use tauri::{AppHandle, Manager, Runtime};

use crate::browsers::{self, DetectedProfile, ImportedBookmark};
use crate::error::AppResult;
use crate::state::{run_blocking, AppState};

/// Chromium family + Firefox profiles. Filesystem paths never leave Rust.
#[tauri::command]
pub async fn detect_browsers<R: Runtime>(app: AppHandle<R>) -> AppResult<Vec<DetectedProfile>> {
    run_blocking(move || Ok(browsers::detect(&app.state::<AppState>().profiles))).await
}

#[tauri::command]
pub async fn read_browser_bookmarks<R: Runtime>(
    app: AppHandle<R>,
    profile_id: String,
) -> AppResult<Vec<ImportedBookmark>> {
    run_blocking(move || browsers::read(&app.state::<AppState>().profiles, &profile_id)).await
}
