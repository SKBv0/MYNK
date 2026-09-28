//! Snapshot directory maintenance: uploads, deletion, pruning, size cap.
//! All functions are blocking; call them through `state::run_blocking`.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use super::backend::CAPTURE_PROFILE_PREFIX;
use super::media::{sniff_raster, CachedFormat};
use crate::error::{AppError, AppResult};
use crate::util::{
    age_cutoff, is_plain_file_name, is_windows_device_name, sha256_hex, sweep_stale_dirs,
};

/// Mirrors the renderer's `MAX_UPLOAD_BYTES` in src/store/jobs/preview.ts ("15 MB" message).
pub const MAX_UPLOAD_BYTES: usize = 15 * 1024 * 1024;
/// Size cap for the snapshot directory; uploads count toward it but are never evicted.
pub const MAX_CACHE_BYTES: u64 = 500 * 1024 * 1024;
/// Share of the cap that stays available to evictable files even when uploads alone fill it.
const EVICTION_FLOOR_DIVISOR: u64 = 8;
const TMP_SUFFIX: &str = ".tmp";
const UPLOAD_PREFIX: &str = "upload-";
/// Files newer than this are never pruned: they may not be referenced by the renderer yet.
pub const PRUNE_MIN_AGE: Duration = Duration::from_secs(5 * 60);
/// A capture never lives longer than `SNAPSHOT_TIMEOUT`, so an older profile has no owner left.
pub const CAPTURE_PROFILE_MAX_AGE: Duration = Duration::from_secs(3600);
/// An atomic write takes moments, so an older temp file was left by one that never finished.
const TEMP_FILE_MAX_AGE: Duration = Duration::from_secs(3600);

/// Lowercase hex of the first `bytes` bytes of SHA-256(`data`).
pub fn short_hash(data: &[u8], bytes: usize) -> String {
    sha256_hex(&[data], bytes)
}

/// A plain file name that is also not a Windows device name (`CON`, `nul.png`, `COM1.txt`, ...),
/// since the snapshot directory is served to the renderer by name.
pub fn is_safe_file_name(name: &str) -> bool {
    is_plain_file_name(name) && !is_windows_device_name(name)
}

fn resolve(dir: &Path, name: &str) -> AppResult<PathBuf> {
    if !is_safe_file_name(name) {
        return Err(AppError::invalid_input(format!(
            "Rejected snapshot file name \"{}\".",
            name.chars().take(64).collect::<String>()
        )));
    }
    Ok(dir.join(name))
}

/// Unique temp file name for `name`: two writers racing for the same target (two resources
/// sharing a favicon URL, say) must not write into one file and then rename it twice.
fn tmp_name(name: &str) -> String {
    format!("{name}-{}{TMP_SUFFIX}", crate::state::next_temp_id())
}

