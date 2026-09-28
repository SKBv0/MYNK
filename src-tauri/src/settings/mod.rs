//! AI provider settings: persisted store + OS keyring secret + in-memory cache.

pub mod secrets;
pub mod store;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult};
pub use crate::http::ollama::DEFAULT_OLLAMA_BASE_URL;
use crate::state::{run_blocking, AppState};
pub use store::PersistedSettings;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AIProvider {
    #[default]
    Ollama,
    Openrouter,
}

/// Public settings (`AISettings` in ipcTypes.ts).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AISettings {
    pub provider: AIProvider,
    pub ollama_base_url: String,
    pub ollama_model: String,
    pub openrouter_model: String,
    pub has_openrouter_api_key: bool,
    pub allow_private_network: bool,
    pub embedding_model: String,
}

/// `AISettingsUpdate` in ipcTypes.ts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AISettingsUpdate {
    pub provider: AIProvider,
    pub ollama_base_url: String,
    pub ollama_model: String,
    pub openrouter_model: String,
    #[serde(default)]
    pub allow_private_network: bool,
    #[serde(default)]
    pub embedding_model: String,
}

impl AISettings {
    pub fn from_persisted(settings: PersistedSettings, has_openrouter_api_key: bool) -> Self {
        Self {
            provider: settings.provider,
            ollama_base_url: settings.ollama_base_url,
            ollama_model: settings.ollama_model,
            openrouter_model: settings.openrouter_model,
            has_openrouter_api_key,
            allow_private_network: settings.allow_private_network,
            embedding_model: settings.embedding_model,
        }
    }
}

impl TryFrom<AISettingsUpdate> for PersistedSettings {
    type Error = AppError;

    /// Only the base URL is validated here; models are checked when settings are used or tested.
    fn try_from(update: AISettingsUpdate) -> AppResult<Self> {
        Ok(Self {
            provider: update.provider,
            ollama_base_url: normalize_base_url(&update.ollama_base_url)?,
            ollama_model: update.ollama_model.trim().to_string(),
            openrouter_model: update.openrouter_model.trim().to_string(),
            allow_private_network: update.allow_private_network,
            embedding_model: update.embedding_model.trim().to_string(),
        })
    }
}

/// [`crate::http::ollama::normalize_base_url`] as a command result; empty input is the default.
pub fn normalize_base_url(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(DEFAULT_OLLAMA_BASE_URL.to_string());
    }
    crate::http::ollama::normalize_base_url(trimmed).map_err(AppError::config)
}

/// Loads settings (cached after first read). A cache miss takes `settings_lock`, shared with
/// `save`, so an in-flight load can't overwrite a newer save's cached value.
pub async fn load<R: Runtime>(app: &AppHandle<R>) -> AppResult<PersistedSettings> {
    let state = app.state::<AppState>();
    if let Some(cached) = state.cached_settings() {
        return Ok(cached);
    }
    let _guard = state.settings_lock.lock().await;
    // Another loader or a save may have filled the cache while this call waited for the lock.
    if let Some(cached) = state.cached_settings() {
        return Ok(cached);
    }
    let handle = app.clone();
    let loaded = run_blocking(move || store::load(&handle)).await?;
    state.set_cached_settings(loaded.clone());
    Ok(loaded)
}

pub async fn save<R: Runtime>(app: &AppHandle<R>, settings: PersistedSettings) -> AppResult<()> {
    let state = app.state::<AppState>();
    let _guard = state.settings_lock.lock().await;
    let handle = app.clone();
    let to_store = settings.clone();
    run_blocking(move || store::save(&handle, &to_store)).await?;
    state.set_cached_settings(settings);
    Ok(())
}

pub async fn api_key() -> AppResult<Option<String>> {
    run_blocking(secrets::get_api_key).await
}

pub async fn has_api_key() -> AppResult<bool> {
    Ok(api_key().await?.is_some())
}

pub async fn set_api_key(api_key: String) -> AppResult<()> {
    run_blocking(move || secrets::set_api_key(&api_key)).await
}

pub async fn clear_api_key() -> AppResult<()> {
    run_blocking(secrets::clear_api_key).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_urls() {
        assert_eq!(
            normalize_base_url("").expect("default"),
            DEFAULT_OLLAMA_BASE_URL
        );
        assert_eq!(
            normalize_base_url(" http://127.0.0.1:11434/ ").expect("trailing slash"),
            "http://127.0.0.1:11434"
        );
        assert_eq!(
            normalize_base_url("localhost:11434").expect("scheme added"),
            "http://localhost:11434"
        );
        assert_eq!(
            normalize_base_url("https://ollama.example.com/base/").expect("path kept"),
            "https://ollama.example.com/base"
        );
        assert!(normalize_base_url("file:///etc/passwd").is_err());
        assert!(normalize_base_url("javascript://alert(1)").is_err());
        assert!(normalize_base_url("http://user:pw@host").is_err());
        assert!(normalize_base_url("http://host/?q=1").is_err());
    }

    #[test]
    fn update_does_not_require_models() {
        let update = AISettingsUpdate {
            provider: AIProvider::Openrouter,
            ollama_base_url: String::new(),
            ollama_model: String::new(),
            openrouter_model: String::new(),
            embedding_model: String::new(),
            allow_private_network: false,
        };
        let persisted =
            PersistedSettings::try_from(update).expect("saving must not validate models");
        assert_eq!(persisted.ollama_base_url, DEFAULT_OLLAMA_BASE_URL);
    }
}
