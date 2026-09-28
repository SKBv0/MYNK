//! Application error model. Every command returns `AppResult<T>`; a rejected `invoke()`
//! receives `{ kind, message, status?, code?, model? }` (`AppErrorPayload` in ipcTypes.ts).

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use std::error::Error as StdError;

use crate::http::guard::{BlockedAddressError, DnsLookupError};

/// Maximum length of any provider / page body echoed back in an error message.
pub const MAX_ERROR_BODY_CHARS: usize = 200;

// Network failures that end the same way for the rest of a run; the job queue retries any
// other `network` error.
const HOST_NOT_FOUND: &str = "hostNotFound";
const TLS_CERTIFICATE: &str = "tlsCertificate";
const TLS_HANDSHAKE: &str = "tlsHandshake";
/// Ollama's address refused the connection (see [`AppError::network_code`]).
pub const OLLAMA_UNREACHABLE: &str = "ollamaUnreachable";
const MODEL_MISSING: &str = "modelMissing";
const NOT_CHAT_MODEL: &str = "notChatModel";
const BROWSER_LOCKED: &str = "browserLocked";
/// The prompt did not fit the model's context window.
const INPUT_TOO_LONG_CODE: &str = "inputTooLong";
/// What the user is told when `truncate: false` made Ollama refuse an oversized prompt.
pub const INPUT_TOO_LONG: &str = "The text is too long for this model's context window. Send less \
                                  of it, or choose a model with a larger context.";

/// Every `code` an error can carry; `ERROR_CODES` in ipc.ts must list exactly these.
pub const ERROR_CODES: [&str; 8] = [
    MODEL_MISSING,
    NOT_CHAT_MODEL,
    OLLAMA_UNREACHABLE,
    HOST_NOT_FOUND,
    TLS_CERTIFICATE,
    TLS_HANDSHAKE,
    BROWSER_LOCKED,
    INPUT_TOO_LONG_CODE,
];

/// A rejected certificate or a refused handshake comes from the peer's own configuration.
fn tls_failure_code(root_cause: &str) -> Option<&'static str> {
    let message = root_cause.to_ascii_lowercase();
    if message.contains("invalid peer certificate") || message.contains("certificate verify failed")
    {
        return Some(TLS_CERTIFICATE);
    }
    if message.contains("received fatal alert") || message.contains("protocol version") {
        return Some(TLS_HANDSHAKE);
    }
    None
}

