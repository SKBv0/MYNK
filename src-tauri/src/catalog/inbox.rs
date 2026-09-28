//! The agent inbox: `<data dir>/inbox/<unix ms>-<8 hex>.json`, drained two-step ([`peek`] then
//! [`ack`]) so a failed import can retry. Every field is bounded (a trust boundary), writes are
//! atomic (`.tmp` + rename), and an unparseable file is set aside as `.bad`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::paths::inbox_dir;
use crate::util::{
    is_plain_file_name, is_windows_device_name, now_ms, sha256_hex, write_atomically,
};

/// How many pending files the directory may hold before writes are refused.
pub const MAX_PENDING_FILES: usize = 500;

pub const MAX_URL_CHARS: usize = 2048;
pub const MAX_TITLE_CHARS: usize = 300;
pub const MAX_TAGS: usize = 24;
pub const MAX_TAG_CHARS: usize = 48;
pub const MAX_NOTE_CHARS: usize = 2000;
pub const MAX_SOURCE_CHARS: usize = 64;
/// Cap on a single entry file, so a hand-written one cannot be read into memory unbounded.
pub const MAX_ENTRY_BYTES: u64 = 64 * 1024;

/// Distinguishes two writes inside the same millisecond in the same process.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// One bookmark handed to MYNK by an agent or a script.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Who added it, e.g. `mcp:claude-code` or `cli`. Spoofable, so only logged: never shown in the
    /// UI or used for a decision.
    #[serde(default)]
    pub source: String,
    /// When the agent added it (epoch ms).
    pub created_at: i64,
}

/// A pending entry plus the file it lives in, so [`ack`] can target exactly what was stored;
/// `name` is a plain file name, never a path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxFile {
    pub name: String,
    pub entry: InboxEntry,
}

impl InboxEntry {
    /// A new entry stamped with the current time.
    pub fn new(url: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            source: source.into(),
            created_at: now_ms(),
            ..Self::default()
        }
    }
}

fn chars(value: &str) -> usize {
    value.chars().count()
}

fn too_long(field: &str, max: usize) -> AppError {
    AppError::invalid_input(format!("{field} is longer than {max} characters."))
}

/// Control characters and bidi overrides: invisible in the list, so they could disguise what a
/// stored bookmark says.
fn is_hidden(value: &str) -> bool {
    value
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
}

fn hidden(field: &str) -> AppError {
    AppError::invalid_input(format!("{field} contains characters that cannot be shown."))
}

/// Rejects a value over `max` characters or one carrying hidden characters.
fn bounded_text<'a>(field: &str, value: &'a str, max: usize) -> AppResult<&'a str> {
    if chars(value) > max {
        return Err(too_long(field, max));
    }
    if is_hidden(value) {
        return Err(hidden(field));
    }
    Ok(value)
}

/// A trimmed optional field; blank reads as absent.
fn optional_text(field: &str, value: Option<&str>, max: usize) -> AppResult<Option<String>> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(value) => Ok(Some(bounded_text(field, value, max)?.to_string())),
        None => Ok(None),
    }
}

