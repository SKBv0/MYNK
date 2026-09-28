//! Firefox: `profiles.ini` → `places.sqlite`, read via a private file copy (with its `-wal`).
//! The live database is never opened in place, not even read-only: SQLite would create
//! `-wal`/`-shm` files in the profile and risk colliding with Firefox's own locks.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use super::registry::{BrowserFamily, ProfileSource, SourceKind};
use super::{is_importable_url, ImportedBookmark};
use crate::error::{AppError, AppResult};
use crate::state::next_temp_id;
use crate::util::sweep_stale_dirs;

const MAX_PLACES_BYTES: u64 = 512 * 1024 * 1024;
const TEMP_COPY_PREFIX: &str = "mynk-ff-";
/// Temp copies older than this were left behind by a crash, not by a running import.
pub const TEMP_COPY_MAX_AGE: Duration = Duration::from_secs(3600);
/// Nearest folders kept for a bookmark whose parent chain is deeper than this (or cyclic, in a
/// damaged database). The root end of the chain is cut; the bookmark itself is kept.
const MAX_FOLDER_DEPTH: usize = 64;

fn firefox_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "windows")]
    if let Some(roaming) = dirs::data_dir() {
        roots.push(roaming.join(r"Mozilla\Firefox"));
    }
    #[cfg(target_os = "macos")]
    if let Some(support) = dirs::data_dir() {
        roots.push(support.join("Firefox"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".mozilla/firefox"));
        roots.push(home.join("snap/firefox/common/.mozilla/firefox"));
        roots.push(home.join(".var/app/org.mozilla.firefox/.mozilla/firefox"));
    }
    roots
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IniProfile {
    pub name: String,
    pub path: PathBuf,
}

/// Parses `profiles.ini` (only `[Profile*]` sections with a `Path`).
pub fn parse_profiles_ini(content: &str, root: &Path) -> Vec<IniProfile> {
    let mut profiles = Vec::new();
    let mut in_profile = false;
    let mut name: Option<String> = None;
    let mut path: Option<String> = None;
    let mut relative = true;

    let mut flush =
        |name: &mut Option<String>, path: &mut Option<String>, relative: bool, in_profile: bool| {
            if in_profile {
                if let Some(p) = path.take() {
                    let full = if relative {
                        root.join(p.replace('/', std::path::MAIN_SEPARATOR_STR))
                    } else {
                        PathBuf::from(p)
                    };
                    profiles.push(IniProfile {
                        name: name.take().unwrap_or_else(|| "default".to_string()),
                        path: full,
                    });
                }
            }
            *name = None;
            *path = None;
        };

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            flush(&mut name, &mut path, relative, in_profile);
            in_profile = line[1..line.len() - 1].starts_with("Profile");
            relative = true;
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "Name" => name = Some(value.trim().to_string()),
            "Path" => path = Some(value.trim().to_string()),
            "IsRelative" => relative = value.trim() != "0",
            _ => {}
        }
    }
    flush(&mut name, &mut path, relative, in_profile);
    profiles
}

pub fn detect() -> Vec<ProfileSource> {
    let mut sources = Vec::new();
    for root in firefox_roots() {
        let Ok(ini) = fs::read_to_string(root.join("profiles.ini")) else {
            continue;
        };
        for profile in parse_profiles_ini(&ini, &root) {
            let places = profile.path.join("places.sqlite");
            if places.is_file() {
                sources.push(ProfileSource {
                    browser: BrowserFamily::Firefox,
                    profile_name: profile.name,
                    kind: SourceKind::FirefoxPlaces(places),
                });
            }
        }
    }
    sources
}

/// Maps a SQLite error to a renderer-safe `AppError`; the full error goes to the log only.
fn db_error(context: &str, error: &rusqlite::Error) -> AppError {
    log::warn!("{context}: {error}");
    AppError::storage(format!(
        "{context} ({}).",
        crate::util::sqlite_detail(error)
    ))
}

