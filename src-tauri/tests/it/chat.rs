//! Chat completion and streaming end to end, against stand-in Ollama and OpenRouter endpoints.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::analyze::Lang;
use app_lib::commands::ai::{chat_complete, chat_stream, ChatRequest, ChatStreamEvent};
use app_lib::commands::providers::{list_ollama_models, test_provider_connection};
use app_lib::error::AppResult;
use app_lib::http::HttpClients;
use app_lib::providers::ollama::OllamaProvider;
use app_lib::providers::openrouter::{list_models_at, OpenRouterProvider};
use app_lib::providers::stream::{
    DeltaSink, Usage, MAX_LINE_BYTES, MAX_OUTPUT_CHARS, MAX_REASONING_CHARS,
};
use app_lib::providers::{
    ChatTurn, CompletionRequest, Message, Provider, ResponseFormat, Role, TurnRole,
};
use app_lib::settings::{AIProvider, AISettingsUpdate};
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio_util::sync::CancellationToken;

use crate::support::server::{Chunk, Reply, TestServer};
use crate::support::{app_for, offline_app};

/// Collects everything the `chat_stream` channel emits, in order.
#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<Value>>>);

impl Events {
    fn channel(&self) -> Channel<ChatStreamEvent> {
        let sink = Arc::clone(&self.0);
        Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Json(text) = body {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    sink.lock().expect("events").push(value);
                }
            }
            Ok(())
        })
    }

    fn all(&self) -> Vec<Value> {
        self.0.lock().expect("events").clone()
    }

    fn text(&self) -> String {
        self.all()
            .iter()
            .filter(|e| e["type"] == "delta")
            .filter_map(|e| e["text"].as_str().map(str::to_string))
            .collect()
    }

    fn deltas(&self) -> usize {
        self.all().iter().filter(|e| e["type"] == "delta").count()
    }

    fn last(&self) -> Value {
        self.all().last().cloned().unwrap_or(Value::Null)
    }
}

fn request(prompt: &str) -> ChatRequest {
    ChatRequest {
        prompt: prompt.to_string(),
        history: Vec::new(),
        lang: Lang::En,
        system: None,
        json_mode: false,
    }
}

fn ndjson_lines() -> String {
    [
        r#"{"message":{"role":"assistant","content":"He"},"done":false}"#,
        r#"{"message":{"role":"assistant","content":"llo <thi"},"done":false}"#,
        r#"{"message":{"role":"assistant","content":"nk>hidden</think> world"},"done":false}"#,
        r#"{"message":{"content":""},"done":true,"prompt_eval_count":11,"eval_count":7}"#,
    ]
    .join("\n")
        + "\n"
}

