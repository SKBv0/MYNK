use std::future::Future;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};

use crate::analyze::{self, AnalyzeResult, Lang};
use crate::error::{AppError, AppResult};
use crate::providers::stream::Usage;
use crate::providers::{self, ChatTurn, CompletionRequest, ResponseFormat};
use crate::settings;
use crate::state::AppState;

const MAX_HISTORY_TURNS: usize = 20;
const MAX_PROMPT_CHARS: usize = 200_000;

const DEFAULT_CHAT_SYSTEM_PROMPT: &str = "You are MYNK, the user's personal bookmark \
     assistant. Be concise. Use only the context the user provides; if the answer is not in \
     it, say so plainly. Never invent bookmarks, sources or facts.";

/// `ChatRequest` in ipcTypes.ts.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub prompt: String,
    #[serde(default)]
    pub history: Vec<ChatTurn>,
    #[serde(default)]
    pub lang: Lang,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub json_mode: bool,
}

/// `ChatStreamEvent` in ipcTypes.ts (sent over the `chat_stream` channel).
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatStreamEvent {
    Delta {
        text: String,
    },
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
    },
    Error {
        error: AppError,
    },
}

const MAX_REQUEST_ID_CHARS: usize = 128;

fn validate_request_id(request_id: &str) -> AppResult<()> {
    if request_id.trim().is_empty() || request_id.chars().count() > MAX_REQUEST_ID_CHARS {
        return Err(AppError::invalid_input("Invalid request id."));
    }
    Ok(())
}

/// Runs `work` as a cancellable request when a request id is given (`cancel_request`).
/// Cancelling drops the future, which closes any in-flight HTTP connection.
async fn cancellable<T>(
    state: &AppState,
    request_id: Option<String>,
    work: impl Future<Output = AppResult<T>>,
) -> AppResult<T> {
    let Some(request_id) = request_id else {
        return work.await;
    };
    validate_request_id(&request_id)?;
    let guard = state.register_request(&request_id);
    tokio::select! {
        biased;
        _ = guard.token().cancelled() => Err(AppError::cancelled()),
        result = work => result,
    }
}

/// With a `requestId` the analysis can be cancelled through `cancel_request`.
#[tauri::command]
pub async fn analyze_url<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    url: String,
    lang: Lang,
    request_id: Option<String>,
) -> AppResult<AnalyzeResult> {
    cancellable(&state, request_id, analyze::analyze(&app, &url, lang)).await
}

/// Cancels a `chat_stream` / `analyze_url` / `chat_complete` request. Unknown ids are ignored.
#[tauri::command]
pub async fn cancel_request(state: State<'_, AppState>, request_id: String) -> AppResult<()> {
    if !state.cancel_request(&request_id) {
        log::debug!("cancel_request: no active request {request_id}");
    }
    Ok(())
}

/// Builds the system prompt: caller prompt (or default) + language instruction.
pub fn chat_system_prompt(system: Option<&str>, lang: Lang, json_mode: bool) -> String {
    let base = system
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_CHAT_SYSTEM_PROMPT);
    let mut prompt = format!("{base}\n\n{}", lang.respond_instruction());
    if json_mode {
        prompt.push_str(" Respond with a single valid JSON object only, without Markdown.");
    }
    prompt
}

/// Validates a chat request and builds the provider completion request.
fn completion_from(request: &ChatRequest) -> AppResult<CompletionRequest> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::invalid_input("The message is empty."));
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(AppError::invalid_input("The message is too long."));
    }
    let system = chat_system_prompt(request.system.as_deref(), request.lang, request.json_mode);
    Ok(CompletionRequest {
        messages: providers::build_messages(
            Some(&system),
            &request.history,
            prompt,
            MAX_HISTORY_TURNS,
        ),
        format: if request.json_mode {
            ResponseFormat::JsonObject
        } else {
            ResponseFormat::Text
        },
        temperature: if request.json_mode { 0.2 } else { 0.5 },
        max_tokens: None,
        // Chat and synthesis keep the thinking channel; Ollama reserves context window for it.
        disable_thinking: false,
    })
}

/// With a `requestId` the completion can be cancelled through `cancel_request`.
#[tauri::command]
pub async fn chat_complete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    request: ChatRequest,
    request_id: Option<String>,
) -> AppResult<String> {
    let completion = completion_from(&request)?;
    cancellable(&state, request_id, async {
        let stored = settings::load(&app).await?;
        let provider = providers::provider_from_settings(&state, &stored).await?;
        provider.complete(&completion).await
    })
    .await
}

