//! The `mynk-mcp` program end to end: a real MCP client against the real server, and the real
//! binary against a real command line. Verifies protocol wiring, not the answers.

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::Arc;

use app_lib::catalog::inbox;
use app_lib::mcp::engine::Engine;
use app_lib::mcp::server::MynkServer;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientInfo, GetPromptRequestParams,
    Implementation, ReadResourceRequestParams, ResourceContents,
};
use rmcp::service::RunningService;
use rmcp::{ClientHandler, RoleClient, ServiceExt};
use serde_json::{json, Value};

/// How the test client introduces itself, so `add_bookmark` has a name to record.
const CLIENT_NAME: &str = "mynk-test-client";

/// A library written the way the app writes one: one English record, one Turkish, one collection.
fn library_json() -> String {
    json!({
        "version": 3,
        "savedAt": 1_757_289_600_000i64,
        "resources": [
            {
                "id": "r1",
                "url": "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
                "urlKey": "doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
                "title": "Ownership in Rust",
                "description": "How ownership, borrowing and lifetimes work.",
                "categoryId": "development",
                "tags": ["rust", "memory"],
                "summary": ["Every value in Rust has a single owner."],
                "folderPath": ["Bookmarks bar", "Dev"],
                "createdAt": 1_757_289_600_000i64,
                "updatedAt": 1_757_289_600_000i64,
                "lastOpenedAt": 1_757_376_000_000i64,
                "isFavorite": false,
                "ai": { "status": "ok", "analyzedAt": 1_757_289_600_000i64, "confidence": 0.92 },
                "media": { "snapshotFile": "shot-1.png", "faviconFile": "fav-1.png" },
                "health": { "status": "alive", "checkedAt": 1_757_296_800_000i64, "httpStatus": 200 }
            },
            {
                "id": "r2",
                "url": "https://tr.example.com/yazilim-gelistirme",
                "title": "Yazılım Geliştirme Rehberi",
                "description": "Türkçe kaynaklar.",
                "categoryId": "learning",
                "tags": ["yazılım"],
                "createdAt": 1_757_203_200_000i64,
                "lastOpenedAt": null,
                "isFavorite": true,
                "ai": { "status": "none" },
                "media": {}
            }
        ],
        "collections": [
            {
                "id": "c1",
                "name": "Rust",
                "description": "Rust reading list",
                "keywords": ["rust"],
                "pinnedIds": [],
                "color": "#ff8800"
            }
        ],
        "chats": { "global": [{ "id": "m1", "role": "user", "content": "secret question" }] },
        "settings": { "lang": "tr" }
    })
    .to_string()
}

fn seeded_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    app_lib::library::save(dir.path(), &library_json()).expect("seed library.json");
    dir
}

#[derive(Debug, Clone)]
struct TestClient {
    info: ClientInfo,
}

impl Default for TestClient {
    fn default() -> Self {
        Self {
            info: ClientInfo::new(
                ClientCapabilities::default(),
                Implementation::new(CLIENT_NAME, "1.0.0"),
            ),
        }
    }
}

impl ClientHandler for TestClient {
    fn get_info(&self) -> ClientInfo {
        self.info.clone()
    }
}

/// Starts the server and an MCP client on either end of an in-memory pipe.
async fn connect(data_dir: &Path) -> RunningService<RoleClient, TestClient> {
    let engine = Arc::new(Engine::new(data_dir, data_dir.join("cache")));
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        if let Ok(service) = MynkServer::new(engine).serve(server_transport).await {
            let _ = service.waiting().await;
        }
    });
    TestClient::default()
        .serve(client_transport)
        .await
        .expect("the client could not initialize")
}

fn arguments(value: Value) -> rmcp::model::JsonObject {
    value.as_object().cloned().expect("an object of arguments")
}

/// The structured answer of a tool call that was supposed to succeed.
fn structured(result: &CallToolResult) -> Value {
    assert_eq!(result.is_error, Some(false), "{result:?}");
    result
        .structured_content
        .clone()
        .expect("a structured answer")
}

