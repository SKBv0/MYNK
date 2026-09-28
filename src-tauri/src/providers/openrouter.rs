//! OpenRouter provider (OpenAI-compatible `/chat/completions`, `/models`).

use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::stream::{self, DeltaSink, Usage, STREAM_IDLE_TIMEOUT, STREAM_TOTAL_TIMEOUT};
use super::{CompletionRequest, ModelInfo, ResponseFormat};
use crate::error::{truncate_chars, AppError, AppResult, MAX_ERROR_BODY_CHARS};
use crate::http::body::{read_limited, Overflow, API_BODY_LIMIT};

const BASE_URL: &str = "https://openrouter.ai/api/v1";
const REFERER: &str = "https://github.com/SKBv0/mynk";
const TITLE: &str = "MYNK Desktop";

/// No `Debug` derive: the struct holds the API key.
pub struct OpenRouterProvider {
    client: Client,
    model: String,
    api_key: String,
    /// Always `BASE_URL` in production; overridable so integration tests can talk to a local
    /// stand-in server instead of the real API.
    base_url: String,
    /// Longest silence tolerated between two stream chunks; `STREAM_IDLE_TIMEOUT` unless a test
    /// shortens it with [`OpenRouterProvider::with_stream_idle_timeout`].
    stream_idle_timeout: Duration,
}

/// Pulls `error.message` out of an OpenAI-style error body.
fn error_message(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .map(|s| truncate_chars(s, MAX_ERROR_BODY_CHARS))
}

/// [`error_message`] over a raw body.
fn json_error_message(raw: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(raw)
        .ok()
        .as_ref()
        .and_then(error_message)
}

/// What to show after the status: the body's `error.message`, else the raw text, clipped.
fn error_detail(raw: &[u8]) -> String {
    json_error_message(raw)
        .unwrap_or_else(|| truncate_chars(&String::from_utf8_lossy(raw), MAX_ERROR_BODY_CHARS))
}

/// Maps an HTTP status to a user-facing error (401/402/429 etc.).
pub fn status_error(status: u16, detail: Option<&str>, model: &str) -> AppError {
    let detail = detail.map(|d| format!(" {d}")).unwrap_or_default();
    let message = match status {
        401 => "OpenRouter rejected the API key (HTTP 401). Check the key in Settings.".to_string(),
        402 => "Your OpenRouter account has insufficient credits (HTTP 402).".to_string(),
        403 => format!("OpenRouter refused the request (HTTP 403).{detail}"),
        404 => format!("OpenRouter model \"{model}\" was not found (HTTP 404)."),
        408 => "OpenRouter timed out waiting for the model (HTTP 408).".to_string(),
        429 => "OpenRouter rate limit reached (HTTP 429). Try again in a moment.".to_string(),
        502 | 503 => {
            format!("The OpenRouter model provider is unavailable (HTTP {status}).{detail}")
        }
        _ => format!("OpenRouter returned HTTP {status}.{detail}"),
    };
    AppError::provider(message, Some(status))
}

/// Extracts assistant text from a chat completion response.
pub fn parse_completion_text(value: &Value) -> Option<String> {
    let content = value.pointer("/choices/0/message/content");
    if let Some(text) = content.and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(parts) = content.and_then(Value::as_array) {
        // Fragments of one message: a separator would corrupt JSON split across them.
        let text: String = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect();
        return Some(text);
    }
    value
        .pointer("/choices/0/text")
        .and_then(Value::as_str)
        .map(str::to_string)
}

impl OpenRouterProvider {
    pub fn new(client: Client, model: &str, api_key: String) -> Self {
        Self::with_base_url(client, model, api_key, BASE_URL)
    }

    /// Same as [`OpenRouterProvider::new`] with an explicit API root (tests only).
    pub fn with_base_url(client: Client, model: &str, api_key: String, base_url: &str) -> Self {
        Self {
            client,
            model: model.to_string(),
            api_key,
            base_url: base_url.trim_end_matches('/').to_string(),
            stream_idle_timeout: STREAM_IDLE_TIMEOUT,
        }
    }

