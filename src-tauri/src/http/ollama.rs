//! What both Ollama callers need: the base-URL rule, the client builder, the endpoint form,
//! the `/api/tags` shape and the error-body detail. Tauri-free, so `catalog::embed` can use it.

use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use url::Url;

use super::guard::{AddressPolicy, GuardedResolver};
use super::{APP_USER_AGENT, CONNECT_TIMEOUT};
use crate::error::{truncate_chars, MAX_ERROR_BODY_CHARS};

/// Where Ollama runs unless the user says otherwise.
pub const DEFAULT_OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";

/// Normalizes a non-empty Ollama base URL: http/https, host required, no credentials, query or
/// fragment; trailing slash removed. `Err` carries the sentence the user is shown.
pub fn normalize_base_url(trimmed: &str) -> Result<String, String> {
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = Url::parse(&candidate).map_err(|e| format!("Ollama base URL is not valid: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Ollama base URL must start with http:// or https://.".to_string());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("Ollama base URL must include a host.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Ollama base URL must not contain credentials.".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Ollama base URL must not contain a query or fragment.".to_string());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// `<base>/<path>`, whether or not the base was stored with a trailing slash.
pub fn endpoint(base_url: &str, path: &str) -> String {
    format!("{}/{}", base_url.trim_end_matches('/'), path)
}

/// Guarded client for the Ollama API: no redirects, no proxy, caller-chosen response timeout.
/// The error stays a `reqwest` one so each caller keeps its own wording.
pub fn build_client(policy: AddressPolicy, timeout: Duration) -> reqwest::Result<Client> {
    Client::builder()
        .user_agent(APP_USER_AGENT)
        .timeout(timeout)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(Policy::none())
        .dns_resolver(GuardedResolver::new(policy))
        .no_proxy()
        .build()
}

/// `GET /api/tags`.
#[derive(Debug, Deserialize)]
pub struct TagsResponse {
    #[serde(default)]
    pub models: Vec<TagModel>,
}

#[derive(Debug, Deserialize)]
pub struct TagModel {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub details: Option<TagModelDetails>,
}

#[derive(Debug, Deserialize)]
pub struct TagModelDetails {
    /// The model's trained context window, reported by `/api/tags` on current Ollama releases.
    #[serde(default)]
    pub context_length: Option<u64>,
    /// Architecture family, e.g. `qwen3`, `nomic-bert`, `bert`.
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub families: Option<Vec<String>>,
}

/// The `error` string of an Ollama JSON error body, if the body is one.
pub fn json_error(raw: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(raw)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
}

/// What to put after "HTTP 500": the JSON `error` field, else the raw text, clipped and trimmed
/// (so an empty body leaves no dangling colon).
pub fn error_detail(raw: &[u8]) -> String {
    let detail = json_error(raw).unwrap_or_else(|| String::from_utf8_lossy(raw).to_string());
    truncate_chars(&detail, MAX_ERROR_BODY_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_urls() {
        assert_eq!(
            normalize_base_url("http://127.0.0.1:11434/").expect("trailing slash"),
            DEFAULT_OLLAMA_BASE_URL
        );
        assert_eq!(
            normalize_base_url("localhost:11434").expect("scheme added"),
            "http://localhost:11434"
        );
        assert_eq!(
            normalize_base_url("https://ollama.example.com/base/").expect("path kept"),
            "https://ollama.example.com/base"
        );
        for bad in [
            "file:///etc/passwd",
            "javascript://alert(1)",
            "http://user:pw@host",
            "http://host/?q=1",
            "http://host/#x",
        ] {
            assert!(normalize_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn joins_endpoints_and_extracts_error_details() {
        assert_eq!(
            endpoint("http://127.0.0.1:11434", "api/tags"),
            "http://127.0.0.1:11434/api/tags"
        );
        assert_eq!(
            endpoint("http://127.0.0.1:11434/", "api/embed"),
            "http://127.0.0.1:11434/api/embed"
        );
        assert_eq!(error_detail(br#"{"error":"boom"}"#), "boom");
        assert_eq!(error_detail(b"  \n"), "");
        assert_eq!(error_detail(b"404 page not found"), "404 page not found");
        assert_eq!(json_error(b"plain text"), None);
    }
}
