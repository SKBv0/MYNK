//! Browser bookmark import.

pub mod chromium;
pub mod firefox;
pub mod registry;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use registry::{BrowserFamily, ProfileRegistry, ProfileSource, SourceKind};

/// `ImportedBookmark` in ipcTypes.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedBookmark {
    pub url: String,
    pub title: String,
    pub folder_path: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_at: Option<i64>,
}

/// `DetectedProfile` in ipcTypes.ts. `error` is a code (`locked` | `unreadable`), never a
/// sentence: a SQLite message is English and would land untranslated in the interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProfile {
    pub id: String,
    pub browser: BrowserFamily,
    pub profile_name: String,
    pub bookmark_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Whether an I/O failure means another program is holding the file open. Windows reports that
/// as a sharing violation (OS error 32), which Rust has no `ErrorKind` for.
fn is_lock_error(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::PermissionDenied || error.raw_os_error() == Some(32)
}

/// The code the renderer shows for a profile it could not count.
fn profile_error_code(error: &AppError) -> &'static str {
    if error.code() == Some("browserLocked") {
        return "locked";
    }
    let message = error.to_string().to_ascii_lowercase();
    // SQLite says "database is locked" / "database is busy" through its own error code.
    if ["lock", "busy", "sharing violation"]
        .iter()
        .any(|hint| message.contains(hint))
    {
        return "locked";
    }
    "unreadable"
}

/// Matches what the renderer accepts from a browser import, where every URL carries a scheme:
/// http(s) with a host, including dotless intranet hosts like `http://wiki/`.
pub fn is_importable_url(raw: &str) -> bool {
    url::Url::parse(raw.trim())
        .map(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
        .unwrap_or(false)
}

fn read_source(source: &ProfileSource) -> AppResult<Vec<ImportedBookmark>> {
    match &source.kind {
        SourceKind::ChromiumBookmarks(path) => chromium::read(path),
        SourceKind::FirefoxPlaces(path) => firefox::read(path),
    }
}

/// Bookmark count for the profile list. Cheaper than `read_source`: no `ImportedBookmark` is
/// built, and Firefox answers with a single aggregate query instead of every row.
fn count_source(source: &ProfileSource) -> AppResult<usize> {
    match &source.kind {
        SourceKind::ChromiumBookmarks(path) => chromium::count(path),
        SourceKind::FirefoxPlaces(path) => firefox::count(path),
    }
}

fn detect_sources() -> Vec<ProfileSource> {
    let mut sources = chromium::detect();
    sources.extend(firefox::detect());
    sources
}

/// Detects profiles on this machine and refreshes the id registry. Unsupported platforms or
/// machines without browsers yield an empty list, never an error. Blocking.
pub fn detect(registry: &ProfileRegistry) -> Vec<DetectedProfile> {
    let sources = detect_sources();
    registry.replace(&sources);
    sources
        .iter()
        .map(|source| {
            let (bookmark_count, error) = match count_source(source) {
                Ok(count) => (count, None),
                Err(error) => {
                    log::warn!(
                        "browser profile \"{}\" could not be read: {error}",
                        source.profile_name
                    );
                    (0, Some(profile_error_code(&error).to_string()))
                }
            };
            DetectedProfile {
                id: source.id(),
                browser: source.browser,
                profile_name: source.profile_name.clone(),
                bookmark_count,
                error,
            }
        })
        .collect()
}

/// Reads bookmarks for an opaque profile id. Re-runs detection once if the id is unknown
/// (e.g. the app restarted since `detect_browsers`). Blocking.
pub fn read(registry: &ProfileRegistry, profile_id: &str) -> AppResult<Vec<ImportedBookmark>> {
    let source = match registry.get(profile_id) {
        Some(source) => source,
        None => {
            registry.replace(&detect_sources());
            registry.get(profile_id).ok_or_else(|| {
                AppError::NotFound("This browser profile is no longer available.".to_string())
            })?
        }
    };
    read_source(&source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_urls_are_importable_and_other_schemes_are_not() {
        assert!(is_importable_url("https://example.com"));
        assert!(is_importable_url("http://localhost:3000/x"));
        assert!(!is_importable_url("javascript:alert(1)"));
        assert!(!is_importable_url("chrome://settings"));
        assert!(!is_importable_url("file:///C:/x"));
        assert!(!is_importable_url("place:sort=8"));
    }

    #[test]
    fn intranet_hosts_without_a_dot_are_importable() {
        for url in [
            "http://wiki/",
            "http://wiki",
            "https://intranet/page?q=1",
            "http://nas:5000/files",
            "http://192.168.1.10/admin",
            "http://[::1]:8080/",
            "HTTPS://Example.COM/",
            "  https://example.com/padded  ",
        ] {
            assert!(is_importable_url(url), "{url} must be importable");
        }
    }

    #[test]
    fn non_web_schemes_and_hostless_urls_are_rejected() {
        for url in [
            "",
            "   ",
            "wiki",
            "not a url",
            "http://",
            "https://",
            "data:text/html,<script>alert(1)</script>",
            "about:blank",
            "ftp://example.com/file",
            "mailto:someone@example.com",
            "blob:https://example.com/0b6f",
            "view-source:https://example.com/",
            "edge://settings",
            "chrome-extension://abcdef/popup.html",
            "JavaScript:alert(1)",
        ] {
            assert!(!is_importable_url(url), "{url} must be rejected");
        }
    }

    #[test]
    fn detection_never_errors() {
        let registry = ProfileRegistry::default();
        let profiles = detect(&registry);
        for profile in &profiles {
            assert!(
                matches!(
                    profile.error.as_deref(),
                    None | Some("locked") | Some("unreadable")
                ),
                "{:?}",
                profile.error
            );
        }
    }

    #[test]
    fn a_profile_failure_reaches_the_renderer_as_a_code() {
        assert_eq!(
            profile_error_code(&AppError::browser_locked("Close Firefox and try again.")),
            "locked"
        );
        // The message SQLite gives for a held database, through `sqlite_detail`.
        assert_eq!(
            profile_error_code(&AppError::storage(
                "Could not open the Firefox bookmarks database (Error code 5: The database file is locked)."
            )),
            "locked"
        );
        assert_eq!(
            profile_error_code(&AppError::storage(
                "Could not open the Firefox bookmarks database (Error code 5: database is busy)."
            )),
            "locked"
        );
        for other in [
            AppError::storage("The bookmarks file is too large."),
            AppError::Parse("not JSON".into()),
            AppError::NotFound("gone".into()),
        ] {
            assert_eq!(profile_error_code(&other), "unreadable", "{other}");
        }
    }

    #[test]
    fn a_held_file_is_told_apart_from_an_unreadable_one() {
        use std::io::{Error, ErrorKind};
        assert!(is_lock_error(&Error::from(ErrorKind::PermissionDenied)));
        assert!(is_lock_error(&Error::from_raw_os_error(32)));
        assert!(!is_lock_error(&Error::from(ErrorKind::NotFound)));
        assert!(!is_lock_error(&Error::from(ErrorKind::InvalidData)));
    }
}
