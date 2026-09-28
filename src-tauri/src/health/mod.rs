//! Link health scanning: HEAD first with a GET fallback, 8 requests in flight (2 per host) across
//! all concurrent calls. Progress is emitted on `health-scan-progress`; a cancelled run returns
//! partial results.

pub mod challenge;

use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use futures::StreamExt;
use reqwest::{Client, Response, StatusCode};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::Url;

use crate::error::{
    find_source, is_tls_failure, root_cause_message, truncate_chars, AppResult,
    MAX_ERROR_BODY_CHARS,
};
use crate::http::guard::{check_url, AddressPolicy, BlockedAddressError, DnsLookupError};
use crate::http::{header_text, normalize_target_url};
use crate::settings;
use crate::state::AppState;
use crate::util::lock;

pub const PROGRESS_EVENT: &str = "health-scan-progress";
const CONCURRENCY: usize = 8;
const PER_HOST_CONCURRENCY: usize = 2;
/// Default per-request timeout; the effective value is `AppState::health_request_timeout`.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// How long one online probe answers for, as long as the outgoing route stays the same.
const ONLINE_PROBE_TTL: Duration = Duration::from_secs(30);
/// Host entries are swept of finished hosts once the map reaches this size.
const HOST_SWEEP_AT: usize = 256;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HealthErrorKind {
    None,
    Dns,
    Timeout,
    Tls,
    Refused,
    Http,
    Blocked,
    Other,
}

/// `LinkHealthResult` in ipcTypes.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkHealthResult {
    /// Exactly the URL string that was passed in (lets the renderer map results back).
    pub url: String,
    pub ok: bool,
    pub definitely_broken: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    pub preview_blocked: bool,
    pub error_kind: HealthErrorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Progress of one `check_links_health` call; `processed`/`total` count only this call's own
/// URLs, not cumulative across calls sharing a run id.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthScanProgressEvent {
    pub run_id: String,
    pub processed: usize,
    pub total: usize,
}

impl LinkHealthResult {
    fn failure(url: &str, kind: HealthErrorKind, definitely_broken: bool, error: String) -> Self {
        Self {
            url: url.to_string(),
            ok: false,
            definitely_broken,
            status: None,
            final_url: None,
            preview_blocked: false,
            error_kind: kind,
            error: Some(truncate_chars(&error, MAX_ERROR_BODY_CHARS)),
        }
    }
}

/// Status → (ok, definitely_broken, preview_blocked, error_kind).
pub fn classify_status(status: u16) -> (bool, bool, bool, HealthErrorKind) {
    match status {
        200..=399 => (true, false, false, HealthErrorKind::None),
        401 | 403 | 429 => (true, false, true, HealthErrorKind::None),
        404 | 410 => (false, true, false, HealthErrorKind::Http),
        _ => (false, false, false, HealthErrorKind::Http),
    }
}

/// Suffixes of names that only resolve inside a private network (intranet, VPN, home router)
/// or never resolve by design. A lookup failure for them says nothing about the link.
const PRIVATE_NAME_SUFFIXES: &[&str] = &[
    "local",
    "localhost",
    "localdomain",
    "lan",
    "home",
    "home.arpa",
    "corp",
    "internal",
    "intranet",
    "intra",
    "private",
    "priv",
    "test",
    "invalid",
    "example",
    "alt",
    "onion",
];

