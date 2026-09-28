//! MYNK desktop backend.

// Public for `tests/`'s integration tests (built as an `rlib`); not a stable API.
pub mod analyze;
pub mod browsers;
pub mod catalog;
pub mod commands;
pub mod error;
pub mod health;
pub mod http;
pub mod library;
pub mod mcp;
pub mod paths;
pub mod providers;
pub mod settings;
pub mod snapshot;
pub mod state;
pub mod util;

use tauri::plugin::TauriPlugin;
use tauri::{Manager, Runtime, Url};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use commands::agents::RunningFile;
use http::HttpClients;
use snapshot::backend::Backend;
use state::AppState;

const LOG_MAX_FILE_BYTES: u128 = 2 * 1024 * 1024;

/// Logging is active in release builds too: warnings to the OS log dir with a single rotated
/// file. Debug builds log at Info to stdout as well. Secrets are never logged.
fn log_plugin<R: Runtime>() -> TauriPlugin<R> {
    let builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .rotation_strategy(RotationStrategy::KeepOne)
        .max_file_size(LOG_MAX_FILE_BYTES)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("hyper_util", log::LevelFilter::Warn)
        .level_for("html5ever", log::LevelFilter::Warn)
        .level_for("selectors", log::LevelFilter::Warn)
        // Every rejected certificate is logged at Error here and again, with the URL, by the app.
        .level_for("rustls_platform_verifier", log::LevelFilter::Off)
        // A repo with no release answers 404 on every silent check; the renderer reports that.
        .level_for("tauri_plugin_updater", log::LevelFilter::Off);
    let builder = if cfg!(debug_assertions) {
        builder
            .level(log::LevelFilter::Info)
            .target(Target::new(TargetKind::Stdout))
            .target(Target::new(TargetKind::LogDir { file_name: None }))
    } else {
        builder
            .level(log::LevelFilter::Warn)
            .target(Target::new(TargetKind::LogDir { file_name: None }))
    };
    builder.build()
}

/// Top-level navigation is limited to the app itself. External links must go through
/// `open_external_url`.
fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            host == "tauri.localhost"
                || (cfg!(debug_assertions) && matches!(host, "localhost" | "127.0.0.1"))
        }
        _ => false,
    }
}

/// Name of the updater plugin's entry in `tauri.conf.json#plugins`.
const UPDATER_PLUGIN: &str = "updater";

/// Environment variable that repoints the update check at another `latest.json`, for end-to-end
/// tests against a local server. The published address lives in `tauri.conf.json`.
const UPDATE_ENDPOINT_ENV: &str = "MYNK_UPDATE_ENDPOINT";

/// Validates an endpoint override; the compiled public key stays in place. Only `https` passes,
/// plus loopback `http` in debug builds, so a release build never starts with a plain endpoint.
fn normalize_update_endpoint(raw: &str, debug_build: bool) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let url = Url::parse(value).ok()?;
    // `host_str` keeps the brackets of an IPv6 literal.
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    );
    match url.scheme() {
        "https" => Some(url.to_string()),
        "http" if loopback && debug_build => Some(url.to_string()),
        _ => None,
    }
}

/// Rewrites `plugins.updater.endpoints` before the app is built; the plugin reads its config once.
fn apply_update_endpoint(
    plugins: &mut std::collections::HashMap<String, serde_json::Value>,
    endpoint: &str,
) {
    let Some(updater) = plugins
        .get_mut(UPDATER_PLUGIN)
        .and_then(|c| c.as_object_mut())
    else {
        log::warn!("{UPDATE_ENDPOINT_ENV} is set but the updater is not configured; ignoring it.");
        return;
    };
    updater.insert(
        "endpoints".to_string(),
        serde_json::Value::Array(vec![serde_json::Value::String(endpoint.to_string())]),
    );
    log::warn!("Update endpoint overridden by {UPDATE_ENDPOINT_ENV}: {endpoint}");
}

fn navigation_guard<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::<R, ()>::new("navigation-guard")
        .on_navigation(|_webview, url| {
            let allowed = navigation_allowed(url);
            if !allowed {
                log::warn!(
                    "Blocked navigation to {}://{}",
                    url.scheme(),
                    url.host_str().unwrap_or_default()
                );
            }
            allowed
        })
        .build()
}

