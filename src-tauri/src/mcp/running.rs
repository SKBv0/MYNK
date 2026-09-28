//! The `running.json` contract: the heartbeat the app writes to its data dir and every reader of
//! it. A missing, stale or unreadable heartbeat reads as "closed", not as an error.
//! `commands::agents` owns the writing half.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// File name inside the data directory, shared with the desktop app.
pub const RUNNING_FILE: &str = "running.json";

/// How often the app refreshes the heartbeat while it is open.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

/// How old a heartbeat may be and still count as live. Three missed [`HEARTBEAT_INTERVAL`] beats,
/// so a busy machine is not mistaken for a closed app.
pub const FRESH_MS: i64 = 3 * HEARTBEAT_INTERVAL.as_millis() as i64;

/// The heartbeat the app writes; `pid` is informational only. A cross-process contract, so the
/// wire names may not change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub heartbeat_at: i64,
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(RUNNING_FILE)
}

/// Reads the heartbeat file, or `None` when it is absent or unreadable.
pub fn read(data_dir: &Path) -> Option<Heartbeat> {
    let raw = std::fs::read_to_string(path(data_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Whether `heartbeat` counts as live at `now`; a stamp in the future (clock skew) is live.
/// Saturating, because the stamp comes from a file and any two `i64`s could overflow.
pub fn is_fresh(heartbeat: &Heartbeat, now: i64) -> bool {
    heartbeat.heartbeat_at > 0 && now.saturating_sub(heartbeat.heartbeat_at) <= FRESH_MS
}

/// True when the MYNK window is open and draining the inbox.
pub fn app_is_running(data_dir: &Path, now: i64) -> bool {
    read(data_dir).is_some_and(|heartbeat| is_fresh(&heartbeat, now))
}

/// `"seconds"` while the app is open, `"next-launch"` otherwise.
pub fn appears_in(data_dir: &Path, now: i64) -> &'static str {
    if app_is_running(data_dir, now) {
        "seconds"
    } else {
        "next-launch"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, contents: &str) {
        std::fs::write(path(dir), contents).expect("write heartbeat");
    }

    #[test]
    fn a_missing_file_means_the_app_is_closed() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(read(dir.path()), None);
        assert!(!app_is_running(dir.path(), 1_000_000));
        assert_eq!(appears_in(dir.path(), 1_000_000), "next-launch");
    }

    #[test]
    fn a_fresh_heartbeat_means_the_app_is_open() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(
            dir.path(),
            r#"{"pid":4242,"startedAt":1000000,"heartbeatAt":1009000}"#,
        );
        let heartbeat = read(dir.path()).expect("parsed");
        assert_eq!(heartbeat.pid, 4242);
        assert_eq!(heartbeat.started_at, 1_000_000);
        assert!(app_is_running(dir.path(), 1_010_000));
        assert_eq!(appears_in(dir.path(), 1_010_000), "seconds");
    }

    #[test]
    fn a_stale_heartbeat_means_the_app_is_gone() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(
            dir.path(),
            r#"{"pid":1,"startedAt":1,"heartbeatAt":1000000}"#,
        );
        assert!(!app_is_running(dir.path(), 1_000_000 + FRESH_MS + 1));
        assert!(
            app_is_running(dir.path(), 1_000_000 + FRESH_MS),
            "the boundary itself still counts as live"
        );
    }

    #[test]
    fn a_clock_that_moved_backwards_does_not_read_as_dead() {
        let heartbeat = Heartbeat {
            pid: 1,
            started_at: 1,
            heartbeat_at: 2_000_000,
        };
        assert!(is_fresh(&heartbeat, 1_999_000), "a future stamp is live");
        assert!(!is_fresh(&Heartbeat::default(), 1_000));
    }

    /// The stamp is read from a file, so it can be any `i64` and must not overflow the check.
    #[test]
    fn an_absurd_stamp_answers_instead_of_panicking() {
        let with = |heartbeat_at| Heartbeat {
            pid: 1,
            started_at: 1,
            heartbeat_at,
        };
        assert!(
            is_fresh(&with(i64::MAX), i64::MIN),
            "a future stamp is live"
        );
        assert!(is_fresh(&with(i64::MAX), i64::MAX));
        assert!(!is_fresh(&with(1), i64::MAX), "long gone");
        assert!(
            !is_fresh(&with(i64::MIN), 0),
            "a non-positive stamp is never live"
        );
    }

    #[test]
    fn a_broken_or_partial_file_is_treated_as_closed() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(dir.path(), "{ not json");
        assert_eq!(read(dir.path()), None);
        assert!(!app_is_running(dir.path(), 1_000));

        write(dir.path(), "{}");
        assert_eq!(read(dir.path()), Some(Heartbeat::default()));
        assert!(!app_is_running(dir.path(), 1_000));
    }
}
