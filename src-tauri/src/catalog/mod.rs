//! Agent access to the MYNK library, shared by the app and the separate `mynk-mcp` binary.
//! Nothing under this module may import `tauri::`, write `library.json`, or return a file path.

pub mod embed;
mod fold_tables;
pub mod inbox;
pub mod model;
pub mod search;
pub mod semantic;
pub mod text;
pub mod views;