fn hit_ids(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_can_initialize_and_discover_the_whole_surface() {
    let dir = seeded_dir();
    let client = connect(dir.path()).await;

    let info = client.peer_info().expect("the server introduced itself");
    let implementation = info
        .server_info
        .clone()
        .expect("the server named itself in initialize");
    assert_eq!(implementation.name, "mynk");
    assert_eq!(implementation.version, env!("CARGO_PKG_VERSION"));
    let instructions = info.instructions.clone().unwrap_or_default();
    assert!(instructions.contains("search_bookmarks"), "{instructions}");

    let mut tools: Vec<String> = client
        .list_all_tools()
        .await
        .expect("tools/list")
        .into_iter()
        .map(|tool| tool.name.to_string())
        .collect();
    tools.sort();
    assert_eq!(
        tools,
        vec![
            "add_bookmark",
            "get_bookmark",
            "library_stats",
            "list_categories",
            "list_collections",
            "list_recent",
            "list_tags",
            "list_unopened",
            "search_bookmarks",
        ]
    );

    let templates = client
        .list_all_resource_templates()
        .await
        .expect("resources/templates/list");
    let uris: Vec<String> = templates
        .iter()
        .map(|template| template.uri_template.clone())
        .collect();
    assert_eq!(uris, vec!["mynk://bookmark/{id}", "mynk://collection/{id}"]);

    let prompts = client.list_all_prompts().await.expect("prompts/list");
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].name, "find_bookmark");

    client.cancel().await.expect("shut down");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn searching_and_fetching_a_bookmark_over_mcp() {
    let dir = seeded_dir();
    let client = connect(dir.path()).await;

    // Keyword mode, so the answer does not depend on whether this machine has an embedding index.
    let result = client
        .call_tool(
            CallToolRequestParams::new("search_bookmarks").with_arguments(arguments(json!({
                "query": "ownership rust",
                "mode": "keyword"
            }))),
        )
        .await
        .expect("search_bookmarks");
    let answer = structured(&result);
    assert_eq!(hit_ids(&answer, "hits"), vec!["r1"]);
    assert_eq!(answer["modeUsed"], "keyword");
    assert_eq!(answer["note"], Value::Null);
    assert_eq!(answer["hits"][0]["title"], "Ownership in Rust");

    // A Turkish query typed without the Turkish letters still finds the Turkish record.
    let result = client
        .call_tool(
            CallToolRequestParams::new("search_bookmarks").with_arguments(arguments(json!({
                "query": "yazilim gelistirme",
                "mode": "keyword"
            }))),
        )
        .await
        .expect("search_bookmarks");
    assert_eq!(hit_ids(&structured(&result), "hits"), vec!["r2"]);

    let result = client
        .call_tool(
            CallToolRequestParams::new("search_bookmarks").with_arguments(arguments(json!({
                "query": "",
                "mode": "keyword",
                "unopened_only": true
            }))),
        )
        .await
        .expect("search_bookmarks");
    assert_eq!(hit_ids(&structured(&result), "hits"), vec!["r2"]);

    let result = client
        .call_tool(
            CallToolRequestParams::new("get_bookmark")
                .with_arguments(arguments(json!({ "id_or_url": "r1" }))),
        )
        .await
        .expect("get_bookmark");
    let record = structured(&result);
    assert_eq!(
        record["url"],
        "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html"
    );
    assert_eq!(record["analysis"]["status"], "ok");
    assert_eq!(record["link"]["httpStatus"], 200);

    let result = client
        .call_tool(
            CallToolRequestParams::new("list_unopened")
                .with_arguments(arguments(json!({ "days": 100_000 }))),
        )
        .await
        .expect("list_unopened");
    let answer = structured(&result);
    assert_eq!(hit_ids(&answer, "bookmarks"), vec!["r2"]);
    assert_eq!(
        answer["note"],
        "Only opens from inside MYNK are recorded; browser visits are unknown."
    );

    let result = client
        .call_tool(CallToolRequestParams::new("library_stats"))
        .await
        .expect("library_stats");
    let stats = structured(&result);
    assert_eq!(stats["total"], 2);
    assert_eq!(stats["appRunning"], false);

    client.cancel().await.expect("shut down");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sentence_shaped_query_is_answered_and_the_relaxation_is_admitted() {
    let dir = seeded_dir();
    let client = connect(dir.path()).await;

    let result = client
        .call_tool(
            CallToolRequestParams::new("search_bookmarks").with_arguments(arguments(json!({
                "query": "an article about memory safety in rust",
                "mode": "keyword"
            }))),
        )
        .await
        .expect("search_bookmarks");
    let answer = structured(&result);
    assert_eq!(hit_ids(&answer, "hits"), vec!["r1"]);
    let note = answer["note"].as_str().unwrap_or_default();
    assert!(note.contains("relaxed"), "{note}");

    // Every hit is placed and scored relative to the best one, so twenty fused hits are told apart.
    assert_eq!(answer["hits"][0]["rank"], 1);
    assert_eq!(answer["hits"][0]["score"], 1.0);

    // An empty query with no filter is a browse, and is refused as one.
    let error = client
        .call_tool(
            CallToolRequestParams::new("search_bookmarks")
                .with_arguments(arguments(json!({ "query": "   " }))),
        )
        .await
        .expect_err("nothing to search for");
    assert!(error.to_string().contains("list_recent"), "{error}");

    // With a filter it is a listing, not a search.
    let result = client
        .call_tool(
            CallToolRequestParams::new("search_bookmarks")
                .with_arguments(arguments(json!({ "query": "", "favorites_only": true }))),
        )
        .await
        .expect("search_bookmarks");
    let answer = structured(&result);
    assert_eq!(hit_ids(&answer, "hits"), vec!["r2"]);
    assert_eq!(answer["modeUsed"], "keyword");
    let note = answer["note"].as_str().unwrap_or_default();
    assert!(note.starts_with("empty query:"), "{note}");

    client.cancel().await.expect("shut down");
}

/// An agent must be able to plan a call from `tools/list` alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_tool_advertises_its_answer_and_the_modes_it_accepts() {
    let dir = seeded_dir();
    let client = connect(dir.path()).await;

    let tools = client.list_all_tools().await.expect("tools/list");
    for tool in &tools {
        let schema = tool
            .output_schema
            .as_ref()
            .unwrap_or_else(|| panic!("{} has no output schema", tool.name));
        assert_eq!(schema["type"], "object", "{}", tool.name);
        assert!(
            schema["properties"]
                .as_object()
                .is_some_and(|properties| !properties.is_empty()),
            "{} answers with nothing",
            tool.name
        );
    }

    let search = tools
        .iter()
        .find(|tool| tool.name == "search_bookmarks")
        .expect("search_bookmarks");
    let mode = serde_json::to_string(&search.input_schema["properties"]["mode"]).expect("json");
    for value in ["hybrid", "keyword", "semantic"] {
        assert!(mode.contains(&format!("\"{value}\"")), "{mode}");
    }
    let hits = serde_json::to_string(&search.output_schema.as_ref().expect("schema")["properties"])
        .expect("json");
    for field in ["hits", "modeUsed", "note", "total"] {
        assert!(hits.contains(&format!("\"{field}\"")), "{hits}");
    }

    client.cancel().await.expect("shut down");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_answer_carries_a_file_name_or_a_chat_message() {
    let dir = seeded_dir();
    let client = connect(dir.path()).await;

    let mut everything = String::new();
    for (tool, args) in [
        (
            "search_bookmarks",
            json!({ "query": "", "mode": "keyword", "unopened_only": true }),
        ),
        (
            "search_bookmarks",
            json!({ "query": "rust ownership", "mode": "keyword" }),
        ),
        ("get_bookmark", json!({ "id_or_url": "r1" })),
        ("list_recent", json!({ "days": 100_000 })),
        ("list_unopened", json!({ "days": 100_000 })),
        ("list_collections", json!({})),
        ("list_tags", json!({})),
        ("list_categories", json!({})),
        ("library_stats", json!({})),
    ] {
        let result = client
            .call_tool(CallToolRequestParams::new(tool).with_arguments(arguments(args)))
            .await
            .unwrap_or_else(|error| panic!("{tool}: {error}"));
        everything.push_str(&serde_json::to_string(&result).expect("serialize"));
    }
    let resource = client
        .read_resource(ReadResourceRequestParams::new("mynk://bookmark/r1"))
        .await
        .expect("resources/read");
    everything.push_str(&serde_json::to_string(&resource).expect("serialize"));

    for secret in [
        "shot-1.png",
        "fav-1.png",
        "secret question",
        "snapshotFile",
        "folderPath",
        "Bookmarks bar",
    ] {
        assert!(!everything.contains(secret), "{secret} leaked");
    }
    assert!(
        !everything.contains(&dir.path().display().to_string()),
        "the data directory leaked"
    );

    client.cancel().await.expect("shut down");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adding_a_bookmark_lands_in_the_inbox_under_the_client_name() {
    let dir = seeded_dir();
    let before = std::fs::read_to_string(dir.path().join("library.json")).expect("library");
    let client = connect(dir.path()).await;

    let result = client
        .call_tool(
            CallToolRequestParams::new("add_bookmark").with_arguments(arguments(json!({
                "url": "https://example.com/from-an-agent",
                "title": "From an agent",
                "tags": ["rust", "rust"],
                "note": "added while the app was closed"
            }))),
        )
        .await
        .expect("add_bookmark");
    let answer = structured(&result);
    assert_eq!(answer["queued"], true);
    assert_eq!(
        answer["appearsIn"], "next-launch",
        "no heartbeat file, so the app is closed"
    );

    assert_eq!(inbox::count(dir.path()), 1);
    let drained = inbox::drain(dir.path()).expect("drain");
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].url, "https://example.com/from-an-agent");
    assert_eq!(drained[0].title.as_deref(), Some("From an agent"));
    assert_eq!(drained[0].tags, vec!["rust"], "duplicates are dropped");
    assert_eq!(
        drained[0].source,
        format!("mcp:{CLIENT_NAME}"),
        "the client that added it is recorded"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("library.json")).expect("library"),
        before,
        "the library the app owns is never written by an agent"
    );

    client.cancel().await.expect("shut down");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_two_failure_shapes_reach_an_agent_differently() {
    let dir = seeded_dir();
    let client = connect(dir.path()).await;

    // A missing record is a readable failure: the model gets the sentence.
    let result = client
        .call_tool(
            CallToolRequestParams::new("get_bookmark")
                .with_arguments(arguments(json!({ "id_or_url": "no-such-record" }))),
        )
        .await
        .expect("the call itself succeeds");
    assert_eq!(result.is_error, Some(true));
    let text = result
        .content
        .first()
        .and_then(|block| block.as_text())
        .map(|text| text.text.clone())
        .unwrap_or_default();
    assert!(text.contains("No bookmark matches"), "{text}");

    // Input the server cannot route is a protocol error instead.
    let error = client
        .call_tool(
            CallToolRequestParams::new("search_bookmarks")
                .with_arguments(arguments(json!({ "query": "rust", "mode": "telepathy" }))),
        )
        .await
        .expect_err("an impossible mode cannot be answered");
    assert!(error.to_string().contains("hybrid"), "{error}");

    // A URL MYNK could never import is refused before anything is written.
    let error = client
        .call_tool(
            CallToolRequestParams::new("add_bookmark")
                .with_arguments(arguments(json!({ "url": "javascript:alert(1)" }))),
        )
        .await
        .expect_err("not an http(s) URL");
    assert!(!error.to_string().is_empty(), "{error}");
    assert_eq!(inbox::count(dir.path()), 0, "nothing was written");

    client.cancel().await.expect("shut down");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resources_and_the_prompt_are_readable() {
    let dir = seeded_dir();
    let client = connect(dir.path()).await;

    let read = client
        .read_resource(ReadResourceRequestParams::new("mynk://bookmark/r2"))
        .await
        .expect("resources/read");
    let ResourceContents::TextResourceContents { uri, text, .. } =
        read.contents.first().expect("one content block").clone()
    else {
        panic!("a bookmark is text, not a blob");
    };
    assert_eq!(uri, "mynk://bookmark/r2");
    let record: Value = serde_json::from_str(&text).expect("the body is JSON");
    assert_eq!(record["title"], "Yazılım Geliştirme Rehberi");

    let read = client
        .read_resource(ReadResourceRequestParams::new("mynk://collection/c1"))
        .await
        .expect("resources/read");
    let ResourceContents::TextResourceContents { text, .. } =
        read.contents.first().expect("one content block").clone()
    else {
        panic!("a collection is text, not a blob");
    };
    let collection: Value = serde_json::from_str(&text).expect("the body is JSON");
    assert_eq!(collection["name"], "Rust");
    assert_eq!(hit_ids(&collection, "bookmarks"), vec!["r1"]);

    for unknown in [
        "mynk://bookmark/nope",
        "mynk://nothing/1",
        "file:///etc/passwd",
    ] {
        let error = client
            .read_resource(ReadResourceRequestParams::new(unknown))
            .await
            .expect_err(unknown);
        assert!(!error.to_string().is_empty(), "{unknown}");
    }

    let prompt = client
        .get_prompt(
            GetPromptRequestParams::new("find_bookmark").with_arguments(arguments(
                json!({ "description": "an article about ownership" }),
            )),
        )
        .await
        .expect("prompts/get");
    let text = prompt
        .messages
        .first()
        .and_then(|message| message.content.as_text())
        .map(|text| text.text.clone())
        .unwrap_or_default();
    assert!(text.contains("an article about ownership"), "{text}");
    assert!(text.contains("search_bookmarks"), "{text}");
    assert!(text.contains("get_bookmark"), "{text}");

    client.cancel().await.expect("shut down");
}

/// Runs the real binary against a temporary data directory.
fn run(dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_mynk-mcp"))
        .args(args)
        .env("MYNK_DATA_DIR", dir)
        .env("MYNK_CACHE_DIR", dir.join("cache"))
        .output()
        .expect("mynk-mcp could not be started")
}

/// Runs it with a temporary home directory too, so `install` edits a throwaway tree.
fn run_at_home(dir: &Path, home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_mynk-mcp"))
        .args(args)
        .env("MYNK_DATA_DIR", dir)
        .env("MYNK_CACHE_DIR", dir.join("cache"))
        .env("MYNK_HOME_DIR", home)
        .output()
        .expect("mynk-mcp could not be started")
}

fn stdout_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "stdout was not JSON ({error}): {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

#[test]
fn the_cli_answers_with_json_and_with_text() {
    let dir = seeded_dir();

    let output = run(
        dir.path(),
        &["search", "ownership", "--mode", "keyword", "--json"],
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let answer = stdout_json(&output);
    assert_eq!(hit_ids(&answer, "hits"), vec!["r1"]);
    assert_eq!(answer["modeUsed"], "keyword");

    let output = run(dir.path(), &["search", "ownership", "--mode", "keyword"]);
    assert_eq!(output.status.code(), Some(0));
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    assert!(text.contains("Ownership in Rust"), "{text}");
    assert!(text.contains("1 hit, keyword search"), "{text}");

    let output = run(dir.path(), &["get", "r2", "--json"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout_json(&output)["title"], "Yazılım Geliştirme Rehberi");

    let output = run(dir.path(), &["stats", "--json"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout_json(&output)["total"], 2);
}

/// Text answers are for people: nothing is said twice and every column has a heading.
#[test]
fn the_cli_text_answers_say_each_thing_once() {
    let dir = seeded_dir();

    // Nothing was added in the last day, so this is the empty answer that carries the caveat.
    let output = run(dir.path(), &["unopened", "--days", "1"]);
    assert_eq!(output.status.code(), Some(0));
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    assert_eq!(
        text.matches(app_lib::mcp::output::VISIT_CAVEAT).count(),
        1,
        "{text}"
    );

    let output = run(dir.path(), &["stats"]);
    assert_eq!(output.status.code(), Some(0));
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    assert!(text.contains("\nby category\n"), "{text}");
    assert!(text.contains("  development"), "{text}");
}

#[test]
fn the_cli_hands_a_bookmark_to_the_inbox() {
    let dir = seeded_dir();
    let output = run(
        dir.path(),
        &[
            "add",
            "https://example.com/from-a-script",
            "--tag",
            "rust",
            "--tag",
            "cli",
            "--note",
            "found while grepping",
            "--json",
        ],
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let answer = stdout_json(&output);
    assert_eq!(answer["queued"], true);
    assert_eq!(answer["appearsIn"], "next-launch");

    let drained = inbox::drain(dir.path()).expect("drain");
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].url, "https://example.com/from-a-script");
    assert_eq!(drained[0].tags, vec!["rust", "cli"]);
    assert_eq!(drained[0].source, "cli");
}

#[test]
fn doctor_reports_the_directories_it_resolved() {
    let dir = seeded_dir();
    let output = run(dir.path(), &["doctor", "--json"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = stdout_json(&output);
    assert_eq!(
        report["dataDir"].as_str().unwrap_or_default(),
        dir.path().display().to_string(),
        "MYNK_DATA_DIR decides where it looks"
    );
    assert_eq!(report["library"]["ok"], true);
    assert_eq!(report["library"]["bookmarks"], 2);
    assert_eq!(report["library"]["schemaVersion"], 3);
    assert_eq!(report["inbox"]["pending"], 0);
    assert_eq!(report["app"]["running"], false);
    assert!(report["ollama"]["detail"].is_string());

    let output = run(dir.path(), &["doctor"]);
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    assert!(text.contains("2 bookmarks"), "{text}");
    assert!(text.contains("app open   no"), "{text}");
}

#[test]
fn install_print_shows_a_configuration_for_every_client_and_writes_nothing() {
    let dir = seeded_dir();
    let exe = env!("CARGO_BIN_EXE_mynk-mcp");
    for (client, needle) in [
        ("claude-code", "claude mcp add mynk"),
        ("codex", "[mcp_servers.mynk]"),
        ("cursor", "\"mcpServers\""),
        ("windsurf", "\"mcpServers\""),
        ("generic", "\"mcpServers\""),
    ] {
        let output = run(dir.path(), &["install", "--client", client, "--print"]);
        assert_eq!(output.status.code(), Some(0), "{client}");
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        assert!(text.contains(needle), "{client}: {text}");
        // A Windows path is escaped in JSON but verbatim elsewhere; both must name this executable.
        assert!(
            text.contains(exe) || text.contains(&exe.replace('\\', "\\\\")),
            "{client} must point at this executable: {text}"
        );
    }

    let output = run(
        dir.path(),
        &["install", "--client", "generic", "--print", "--json"],
    );
    let answer = stdout_json(&output);
    assert_eq!(answer["client"], "generic");
    assert_eq!(answer["written"], false);
    assert_eq!(answer["command"], exe);
}

/// Anything other than JSON-RPC on stdout breaks every client at once.
#[test]
fn the_server_writes_nothing_but_json_rpc_to_stdout() {
    let dir = seeded_dir();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mynk-mcp"))
        .env("MYNK_DATA_DIR", dir.path())
        .env("MYNK_CACHE_DIR", dir.path().join("cache"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("mynk-mcp could not be started");

    let mut stdin = child.stdin.take().expect("stdin");
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "pipe-test", "version": "1.0.0" }
        }
    });
    writeln!(stdin, "{request}").expect("write the request");
    stdin.flush().expect("flush");

    // Read on a thread so a server that never answers fails the test instead of hanging it.
    let stdout = child.stdout.take().expect("stdout");
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = std::io::BufReader::new(stdout).read_line(&mut line);
        let _ = sender.send(line);
    });
    let line = receiver.recv_timeout(std::time::Duration::from_secs(30));
    let _ = child.kill();
    let _ = child.wait();
    let line = line.expect("the server did not answer initialize");

    assert!(
        line.starts_with('{'),
        "the first thing on stdout has to be a JSON-RPC frame: {line:?}"
    );
    let answer: Value = serde_json::from_str(line.trim())
        .unwrap_or_else(|error| panic!("stdout was not JSON-RPC ({error}): {line:?}"));
    assert_eq!(answer["jsonrpc"], "2.0");
    assert_eq!(answer["id"], 1);
    assert_eq!(answer["result"]["serverInfo"]["name"], "mynk");
}

/// `install` keeps whatever it did not write and backs up the previous version.
#[test]
fn install_edits_a_real_configuration_in_place() {
    let dir = seeded_dir();
    let home = tempfile::tempdir().expect("temp home");

    // Cursor has never been configured: the file (and its directory) is created.
    let output = run_at_home(dir.path(), home.path(), &["install", "--client", "cursor"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("Creating"),
        "the plan belongs on stdout"
    );
    assert!(
        output.stderr.is_empty(),
        "a successful install must not repeat the plan on stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cursor = home.path().join(".cursor").join("mcp.json");
    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(&cursor).expect("mcp.json")).expect("json");
    assert_eq!(
        written["mcpServers"]["mynk"]["command"],
        env!("CARGO_BIN_EXE_mynk-mcp")
    );
    assert!(
        !cursor.with_file_name("mcp.json.tmp").exists(),
        "the atomic write leaves no temporary file behind"
    );
    assert!(
        !cursor.with_extension("json.bak").exists(),
        "there was nothing to back up"
    );

    // Windsurf already has another server, which has to survive.
    let windsurf = home
        .path()
        .join(".codeium")
        .join("windsurf")
        .join("mcp_config.json");
    std::fs::create_dir_all(windsurf.parent().expect("parent")).expect("mkdir");
    let before = json!({
        "mcpServers": { "other": { "command": "other.exe", "args": ["--flag"] } },
        "ui": { "theme": "dark" }
    })
    .to_string();
    std::fs::write(&windsurf, &before).expect("seed");

    let output = run_at_home(
        dir.path(),
        home.path(),
        &["install", "--client", "windsurf"],
    );
    assert_eq!(output.status.code(), Some(0));
    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(&windsurf).expect("read")).expect("json");
    assert_eq!(written["mcpServers"]["other"]["command"], "other.exe");
    assert_eq!(written["mcpServers"]["other"]["args"][0], "--flag");
    assert_eq!(written["ui"]["theme"], "dark");
    assert_eq!(
        written["mcpServers"]["mynk"]["command"],
        env!("CARGO_BIN_EXE_mynk-mcp")
    );
    assert_eq!(
        std::fs::read_to_string(windsurf.with_extension("json.bak")).expect("backup"),
        before,
        "the previous file is one move away"
    );

    // Codex is TOML, edited as text so nothing outside the `mynk` section is reformatted.
    let codex = home.path().join(".codex").join("config.toml");
    std::fs::create_dir_all(codex.parent().expect("parent")).expect("mkdir");
    std::fs::write(&codex, "model = \"gpt-5\"\n\n[tui]\ntheme = 'dark'\n").expect("seed");
    let output = run_at_home(
        dir.path(),
        home.path(),
        &["install", "--client", "codex", "--json"],
    );
    assert_eq!(output.status.code(), Some(0));
    let answer = stdout_json(&output);
    assert_eq!(answer["written"], true);
    assert_eq!(
        answer["path"].as_str().unwrap_or_default(),
        codex.display().to_string()
    );
    let toml = std::fs::read_to_string(&codex).expect("read");
    assert!(toml.contains("model = \"gpt-5\""), "{toml}");
    assert!(toml.contains("[tui]"), "{toml}");
    assert!(
        toml.contains(&format!(
            "[mcp_servers.mynk]\ncommand = '{}'",
            env!("CARGO_BIN_EXE_mynk-mcp")
        )),
        "a literal string is what keeps a Windows path readable: {toml}"
    );

    // Running it again is a no-op that says so, and takes no second backup.
    let output = run_at_home(
        dir.path(),
        home.path(),
        &["install", "--client", "codex", "--json"],
    );
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout_json(&output)["written"], false);
}

