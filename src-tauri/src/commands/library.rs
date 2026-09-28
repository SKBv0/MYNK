use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime, State};

use crate::error::AppResult;
use crate::library::{self, export};
use crate::state::{run_blocking, AppState};

/// Directory exports are written to (and the only place `reveal_in_folder` may open).
fn export_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .download_dir()
        .ok()
        .or_else(dirs::download_dir)
        .or_else(|| dirs::home_dir().map(|home| home.join("Downloads")))
        .unwrap_or_else(std::env::temp_dir)
}

/// Reads the library, taking the same lock as `library_save` so a concurrent save's rename
/// window can't be read as a missing file. `recoveredFromBackup` is true only if `.bak` was used.
#[tauri::command]
pub async fn library_load(state: State<'_, AppState>) -> AppResult<library::LibraryLoad> {
    let _guard = state.library_lock.lock().await;
    let dir = state.data_dir.clone();
    run_blocking(move || library::load(&dir)).await
}

#[tauri::command]
pub async fn library_save(state: State<'_, AppState>, json: String) -> AppResult<()> {
    let _guard = state.library_lock.lock().await;
    let dir = state.data_dir.clone();
    run_blocking(move || library::save(&dir, &json)).await
}

#[tauri::command]
pub async fn export_library<R: Runtime>(
    app: AppHandle<R>,
    format: export::ExportFormat,
    content: String,
    suggested_name: String,
) -> AppResult<String> {
    let dir = export_dir(&app);
    let stem = export::sanitize_stem(&suggested_name);
    let path = run_blocking(move || export::write_unique(&dir, &stem, format, &content)).await?;
    Ok(export::display_path(&path).to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn reveal_in_folder<R: Runtime>(app: AppHandle<R>, path: String) -> AppResult<()> {
    let dir = export_dir(&app);
    run_blocking(move || {
        let target = export::resolve_revealable(&dir, &path)?;
        export::reveal(&target)
    })
    .await
}