/// Validates and trims an entry into the form written to disk. Rejects a non-http(s) URL, a URL
/// without a host, or an oversized field.
pub fn validate(entry: &InboxEntry) -> AppResult<InboxEntry> {
    let url = entry.url.trim();
    if url.is_empty() {
        return Err(AppError::invalid_input("The URL cannot be empty."));
    }
    let url = bounded_text("The URL", url, MAX_URL_CHARS)?;
    let parsed = url::Url::parse(url)
        .map_err(|_| AppError::invalid_input("The URL could not be parsed."))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::invalid_input(
            "Only http and https URLs can be added.",
        ));
    }
    if parsed.host_str().unwrap_or_default().is_empty() {
        return Err(AppError::invalid_input("The URL has no host."));
    }
    // The normalized form is stored, and percent-encoding can grow it several times over;
    // measuring the raw string would let `peek` reject what `write` accepted.
    let normalized = parsed.to_string();
    if chars(&normalized) > MAX_URL_CHARS {
        return Err(too_long("The URL", MAX_URL_CHARS));
    }

    let title = optional_text("The title", entry.title.as_deref(), MAX_TITLE_CHARS)?;

    if entry.tags.len() > MAX_TAGS {
        return Err(AppError::invalid_input(format!(
            "At most {MAX_TAGS} tags can be added."
        )));
    }
    let mut tags: Vec<String> = Vec::with_capacity(entry.tags.len());
    for tag in &entry.tags {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        let tag = bounded_text("A tag", tag, MAX_TAG_CHARS)?;
        if !tags.iter().any(|existing| existing == tag) {
            tags.push(tag.to_string());
        }
    }

    let note = optional_text("The note", entry.note.as_deref(), MAX_NOTE_CHARS)?;
    let source = bounded_text("The source", entry.source.trim(), MAX_SOURCE_CHARS)?;

    Ok(InboxEntry {
        url: normalized,
        title,
        tags,
        note,
        source: source.to_string(),
        created_at: if entry.created_at > 0 {
            entry.created_at
        } else {
            now_ms()
        },
    })
}

/// 8 hex characters derived from the clock, process id and a per-process counter; not a secret.
fn suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
        .to_le_bytes();
    sha256_hex(
        &[
            &nanos,
            &std::process::id().to_le_bytes(),
            &SEQUENCE.fetch_add(1, Ordering::Relaxed).to_le_bytes(),
        ],
        4,
    )
}

fn is_json(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "json")
}

/// Pending entry files, oldest name first (the name starts with the write timestamp).
fn pending(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .filter(|path| is_json(path))
        .collect();
    files.sort();
    files
}

/// How many entries are waiting to be imported.
pub fn count(data_dir: &Path) -> usize {
    pending(&inbox_dir(data_dir)).len()
}

/// How many unreadable entries were set aside as `.bad`; `mynk-mcp doctor` reports this.
pub fn set_aside_count(data_dir: &Path) -> usize {
    set_aside_files(&inbox_dir(data_dir)).len()
}

/// Validates `entry` and writes it to the inbox; returns the file name, never a path.
pub fn write(data_dir: &Path, entry: &InboxEntry) -> AppResult<String> {
    let entry = validate(entry)?;
    let dir = inbox_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|error| {
        log::warn!("inbox: could not create the inbox directory: {error}");
        AppError::storage("The inbox directory could not be created.")
    })?;
    if pending(&dir).len() >= MAX_PENDING_FILES {
        return Err(AppError::storage(format!(
            "The MYNK inbox already holds {MAX_PENDING_FILES} entries that have not been imported yet. Open MYNK to import them."
        )));
    }

    let json = serde_json::to_string(&entry)?;
    let stamp = now_ms().max(0);
    // A name collision would overwrite one of the two entries, so a taken name is retried.
    for _ in 0..8 {
        let name = format!("{stamp}-{}.json", suffix());
        let target = dir.join(&name);
        if target.exists() {
            continue;
        }
        let tmp = dir.join(format!("{name}.tmp"));
        if let Err(error) = write_atomically(&target, &tmp, json.as_bytes()) {
            log::warn!("inbox: could not write {name}: {error}");
            return Err(AppError::storage("The inbox entry could not be written."));
        }
        return Ok(name);
    }
    Err(AppError::storage(
        "A free name for the inbox entry could not be found.",
    ))
}

/// Reads one entry file: `Ok(None)` when its content is unusable, `Err` when the file could not be
/// read at all (a scanner holding it open, say), which says nothing about the content.
fn read_entry(path: &Path) -> std::io::Result<Option<InboxEntry>> {
    if fs::metadata(path)?.len() > MAX_ENTRY_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    Ok(serde_json::from_slice::<InboxEntry>(&bytes)
        .ok()
        .and_then(|entry| validate(&entry).ok()))
}