    /// Overrides the idle timeout for this instance only (tests run in parallel).
    #[must_use]
    pub fn with_stream_idle_timeout(mut self, timeout: Duration) -> Self {
        self.stream_idle_timeout = timeout;
        self
    }

    fn chat_body(&self, request: &CompletionRequest, stream: bool) -> Value {
        let mut body = json!({
            "model": self.model,
            "messages": request.messages,
            "temperature": request.temperature,
        });
        if let Some(max_tokens) = request.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        if matches!(
            request.format,
            ResponseFormat::JsonObject | ResponseFormat::JsonSchema(_)
        ) {
            body["response_format"] = json!({ "type": "json_object" });
        }
        if stream {
            body["stream"] = json!(true);
            // Token counts (and cost) in the final chunk, for the cost indicator.
            body["usage"] = json!({ "include": true });
        }
        body
    }

    fn post(&self, body: &Value) -> reqwest::RequestBuilder {
        self.client
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .header("HTTP-Referer", REFERER)
            .header("X-Title", TITLE)
            .json(body)
    }

    /// Streaming `/chat/completions` (SSE).
    pub async fn stream(
        &self,
        request: &CompletionRequest,
        token: &CancellationToken,
        sink: &mut DeltaSink<'_>,
    ) -> AppResult<Option<Usage>> {
        let body = self.chat_body(request, true);
        let send = self
            .post(&body)
            .header(ACCEPT, "text/event-stream")
            .timeout(STREAM_TOTAL_TIMEOUT)
            .send();
        let response = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(AppError::cancelled()),
            response = send => response
                .map_err(|e| AppError::from_reqwest("OpenRouter request failed", &e))?,
        };
        let status = response.status();
        if !status.is_success() {
            let raw = read_limited(
                response,
                API_BODY_LIMIT,
                Overflow::Truncate,
                "OpenRouter response",
            )
            .await
            .unwrap_or_default();
            let detail = error_detail(&raw);
            return Err(status_error(status.as_u16(), Some(&detail), &self.model));
        }
        let model = self.model.clone();
        stream::drive(
            response,
            token,
            "OpenRouter",
            self.stream_idle_timeout,
            move |line| stream::parse_openrouter_line(line, &model),
            sink,
        )
        .await
    }
}

impl OpenRouterProvider {
    pub fn label(&self) -> &'static str {
        "OpenRouter"
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Non-streaming completion, reasoning left in; [`super::Provider`] is what cleans it.
    pub async fn complete_raw(&self, request: &CompletionRequest) -> AppResult<String> {
        let body = self.chat_body(request, false);
        let response = self
            .post(&body)
            .send()
            .await
            .map_err(|e| AppError::from_reqwest("OpenRouter request failed", &e))?;

        let status = response.status();
        let raw = read_limited(
            response,
            API_BODY_LIMIT,
            Overflow::Error,
            "OpenRouter response",
        )
        .await?;
        let parsed: Option<Value> = serde_json::from_slice(&raw).ok();

        if !status.is_success() {
            let detail = error_detail(&raw);
            return Err(status_error(status.as_u16(), Some(&detail), &self.model));
        }

        let parsed = parsed.ok_or_else(|| {
            AppError::Parse("OpenRouter response was not valid JSON.".to_string())
        })?;

        // OpenRouter can report upstream failures with HTTP 200 and an `error` object.
        if parsed.get("error").is_some() {
            let code = parsed
                .pointer("/error/code")
                .and_then(Value::as_u64)
                .and_then(|c| u16::try_from(c).ok())
                .unwrap_or(502);
            return Err(status_error(
                code,
                error_message(&parsed).as_deref(),
                &self.model,
            ));
        }

        parse_completion_text(&parsed).ok_or_else(|| {
            AppError::Parse("OpenRouter response did not include text output.".to_string())
        })
    }
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<RawModel>,
}

#[derive(Debug, Deserialize)]
struct RawModel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context_length: Option<u64>,
    #[serde(default)]
    pricing: Option<RawPricing>,
}

