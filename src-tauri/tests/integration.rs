//! End-to-end integration tests for the Rust backend, against real infrastructure: a real HTTP
//! server, real temp dirs, real SQLite, a real (mock-runtime) Tauri app. No external network.

mod support;

#[path = "it/guard.rs"]
mod guard;

#[path = "it/body.rs"]
mod body;

#[path = "it/analyze.rs"]
mod analyze;

#[path = "it/chat.rs"]
mod chat;

#[path = "it/health.rs"]
mod health;

#[path = "it/media.rs"]
mod media;

#[path = "it/snapshot.rs"]
mod snapshot;

#[path = "it/library.rs"]
mod library;

#[path = "it/catalog.rs"]
mod catalog;

#[path = "it/mcp.rs"]
mod mcp;

#[path = "it/agents.rs"]
mod agents;

#[path = "it/semantic.rs"]
mod semantic;

#[path = "it/browsers.rs"]
mod browsers;

#[path = "it/settings.rs"]
mod settings;
