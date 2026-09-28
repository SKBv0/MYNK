//! AI settings through the real `tauri-plugin-store` file, plus the keyring boundary.

use std::fs;

use app_lib::commands::settings::{
    get_ai_settings, set_openrouter_api_key, update_ai_settings, MAX_API_KEY_CHARS,
};
use app_lib::settings::{self, store, AIProvider, AISettingsUpdate, PersistedSettings};
use serde_json::json;

use crate::support::test_app_with_store;

fn update(base_url: &str) -> AISettingsUpdate {
    AISettingsUpdate {
        provider: AIProvider::Openrouter,
        ollama_base_url: base_url.to_string(),
        ollama_model: "  qwen3:8b  ".to_string(),
        openrouter_model: " acme/model-x ".to_string(),
        embedding_model: String::new(),
        allow_private_network: true,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_survive_a_real_store_round_trip() {
    let app = test_app_with_store();
    let handle = app.handle();

    // A fresh profile has no store file yet.
    assert_eq!(
        settings::load(&handle).await.expect("defaults"),
        PersistedSettings::default()
    );

    let saved = PersistedSettings {
        provider: AIProvider::Openrouter,
        ollama_base_url: "http://127.0.0.1:11434".to_string(),
        ollama_model: "qwen3:8b".to_string(),
        openrouter_model: "acme/model-x".to_string(),
        embedding_model: String::new(),
        allow_private_network: true,
    };
    settings::save(&handle, saved.clone()).await.expect("save");

    let file = app
        .store_dir()
        .expect("store dir")
        .join("settings.store.json");
    assert!(file.is_file(), "the store must be written to disk");
    let raw: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&file).expect("read")).expect("json");
    assert_eq!(raw["ai"]["provider"], json!("openrouter"));
    assert_eq!(raw["ai"]["allowPrivateNetwork"], json!(true));

    // Read back through the store (not the in-memory cache).
    assert_eq!(store::load(&handle).expect("store load"), saved);
}

/// The store writes into the real user profile, so the fixture has to take it back: a test run
/// must not leave `mynk-it-app-*` folders behind in the developer's data directory.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_test_app_takes_its_profile_directory_with_it() {
    let dir = {
        let app = test_app_with_store();
        settings::save(&app.handle(), PersistedSettings::default())
            .await
            .expect("save");
        let dir = app.store_dir().expect("store dir").clone();
        assert!(
            dir.join("settings.store.json").is_file(),
            "the store must have written into {}",
            dir.display()
        );
        dir
    };
    assert!(!dir.exists(), "{} outlived the test", dir.display());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_corrupt_store_entry_falls_back_to_defaults() {
    let app = test_app_with_store();
    let dir = app.store_dir().expect("store dir").clone();
    fs::create_dir_all(&dir).expect("store dir");
    fs::write(
        dir.join("settings.store.json"),
        r#"{"ai":"this is not a settings object"}"#,
    )
    .expect("write");

    let loaded = store::load(&app.handle()).expect("load must not fail");
    assert_eq!(loaded, PersistedSettings::default());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_update_command_normalizes_and_reports_the_contract_shape() {
    let app = test_app_with_store();
    let handle = app.handle();
    // An unreachable credential store must not stop settings from being saved or shown.
    let result = update_ai_settings(handle.clone(), update("127.0.0.1:11434/"))
        .await
        .expect("update");
    let value = serde_json::to_value(&result).expect("serialize");
    assert_eq!(value["ollamaBaseUrl"], json!("http://127.0.0.1:11434"));
    assert_eq!(
        value["ollamaModel"],
        json!("qwen3:8b"),
        "values are trimmed"
    );
    assert_eq!(value["openrouterModel"], json!("acme/model-x"));
    assert_eq!(value["provider"], json!("openrouter"));
    assert_eq!(value["allowPrivateNetwork"], json!(true));
    assert!(value["hasOpenrouterApiKey"].is_boolean());

    let reloaded =
        serde_json::to_value(get_ai_settings(handle).await.expect("get")).expect("serialize");
    assert_eq!(reloaded, value, "get must mirror what update returned");

    // Invalid base URLs are rejected at save time.
    for bad in [
        "file:///etc/passwd",
        "http://user:pw@host",
        "http://host/?q=1",
    ] {
        let error = update_ai_settings(app.handle(), update(bad))
            .await
            .expect_err(bad);
        assert_eq!(error.kind(), "config", "{bad}");
    }
}

/// A cache-miss load reads disk while a save may be running; the cache must end up holding
/// whatever was saved, never a stale on-disk value.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cold_load_never_overwrites_a_concurrent_save() {
    let app = test_app_with_store();
    let handle = app.handle();

    for round in 0..8 {
        // Force the cold path again: the next load really goes through the store.
        app.state().clear_cached_settings();
        let saved = PersistedSettings {
            ollama_model: format!("model-{round}"),
            allow_private_network: round % 2 == 0,
            ..PersistedSettings::default()
        };

        let (loaded, stored) = tokio::join!(
            settings::load(&handle),
            settings::save(&handle, saved.clone())
        );
        stored.expect("save");
        loaded.expect("load");

        assert_eq!(
            app.state().cached_settings().expect("cache"),
            saved,
            "round {round}: a stale load put the old value back into the cache"
        );
        assert_eq!(
            settings::load(&handle).await.expect("reload"),
            saved,
            "round {round}: the next load must see the saved value"
        );
    }
}

/// Only the read path is checked; a write would clobber the developer's real OpenRouter key.
/// Ignored off Windows, where CI may have no reachable credential store.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[cfg_attr(
    not(windows),
    ignore = "needs an unlocked desktop credential store; run with --ignored"
)]
async fn the_credential_store_is_reachable() {
    if let Err(error) = settings::has_api_key().await {
        panic!("the OS credential store could not be read: {error}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn api_keys_are_validated_before_the_credential_store_is_touched() {
    let empty = set_openrouter_api_key("   ".to_string())
        .await
        .expect_err("empty key");
    assert_eq!(empty.kind(), "invalidInput");

    let pasted_page = "x".repeat(MAX_API_KEY_CHARS + 1);
    let too_long = set_openrouter_api_key(pasted_page)
        .await
        .expect_err("oversized key");
    assert_eq!(too_long.kind(), "invalidInput");
    assert!(too_long.to_string().contains("too long"), "{too_long}");
}
