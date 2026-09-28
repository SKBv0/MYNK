//! App-side agent bridge: the inbox handover (`peek_agent_inbox` / `ack_agent_inbox`) and the
//! `running.json` heartbeat that tells a second process whether MYNK is open.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;
use tokio::time::MissedTickBehavior;

use crate::catalog::inbox::{self, InboxFile};
use crate::error::AppResult;
use crate::mcp::running::{self, Heartbeat, HEARTBEAT_INTERVAL, RUNNING_FILE};
use crate::state::{run_blocking, AppState};
use crate::util::{lock, now_ms, write_atomically};

/// The MCP binary Tauri installs next to the app executable (`bundle.externalBin`).
const MCP_BINARY_NAME: &str = if cfg!(windows) {
    "mynk-mcp.exe"
} else {
    "mynk-mcp"
};

/// What the Settings -> Agents tab shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeInfo {
    /// Absolute path of `mynk-mcp` next to the executable, or `null` if not installed. The only
    /// path exposed to the renderer, for pasting into the agent's config.
    pub mcp_path: Option<String>,
    pub mcp_available: bool,
    pub inbox_pending: u32,
}

/// Writes the heartbeat [`crate::mcp::running`] defines, atomically: no reader sees half a file.
pub fn write_running(data_dir: &Path, started_at: i64) -> std::io::Result<()> {
    let info = Heartbeat {
        pid: std::process::id(),
        started_at,
        heartbeat_at: now_ms(),
    };
    let json = serde_json::to_string(&info).map_err(std::io::Error::other)?;
    fs::create_dir_all(data_dir)?;
    let tmp = data_dir.join(format!("{RUNNING_FILE}.tmp"));
    write_atomically(&running::path(data_dir), &tmp, json.as_bytes())
}

pub fn remove_running(data_dir: &Path) {
    match fs::remove_file(running::path(data_dir)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("agents: could not remove {RUNNING_FILE}: {error}"),
    }
}

/// This process's `running.json`: refreshed until [`RunningFile::stop`]; a refresh already in
/// flight cannot rewrite it after that.
#[derive(Clone)]
pub struct RunningFile {
    inner: Arc<RunningFileInner>,
}

struct RunningFileInner {
    data_dir: PathBuf,
    started_at: i64,
    /// Held across every write, so `stop` waits for one in flight; `true` once stopped.
    stopped: Mutex<bool>,
}

impl RunningFile {
    pub fn new(data_dir: PathBuf, started_at: i64) -> Self {
        Self {
            inner: Arc::new(RunningFileInner {
                data_dir,
                started_at,
                stopped: Mutex::new(false),
            }),
        }
    }

    /// Rewrites the heartbeat; `Ok(false)` once the file has been stopped.
    pub fn refresh(&self) -> std::io::Result<bool> {
        let stopped = lock(&self.inner.stopped);
        if *stopped {
            return Ok(false);
        }
        write_running(&self.inner.data_dir, self.inner.started_at)?;
        Ok(true)
    }

    /// Removes the file; called when the app exits.
    pub fn stop(&self) {
        let mut stopped = lock(&self.inner.stopped);
        *stopped = true;
        remove_running(&self.inner.data_dir);
    }
}

/// Called from the Tauri `setup` hook; a failure is logged and never stops start-up.
pub fn start_heartbeat(data_dir: PathBuf) -> RunningFile {
    let file = RunningFile::new(data_dir, now_ms());
    if let Err(error) = file.refresh() {
        log::warn!("agents: could not write {RUNNING_FILE}: {error}");
    }
    let ticking = file.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
        // Avoids a burst of catch-up writes after the machine wakes from sleep.
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            // `write_running` fsyncs, so it never runs on an async worker.
            let file = ticking.clone();
            match run_blocking(move || Ok(file.refresh())).await {
                Ok(Ok(true)) => {}
                Ok(Ok(false)) => break,
                Ok(Err(error)) => {
                    log::warn!("agents: could not refresh {RUNNING_FILE}: {error}")
                }
                Err(error) => log::warn!("agents: the heartbeat task failed: {error}"),
            }
        }
    });
    file
}

/// Absolute path of the `mynk-mcp` binary next to the executable, if installed.
pub fn mcp_binary_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    installed_binary(exe.parent()?)
}

/// `mynk-mcp` in `dir`; an empty file is the build's placeholder, not an installed binary.
fn installed_binary(dir: &Path) -> Option<PathBuf> {
    let candidate = dir.join(MCP_BINARY_NAME);
    let installed = fs::metadata(&candidate).is_ok_and(|meta| meta.is_file() && meta.len() > 0);
    installed.then_some(candidate)
}