/// Writes `bytes` to `dir/name` via a temporary file + rename (never a half-written image).
pub fn write_atomically(dir: &Path, name: &str, bytes: &[u8]) -> AppResult<()> {
    let target = resolve(dir, name)?;
    let tmp = dir.join(tmp_name(name));
    crate::util::write_atomically(&target, &tmp, bytes)?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageExt {
    Png,
    Jpg,
    Webp,
}

impl ImageExt {
    pub fn parse(raw: &str) -> AppResult<Self> {
        match raw
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str()
        {
            "png" => Ok(ImageExt::Png),
            "jpg" | "jpeg" => Ok(ImageExt::Jpg),
            "webp" => Ok(ImageExt::Webp),
            other => Err(AppError::invalid_input(format!(
                "Unsupported preview image type \"{}\" (png, jpg, webp).",
                other.chars().take(16).collect::<String>()
            ))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            ImageExt::Png => "png",
            ImageExt::Jpg => "jpg",
            ImageExt::Webp => "webp",
        }
    }

    /// Magic-byte check so a renamed arbitrary file cannot be stored as an "image".
    fn matches(self, bytes: &[u8]) -> bool {
        matches!(
            (self, sniff_raster(bytes)),
            (ImageExt::Png, Some(CachedFormat::Png))
                | (ImageExt::Jpg, Some(CachedFormat::Jpeg))
                | (ImageExt::Webp, Some(CachedFormat::Webp))
        )
    }
}

/// Stores a user-uploaded preview; returns the file name.
pub fn save_uploaded_preview(
    dir: &Path,
    resource_id: &str,
    bytes: &[u8],
    ext: ImageExt,
) -> AppResult<String> {
    if bytes.is_empty() {
        return Err(AppError::invalid_input("Preview image is empty."));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::invalid_input(format!(
            "Preview image is too large (max {} MB).",
            MAX_UPLOAD_BYTES / (1024 * 1024)
        )));
    }
    if !ext.matches(bytes) {
        return Err(AppError::invalid_input(
            "The file content does not match its image type.",
        ));
    }
    let name = format!(
        "upload-{}-{}.{}",
        short_hash(resource_id.as_bytes(), 8),
        short_hash(bytes, 6),
        ext.as_str()
    );
    fs::create_dir_all(dir)?;
    write_atomically(dir, &name, bytes)?;
    Ok(name)
}

/// Deletes the given files. Invalid names reject the whole request; missing files are ignored.
pub fn delete_snapshots(dir: &Path, names: &[String]) -> AppResult<()> {
    let paths = names
        .iter()
        .map(|name| resolve(dir, name))
        .collect::<AppResult<Vec<_>>>()?;
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Deletes every regular file in `dir` whose name is not in `keep`. Returns the count.
/// User uploads are never pruned, even with an empty or partial `keep` list.
pub fn prune_snapshots(dir: &Path, keep: &[String]) -> AppResult<u32> {
    let cutoff = age_cutoff(PRUNE_MIN_AGE);
    let keep: HashSet<&str> = keep.iter().map(String::as_str).collect();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let mut deleted = 0u32;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // In-flight temp files belong to running writes/captures; `sweep_temp_files` handles them.
        if keep.contains(name) || is_temp_name(name) || name.starts_with(UPLOAD_PREFIX) {
            continue;
        }
        // Unknown modification time counts as recent: when in doubt, keep the file.
        let old_enough = matches!(
            entry.metadata().and_then(|meta| meta.modified()),
            Ok(modified) if modified <= cutoff
        );
        if !old_enough {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => deleted += 1,
            Err(e) => log::warn!("prune: could not delete {name}: {e}"),
        }
    }
    Ok(deleted)
}

/// Factory reset: deletes every regular file in `dir`, uploads included, regardless of age.
/// Only in-flight temp files are skipped. Returns how many files were deleted.
pub fn reset_snapshots(dir: &Path) -> AppResult<u32> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let mut deleted = 0u32;
    let mut failed = 0u32;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_temp_name(&name) {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => deleted += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                log::warn!("reset: could not delete {name}: {e}");
                failed += 1;
            }
        }
    }
    if failed > 0 {
        return Err(AppError::storage(format!(
            "Could not delete {failed} preview file(s); {deleted} were deleted."
        )));
    }
    Ok(deleted)
}

fn is_temp_name(name: &str) -> bool {
    name.ends_with(TMP_SUFFIX) || name.ends_with(".tmp.png")
}

/// `SnapshotMaintenanceReport` in ipcTypes.ts.
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceReport {
    /// Files deleted because no resource references them.
    pub deleted_unreferenced: u32,
    /// Referenced files evicted by the size cap; the renderer must drop these references.
    pub evicted: Vec<String>,
    /// Directory size after maintenance, in bytes.
    pub total_bytes: u64,
}

struct CachedFile {
    name: String,
    size: u64,
    last_used: SystemTime,
}

/// Last use = the later of access and modification time (NTFS may not update access times).
fn last_used(meta: &fs::Metadata) -> SystemTime {
    let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    match meta.accessed() {
        Ok(accessed) if accessed > modified => accessed,
        _ => modified,
    }
}

