//! Tauri command handlers. Thin: argument mapping + delegation to the domain modules.
//! Arguments are camelCase on the JS side (Tauri 2 default).

pub mod agents;
pub mod ai;
pub mod browsers;
pub mod health;
pub mod library;
pub mod media;
pub mod providers;
pub mod settings;
pub mod system;