fn pending_count(data_dir: &Path) -> u32 {
    u32::try_from(inbox::count(data_dir)).unwrap_or(u32::MAX)
}

/// Every pending inbox entry, without removing anything. The renderer only calls
/// [`ack_agent_inbox`] after a successful save, so a failed save keeps the bookmarks.
#[tauri::command]
pub async fn peek_agent_inbox(state: State<'_, AppState>) -> AppResult<Vec<InboxFile>> {
    let dir = state.data_dir.clone();
    run_blocking(move || inbox::peek(&dir)).await
}

/// Removes only the named entry files. A name that is not a plain inbox file name is
/// rejected (`invalidInput`) and nothing is deleted.
#[tauri::command]
pub async fn ack_agent_inbox(state: State<'_, AppState>, names: Vec<String>) -> AppResult<()> {
    let dir = state.data_dir.clone();
    run_blocking(move || inbox::ack(&dir, &names)).await
}

#[tauri::command]
pub async fn get_agent_bridge_info(state: State<'_, AppState>) -> AppResult<AgentBridgeInfo> {
    let dir = state.data_dir.clone();
    run_blocking(move || {
        let mcp_path = mcp_binary_path();
        Ok(AgentBridgeInfo {
            mcp_available: mcp_path.is_some(),
            mcp_path: mcp_path.map(|path| path.to_string_lossy().into_owned()),
            inbox_pending: pending_count(&dir),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    #[test]
    fn the_heartbeat_file_round_trips_and_leaves_no_temp_file() {
        let dir = temp_dir();
        assert!(running::read(dir.path()).is_none());
        assert!(!running::app_is_running(dir.path(), now_ms()));

        write_running(dir.path(), 1_757_000_000_000).expect("write");
        let info = running::read(dir.path()).expect("heartbeat");
        assert_eq!(info.pid, std::process::id());
        assert_eq!(info.started_at, 1_757_000_000_000);
        assert!(info.heartbeat_at > 0);
        assert!(running::app_is_running(dir.path(), now_ms()));
        assert!(!dir.path().join("running.json.tmp").exists());

        write_running(dir.path(), 1_757_000_000_000).expect("refresh");
        assert!(running::read(dir.path()).is_some());

        remove_running(dir.path());
        assert!(!running::path(dir.path()).exists());
        assert!(!running::app_is_running(dir.path(), now_ms()));
        remove_running(dir.path());
    }

    #[test]
    fn a_damaged_heartbeat_file_reads_as_not_running() {
        let dir = temp_dir();
        fs::write(running::path(dir.path()), "{ not json").expect("broken");
        assert!(running::read(dir.path()).is_none());
        assert!(!running::app_is_running(dir.path(), now_ms()));
    }

    /// `mynk-mcp` reads this file without linking any of this code, so the wire shape is fixed.
    #[test]
    fn the_heartbeat_file_uses_the_camel_case_wire_shape() {
        let dir = temp_dir();
        write_running(dir.path(), 1_757_000_000_000).expect("write");
        let raw = fs::read_to_string(running::path(dir.path())).expect("read");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(value["startedAt"], 1_757_000_000_000i64);
        assert!(value["heartbeatAt"].is_i64(), "{raw}");
        assert!(value["pid"].is_u64(), "{raw}");
        assert!(value.get("started_at").is_none(), "{raw}");
        assert!(value.get("heartbeat_at").is_none(), "{raw}");
    }

    #[test]
    fn bridge_info_serializes_as_camel_case() {
        let value = serde_json::to_value(AgentBridgeInfo {
            mcp_path: None,
            mcp_available: false,
            inbox_pending: 3,
        })
        .expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "mcpPath": null,
                "mcpAvailable": false,
                "inboxPending": 3
            })
        );
    }

    #[test]
    fn the_test_binary_has_no_mcp_sibling() {
        assert_eq!(mcp_binary_path(), None);
    }

    #[test]
    fn an_empty_placeholder_is_not_an_installed_binary() {
        let dir = temp_dir();
        let binary = dir.path().join(MCP_BINARY_NAME);
        fs::write(&binary, b"").expect("placeholder");
        assert_eq!(installed_binary(dir.path()), None);

        fs::write(&binary, b"MZ").expect("binary");
        assert_eq!(installed_binary(dir.path()), Some(binary));
    }

    #[test]
    fn a_stopped_heartbeat_is_never_written_again() {
        let dir = temp_dir();
        let file = RunningFile::new(dir.path().to_path_buf(), 1_757_000_000_000);
        assert!(file.refresh().expect("write"));
        assert!(running::path(dir.path()).exists());

        file.clone().stop();
        assert!(!running::path(dir.path()).exists());
        assert!(!file.refresh().expect("refresh after stop"));
        assert!(!running::path(dir.path()).exists());
    }
}
