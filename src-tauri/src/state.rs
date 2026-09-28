//! Application state shared by all commands (`app.manage(AppState)`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::browsers::registry::ProfileRegistry;
use crate::error::AppResult;
use crate::health::{HealthLimits, OnlineCache};
use crate::http::HttpClients;
use crate::settings::PersistedSettings;
use crate::snapshot::backend::{Backend, SNAPSHOT_TIMEOUT};
use crate::util::lock;

/// Maximum concurrent snapshot captures (each one is a headless browser process).
const SNAPSHOT_CONCURRENCY: usize = 2;

/// Maximum concurrent rendered-DOM fallbacks (a headless browser process each, like a capture).
const RENDER_CONCURRENCY: usize = 2;

/// Process-wide counter behind [`next_temp_id`].
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

/// `<pid>-<counter>`: unique for every temporary file this process creates, and distinct from
/// the temp names of any other process writing into the same directory.
pub fn next_temp_id() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    )
}

pub struct AppState {
    pub http: HttpClients,
    /// `<app cache dir>/snapshots`, the only directory the asset protocol may serve.
    pub snapshot_dir: PathBuf,
    /// `<app data dir>`; library.json lives here.
    pub data_dir: PathBuf,
    pub snapshot_backend: Backend,
    pub snapshot_permits: Arc<Semaphore>,
    /// Permits of the analysis fallback's browser runs. Separate from `snapshot_permits` so a
    /// queue of previews and a batch of analyses never starve each other.
    pub render_permits: Arc<Semaphore>,
    /// Serializes library reads and writes (tmp file + rename).
    pub library_lock: tokio::sync::Mutex<()>,
    /// Serializes a cache-miss settings load against a settings save, so a load that started
    /// before a save can never put the stale on-disk value back into the cache.
    pub settings_lock: tokio::sync::Mutex<()>,
    pub profiles: ProfileRegistry,
    settings_cache: Mutex<Option<PersistedSettings>>,
    health_runs: Mutex<HashMap<String, (u64, CancellationToken)>>,
    next_run_generation: AtomicU64,
    /// In-flight cancellable requests, keyed by request id.
    requests: Arc<Mutex<HashMap<String, (u64, CancellationToken)>>>,
    /// Per-request timeout of link health checks, in milliseconds. Per app instance (not a
    /// global) so an integration test can shorten it without affecting other tests.
    health_request_timeout_ms: AtomicU64,
    /// Per-host and global link-check limits, shared by concurrent `check_links_health` calls.
    pub health_limits: HealthLimits,
    pub online_cache: OnlineCache,
    /// Cancelled and replaced by `cancel_snapshot_captures`; captures clone it when they start.
    snapshot_cancel: Mutex<CancellationToken>,
    /// Whole-capture budget in milliseconds; per instance so a test can shorten it.
    snapshot_timeout_ms: AtomicU64,
}

/// Registration of a cancellable request; removes itself from the registry when dropped.
pub struct RequestGuard {
    id: String,
    generation: u64,
    token: CancellationToken,
    registry: Arc<Mutex<HashMap<String, (u64, CancellationToken)>>>,
}

impl RequestGuard {
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        let mut requests = lock(&self.registry);
        if requests
            .get(&self.id)
            .is_some_and(|(current, _)| *current == self.generation)
        {
            requests.remove(&self.id);
        }
    }
}

impl AppState {
    pub fn new(
        http: HttpClients,
        snapshot_dir: PathBuf,
        data_dir: PathBuf,
        snapshot_backend: Backend,
    ) -> Self {
        Self {
            http,
            snapshot_dir,
            data_dir,
            snapshot_backend,
            snapshot_permits: Arc::new(Semaphore::new(SNAPSHOT_CONCURRENCY)),
            render_permits: Arc::new(Semaphore::new(RENDER_CONCURRENCY)),
            library_lock: tokio::sync::Mutex::new(()),
            settings_lock: tokio::sync::Mutex::new(()),
            profiles: ProfileRegistry::default(),
            settings_cache: Mutex::new(None),
            health_runs: Mutex::new(HashMap::new()),
            next_run_generation: AtomicU64::new(1),
            requests: Arc::new(Mutex::new(HashMap::new())),
            health_request_timeout_ms: AtomicU64::new(duration_ms(
                crate::health::DEFAULT_REQUEST_TIMEOUT,
            )),
            health_limits: HealthLimits::new(),
            online_cache: OnlineCache::default(),
            snapshot_cancel: Mutex::new(CancellationToken::new()),
            snapshot_timeout_ms: AtomicU64::new(duration_ms(SNAPSHOT_TIMEOUT)),
        }
    }

    /// Budget of one snapshot capture, pre-flight included.
    pub fn snapshot_timeout(&self) -> Duration {
        Duration::from_millis(self.snapshot_timeout_ms.load(Ordering::Relaxed))
    }

    /// Test hook: overrides [`AppState::snapshot_timeout`] (at least 1 ms).
    pub fn set_snapshot_timeout(&self, timeout: Duration) {
        self.snapshot_timeout_ms
            .store(duration_ms(timeout).max(1), Ordering::Relaxed);
    }

    /// The token a capture starting now listens to.
    pub fn snapshot_cancel_token(&self) -> CancellationToken {
        lock(&self.snapshot_cancel).clone()
    }

    /// Cancels every capture started so far; later captures get a fresh token.
    pub fn cancel_snapshot_captures(&self) {
        let previous = std::mem::take(&mut *lock(&self.snapshot_cancel));
        previous.cancel();
    }

