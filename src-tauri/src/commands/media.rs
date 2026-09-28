use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Runtime, State};

use crate::error::{AppError, AppResult};
use crate::library::export::display_path;
use crate::snapshot::cleanup::{MaintenanceReport, MAX_UPLOAD_BYTES};
use crate::snapshot::media::RemoteImageKind;
use crate::snapshot::{self, SnapshotResult};
use crate::state::AppState;

const RESOURCE_ID_HEADER: &str = "x-resource-id";
const EXT_HEADER: &str = "x-ext";

/// Absolute snapshot directory (the renderer joins file names to it for `convertFileSrc`).
#[tauri::command]
pub async fn get_snapshot_dir(state: State<'_, AppState>) -> AppResult<String> {
    Ok(display_path(&state.snapshot_dir)
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub async fn capture_snapshot<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> AppResult<SnapshotResult> {
    snapshot::capture(&app, &url).await
}

/// Ends every running or queued `capture_snapshot` promptly; each resolves as
/// `{ kind: "error", reason: "cancelled" }`. Captures started afterwards run normally.
#[tauri::command]
pub async fn cancel_snapshot_captures(state: State<'_, AppState>) -> AppResult<()> {
    state.cancel_snapshot_captures();
    Ok(())
}

fn header(request: &Request<'_>, name: &str) -> AppResult<String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::invalid_input(format!("Missing \"{name}\" header.")))
}

/// Raw binary body (Tauri 2 `InvokeBody::Raw`). Returns the stored file name.
#[tauri::command]
pub async fn save_uploaded_preview<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> AppResult<String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::invalid_input(
            "save_uploaded_preview expects a raw binary body.",
        ));
    };
    // Reject oversized bodies before copying them (the domain function checks again).
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::invalid_input(format!(
            "Preview image is too large (max {} MB).",
            MAX_UPLOAD_BYTES / (1024 * 1024)
        )));
    }
    let resource_id = header(&request, RESOURCE_ID_HEADER)?;
    let ext = header(&request, EXT_HEADER)?;
    snapshot::save_uploaded_preview(&app, resource_id, bytes.clone(), &ext).await
}

/// Downloads a remote favicon / og:image into the snapshot directory (or returns the cached
/// copy without network access). Returns the file name for `snapshotSrc()`.
#[tauri::command]
pub async fn cache_remote_image<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    kind: RemoteImageKind,
) -> AppResult<String> {
    snapshot::media::cache_remote_image(&app, &url, kind).await
}

/// Start-up maintenance: prune unreferenced files and enforce the size cap. The renderer must
/// clear references to the returned `evicted` file names.
#[tauri::command]
pub async fn maintain_snapshots<R: Runtime>(
    app: AppHandle<R>,
    keep_file_names: Vec<String>,
) -> AppResult<MaintenanceReport> {
    snapshot::maintain(&app, keep_file_names).await
}

/// Current size of the snapshot directory in bytes, for the settings page.
#[tauri::command]
pub async fn snapshot_dir_bytes<R: Runtime>(app: AppHandle<R>) -> AppResult<u64> {
    snapshot::dir_bytes(&app).await
}

#[tauri::command]
pub async fn delete_snapshots<R: Runtime>(
    app: AppHandle<R>,
    file_names: Vec<String>,
) -> AppResult<()> {
    snapshot::delete(&app, file_names).await
}

/// Factory reset: deletes every file in the snapshot directory, uploads included and whatever
/// their age; only in-flight temp files are skipped. Returns the number of deleted files.
#[tauri::command]
pub async fn reset_snapshots<R: Runtime>(app: AppHandle<R>) -> AppResult<u32> {
    snapshot::reset(&app).await
}
