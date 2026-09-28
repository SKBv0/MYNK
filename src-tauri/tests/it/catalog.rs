//! Agent access core against real temp dirs and a real (mock-runtime) Tauri app: the Tauri-free
//! path resolution must agree with Tauri's own, and a library the app writes must read back here.

use std::fs;
use std::path::Path;

use app_lib::catalog::inbox::{self, InboxEntry};
use app_lib::catalog::model;
use app_lib::catalog::search::{self, Filters, MatchedBy, Query, SearchMode};
use app_lib::catalog::views;
use app_lib::paths;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::Manager;

/// A library the app would write: one record per shape the agent has to cope with.
fn library_json() -> String {
    serde_json::json!({
        "version": 3,
        "savedAt": 1_757_700_000_000i64,
        "resources": [
            {
                "id": "r1",
                "url": "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
                "urlKey": "doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
                "title": "Ownership in Rust",
                "description": "How ownership, borrowing and lifetimes work.",
                "categoryId": "development",
                "tags": ["rust", "memory"],
                "summary": ["Every value in Rust has a single owner."],
                "folderPath": ["Bookmarks bar", "Dev"],
                "createdAt": 1_757_300_000_000i64,
                "updatedAt": 1_757_300_000_000i64,
                "lastOpenedAt": 1_757_400_000_000i64,
                "isFavorite": false,
                "ai": { "status": "ok", "analyzedAt": 1_757_300_000_000i64, "confidence": 0.92 },
                "media": { "snapshotFile": "shot-1.png", "faviconFile": "fav-1.png" },
                "health": { "status": "alive", "checkedAt": 1_757_350_000_000i64, "httpStatus": 200 }
            },
            {
                "id": "r2",
                "url": "https://tr.example.com/yazilim-gelistirme",
                "urlKey": "tr.example.com/yazilim-gelistirme",
                "title": "Yazılım Geliştirme Rehberi",
                "description": "Türkçe kaynaklar.",
                "categoryId": "learning",
                "tags": ["yazılım", "rehber"],
                "summary": [],
                "folderPath": [],
                "createdAt": 1_757_200_000_000i64,
                "updatedAt": 1_757_200_000_000i64,
                "lastOpenedAt": null,
                "isFavorite": true,
                "ai": { "status": "none", "analyzedAt": null, "confidence": null },
                "media": {},
                "health": { "status": "unknown", "checkedAt": null }
            },
            {
                "id": "r3",
                "url": "https://dead.example.com/gone",
                "title": "Gone",
                "categoryId": "development",
                "tags": [],
                "createdAt": 1_757_100_000_000i64,
                "lastOpenedAt": null,
                "ai": { "status": "failed" },
                "health": { "status": "dead", "checkedAt": 1_757_350_000_000i64, "httpStatus": 404 }
            },
            "this record is not even an object"
        ],
        "collections": [
            {
                "id": "c1",
                "name": "Rust",
                "description": "Rust reading list",
                "keywords": ["rust"],
                "pinnedIds": ["r2"],
                "color": "#ff8800",
                "createdAt": 1,
                "updatedAt": 2
            }
        ],
        "chats": { "global": [{ "id": "m1", "role": "user", "content": "secret question" }] },
        "settings": { "lang": "tr", "theme": { "accent": "#f00" } },
        "healthMeta": { "hasRun": true, "lastScanAt": 1_757_350_000_000i64 }
    })
    .to_string()
}

fn seeded_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    // Written through the app's own writer, so the agent reads exactly what the app produces.
    app_lib::library::save(dir.path(), &library_json()).expect("seed library.json");
    dir
}

#[test]
fn path_resolution_matches_tauri() {
    let mut context = mock_context(noop_assets());
    context.config_mut().identifier = paths::APP_IDENTIFIER.to_string();
    let app = mock_builder().build(context).expect("build mock app");

    let tauri_data = app.path().app_data_dir().expect("tauri app_data_dir");
    let tauri_cache = app.path().app_cache_dir().expect("tauri app_cache_dir");
    assert_eq!(paths::default_data_dir().expect("data dir"), tauri_data);
    assert_eq!(paths::default_cache_dir().expect("cache dir"), tauri_cache);
    assert!(
        tauri_data.ends_with(paths::APP_IDENTIFIER),
        "{tauri_data:?}"
    );
    assert_eq!(
        paths::inbox_dir(&tauri_data),
        tauri_data.join("inbox"),
        "the app and the agent must agree on the inbox location"
    );
    assert_eq!(
        paths::semantic_index_path(&tauri_cache),
        tauri_cache.join("semantic.sqlite")
    );
}