fn sidecar(places: &Path, suffix: &str) -> PathBuf {
    let mut name = places.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Copies `places.sqlite` and its `-wal` into `dir` via plain file reads (SQLite never opens the
/// profile). A `-wal` that fails to copy is an error: without it, recent bookmarks go missing.
fn copy_with_wal(places: &Path, dir: &Path) -> AppResult<PathBuf> {
    let target = dir.join("places.sqlite");
    // WAL copied first so a checkpoint mid-copy can't pair a stale main file with a fresh WAL.
    let wal = sidecar(places, "-wal");
    if fs::symlink_metadata(&wal).is_ok() {
        fs::copy(&wal, dir.join("places.sqlite-wal")).map_err(|error| {
            log::warn!("Copying {} failed: {error}", wal.display());
            AppError::browser_locked(
                "Could not copy the Firefox bookmarks journal, so recent bookmarks would be missing. Close Firefox and try again.",
            )
        })?;
    }
    fs::copy(places, &target).map_err(|error| {
        log::warn!("Copying {} failed: {error}", places.display());
        AppError::browser_locked(
            "Could not copy the Firefox bookmarks database. Close Firefox and try again.",
        )
    })?;
    Ok(target)
}

/// Private snapshot of `places.sqlite` that is deleted on drop. Release builds abort on panic,
/// so `Drop` is not guaranteed to run: `sweep_temp_copies` clears whatever a crash left behind.
struct TempCopy {
    dir: PathBuf,
}

impl TempCopy {
    fn new(places: &Path) -> AppResult<(Self, PathBuf)> {
        if fs::metadata(places)?.len() > MAX_PLACES_BYTES {
            return Err(AppError::storage(
                "The Firefox history database is too large.",
            ));
        }
        let dir = std::env::temp_dir().join(format!("{TEMP_COPY_PREFIX}{}", next_temp_id()));
        fs::create_dir_all(&dir)?;
        let guard = Self { dir };
        let target = copy_with_wal(places, &guard.dir)?;
        Ok((guard, target))
    }
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Start-up sweep: removes `mynk-ff-*` copies older than `max_age`, left behind when `Drop`
/// didn't run. Returns how many directories were removed.
pub fn sweep_temp_copies(max_age: Duration) -> u32 {
    sweep_temp_copies_in(&std::env::temp_dir(), max_age)
}

/// [`sweep_temp_copies`] against an explicit temp root (tests).
pub fn sweep_temp_copies_in(temp_root: &Path, max_age: Duration) -> u32 {
    sweep_stale_dirs(
        temp_root,
        |name| name.starts_with(TEMP_COPY_PREFIX),
        max_age,
    )
}

/// Firefox root folder GUIDs → display names.
fn root_name(guid: &str) -> Option<&'static str> {
    match guid {
        "menu________" => Some("Bookmarks Menu"),
        "toolbar_____" => Some("Bookmarks Toolbar"),
        "unfiled_____" => Some("Other Bookmarks"),
        "mobile______" => Some("Mobile Bookmarks"),
        _ => None,
    }
}

#[derive(Debug)]
struct Row {
    parent: i64,
    kind: i64,
    title: String,
    guid: String,
    url: Option<String>,
    date_added: Option<i64>,
}

/// Opens a private copy read-write: it may still be in WAL mode, and a read-only connection
/// cannot rebuild its `-shm` index.
fn open_copy(path: &Path) -> AppResult<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| db_error("Could not open the Firefox bookmarks database", &error))
}

fn query_rows(conn: &Connection) -> rusqlite::Result<HashMap<i64, Row>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.parent, b.type, COALESCE(b.title, ''), COALESCE(b.guid, ''), p.url, b.dateAdded
         FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk = p.id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            Row {
                parent: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                guid: row.get(4)?,
                url: row.get(5)?,
                date_added: row.get(6)?,
            },
        ))
    })?;
    rows.collect()
}