fn setup_state<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let paths = app.path();
    let snapshot_dir = paths.app_cache_dir()?.join("snapshots");
    let data_dir = paths.app_data_dir()?;
    std::fs::create_dir_all(&snapshot_dir)?;
    std::fs::create_dir_all(&data_dir)?;
    // Agents write here while the app is closed; mynk-mcp must not have to create it itself.
    std::fs::create_dir_all(paths::inbox_dir(&data_dir))?;
    // The single-instance guard already rules out a concurrent writer of this temp file.
    library::sweep_orphan_temp(&data_dir);
    library::prune_corrupt_copies(&data_dir, library::MAX_CORRUPT_COPIES);
    snapshot::cleanup::sweep_temp_files(&snapshot_dir);
    // A crash (release builds abort on panic) can leave a full places.sqlite copy in %TEMP%.
    let swept = browsers::firefox::sweep_temp_copies(browsers::firefox::TEMP_COPY_MAX_AGE);
    if swept > 0 {
        log::info!("removed {swept} stale Firefox bookmark copies from the temp directory");
    }
    // A killed or crashed capture leaves its whole throwaway browser profile behind.
    let profiles =
        snapshot::cleanup::sweep_capture_profiles(snapshot::cleanup::CAPTURE_PROFILE_MAX_AGE);
    if profiles > 0 {
        log::debug!("removed {profiles} stale capture profiles from the temp directory");
    }

    // The static `assetProtocol.scope` glob is what grants access in practice; this grant only
    // supplements it.
    if let Err(error) = app
        .asset_protocol_scope()
        .allow_directory(&snapshot_dir, false)
    {
        log::warn!("Could not extend the asset protocol scope: {error}");
    }

    let backend = Backend::detect();
    if let Backend::Disabled(reason) = &backend {
        log::info!("Snapshot capture disabled: {reason}");
    }

    app.manage(AppState::new(
        HttpClients::new()?,
        snapshot_dir,
        data_dir.clone(),
        backend,
    ));
    // Lets a second process (`mynk-mcp`) know whether MYNK is open.
    app.manage(commands::agents::start_heartbeat(data_dir));
    Ok(())
}

/// Release builds abort on panic with no console, so route it through the log plugin first.
fn install_panic_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("MYNK panicked: {info}");
        log::logger().flush();
        default_hook(info);
    }));
}

/// A start-up failure is written to the log file and stderr, and exits non-zero instead of
/// aborting without a window or log.
fn exit_after_startup_failure(error: &tauri::Error) -> ! {
    log::error!("MYNK could not start: {error}");
    log::logger().flush();
    eprintln!("MYNK could not start: {error}");
    std::process::exit(1);
}