#[test]
fn a_real_library_file_is_read_searched_and_summarized() {
    let dir = seeded_dir();
    let lib = model::load(dir.path()).expect("load");
    assert_eq!(lib.version, 3);
    assert_eq!(lib.resources.len(), 3);
    assert_eq!(lib.skipped, 1, "the bogus record was skipped, not fatal");

    let outcome = search::search_with(&lib, &Query::keyword("ownership rust"), None);
    assert_eq!(outcome.mode_used, SearchMode::Keyword);
    assert_eq!(outcome.note, None);
    assert_eq!(outcome.hits.len(), 1);
    assert_eq!(outcome.hits[0].resource.id, "r1");
    assert_eq!(outcome.hits[0].matched_by, MatchedBy::Keyword);

    // A Turkish query typed without the Turkish letters still finds the Turkish record.
    let outcome = search::search_with(&lib, &Query::keyword("yazilim gelistirme"), None);
    assert_eq!(
        outcome
            .hits
            .iter()
            .map(|hit| hit.resource.id.as_str())
            .collect::<Vec<_>>(),
        vec!["r2"]
    );

    let query = Query {
        filters: Filters {
            category: Some("development".into()),
            unopened_only: true,
            ..Filters::default()
        },
        ..Query::keyword("")
    };
    assert_eq!(
        search::search_with(&lib, &query, None)
            .hits
            .iter()
            .map(|hit| hit.resource.id.as_str())
            .collect::<Vec<_>>(),
        vec!["r3"]
    );

    let stats = views::stats(&lib);
    assert_eq!(stats.total, 3);
    assert_eq!(stats.analyzed, 1);
    assert_eq!(stats.unanalyzed, 2);
    assert_eq!(stats.broken, 1);
    assert_eq!(stats.favorites, 1);
    assert_eq!(stats.collections, 1);
    assert_eq!(stats.skipped, 1);
    assert_eq!(stats.newest_created_at, Some(1_757_300_000_000));
    assert_eq!(
        stats.by_category,
        vec![("development".to_string(), 2), ("learning".to_string(), 1)]
    );

    let recent = views::recent(&lib, Some(1_757_200_000_000), 10, false);
    assert_eq!(
        recent.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["r1", "r2"]
    );
    let unopened = views::unopened(&lib, None, 10);
    assert_eq!(
        unopened.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["r2", "r3"]
    );
    assert_eq!(
        views::tags(&lib)
            .iter()
            .map(|(tag, count)| (tag.as_str(), *count))
            .collect::<Vec<_>>(),
        vec![("memory", 1), ("rehber", 1), ("rust", 1), ("yazılım", 1)]
    );
    let collections = views::collections(&lib);
    assert_eq!(collections.len(), 1);
    assert_eq!(collections[0].name, "Rust");
    assert_eq!(
        collections[0].member_count, 2,
        "r1 matches the keyword, r2 is pinned"
    );

    assert_eq!(
        views::get(&lib, "r3").map(|r| r.title.as_str()),
        Some("Gone")
    );
    assert_eq!(
        views::get(&lib, "http://www.dead.example.com/gone/").map(|r| r.id.as_str()),
        Some("r3"),
        "a URL matches regardless of scheme, www. or a trailing slash"
    );
}

#[test]
fn media_file_names_and_chats_never_leave_the_app() {
    let dir = seeded_dir();
    let lib = model::load(dir.path()).expect("load");
    let serialised = serde_json::to_string(&lib.resources).expect("serialize");
    for secret in [
        "shot-1.png",
        "fav-1.png",
        "secret question",
        "media",
        "chats",
    ] {
        assert!(
            !serialised.contains(secret),
            "{secret} leaked: {serialised}"
        );
    }
}

#[test]
fn a_future_schema_is_refused_instead_of_misread() {
    let dir = tempfile::tempdir().expect("temp dir");
    app_lib::library::save(
        dir.path(),
        &serde_json::json!({ "version": 4, "resources": [] }).to_string(),
    )
    .expect("seed");
    let error = model::load(dir.path()).expect_err("schema 4");
    assert_eq!(error.kind(), "storage");
    assert!(
        error.to_string().contains("schema 4 is not supported"),
        "{error}"
    );
}

#[test]
fn a_corrupt_library_falls_back_to_the_backup() {
    let dir = seeded_dir();
    // A second save rotates the seeded content into library.json.bak.
    app_lib::library::save(dir.path(), &library_json()).expect("second save");
    fs::write(dir.path().join("library.json"), "{ half written").expect("corrupt");

    let lib = model::load(dir.path()).expect("load from the backup");
    assert_eq!(lib.resources.len(), 3);
}

#[test]
fn a_machine_without_a_library_reads_as_empty() {
    let dir = tempfile::tempdir().expect("temp dir");
    let lib = model::load(dir.path()).expect("load");
    assert!(lib.resources.is_empty());
    assert_eq!(lib.version, model::SCHEMA_VERSION);
    assert!(search::search_with(&lib, &Query::keyword("anything"), None)
        .hits
        .is_empty());
    assert_eq!(views::stats(&lib).total, 0);
}

#[test]
fn the_inbox_round_trips_through_the_real_filesystem() {
    let dir = seeded_dir();
    let data_dir: &Path = dir.path();
    assert_eq!(inbox::count(data_dir), 0);

    let mut entry = InboxEntry::new("https://example.com/from-an-agent", "mcp:claude-code");
    entry.title = Some("From an agent".into());
    entry.tags = vec!["rust".into(), "rust".into()];
    entry.note = Some("added while the app was closed".into());
    let name = inbox::write(data_dir, &entry).expect("write");
    assert!(name.ends_with(".json"));
    assert!(
        !name.contains('/') && !name.contains('\\'),
        "the agent only learns a file name: {name}"
    );
    assert_eq!(inbox::count(data_dir), 1);

    // Writing does not touch the library the app owns.
    let before = fs::read_to_string(data_dir.join("library.json")).expect("library");
    assert_eq!(before, library_json());

    let drained = inbox::drain(data_dir).expect("drain");
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].url, "https://example.com/from-an-agent");
    assert_eq!(drained[0].tags, vec!["rust"], "duplicates are dropped");
    assert_eq!(drained[0].source, "mcp:claude-code");
    assert_eq!(inbox::count(data_dir), 0);
    assert!(inbox::drain(data_dir).expect("drain again").is_empty());

    let bad = InboxEntry::new("javascript:alert(1)", "cli");
    assert_eq!(
        inbox::write(data_dir, &bad).expect_err("not http").kind(),
        "invalidInput"
    );
    assert_eq!(inbox::count(data_dir), 0);
}