    /// Timeout applied to every HEAD/GET of a link health check.
    pub fn health_request_timeout(&self) -> Duration {
        Duration::from_millis(self.health_request_timeout_ms.load(Ordering::Relaxed))
    }

    /// Test hook: overrides [`AppState::health_request_timeout`] (at least 1 ms).
    pub fn set_health_request_timeout(&self, timeout: Duration) {
        self.health_request_timeout_ms
            .store(duration_ms(timeout).max(1), Ordering::Relaxed);
    }

    pub fn cached_settings(&self) -> Option<PersistedSettings> {
        lock(&self.settings_cache).clone()
    }

    pub fn set_cached_settings(&self, settings: PersistedSettings) {
        *lock(&self.settings_cache) = Some(settings);
    }

    /// Test hook: drops the cache so the next `settings::load` goes through the store again,
    /// which is the only way to exercise the cold path.
    pub fn clear_cached_settings(&self) {
        *lock(&self.settings_cache) = None;
    }

    /// Registers a health scan run; an existing run with the same id is cancelled first.
    /// Returns the run generation (used by `finish_health_run`) and its cancellation token.
    pub fn register_health_run(&self, run_id: &str) -> (u64, CancellationToken) {
        let generation = self.next_run_generation.fetch_add(1, Ordering::Relaxed);
        let token = CancellationToken::new();
        if let Some((_, previous)) =
            lock(&self.health_runs).insert(run_id.to_string(), (generation, token.clone()))
        {
            previous.cancel();
        }
        (generation, token)
    }

    pub fn cancel_health_run(&self, run_id: &str) -> bool {
        match lock(&self.health_runs).get(run_id) {
            Some((_, token)) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Registers a cancellable request. A previous request with the same id is cancelled.
    pub fn register_request(&self, request_id: &str) -> RequestGuard {
        let generation = self.next_run_generation.fetch_add(1, Ordering::Relaxed);
        let token = CancellationToken::new();
        if let Some((_, previous)) =
            lock(&self.requests).insert(request_id.to_string(), (generation, token.clone()))
        {
            previous.cancel();
        }
        RequestGuard {
            id: request_id.to_string(),
            generation,
            token,
            registry: Arc::clone(&self.requests),
        }
    }

    /// Cancels an in-flight request; returns false when no such request is running.
    pub fn cancel_request(&self, request_id: &str) -> bool {
        match lock(&self.requests).get(request_id) {
            Some((_, token)) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Removes the run only if it was not replaced by a newer run with the same id.
    pub fn finish_health_run(&self, run_id: &str, generation: u64) {
        let mut runs = lock(&self.health_runs);
        if runs
            .get(run_id)
            .is_some_and(|(current, _)| *current == generation)
        {
            runs.remove(run_id);
        }
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// Runs blocking work off the async runtime. Not cancellable: dropping the future only stops
/// waiting, so long work must bound its own cost or poll a `CancellationToken` itself.
pub async fn run_blocking<T, F>(work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AppState {
        AppState::new(
            HttpClients::new().expect("clients"),
            std::env::temp_dir(),
            std::env::temp_dir(),
            Backend::Disabled("test".into()),
        )
    }

    #[test]
    fn request_registry_cancels_and_cleans_up() {
        let state = state();
        let guard = state.register_request("r1");
        assert!(!guard.token().is_cancelled());
        assert!(state.cancel_request("r1"));
        assert!(guard.token().is_cancelled());
        drop(guard);
        assert!(!state.cancel_request("r1"));
    }

    #[test]
    fn health_request_timeout_is_per_instance() {
        let first = state();
        let second = state();
        assert_eq!(
            first.health_request_timeout(),
            crate::health::DEFAULT_REQUEST_TIMEOUT
        );
        first.set_health_request_timeout(Duration::from_millis(250));
        assert_eq!(first.health_request_timeout(), Duration::from_millis(250));
        assert_eq!(
            second.health_request_timeout(),
            crate::health::DEFAULT_REQUEST_TIMEOUT
        );
        first.set_health_request_timeout(Duration::ZERO);
        assert_eq!(first.health_request_timeout(), Duration::from_millis(1));
    }

    #[test]
    fn cancelling_captures_spares_the_ones_started_later() {
        let state = state();
        let running = state.snapshot_cancel_token();
        state.cancel_snapshot_captures();
        assert!(running.is_cancelled());
        let later = state.snapshot_cancel_token();
        assert!(!later.is_cancelled());
        state.cancel_snapshot_captures();
        assert!(later.is_cancelled());
    }

    #[test]
    fn snapshot_timeout_defaults_and_can_be_shortened() {
        let state = state();
        assert_eq!(state.snapshot_timeout(), SNAPSHOT_TIMEOUT);
        state.set_snapshot_timeout(Duration::from_millis(1500));
        assert_eq!(state.snapshot_timeout(), Duration::from_millis(1500));
    }

    #[test]
    fn temp_ids_never_repeat() {
        let ids: Vec<String> = (0..64).map(|_| next_temp_id()).collect();
        let unique: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
        assert!(ids
            .iter()
            .all(|id| id.starts_with(&format!("{}-", std::process::id()))));
    }

    #[test]
    fn re_registering_cancels_previous_and_keeps_newer() {
        let state = state();
        let first = state.register_request("same");
        let second = state.register_request("same");
        assert!(first.token().is_cancelled());
        drop(first);
        assert!(state.cancel_request("same"));
        assert!(second.token().is_cancelled());
    }
}