pub fn run() {
    install_panic_logger();
    let mut context = tauri::generate_context!();
    if let Some(endpoint) = std::env::var(UPDATE_ENDPOINT_ENV)
        .ok()
        .and_then(|raw| normalize_update_endpoint(&raw, cfg!(debug_assertions)))
    {
        apply_update_endpoint(&mut context.config_mut().plugins.0, &endpoint);
    }
    let mut builder = tauri::Builder::default();
    // Tauri requires this plugin first; it also keeps a second launch off library.json.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                // A hidden window ignores unminimize/focus on its own.
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
        // The updater does the signed check/download/install; process supplies the relaunch.
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    builder
        // The log plugin goes in before every other plugin and `setup`, or their output is lost.
        .plugin(log_plugin())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(navigation_guard())
        .setup(|app| {
            setup_state(app).inspect_err(|error| log::error!("Start-up setup failed: {error}"))
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(running) = window.app_handle().try_state::<RunningFile>() {
                    running.stop();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_ai_settings,
            commands::settings::update_ai_settings,
            commands::settings::set_openrouter_api_key,
            commands::settings::clear_openrouter_api_key,
            commands::providers::list_ollama_models,
            commands::providers::list_openrouter_models,
            commands::providers::test_provider_connection,
            commands::ai::analyze_url,
            commands::ai::chat_complete,
            commands::ai::chat_stream,
            commands::ai::cancel_request,
            commands::health::check_links_health,
            commands::health::cancel_health_scan,
            commands::media::get_snapshot_dir,
            commands::media::capture_snapshot,
            commands::media::cancel_snapshot_captures,
            commands::media::save_uploaded_preview,
            commands::media::delete_snapshots,
            commands::media::reset_snapshots,
            commands::media::maintain_snapshots,
            commands::media::snapshot_dir_bytes,
            commands::media::cache_remote_image,
            commands::library::library_load,
            commands::library::library_save,
            commands::library::export_library,
            commands::library::reveal_in_folder,
            commands::system::open_external_url,
            commands::browsers::detect_browsers,
            commands::browsers::read_browser_bookmarks,
            commands::agents::peek_agent_inbox,
            commands::agents::ack_agent_inbox,
            commands::agents::get_agent_bridge_info,
        ])
        .build(context)
        .unwrap_or_else(|error| exit_after_startup_failure(&error))
        // `build` + `run` (not `run(context)`) so the exit event is observed for heartbeat cleanup.
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(running) = app.try_state::<RunningFile>() {
                    running.stop();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_is_limited_to_the_app_origin() {
        let url = |s: &str| Url::parse(s).expect("url");
        assert!(navigation_allowed(&url(
            "http://tauri.localhost/index.html"
        )));
        assert!(navigation_allowed(&url("tauri://localhost/")));
        assert!(!navigation_allowed(&url("https://evil.example/")));
        assert!(!navigation_allowed(&url("file:///C:/Windows/win.ini")));
        assert!(!navigation_allowed(&url("javascript:alert(1)")));
    }

    #[test]
    fn update_endpoint_override_only_takes_safe_addresses() {
        assert_eq!(
            normalize_update_endpoint("https://example.com/latest.json", false).as_deref(),
            Some("https://example.com/latest.json")
        );
        // Loopback http passes in debug builds only; a release build keeps the configured endpoint.
        assert_eq!(
            normalize_update_endpoint("http://127.0.0.1:8787/latest.json", true).as_deref(),
            Some("http://127.0.0.1:8787/latest.json")
        );
        assert_eq!(
            normalize_update_endpoint("http://[::1]:8787/latest.json", true).as_deref(),
            Some("http://[::1]:8787/latest.json")
        );
        assert_eq!(
            normalize_update_endpoint("http://127.0.0.1:8787/latest.json", false),
            None
        );
        assert_eq!(
            normalize_update_endpoint("http://example.com/latest.json", true),
            None
        );
        assert_eq!(normalize_update_endpoint("  ", true), None);
        assert_eq!(normalize_update_endpoint("not a url", true), None);
        assert_eq!(
            normalize_update_endpoint("file:///C:/latest.json", true),
            None
        );
    }

    #[test]
    fn update_endpoint_override_replaces_the_configured_list() {
        let mut plugins = std::collections::HashMap::from([(
            UPDATER_PLUGIN.to_string(),
            serde_json::json!({ "pubkey": "k", "endpoints": ["https://example.com/a.json"] }),
        )]);
        apply_update_endpoint(&mut plugins, "http://127.0.0.1:8787/latest.json");
        assert_eq!(
            plugins[UPDATER_PLUGIN]["endpoints"],
            serde_json::json!(["http://127.0.0.1:8787/latest.json"])
        );
        assert_eq!(plugins[UPDATER_PLUGIN]["pubkey"], serde_json::json!("k"));

        let mut empty = std::collections::HashMap::new();
        apply_update_endpoint(&mut empty, "https://example.com/latest.json");
        assert!(empty.is_empty());
    }

    /// Without `createUpdaterArtifacts` the installer ships unsigned; without a key and an
    /// endpoint every update check fails.
    #[test]
    fn updater_is_configured_for_signed_artifacts() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], true);
        let updater = &conf["plugins"][UPDATER_PLUGIN];
        let pubkey = updater["pubkey"].as_str().unwrap_or_default();
        assert!(!pubkey.is_empty(), "the updater needs a public key");
        let endpoints = updater["endpoints"]
            .as_array()
            .expect("endpoints must be a list");
        assert!(!endpoints.is_empty(), "the updater needs an endpoint");
        for endpoint in endpoints {
            let url = endpoint.as_str().expect("endpoints are strings");
            assert!(
                url.starts_with("https://"),
                "updater endpoint {url} must use https"
            );
        }
    }

    /// The renderer may only check, install and restart from the process plugin.
    #[test]
    fn capabilities_grant_only_the_update_permissions() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("capabilities/default.json");
        let permissions: Vec<&str> = capability["permissions"]
            .as_array()
            .expect("permissions must be a list")
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        assert!(permissions.contains(&"updater:default"));
        assert!(permissions.contains(&"process:allow-restart"));
        assert!(!permissions.contains(&"process:default"));
    }

    /// A `$APPCACHE` pattern in the static scope is not expanded, so every cached image would be
    /// refused.
    #[test]
    fn asset_protocol_scope_is_a_literal_glob() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let scope = conf["app"]["security"]["assetProtocol"]["scope"]
            .as_array()
            .expect("assetProtocol.scope must be a list");
        assert!(!scope.is_empty(), "asset protocol scope must not be empty");
        for entry in scope {
            let pattern = entry.as_str().expect("scope entries are strings");
            assert!(
                !pattern.contains('$'),
                "scope pattern {pattern} uses a variable, which this protocol does not expand"
            );
        }
        assert!(
            scope
                .iter()
                .any(|e| e.as_str().is_some_and(|p| p.contains("snapshots"))),
            "the snapshot directory must stay readable through the asset protocol"
        );
    }
}
