//! Small helpers shared by the app and `mynk-mcp`: atomic writes, stale temp directories, plain
//! file names, character caps, epoch milliseconds, SHA-256 hex, poison-tolerant locking, SQLite
//! error detail. Nothing here may depend on Tauri.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

/// Writes `bytes` to `tmp` and fsyncs it; the temp file is removed when anything fails.
pub fn write_temp(tmp: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let written = fs::File::create(tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(error) = written {
        let _ = fs::remove_file(tmp);
        return Err(error);
    }
    Ok(())
}

/// [`write_temp`] followed by a rename onto `target`, so a reader never sees a half-written file.
/// The caller picks `tmp` because a unique name needs process state this module cannot reach.
pub fn write_atomically(target: &Path, tmp: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_temp(tmp, bytes)?;
    if let Err(error) = fs::rename(tmp, target) {
        let _ = fs::remove_file(tmp);
        return Err(error);
    }
    Ok(())
}

/// A file name that can only mean a file inside the directory it is joined to: at most 128 chars
/// of `[A-Za-z0-9._-]`, no leading dot, no `..`. Callers add their own conditions.
pub fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Windows device names, reserved with or without an extension.
const WINDOWS_DEVICE_NAMES: &[&str] = &["CON", "PRN", "AUX", "NUL"];
const WINDOWS_NUMBERED_DEVICES: &[&str] = &["COM", "LPT"];

/// Whether `name` is a Windows device name (`CON`, `nul.png`, `COM1.txt`, ...), case-insensitively.
pub fn is_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    if WINDOWS_DEVICE_NAMES
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device))
    {
        return true;
    }
    stem.len() == 4
        && stem.as_bytes()[3].is_ascii_digit()
        && stem.get(..3).is_some_and(|prefix| {
            WINDOWS_NUMBERED_DEVICES
                .iter()
                .any(|device| prefix.eq_ignore_ascii_case(device))
        })
}

/// Longest model name or id accepted from a provider.
pub const MAX_MODEL_NAME_CHARS: usize = 128;
/// Most models one local Ollama answer may contribute; a real machine holds a handful.
pub const MAX_LOCAL_MODELS: usize = 500;

/// A model name or id safe to show and to paste into a shell hint (`ollama pull …`): letters,
/// digits and `._:/+@-` only, so quotes, spaces and control characters can never get in.
pub fn is_plain_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_MODEL_NAME_CHARS
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '+' | '@' | '-')
        })
}

/// Epoch milliseconds; 0 when the clock cannot be read.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

/// Lowercase hex of the first `bytes` bytes of SHA-256 over `parts` joined in order.
pub fn sha256_hex(parts: &[&[u8]], bytes: usize) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher
        .finalize()
        .iter()
        .take(bytes)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Release builds abort on panic, so poisoning can only happen in debug/test builds, where
/// taking the inner value is safe and keeps one panicked thread from disabling the whole cache.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The part of a SQLite failure that is safe to show: its messages can carry absolute file paths,
/// so only the error code is kept and the caller logs the full error instead.
pub fn sqlite_detail(error: &rusqlite::Error) -> String {
    match error {
        rusqlite::Error::SqliteFailure(code, _) => code.to_string(),
        _ => "unexpected database error".to_string(),
    }
}

/// Cuts `text` to at most `max` characters, always on a `char` boundary; nothing is appended.
pub fn cap_chars(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((byte, _)) => &text[..byte],
        None => text,
    }
}

