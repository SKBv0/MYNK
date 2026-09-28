//! Browser bookmark import from real fixture profiles: a Chromium `Bookmarks` JSON tree and a
//! real `places.sqlite` database.

use std::fs;
use std::path::{Path, PathBuf};

use app_lib::browsers::registry::{BrowserFamily, ProfileRegistry, ProfileSource, SourceKind};
use app_lib::browsers::{self, chromium, firefox};
use rusqlite::Connection;

/// 2021-01-01T00:00:00Z expressed in the WebKit epoch (µs since 1601-01-01).
const WEBKIT_2021: i64 = (1_609_459_200_000 + 11_644_473_600_000) * 1000;

fn chromium_profile(root: &Path) -> PathBuf {
    let profile = root.join("User Data").join("Default");
    fs::create_dir_all(&profile).expect("profile dir");
    let bookmarks = profile.join("Bookmarks");
    let json = format!(
        r#"{{
      "checksum": "abc", "version": 1,
      "roots": {{
        "bookmark_bar": {{ "type": "folder", "name": "Bookmarks bar", "children": [
          {{ "type": "url", "name": " Rust ", "url": "https://www.rust-lang.org/",
             "date_added": "{WEBKIT_2021}" }},
          {{ "type": "folder", "name": "Dev", "children": [
            {{ "type": "folder", "name": "Rust", "children": [
              {{ "type": "url", "name": "Tauri", "url": "http://tauri.app/" }}
            ]}},
            {{ "type": "url", "name": "Settings", "url": "chrome://settings" }},
            {{ "type": "url", "name": "Script", "url": "javascript:alert(1)" }},
            {{ "type": "url", "name": "Local", "url": "file:///C:/notes.txt" }}
          ]}}
        ]}},
        "other": {{ "type": "folder", "name": "Other bookmarks", "children": [
          {{ "type": "url", "name": "Docs", "url": "https://docs.rs/" }}
        ]}},
        "sync_transaction_version": "1"
      }}
    }}"#
    );
    fs::write(&bookmarks, json).expect("write bookmarks");
    fs::write(
        profile.parent().expect("user data").join("Local State"),
        r#"{"profile":{"info_cache":{"Default":{"name":"Work profile"}}}}"#,
    )
    .expect("write local state");
    bookmarks
}

fn firefox_places(root: &Path) -> PathBuf {
    let profile = root.join("Profiles").join("abc.default");
    fs::create_dir_all(&profile).expect("profile dir");
    let places = profile.join("places.sqlite");
    let connection = Connection::open(&places).expect("create db");
    connection
        .execute_batch(
            "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
             CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER,
                parent INTEGER, title TEXT, guid TEXT, dateAdded INTEGER);
             INSERT INTO moz_places VALUES
                (1, 'https://rust-lang.org/'), (2, 'place:sort=8'),
                (3, 'https://tagged.example/'), (4, 'https://mozilla.org/');
             INSERT INTO moz_bookmarks VALUES
                (1, 2, NULL, 0, '', 'root________', 0),
                (2, 2, NULL, 1, 'menu', 'menu________', 0),
                (3, 2, NULL, 1, 'toolbar', 'toolbar_____', 0),
                (4, 2, NULL, 1, 'tags', 'tags________', 0),
                (5, 2, NULL, 3, 'Dev', 'aaaaaaaaaaaa', 0),
                (6, 1, 1, 5, ' Rust ', 'bbbbbbbbbbbb', 1609459200000000),
                (7, 1, 2, 2, 'Smart folder', 'cccccccccccc', 0),
                (8, 2, NULL, 4, 'mytag', 'dddddddddddd', 0),
                (9, 1, 3, 8, NULL, 'eeeeeeeeeeee', 0),
                (10, 1, 4, 2, 'Mozilla', 'ffffffffffff', 0);",
        )
        .expect("seed");
    drop(connection);

    fs::write(
        root.join("profiles.ini"),
        "[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default\n",
    )
    .expect("write profiles.ini");
    places
}

#[test]
fn chromium_bookmark_trees_are_flattened_with_folder_paths() {
    let root = tempfile::tempdir().expect("temp dir");
    let bookmarks = chromium_profile(root.path());

    let items = chromium::read(&bookmarks).expect("read bookmarks");
    assert_eq!(items.len(), 3, "only http/https entries are imported");

    assert_eq!(items[0].title, "Rust", "titles are trimmed");
    assert_eq!(items[0].url, "https://www.rust-lang.org/");
    assert_eq!(items[0].folder_path, vec!["Bookmarks bar"]);
    assert_eq!(items[0].added_at, Some(1_609_459_200_000));

    assert_eq!(items[1].url, "http://tauri.app/");
    assert_eq!(items[1].folder_path, vec!["Bookmarks bar", "Dev", "Rust"]);
    assert_eq!(items[1].added_at, None, "missing dates stay absent");

    assert_eq!(items[2].url, "https://docs.rs/");
    assert_eq!(items[2].folder_path, vec!["Other bookmarks"]);
}

#[test]
fn firefox_places_databases_are_read_through_a_private_copy() {
    let root = tempfile::tempdir().expect("temp dir");
    let places = firefox_places(root.path());

    let items = firefox::read(&places).expect("read places");
    assert_eq!(items.len(), 2, "place: URLs and tag entries are skipped");
    assert_eq!(items[0].url, "https://rust-lang.org/");
    assert_eq!(items[0].title, "Rust");
    assert_eq!(items[0].folder_path, vec!["Bookmarks Toolbar", "Dev"]);
    assert_eq!(items[0].added_at, Some(1_609_459_200_000));
    assert_eq!(items[1].url, "https://mozilla.org/");
    assert_eq!(items[1].folder_path, vec!["Bookmarks Menu"]);

    assert!(places.is_file());

    let profiles = firefox::parse_profiles_ini(
        &fs::read_to_string(root.path().join("profiles.ini")).expect("ini"),
        root.path(),
    );
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].name, "default-release");
    assert_eq!(profiles[0].path.join("places.sqlite"), places);
}

