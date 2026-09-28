//! Library persistence and export against the real filesystem.

use std::fs;

use app_lib::commands::library::{library_load, library_save};
use app_lib::library::{export, LibraryLoad, MAX_LIBRARY_BYTES};

use crate::support::offline_app;

fn library(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("library.json")
}

fn backup(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("library.json.bak")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saving_rotates_a_backup_and_never_leaves_a_temp_file() {
    let app = offline_app();
    let dir = app.data_dir().clone();

    let empty = library_load(app.state()).await.expect("empty");
    assert_eq!(
        empty,
        LibraryLoad {
            json: None,
            recovered_from_backup: false
        }
    );
    assert_eq!(
        serde_json::to_value(&empty).expect("serialize"),
        serde_json::json!({ "json": null, "recoveredFromBackup": false }),
        "a missing library serializes `json` as null"
    );

    library_save(app.state(), r#"{"v":1}"#.to_string())
        .await
        .expect("save 1");
    library_save(app.state(), r#"{"v":2}"#.to_string())
        .await
        .expect("save 2");

    let loaded = library_load(app.state()).await.expect("load");
    assert_eq!(loaded.json.as_deref(), Some(r#"{"v":2}"#));
    assert!(!loaded.recovered_from_backup, "a healthy main file");
    assert_eq!(
        fs::read_to_string(backup(&dir)).expect("backup"),
        r#"{"v":1}"#
    );
    assert!(!dir.join("library.json.tmp").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_corrupt_or_missing_main_file_falls_back_to_the_backup() {
    let app = offline_app();
    let dir = app.data_dir().clone();
    library_save(app.state(), r#"{"v":1}"#.to_string())
        .await
        .expect("save 1");
    library_save(app.state(), r#"{"v":2}"#.to_string())
        .await
        .expect("save 2");

    fs::write(library(&dir), "{broken").expect("corrupt the main file");
    let loaded = library_load(app.state()).await.expect("load");
    assert_eq!(loaded.json.as_deref(), Some(r#"{"v":1}"#));
    assert!(loaded.recovered_from_backup, "the backup was used");

    // A crash between the two renames leaves no main file at all.
    fs::remove_file(library(&dir)).expect("remove");
    let loaded = library_load(app.state()).await.expect("load");
    assert_eq!(loaded.json.as_deref(), Some(r#"{"v":1}"#));
    assert!(loaded.recovered_from_backup, "the backup was used");

    fs::write(library(&dir), "{broken").expect("corrupt");
    fs::write(backup(&dir), "also broken").expect("corrupt backup");
    let error = library_load(app.state()).await.expect_err("both corrupt");
    assert_eq!(error.kind(), "storage");
}

/// The broken main file is set aside, not rotated over the only good backup copy.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_after_a_backup_fallback_does_not_overwrite_the_backup() {
    let app = offline_app();
    let dir = app.data_dir().clone();
    library_save(app.state(), r#"{"v":1}"#.to_string())
        .await
        .expect("save 1");
    library_save(app.state(), r#"{"v":2}"#.to_string())
        .await
        .expect("save 2");
    fs::write(library(&dir), "{broken").expect("corrupt the main file");
    let loaded = library_load(app.state()).await.expect("load");
    assert_eq!(loaded.json.as_deref(), Some(r#"{"v":1}"#));
    assert!(loaded.recovered_from_backup, "the backup was used");

    library_save(app.state(), r#"{"v":3}"#.to_string())
        .await
        .expect("save 3");
    assert_eq!(
        fs::read_to_string(backup(&dir)).expect("backup"),
        r#"{"v":1}"#
    );
    let aside: Vec<_> = fs::read_dir(&dir)
        .expect("dir")
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("library.json.corrupt-")
        })
        .collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(
        fs::read_to_string(aside[0].path()).expect("aside"),
        "{broken"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_or_oversized_payloads_are_refused() {
    let app = offline_app();

    let invalid = library_save(app.state(), "not json".to_string())
        .await
        .expect_err("invalid JSON");
    assert_eq!(invalid.kind(), "parse");

    let huge = "x".repeat(MAX_LIBRARY_BYTES as usize + 1);
    let too_big = library_save(app.state(), huge)
        .await
        .expect_err("too large");
    assert_eq!(too_big.kind(), "storage");
    assert!(too_big.to_string().contains("64 MB"), "{too_big}");

    assert!(!app.data_dir().join("library.json").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_saves_are_serialized_and_leave_valid_json() {
    let app = offline_app();
    let body = |i: usize| format!(r#"{{"writer":{i},"pad":"{}"}}"#, "p".repeat(4096));

    let (a, b, c, d, e, f, g, h) = tokio::join!(
        library_save(app.state(), body(0)),
        library_save(app.state(), body(1)),
        library_save(app.state(), body(2)),
        library_save(app.state(), body(3)),
        library_save(app.state(), body(4)),
        library_save(app.state(), body(5)),
        library_save(app.state(), body(6)),
        library_save(app.state(), body(7)),
    );
    for result in [a, b, c, d, e, f, g, h] {
        result.expect("every save must succeed");
    }

    let loaded = library_load(app.state())
        .await
        .expect("load")
        .json
        .expect("some content");
    let value: serde_json::Value = serde_json::from_str(&loaded).expect("valid JSON survived");
    assert!(value["writer"].is_number());
    assert!(!app.data_dir().join("library.json.tmp").exists());
}

/// A load must never observe the rename window between `library.json` and its `.bak` copy.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn loads_interleaved_with_saves_always_see_a_complete_library() {
    let app = offline_app();
    let body = |i: usize| format!(r#"{{"writer":{i},"pad":"{}"}}"#, "p".repeat(4096));
    library_save(app.state(), body(0)).await.expect("seed");

    let (s1, l1, s2, l2, s3, l3) = tokio::join!(
        library_save(app.state(), body(1)),
        library_load(app.state()),
        library_save(app.state(), body(2)),
        library_load(app.state()),
        library_save(app.state(), body(3)),
        library_load(app.state()),
    );
    for save in [s1, s2, s3] {
        save.expect("save");
    }
    for load in [l1, l2, l3] {
        let loaded = load.expect("load");
        assert!(
            !loaded.recovered_from_backup,
            "the backup must never be observed"
        );
        let content = loaded.json.expect("a library must be there");
        let value: serde_json::Value = serde_json::from_str(&content).expect("valid JSON");
        assert!(value["writer"].is_number(), "{content}");
    }
    assert!(!app.data_dir().join("library.json.tmp").exists());
}

#[test]
fn exports_are_written_with_sanitized_unique_names() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path();

    assert_eq!(export::sanitize_stem("Yer imlerim.json"), "Yer imlerim");
    assert_eq!(export::sanitize_stem("../../etc/passwd"), "passwd");
    assert_eq!(export::sanitize_stem("C:\\Users\\x\\evil.html"), "evil");
    assert_eq!(export::sanitize_stem("CON"), "mynk-export");

    let first = export::write_unique(path, "lib", export::ExportFormat::Json, r#"{"a":1}"#)
        .expect("first export");
    let second = export::write_unique(path, "lib", export::ExportFormat::Html, "<html></html>")
        .expect("html export");
    let third = export::write_unique(path, "lib", export::ExportFormat::Json, r#"{"a":2}"#)
        .expect("second json export");

    assert!(first.ends_with("lib.json"));
    assert!(second.ends_with("lib.html"));
    assert!(third.ends_with("lib (1).json"));
    assert_eq!(fs::read_to_string(&first).expect("read"), r#"{"a":1}"#);

    // Reveal is restricted to the export directory.
    export::resolve_revealable(path, &first.to_string_lossy()).expect("inside the export dir");
    let outside = tempfile::tempdir().expect("other dir");
    let stray = outside.path().join("stray.json");
    fs::write(&stray, "{}").expect("write");
    assert_eq!(
        export::resolve_revealable(path, &stray.to_string_lossy())
            .expect_err("outside")
            .kind(),
        "invalidInput"
    );
}
