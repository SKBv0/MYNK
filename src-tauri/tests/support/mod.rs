//! Shared fixtures for the integration tests: a real (mock-runtime) Tauri app wired to real
//! temporary directories and real HTTP clients, plus small binary fixtures.

pub mod server;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use app_lib::http::HttpClients;
use app_lib::settings::{AIProvider, PersistedSettings};
use app_lib::snapshot::backend::{Backend, ChromiumBackend};
use app_lib::state::AppState;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, AppHandle, Manager, State};
use tempfile::TempDir;

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique(tag: &str) -> String {
    format!(
        "mynk-it-{tag}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Settings that point every provider at a local test server and allow loopback traffic.
pub fn ollama_settings(base_url: &str) -> PersistedSettings {
    PersistedSettings {
        provider: AIProvider::Ollama,
        ollama_base_url: base_url.trim_end_matches('/').to_string(),
        ollama_model: "test-model".to_string(),
        openrouter_model: String::new(),
        embedding_model: String::new(),
        allow_private_network: true,
    }
}

/// A test app pointed at `server`, the shape every server-backed test needs.
pub fn app_for(server: &server::TestServer) -> TestApp {
    test_app(ollama_settings(&server.base()))
}

/// A test app whose provider address refuses every connection, for tests that must not reach one.
pub fn offline_app() -> TestApp {
    test_app(ollama_settings("http://127.0.0.1:1"))
}

/// A built (but not running) Tauri app on the mock runtime with `AppState` managed.
pub struct TestApp {
    app: App<MockRuntime>,
    _dir: TempDir,
    snapshot_dir: PathBuf,
    data_dir: PathBuf,
    store_dir: Option<PathBuf>,
    profile_dirs: Vec<PathBuf>,
}

/// Directories the mock app resolves under the real user profile, to be removed on drop: on
/// Windows no environment variable can send Tauri's path resolver to a temporary directory.
fn profile_dirs(app: &App<MockRuntime>, identifier: &str) -> Vec<PathBuf> {
    let path = app.path();
    [
        path.app_data_dir(),
        path.app_local_data_dir(),
        path.app_config_dir(),
        path.app_cache_dir(),
        path.app_log_dir(),
    ]
    .into_iter()
    .flatten()
    // Nothing but a folder named after this app's own throwaway identifier is ever deleted.
    .filter(|dir| dir.file_name().is_some_and(|name| name == identifier))
    .collect()
}

impl Drop for TestApp {
    fn drop(&mut self) {
        for dir in &self.profile_dirs {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

pub fn test_app(settings: PersistedSettings) -> TestApp {
    build_app(
        settings,
        false,
        Backend::Disabled("snapshot backend disabled in tests".into()),
    )
}

/// A test app whose snapshot backend is whatever this machine really offers.
pub fn test_app_with_real_backend(settings: PersistedSettings) -> TestApp {
    build_app(settings, false, Backend::detect())
}

pub fn test_app_with_backend(settings: PersistedSettings, backend: Backend) -> TestApp {
    build_app(settings, false, backend)
}

/// Like [`test_app`] but with the store plugin installed and no primed settings cache.
pub fn test_app_with_store() -> TestApp {
    build_app(
        PersistedSettings::default(),
        true,
        Backend::Disabled("snapshot backend disabled in tests".into()),
    )
}

fn build_app(settings: PersistedSettings, with_store: bool, backend: Backend) -> TestApp {
    let dir = tempfile::tempdir().expect("temp dir");
    let snapshot_dir = dir.path().join("snapshots");
    let data_dir = dir.path().join("data");
    std::fs::create_dir_all(&snapshot_dir).expect("snapshot dir");
    std::fs::create_dir_all(&data_dir).expect("data dir");

    let identifier = unique("app");
    let mut context = mock_context(noop_assets());
    context.config_mut().identifier = identifier.clone();

    let builder = if with_store {
        mock_builder().plugin(tauri_plugin_store::Builder::default().build())
    } else {
        mock_builder()
    };
    let app = builder.build(context).expect("build mock app");
    app.manage(AppState::new(
        HttpClients::new().expect("http clients"),
        snapshot_dir.clone(),
        data_dir.clone(),
        backend,
    ));
    if !with_store {
        app.state::<AppState>().set_cached_settings(settings);
    }

    // The store plugin resolves names against the data dir, which is not the config dir under XDG.
    let store_dir = with_store.then(|| app.path().app_data_dir().ok()).flatten();
    let profile_dirs = profile_dirs(&app, &identifier);

    TestApp {
        app,
        _dir: dir,
        snapshot_dir,
        data_dir,
        store_dir,
        profile_dirs,
    }
}

impl TestApp {
    pub fn handle(&self) -> AppHandle<MockRuntime> {
        self.app.handle().clone()
    }

    pub fn app(&self) -> &App<MockRuntime> {
        &self.app
    }

    pub fn state(&self) -> State<'_, AppState> {
        self.app.state::<AppState>()
    }

    pub fn snapshot_dir(&self) -> &PathBuf {
        &self.snapshot_dir
    }

    pub fn data_dir(&self) -> &PathBuf {
        &self.data_dir
    }

    /// Replaces the cached settings (no disk access; `settings::load` reads the cache first).
    pub fn set_settings(&self, settings: PersistedSettings) {
        self.state().set_cached_settings(settings);
    }

    /// Directory the store plugin writes `settings.store.json` into, when it is installed.
    pub fn store_dir(&self) -> Option<&PathBuf> {
        self.store_dir.as_ref()
    }
}

/// 1x1 transparent PNG.
pub const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

/// JFIF header + EOI: enough for magic-byte sniffing.
pub const JPEG: &[u8] = &[
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
];

pub const WEBP: &[u8] =
    b"RIFF\x1a\x00\x00\x00WEBPVP8 \x0e\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00";

pub const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;";

pub const ICO: &[u8] = &[
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00, 0x04, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
];

pub const SAFE_SVG: &[u8] =
    br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#0af"/><a href="#top"/></svg>"##;

pub const UNSAFE_SVG: &[u8] =
    br#"<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('https://evil.example')</script></svg>"#;

/// A realistic article page with og:image, favicon link, meta description and >1000 words.
pub fn article_html(words: usize) -> String {
    let body: String = (0..words).map(|i| format!("word{i} ")).collect::<String>();
    format!(
        r#"<!doctype html><html lang="en-GB"><head>
<title>Ownership in Rust | The Book</title>
<meta name="description" content="How ownership, borrowing and lifetimes work in Rust.">
<meta property="og:title" content="Ownership in Rust">
<meta property="og:image" content="/media/cover.png">
<link rel="icon" href="/static/favicon.png">
<script>var tracking = 'never included';</script>
</head><body>
<nav>Home Docs Blog</nav>
<article><h1>Ownership</h1><p>Every value in Rust has a single owner.</p><p>{body}</p></article>
<footer>Copyright</footer>
</body></html>"#
    )
}

/// A Cloudflare managed-challenge interstitial, trimmed but structurally faithful.
pub const CF_INTERSTITIAL: &str = r#"<!DOCTYPE html><html lang="en-US"><head>
<title>Just a moment...</title><meta http-equiv="refresh" content="390">
</head><body><div class="main-wrapper" role="main"><div class="main-content">
<noscript><div class="h2"><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></div></noscript>
</div></div><script>(function(){window._cf_chl_opt={cvId: '3',cZone: "example.com",cType: 'managed'};
var cpo=document.createElement('script');cpo.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=8a1b2c3d';
document.getElementsByTagName('head')[0].appendChild(cpo);}());</script></body></html>"#;

/// Set in CI: a machine without a capture browser then fails the browser tests instead of
/// skipping them.
const REQUIRE_BROWSER_ENV: &str = "MYNK_REQUIRE_BROWSER";

/// This machine's capture browser; `None` (the test is skipped) where nothing is installed.
pub fn capture_browser() -> Option<ChromiumBackend> {
    match Backend::detect() {
        Backend::Chromium(backend) => Some(backend),
        Backend::Disabled(reason) => {
            assert!(
                std::env::var_os(REQUIRE_BROWSER_ENV).is_none(),
                "{REQUIRE_BROWSER_ENV} is set, but there is no capture browser: {reason}"
            );
            eprintln!("skipping: no capture runtime on this machine");
            None
        }
    }
}

/// A page with almost no readable text but with a title and a description.
pub const THIN_HTML: &str = r#"<!doctype html><html><head>
<title>Tiny</title><meta name="description" content="A very small page."></head>
<body><main><p>Hi.</p></main></body></html>"#;

/// A page with neither readable text nor metadata.
pub const BARE_HTML: &str = "<!doctype html><html><head></head><body><main>ok</main></body></html>";
