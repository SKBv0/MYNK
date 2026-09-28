//! LLM providers (Ollama, OpenRouter) behind the [`Provider`] enum.

pub mod json;
pub mod ollama;
pub mod openrouter;
pub mod stream;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::error::{truncate_chars, AppError, AppResult};
use crate::settings::{self, AIProvider, PersistedSettings};
use crate::state::AppState;
use ollama::OllamaProvider;
use openrouter::OpenRouterProvider;
use stream::{DeltaSink, Usage};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

impl Message {
    pub fn new(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
        }
    }
}

/// `ChatTurn` in ipcTypes.ts. Only user/assistant roles are accepted from the renderer.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TurnRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatTurn {
    pub role: TurnRole,
    pub content: String,
}

#[derive(Debug, Clone)]
pub enum ResponseFormat {
    Text,
    /// Any JSON object (Ollama `format: "json"`, OpenRouter `json_object`).
    JsonObject,
    /// JSON schema (Ollama structured outputs); OpenRouter falls back to `json_object`.
    JsonSchema(serde_json::Value),
}

#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub messages: Vec<Message>,
    pub format: ResponseFormat,
    pub temperature: f32,
    pub max_tokens: Option<u32>,
    /// Disables the thinking channel for a plain-text request; structured formats never think.
    pub disable_thinking: bool,
}

/// `ModelInfo` in ipcTypes.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    /// USD per million prompt tokens (OpenRouter pricing), when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_price_per_m_tok: Option<f64>,
    /// USD per million completion tokens (OpenRouter pricing), when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_price_per_m_tok: Option<f64>,
    /// `Some(true)` for an embedding-only model (Ollama), which cannot be used for chat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<bool>,
}

pub enum Provider {
    Ollama(OllamaProvider),
    OpenRouter(OpenRouterProvider),
}

impl Provider {
    /// Human-readable provider name for messages.
    pub fn label(&self) -> &'static str {
        match self {
            Provider::Ollama(p) => p.label(),
            Provider::OpenRouter(p) => p.label(),
        }
    }

    pub fn model(&self) -> &str {
        match self {
            Provider::Ollama(p) => p.model(),
            Provider::OpenRouter(p) => p.model(),
        }
    }

    /// Runs a non-streaming completion; reasoning is stripped and an empty answer is an error.
    pub async fn complete(&self, request: &CompletionRequest) -> AppResult<String> {
        let raw = self.complete_raw(request).await?;
        let cleaned = strip_reasoning(&raw);
        if cleaned.is_empty() {
            return Err(AppError::provider(
                format!("{} returned an empty response.", self.label()),
                None,
            ));
        }
        Ok(cleaned)
    }

    /// Raw completion without the empty-output check (used by the connection test).
    pub async fn complete_raw(&self, request: &CompletionRequest) -> AppResult<String> {
        match self {
            Provider::Ollama(p) => p.complete_raw(request).await,
            Provider::OpenRouter(p) => p.complete_raw(request).await,
        }
    }

    /// Streaming completion; text deltas go to `sink`.
    /// Cancelling `token` aborts with `AppError::Cancelled`.
    pub async fn stream(
        &self,
        request: &CompletionRequest,
        token: &CancellationToken,
        sink: &mut DeltaSink<'_>,
    ) -> AppResult<Option<Usage>> {
        match self {
            Provider::Ollama(p) => p.stream(request, token, sink).await,
            Provider::OpenRouter(p) => p.stream(request, token, sink).await,
        }
    }
}

/// Max characters kept from a single history turn.
pub const MAX_HISTORY_TURN_CHARS: usize = 8_000;
/// Max characters kept from the whole history.
pub const MAX_HISTORY_CHARS: usize = 60_000;

/// Builds `[system?, ...last `max_history` turns, user prompt]`, oldest turns dropped first
/// once the total exceeds `MAX_HISTORY_CHARS`.
pub fn build_messages(
    system: Option<&str>,
    history: &[ChatTurn],
    prompt: &str,
    max_history: usize,
) -> Vec<Message> {
    let start = history.len().saturating_sub(max_history);
    let mut recent: Vec<Message> = Vec::with_capacity(history.len() - start);
    let mut budget = MAX_HISTORY_CHARS;
    for turn in history[start..].iter().rev() {
        let content = turn.content.trim();
        if content.is_empty() {
            continue;
        }
        let content = truncate_chars(content, MAX_HISTORY_TURN_CHARS);
        let Some(remaining) = budget.checked_sub(content.chars().count()) else {
            break;
        };
        budget = remaining;
        let role = match turn.role {
            TurnRole::User => Role::User,
            TurnRole::Assistant => Role::Assistant,
        };
        recent.push(Message::new(role, content));
    }
    recent.reverse();

    let mut messages = Vec::with_capacity(recent.len() + 2);
    if let Some(system) = system.map(str::trim).filter(|s| !s.is_empty()) {
        messages.push(Message::new(Role::System, system));
    }
    messages.append(&mut recent);
    messages.push(Message::new(Role::User, prompt));
    messages
}

