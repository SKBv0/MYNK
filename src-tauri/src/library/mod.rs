//! Library persistence (`<app data dir>/library.json`) with atomic writes and a `.bak` copy.
//! Blocking functions; commands call them through `state::run_blocking`.

pub mod export;

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::de::IgnoredAny;
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const LIBRARY_FILE: &str = "library.json";
pub const MAX_LIBRARY_BYTES: u64 = 64 * 1024 * 1024;

/// User-facing message when the library file cannot be opened or read. The OS error (localized,
/// may name the file) goes to the log only.
pub const READ_FAILED_MESSAGE: &str = "The library file is in use or cannot be read.";
/// User-facing message when the library file cannot be written or replaced.
pub const WRITE_FAILED_MESSAGE: &str = "The library file is in use or cannot be saved.";
/// User-facing message when `library.json` is marked read-only: saves stop instead of replacing it.
pub const READ_ONLY_MESSAGE: &str =
    "The library file is read-only. Clear the read-only attribute on library.json to save changes.";

/// `LibraryLoadResult` in ipcTypes.ts. `json` is `null` when no library exists yet;
/// `recovered_from_backup` is true when the `.bak` copy was returned instead of the main file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLoad {
    pub json: Option<String>,
    pub recovered_from_backup: bool,
}

/// Logs an I/O failure with its OS detail and returns a fixed message without it.
fn io_failure(
    action: &'static str,
    message: &'static str,
) -> impl FnOnce(std::io::Error) -> AppError {
    move |error| {
        log::warn!("library: could not {action}: {error}");
        AppError::storage(message)
    }
}

fn main_path(dir: &Path) -> PathBuf {
    dir.join(LIBRARY_FILE)
}

fn backup_path(dir: &Path) -> PathBuf {
    dir.join(format!("{LIBRARY_FILE}.bak"))
}

fn tmp_path(dir: &Path) -> PathBuf {
    dir.join(format!("{LIBRARY_FILE}.tmp"))
}

fn is_valid_json(text: &str) -> bool {
    serde_json::from_str::<IgnoredAny>(text).is_ok()
}

fn read_capped(path: &Path) -> AppResult<Option<String>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_failure("open the file", READ_FAILED_MESSAGE)(e)),
    };
    let len = file
        .metadata()
        .map_err(io_failure("read the file size", READ_FAILED_MESSAGE))?
        .len();
    if len > MAX_LIBRARY_BYTES {
        return Err(AppError::storage(format!(
            "The library file is too large ({} MB, max {} MB).",
            len / (1024 * 1024),
            MAX_LIBRARY_BYTES / (1024 * 1024)
        )));
    }
    let mut content = String::with_capacity(usize::try_from(len).unwrap_or(0));
    file.take(MAX_LIBRARY_BYTES)
        .read_to_string(&mut content)
        .map_err(io_failure("read the file", READ_FAILED_MESSAGE))?;
    Ok(Some(content))
}

/// Name for a main file that is set aside instead of being rotated over a good backup.
fn corrupt_path(dir: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let base = format!("{LIBRARY_FILE}.corrupt-{stamp}");
    let mut candidate = dir.join(&base);
    let mut n = 1u32;
    while candidate.exists() {
        candidate = dir.join(format!("{base}-{n}"));
        n += 1;
    }
    candidate
}