/// How many `.bad-<n>` names are tried before the last one is overwritten.
const MAX_BAD_SUFFIXES: u32 = 32;
/// How many set-aside files are kept. They are rejected inbox entries, never user data, and
/// nothing imports them; without a cap they would pile up in the inbox directory.
pub const MAX_BAD_FILES: usize = 50;

/// Moves an unreadable file to `<name>.bad`, adding a suffix if that name is taken; once the
/// suffixes run out the last one is overwritten, since a file left in place blocks every drain.
fn set_aside(path: &Path) {
    let mut target = path.with_extension("json.bad");
    let mut n = 1u32;
    while target.exists() && n <= MAX_BAD_SUFFIXES {
        target = path.with_extension(format!("json.bad-{n}"));
        n += 1;
    }
    match fs::rename(path, &target) {
        Ok(()) => log::warn!(
            "inbox: {} could not be read and was set aside",
            path.file_name().unwrap_or_default().to_string_lossy()
        ),
        Err(error) => log::warn!("inbox: could not set a bad entry aside: {error}"),
    }
    if let Some(dir) = path.parent() {
        prune_set_aside(dir);
    }
}

/// Set-aside files in the directory, newest first; files whose age is unreadable sort last.
fn set_aside_files(dir: &Path) -> Vec<(PathBuf, std::time::SystemTime)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.contains(".json.bad"))
        })
        .map(|entry| {
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (entry.path(), modified)
        })
        .collect();
    // Newest first; a file system whose timestamps are too coarse falls back to the name, which
    // starts with the write timestamp.
    files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    files
}

/// Keeps the newest [`MAX_BAD_FILES`] set-aside files and removes the rest.
fn prune_set_aside(dir: &Path) {
    for (path, _) in set_aside_files(dir).into_iter().skip(MAX_BAD_FILES) {
        if let Err(error) = fs::remove_file(&path) {
            log::warn!("inbox: could not remove an old set-aside entry: {error}");
        }
    }
}

/// A plain file name with a `.json` extension; nothing that could resolve outside the inbox
/// directory, nothing Windows would open as a device, and nothing [`ack`] would later refuse.
pub fn is_safe_entry_name(name: &str) -> bool {
    is_plain_file_name(name) && name.ends_with(".json") && !is_windows_device_name(name)
}

/// Every pending entry with the file it came from, oldest first, without removing anything;
/// unusable files are set aside as `.bad` and [`ack`] follows only once the import is stored.
pub fn peek(data_dir: &Path) -> AppResult<Vec<InboxFile>> {
    let dir = inbox_dir(data_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for path in pending(&dir) {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| is_safe_entry_name(name));
        // A name [`ack`] would refuse must not reach the caller: it would fail every later drain.
        let Some(name) = name else {
            set_aside(&path);
            continue;
        };
        match read_entry(&path) {
            Ok(Some(entry)) => files.push(InboxFile { name, entry }),
            Ok(None) => set_aside(&path),
            // Left in place for the next drain; setting it aside would lose a valid bookmark.
            Err(error) => log::warn!("inbox: could not read {name} this round: {error}"),
        }
    }
    Ok(files)
}

/// Removes the named entry files, only after every name has been checked (no half-deleted batch).
/// A file already gone counts as done; one that refuses to go is set aside as `.bad`.
pub fn ack(data_dir: &Path, names: &[String]) -> AppResult<()> {
    for name in names {
        if !is_safe_entry_name(name) {
            return Err(AppError::invalid_input(format!(
                "Rejected inbox file name \"{}\".",
                name.chars().take(64).collect::<String>()
            )));
        }
    }
    let dir = inbox_dir(data_dir);
    for name in names {
        let path = dir.join(name);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                log::warn!("inbox: could not remove the imported entry {name}: {error}");
                // Left in place, it would be imported again on the next drain.
                set_aside(&path);
            }
        }
    }
    Ok(())
}

