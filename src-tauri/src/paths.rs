//! Data and cache directory resolution without Tauri, for `mynk-mcp`, the second process that
//! never builds a Tauri app. Reproduces `dirs::data_dir()/<identifier>` and
//! `dirs::cache_dir()/<identifier>`, overridable via `MYNK_DATA_DIR`/`MYNK_CACHE_DIR`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Bundle identifier, kept in step with `identifier` in `tauri.conf.json` (asserted below).
pub const APP_IDENTIFIER: &str = "com.mynk.desktop";

/// Environment override for the data directory (the one holding `library.json`).
pub const DATA_DIR_ENV: &str = "MYNK_DATA_DIR";
/// Environment override for the cache directory (the one holding the semantic index).
pub const CACHE_DIR_ENV: &str = "MYNK_CACHE_DIR";

/// Sub-directory of the data directory where agents drop bookmarks for the app to import.
pub const INBOX_DIR_NAME: &str = "inbox";
/// File name of the (lazily built) embedding index inside the cache directory.
pub const SEMANTIC_INDEX_FILE: &str = "semantic.sqlite";

/// Turns the raw value of an override variable into a path. A variable that is unset, empty or
/// only whitespace is ignored instead of resolving to the current working directory.
fn env_override(value: Option<OsString>) -> Option<PathBuf> {
    let value = value?;
    if value.is_empty() || value.to_string_lossy().trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

fn missing(what: &'static str) -> AppError {
    AppError::storage(format!("The {what} directory could not be determined."))
}

/// `dirs::data_dir()/<identifier>`, matching Tauri's `app_data_dir()`. Ignores [`DATA_DIR_ENV`].
pub fn default_data_dir() -> AppResult<PathBuf> {
    dirs::data_dir()
        .map(|dir| dir.join(APP_IDENTIFIER))
        .ok_or_else(|| missing("application data"))
}

/// `dirs::cache_dir()/<identifier>`, matching Tauri's `app_cache_dir()`. Ignores [`CACHE_DIR_ENV`].
pub fn default_cache_dir() -> AppResult<PathBuf> {
    dirs::cache_dir()
        .map(|dir| dir.join(APP_IDENTIFIER))
        .ok_or_else(|| missing("application cache"))
}

/// The app data directory, honoring [`DATA_DIR_ENV`].
pub fn data_dir() -> AppResult<PathBuf> {
    match env_override(std::env::var_os(DATA_DIR_ENV)) {
        Some(path) => Ok(path),
        None => default_data_dir(),
    }
}

/// The app cache directory, honoring [`CACHE_DIR_ENV`].
pub fn cache_dir() -> AppResult<PathBuf> {
    match env_override(std::env::var_os(CACHE_DIR_ENV)) {
        Some(path) => Ok(path),
        None => default_cache_dir(),
    }
}

/// Where `add_bookmark` writes and the app reads (`<data dir>/inbox`).
pub fn inbox_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(INBOX_DIR_NAME)
}

/// Where the embedding index lives (`<cache dir>/semantic.sqlite`).
pub fn semantic_index_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(SEMANTIC_INDEX_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift from `tauri.conf.json`'s identifier would point mynk-mcp at an empty directory.
    #[test]
    fn identifier_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(conf["identifier"].as_str(), Some(APP_IDENTIFIER));
    }

    #[test]
    fn platform_directories_end_with_the_identifier() {
        let data = default_data_dir().expect("data dir");
        let cache = default_cache_dir().expect("cache dir");
        assert_eq!(
            data.file_name().and_then(|n| n.to_str()),
            Some(APP_IDENTIFIER)
        );
        assert_eq!(
            cache.file_name().and_then(|n| n.to_str()),
            Some(APP_IDENTIFIER)
        );
        assert!(data.parent().is_some());
        assert!(cache.parent().is_some());
    }

    /// Tested in isolation: reading the process environment would race other tests in the binary.
    #[test]
    fn blank_overrides_are_ignored() {
        assert_eq!(env_override(None), None);
        assert_eq!(env_override(Some(OsString::from(""))), None);
        assert_eq!(env_override(Some(OsString::from("   "))), None);
        assert_eq!(
            env_override(Some(OsString::from("C:\\tmp\\mynk"))),
            Some(PathBuf::from("C:\\tmp\\mynk"))
        );
    }

    #[test]
    fn inbox_and_index_paths_sit_under_their_directories() {
        let data = Path::new("/tmp/mynk-data");
        let cache = Path::new("/tmp/mynk-cache");
        assert_eq!(inbox_dir(data), data.join("inbox"));
        assert_eq!(semantic_index_path(cache), cache.join("semantic.sqlite"));
    }
}