/// Reads bookmarks from a `places.sqlite` file (already a private copy).
pub fn read_places(path: &Path) -> AppResult<Vec<ImportedBookmark>> {
    let conn = open_copy(path)?;
    let rows = query_rows(&conn)
        .map_err(|error| db_error("Could not read the Firefox bookmarks", &error))?;
    Ok(build_bookmarks(&rows))
}

/// Folder names from the top of the tree down to `parent`; `None` for tag entries or a broken
/// chain. A chain deeper than `MAX_FOLDER_DEPTH` (or cyclic) keeps the nearest folders instead.
fn folder_path(rows: &HashMap<i64, Row>, mut parent: i64) -> Option<Vec<String>> {
    let mut path = Vec::new();
    for _ in 0..MAX_FOLDER_DEPTH {
        let row = rows.get(&parent)?;
        if row.guid == "tags________" {
            return None; // tag entries are not bookmarks
        }
        if row.guid == "root________" || row.parent == 0 {
            path.reverse();
            return Some(path);
        }
        let name = root_name(&row.guid)
            .map(str::to_string)
            .unwrap_or_else(|| row.title.clone());
        path.push(name);
        parent = row.parent;
    }
    log::info!("Firefox folder chain deeper than {MAX_FOLDER_DEPTH} levels; keeping the nearest");
    path.reverse();
    Some(path)
}

fn build_bookmarks(rows: &HashMap<i64, Row>) -> Vec<ImportedBookmark> {
    let mut items: Vec<(i64, ImportedBookmark)> = rows
        .iter()
        .filter(|(_, row)| row.kind == 1)
        .filter_map(|(id, row)| {
            let url = row.url.as_deref().filter(|u| is_importable_url(u))?;
            let folder_path = folder_path(rows, row.parent)?;
            Some((
                *id,
                ImportedBookmark {
                    url: url.to_string(),
                    title: row.title.trim().to_string(),
                    folder_path,
                    // Firefox stores microseconds since the Unix epoch.
                    added_at: row.date_added.filter(|d| *d > 0).map(|d| d / 1000),
                },
            ))
        })
        .collect();
    items.sort_by_key(|(id, _)| *id);
    items.into_iter().map(|(_, item)| item).collect()
}

/// Counts importable bookmarks with one aggregate query, without materializing any row.
/// Excludes the tag hierarchy, same as `folder_path`.
fn count_query(conn: &Connection) -> rusqlite::Result<usize> {
    let count: i64 = conn.query_row(
        "WITH RECURSIVE tag_folders(id) AS (
             SELECT id FROM moz_bookmarks WHERE guid = 'tags________'
             UNION
             SELECT b.id FROM moz_bookmarks b JOIN tag_folders t ON b.parent = t.id
         )
         SELECT COUNT(*) FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id
         WHERE b.type = 1
           AND (p.url LIKE 'http://%' OR p.url LIKE 'https://%')
           AND b.parent NOT IN (SELECT id FROM tag_folders)",
        [],
        |row| row.get(0),
    )?;
    Ok(usize::try_from(count).unwrap_or(0))
}

/// [`count_query`] against a private copy.
pub fn count_places(path: &Path) -> AppResult<usize> {
    let conn = open_copy(path)?;
    count_query(&conn).map_err(|error| db_error("Could not count the Firefox bookmarks", &error))
}

/// Imports from a private copy of the database and its WAL.
pub fn read(places: &Path) -> AppResult<Vec<ImportedBookmark>> {
    let (_guard, copy) = TempCopy::new(places)?;
    read_places(&copy)
}