/// Whether the root cause is a TLS failure at all; [`tls_failure_code`] picks out the ones
/// that are permanent. Link health labels with this, so both sides agree on what TLS is.
pub(crate) fn is_tls_failure(root_cause: &str) -> bool {
    let message = root_cause.to_ascii_lowercase();
    tls_failure_code(&message).is_some()
        || ["certificate", "tls", "ssl", "handshake"]
            .iter()
            .any(|needle| message.contains(needle))
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Config(String),
    /// The configured model is not installed on the Ollama server. Serialized as kind `config`
    /// with `code: "modelMissing"` and `model`, so the renderer can show a translated sentence.
    #[error("Model \"{model}\" is not installed on the Ollama server. Pull it with `ollama pull {model}` or choose another model.")]
    ModelMissing { model: String },
    /// The configured model cannot chat (an embedding model). Kind `config`, `code: "notChatModel"`.
    #[error("Model \"{model}\" does not support chat; it is probably an embedding model. Choose a chat model.")]
    NotChatModel { model: String },
    /// A value the user typed or the renderer sent is not valid (URL, file name, upload, id).
    /// `Config` is reserved for a missing or invalid AI provider configuration.
    #[error("{0}")]
    InvalidInput(String),
    #[error("{message}")]
    Network {
        message: String,
        status: Option<u16>,
        /// Set when this failure has its own translated sentence in the renderer
        /// (see [`AppError::network_code`]).
        code: Option<&'static str>,
    },
    #[error("{0}")]
    Timeout(String),
    #[error("{0}")]
    BlockedAddress(String),
    #[error("{message}")]
    Provider {
        message: String,
        status: Option<u16>,
    },
    #[error("{0}")]
    Parse(String),
    #[error("{0}")]
    Keyring(String),
    #[error("{0}")]
    Storage(String),
    /// A browser profile file another program holds open. Kind `storage`,
    /// `code: "browserLocked"`, so the renderer can say which browser to close.
    #[error("{0}")]
    BrowserLocked(String),
    #[error("{0}")]
    NotFound(String),
    /// A request cancelled via `cancel_request`. Cancelled health scans resolve with partial
    /// results instead.
    #[error("{0}")]
    Cancelled(String),
    #[error("{0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Config(_) | AppError::ModelMissing { .. } | AppError::NotChatModel { .. } => {
                "config"
            }
            AppError::InvalidInput(_) => "invalidInput",
            AppError::Network { .. } => "network",
            AppError::Timeout(_) => "timeout",
            AppError::BlockedAddress(_) => "blockedAddress",
            AppError::Provider { .. } => "provider",
            AppError::Parse(_) => "parse",
            AppError::Keyring(_) => "keyring",
            AppError::Storage(_) | AppError::BrowserLocked(_) => "storage",
            AppError::NotFound(_) => "notFound",
            AppError::Cancelled(_) => "cancelled",
            AppError::Internal(_) => "internal",
        }
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            AppError::Network { status, .. } | AppError::Provider { status, .. } => *status,
            _ => None,
        }
    }

    /// Machine-readable refinement of `kind` (`AppErrorPayload.code` in ipcTypes.ts).
    pub fn code(&self) -> Option<&'static str> {
        match self {
            AppError::ModelMissing { .. } => Some(MODEL_MISSING),
            AppError::NotChatModel { .. } => Some(NOT_CHAT_MODEL),
            AppError::BrowserLocked(_) => Some(BROWSER_LOCKED),
            AppError::Network { code, .. } => *code,
            AppError::InvalidInput(message) if message == INPUT_TOO_LONG => {
                Some(INPUT_TOO_LONG_CODE)
            }
            _ => None,
        }
    }

    /// Model the error is about, when `code` names one.
    pub fn model(&self) -> Option<&str> {
        match self {
            AppError::ModelMissing { model } | AppError::NotChatModel { model } => Some(model),
            _ => None,
        }
    }

    pub fn config(message: impl Into<String>) -> Self {
        AppError::Config(message.into())
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        AppError::InvalidInput(message.into())
    }

    pub fn network(message: impl Into<String>) -> Self {
        AppError::Network {
            message: message.into(),
            status: None,
            code: None,
        }
    }

    /// A network failure the renderer can name exactly, e.g. [`OLLAMA_UNREACHABLE`]; `kind`
    /// stays `network` so retry handling is unchanged. `code` must be one of [`ERROR_CODES`].
    pub fn network_code(message: impl Into<String>, code: &'static str) -> Self {
        debug_assert!(ERROR_CODES.contains(&code), "unknown error code {code}");
        AppError::Network {
            message: message.into(),
            status: None,
            code: Some(code),
        }
    }

    pub fn provider(message: impl Into<String>, status: Option<u16>) -> Self {
        AppError::Provider {
            message: message.into(),
            status,
        }
    }

    pub fn storage(message: impl Into<String>) -> Self {
        AppError::Storage(message.into())
    }

    pub fn browser_locked(message: impl Into<String>) -> Self {
        AppError::BrowserLocked(message.into())
    }

    pub fn cancelled() -> Self {
        AppError::Cancelled("The request was cancelled.".to_string())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        AppError::Internal(message.into())
    }

    /// Maps a reqwest error to an `AppError`, prefixing the message with `context`.
    pub fn from_reqwest(context: &str, error: &reqwest::Error) -> Self {
        if let Some(blocked) = find_source::<BlockedAddressError>(error) {
            return AppError::BlockedAddress(blocked.to_string());
        }
        if error.is_timeout() {
            return AppError::Timeout(format!("{context}: the request timed out."));
        }
        if let Some(dns) = find_source::<DnsLookupError>(error) {
            let message = format!("{context}: {dns}");
            if dns.not_found {
                return AppError::network_code(message, HOST_NOT_FOUND);
            }
            return AppError::network(message);
        }
        if error.is_decode() {
            return AppError::Parse(format!("{context}: the response could not be decoded."));
        }
        if error.is_redirect() {
            return AppError::network(format!("{context}: too many or invalid redirects."));
        }
        let root_cause = root_cause_message(error);
        // Classified before truncation, so a long chain cannot hide the phrase that names the cause.
        let code = tls_failure_code(&root_cause);
        let detail = truncate_chars(&root_cause, MAX_ERROR_BODY_CHARS);
        if error.is_connect() {
            return AppError::Network {
                message: format!("{context}: could not connect ({detail})."),
                status: None,
                code,
            };
        }
        AppError::Network {
            message: format!("{context}: {detail}"),
            status: error.status().map(|s| s.as_u16()),
            code,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let status = self.status();
        let code = self.code();
        let model = self.model();
        let len = 2
            + usize::from(status.is_some())
            + usize::from(code.is_some())
            + usize::from(model.is_some());
        let mut state = serializer.serialize_struct("AppError", len)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        if let Some(status) = status {
            state.serialize_field("status", &status)?;
        }
        if let Some(code) = code {
            state.serialize_field("code", code)?;
        }
        if let Some(model) = model {
            state.serialize_field("model", model)?;
        }
        state.end()
    }
}

