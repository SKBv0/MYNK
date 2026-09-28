use crate::error::{AppError, AppResult};
use crate::http::normalize_target_url;
use crate::state::run_blocking;

/// Opens an http/https URL in the system browser. Other schemes are rejected.
#[tauri::command]
pub async fn open_external_url(url: String) -> AppResult<()> {
    let url = normalize_target_url(&url)?;
    run_blocking(move || {
        webbrowser::open(url.as_str())
            .map_err(|e| AppError::internal(format!("Could not open the browser: {e}")))
    })
    .await
}
