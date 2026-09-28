use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::error::{AppError, AppResult};
use crate::providers::{
    self, ollama, openrouter, CompletionRequest, Message, ModelInfo, ResponseFormat, Role,
};
use crate::settings::{self, normalize_base_url, AISettingsUpdate, PersistedSettings};
use crate::state::AppState;

/// Why a connection test failed (`ProviderConnectionFailure` in ipcTypes.ts). The renderer shows
/// a translated sentence for it; `message` stays English developer text.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionFailure {
    /// No connection (refused, DNS, TLS).
    Unreachable,
    Timeout,
    /// The SSRF guard refused a private-network address.
    BlockedAddress,
    ModelMissing,
    NotChatModel,
    /// The provider rejected the API key (401/403) or the keychain could not provide it.
    Unauthorized,
    /// The draft itself is incomplete or invalid (no model, bad address, no API key).
    InvalidSettings,
    Other,
}

impl ConnectionFailure {
    pub fn classify(error: &AppError) -> Self {
        match error {
            AppError::ModelMissing { .. } => Self::ModelMissing,
            AppError::NotChatModel { .. } => Self::NotChatModel,
            AppError::Network { .. } => Self::Unreachable,
            AppError::Timeout(_) => Self::Timeout,
            AppError::BlockedAddress(_) => Self::BlockedAddress,
            AppError::Provider {
                status: Some(401 | 403),
                ..
            }
            | AppError::Keyring(_) => Self::Unauthorized,
            AppError::Config(_) | AppError::InvalidInput(_) => Self::InvalidSettings,
            _ => Self::Other,
        }
    }
}

/// `ProviderConnectionResult` in ipcTypes.ts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectionResult {
    ok: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_ms: Option<u64>,
    /// Set when `ok` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<ConnectionFailure>,
}

impl ProviderConnectionResult {
    fn failed(error: &AppError, latency_ms: Option<u64>) -> Self {
        Self {
            ok: false,
            message: error.to_string(),
            latency_ms,
            reason: Some(ConnectionFailure::classify(error)),
        }
    }
}

/// Lists Ollama models. `baseUrl`/`allowPrivateNetwork` are the renderer's unsaved draft values
/// and win over stored settings when supplied; omitted values fall back to what is stored.
#[tauri::command]
pub async fn list_ollama_models<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    base_url: Option<String>,
    allow_private_network: Option<bool>,
) -> AppResult<Vec<ModelInfo>> {
    let stored = settings::load(&app).await?;
    let base = match base_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => normalize_base_url(raw)?,
        None => stored.ollama_base_url.clone(),
    };
    let allow_private = allow_private_network.unwrap_or(stored.allow_private_network);
    ollama::list_models(state.http.ollama(allow_private), &base, allow_private).await
}

#[tauri::command]
pub async fn list_openrouter_models(state: State<'_, AppState>) -> AppResult<Vec<ModelInfo>> {
    openrouter::list_models(state.http.openrouter()).await
}

/// Runs a tiny completion against the candidate settings to check reachability and that the
/// model exists. Reasoning models are asked to skip their thinking channel to save the budget.
#[tauri::command]
pub async fn test_provider_connection(
    state: State<'_, AppState>,
    payload: AISettingsUpdate,
) -> AppResult<ProviderConnectionResult> {
    let candidate = match PersistedSettings::try_from(payload) {
        Ok(candidate) => candidate,
        Err(error) => return Ok(ProviderConnectionResult::failed(&error, None)),
    };
    let provider = match providers::provider_from_settings(&state, &candidate).await {
        Ok(provider) => provider,
        Err(error) => return Ok(ProviderConnectionResult::failed(&error, None)),
    };
    let request = CompletionRequest {
        messages: vec![
            Message::new(
                Role::System,
                "You are a connectivity check. Reply with the single word: pong",
            ),
            Message::new(Role::User, "ping"),
        ],
        format: ResponseFormat::Text,
        temperature: 0.0,
        max_tokens: Some(16),
        disable_thinking: true,
    };
    let started = Instant::now();
    let result = provider.complete_raw(&request).await;
    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    Ok(match result {
        Ok(_) => ProviderConnectionResult {
            ok: true,
            message: format!(
                "{} answered with model {} in {latency_ms} ms.",
                provider.label(),
                provider.model()
            ),
            latency_ms: Some(latency_ms),
            reason: None,
        },
        Err(error) => ProviderConnectionResult::failed(&error, Some(latency_ms)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_are_classified_into_reasons() {
        let cases = [
            (
                AppError::ModelMissing { model: "m".into() },
                ConnectionFailure::ModelMissing,
            ),
            (
                AppError::NotChatModel { model: "m".into() },
                ConnectionFailure::NotChatModel,
            ),
            (
                AppError::network("Could not connect"),
                ConnectionFailure::Unreachable,
            ),
            (AppError::Timeout("slow".into()), ConnectionFailure::Timeout),
            (
                AppError::BlockedAddress("10.0.0.7".into()),
                ConnectionFailure::BlockedAddress,
            ),
            (
                AppError::provider("bad key", Some(401)),
                ConnectionFailure::Unauthorized,
            ),
            (
                AppError::config("Select an Ollama model"),
                ConnectionFailure::InvalidSettings,
            ),
            (
                AppError::provider("Ollama returned HTTP 500.", Some(500)),
                ConnectionFailure::Other,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(ConnectionFailure::classify(&error), expected, "{error}");
        }
    }

    #[test]
    fn a_failed_result_serializes_its_reason() {
        let value = serde_json::to_value(ProviderConnectionResult::failed(
            &AppError::ModelMissing { model: "m".into() },
            Some(3),
        ))
        .expect("serialize");
        assert_eq!(value["ok"], false);
        assert_eq!(value["reason"], "modelMissing");
        assert_eq!(value["latencyMs"], 3);
    }
}
