//! The embedding index behind [`crate::catalog::semantic`]: settings, the Ollama client, and the
//! SQLite vector store, none of it Tauri-aware. Nothing is pulled or deleted on the server; the
//! index is derived data that any search can rebuild.

pub mod index;
pub mod ollama;
pub mod settings_file;