/// Returns the library JSON, falling back to `.bak` when the main file is missing or invalid.
/// A main file that exists but can't be read fails the load; the backup is not used then.
pub fn load(dir: &Path) -> AppResult<LibraryLoad> {
    let main_corrupt = match read_capped(&main_path(dir)) {
        Ok(Some(content)) if is_valid_json(&content) => {
            return Ok(LibraryLoad {
                json: Some(content),
                recovered_from_backup: false,
            })
        }
        Ok(Some(_)) => {
            log::warn!("library.json is corrupt; trying library.json.bak");
            true
        }
        Ok(None) => false,
        Err(error) => {
            log::warn!("library.json exists but could not be read ({error}); not using the backup");
            return Err(error);
        }
    };
    match read_capped(&backup_path(dir))? {
        Some(content) if is_valid_json(&content) => {
            log::warn!("Loaded library from backup");
            Ok(LibraryLoad {
                json: Some(content),
                recovered_from_backup: true,
            })
        }
        Some(_) if main_corrupt => Err(AppError::storage(
            "Both library.json and its backup are corrupt.",
        )),
        Some(_) => Err(AppError::storage(
            "library.json is missing and its backup is corrupt.",
        )),
        None if main_corrupt => Err(AppError::storage(
            "library.json is corrupt and no backup exists.",
        )),
        None => Ok(LibraryLoad {
            json: None,
            recovered_from_backup: false,
        }),
    }
}

/// Start-up only: removes a `library.json.tmp` left by a save that crashed before its rename, or
/// promotes it when the crash came after `library.json` had moved to `.bak`.
pub fn sweep_orphan_temp(dir: &Path) {
    let tmp = tmp_path(dir);
    let main = main_path(dir);
    let main_missing =
        matches!(fs::symlink_metadata(&main), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    if main_missing && matches!(read_capped(&tmp), Ok(Some(content)) if is_valid_json(&content)) {
        match fs::rename(&tmp, &main) {
            Ok(()) => log::warn!("library.json was missing; restored it from library.json.tmp"),
            // Kept: it may be the newest copy of the library.
            Err(e) => log::warn!("could not restore library.json from library.json.tmp: {e}"),
        }
        return;
    }
    match fs::remove_file(&tmp) {
        Ok(()) => log::info!("removed an orphaned library.json.tmp"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("could not remove library.json.tmp: {e}"),
    }
}

/// How many `library.json.corrupt-*` files start-up keeps.
pub const MAX_CORRUPT_COPIES: usize = 5;

/// Sort key of a set-aside file: `library.json.corrupt-<secs>[-<n>]`. Names that do not parse
/// sort first, so they are the first to go.
fn corrupt_sort_key(name: &str) -> Option<(u64, u32)> {
    let rest = name.strip_prefix(&format!("{LIBRARY_FILE}.corrupt-"))?;
    let (secs, n) = match rest.split_once('-') {
        Some((secs, n)) => (secs, n.parse().ok()?),
        None => (rest, 0),
    };
    Some((secs.parse().ok()?, n))
}

/// Start-up: keeps the oldest set-aside corrupt copy plus the newest `keep - 1`, so a recurring
/// problem cannot fill the data directory while the copy closest to the user's data survives.
pub fn prune_corrupt_copies(dir: &Path, keep: usize) -> u32 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let prefix = format!("{LIBRARY_FILE}.corrupt-");
    let mut copies: Vec<(Option<(u64, u32)>, String)> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|name| name.starts_with(&prefix))
        .map(|name| (corrupt_sort_key(&name), name))
        .collect();
    if copies.len() <= keep {
        return 0;
    }
    copies.sort();
    // The first copy with a parseable name came from the library the user last had.
    let first = (keep > 0).then(|| {
        copies
            .iter()
            .position(|(key, _)| key.is_some())
            .unwrap_or(0)
    });
    let newest_from = copies.len() - keep.saturating_sub(1);
    let mut removed = 0u32;
    for (index, (_, name)) in copies.into_iter().enumerate() {
        if index >= newest_from || Some(index) == first {
            continue;
        }
        match fs::remove_file(dir.join(&name)) {
            Ok(()) => removed += 1,
            Err(e) => log::warn!("could not remove {name}: {e}"),
        }
    }
    if removed > 0 {
        log::info!("removed {removed} old library.json.corrupt-* file(s)");
    }
    removed
}

fn is_read_only(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.permissions().readonly())
}