/// Start-up maintenance: prune unreferenced files, then evict least-recently-used non-upload
/// files until they fit the budget left after uploads and temp files.
pub fn maintain(dir: &Path, keep: &[String], max_bytes: u64) -> AppResult<MaintenanceReport> {
    let deleted_unreferenced = prune_snapshots(dir, keep)?;
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MaintenanceReport {
                deleted_unreferenced,
                ..MaintenanceReport::default()
            })
        }
        Err(e) => return Err(e.into()),
    };

    let mut total: u64 = 0;
    let mut evictable_bytes: u64 = 0;
    let mut evictable: Vec<CachedFile> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        total = total.saturating_add(meta.len());
        if is_temp_name(name) || name.starts_with(UPLOAD_PREFIX) || !is_safe_file_name(name) {
            continue;
        }
        evictable_bytes = evictable_bytes.saturating_add(meta.len());
        evictable.push(CachedFile {
            name: name.to_string(),
            size: meta.len(),
            last_used: last_used(&meta),
        });
    }

    // Bytes that cannot be reclaimed shrink the budget instead of evicting everything else.
    let reserved = total.saturating_sub(evictable_bytes);
    let budget = max_bytes
        .saturating_sub(reserved)
        .max(max_bytes / EVICTION_FLOOR_DIVISOR);

    let mut evicted = Vec::new();
    if evictable_bytes > budget {
        evictable.sort_by(|a, b| a.last_used.cmp(&b.last_used).then(a.name.cmp(&b.name)));
        for file in evictable {
            if evictable_bytes <= budget {
                break;
            }
            match fs::remove_file(dir.join(&file.name)) {
                Ok(()) => {
                    evictable_bytes = evictable_bytes.saturating_sub(file.size);
                    total = total.saturating_sub(file.size);
                    evicted.push(file.name);
                }
                Err(e) => log::warn!("maintenance: could not evict {}: {e}", file.name),
            }
        }
        log::info!(
            "snapshot maintenance evicted {} file(s); directory is now {total} bytes",
            evicted.len()
        );
    }

    Ok(MaintenanceReport {
        deleted_unreferenced,
        evicted,
        total_bytes: total,
    })
}

/// Total size of the files in the snapshot directory, in bytes; a missing directory is 0.
pub fn dir_bytes(dir: &Path) -> AppResult<u64> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    Ok(entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(fs::Metadata::is_file)
        .fold(0u64, |total, meta| total.saturating_add(meta.len())))
}

/// Removes temp files left behind by interrupted writes (older than `TEMP_FILE_MAX_AGE`).
pub fn sweep_temp_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let cutoff = age_cutoff(TEMP_FILE_MAX_AGE);
    for entry in entries.flatten() {
        let path = entry.path();
        let is_tmp = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(is_temp_name);
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|modified| modified < cutoff);
        if is_tmp && old {
            let _ = fs::remove_file(path);
        }
    }
}

/// Exactly the `mynk-capture-<pid>-<counter>` names `TempProfile` creates, so a sweep can never
/// reach anything else in the shared temp directory.
fn is_capture_profile_name(name: &str) -> bool {
    let Some((pid, counter)) = name
        .strip_prefix(CAPTURE_PROFILE_PREFIX)
        .and_then(|rest| rest.split_once('-'))
    else {
        return false;
    };
    !pid.is_empty()
        && !counter.is_empty()
        && pid
            .bytes()
            .chain(counter.bytes())
            .all(|b| b.is_ascii_digit())
}

/// Start-up sweep: removes throwaway capture profiles left in the temp directory by a killed or
/// crashed capture process. Returns how many directories were removed.
pub fn sweep_capture_profiles(max_age: Duration) -> u32 {
    sweep_capture_profiles_in(&std::env::temp_dir(), max_age)
}

