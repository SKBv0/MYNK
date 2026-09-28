//! Persisted (non-secret) AI settings in `settings.store.json` via tauri-plugin-store.
//! All functions here are blocking; call them through `state::run_blocking`.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use super::{normalize_base_url, AIProvider, DEFAULT_OLLAMA_BASE_URL};
// The second process reads this file directly, so both sides name it from one place.
use crate::catalog::embed::settings_file::{
    ALLOW_PRIVATE_NETWORK_FIELD, BASE_URL_FIELD, EMBEDDING_MODEL_FIELD, SETTINGS_KEY,
    SETTINGS_STORE_FILE,
};
use crate::error::{AppError, AppResult};

/// Stored shape. `#[serde(default)]` lets stored values without `allowPrivateNetwork`
/// deserialize.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedSettings {
    pub provider: AIProvider,
    pub ollama_base_url: String,
    pub ollama_model: String,
    pub openrouter_model: String,
    pub allow_private_network: bool,
    /// Embedding model for the agent bridge's semantic search; empty picks one from the server.
    pub embedding_model: String,
}

impl Default for PersistedSettings {
    fn default() -> Self {
        Self {
            provider: AIProvider::Ollama,
            ollama_base_url: DEFAULT_OLLAMA_BASE_URL.to_string(),
            ollama_model: String::new(),
            openrouter_model: String::new(),
            allow_private_network: false,
            embedding_model: String::new(),
        }
    }
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> AppResult<PersistedSettings> {
    let store = app
        .store(SETTINGS_STORE_FILE)
        .map_err(|e| AppError::storage(format!("Could not open the settings store: {e}")))?;

    let Some(value) = store.get(SETTINGS_KEY) else {
        return Ok(PersistedSettings::default());
    };

    let mut parsed = parse_lenient(value);
    parsed.ollama_base_url = normalize_base_url(&parsed.ollama_base_url)
        .unwrap_or_else(|_| DEFAULT_OLLAMA_BASE_URL.to_string());
    Ok(parsed)
}

/// Field-by-field read: one invalid value (a provider name from a newer version, a wrong type)
/// resets only that field instead of every stored setting.
fn parse_lenient(value: Value) -> PersistedSettings {
    let Value::Object(map) = value else {
        log::warn!("Stored AI settings are not an object, using defaults");
        return PersistedSettings::default();
    };
    let defaults = PersistedSettings::default();
    PersistedSettings {
        provider: field(&map, "provider", defaults.provider),
        ollama_base_url: field(&map, BASE_URL_FIELD, defaults.ollama_base_url),
        ollama_model: field(&map, "ollamaModel", defaults.ollama_model),
        openrouter_model: field(&map, "openrouterModel", defaults.openrouter_model),
        allow_private_network: field(
            &map,
            ALLOW_PRIVATE_NETWORK_FIELD,
            defaults.allow_private_network,
        ),
        embedding_model: field(&map, EMBEDDING_MODEL_FIELD, defaults.embedding_model),
    }
}

fn field<T: DeserializeOwned>(map: &Map<String, Value>, key: &str, default: T) -> T {
    match map.get(key) {
        None => default,
        Some(raw) => T::deserialize(raw).unwrap_or_else(|error| {
            log::warn!("Stored AI setting \"{key}\" is invalid, using its default: {error}");
            default
        }),
    }
}

pub fn save<R: Runtime>(app: &AppHandle<R>, settings: &PersistedSettings) -> AppResult<()> {
    let store = app
        .store(SETTINGS_STORE_FILE)
        .map_err(|e| AppError::storage(format!("Could not open the settings store: {e}")))?;
    store.set(SETTINGS_KEY, json!(settings));
    store
        .save()
        .map_err(|e| AppError::storage(format!("Could not save AI settings: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_store_values_get_defaults() {
        let old = json!({
            "provider": "openrouter",
            "ollamaBaseUrl": "http://127.0.0.1:11434",
            "ollamaModel": "llama3",
            "openrouterModel": "openai/gpt-4o-mini"
        });
        let parsed: PersistedSettings = serde_json::from_value(old).expect("old shape parses");
        assert_eq!(parsed.provider, AIProvider::Openrouter);
        assert!(!parsed.allow_private_network);
    }

    #[test]
    fn one_invalid_field_keeps_the_others() {
        let stored = json!({
            "provider": "some-future-provider",
            "ollamaBaseUrl": "http://10.0.0.5:11434",
            "ollamaModel": "qwen3:8b",
            "openrouterModel": 42,
            "allowPrivateNetwork": true
        });
        let parsed = parse_lenient(stored);
        assert_eq!(parsed.provider, AIProvider::Ollama, "invalid → default");
        assert_eq!(parsed.ollama_base_url, "http://10.0.0.5:11434");
        assert_eq!(parsed.ollama_model, "qwen3:8b");
        assert_eq!(parsed.openrouter_model, "", "wrong type → default");
        assert!(parsed.allow_private_network);
        assert_eq!(parsed.embedding_model, "", "missing → default");

        assert_eq!(parse_lenient(json!("nope")), PersistedSettings::default());
        assert_eq!(parse_lenient(json!({})), PersistedSettings::default());
    }
}