/// Bookmark count only, from a private copy as well. Copying costs more than querying the live
/// file, but opening the live file is exactly what must not happen (see the module docs).
pub fn count(places: &Path) -> AppResult<usize> {
    let (_guard, copy) = TempCopy::new(places)?;
    count_places(&copy)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA: &str = "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
         CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER,
            parent INTEGER, title TEXT, guid TEXT, dateAdded INTEGER);";

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mynk-fftest-{tag}-{}", next_temp_id()));
        fs::create_dir_all(&dir).expect("dir");
        dir
    }

    #[test]
    fn parses_profiles_ini() {
        let ini = "[General]\nStartWithLastProfile=1\n\n[Profile1]\nName=work\nIsRelative=1\nPath=Profiles/abc.work\n\n[Profile0]\nName=default-release\nIsRelative=0\nPath=/abs/xyz\nDefault=1\n\n[Install123]\nDefault=Profiles/abc.work\n";
        let root = Path::new("/root");
        let profiles = parse_profiles_ini(ini, root);
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].name, "work");
        assert!(profiles[0].path.ends_with("abc.work"));
        assert_eq!(profiles[1].path, PathBuf::from("/abs/xyz"));
    }

    #[test]
    fn reads_places_database() {
        let dir = temp_dir("read");
        let db = dir.join("places.sqlite");
        {
            let conn = Connection::open(&db).expect("create db");
            conn.execute_batch(SCHEMA).expect("schema");
            conn.execute_batch(
                "INSERT INTO moz_places VALUES (1, 'https://rust-lang.org/'), (2, 'place:sort=8'),
                    (3, 'https://tagged.example/');
                 INSERT INTO moz_bookmarks VALUES
                    (1, 2, NULL, 0, '', 'root________', 0),
                    (2, 2, NULL, 1, 'menu', 'menu________', 0),
                    (3, 2, NULL, 1, 'toolbar', 'toolbar_____', 0),
                    (4, 2, NULL, 1, 'tags', 'tags________', 0),
                    (5, 2, NULL, 3, 'Dev', 'aaaaaaaaaaaa', 0),
                    (6, 1, 1, 5, 'Rust', 'bbbbbbbbbbbb', 1609459200000000),
                    (7, 1, 2, 2, 'Smart', 'cccccccccccc', 0),
                    (8, 2, NULL, 4, 'mytag', 'dddddddddddd', 0),
                    (9, 1, 3, 8, NULL, 'eeeeeeeeeeee', 0);",
            )
            .expect("seed");
        }
        let items = read(&db).expect("read");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].url, "https://rust-lang.org/");
        assert_eq!(items[0].folder_path, vec!["Bookmarks Toolbar", "Dev"]);
        assert_eq!(items[0].added_at, Some(1_609_459_200_000));
        assert_eq!(
            count(&db).expect("count"),
            items.len(),
            "the COUNT query must agree with the full read"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Seeds a WAL-mode database and keeps the writer open with checkpoints disabled, the way a
    /// running Firefox leaves recent bookmarks only in `places.sqlite-wal`.
    fn wal_database(dir: &Path) -> (PathBuf, Connection) {
        let db = dir.join("places.sqlite");
        let conn = Connection::open(&db).expect("create db");
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .expect("wal mode");
        conn.execute_batch(SCHEMA).expect("schema");
        conn.execute_batch(
            "INSERT INTO moz_bookmarks VALUES
                (1, 2, NULL, 0, '', 'root________', 0),
                (2, 2, NULL, 1, 'menu', 'menu________', 0);",
        )
        .expect("roots");
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("checkpoint");
        // Everything below lives only in the WAL.
        conn.execute_batch(
            "INSERT INTO moz_places VALUES (1, 'https://recent.example/');
             INSERT INTO moz_bookmarks VALUES (3, 1, 1, 2, 'Recent', 'bbbbbbbbbbbb', 0);",
        )
        .expect("recent bookmark");
        assert!(
            fs::metadata(sidecar(&db, "-wal")).expect("wal").len() > 0,
            "the recent bookmark must be in the WAL"
        );
        (db, conn)
    }

    #[test]
    fn bookmarks_that_only_exist_in_the_wal_are_imported_and_counted() {
        let dir = temp_dir("wal");
        let (db, writer) = wal_database(&dir);

        let items = read(&db).expect("read");
        assert_eq!(items.len(), 1, "the copy must include the WAL content");
        assert_eq!(items[0].url, "https://recent.example/");
        assert_eq!(count(&db).expect("count"), 1);

        // The copy itself carries the WAL.
        let copy_dir = temp_dir("wal-copy");
        let copy = copy_with_wal(&db, &copy_dir).expect("copy");
        assert_eq!(read_places(&copy).expect("read copy").len(), 1);
        assert_eq!(count_places(&copy).expect("count copy"), 1);

        drop(writer);
        let _ = fs::remove_dir_all(&copy_dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wal_that_cannot_be_copied_is_an_error_not_a_silent_loss() {
        let dir = temp_dir("badwal");
        let db = dir.join("places.sqlite");
        {
            let conn = Connection::open(&db).expect("create db");
            conn.execute_batch(SCHEMA).expect("schema");
        }
        // Something named `places.sqlite-wal` exists but cannot be read as a file.
        fs::create_dir_all(sidecar(&db, "-wal")).expect("wal dir");
        let copy_dir = temp_dir("badwal-copy");
        let error = copy_with_wal(&db, &copy_dir).expect_err("the WAL copy fails");
        assert_eq!(error.kind(), "storage");
        assert_eq!(
            error.code(),
            Some("browserLocked"),
            "the renderer needs a code, not an English sentence"
        );
        assert!(error.to_string().contains("journal"), "{error}");
        // Import and count go through the same copy and fail the same way.
        for error in [read(&db).expect_err("read"), count(&db).expect_err("count")] {
            assert_eq!(error.kind(), "storage");
            assert_eq!(error.code(), Some("browserLocked"));
            assert!(error.to_string().contains("journal"), "{error}");
        }
        let _ = fs::remove_dir_all(&copy_dir);
        let _ = fs::remove_dir_all(&dir);
    }

    fn listing(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    // A stopped Firefox leaves places.sqlite + -wal but no -shm; reading must not create one.
    #[test]
    fn reading_and_counting_never_touch_the_profile_directory() {
        let seed_dir = temp_dir("untouched-seed");
        let (seed_db, writer) = wal_database(&seed_dir);
        let profile = temp_dir("untouched-profile");
        let places = profile.join("places.sqlite");
        fs::copy(sidecar(&seed_db, "-wal"), sidecar(&places, "-wal")).expect("copy wal");
        fs::copy(&seed_db, &places).expect("copy main");
        drop(writer);
        let _ = fs::remove_dir_all(&seed_dir);

        let before_names = listing(&profile);
        assert_eq!(before_names, vec!["places.sqlite", "places.sqlite-wal"]);
        let before_main = fs::read(&places).expect("main");
        let before_wal = fs::read(sidecar(&places, "-wal")).expect("wal");
        let before_mtime = fs::metadata(&places)
            .and_then(|m| m.modified())
            .expect("mtime");

        let items = read(&places).expect("read");
        assert_eq!(items.len(), 1, "the WAL bookmark is read");
        assert_eq!(items[0].url, "https://recent.example/");
        assert_eq!(count(&places).expect("count"), 1, "and counted");

        assert_eq!(
            listing(&profile),
            before_names,
            "no -shm or other file appears"
        );
        assert_eq!(fs::read(&places).expect("main"), before_main);
        assert_eq!(fs::read(sidecar(&places, "-wal")).expect("wal"), before_wal);
        assert_eq!(
            fs::metadata(&places)
                .and_then(|m| m.modified())
                .expect("mtime"),
            before_mtime
        );
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn database_errors_never_carry_a_file_path() {
        let dir = temp_dir("notadb");
        let db = dir.join("places.sqlite");
        fs::write(
            &db,
            b"definitely not sqlite, but long enough to look like a header....",
        )
        .expect("write");
        let dir_text = dir.to_string_lossy().to_string();
        let temp_text = std::env::temp_dir().to_string_lossy().to_string();
        for error in [read(&db).expect_err("read"), count(&db).expect_err("count")] {
            let message = error.to_string();
            assert_eq!(error.kind(), "storage");
            assert!(!message.contains(&dir_text), "{message}");
            assert!(!message.contains(&temp_text), "{message}");
            assert!(!message.contains("places.sqlite"), "{message}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    fn row(parent: i64, kind: i64, title: &str, guid: &str, url: Option<&str>) -> Row {
        Row {
            parent,
            kind,
            title: title.to_string(),
            guid: guid.to_string(),
            url: url.map(str::to_string),
            date_added: None,
        }
    }

    #[test]
    fn a_folder_chain_deeper_than_the_limit_keeps_the_bookmark() {
        let mut rows = HashMap::new();
        rows.insert(1, row(0, 2, "", "root________", None));
        rows.insert(2, row(1, 2, "menu", "menu________", None));
        // 100 nested folders under the menu: ids 10..=109.
        let mut parent = 2;
        for id in 10..110 {
            rows.insert(id, row(parent, 2, &format!("f{id}"), "xxxxxxxxxxxx", None));
            parent = id;
        }
        rows.insert(
            500,
            row(
                parent,
                1,
                "Deep",
                "yyyyyyyyyyyy",
                Some("https://deep.example/"),
            ),
        );
        let shallow_parent = 12;
        rows.insert(
            501,
            row(
                shallow_parent,
                1,
                "Shallow",
                "zzzzzzzzzzzz",
                Some("https://shallow.example/"),
            ),
        );

        let items = build_bookmarks(&rows);
        assert_eq!(items.len(), 2, "the deep bookmark is not dropped");
        let deep = &items[0];
        assert_eq!(deep.url, "https://deep.example/");
        assert_eq!(deep.folder_path.len(), MAX_FOLDER_DEPTH);
        assert_eq!(
            deep.folder_path.last().map(String::as_str),
            Some("f109"),
            "the nearest folder is kept; the root end is cut"
        );
        assert_eq!(
            items[1].folder_path,
            vec!["Bookmarks Menu", "f10", "f11", "f12"]
        );

        // A cycle in a damaged database terminates too.
        let mut cyclic = HashMap::new();
        cyclic.insert(1, row(2, 2, "a", "aaaaaaaaaaaa", None));
        cyclic.insert(2, row(1, 2, "b", "bbbbbbbbbbbb", None));
        cyclic.insert(
            3,
            row(1, 1, "x", "cccccccccccc", Some("https://x.example/")),
        );
        assert_eq!(build_bookmarks(&cyclic).len(), 1);
    }

    #[test]
    fn the_sweep_removes_only_stale_temp_copies() {
        let root = std::env::temp_dir().join(format!("mynk-sweep-{}", next_temp_id()));
        fs::create_dir_all(&root).expect("root");
        let copies = [
            root.join(format!("{TEMP_COPY_PREFIX}1-1")),
            root.join(format!("{TEMP_COPY_PREFIX}1-2")),
        ];
        let unrelated = root.join("some-other-tool");
        for dir in copies.iter().chain([&unrelated]) {
            fs::create_dir_all(dir).expect("dir");
            fs::write(dir.join("places.sqlite"), vec![0u8; 32]).expect("file");
        }
        // A plain file that happens to share the prefix is not a copy.
        let file = root.join(format!("{TEMP_COPY_PREFIX}note.txt"));
        fs::write(&file, b"x").expect("file");

        // Copies younger than the age limit belong to a running import.
        assert_eq!(sweep_temp_copies_in(&root, TEMP_COPY_MAX_AGE), 0);
        assert!(copies.iter().all(|dir| dir.is_dir()));

        // With no grace period every copy is stale; everything else is left alone.
        assert_eq!(sweep_temp_copies_in(&root, Duration::ZERO), 2);
        assert!(copies.iter().all(|dir| !dir.exists()));
        assert!(unrelated.is_dir(), "unrelated directories are untouched");
        assert!(file.is_file(), "files are never removed");
        let _ = fs::remove_dir_all(&root);
    }
}
