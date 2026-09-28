//! The settings the embedding index needs, read from `settings.store.json` without Tauri.
//! Reading never fails: a missing, unreadable or malformed file yields
//! [`EmbedSettings::default`], and nothing is written back.

use std::fs;
use std::path::{Path, PathBuf};

pub use crate::http::ollama::DEFAULT_OLLAMA_BASE_URL;

pub const SETTINGS_STORE_FILE: &str = "settings.store.json";
/// The store key everything AI-related lives under.
pub const SETTINGS_KEY: &str = "ai";
/// Field names inside that object, as `PersistedSettings` serializes them (camelCase).
pub const BASE_URL_FIELD: &str = "ollamaBaseUrl";
pub const ALLOW_PRIVATE_NETWORK_FIELD: &str = "allowPrivateNetwork";
/// The embedding model chosen in Settings; empty means "pick one from the server".
pub const EMBEDDING_MODEL_FIELD: &str = "embeddingModel";

/// Overrides the embedding model that would otherwise be picked from `/api/tags`.
pub const EMBED_MODEL_ENV: &str = "MYNK_EMBED_MODEL";

/// The settings file holds a handful of short strings; anything larger is not it.
const MAX_SETTINGS_BYTES: u64 = 64 * 1024;

/// What the embedding client needs to know about the user's setup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedSettings {
    /// Normalized base URL (no trailing slash, no credentials, no query).
    pub ollama_base_url: String,
    /// Whether requests may reach private/LAN addresses as well as loopback.
    pub allow_private_network: bool,
    /// The model chosen in Settings; `None` lets the server's list decide.
    pub embedding_model: Option<String>,
}

impl Default for EmbedSettings {
    fn default() -> Self {
        Self {
            ollama_base_url: DEFAULT_OLLAMA_BASE_URL.to_string(),
            allow_private_network: false,
            embedding_model: None,
        }
    }
}

pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_STORE_FILE)
}

/// Reads the settings the app persisted; never fails.
pub fn load(data_dir: &Path) -> EmbedSettings {
    let path = settings_path(data_dir);
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() > MAX_SETTINGS_BYTES => {
            log::warn!("embed: {SETTINGS_STORE_FILE} is implausibly large, using defaults");
            return EmbedSettings::default();
        }
        Ok(_) => {}
        // No file until the settings dialog is first saved; not worth a warning.
        Err(_) => return EmbedSettings::default(),
    }
    match fs::read_to_string(&path) {
        Ok(raw) => parse(&raw),
        Err(error) => {
            log::warn!("embed: {SETTINGS_STORE_FILE} could not be read ({error}), using defaults");
            EmbedSettings::default()
        }
    }
}

/// Field-by-field read of the store JSON: an unusable value falls back to its own default
/// without affecting the other.
pub fn parse(json: &str) -> EmbedSettings {
    let defaults = EmbedSettings::default();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        log::warn!("embed: {SETTINGS_STORE_FILE} is not valid JSON, using defaults");
        return defaults;
    };
    let Some(ai) = value.get(SETTINGS_KEY) else {
        return defaults;
    };
    let ollama_base_url = ai
        .get(BASE_URL_FIELD)
        .and_then(serde_json::Value::as_str)
        .and_then(normalize_base_url)
        .unwrap_or(defaults.ollama_base_url);
    let allow_private_network = ai
        .get(ALLOW_PRIVATE_NETWORK_FIELD)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(defaults.allow_private_network);
    let embedding_model = ai
        .get(EMBEDDING_MODEL_FIELD)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    EmbedSettings {
        ollama_base_url,
        allow_private_network,
        embedding_model,
    }
}

/// [`crate::http::ollama::normalize_base_url`] as an `Option`; `None` falls back to the default.
pub fn normalize_base_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    crate::http::ollama::normalize_base_url(trimmed).ok()
}