/// Splits `text` into small wire chunks so line and tag boundaries land mid-chunk.
fn wire_chunks(text: &str, size: usize) -> Vec<Chunk> {
    text.as_bytes()
        .chunks(size)
        .map(|piece| Chunk::now(piece.to_vec()))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_complete_strips_reasoning_and_sends_the_language_instruction() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        Reply::json(&json!({
            "message": { "role": "assistant", "content": "<think>plan</think>\n\nHello there." },
            "done": true
        }))
    });
    let app = app_for(&server);

    let answer = chat_complete(app.handle(), app.state(), request("hi"), None)
        .await
        .expect("completion");
    assert_eq!(answer, "Hello there.");

    let body = server.requests_to("/api/chat")[0].json();
    assert_eq!(body["stream"], json!(false));
    assert_eq!(body["model"], json!("test-model"));
    // num_ctx covers the prompt plus the output reserve; a tiny "hi" lands on 8192.
    assert_eq!(body["options"]["num_ctx"], json!(8192));
    assert!(body["options"].get("num_predict").is_none(), "{body}");
    assert!(body.get("think").is_none(), "{body}");
    let system = body["messages"][0]["content"].as_str().unwrap_or_default();
    assert!(system.contains("Respond in English."), "{system}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_complete_rejects_an_empty_answer() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        Reply::json(&json!({ "message": { "content": "   " }, "done": true }))
    });
    let app = app_for(&server);

    let error = chat_complete(app.handle(), app.state(), request("hi"), None)
        .await
        .expect_err("empty answers are an error");
    assert_eq!(error.kind(), "provider");
    assert!(error.to_string().contains("empty response"), "{error}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_history_that_does_not_fit_is_retried_shorter() {
    let server = TestServer::start().await;
    // A model whose window fits 2000 characters: the first prompt does not, the retry does.
    server.route("/api/chat", |request| {
        let sent: usize = request.json()["messages"]
            .as_array()
            .map(|messages| {
                messages
                    .iter()
                    .filter_map(|m| m["content"].as_str())
                    .map(|content| content.chars().count())
                    .sum()
            })
            .unwrap_or_default();
        if sent > 2000 {
            return Reply::text(
                400,
                "application/json",
                json!({ "error": "input length exceeds maximum context length" }).to_string(),
            );
        }
        Reply::json(&json!({
            "message": { "role": "assistant", "content": "Shorter, but answered." },
            "done": true
        }))
    });
    let app = app_for(&server);

    let mut long = request("and now?");
    long.history = (0..8)
        .map(|i| ChatTurn {
            role: if i % 2 == 0 {
                TurnRole::User
            } else {
                TurnRole::Assistant
            },
            content: format!("turn {i} {}", "x".repeat(400)),
        })
        .collect();

    let answer = chat_complete(app.handle(), app.state(), long, None)
        .await
        .expect("the retry answers");
    assert_eq!(answer, "Shorter, but answered.");

    let calls = server.requests_to("/api/chat");
    assert_eq!(calls.len(), 2, "exactly one retry");
    let retried = calls[1].json();
    let messages = retried["messages"].as_array().expect("messages").clone();
    assert!(messages.len() < 10, "the history was trimmed: {messages:?}");
    assert_eq!(messages[0]["role"], "system", "the system prompt stays");
    assert_eq!(
        messages.last().and_then(|m| m["content"].as_str()),
        Some("and now?"),
        "the question stays"
    );
    assert!(
        !messages.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|c| c.starts_with("turn 0"))),
        "the oldest turn goes first: {messages:?}"
    );
    assert_eq!(retried["truncate"], json!(false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_single_prompt_that_does_not_fit_is_reported() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        Reply::text(
            400,
            "application/json",
            json!({ "error": "input length exceeds maximum context length" }).to_string(),
        )
    });
    let app = app_for(&server);

    let error = chat_complete(app.handle(), app.state(), request(&"x".repeat(5000)), None)
        .await
        .expect_err("nothing can be trimmed");
    assert_eq!(error.kind(), "invalidInput");
    assert!(error.to_string().contains("too long"), "{error}");
    assert_eq!(server.hits("/api/chat"), 1, "no pointless retry");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chat_complete_can_be_cancelled() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        Reply::json(&json!({ "message": { "content": "late" }, "done": true })).with_delay(5_000)
    });
    let app = app_for(&server);

    let run = chat_complete(
        app.handle(),
        app.state(),
        request("hi"),
        Some("chat-1".to_string()),
    );
    let cancel = async {
        while server.hits("/api/chat") == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(app.state().cancel_request("chat-1"));
    };
    let (result, ()) = tokio::join!(run, cancel);
    assert_eq!(result.expect_err("cancelled").kind(), "cancelled");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_stream_reassembles_ollama_ndjson_across_chunk_boundaries() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        Reply::chunked("application/x-ndjson", wire_chunks(&ndjson_lines(), 17))
    });
    let app = app_for(&server);
    let events = Events::default();

    chat_stream(
        app.handle(),
        app.state(),
        request("hi"),
        "stream-1".to_string(),
        events.channel(),
    )
    .await
    .expect("stream command resolves");

    assert_eq!(events.text(), "Hello  world", "think blocks are filtered");
    assert!(events.deltas() >= 2, "text arrives incrementally");
    assert_eq!(
        events.last(),
        json!({ "type": "done", "usage": { "promptTokens": 11, "completionTokens": 7 } })
    );
    let body = server.requests_to("/api/chat")[0].json();
    assert_eq!(body["stream"], json!(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_stream_surfaces_a_provider_error_after_partial_text() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        let body = format!(
            "{}\n{}\n",
            r#"{"message":{"content":"partial"},"done":false}"#, r#"{"error":"the model crashed"}"#
        );
        Reply::chunked("application/x-ndjson", wire_chunks(&body, 24))
    });
    let app = app_for(&server);
    let events = Events::default();

    chat_stream(
        app.handle(),
        app.state(),
        request("hi"),
        "stream-2".to_string(),
        events.channel(),
    )
    .await
    .expect("stream command resolves");

    assert_eq!(events.text(), "partial");
    let last = events.last();
    assert_eq!(last["type"], "error");
    assert_eq!(last["error"]["kind"], "provider");
    assert!(last["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .contains("the model crashed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_stream_reports_a_connection_that_dies_mid_stream() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        Reply::chunked_abort(
            "application/x-ndjson",
            wire_chunks(
                &format!("{}\n", r#"{"message":{"content":"half"},"done":false}"#),
                20,
            ),
        )
    });
    let app = app_for(&server);
    let events = Events::default();

    chat_stream(
        app.handle(),
        app.state(),
        request("hi"),
        "stream-3".to_string(),
        events.channel(),
    )
    .await
    .expect("stream command resolves");

    assert_eq!(events.text(), "half", "text seen before the drop is kept");
    let last = events.last();
    assert_eq!(last["type"], "error");
    // A truncated chunked body decodes as `parse`, not `network`.
    assert_eq!(last["error"]["kind"], "parse", "{last}");
    assert_eq!(
        events.all().iter().filter(|e| e["type"] != "delta").count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chat_stream_cancellation_keeps_the_partial_text() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        let mut chunks = vec![Chunk::now(format!(
            "{}\n",
            r#"{"message":{"content":"first"},"done":false}"#
        ))];
        for _ in 0..20 {
            chunks.push(Chunk::after(
                200,
                format!("{}\n", r#"{"message":{"content":"more"},"done":false}"#),
            ));
        }
        Reply::chunked("application/x-ndjson", chunks)
    });
    let app = app_for(&server);
    let events = Events::default();

    let run = chat_stream(
        app.handle(),
        app.state(),
        request("hi"),
        "stream-4".to_string(),
        events.channel(),
    );
    let cancel = async {
        while events.deltas() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(app.state().cancel_request("stream-4"));
    };
    let (result, ()) = tokio::join!(run, cancel);
    result.expect("stream command resolves");

    assert!(events.text().starts_with("first"));
    let last = events.last();
    assert_eq!(last["type"], "error");
    assert_eq!(last["error"]["kind"], "cancelled");
    assert_eq!(
        events.all().iter().filter(|e| e["type"] != "delta").count(),
        1
    );
}