/// Fixed messages for a converted `std::io::Error`; the OS text is localized and goes to the log.
pub const IO_NOT_FOUND_MESSAGE: &str = "A file or folder MYNK needs could not be found.";
pub const IO_PERMISSION_MESSAGE: &str = "Access to a file or folder MYNK needs was denied.";
pub const IO_FAILED_MESSAGE: &str = "A file or folder MYNK needs could not be read or written.";

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        log::warn!("file system error ({:?}): {error}", error.kind());
        match error.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound(IO_NOT_FOUND_MESSAGE.to_string()),
            std::io::ErrorKind::PermissionDenied => AppError::storage(IO_PERMISSION_MESSAGE),
            _ => AppError::storage(IO_FAILED_MESSAGE),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        AppError::Parse(error.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        AppError::Internal(error.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(error: keyring::Error) -> Self {
        AppError::Keyring(format!("Credential store error: {error}"))
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        AppError::Storage(format!("Database error: {error}"))
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(error: tokio::task::JoinError) -> Self {
        AppError::Internal(format!("Background task failed: {error}"))
    }
}

/// Walks the `source()` chain looking for an error of type `T`.
pub fn find_source<'a, T: StdError + 'static>(
    error: &'a (dyn StdError + 'static),
) -> Option<&'a T> {
    let mut current: Option<&(dyn StdError + 'static)> = Some(error);
    while let Some(err) = current {
        if let Some(found) = err.downcast_ref::<T>() {
            return Some(found);
        }
        current = err.source();
    }
    None
}

/// Message of the innermost error in the chain (usually the most specific one).
pub fn root_cause_message(error: &(dyn StdError + 'static)) -> String {
    let mut current: &(dyn StdError + 'static) = error;
    while let Some(next) = current.source() {
        current = next;
    }
    current.to_string()
}

/// Truncates to `max` characters (not bytes), appending an ellipsis when cut.
pub fn truncate_chars(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_errors_carry_a_fixed_message_instead_of_the_os_text() {
        let cases = [
            (
                std::io::ErrorKind::NotFound,
                "notFound",
                IO_NOT_FOUND_MESSAGE,
            ),
            (
                std::io::ErrorKind::PermissionDenied,
                "storage",
                IO_PERMISSION_MESSAGE,
            ),
            (std::io::ErrorKind::Other, "storage", IO_FAILED_MESSAGE),
        ];
        for (kind, expected_kind, message) in cases {
            let error =
                AppError::from(std::io::Error::new(kind, "Erişim engellendi. (os error 5)"));
            assert_eq!(error.kind(), expected_kind);
            assert_eq!(error.to_string(), message);
        }
        let raw = AppError::from(std::io::Error::from_raw_os_error(5));
        assert!(!raw.to_string().contains("os error"), "{raw}");
    }

    #[test]
    fn serializes_kind_message_and_optional_status() {
        let value = serde_json::to_value(AppError::provider("bad key", Some(401)))
            .expect("serialize provider error");
        assert_eq!(
            value,
            serde_json::json!({ "kind": "provider", "message": "bad key", "status": 401 })
        );

        let value = serde_json::to_value(AppError::config("missing model"))
            .expect("serialize config error");
        assert_eq!(
            value,
            serde_json::json!({ "kind": "config", "message": "missing model" })
        );

        let value = serde_json::to_value(AppError::invalid_input("URL cannot be empty."))
            .expect("serialize invalid input error");
        assert_eq!(
            value,
            serde_json::json!({ "kind": "invalidInput", "message": "URL cannot be empty." })
        );
    }

    #[test]
    fn model_errors_serialize_as_config_with_a_code_and_the_model() {
        let value = serde_json::to_value(AppError::ModelMissing {
            model: "qwen3:8b".into(),
        })
        .expect("serialize");
        assert_eq!(value["kind"], "config");
        assert_eq!(value["code"], "modelMissing");
        assert_eq!(value["model"], "qwen3:8b");
        assert!(value.get("status").is_none());
        assert!(value["message"]
            .as_str()
            .unwrap_or_default()
            .starts_with("Model \"qwen3:8b\" is not installed"));

        let value = serde_json::to_value(AppError::NotChatModel {
            model: "bge-m3".into(),
        })
        .expect("serialize");
        assert_eq!(value["kind"], "config");
        assert_eq!(value["code"], "notChatModel");

        let value = serde_json::to_value(AppError::browser_locked(
            "Could not copy the Firefox bookmarks database. Close Firefox and try again.",
        ))
        .expect("serialize");
        assert_eq!(value["kind"], "storage");
        assert_eq!(value["code"], "browserLocked");
        assert!(value.get("model").is_none(), "{value}");

        let plain = serde_json::to_value(AppError::config("x")).expect("serialize");
        assert!(plain.get("code").is_none());
        let storage = serde_json::to_value(AppError::storage("x")).expect("serialize");
        assert!(storage.get("code").is_none());
    }

    #[test]
    fn an_unreachable_ollama_keeps_the_network_kind_and_names_itself() {
        let value = serde_json::to_value(AppError::network_code(
            "Could not connect to Ollama at http://127.0.0.1:11434. Make sure Ollama is running.",
            OLLAMA_UNREACHABLE,
        ))
        .expect("serialize");
        assert_eq!(value["kind"], "network");
        assert_eq!(value["code"], "ollamaUnreachable");
        assert!(value.get("model").is_none(), "{value}");
        assert!(value.get("status").is_none(), "{value}");
        assert!(value["message"]
            .as_str()
            .unwrap_or_default()
            .contains("127.0.0.1:11434"));

        let plain = serde_json::to_value(AppError::network("offline")).expect("serialize");
        assert_eq!(
            plain,
            serde_json::json!({ "kind": "network", "message": "offline" })
        );
    }

    #[test]
    fn permanent_network_failures_carry_a_code_so_they_are_not_retried() {
        for message in [
            "invalid peer certificate: NotValidForName",
            "invalid peer certificate: UnknownIssuer",
            "invalid peer certificate: Expired",
        ] {
            assert_eq!(
                tls_failure_code(message),
                Some(TLS_CERTIFICATE),
                "{message}"
            );
        }
        for message in [
            "received fatal alert: HandshakeFailure",
            "received fatal alert: ProtocolVersion",
            "peer doesn't support any known protocol versions",
        ] {
            assert_eq!(tls_failure_code(message), Some(TLS_HANDSHAKE), "{message}");
        }
        for message in [
            "connection reset by peer (os error 10054)",
            "operation timed out",
            "tcp connect error: connection refused",
        ] {
            assert_eq!(tls_failure_code(message), None, "{message}");
            assert!(!is_tls_failure(message), "{message}");
        }
        // Every permanent TLS failure is a TLS failure, and a transient one is labeled too.
        for message in [
            "invalid peer certificate: Expired",
            "received fatal alert: ProtocolVersion",
            "peer doesn't support any known protocol versions",
            "tls handshake eof",
        ] {
            assert!(is_tls_failure(message), "{message}");
        }
        assert_eq!(tls_failure_code("tls handshake eof"), None);

        let value = serde_json::to_value(AppError::network_code(
            "Could not fetch the page: could not connect (invalid peer certificate: Expired).",
            TLS_CERTIFICATE,
        ))
        .expect("serialize");
        assert_eq!(value["kind"], "network");
        assert_eq!(value["code"], "tlsCertificate");
    }

    #[test]
    fn a_missing_host_is_named_but_a_failed_lookup_is_not() {
        let not_found = DnsLookupError {
            host: "example.invalid".into(),
            not_found: true,
            detail: "no such host".into(),
        };
        let value = serde_json::to_value(AppError::network_code(
            not_found.to_string(),
            HOST_NOT_FOUND,
        ))
        .expect("serialize");
        assert_eq!(value["code"], "hostNotFound");
        assert_eq!(
            value["message"],
            "the host example.invalid could not be found"
        );

        // A lookup that failed for another reason may well succeed on the next attempt.
        let failed = DnsLookupError {
            host: "example.com".into(),
            not_found: false,
            detail: "server misbehaving".into(),
        };
        let value = serde_json::to_value(AppError::network(failed.to_string())).expect("serialize");
        assert!(value.get("code").is_none(), "{value}");
    }

    #[test]
    fn truncates_by_chars() {
        assert_eq!(truncate_chars("abc", 5), "abc");
        assert_eq!(truncate_chars("çğüşöı", 3), "çğü…");
    }
}