/// `install` never reads the library, so it must answer even when the data directory can't resolve.
#[test]
fn install_answers_without_a_usable_data_directory() {
    let output = Command::new(env!("CARGO_BIN_EXE_mynk-mcp"))
        .args(["install", "--client", "generic", "--print"])
        .env("MYNK_DATA_DIR", "Z:\\no-such-drive\\mynk")
        .env("MYNK_CACHE_DIR", "Z:\\no-such-drive\\mynk-cache")
        // On unix these are what `dirs` answers from; without them there is no directory at all.
        .env_remove("HOME")
        .env_remove("XDG_DATA_HOME")
        .env_remove("XDG_CACHE_HOME")
        .output()
        .expect("mynk-mcp could not be started");
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"mcpServers\""));
}

#[test]
fn the_listing_subcommands_answer_in_both_shapes() {
    let dir = seeded_dir();

    let output = run(dir.path(), &["collections", "--json"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let answer = stdout_json(&output);
    assert_eq!(answer["collections"][0]["id"], "c1");
    assert_eq!(answer["collections"][0]["count"], 1);
    let text = String::from_utf8_lossy(&run(dir.path(), &["collections"]).stdout).to_string();
    assert!(text.contains("Rust"), "{text}");
    assert!(text.contains("id: c1"), "{text}");

    let output = run(dir.path(), &["tags", "--json"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout_json(&output)["total"], 3);
    let text = String::from_utf8_lossy(&run(dir.path(), &["tags"]).stdout).to_string();
    assert!(text.contains("rust"), "{text}");

    let output = run(dir.path(), &["categories", "--json"]);
    assert_eq!(output.status.code(), Some(0));
    let answer = stdout_json(&output);
    let names: Vec<&str> = answer["categories"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["name"].as_str())
                .collect()
        })
        .unwrap_or_default();
    assert!(names.contains(&"development"), "{names:?}");
    assert!(names.contains(&"learning"), "{names:?}");
}

#[test]
fn the_search_filters_work_from_the_command_line() {
    let dir = seeded_dir();

    let output = run(
        dir.path(),
        &[
            "search",
            "",
            "--mode",
            "keyword",
            "--collection",
            "c1",
            "--added-after",
            "1970-01-01",
            "--added-before",
            "2030-01-01",
            "--json",
        ],
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(hit_ids(&stdout_json(&output), "hits"), vec!["r1"]);

    let output = run(
        dir.path(),
        &["search", "", "--favorites", "--mode", "keyword", "--json"],
    );
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(hit_ids(&stdout_json(&output), "hits"), vec!["r2"]);

    // A sentence answers instead of returning nothing, and says it was relaxed.
    let output = run(
        dir.path(),
        &[
            "search",
            "an article about memory safety in rust",
            "--mode",
            "keyword",
            "--json",
        ],
    );
    assert_eq!(output.status.code(), Some(0));
    let answer = stdout_json(&output);
    assert_eq!(hit_ids(&answer, "hits"), vec!["r1"]);
    assert!(
        answer["note"]
            .as_str()
            .unwrap_or_default()
            .contains("relaxed"),
        "{answer}"
    );
    assert_eq!(answer["hits"][0]["rank"], 1);
}

#[test]
fn the_cli_exit_codes_are_the_contract_a_script_depends_on() {
    let dir = seeded_dir();
    // 2: the command line itself is wrong.
    for args in [
        vec!["frobnicate"],
        vec!["search", "--mode"],
        vec!["search", "rust", "--nope"],
        vec!["search", "rust", "--limit", "lots"],
        vec!["search", "rust", "--limit", "9000"],
        vec!["get"],
        vec!["install"],
        vec!["install", "--client", "emacs", "--print"],
        vec!["add", "javascript:alert(1)"],
        // Two URLs are never one; joined they would queue a single broken address.
        vec!["add", "https://example.com/a", "https://example.com/b"],
        // Nothing to match on and nothing to narrow by.
        vec!["search", ""],
        vec!["search", "   ", "--mode", "keyword"],
    ] {
        let output = run(dir.path(), &args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(
            !output.stderr.is_empty(),
            "{args:?} must explain itself on stderr"
        );
    }

    // 1: it ran and failed.
    let output = run(dir.path(), &["get", "no-such-record"]);
    assert_eq!(output.status.code(), Some(1));
    let message = String::from_utf8_lossy(&output.stderr).to_string();
    assert!(message.contains("No bookmark matches"), "{message}");

    // 0: help and version answer without a library at all.
    for args in [vec!["--help"], vec!["--version"]] {
        let output = run(dir.path(), &args);
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        assert!(!output.stdout.is_empty(), "{args:?}");
    }
}

#[test]
fn an_unreadable_library_is_reported_as_an_error() {
    let dir = tempfile::tempdir().expect("temp dir");
    app_lib::library::save(
        dir.path(),
        &json!({ "version": 4, "resources": [] }).to_string(),
    )
    .expect("seed");

    let output = run(dir.path(), &["search", "anything", "--mode", "keyword"]);
    assert_eq!(output.status.code(), Some(1));
    let message = String::from_utf8_lossy(&output.stderr).to_string();
    assert!(message.contains("schema 4 is not supported"), "{message}");

    // `doctor` still answers, and the exit code carries the failure for scripts.
    let output = run(dir.path(), &["doctor", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(stdout_json(&output)["library"]["ok"], false);
}

#[test]
fn doctor_says_when_no_library_file_exists_yet() {
    let dir = tempfile::tempdir().expect("temp dir");
    let output = run(dir.path(), &["doctor", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    let library = &stdout_json(&output)["library"];
    assert_eq!(library["ok"], false);
    let detail = library["detail"].as_str().unwrap_or_default();
    assert!(detail.contains("open MYNK once"), "{detail}");
}

#[test]
fn a_machine_without_a_library_answers_empty() {
    let dir = tempfile::tempdir().expect("temp dir");
    let output = run(
        dir.path(),
        &["search", "anything", "--mode", "keyword", "--json"],
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(stdout_json(&output)["total"], 0);

    let output = run(dir.path(), &["stats", "--json"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout_json(&output)["total"], 0);
}
