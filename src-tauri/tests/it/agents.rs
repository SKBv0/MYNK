//! The agent bridge commands against a real (mock-runtime) Tauri app: reading and acknowledging
//! the inbox an agent wrote, the Agents-tab status, and the heartbeat the second process reads.

use std::fs;

use app_lib::catalog::inbox::{self, InboxEntry};
use app_lib::commands::agents::{
    ack_agent_inbox, get_agent_bridge_info, peek_agent_inbox, remove_running, write_running,
};
use app_lib::mcp::running;
use app_lib::paths::inbox_dir;
use app_lib::util::now_ms;

use crate::support::offline_app;

fn entry(url: &str) -> InboxEntry {
    InboxEntry {
        url: url.to_string(),
        title: Some("Ownership in Rust".into()),
        tags: vec!["rust".into()],
        note: Some("read this".into()),
        source: "mcp:claude-code".into(),
        created_at: 1_757_000_000_000,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_app_reads_and_then_acknowledges_what_an_agent_wrote() {
    let app = offline_app();
    let dir = app.data_dir().clone();

    assert_eq!(inbox::count(app.data_dir()), 0);
    assert!(peek_agent_inbox(app.state())
        .await
        .expect("peek an empty inbox")
        .is_empty());

    inbox::write(&dir, &entry("https://doc.rust-lang.org/book/")).expect("agent write");
    inbox::write(&dir, &entry("https://tokio.rs/")).expect("agent write 2");
    assert_eq!(inbox::count(app.data_dir()), 2);

    let pending = peek_agent_inbox(app.state()).await.expect("peek");
    assert_eq!(pending.len(), 2);
    let first = pending
        .iter()
        .find(|file| file.entry.url == "https://doc.rust-lang.org/book/")
        .expect("the entry survived the round trip");
    assert_eq!(first.entry.title.as_deref(), Some("Ownership in Rust"));
    assert_eq!(first.entry.tags, vec!["rust"]);
    assert_eq!(first.entry.note.as_deref(), Some("read this"));
    assert_eq!(first.entry.source, "mcp:claude-code");
    assert_eq!(first.entry.created_at, 1_757_000_000_000);

    // Peeking consumes nothing: an import that never reached the disk can retry.
    assert_eq!(inbox::count(app.data_dir()), 2);
    assert_eq!(
        peek_agent_inbox(app.state()).await.expect("peek again"),
        pending
    );

    ack_agent_inbox(app.state(), vec![first.name.clone()])
        .await
        .expect("ack one");
    assert_eq!(inbox::count(app.data_dir()), 1);
    let left = peek_agent_inbox(app.state()).await.expect("peek");
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].entry.url, "https://tokio.rs/");

    ack_agent_inbox(app.state(), vec![left[0].name.clone()])
        .await
        .expect("ack the rest");
    assert_eq!(inbox::count(app.data_dir()), 0);
    assert!(peek_agent_inbox(app.state())
        .await
        .expect("peek an emptied inbox")
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acknowledging_a_bad_name_is_refused_and_deletes_nothing() {
    let app = offline_app();
    let dir = app.data_dir().clone();
    let name = inbox::write(&dir, &entry("https://example.com/a")).expect("agent write");

    for bad in ["../library.json", "..\\library.json", "sub/other.json"] {
        let error = ack_agent_inbox(app.state(), vec![bad.to_string()])
            .await
            .expect_err("rejected");
        assert_eq!(error.kind(), "invalidInput", "{bad}");
    }
    // A batch with one bad name deletes nothing at all.
    let error = ack_agent_inbox(app.state(), vec![name, "../library.json".into()])
        .await
        .expect_err("rejected batch");
    assert_eq!(error.kind(), "invalidInput");
    assert_eq!(inbox::count(app.data_dir()), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_entries_cross_the_boundary_as_camel_case() {
    let app = offline_app();
    inbox::write(app.data_dir(), &entry("https://example.com/a")).expect("agent write");

    let pending = peek_agent_inbox(app.state()).await.expect("peek");
    let value = serde_json::to_value(&pending).expect("serialize");
    let first = &value[0];
    assert!(
        first["name"].as_str().is_some_and(|n| n.ends_with(".json")),
        "{value}"
    );
    let entry = &first["entry"];
    assert_eq!(entry["url"], "https://example.com/a");
    assert_eq!(entry["createdAt"], 1_757_000_000_000i64);
    assert_eq!(entry["source"], "mcp:claude-code");
    assert!(entry.get("created_at").is_none(), "{value}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_broken_entry_does_not_block_the_others() {
    let app = offline_app();
    let dir = app.data_dir().clone();
    inbox::write(&dir, &entry("https://example.com/good")).expect("agent write");
    fs::write(inbox_dir(&dir).join("100-00000000.json"), "{ not json").expect("broken entry");

    let pending = peek_agent_inbox(app.state()).await.expect("peek");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].entry.url, "https://example.com/good");
    // The unreadable file is set aside by the read itself, so it is not pending.
    assert!(inbox_dir(&dir).join("100-00000000.json.bad").is_file());
    assert_eq!(inbox::count(app.data_dir()), 1);

    ack_agent_inbox(app.state(), vec![pending[0].name.clone()])
        .await
        .expect("ack");
    assert_eq!(inbox::count(app.data_dir()), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_bridge_reports_the_inbox_and_the_heartbeat() {
    let app = offline_app();
    let dir = app.data_dir().clone();

    let info = get_agent_bridge_info(app.state()).await.expect("info");
    assert_eq!(info.inbox_pending, 0);
    assert!(!running::app_is_running(&dir, now_ms()), "no heartbeat yet");
    // The test binary has no `mynk-mcp` sibling; a missing binary is reported as absent.
    assert_eq!(info.mcp_path, None);
    assert!(!info.mcp_available);

    inbox::write(&dir, &entry("https://example.com/a")).expect("agent write");
    write_running(&dir, now_ms()).expect("heartbeat");
    let info = get_agent_bridge_info(app.state()).await.expect("info");
    assert_eq!(info.inbox_pending, 1);
    assert!(
        running::app_is_running(&dir, now_ms()),
        "a fresh heartbeat means the app is open"
    );
    assert!(running::read(&dir).is_some());

    // A heartbeat older than the limit: the process was killed without deleting the file.
    let stale = now_ms() - running::FRESH_MS - 1_000;
    let raw = serde_json::json!({ "pid": 4242, "startedAt": stale, "heartbeatAt": stale });
    fs::write(running::path(&dir), raw.to_string()).expect("stale heartbeat");
    assert!(!running::app_is_running(&dir, now_ms()));

    remove_running(&dir);
    assert!(!running::path(&dir).exists());
    assert!(!running::app_is_running(&dir, now_ms()));
}