/// Detection takes a cheap count-only path; the number must still match a full import.
#[test]
fn bookmark_counts_match_what_the_import_returns() {
    let root = tempfile::tempdir().expect("temp dir");
    let bookmarks = chromium_profile(root.path());
    let places = firefox_places(root.path());

    assert_eq!(
        chromium::count(&bookmarks).expect("chromium count"),
        chromium::read(&bookmarks).expect("chromium read").len()
    );
    assert_eq!(
        firefox::count(&places).expect("firefox count"),
        firefox::read(&places).expect("firefox read").len(),
        "place: URLs and tag entries must be excluded from the count too"
    );

    // Broken sources report an error through the count path as well.
    let broken = root.path().join("Broken");
    fs::write(&broken, "{not json").expect("write");
    assert_eq!(
        chromium::count(&broken).expect_err("broken").kind(),
        "parse"
    );
    let not_a_db = root.path().join("not-places.sqlite");
    fs::write(&not_a_db, b"definitely not sqlite").expect("write");
    assert!(firefox::count(&not_a_db).is_err());
}

/// A running Firefox keeps recent writes in `places.sqlite-wal`; import and count must see these.
#[test]
fn bookmarks_still_in_the_firefox_wal_are_imported_and_counted() {
    let root = tempfile::tempdir().expect("temp dir");
    let places = firefox_places(root.path());
    let writer = Connection::open(&places).expect("open");
    writer
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .expect("wal mode");
    writer
        .execute_batch(
            "INSERT INTO moz_places VALUES (5, 'https://only-in-wal.example/');
             INSERT INTO moz_bookmarks VALUES (11, 1, 5, 2, 'Fresh', 'gggggggggggg', 0);",
        )
        .expect("recent bookmark");
    let wal = PathBuf::from(format!("{}-wal", places.display()));
    assert!(fs::metadata(&wal).expect("wal").len() > 0);

    let items = firefox::read(&places).expect("read places");
    assert_eq!(items.len(), 3);
    assert!(items
        .iter()
        .any(|item| item.url == "https://only-in-wal.example/"));
    assert_eq!(firefox::count(&places).expect("count"), 3);

    // The writer's WAL was neither checkpointed nor removed by the reads.
    assert!(fs::metadata(&wal).expect("wal still there").len() > 0);
    drop(writer);
}

#[test]
fn opaque_profile_ids_resolve_to_sources_and_never_leak_paths() {
    let root = tempfile::tempdir().expect("temp dir");
    let bookmarks = chromium_profile(root.path());
    let places = firefox_places(root.path());

    let sources = vec![
        ProfileSource {
            browser: BrowserFamily::Edge,
            profile_name: "Work profile".to_string(),
            kind: SourceKind::ChromiumBookmarks(bookmarks.clone()),
        },
        ProfileSource {
            browser: BrowserFamily::Firefox,
            profile_name: "default-release".to_string(),
            kind: SourceKind::FirefoxPlaces(places.clone()),
        },
    ];
    let registry = ProfileRegistry::default();
    registry.replace(&sources);

    let chromium_id = sources[0].id();
    let firefox_id = sources[1].id();
    assert!(chromium_id.starts_with("edge-"));
    assert!(firefox_id.starts_with("firefox-"));
    for id in [&chromium_id, &firefox_id] {
        assert!(
            !id.contains(&root.path().to_string_lossy().to_string()),
            "ids must not carry a path"
        );
    }

    assert_eq!(
        browsers::read(&registry, &chromium_id)
            .expect("chromium bookmarks")
            .len(),
        3
    );
    assert_eq!(
        browsers::read(&registry, &firefox_id)
            .expect("firefox bookmarks")
            .len(),
        2
    );

    // A stale id triggers one re-detection and then a clean notFound.
    let error = browsers::read(&registry, "chrome-deadbeefdeadbeef").expect_err("unknown id");
    assert_eq!(error.kind(), "notFound");
}

#[test]
fn detection_on_this_machine_returns_a_list_and_never_fails() {
    let registry = ProfileRegistry::default();
    let profiles = browsers::detect(&registry);
    for profile in &profiles {
        assert!(!profile.id.is_empty());
        // Whatever is installed here, a detected profile must resolve back through the registry.
        assert!(browsers::read(&registry, &profile.id).is_ok() || profile.error.is_some());
    }
}

#[test]
fn a_missing_or_broken_profile_is_an_error_not_a_panic() {
    let root = tempfile::tempdir().expect("temp dir");
    let missing = root.path().join("Bookmarks");
    assert_eq!(
        chromium::read(&missing).expect_err("missing file").kind(),
        "notFound"
    );

    let broken = root.path().join("Broken");
    fs::write(&broken, "{not json").expect("write");
    assert_eq!(
        chromium::read(&broken).expect_err("broken file").kind(),
        "parse"
    );

    let not_a_db = root.path().join("places.sqlite");
    fs::write(&not_a_db, b"definitely not sqlite").expect("write");
    assert!(firefox::read(&not_a_db).is_err());
}