/// [`sweep_capture_profiles`] against an explicit temp root (tests).
pub fn sweep_capture_profiles_in(temp_root: &Path, max_age: Duration) -> u32 {
    sweep_stale_dirs(temp_root, is_capture_profile_name, max_age)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mynk-test-{tag}-{}-{}",
            std::process::id(),
            short_hash(format!("{:?}", SystemTime::now()).as_bytes(), 4)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn rejects_path_traversal_and_windows_device_names() {
        assert!(is_safe_file_name("abc123.png"));
        assert!(is_safe_file_name("upload-ab-cd.webp"));
        assert!(!is_safe_file_name("../secret.txt"));
        assert!(!is_safe_file_name("..\\secret.txt"));
        assert!(!is_safe_file_name("C:\\Windows\\win.ini"));
        assert!(!is_safe_file_name("/etc/passwd"));
        assert!(!is_safe_file_name(".hidden"));
        assert!(!is_safe_file_name("a..b"));
        assert!(!is_safe_file_name(""));
        for device in [
            "CON",
            "con",
            "PRN.png",
            "aux.tar.gz",
            "NUL",
            "nul.png",
            "COM1",
            "com9.ico",
            "LPT1.txt",
            "lpt5.webp",
        ] {
            assert!(!is_safe_file_name(device), "{device}");
        }
        for fine in [
            "console.png",
            "com10.png",
            "nully.png",
            "fav-con.ico",
            "comx.png",
        ] {
            assert!(is_safe_file_name(fine), "{fine}");
        }
    }

    fn write_with_time(dir: &Path, name: &str, bytes: usize, age_secs: u64) {
        let path = dir.join(name);
        fs::write(&path, vec![0u8; bytes]).expect("write");
        let when = SystemTime::now()
            .checked_sub(Duration::from_secs(age_secs))
            .expect("time");
        let file = fs::File::options().write(true).open(&path).expect("open");
        file.set_times(fs::FileTimes::new().set_accessed(when).set_modified(when))
            .expect("set times");
    }

    #[test]
    fn maintenance_prunes_then_evicts_least_recently_used() {
        let dir = temp_dir("maint");
        write_with_time(&dir, "orphan.png", 10, 4000);
        write_with_time(&dir, "old.png", 400, 3000);
        write_with_time(&dir, "fav-aa.ico", 100, 2000);
        write_with_time(&dir, "new.png", 400, 10);
        write_with_time(&dir, "upload-x-y.png", 500, 9000);
        write_with_time(&dir, "busy.png.tmp", 50, 9000);
        let keep: Vec<String> = ["old.png", "fav-aa.ico", "new.png", "upload-x-y.png"]
            .iter()
            .map(|s| s.to_string())
            .collect();

        // 400 + 100 + 400 + 500 + 50 (temp) = 1450 bytes after pruning the orphan.
        let report = maintain(&dir, &keep, 1000).expect("maintain");
        assert_eq!(report.deleted_unreferenced, 1);
        // Oldest evictable first: old.png (1050 left) then fav-aa.ico (950 left).
        assert_eq!(
            report.evicted,
            vec!["old.png".to_string(), "fav-aa.ico".to_string()]
        );
        assert_eq!(report.total_bytes, 950);
        assert!(
            dir.join("upload-x-y.png").is_file(),
            "uploads are never evicted"
        );
        assert!(
            dir.join("busy.png.tmp").is_file(),
            "temp files are left alone"
        );
        assert!(dir.join("new.png").is_file());

        let again = maintain(&dir, &keep, MAX_CACHE_BYTES).expect("maintain");
        assert_eq!(again.deleted_unreferenced, 0);
        assert!(again.evicted.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dir_bytes_counts_files_only_and_follows_changes() {
        let dir = temp_dir("dir-bytes");
        assert_eq!(dir_bytes(&dir.join("missing")).expect("missing dir"), 0);
        write_with_time(&dir, "a.png", 300, 10);
        write_with_time(&dir, "upload-x-y.png", 200, 10);
        fs::create_dir_all(dir.join("nested")).expect("subdir");
        fs::write(dir.join("nested").join("inner.png"), [0u8; 999]).expect("inner");
        assert_eq!(dir_bytes(&dir).expect("size"), 500);

        delete_snapshots(&dir, &["a.png".to_string()]).expect("delete");
        assert_eq!(dir_bytes(&dir).expect("size after delete"), 200);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn large_uploads_never_evict_the_whole_cache() {
        let dir = temp_dir("uploads");
        write_with_time(&dir, "upload-a-b.png", 2000, 9000);
        write_with_time(&dir, "old.png", 60, 3000);
        write_with_time(&dir, "new.png", 60, 10);
        let keep: Vec<String> = ["upload-a-b.png", "old.png", "new.png"]
            .iter()
            .map(|s| s.to_string())
            .collect();

        // Budget = max(1000 - 2000, 1000 / 8) = 125 bytes for the 120 bytes of cached images.
        let report = maintain(&dir, &keep, 1000).expect("maintain");
        assert!(
            report.evicted.is_empty(),
            "uploads over the cap must not evict the cache: {report:?}"
        );
        assert!(dir.join("old.png").is_file());
        assert!(dir.join("new.png").is_file());

        write_with_time(&dir, "extra.png", 60, 2000);
        let keep: Vec<String> = keep.into_iter().chain(["extra.png".to_string()]).collect();
        let report = maintain(&dir, &keep, 1000).expect("maintain");
        assert_eq!(report.evicted, vec!["old.png".to_string()]);
        assert!(dir.join("upload-a-b.png").is_file(), "uploads stay");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_writes_use_unique_temp_names() {
        let dir = temp_dir("atomic");
        let names: Vec<String> = (0..4).map(|_| tmp_name("a.png")).collect();
        let unique: HashSet<&String> = names.iter().collect();
        assert_eq!(unique.len(), names.len(), "{names:?}");
        assert!(names.iter().all(|n| is_temp_name(n)));

        write_atomically(&dir, "a.png", b"one").expect("write");
        write_atomically(&dir, "a.png", b"two").expect("overwrite");
        assert_eq!(fs::read(dir.join("a.png")).expect("read"), b"two");
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .expect("dir")
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|name| is_temp_name(name))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// An empty keep list is what a failed library load sends: uploads cannot be recreated, so
    /// they must survive it, and files written moments ago may not be referenced yet.
    #[test]
    fn prune_never_deletes_uploads_or_fresh_files() {
        let dir = temp_dir("prune-belt");
        write_with_time(&dir, "upload-a-b.png", 8, 90_000);
        write_with_time(&dir, "fav-fresh.ico", 8, 5);
        write_with_time(&dir, "img-under.png", 8, PRUNE_MIN_AGE.as_secs() - 30);
        write_with_time(&dir, "old-orphan.png", 8, PRUNE_MIN_AGE.as_secs() + 60);

        let deleted = prune_snapshots(&dir, &[]).expect("prune");
        assert_eq!(deleted, 1);
        assert!(
            dir.join("upload-a-b.png").is_file(),
            "uploads are never pruned"
        );
        assert!(
            dir.join("fav-fresh.ico").is_file(),
            "fresh files are skipped"
        );
        assert!(dir.join("img-under.png").is_file());
        assert!(!dir.join("old-orphan.png").exists());

        let report = maintain(&dir, &[], MAX_CACHE_BYTES).expect("maintain");
        assert_eq!(report.deleted_unreferenced, 0);
        assert!(dir.join("upload-a-b.png").is_file());

        delete_snapshots(&dir, &["upload-a-b.png".to_string()]).expect("delete");
        assert!(!dir.join("upload-a-b.png").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_deletes_uploads_and_fresh_files_but_not_temp_files() {
        let dir = temp_dir("reset");
        write_with_time(&dir, "upload-a-b.png", 8, 90_000);
        write_with_time(&dir, "fav-fresh.ico", 8, 1);
        write_with_time(&dir, "img-old.png", 8, 90_000);
        write_with_time(&dir, "busy.png-1-2.tmp", 8, 1);
        write_with_time(&dir, "capture-1.tmp.png", 8, 1);
        fs::create_dir_all(dir.join("subdir")).expect("subdir");

        assert_eq!(reset_snapshots(&dir).expect("reset"), 3);
        assert!(!dir.join("upload-a-b.png").exists(), "uploads go too");
        assert!(!dir.join("fav-fresh.ico").exists(), "no age limit");
        assert!(!dir.join("img-old.png").exists());
        assert!(
            dir.join("busy.png-1-2.tmp").is_file(),
            "in-flight temp kept"
        );
        assert!(
            dir.join("capture-1.tmp.png").is_file(),
            "in-flight capture kept"
        );
        assert!(dir.join("subdir").is_dir(), "only plain files are touched");

        assert_eq!(reset_snapshots(&dir).expect("again"), 0);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(reset_snapshots(&dir).expect("missing dir"), 0);
    }

    #[test]
    fn capture_profile_sweep_only_removes_stale_profile_directories() {
        let root = temp_dir("capture-sweep");
        let profiles = [
            root.join(format!("{CAPTURE_PROFILE_PREFIX}21468-45")),
            root.join(format!("{CAPTURE_PROFILE_PREFIX}48520-7")),
        ];
        let unrelated = [
            root.join(format!("{CAPTURE_PROFILE_PREFIX}abc-1")),
            root.join(format!("{CAPTURE_PROFILE_PREFIX}7")),
            root.join("mynk-ff-1-1"),
        ];
        for dir in profiles.iter().chain(&unrelated) {
            fs::create_dir_all(dir.join("Default")).expect("dir");
            fs::write(dir.join("Default").join("Preferences"), b"{}").expect("file");
        }
        let file = root.join(format!("{CAPTURE_PROFILE_PREFIX}31000-2"));
        fs::write(&file, b"x").expect("file");

        // Profiles younger than the age limit belong to a capture that is still running.
        assert_eq!(sweep_capture_profiles_in(&root, CAPTURE_PROFILE_MAX_AGE), 0);
        assert!(profiles.iter().all(|dir| dir.is_dir()));

        assert_eq!(sweep_capture_profiles_in(&root, Duration::ZERO), 2);
        assert!(profiles.iter().all(|dir| !dir.exists()));
        assert!(
            unrelated.iter().all(|dir| dir.is_dir()),
            "only the exact name pattern is swept"
        );
        assert!(file.is_file(), "files are never removed");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn maintenance_on_missing_dir_is_empty() {
        let dir = std::env::temp_dir().join("mynk-test-does-not-exist-maint");
        let report = maintain(&dir, &[], 10).expect("maintain");
        assert_eq!(report, MaintenanceReport::default());
    }

    #[test]
    fn uploads_are_validated_then_pruned_and_deleted_by_name() {
        let dir = temp_dir("snap");
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
        let name = save_uploaded_preview(&dir, "res-1", &png, ImageExt::Png).expect("save");
        assert!(dir.join(&name).is_file());
        assert!(save_uploaded_preview(&dir, "res-1", b"not an image", ImageExt::Png).is_err());
        assert!(ImageExt::parse("gif").is_err());

        write_with_time(&dir, "orphan.png", 1, 4000);
        write_with_time(&dir, "keep.png", 1, 4000);
        let deleted =
            prune_snapshots(&dir, &["keep.png".to_string(), name.clone()]).expect("prune");
        assert_eq!(deleted, 1);
        assert!(dir.join("keep.png").is_file());

        assert!(delete_snapshots(&dir, &["../keep.png".to_string()]).is_err());
        delete_snapshots(&dir, &[name.clone(), "missing.png".to_string()]).expect("delete");
        assert!(!dir.join(&name).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