/// Is `host` a name the public internet is expected to resolve? False for single-label names
/// (`wiki`, `jira`) and for private or reserved suffixes (`jira.corp`, `nas.home.arpa`).
pub fn host_is_publicly_resolvable(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || !host.contains('.') {
        return false;
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    !PRIVATE_NAME_SUFFIXES.iter().any(|suffix| {
        host == *suffix
            || host
                .strip_suffix(suffix)
                .is_some_and(|rest| rest.ends_with('.'))
    })
}

/// A DNS failure proves a link is broken only when the name does not exist, the machine is online,
/// and the name is one the public internet should know. Intranet names fail off-VPN.
pub fn dns_failure_is_definitive(not_found: bool, online: bool, host: &str) -> bool {
    not_found && online && host_is_publicly_resolvable(host)
}

/// Error → (kind, definitely_broken). DNS "not found" is definitive only while online and
/// for publicly resolvable names.
pub fn classify_error(error: &reqwest::Error, online: bool) -> (HealthErrorKind, bool) {
    if find_source::<BlockedAddressError>(error).is_some() {
        return (HealthErrorKind::Blocked, false);
    }
    if error.is_timeout() {
        return (HealthErrorKind::Timeout, false);
    }
    if let Some(dns) = find_source::<DnsLookupError>(error) {
        return (
            HealthErrorKind::Dns,
            dns_failure_is_definitive(dns.not_found, online, &dns.host),
        );
    }
    if let Some(io) = find_source::<std::io::Error>(error) {
        match io.kind() {
            std::io::ErrorKind::ConnectionRefused => return (HealthErrorKind::Refused, false),
            std::io::ErrorKind::TimedOut => return (HealthErrorKind::Timeout, false),
            _ => {}
        }
    }
    let message = root_cause_message(error);
    if is_tls_failure(&message) {
        return (HealthErrorKind::Tls, false);
    }
    if message.to_ascii_lowercase().contains("refused") {
        return (HealthErrorKind::Refused, false);
    }
    (HealthErrorKind::Other, false)
}

fn from_response(url: &str, response: &Response) -> LinkHealthResult {
    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    let (mut ok, definitely_broken, mut preview_blocked, error_kind) = classify_status(status);
    let cf_mitigated = header_text(response, "cf-mitigated");
    if challenge::cf_mitigated_is_challenge(cf_mitigated.as_deref())
        || challenge::url_is_challenge(&final_url)
    {
        ok = true;
        preview_blocked = true;
    }
    let error = (!ok).then(|| format!("HTTP {status}"));
    LinkHealthResult {
        url: url.to_string(),
        ok,
        definitely_broken: definitely_broken && !preview_blocked,
        status: Some(status),
        final_url: Some(final_url),
        preview_blocked,
        error_kind,
        error,
    }
}

/// HEAD answers that should be confirmed with a GET (servers that mishandle HEAD).
fn needs_get_fallback(status: StatusCode) -> bool {
    matches!(status.as_u16(), 400 | 403 | 404 | 405 | 410 | 501)
}

fn retryable_with_get(error: &reqwest::Error) -> bool {
    !(error.is_timeout()
        || find_source::<DnsLookupError>(error).is_some()
        || find_source::<BlockedAddressError>(error).is_some())
}

/// Request limits shared by every `check_links_health` call, so concurrent chunks cannot
/// multiply the per-host or global budget.
pub struct HealthLimits {
    global: Arc<Semaphore>,
    /// Weak, so a host's entry dies with its last waiting or running request.
    hosts: Mutex<HashMap<String, Weak<Semaphore>>>,
}

impl Default for HealthLimits {
    fn default() -> Self {
        Self::new()
    }
}

impl HealthLimits {
    pub fn new() -> Self {
        Self {
            global: Arc::new(Semaphore::new(CONCURRENCY)),
            hosts: Mutex::new(HashMap::new()),
        }
    }

    fn host(&self, host: &str) -> Arc<Semaphore> {
        let mut hosts = lock(&self.hosts);
        if let Some(semaphore) = hosts.get(host).and_then(Weak::upgrade) {
            return semaphore;
        }
        if hosts.len() >= HOST_SWEEP_AT {
            hosts.retain(|_, entry| entry.strong_count() > 0);
        }
        let semaphore = Arc::new(Semaphore::new(PER_HOST_CONCURRENCY));
        hosts.insert(host.to_string(), Arc::downgrade(&semaphore));
        semaphore
    }

    /// Host slot first: a request queued behind a busy host must not hold a global slot.
    async fn acquire(
        &self,
        url: &Url,
    ) -> (Option<OwnedSemaphorePermit>, Option<OwnedSemaphorePermit>) {
        let host = match url.host_str() {
            Some(host) => self
                .host(&host.to_ascii_lowercase())
                .acquire_owned()
                .await
                .ok(),
            None => None,
        };
        let global = Arc::clone(&self.global).acquire_owned().await.ok();
        (host, global)
    }

    #[cfg(test)]
    fn tracked_hosts(&self) -> usize {
        lock(&self.hosts).len()
    }
}

/// The last online probe and the outgoing route it was made on.
#[derive(Default)]
pub struct OnlineCache {
    entry: tokio::sync::Mutex<Option<(Option<IpAddr>, Instant, bool)>>,
}

impl OnlineCache {
    /// Reuses a probe younger than `ONLINE_PROBE_TTL` made on the same `route`; concurrent
    /// callers wait for one probe instead of each running their own.
    pub async fn get<F, Fut>(&self, route: Option<IpAddr>, now: Instant, probe: F) -> bool
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = bool>,
    {
        let mut entry = self.entry.lock().await;
        if let Some((cached_route, at, online)) = *entry {
            if cached_route == route && now.saturating_duration_since(at) < ONLINE_PROBE_TTL {
                return online;
            }
        }
        let online = probe().await;
        *entry = Some((route, Instant::now(), online));
        online
    }
}

/// Local address of the default route; it changes when the machine changes networks. A UDP
/// `connect` sends nothing, and the target is a documentation address.
async fn outgoing_route() -> Option<IpAddr> {
    let socket = tokio::net::UdpSocket::bind(("0.0.0.0", 0)).await.ok()?;
    socket.connect(("192.0.2.1", 9)).await.ok()?;
    socket.local_addr().ok().map(|address| address.ip())
}

struct CheckContext<'a> {
    client: &'a Client,
    policy: AddressPolicy,
    online: bool,
    limits: &'a HealthLimits,
    timeout: Duration,
}