/// [`peek`] followed by [`ack`] of everything it returned: reads and removes in one step, for the
/// CLI and tests. The app uses the two halves, so a bookmark leaves the inbox only once stored.
pub fn drain(data_dir: &Path) -> AppResult<Vec<InboxEntry>> {
    let files = peek(data_dir)?;
    let names: Vec<String> = files.iter().map(|file| file.name.clone()).collect();
    ack(data_dir, &names)?;
    Ok(files.into_iter().map(|file| file.entry).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    fn entry(url: &str) -> InboxEntry {
        InboxEntry {
            url: url.to_string(),
            title: Some("Ownership in Rust".into()),
            tags: vec!["rust".into(), "ownership".into()],
            note: Some("read this".into()),
            source: "mcp:claude-code".into(),
            created_at: 1_757_000_000_000,
        }
    }

    #[test]
    fn write_read_and_drain_round_trip() {
        let dir = temp_dir();
        assert_eq!(count(dir.path()), 0);
        assert!(drain(dir.path()).expect("drain an absent inbox").is_empty());

        let name = write(dir.path(), &entry("https://doc.rust-lang.org/book/")).expect("write");
        assert!(name.ends_with(".json"), "{name}");
        assert!(
            !name.contains(std::path::MAIN_SEPARATOR),
            "no path leaks: {name}"
        );
        assert_eq!(count(dir.path()), 1);

        write(dir.path(), &entry("https://example.com/second")).expect("write 2");
        assert_eq!(count(dir.path()), 2);

        let drained = drain(dir.path()).expect("drain");
        assert_eq!(drained.len(), 2);
        // Looked up by URL: same-millisecond writes only differ by their random suffix.
        let first = drained
            .iter()
            .find(|entry| entry.url == "https://doc.rust-lang.org/book/")
            .expect("the first entry survived the round trip");
        assert_eq!(first.title.as_deref(), Some("Ownership in Rust"));
        assert_eq!(first.tags, vec!["rust", "ownership"]);
        assert_eq!(first.note.as_deref(), Some("read this"));
        assert_eq!(first.source, "mcp:claude-code");
        assert_eq!(first.created_at, 1_757_000_000_000);
        assert!(drained
            .iter()
            .any(|entry| entry.url == "https://example.com/second"));
        assert_eq!(count(dir.path()), 0, "drained entries are removed");
        assert!(drain(dir.path()).expect("drain again").is_empty());
    }

    #[test]
    fn peek_leaves_everything_where_it_is() {
        let dir = temp_dir();
        assert!(peek(dir.path()).expect("peek an absent inbox").is_empty());
        let name = write(dir.path(), &entry("https://example.com/a")).expect("write");
        write(dir.path(), &entry("https://example.com/b")).expect("write 2");

        let first = peek(dir.path()).expect("peek");
        assert_eq!(first.len(), 2);
        assert_eq!(count(dir.path()), 2, "peeking consumes nothing");
        let again = peek(dir.path()).expect("peek again");
        assert_eq!(first, again);
        assert!(first.iter().any(|file| file.name == name));
        assert!(first
            .iter()
            .any(|file| file.entry.url == "https://example.com/a"));
        assert!(
            first.iter().all(|file| is_safe_entry_name(&file.name)),
            "{first:?}"
        );
    }

    #[test]
    fn ack_removes_only_the_named_files() {
        let dir = temp_dir();
        let first = write(dir.path(), &entry("https://example.com/a")).expect("write");
        write(dir.path(), &entry("https://example.com/b")).expect("write 2");

        ack(dir.path(), std::slice::from_ref(&first)).expect("ack");
        let left = peek(dir.path()).expect("peek");
        assert_eq!(left.len(), 1, "the unacknowledged entry is still waiting");
        assert_eq!(left[0].entry.url, "https://example.com/b");
        ack(dir.path(), &[first]).expect("ack twice");
        assert_eq!(count(dir.path()), 1);
        ack(dir.path(), &[]).expect("ack nothing");
        assert_eq!(count(dir.path()), 1);
    }

    #[test]
    fn ack_refuses_a_name_that_is_not_a_plain_inbox_file() {
        let dir = temp_dir();
        let good = write(dir.path(), &entry("https://example.com/a")).expect("write");
        for bad in [
            "../library.json",
            "..\\library.json",
            "C:\\Windows\\win.ini",
            "/etc/passwd",
            "sub/dir.json",
            ".hidden.json",
            "not-json.txt",
            "",
        ] {
            assert!(!is_safe_entry_name(bad), "{bad}");
            let error = ack(dir.path(), &[bad.to_string()]).expect_err("rejected");
            assert_eq!(error.kind(), "invalidInput", "{bad}");
        }
        let error = ack(dir.path(), &[good.clone(), "../library.json".into()]).expect_err("batch");
        assert_eq!(error.kind(), "invalidInput");
        assert_eq!(count(dir.path()), 1, "{good} survived the rejected batch");
        assert!(is_safe_entry_name(&good));
    }

    #[test]
    fn peek_sets_aside_a_file_ack_could_never_remove() {
        let dir = temp_dir();
        write(dir.path(), &entry("https://example.com/good")).expect("write");
        let inbox = inbox_dir(dir.path());
        let stray = inbox.join("my bookmark.json");
        fs::write(
            &stray,
            r#"{"url":"https://example.com/stray","createdAt":1}"#,
        )
        .expect("stray entry");

        let files = peek(dir.path()).expect("peek");
        assert_eq!(files.len(), 1, "the unacknowledgeable name is left out");
        assert!(files.iter().all(|file| is_safe_entry_name(&file.name)));
        let names: Vec<String> = files.iter().map(|file| file.name.clone()).collect();
        ack(dir.path(), &names).expect("ack accepts everything peek returned");
        assert!(!stray.exists());
        assert!(inbox.join("my bookmark.json.bad").is_file());
        assert_eq!(count(dir.path()), 0);
    }

    #[test]
    fn validation_rejects_control_and_bidi_characters() {
        let reject = |mutate: &dyn Fn(&mut InboxEntry)| {
            let mut e = entry("https://example.com/a");
            mutate(&mut e);
            validate(&e)
                .expect_err("must be rejected")
                .kind()
                .to_string()
        };
        assert_eq!(
            reject(&|e| e.title = Some("gpj.exe\u{202e}".into())),
            "invalidInput"
        );
        assert_eq!(
            reject(&|e| e.title = Some("bell\u{7}here".into())),
            "invalidInput"
        );
        assert_eq!(
            reject(&|e| e.title = Some("two\nlines".into())),
            "invalidInput"
        );
        assert_eq!(
            reject(&|e| e.tags = vec!["ru\u{2066}st".into()]),
            "invalidInput"
        );
        assert_eq!(reject(&|e| e.source = "cli\u{1}".into()), "invalidInput");
        assert_eq!(
            reject(&|e| e.note = Some("a\u{202a}b".into())),
            "invalidInput"
        );
        assert_eq!(
            reject(&|e| e.url = "https://exam\u{202e}ple.com/".into()),
            "invalidInput"
        );
    }

    #[test]
    fn two_writes_in_the_same_millisecond_do_not_collide() {
        let dir = temp_dir();
        let mut names = Vec::new();
        for i in 0..25 {
            names.push(
                write(dir.path(), &entry(&format!("https://example.com/{i}"))).expect("write"),
            );
        }
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 25);
        assert_eq!(count(dir.path()), 25);
    }

    #[test]
    fn only_complete_files_are_visible() {
        let dir = temp_dir();
        write(dir.path(), &entry("https://example.com/a")).expect("write");
        // A half-written file is still a `.tmp` and must be invisible to both count and drain.
        fs::write(
            inbox_dir(dir.path()).join("999-deadbeef.json.tmp"),
            "{ half",
        )
        .expect("stray temp file");
        assert_eq!(count(dir.path()), 1);
        assert_eq!(drain(dir.path()).expect("drain").len(), 1);
        assert!(inbox_dir(dir.path()).join("999-deadbeef.json.tmp").exists());
    }

    #[test]
    fn a_broken_entry_is_set_aside_and_does_not_stop_the_others() {
        let dir = temp_dir();
        write(dir.path(), &entry("https://example.com/good")).expect("write");
        let inbox = inbox_dir(dir.path());
        fs::write(inbox.join("100-00000000.json"), "{ not json").expect("broken");
        fs::write(
            inbox.join("101-00000000.json"),
            r#"{"url":"javascript:alert(1)","createdAt":1}"#,
        )
        .expect("invalid url");

        let drained = drain(dir.path()).expect("drain");
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].url, "https://example.com/good");
        assert!(inbox.join("100-00000000.json.bad").is_file());
        assert!(inbox.join("101-00000000.json.bad").is_file());
        assert_eq!(count(dir.path()), 0, "bad files are no longer pending");
        // A second bad file with the same name gets its own suffix instead of overwriting.
        fs::write(inbox.join("100-00000000.json"), "{ not json").expect("broken again");
        assert!(drain(dir.path()).expect("drain").is_empty());
        assert!(inbox.join("100-00000000.json.bad-1").is_file());
        assert_eq!(set_aside_count(dir.path()), 3);
    }

    /// Left in place, the same unreadable file would be read again on every drain.
    #[test]
    fn a_bad_entry_leaves_the_inbox_even_when_every_suffix_is_taken() {
        let dir = temp_dir();
        let inbox = inbox_dir(dir.path());
        fs::create_dir_all(&inbox).expect("inbox dir");
        fs::write(inbox.join("100-00000000.json.bad"), "older").expect("taken");
        for n in 1..=MAX_BAD_SUFFIXES {
            fs::write(inbox.join(format!("100-00000000.json.bad-{n}")), "older").expect("taken");
        }
        fs::write(inbox.join("100-00000000.json"), "{ not json").expect("broken");

        assert!(drain(dir.path()).expect("drain").is_empty());
        assert!(
            !inbox.join("100-00000000.json").exists(),
            "the round has to make progress"
        );
        assert_eq!(count(dir.path()), 0);
        assert_eq!(
            fs::read_to_string(inbox.join(format!("100-00000000.json.bad-{MAX_BAD_SUFFIXES}")))
                .expect("read"),
            "{ not json",
            "the last candidate is the one overwritten"
        );
        assert_eq!(
            set_aside_count(dir.path()),
            MAX_BAD_SUFFIXES as usize + 1,
            "doctor counts every set-aside file"
        );
    }

    /// `write` stores the normalized URL, so the limit is measured on that form; otherwise
    /// `peek` would set aside a bookmark that `write` accepted.
    #[test]
    fn the_url_limit_is_measured_on_the_form_that_is_stored() {
        let dir = temp_dir();
        // Percent-encoding grows this path sixfold: 420 raw characters, over 2400 stored ones.
        let expands = format!("https://example.com/{}", "ı".repeat(400));
        assert!(chars(&expands) < MAX_URL_CHARS, "the raw URL is short");
        let error = write(dir.path(), &entry(&expands)).expect_err("too long once encoded");
        assert_eq!(error.kind(), "invalidInput");
        assert_eq!(count(dir.path()), 0);

        // One that still fits survives the round trip, and `peek` agrees with `write`.
        let mixed = "https://example.com/tr/kütüphane notları/ödev.html?q=bir şey";
        let name = write(dir.path(), &entry(mixed)).expect("write");
        let files = peek(dir.path()).expect("peek");
        assert_eq!(files.len(), 1, "nothing was set aside: {files:?}");
        assert_eq!(files[0].name, name);
        assert!(files[0].entry.url.contains("%20"), "{}", files[0].entry.url);
        assert_eq!(
            files[0].entry.url,
            url::Url::parse(mixed).expect("url").to_string()
        );
        assert_eq!(set_aside_count(dir.path()), 0);
    }

    #[test]
    fn set_aside_files_are_capped_so_they_cannot_fill_the_inbox() {
        let dir = temp_dir();
        let inbox = inbox_dir(dir.path());
        fs::create_dir_all(&inbox).expect("inbox dir");
        for i in 0..(MAX_BAD_FILES + 20) {
            fs::write(inbox.join(format!("{i:06}-00000000.json.bad")), "old").expect("bad file");
        }
        assert_eq!(set_aside_count(dir.path()), MAX_BAD_FILES + 20);

        // Setting one more aside trims the pile back to the cap.
        fs::write(inbox.join("999999-00000000.json"), "{ not json").expect("broken");
        assert!(drain(dir.path()).expect("drain").is_empty());
        assert_eq!(set_aside_count(dir.path()), MAX_BAD_FILES);
        assert!(
            inbox.join("999999-00000000.json.bad").is_file(),
            "the newest one is the one kept"
        );
        assert_eq!(count(dir.path()), 0, "set-aside files are not pending");
    }

    #[test]
    fn a_windows_device_name_is_never_an_entry_name() {
        let dir = temp_dir();
        for device in ["nul.json", "CON.json", "com1.json", "LPT9.json"] {
            assert!(!is_safe_entry_name(device), "{device}");
            let error = ack(dir.path(), &[device.to_string()]).expect_err("rejected");
            assert_eq!(error.kind(), "invalidInput", "{device}");
        }
        assert!(is_safe_entry_name("console.json"));
        assert!(is_safe_entry_name("com10.json"));
    }

    #[test]
    fn a_full_inbox_refuses_new_entries() {
        let dir = temp_dir();
        let inbox = inbox_dir(dir.path());
        fs::create_dir_all(&inbox).expect("inbox dir");
        for i in 0..MAX_PENDING_FILES {
            fs::write(inbox.join(format!("{i:06}-00000000.json")), "{}").expect("filler");
        }
        let error = write(dir.path(), &entry("https://example.com/x")).expect_err("full");
        assert_eq!(error.kind(), "storage");
        assert!(error.to_string().contains("not been imported"), "{error}");
    }

    #[test]
    fn validation_rejects_what_the_app_cannot_use() {
        let reject = |mutate: &dyn Fn(&mut InboxEntry)| {
            let mut e = entry("https://example.com/a");
            mutate(&mut e);
            validate(&e)
                .expect_err("must be rejected")
                .kind()
                .to_string()
        };
        assert_eq!(reject(&|e| e.url = String::new()), "invalidInput");
        assert_eq!(reject(&|e| e.url = "   ".into()), "invalidInput");
        assert_eq!(
            reject(&|e| e.url = "javascript:alert(1)".into()),
            "invalidInput"
        );
        assert_eq!(
            reject(&|e| e.url = "file:///C:/Windows/win.ini".into()),
            "invalidInput"
        );
        assert_eq!(reject(&|e| e.url = "not a url".into()), "invalidInput");
        assert_eq!(
            reject(&|e| e.url = format!("https://example.com/{}", "x".repeat(MAX_URL_CHARS))),
            "invalidInput"
        );
        assert_eq!(
            reject(&|e| e.title = Some("t".repeat(MAX_TITLE_CHARS + 1))),
            "invalidInput"
        );
        assert_eq!(
            reject(&|e| e.note = Some("n".repeat(MAX_NOTE_CHARS + 1))),
            "invalidInput"
        );
        assert_eq!(
            reject(&|e| e.tags = (0..MAX_TAGS + 1).map(|i| format!("t{i}")).collect()),
            "invalidInput"
        );
        assert_eq!(
            reject(&|e| e.tags = vec!["t".repeat(MAX_TAG_CHARS + 1)]),
            "invalidInput"
        );
        assert_eq!(
            reject(&|e| e.source = "s".repeat(MAX_SOURCE_CHARS + 1)),
            "invalidInput"
        );
    }

    #[test]
    fn validation_trims_and_deduplicates() {
        let mut e = entry("  https://example.com/a  ");
        e.title = Some("   ".into());
        e.note = Some("  ".into());
        e.tags = vec![
            "  rust ".into(),
            "rust".into(),
            "   ".into(),
            "ownership".into(),
        ];
        e.source = "  cli  ".into();
        e.created_at = 0;

        let clean = validate(&e).expect("valid");
        assert_eq!(clean.url, "https://example.com/a");
        assert_eq!(clean.title, None, "a blank title is dropped, not stored");
        assert_eq!(clean.note, None);
        assert_eq!(clean.tags, vec!["rust", "ownership"]);
        assert_eq!(clean.source, "cli");
        assert!(clean.created_at > 0, "a missing timestamp is stamped now");
    }

    #[test]
    fn the_limits_themselves_are_allowed() {
        let mut e = entry("https://example.com/a");
        e.title = Some("t".repeat(MAX_TITLE_CHARS));
        e.note = Some("n".repeat(MAX_NOTE_CHARS));
        e.tags = (0..MAX_TAGS).map(|i| format!("tag{i}")).collect();
        e.source = "s".repeat(MAX_SOURCE_CHARS);
        let clean = validate(&e).expect("the limits themselves are fine");
        assert_eq!(clean.tags.len(), MAX_TAGS);
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_entry_stays_in_place_for_the_next_drain() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_DELETE: u32 = 0x4;

        let dir = temp_dir();
        let name = write(dir.path(), &entry("https://example.com/locked")).expect("write");
        let path = inbox_dir(dir.path()).join(&name);
        // Refuses other readers but still lets the file be renamed, as a scanner's handle can.
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_DELETE)
            .open(&path)
            .expect("lock the entry");
        assert!(peek(dir.path()).expect("peek while locked").is_empty());
        assert!(path.is_file(), "the entry stays where it was");
        assert_eq!(set_aside_count(dir.path()), 0);
        drop(lock);

        let files = peek(dir.path()).expect("peek once released");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, name);
    }

    #[test]
    fn a_file_that_is_not_utf8_is_set_aside() {
        let dir = temp_dir();
        let inbox = inbox_dir(dir.path());
        fs::create_dir_all(&inbox).expect("inbox dir");
        fs::write(inbox.join("100-00000000.json"), [0xff, 0xfe, 0x00]).expect("binary");
        assert!(peek(dir.path()).expect("peek").is_empty());
        assert!(inbox.join("100-00000000.json.bad").is_file());
    }

    #[test]
    fn an_oversized_file_is_not_read_into_memory() {
        let dir = temp_dir();
        let inbox = inbox_dir(dir.path());
        fs::create_dir_all(&inbox).expect("inbox dir");
        let huge = format!(
            r#"{{"url":"https://example.com/a","createdAt":1,"note":"{}"}}"#,
            "x".repeat(MAX_ENTRY_BYTES as usize)
        );
        fs::write(inbox.join("100-00000000.json"), huge).expect("huge entry");
        assert!(drain(dir.path()).expect("drain").is_empty());
        assert!(inbox.join("100-00000000.json.bad").is_file());
    }

    #[test]
    fn the_stored_json_uses_the_camel_case_wire_shape() {
        let dir = temp_dir();
        let name = write(dir.path(), &entry("https://example.com/a")).expect("write");
        let raw = fs::read_to_string(inbox_dir(dir.path()).join(name)).expect("read");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(value["url"], "https://example.com/a");
        assert_eq!(value["createdAt"], 1_757_000_000_000i64);
        assert_eq!(value["source"], "mcp:claude-code");
        assert!(value.get("created_at").is_none(), "{raw}");
        // An absent optional field is omitted, not written as null.
        let mut bare = InboxEntry::new("https://example.com/b", "cli");
        bare.title = None;
        let json = serde_json::to_value(validate(&bare).expect("valid")).expect("serialize");
        assert!(json.get("title").is_none(), "{json}");
        assert!(json.get("note").is_none(), "{json}");
    }
}