/// Exercises the OpenRouter provider directly; `provider_from_settings` would need the OS keyring.
async fn openrouter_stream(
    server: &TestServer,
) -> (
    Vec<String>,
    app_lib::error::AppResult<Option<app_lib::providers::stream::Usage>>,
) {
    let provider = Provider::OpenRouter(OpenRouterProvider::with_base_url(
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client"),
        "acme/model-x",
        "sk-test-key".to_string(),
        &server.base(),
    ));
    let request = CompletionRequest {
        messages: vec![Message::new(Role::User, "hi")],
        format: ResponseFormat::Text,
        temperature: 0.5,
        max_tokens: None,
        disable_thinking: false,
    };
    let collected = Arc::new(Mutex::new(Vec::new()));
    let token = CancellationToken::new();
    let result = {
        let collected = Arc::clone(&collected);
        let mut sink = move |text: &str| {
            collected.lock().expect("deltas").push(text.to_string());
            true
        };
        let sink: &mut DeltaSink<'_> = &mut sink;
        provider.stream(&request, &token, sink).await
    };
    let deltas = collected.lock().expect("deltas").clone();
    (deltas, result)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_sse_streams_text_and_usage() {
    let server = TestServer::start().await;
    server.route("/chat/completions", |_| {
        let sse = concat!(
            ": OPENROUTER PROCESSING\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"cost\":0.0012}}\n\n",
            "data: [DONE]\n\n",
        );
        Reply::chunked("text/event-stream", wire_chunks(sse, 23))
    });

    let (deltas, result) = openrouter_stream(&server).await;
    let usage = result.expect("stream").expect("usage reported");
    assert_eq!(deltas.concat(), "Hello");
    assert_eq!(usage.prompt_tokens, 10);
    assert_eq!(usage.completion_tokens, 5);
    assert_eq!(usage.cost_usd, Some(0.0012));

    let request = &server.requests_to("/chat/completions")[0];
    assert_eq!(request.header("authorization"), Some("Bearer sk-test-key"));
    let body = request.json();
    assert_eq!(body["stream"], json!(true));
    assert_eq!(body["usage"]["include"], json!(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_stream_without_a_done_sentinel_keeps_the_answer() {
    let server = TestServer::start().await;
    server.route("/chat/completions", |_| {
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
        );
        Reply::chunked("text/event-stream", wire_chunks(sse, 19))
    });

    let (deltas, result) = openrouter_stream(&server).await;
    assert!(result.is_ok(), "{:?}", result.err().map(|e| e.to_string()));
    assert_eq!(deltas.concat(), "Hello");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_stream_that_ends_before_any_text_is_an_error() {
    let server = TestServer::start().await;
    server.route("/chat/completions", |_| {
        Reply::chunked(
            "text/event-stream",
            wire_chunks(": OPENROUTER PROCESSING\n\n", 11),
        )
    });

    let (deltas, result) = openrouter_stream(&server).await;
    assert!(deltas.is_empty());
    let error = result.expect_err("an empty stream must fail");
    assert_eq!(error.kind(), "network", "{error}");
}

/// `finish_reason` is the model's own end marker; a usage chunk sent alongside it still lands.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_finish_reason_ends_the_stream() {
    let server = TestServer::start().await;
    server.route("/chat/completions", |_| {
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2}}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" after the end\"}}]}\n\n",
        );
        // One wire chunk: everything the provider flushed together is parsed together.
        Reply::chunked(
            "text/event-stream",
            vec![Chunk::now(sse.as_bytes().to_vec())],
        )
    });

    let (deltas, result) = openrouter_stream(&server).await;
    let usage = result.expect("stream").expect("usage reported");
    assert_eq!(deltas.concat(), "done", "nothing after the finish reason");
    assert_eq!(usage.prompt_tokens, 4);
    assert_eq!(usage.completion_tokens, 2);
}