async fn check_one(ctx: &CheckContext<'_>, raw: &str, parsed: Option<&Url>) -> LinkHealthResult {
    let CheckContext {
        client,
        policy,
        online,
        limits,
        timeout,
    } = *ctx;
    let Some(url) = parsed else {
        return LinkHealthResult::failure(
            raw,
            HealthErrorKind::Other,
            false,
            "Invalid URL".to_string(),
        );
    };
    if let Err(error) = check_url(url, policy) {
        return LinkHealthResult::failure(raw, HealthErrorKind::Blocked, false, error.to_string());
    }

    let _permits = limits.acquire(url).await;

    let head = client.head(url.clone()).timeout(timeout).send().await;
    let response = match head {
        Ok(response) if needs_get_fallback(response.status()) => {
            drop(response);
            client.get(url.clone()).timeout(timeout).send().await
        }
        Ok(response) => Ok(response),
        Err(error) if retryable_with_get(&error) => {
            client.get(url.clone()).timeout(timeout).send().await
        }
        Err(error) => Err(error),
    };

    match response {
        // The body is never read: dropping the response closes the stream.
        Ok(response) => from_response(raw, &response),
        Err(error) => {
            let (kind, definitely_broken) = classify_error(&error, online);
            LinkHealthResult::failure(raw, kind, definitely_broken, root_cause_message(&error))
        }
    }
}

/// Distinguishes a nonexistent host from being offline; a test asserts against the same probe.
pub async fn network_online() -> bool {
    let lookup = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::lookup_host(("example.com", 443)),
    )
    .await;
    match lookup {
        Ok(Ok(mut addrs)) => addrs.next().is_some(),
        _ => false,
    }
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, run_id: &str, processed: usize, total: usize) {
    let payload = HealthScanProgressEvent {
        run_id: run_id.to_string(),
        processed,
        total,
    };
    if let Err(error) = app.emit(PROGRESS_EVENT, payload) {
        log::warn!("Could not emit health progress: {error}");
    }
}

pub async fn check_links<R: Runtime>(
    app: &AppHandle<R>,
    urls: Vec<String>,
    run_id: String,
) -> AppResult<Vec<LinkHealthResult>> {
    let state = app.state::<AppState>();
    let settings = settings::load(app).await?;
    let policy = AddressPolicy::for_web(settings.allow_private_network);
    let client = state.http.web(settings.allow_private_network).clone();
    let timeout = state.health_request_timeout();
    let total = urls.len();

    let (generation, token) = state.register_health_run(&run_id);
    emit_progress(app, &run_id, 0, total);
    if total == 0 {
        state.finish_health_run(&run_id, generation);
        return Ok(Vec::new());
    }

    let online = state
        .online_cache
        .get(outgoing_route().await, Instant::now(), network_online)
        .await;
    if !online {
        log::warn!("health scan: DNS probe failed, DNS errors will not be treated as definitive");
    }

    // Each future owns its data; a borrowed closure in `buffer_unordered` hits lifetime limits.
    let jobs: Vec<(usize, String, Option<Url>)> = urls
        .into_iter()
        .enumerate()
        .map(|(index, raw)| {
            let parsed = normalize_target_url(&raw).ok();
            (index, raw, parsed)
        })
        .collect();

    let limits = &state.health_limits;
    let mut results: Vec<Option<LinkHealthResult>> = (0..total).map(|_| None).collect();
    let mut processed = 0usize;
    let mut last_emitted = 0usize;
    let mut ticker = tokio::time::interval(PROGRESS_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    {
        let mut stream = futures::stream::iter(jobs)
            .map(|(index, raw, url)| {
                let client = client.clone();
                async move {
                    let ctx = CheckContext {
                        client: &client,
                        policy,
                        online,
                        limits,
                        timeout,
                    };
                    let result = check_one(&ctx, &raw, url.as_ref()).await;
                    (index, result)
                }
            })
            .buffer_unordered(CONCURRENCY);

        loop {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    log::info!("health scan {run_id} cancelled after {processed}/{total}");
                    break;
                }
                next = stream.next() => match next {
                    Some((index, result)) => {
                        results[index] = Some(result);
                        processed += 1;
                    }
                    None => break,
                },
                _ = ticker.tick() => {
                    if processed != last_emitted {
                        emit_progress(app, &run_id, processed, total);
                        last_emitted = processed;
                    }
                }
            }
        }
    }

    emit_progress(app, &run_id, processed, total);
    state.finish_health_run(&run_id, generation);
    Ok(results.into_iter().flatten().collect())
}