/// Reports every outcome on `channel` (`delta`* then one `done` or `error`); resolves with `()`
/// once the stream ends. Cancel with `cancel_request(requestId)`.
#[tauri::command]
pub async fn chat_stream<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    request: ChatRequest,
    request_id: String,
    channel: Channel<ChatStreamEvent>,
) -> AppResult<()> {
    validate_request_id(&request_id)?;
    let guard = state.register_request(&request_id);
    let token = guard.token().clone();

    let result: AppResult<Option<Usage>> = async {
        let completion = completion_from(&request)?;
        let stored = settings::load(&app).await?;
        let provider = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(AppError::cancelled()),
            provider = providers::provider_from_settings(&state, &stored) => provider?,
        };
        let mut sink = |text: &str| {
            channel
                .send(ChatStreamEvent::Delta {
                    text: text.to_string(),
                })
                .is_ok()
        };
        provider.stream(&completion, &token, &mut sink).await
    }
    .await;
    drop(guard);

    let event = match result {
        Ok(usage) => ChatStreamEvent::Done { usage },
        Err(error) => {
            if !matches!(error, AppError::Cancelled(_)) {
                log::info!("chat_stream failed ({}): {error}", error.kind());
            }
            ChatStreamEvent::Error { error }
        }
    };
    if let Err(error) = channel.send(event) {
        log::debug!("chat_stream: could not deliver the final event: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_request_parses_from_camel_case_json() {
        let request: ChatRequest = serde_json::from_value(serde_json::json!({
            "prompt": "hi",
            "history": [{ "role": "user", "content": "a" }, { "role": "assistant", "content": "b" }],
            "lang": "tr",
            "jsonMode": true
        }))
        .expect("parses");
        assert_eq!(request.lang, Lang::Tr);
        assert!(request.json_mode);
        assert_eq!(request.history.len(), 2);
    }

    #[test]
    fn stream_events_serialize_with_a_type_tag() {
        let delta =
            serde_json::to_value(ChatStreamEvent::Delta { text: "hi".into() }).expect("serialize");
        assert_eq!(delta, serde_json::json!({ "type": "delta", "text": "hi" }));

        let done = serde_json::to_value(ChatStreamEvent::Done {
            usage: Some(Usage {
                prompt_tokens: 3,
                completion_tokens: 4,
                cost_usd: None,
            }),
        })
        .expect("serialize");
        assert_eq!(
            done,
            serde_json::json!({ "type": "done", "usage": { "promptTokens": 3, "completionTokens": 4 } })
        );
        let bare = serde_json::to_value(ChatStreamEvent::Done { usage: None }).expect("serialize");
        assert_eq!(bare, serde_json::json!({ "type": "done" }));

        let error = serde_json::to_value(ChatStreamEvent::Error {
            error: AppError::cancelled(),
        })
        .expect("serialize");
        assert_eq!(error["type"], "error");
        assert_eq!(error["error"]["kind"], "cancelled");
    }

    #[test]
    fn bad_request_ids_and_blank_prompts_are_rejected() {
        assert!(validate_request_id("abc-123").is_ok());
        assert!(validate_request_id(" ").is_err());
        assert!(validate_request_id(&"x".repeat(200)).is_err());
        let empty: ChatRequest =
            serde_json::from_value(serde_json::json!({ "prompt": "   " })).expect("parses");
        assert_eq!(
            completion_from(&empty).expect_err("empty").kind(),
            "invalidInput"
        );
    }

    #[tokio::test]
    async fn cancellable_request_is_cancelled() {
        let state = AppState::new(
            crate::http::HttpClients::new().expect("clients"),
            std::env::temp_dir(),
            std::env::temp_dir(),
            crate::snapshot::backend::Backend::Disabled("test".into()),
        );
        let work = async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            Ok::<_, AppError>(1)
        };
        let run = cancellable(&state, Some("req-1".into()), work);
        let cancel = async {
            tokio::task::yield_now().await;
            assert!(state.cancel_request("req-1"));
        };
        let (result, ()) = tokio::join!(run, cancel);
        assert_eq!(result.expect_err("cancelled").kind(), "cancelled");
        assert!(!state.cancel_request("req-1"));

        let plain = cancellable(&state, None, async { Ok::<_, AppError>(7) }).await;
        assert_eq!(plain.expect("ok"), 7);
    }

    #[test]
    fn system_prompt_names_the_reply_language() {
        let tr = chat_system_prompt(None, Lang::Tr, false);
        assert!(tr.contains("Respond in Turkish."));
        let custom = chat_system_prompt(Some("Custom"), Lang::En, true);
        assert!(custom.starts_with("Custom"));
        assert!(custom.contains("JSON"));
    }
}