/// A usage chunk flushed after the `finish_reason` chunk still reaches the cost indicator.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_usage_in_a_later_chunk_than_the_finish_reason_is_kept() {
    let server = TestServer::start().await;
    server.route("/chat/completions", |_| {
        let answer = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        );
        let usage = concat!(
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"cost\":0.0005}}\n\n",
            "data: [DONE]\n\n",
        );
        Reply::chunked(
            "text/event-stream",
            vec![
                Chunk::now(answer.as_bytes().to_vec()),
                Chunk::after(300, usage.as_bytes().to_vec()),
            ],
        )
    });

    let (deltas, result) = openrouter_stream(&server).await;
    let usage = result
        .expect("stream")
        .expect("usage from the second chunk");
    assert_eq!(deltas.concat(), "done");
    assert_eq!(usage.prompt_tokens, 7);
    assert_eq!(usage.completion_tokens, 3);
    assert_eq!(usage.cost_usd, Some(0.0005));
}

/// A usage report that never comes costs at most the short grace wait, not the idle timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_waits_only_briefly_for_usage_after_the_finish_reason() {
    let server = TestServer::start().await;
    server.route("/chat/completions", |_| {
        let answer =
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n";
        let late =
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\n";
        Reply::chunked(
            "text/event-stream",
            vec![
                Chunk::now(answer.as_bytes().to_vec()),
                Chunk::after(8_000, late.as_bytes().to_vec()),
            ],
        )
    });

    let started = std::time::Instant::now();
    let (deltas, result) = openrouter_stream(&server).await;
    assert_eq!(deltas.concat(), "ok");
    assert_eq!(result.expect("the answer stands"), None);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(6),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_sse_error_chunks_become_provider_errors() {
    let server = TestServer::start().await;
    server.route("/chat/completions", |_| {
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n",
            "data: {\"error\":{\"code\":429,\"message\":\"slow down\"}}\n\n",
        );
        Reply::chunked("text/event-stream", wire_chunks(sse, 31))
    });

    let (deltas, result) = openrouter_stream(&server).await;
    assert_eq!(deltas.concat(), "x");
    let error = result.expect_err("error chunk");
    assert_eq!(error.kind(), "provider");
    assert_eq!(error.status(), Some(429));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_http_errors_are_mapped_to_useful_messages() {
    let server = TestServer::start().await;
    server.route("/chat/completions", |_| {
        Reply::text(
            401,
            "application/json",
            r#"{"error":{"message":"No auth credentials found"}}"#,
        )
    });
    let provider = OpenRouterProvider::with_base_url(
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client"),
        "acme/model-x",
        "sk-bad".to_string(),
        &server.base(),
    );
    let error = provider
        .complete_raw(&CompletionRequest {
            messages: vec![Message::new(Role::User, "hi")],
            format: ResponseFormat::JsonObject,
            temperature: 0.0,
            max_tokens: Some(8),
            disable_thinking: false,
        })
        .await
        .expect_err("401");
    assert_eq!(error.kind(), "provider");
    assert_eq!(error.status(), Some(401));
    assert!(error.to_string().contains("API key"), "{error}");

    let body = server.requests_to("/chat/completions")[0].json();
    assert_eq!(body["response_format"]["type"], json!("json_object"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_model_list_carries_prices_per_million_tokens() {
    let server = TestServer::start().await;
    server.route("/models", |_| {
        Reply::json(&json!({
            "data": [
                { "id": "b/model", "name": "B", "context_length": 8192,
                  "pricing": { "prompt": "0.000003", "completion": "0.000015" } },
                { "id": "a/model", "pricing": { "prompt": "-1", "completion": "abc" } }
            ]
        }))
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("client");

    let models = list_models_at(&client, &server.base())
        .await
        .expect("model list");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "a/model");
    assert_eq!(
        models[0].name, "a/model",
        "missing names fall back to the id"
    );
    assert_eq!(models[0].prompt_price_per_m_tok, None);
    assert_eq!(models[1].prompt_price_per_m_tok, Some(3.0));
    assert_eq!(models[1].completion_price_per_m_tok, Some(15.0));
    assert_eq!(models[1].context_length, Some(8192));
}

/// Real OpenRouter ids carry `/`, `-`, `.` and `:`; anything outside that alphabet is dropped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openrouter_ids_outside_the_plain_alphabet_are_dropped() {
    let server = TestServer::start().await;
    server.route("/models", |_| {
        Reply::json(&json!({
            "data": [
                { "id": "meta-llama/llama-3.1-8b-instruct:free" },
                { "id": "qwen/qwen3-235b-a22b-07-25" },
                { "id": "openai/gpt-4o-mini" },
                { "id": "evil/model\"; rm -rf ~; \"" },
                { "id": "spaced id/model" },
                { "id": "" }
            ]
        }))
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("client");

    let ids: Vec<String> = list_models_at(&client, &server.base())
        .await
        .expect("model list")
        .into_iter()
        .map(|m| m.id)
        .collect();
    assert_eq!(
        ids,
        vec![
            "meta-llama/llama-3.1-8b-instruct:free",
            "openai/gpt-4o-mini",
            "qwen/qwen3-235b-a22b-07-25"
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ollama_model_list_and_connection_test_hit_the_real_endpoints() {
    let server = TestServer::start().await;
    server.route("/api/tags", |_| {
        Reply::json(&json!({
            "models": [
                { "name": "qwen3:8b", "size": 5_200_000_000u64,
                  "details": { "family": "qwen3", "families": ["qwen3"] } },
                { "name": "llama3.2:latest", "size": 2_000_000_000u64 },
                { "name": "nomic-embed-text:latest", "size": 274_000_000u64,
                  "details": { "family": "nomic-bert", "families": ["nomic-bert"] } }
            ]
        }))
    });
    server.route("/api/chat", |_| {
        Reply::json(&json!({ "message": { "content": "pong" }, "done": true }))
    });
    let app = app_for(&server);

    let models = list_ollama_models(app.handle(), app.state(), None, None)
        .await
        .expect("tags");
    assert_eq!(models.len(), 3);
    assert_eq!(models[0].id, "llama3.2:latest", "sorted by name");
    assert_eq!(models[2].size_bytes, Some(5_200_000_000));
    // Embedding models are flagged; chat models carry no flag on the wire.
    assert_eq!(models[1].id, "nomic-embed-text:latest");
    assert_eq!(models[1].embedding, Some(true));
    let wire = serde_json::to_value(&models).expect("serialize");
    assert_eq!(wire[1]["embedding"], json!(true));
    assert!(wire[2].get("embedding").is_none(), "{wire}");

    let probe = test_provider_connection(
        app.state(),
        AISettingsUpdate {
            provider: AIProvider::Ollama,
            ollama_base_url: server.base(),
            ollama_model: "test-model".to_string(),
            openrouter_model: String::new(),
            embedding_model: String::new(),
            allow_private_network: true,
        },
    )
    .await
    .expect("connection test");
    let value = serde_json::to_value(&probe).expect("serialize");
    assert_eq!(value["ok"], json!(true), "{value}");
    assert!(value["latencyMs"].is_number());
    assert!(value.get("reason").is_none(), "{value}");

    // One request, thinking off from the start, a tiny output budget.
    let chats = server.requests_to("/api/chat");
    assert_eq!(chats.len(), 1);
    let body = chats[0].json();
    assert_eq!(body["think"], json!(false), "{body}");
    assert_eq!(body["options"]["num_predict"], json!(16));
}

/// Real Ollama answers a model that was never pulled with 404 and an embedding model with 400;
/// the connection test reports both as a reason the settings screen can translate.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_test_names_a_missing_or_non_chat_model() {
    let server = TestServer::start().await;
    server.route("/api/chat", |request| {
        let body = request.json();
        if body["model"] == json!("bge-m3:latest") {
            Reply::text(
                400,
                "application/json",
                r#"{"error":"\"bge-m3:latest\" does not support chat"}"#,
            )
        } else {
            Reply::text(
                404,
                "application/json",
                r#"{"error":"model 'olmayan-model:1b' not found"}"#,
            )
        }
    });
    let app = app_for(&server);
    let probe = |model: &str| AISettingsUpdate {
        provider: AIProvider::Ollama,
        ollama_base_url: server.base(),
        ollama_model: model.to_string(),
        openrouter_model: String::new(),
        embedding_model: String::new(),
        allow_private_network: true,
    };

    let missing = test_provider_connection(app.state(), probe("olmayan-model:1b"))
        .await
        .expect("resolves");
    let value = serde_json::to_value(&missing).expect("serialize");
    assert_eq!(value["ok"], json!(false));
    assert_eq!(value["reason"], json!("modelMissing"), "{value}");

    let embedding = test_provider_connection(app.state(), probe("bge-m3:latest"))
        .await
        .expect("resolves");
    let value = serde_json::to_value(&embedding).expect("serialize");
    assert_eq!(value["reason"], json!("notChatModel"), "{value}");
}

/// Both list and connection test judge the renderer's unsaved `allowPrivateNetwork` draft first.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_model_list_follows_the_draft_private_network_flag() {
    let server = TestServer::start().await;
    server.route("/api/tags", |_| Reply::json(&json!({ "models": [] })));
    let app = app_for(&server);

    let refused = list_ollama_models(
        app.handle(),
        app.state(),
        Some("http://10.0.0.7:11434".to_string()),
        Some(false),
    )
    .await
    .expect_err("the draft flag turns private networking off");
    assert_eq!(refused.kind(), "blockedAddress", "{refused}");

    let probe = test_provider_connection(
        app.state(),
        AISettingsUpdate {
            provider: AIProvider::Ollama,
            ollama_base_url: "http://10.0.0.7:11434".to_string(),
            ollama_model: "test-model".to_string(),
            openrouter_model: String::new(),
            embedding_model: String::new(),
            allow_private_network: false,
        },
    )
    .await
    .expect("connection test resolves");
    let value = serde_json::to_value(&probe).expect("serialize");
    assert_eq!(value["ok"], json!(false), "{value}");
    assert_eq!(value["reason"], json!("blockedAddress"), "{value}");

    let models = list_ollama_models(app.handle(), app.state(), Some(server.base()), None)
        .await
        .expect("stored settings still allow loopback");
    assert!(models.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_test_reports_failures_without_rejecting() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| Reply::status(500));
    let app = app_for(&server);

    let probe = test_provider_connection(
        app.state(),
        AISettingsUpdate {
            provider: AIProvider::Ollama,
            ollama_base_url: server.base(),
            ollama_model: "test-model".to_string(),
            openrouter_model: String::new(),
            embedding_model: String::new(),
            allow_private_network: true,
        },
    )
    .await
    .expect("connection test resolves even on failure");
    let value = serde_json::to_value(&probe).expect("serialize");
    assert_eq!(value["ok"], json!(false));
    assert_eq!(value["reason"], json!("other"), "{value}");
    // An empty error body leaves no dangling colon.
    assert_eq!(
        value["message"],
        json!("Ollama returned HTTP 500."),
        "{value}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreachable_ollama_carries_its_own_error_code() {
    let app = offline_app();

    let error = list_ollama_models(app.handle(), app.state(), None, None)
        .await
        .expect_err("nothing listens on port 1");
    let value = serde_json::to_value(&error).expect("serialize");
    assert_eq!(value["kind"], json!("network"), "{value}");
    assert_eq!(value["code"], json!("ollamaUnreachable"), "{value}");
    assert!(value.get("model").is_none(), "{value}");
    assert!(
        value["message"]
            .as_str()
            .unwrap_or_default()
            .contains("127.0.0.1:1"),
        "{value}"
    );

    let probe = test_provider_connection(
        app.state(),
        AISettingsUpdate {
            provider: AIProvider::Ollama,
            ollama_base_url: "http://127.0.0.1:1".to_string(),
            ollama_model: "test-model".to_string(),
            openrouter_model: String::new(),
            embedding_model: String::new(),
            allow_private_network: true,
        },
    )
    .await
    .expect("connection test resolves");
    let probe = serde_json::to_value(&probe).expect("serialize");
    assert_eq!(probe["reason"], json!("unreachable"), "{probe}");
}

/// Streams through the provider directly so a test can shorten its idle timeout in isolation.
async fn ollama_stream(
    server: &TestServer,
    idle_timeout: Option<Duration>,
) -> (Vec<String>, AppResult<Option<Usage>>) {
    let clients = HttpClients::new().expect("clients");
    let mut provider = OllamaProvider::new(
        clients.ollama(true).clone(),
        &server.base(),
        true,
        "test-model",
    )
    .expect("provider");
    if let Some(timeout) = idle_timeout {
        provider = provider.with_stream_idle_timeout(timeout);
    }
    let provider = Provider::Ollama(provider);
    let request = CompletionRequest {
        messages: vec![Message::new(Role::User, "hi")],
        format: ResponseFormat::Text,
        temperature: 0.5,
        max_tokens: None,
        disable_thinking: false,
    };
    let collected = Arc::new(Mutex::new(Vec::new()));
    let token = CancellationToken::new();
    let result = {
        let collected = Arc::clone(&collected);
        let mut sink = move |text: &str| {
            collected.lock().expect("deltas").push(text.to_string());
            true
        };
        let sink: &mut DeltaSink<'_> = &mut sink;
        provider.stream(&request, &token, sink).await
    };
    let deltas = collected.lock().expect("deltas").clone();
    (deltas, result)
}

fn ndjson(content: &str) -> String {
    format!(
        "{}\n",
        json!({ "message": { "content": content }, "done": false })
    )
}

/// Uses a 300 ms idle timeout (production default: 120 s) so this runs in the normal suite.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stream_gives_up_when_the_provider_goes_silent() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        Reply::chunked(
            "application/x-ndjson",
            vec![
                Chunk::now(ndjson("start")),
                // Far longer than the 300 ms idle timeout: the stream must be abandoned first.
                Chunk::after(
                    5_000,
                    format!("{}\n", r#"{"message":{"content":"too late"},"done":true}"#),
                ),
            ],
        )
    });

    let started = std::time::Instant::now();
    let (deltas, result) = ollama_stream(&server, Some(Duration::from_millis(300))).await;
    let error = result.expect_err("a silent provider times out");
    assert_eq!(error.kind(), "timeout", "{error}");
    assert!(error.to_string().contains("300 ms"), "{error}");
    assert_eq!(deltas.concat(), "start", "text before the silence is kept");
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the short timeout applied, not the 5 s delay"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stream_with_regular_chunks_outlives_a_short_idle_timeout() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        let mut chunks = vec![Chunk::now(ndjson("a"))];
        for _ in 0..6 {
            chunks.push(Chunk::after(100, ndjson("b")));
        }
        chunks.push(Chunk::after(
            100,
            format!("{}\n", r#"{"message":{"content":""},"done":true}"#),
        ));
        Reply::chunked("application/x-ndjson", chunks)
    });

    let (deltas, result) = ollama_stream(&server, Some(Duration::from_millis(400))).await;
    result.expect("each gap is shorter than the idle timeout");
    assert_eq!(deltas.concat(), "abbbbbb");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stream_rejects_a_line_longer_than_max_line_bytes() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        let piece = vec![b'x'; MAX_LINE_BYTES / 4];
        let chunks = (0..5).map(|_| Chunk::now(piece.clone())).collect();
        Reply::chunked("application/x-ndjson", chunks)
    });

    let (deltas, result) = ollama_stream(&server, None).await;
    let error = result.expect_err("oversized line");
    assert_eq!(error.kind(), "parse", "{error}");
    assert!(error.to_string().contains("oversized line"), "{error}");
    assert!(deltas.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stream_stops_past_max_output_chars() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        let line = ndjson(&"y".repeat(50_000));
        let count = MAX_OUTPUT_CHARS / 50_000 + 2;
        let chunks = (0..count).map(|_| Chunk::now(line.clone())).collect();
        Reply::chunked("application/x-ndjson", chunks)
    });

    let (deltas, result) = ollama_stream(&server, None).await;
    let error = result.expect_err("too long");
    assert_eq!(error.kind(), "parse", "{error}");
    assert!(error.to_string().contains("too long"), "{error}");
    let delivered: usize = deltas.iter().map(|d| d.chars().count()).sum();
    assert_eq!(delivered, MAX_OUTPUT_CHARS);
}