/// Runs of whitespace (newlines included) become single spaces.
pub fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The moment before which an entry counts as older than `max_age`.
pub fn age_cutoff(max_age: Duration) -> SystemTime {
    SystemTime::now()
        .checked_sub(max_age)
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Removes the directories directly under `root` whose name `is_ours` accepts and that were last
/// modified more than `max_age` ago. Returns how many were removed.
pub fn sweep_stale_dirs(root: &Path, is_ours: impl Fn(&str) -> bool, max_age: Duration) -> u32 {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    let cutoff = age_cutoff(max_age);
    let mut removed = 0u32;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_str().is_some_and(&is_ours) {
            continue;
        }
        // Unresolved metadata: a symlink or junction planted here must not redirect the removal.
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let old = meta.modified().is_ok_and(|modified| modified < cutoff);
        if old && fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_atomic_write_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("a.json");
        let tmp = dir.path().join("a.json.tmp");
        write_atomically(&target, &tmp, b"one").expect("write");
        write_atomically(&target, &tmp, b"two").expect("overwrite");
        assert_eq!(fs::read(&target).expect("read"), b"two");
        assert!(!tmp.exists());

        let blocked = dir.path().join("missing").join("b.json.tmp");
        write_temp(&blocked, b"x").expect_err("no such directory");
        assert!(!blocked.exists());
    }

    #[test]
    fn plain_file_names_reject_paths_and_windows_devices() {
        assert!(is_plain_file_name("abc123.png"));
        assert!(is_plain_file_name("1757-00ff.json"));
        assert!(!is_plain_file_name(""));
        assert!(!is_plain_file_name(".hidden"));
        assert!(!is_plain_file_name("a..b"));
        assert!(!is_plain_file_name("sub/dir.json"));
        assert!(!is_plain_file_name("C:\\Windows\\win.ini"));
        assert!(!is_plain_file_name(&"a".repeat(129)));
        for device in [
            "CON",
            "con",
            "PRN.png",
            "aux.tar.gz",
            "nul",
            "COM1",
            "lpt5.webp",
        ] {
            assert!(is_windows_device_name(device), "{device}");
        }
        for fine in ["console.png", "com10.png", "nully.png", "comx.png"] {
            assert!(!is_windows_device_name(fine), "{fine}");
        }
    }

    #[test]
    fn model_names_stay_inside_a_shell_safe_alphabet() {
        for name in [
            "qwen3:8b",
            "nomic-embed-text:latest",
            "library/bge-m3:567m",
            "meta-llama/llama-3.1-8b-instruct:free",
            "qwen/qwen3-235b-a22b-07-25",
            "openai/gpt-4o-mini",
            "hf.co/user/repo:Q4_K_M",
            "a+b@c",
        ] {
            assert!(is_plain_model_name(name), "{name}");
        }
        for hostile in [
            "",
            "   ",
            "qwen3:8b\"; rm -rf /",
            "qwen3 8b",
            "model'name",
            "model`name`",
            "model$(id)",
            "model\nname",
            "model\u{202e}exe",
            "modèle",
            &"a".repeat(MAX_MODEL_NAME_CHARS + 1),
        ] {
            assert!(!is_plain_model_name(hostile), "{hostile:?}");
        }
        assert!(is_plain_model_name(&"a".repeat(MAX_MODEL_NAME_CHARS)));
    }

    #[test]
    fn sha256_hex_matches_the_lengths_its_callers_ask_for() {
        assert_eq!(sha256_hex(&[b"abc"], 32).len(), 64);
        assert_eq!(sha256_hex(&[b"abc"], 4).len(), 8);
        assert_eq!(&sha256_hex(&[b"abc"], 4), "ba7816bf");
        assert_eq!(sha256_hex(&[b"ab", b"c"], 32), sha256_hex(&[b"abc"], 32));
        assert_eq!(sha256_hex(&[b"abc"], 64), sha256_hex(&[b"abc"], 32));
    }

    #[test]
    fn locking_survives_a_poisoned_mutex() {
        let mutex = std::sync::Arc::new(Mutex::new(1));
        let poisoner = std::sync::Arc::clone(&mutex);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().expect("lock");
            panic!("poison it");
        })
        .join();
        assert_eq!(*lock(&mutex), 1);
    }

    #[test]
    fn capping_counts_characters_not_bytes() {
        assert_eq!(cap_chars("kısa", 10), "kısa");
        assert_eq!(cap_chars("çğüşöı", 3), "çğü");
        assert_eq!(cap_chars("abc", 0), "");
    }

    #[test]
    fn collapses_every_kind_of_whitespace() {
        assert_eq!(collapse_whitespace(" a \n\t b  "), "a b");
        assert_eq!(collapse_whitespace("   "), "");
    }

    #[test]
    fn the_clock_reads_as_epoch_milliseconds() {
        assert!(now_ms() > 1_700_000_000_000, "{}", now_ms());
    }
}