/// Clears a read-only `.bak`: Windows refuses to rename over it, which would fail every save.
/// The backup is the app's own copy, replaced on each save anyway.
#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)]
fn make_backup_writable(backup: &Path) -> std::io::Result<()> {
    let Ok(meta) = fs::metadata(backup) else {
        return Ok(());
    };
    let mut permissions = meta.permissions();
    if !permissions.readonly() {
        return Ok(());
    }
    log::info!("library.json.bak is read-only; clearing the attribute before rotating");
    permissions.set_readonly(false);
    fs::set_permissions(backup, permissions)
}

#[cfg(not(windows))]
fn make_backup_writable(_backup: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Atomic save: write `library.json.tmp` + fsync, move the current file to `.bak`, then
/// rename the temp file into place. A read-only `library.json` fails the save untouched.
pub fn save(dir: &Path, json: &str) -> AppResult<()> {
    if json.len() as u64 > MAX_LIBRARY_BYTES {
        return Err(AppError::storage(format!(
            "The library is too large to save (max {} MB).",
            MAX_LIBRARY_BYTES / (1024 * 1024)
        )));
    }
    if !is_valid_json(json) {
        return Err(AppError::Parse(
            "Refusing to save: the library is not valid JSON.".to_string(),
        ));
    }
    fs::create_dir_all(dir).map_err(io_failure(
        "create the data directory",
        WRITE_FAILED_MESSAGE,
    ))?;
    let main = main_path(dir);
    // Moving it to `.bak` would succeed once and carry the attribute onto the backup.
    if is_read_only(&main) {
        log::warn!("library: library.json is read-only; not saving");
        return Err(AppError::storage(READ_ONLY_MESSAGE));
    }
    let tmp = tmp_path(dir);
    // Only the temp file is written here; the rename waits until the backup has been rotated.
    if let Err(error) = crate::util::write_temp(&tmp, json.as_bytes()) {
        return Err(io_failure("write the temp file", WRITE_FAILED_MESSAGE)(
            error,
        ));
    }
    // A temp file left behind would survive every later save, since they all write that name.
    if main.exists() {
        // Only a valid main file may replace the backup; a broken one is set aside instead.
        let rotation_target = match read_capped(&main) {
            Ok(Some(content)) if is_valid_json(&content) => Some(backup_path(dir)),
            // Gone since the `exists` check: nothing to rotate.
            Ok(None) => None,
            // A read error says nothing about the content, so the save fails without moving it.
            Err(error) => {
                let _ = fs::remove_file(&tmp);
                log::warn!("library.json could not be read before rotating it: {error}");
                return Err(error);
            }
            Ok(Some(_)) => {
                let aside = corrupt_path(dir);
                log::warn!(
                    "library.json is not a valid library; keeping the backup and moving it to {}",
                    aside
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default()
                );
                Some(aside)
            }
        };
        if let Some(rotation_target) = rotation_target {
            make_backup_writable(&rotation_target)
                .and_then(|()| fs::rename(&main, rotation_target))
                .inspect_err(|_| {
                    let _ = fs::remove_file(&tmp);
                })
                .map_err(io_failure("rotate the backup", WRITE_FAILED_MESSAGE))?;
        }
    }
    fs::rename(&tmp, &main)
        .inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })
        .map_err(io_failure("replace the file", WRITE_FAILED_MESSAGE))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mynk-lib-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn saves_rotate_the_backup_and_loads_fall_back_to_it() {
        let dir = temp_dir("rot");
        assert_eq!(
            load(&dir).expect("empty"),
            LibraryLoad {
                json: None,
                recovered_from_backup: false
            }
        );
        save(&dir, r#"{"v":1}"#).expect("save 1");
        save(&dir, r#"{"v":2}"#).expect("save 2");
        let loaded = load(&dir).expect("load");
        assert_eq!(loaded.json.as_deref(), Some(r#"{"v":2}"#));
        assert!(!loaded.recovered_from_backup);
        assert_eq!(
            fs::read_to_string(backup_path(&dir)).expect("bak"),
            r#"{"v":1}"#
        );
        assert!(!tmp_path(&dir).exists());

        // Corrupt main file → backup is used.
        fs::write(main_path(&dir), "{broken").expect("corrupt");
        let loaded = load(&dir).expect("fallback");
        assert_eq!(loaded.json.as_deref(), Some(r#"{"v":1}"#));
        assert!(loaded.recovered_from_backup);

        // Missing main (crash between renames) → backup is used.
        fs::remove_file(main_path(&dir)).expect("remove");
        let loaded = load(&dir).expect("fallback");
        assert_eq!(loaded.json.as_deref(), Some(r#"{"v":1}"#));
        assert!(loaded.recovered_from_backup);

        assert!(save(&dir, "not json").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    fn corrupt_copies(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("dir")
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|n| n.starts_with("library.json.corrupt-"))
            .collect();
        names.sort();
        names
    }

    // The broken main file is kept aside, not deleted.
    #[test]
    fn saving_after_a_backup_fallback_keeps_the_good_backup() {
        let dir = temp_dir("corrupt-rotate");
        save(&dir, r#"{"v":1}"#).expect("save 1");
        save(&dir, r#"{"v":2}"#).expect("save 2");
        fs::write(main_path(&dir), "{broken").expect("corrupt");
        let loaded = load(&dir).expect("fallback");
        assert_eq!(loaded.json.as_deref(), Some(r#"{"v":1}"#));
        assert!(loaded.recovered_from_backup);

        save(&dir, r#"{"v":3}"#).expect("save 3");
        assert_eq!(
            fs::read_to_string(backup_path(&dir)).expect("bak"),
            r#"{"v":1}"#,
            "the good backup must survive"
        );
        assert_eq!(
            fs::read_to_string(main_path(&dir)).expect("main"),
            r#"{"v":3}"#
        );
        let aside = corrupt_copies(&dir);
        assert_eq!(aside.len(), 1, "{aside:?}");
        assert_eq!(
            fs::read_to_string(dir.join(&aside[0])).expect("aside"),
            "{broken"
        );

        // Healthy saves rotate normally again.
        save(&dir, r#"{"v":4}"#).expect("save 4");
        assert_eq!(
            fs::read_to_string(backup_path(&dir)).expect("bak"),
            r#"{"v":3}"#
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn assert_unreadable_error(error: &AppError, dir: &Path) {
        assert_eq!(error.kind(), "storage", "{error}");
        let message = error.to_string();
        assert!(
            !message.contains("corrupt"),
            "a read error must not be called corruption: {message}"
        );
        assert!(
            !message.contains(&*dir.to_string_lossy()),
            "no file path in the message: {message}"
        );
        assert_eq!(message, READ_FAILED_MESSAGE, "no OS error text");
    }

    #[test]
    fn an_unreadable_main_file_fails_the_load_even_with_a_good_backup() {
        let dir = temp_dir("unreadable");
        // A directory in place of the file: opening or reading it fails with an I/O error.
        fs::create_dir_all(main_path(&dir)).expect("dir in the way");
        assert_unreadable_error(&load(&dir).expect_err("no backup"), &dir);

        fs::write(backup_path(&dir), r#"{"v":1}"#).expect("backup");
        assert_unreadable_error(
            &load(&dir).expect_err("a valid backup must not hide the read error"),
            &dir,
        );

        fs::write(backup_path(&dir), "{broken").expect("corrupt backup");
        assert_unreadable_error(&load(&dir).expect_err("corrupt backup"), &dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_read_error_before_rotation_fails_the_save_and_moves_nothing() {
        let dir = temp_dir("rotate-read-error");
        fs::write(backup_path(&dir), r#"{"v":1}"#).expect("backup");
        fs::create_dir_all(main_path(&dir)).expect("unreadable main");

        let error = save(&dir, r#"{"v":2}"#).expect_err("the save must fail");
        assert_eq!(error.kind(), "storage", "{error}");
        assert_eq!(error.to_string(), READ_FAILED_MESSAGE, "no OS error text");
        assert!(main_path(&dir).is_dir(), "the main entry was not moved");
        assert!(corrupt_copies(&dir).is_empty(), "nothing was set aside");
        assert_eq!(
            fs::read_to_string(backup_path(&dir)).expect("bak"),
            r#"{"v":1}"#
        );
        assert!(!tmp_path(&dir).exists(), "the temp file is removed");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_first_corrupt_copy_outlives_the_ones_after_it() {
        let dir = temp_dir("corrupt-prune");
        assert_eq!(prune_corrupt_copies(&dir, MAX_CORRUPT_COPIES), 0);
        let names = [
            "library.json.corrupt-100",
            "library.json.corrupt-900",
            "library.json.corrupt-200",
            "library.json.corrupt-900-1",
            "library.json.corrupt-300",
            "library.json.corrupt-garbage",
            "library.json.corrupt-1000",
            "library.json.corrupt-50",
        ];
        for name in names {
            fs::write(dir.join(name), "{broken").expect("write");
        }
        fs::write(backup_path(&dir), r#"{"v":1}"#).expect("backup");
        fs::create_dir_all(dir.join("library.json.corrupt-1")).expect("a directory is ignored");

        assert_eq!(prune_corrupt_copies(&dir, MAX_CORRUPT_COPIES), 3);
        assert_eq!(
            corrupt_copies(&dir),
            vec![
                "library.json.corrupt-1",
                "library.json.corrupt-1000",
                "library.json.corrupt-300",
                "library.json.corrupt-50",
                "library.json.corrupt-900",
                "library.json.corrupt-900-1",
            ],
            "the oldest copy stays; the unparseable name and the middle ones go"
        );
        assert!(backup_path(&dir).is_file(), "other files are untouched");
        assert_eq!(prune_corrupt_copies(&dir, MAX_CORRUPT_COPIES), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    // A directory in place of the temp file simulates a failed create.
    #[test]
    fn a_failed_write_reports_a_fixed_message() {
        let dir = temp_dir("write-fail");
        save(&dir, r#"{"v":1}"#).expect("save");
        fs::create_dir_all(tmp_path(&dir).join("in-the-way")).expect("blocking directory");

        let error = save(&dir, r#"{"v":2}"#).expect_err("the write must fail");
        assert_eq!(error.kind(), "storage", "{error}");
        assert_eq!(error.to_string(), WRITE_FAILED_MESSAGE);
        assert!(!error.to_string().contains("os error"), "{error}");
        assert_eq!(
            fs::read_to_string(main_path(&dir)).expect("main"),
            r#"{"v":1}"#
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_result_serializes_json_as_null_when_absent() {
        let value = serde_json::to_value(LibraryLoad {
            json: None,
            recovered_from_backup: false,
        })
        .expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({ "json": null, "recoveredFromBackup": false })
        );
        let value = serde_json::to_value(LibraryLoad {
            json: Some("{}".into()),
            recovered_from_backup: true,
        })
        .expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({ "json": "{}", "recoveredFromBackup": true })
        );
    }

    #[test]
    fn orphan_temp_file_is_swept() {
        let dir = temp_dir("sweep");
        sweep_orphan_temp(&dir);
        fs::write(tmp_path(&dir), "{half").expect("tmp");
        sweep_orphan_temp(&dir);
        assert!(!tmp_path(&dir).exists());
        assert!(
            !main_path(&dir).exists(),
            "garbage never becomes the library"
        );

        // With a main file present the temp file is stale, however valid it is.
        fs::write(main_path(&dir), r#"{"version":3,"resources":[1]}"#).expect("main");
        fs::write(tmp_path(&dir), r#"{"version":3,"resources":[2]}"#).expect("tmp");
        sweep_orphan_temp(&dir);
        assert!(!tmp_path(&dir).exists());
        assert_eq!(
            fs::read_to_string(main_path(&dir)).expect("main"),
            r#"{"version":3,"resources":[1]}"#
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_valid_temp_file_without_a_main_file_becomes_the_library() {
        let dir = temp_dir("sweep-recover");
        // Power lost between `rename(main, .bak)` and `rename(tmp, main)`.
        fs::write(backup_path(&dir), r#"{"version":3,"resources":["old"]}"#).expect("bak");
        fs::write(tmp_path(&dir), r#"{"version":3,"resources":["new"]}"#).expect("tmp");
        sweep_orphan_temp(&dir);
        assert!(!tmp_path(&dir).exists());
        let loaded = load(&dir).expect("load");
        assert_eq!(
            loaded.json.as_deref(),
            Some(r#"{"version":3,"resources":["new"]}"#)
        );
        assert!(!loaded.recovered_from_backup);
        let _ = fs::remove_dir_all(&dir);
    }

    #[allow(clippy::permissions_set_readonly_false)]
    fn set_read_only(path: &Path, read_only: bool) {
        let mut permissions = fs::metadata(path).expect("metadata").permissions();
        permissions.set_readonly(read_only);
        fs::set_permissions(path, permissions).expect("set permissions");
    }

    #[test]
    fn a_read_only_library_fails_every_save_and_stays_in_place() {
        let dir = temp_dir("read-only-main");
        save(&dir, r#"{"v":1}"#).expect("save 1");
        save(&dir, r#"{"v":2}"#).expect("save 2");
        set_read_only(&main_path(&dir), true);

        for attempt in 3..5 {
            let error = save(&dir, &format!(r#"{{"v":{attempt}}}"#)).expect_err("read-only");
            assert_eq!(error.kind(), "storage", "{error}");
            assert_eq!(error.to_string(), READ_ONLY_MESSAGE);
        }
        assert_eq!(
            fs::read_to_string(main_path(&dir)).expect("main"),
            r#"{"v":2}"#
        );
        assert!(
            is_read_only(&main_path(&dir)),
            "the attribute stays on library.json"
        );
        assert!(
            !is_read_only(&backup_path(&dir)),
            "the backup never inherits it"
        );
        assert_eq!(
            fs::read_to_string(backup_path(&dir)).expect("bak"),
            r#"{"v":1}"#
        );
        assert!(!tmp_path(&dir).exists());

        set_read_only(&main_path(&dir), false);
        save(&dir, r#"{"v":5}"#).expect("writable again");
        assert_eq!(
            load(&dir).expect("load").json.as_deref(),
            Some(r#"{"v":5}"#)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_read_only_backup_does_not_block_rotation() {
        let dir = temp_dir("read-only-bak");
        save(&dir, r#"{"v":1}"#).expect("save 1");
        save(&dir, r#"{"v":2}"#).expect("save 2");
        set_read_only(&backup_path(&dir), true);

        save(&dir, r#"{"v":3}"#).expect("save 3");
        save(&dir, r#"{"v":4}"#).expect("save 4");
        assert_eq!(
            fs::read_to_string(backup_path(&dir)).expect("bak"),
            r#"{"v":3}"#
        );
        assert_eq!(
            fs::read_to_string(main_path(&dir)).expect("main"),
            r#"{"v":4}"#
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_backup_rotation_leaves_no_temp_file() {
        let dir = temp_dir("rotate-fail");
        save(&dir, r#"{"v":1}"#).expect("save");
        // A directory where the backup file belongs makes the rotation rename fail.
        fs::remove_file(backup_path(&dir)).ok();
        fs::create_dir_all(backup_path(&dir).join("in-the-way")).expect("blocking directory");

        let error = save(&dir, r#"{"v":2}"#).expect_err("rotation must fail");
        assert_eq!(error.kind(), "storage", "{error}");
        assert_eq!(error.to_string(), WRITE_FAILED_MESSAGE, "no OS error text");
        assert!(
            !tmp_path(&dir).exists(),
            "the fsynced temp file must be removed"
        );
        assert_eq!(
            fs::read_to_string(main_path(&dir)).expect("main"),
            r#"{"v":1}"#
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