/// Fails promptly instead of holding the chat open until the 10-minute total timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn endless_reasoning_without_an_answer_is_stopped() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        let mut chunks = vec![Chunk::now(ndjson("<think>"))];
        let line = ndjson(&"r".repeat(50_000));
        for _ in 0..MAX_REASONING_CHARS / 50_000 + 2 {
            chunks.push(Chunk::now(line.clone()));
        }
        // Never reached: the stream is stopped before this answer.
        chunks.push(Chunk::after(5_000, ndjson("</think>late answer")));
        Reply::chunked("application/x-ndjson", chunks)
    });

    let started = std::time::Instant::now();
    let (deltas, result) = ollama_stream(&server, None).await;
    let error = result.expect_err("reasoning budget");
    assert_eq!(error.kind(), "provider", "{error}");
    assert!(deltas.is_empty());
    assert!(started.elapsed() < Duration::from_secs(4));
}

/// Ollama's separate `thinking` field is charged to the same reasoning budget.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reasoning_budget_keeps_an_answer_that_was_already_delivered() {
    let server = TestServer::start().await;
    server.route("/api/chat", |_| {
        let mut chunks = vec![Chunk::now(ndjson("Visible answer."))];
        let thinking = format!(
            "{}\n",
            json!({ "message": { "content": "", "thinking": "t".repeat(50_000) }, "done": false })
        );
        for _ in 0..MAX_REASONING_CHARS / 50_000 + 2 {
            chunks.push(Chunk::now(thinking.clone()));
        }
        chunks.push(Chunk::after(5_000, ndjson(" never shown")));
        Reply::chunked("application/x-ndjson", chunks)
    });

    let (deltas, result) = ollama_stream(&server, None).await;
    result.expect("the visible answer is kept");
    assert_eq!(deltas.concat(), "Visible answer.");
}