pub fn cancel<R: Runtime>(app: &AppHandle<R>, run_id: &str) {
    let cancelled = app.state::<AppState>().cancel_health_run(run_id);
    if !cancelled {
        log::debug!("cancel_health_scan: no active run {run_id}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_statuses_map_to_ok_broken_and_blocked_flags() {
        assert_eq!(
            classify_status(200),
            (true, false, false, HealthErrorKind::None)
        );
        assert_eq!(
            classify_status(301),
            (true, false, false, HealthErrorKind::None)
        );
        assert_eq!(
            classify_status(403),
            (true, false, true, HealthErrorKind::None)
        );
        assert_eq!(
            classify_status(429),
            (true, false, true, HealthErrorKind::None)
        );
        assert_eq!(
            classify_status(404),
            (false, true, false, HealthErrorKind::Http)
        );
        assert_eq!(
            classify_status(410),
            (false, true, false, HealthErrorKind::Http)
        );
        assert_eq!(
            classify_status(500),
            (false, false, false, HealthErrorKind::Http)
        );
        assert_eq!(
            classify_status(503),
            (false, false, false, HealthErrorKind::Http)
        );
    }

    #[test]
    fn intranet_and_reserved_names_are_not_publicly_resolvable() {
        for host in [
            "wiki",
            "wiki.",
            "JIRA",
            "jira.corp",
            "nas.home.arpa",
            "printer.local",
            "gitlab.internal",
            "portal.intranet",
            "router.lan",
            "box.home",
            "app.localdomain",
            "api.localhost",
            "localhost",
            "x.invalid",
            "site.test",
            "www.example",
            "127.0.0.1",
            "::1",
            "",
        ] {
            assert!(!host_is_publicly_resolvable(host), "{host}");
        }
        for host in [
            "example.com",
            "wiki.example.org",
            "corp.example.com",
            "mylocal.com",
            "intranet.company.de",
            "testing.io",
            "WWW.GITHUB.COM.",
        ] {
            assert!(host_is_publicly_resolvable(host), "{host}");
        }
    }

    #[test]
    fn dns_not_found_is_definitive_only_for_public_names_while_online() {
        assert!(dns_failure_is_definitive(true, true, "gone.example.com"));
        assert!(!dns_failure_is_definitive(true, false, "gone.example.com"));
        assert!(!dns_failure_is_definitive(false, true, "gone.example.com"));
        assert!(!dns_failure_is_definitive(true, true, "wiki"));
        assert!(!dns_failure_is_definitive(true, true, "jira.corp"));
    }

    #[test]
    fn failure_results_serialize_in_camel_case_without_status() {
        let result = LinkHealthResult::failure(
            "https://x.invalid",
            HealthErrorKind::Dns,
            true,
            "not found".into(),
        );
        let value = serde_json::to_value(&result).expect("serialize");
        assert_eq!(value["definitelyBroken"], true);
        assert_eq!(value["errorKind"], "dns");
        assert_eq!(value["previewBlocked"], false);
        assert!(value.get("status").is_none());
    }

    #[test]
    fn response_results_echo_the_input_url_verbatim() {
        // The renderer maps results back by `url`, so it must be the exact input string.
        let raw = "  HTTP://Example.COM/a?b=1#frag ";
        for status in [200u16, 403, 404, 500] {
            let response = Response::from(
                tauri::http::Response::builder()
                    .status(status)
                    .body(Vec::<u8>::new())
                    .expect("response"),
            );
            let result = from_response(raw, &response);
            assert_eq!(result.url, raw, "status {status}");
        }
        let failure = LinkHealthResult::failure(raw, HealthErrorKind::Dns, true, "x".into());
        assert_eq!(failure.url, raw);
    }

    #[tokio::test]
    async fn blocked_and_invalid_urls_are_not_definitive() {
        let client = Client::new();
        let limits = HealthLimits::new();
        let ctx = CheckContext {
            client: &client,
            policy: AddressPolicy::PublicOnly,
            online: true,
            limits: &limits,
            timeout: DEFAULT_REQUEST_TIMEOUT,
        };
        let url = Url::parse("http://127.0.0.1:9/").expect("url");
        let blocked = check_one(&ctx, "http://127.0.0.1:9/", Some(&url)).await;
        assert_eq!(blocked.error_kind, HealthErrorKind::Blocked);
        assert!(!blocked.ok && !blocked.definitely_broken);

        // Un-normalized input is echoed back unchanged.
        let raw = "HTTP://127.0.0.1:9";
        let normalized = normalize_target_url(raw).expect("normalize");
        let echoed = check_one(&ctx, raw, Some(&normalized)).await;
        assert_eq!(echoed.url, raw);

        let invalid = check_one(&ctx, "::::", None).await;
        assert_eq!(invalid.error_kind, HealthErrorKind::Other);
        assert_eq!(invalid.url, "::::");
    }

    #[tokio::test]
    async fn one_host_shares_one_slot_pool_and_finished_hosts_are_forgotten() {
        let limits = HealthLimits::new();
        let url = Url::parse("https://Example.com/a").expect("url");
        let first = limits.acquire(&url).await;
        let second = limits
            .acquire(&Url::parse("https://example.com/b").expect("url"))
            .await;
        assert!(first.0.is_some() && second.0.is_some());
        let third = tokio::time::timeout(Duration::from_millis(100), limits.acquire(&url)).await;
        assert!(third.is_err(), "a third request to one host must wait");
        drop((first, second));
        assert!(
            tokio::time::timeout(Duration::from_secs(1), limits.acquire(&url))
                .await
                .is_ok(),
            "a freed slot is reused"
        );

        for index in 0..HOST_SWEEP_AT + 8 {
            let url = Url::parse(&format!("https://h{index}.example/")).expect("url");
            drop(limits.acquire(&url).await);
        }
        assert!(
            limits.tracked_hosts() <= HOST_SWEEP_AT,
            "idle hosts are swept: {}",
            limits.tracked_hosts()
        );
    }

    #[tokio::test]
    async fn the_global_budget_holds_across_hosts() {
        let limits = HealthLimits::new();
        let mut held = Vec::new();
        for index in 0..CONCURRENCY {
            let url = Url::parse(&format!("https://h{index}.example/")).expect("url");
            held.push(limits.acquire(&url).await);
        }
        let extra = Url::parse("https://other.example/").expect("url");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), limits.acquire(&extra))
                .await
                .is_err(),
            "a ninth request must wait for a global slot"
        );
        held.pop();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), limits.acquire(&extra))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn the_online_probe_is_reused_until_it_expires_or_the_route_changes() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = OnlineCache::default();
        let probes = AtomicUsize::new(0);
        let probe = || async {
            probes.fetch_add(1, Ordering::SeqCst);
            true
        };
        let route: Option<IpAddr> = Some("192.168.1.20".parse().expect("ip"));
        let start = Instant::now();

        assert!(cache.get(route, start, probe).await);
        assert!(
            cache
                .get(route, start + Duration::from_secs(5), probe)
                .await
        );
        assert_eq!(probes.load(Ordering::SeqCst), 1, "a fresh probe is reused");

        let other: Option<IpAddr> = Some("10.0.0.7".parse().expect("ip"));
        cache
            .get(other, start + Duration::from_secs(6), probe)
            .await;
        assert_eq!(probes.load(Ordering::SeqCst), 2, "a new route probes again");

        cache
            .get(other, Instant::now() + ONLINE_PROBE_TTL, probe)
            .await;
        assert_eq!(probes.load(Ordering::SeqCst), 3, "an old probe expires");

        let offline = cache.get(None, Instant::now(), || async { false }).await;
        assert!(!offline, "losing the route is noticed at once");
    }
}