/// The embedding model named by [`EMBED_MODEL_ENV`], if any; a blank value is treated as unset.
pub fn model_override() -> Option<String> {
    let raw = std::env::var(EMBED_MODEL_ENV).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_yields_the_defaults() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(load(dir.path()), EmbedSettings::default());
        assert_eq!(
            settings_path(dir.path()),
            dir.path().join("settings.store.json")
        );
    }

    #[test]
    fn reads_the_shape_the_app_writes() {
        let dir = tempfile::tempdir().expect("temp dir");
        // Byte for byte the file `tauri-plugin-store` produces (pretty printed, sorted keys).
        fs::write(
            settings_path(dir.path()),
            r#"{
  "ai": {
    "allowPrivateNetwork": true,
    "ollamaBaseUrl": "http://192.168.1.20:11434/",
    "ollamaModel": "qwen3.5:9b",
    "openrouterModel": "",
    "provider": "ollama"
  }
}"#,
        )
        .expect("write settings");
        let settings = load(dir.path());
        assert_eq!(settings.ollama_base_url, "http://192.168.1.20:11434");
        assert!(settings.allow_private_network);
    }

    #[test]
    fn a_broken_file_falls_back_instead_of_failing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let write = |content: &str| fs::write(settings_path(dir.path()), content).expect("write");

        write("{ not json");
        assert_eq!(load(dir.path()), EmbedSettings::default());
        write("[]");
        assert_eq!(load(dir.path()), EmbedSettings::default());
        write(r#"{"other":{"ollamaBaseUrl":"http://10.0.0.9:1"}}"#);
        assert_eq!(load(dir.path()), EmbedSettings::default());
        write(r#"{"ai":{"ollamaBaseUrl":"file:///etc/passwd","allowPrivateNetwork":true}}"#);
        let settings = load(dir.path());
        assert_eq!(settings.ollama_base_url, DEFAULT_OLLAMA_BASE_URL);
        assert!(settings.allow_private_network);
        write(r#"{"ai":{"ollamaBaseUrl":"localhost:11434","allowPrivateNetwork":"yes"}}"#);
        let settings = load(dir.path());
        assert_eq!(settings.ollama_base_url, "http://localhost:11434");
        assert!(!settings.allow_private_network, "a string is not a bool");
        assert_eq!(settings.embedding_model, None, "missing is unset");
        write(r#"{"ai":{"embeddingModel":"  bge-m3:567m "}}"#);
        assert_eq!(
            load(dir.path()).embedding_model.as_deref(),
            Some("bge-m3:567m")
        );
        write(r#"{"ai":{"embeddingModel":"   "}}"#);
        assert_eq!(load(dir.path()).embedding_model, None, "blank is unset");
        write(r#"{"ai":{"embeddingModel":7}}"#);
        assert_eq!(
            load(dir.path()).embedding_model,
            None,
            "a number is not a name"
        );

        write(&format!(r#"{{"pad":"{}"}}"#, "x".repeat(70_000)));
        assert_eq!(load(dir.path()), EmbedSettings::default(), "oversized file");
    }

    #[test]
    fn an_unusable_base_url_falls_back_instead_of_failing() {
        assert_eq!(
            normalize_base_url(" http://127.0.0.1:11434/ ").as_deref(),
            Some(DEFAULT_OLLAMA_BASE_URL)
        );
        for raw in [
            "",
            "   ",
            "file:///etc/passwd",
            "javascript://alert(1)",
            "http://user:pw@host",
            "http://host/?q=1",
            "http://host/#x",
        ] {
            assert_eq!(normalize_base_url(raw), None, "{raw}");
        }
    }

    /// The variable is process-global, so this only checks the parsing around it.
    #[test]
    fn the_model_override_ignores_blanks() {
        assert_eq!(EMBED_MODEL_ENV, "MYNK_EMBED_MODEL");
        match std::env::var(EMBED_MODEL_ENV) {
            Ok(value) if !value.trim().is_empty() => {
                assert_eq!(model_override().as_deref(), Some(value.trim()));
            }
            _ => assert_eq!(model_override(), None),
        }
    }
}
