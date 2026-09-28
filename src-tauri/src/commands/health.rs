use tauri::{AppHandle, Runtime};

use crate::error::AppResult;
use crate::health::{self, LinkHealthResult};

/// Checks links concurrently and emits `health-scan-progress`. When cancelled, resolves with
/// the results gathered so far.
#[tauri::command]
pub async fn check_links_health<R: Runtime>(
    app: AppHandle<R>,
    urls: Vec<String>,
    run_id: String,
) -> AppResult<Vec<LinkHealthResult>> {
    health::check_links(&app, urls, run_id).await
}

#[tauri::command]
pub async fn cancel_health_scan<R: Runtime>(app: AppHandle<R>, run_id: String) -> AppResult<()> {
    health::cancel(&app, &run_id);
    Ok(())
}