/// Removes `<think>…</think>` blocks emitted by reasoning models and trims the result. Same rule
/// as the streamed path, so a whole answer and a streamed one read the same.
pub fn strip_reasoning(text: &str) -> String {
    let mut filter = stream::ThinkFilter::default();
    let mut out = filter.push(text);
    out.push_str(&filter.finish());
    out.trim().to_string()
}

/// Builds the provider described by `settings`, validating model and API key.
pub async fn provider_from_settings(
    state: &AppState,
    settings: &PersistedSettings,
) -> AppResult<Provider> {
    match settings.provider {
        AIProvider::Ollama => {
            let model = settings.ollama_model.trim();
            if model.is_empty() {
                return Err(AppError::config(
                    "Select an Ollama model in Settings before using AI features.",
                ));
            }
            Ok(Provider::Ollama(OllamaProvider::new(
                state.http.ollama(settings.allow_private_network).clone(),
                &settings.ollama_base_url,
                settings.allow_private_network,
                model,
            )?))
        }
        AIProvider::Openrouter => {
            let model = settings.openrouter_model.trim();
            if model.is_empty() {
                return Err(AppError::config(
                    "Enter an OpenRouter model id in Settings before using AI features.",
                ));
            }
            let api_key = settings::api_key().await?.ok_or_else(|| {
                AppError::config("The OpenRouter API key is not set. Add it in Settings.")
            })?;
            Ok(Provider::OpenRouter(OpenRouterProvider::new(
                state.http.openrouter().clone(),
                model,
                api_key,
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: TurnRole, content: &str) -> ChatTurn {
        ChatTurn {
            role,
            content: content.to_string(),
        }
    }

    #[test]
    fn builds_messages_with_history_limit() {
        let history: Vec<ChatTurn> = (0..30)
            .map(|i| {
                turn(
                    if i % 2 == 0 {
                        TurnRole::User
                    } else {
                        TurnRole::Assistant
                    },
                    &format!("m{i}"),
                )
            })
            .collect();
        let messages = build_messages(Some("sys"), &history, "now", 20);
        assert_eq!(messages.len(), 22);
        assert_eq!(messages[0].role, Role::System);
        assert_eq!(messages[1].content, "m10");
        assert_eq!(messages[21].content, "now");
        assert_eq!(messages[21].role, Role::User);
    }

    #[test]
    fn history_is_capped_per_turn_and_in_total() {
        let long = "x".repeat(MAX_HISTORY_TURN_CHARS * 2);
        let history: Vec<ChatTurn> = (0..40)
            .map(|i| {
                turn(
                    if i % 2 == 0 {
                        TurnRole::User
                    } else {
                        TurnRole::Assistant
                    },
                    &format!("{i}:{long}"),
                )
            })
            .collect();
        let messages = build_messages(Some("sys"), &history, "now", 40);

        let kept: Vec<&Message> = messages[1..messages.len() - 1].iter().collect();
        assert!(!kept.is_empty(), "some history must survive");
        assert!(kept
            .iter()
            .all(|m| m.content.chars().count() <= MAX_HISTORY_TURN_CHARS + 1));
        let total: usize = kept.iter().map(|m| m.content.chars().count()).sum();
        assert!(total <= MAX_HISTORY_CHARS, "total {total}");
        assert!(kept[kept.len() - 1].content.starts_with("39:"));
        assert!(!kept[0].content.starts_with("0:"));
        assert_eq!(messages[0].role, Role::System);
        assert_eq!(messages[messages.len() - 1].content, "now");
    }

    #[test]
    fn strips_think_blocks() {
        assert_eq!(
            strip_reasoning("<think>hmm</think>\n{\"a\":1}"),
            "{\"a\":1}"
        );
        assert_eq!(strip_reasoning("plain"), "plain");
        assert_eq!(strip_reasoning("x<think>unterminated"), "x");
        assert_eq!(strip_reasoning("the plan</think>the answer"), "the answer");
        assert_eq!(strip_reasoning("plan</think>a<think>more</think>b"), "ab");
        assert_eq!(strip_reasoning("x<think>y</think>z</think>w"), "xw");
    }

    #[test]
    fn streamed_and_whole_answers_strip_alike() {
        for text in [
            "<think>hmm</think>\n{\"a\":1}",
            "x<think>y</think>z<think>w</think>",
            "a <thi",
            "a<think>only reasoning",
            "  plain answer  ",
        ] {
            let mut filter = stream::ThinkFilter::default();
            let mut streamed: String = text.chars().map(|c| filter.push(&c.to_string())).collect();
            streamed.push_str(&filter.finish());
            assert_eq!(strip_reasoning(text), streamed.trim(), "{text}");
        }
    }

    #[test]
    fn rejects_unknown_roles() {
        let parsed: Result<ChatTurn, _> =
            serde_json::from_str(r#"{"role":"system","content":"x"}"#);
        assert!(parsed.is_err());
    }
}