/// OpenRouter prices are USD per token, usually as decimal strings ("0.000003").
#[derive(Debug, Deserialize)]
struct RawPricing {
    #[serde(default)]
    prompt: Option<Value>,
    #[serde(default)]
    completion: Option<Value>,
}

/// USD/token (string or number) → USD per million tokens. Negative values (OpenRouter uses
/// "-1" for variable-price routers) and garbage yield `None`.
pub fn price_per_million(value: Option<&Value>) -> Option<f64> {
    let per_token = match value? {
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    if !per_token.is_finite() || per_token < 0.0 {
        return None;
    }
    // Round to 6 decimals to hide binary float noise (0.000003 * 1e6 = 2.9999999999999996).
    Some((per_token * 1_000_000.0 * 1_000_000.0).round() / 1_000_000.0)
}

/// Lists OpenRouter models (`GET /models`, public endpoint).
pub async fn list_models(client: &Client) -> AppResult<Vec<ModelInfo>> {
    list_models_at(client, BASE_URL).await
}

/// [`list_models`] against an explicit API root (tests only).
pub async fn list_models_at(client: &Client, base_url: &str) -> AppResult<Vec<ModelInfo>> {
    let base_url = base_url.trim_end_matches('/');
    let response = client
        .get(format!("{base_url}/models"))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| AppError::from_reqwest("Could not reach OpenRouter", &e))?;
    let status = response.status();
    let raw = read_limited(
        response,
        API_BODY_LIMIT * 2,
        Overflow::Error,
        "OpenRouter model list",
    )
    .await?;
    if !status.is_success() {
        let detail = json_error_message(&raw);
        return Err(status_error(status.as_u16(), detail.as_deref(), ""));
    }
    let parsed: ModelsResponse = serde_json::from_slice(&raw)
        .map_err(|e| AppError::Parse(format!("Invalid OpenRouter model list: {e}")))?;
    let mut models: Vec<ModelInfo> = parsed
        .data
        .into_iter()
        .map(|m| RawModel {
            id: m.id.trim().to_string(),
            ..m
        })
        // The id is what a request and an error message carry, so it has to be plain text.
        .filter(|m| crate::util::is_plain_model_name(&m.id))
        .map(|m| ModelInfo {
            name: m
                .name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| m.id.clone()),
            id: m.id,
            size_bytes: None,
            context_length: m.context_length,
            prompt_price_per_m_tok: price_per_million(
                m.pricing.as_ref().and_then(|p| p.prompt.as_ref()),
            ),
            completion_price_per_m_tok: price_per_million(
                m.pricing.as_ref().and_then(|p| p.completion.as_ref()),
            ),
            embedding: None,
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_http_statuses_to_provider_errors() {
        let err = status_error(401, None, "m");
        assert_eq!(err.kind(), "provider");
        assert_eq!(err.status(), Some(401));
        assert!(err.to_string().contains("API key"));
        assert!(status_error(402, None, "m").to_string().contains("credits"));
        assert!(status_error(429, None, "m")
            .to_string()
            .contains("rate limit"));
    }

    #[test]
    fn converts_per_token_prices_to_per_million() {
        assert_eq!(price_per_million(Some(&json!("0.000003"))), Some(3.0));
        assert_eq!(price_per_million(Some(&json!("0"))), Some(0.0));
        assert_eq!(price_per_million(Some(&json!(0.0000005))), Some(0.5));
        assert_eq!(price_per_million(Some(&json!("-1"))), None);
        assert_eq!(price_per_million(Some(&json!("abc"))), None);
        assert_eq!(price_per_million(None), None);
    }

    #[test]
    fn parses_completion_shapes() {
        let plain = json!({ "choices": [{ "message": { "content": "hi" } }] });
        assert_eq!(parse_completion_text(&plain).as_deref(), Some("hi"));
        let parts = json!({ "choices": [{ "message": { "content": [{ "text": "{\"a\":" }, { "text": "1}" }] } }] });
        assert_eq!(parse_completion_text(&parts).as_deref(), Some("{\"a\":1}"));
        assert_eq!(parse_completion_text(&json!({})), None);
    }
}
