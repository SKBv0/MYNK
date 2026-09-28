//! Page snapshots in `<app cache dir>/snapshots`. The browser runs outside the SSRF guard:
//! `vet_browser_target` vets the target and pins its resolved IP (captures also pass `preflight`),
//! but only that first URL. Redirects inside the browser and sub-resources resolve unguarded.

pub mod backend;
pub mod cleanup;
pub mod media;

use std::net::IpAddr;
use std::time::Duration;

use reqwest::dns::{Name, Resolve};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

use crate::error::{find_source, AppError, AppResult};
use crate::health::challenge::{self, ChallengeInput, EXCERPT_BYTES};
use crate::health::classify_status;
use crate::http::body::{decode_text, read_limited, Overflow};
use crate::http::guard::{check_url, AddressPolicy, BlockedAddressError, GuardedResolver};
use crate::http::{header_text, normalize_target_url};
use crate::settings;
use crate::state::{next_temp_id, run_blocking, AppState};
use backend::{reason, Backend, HostPin};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotKind {
    Image,
    Challenge,
    Error,
    RuntimeMissing,
}

/// `SnapshotResult` in ipcTypes.ts. `reason` is a stable code, never a path or process output.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResult {
    pub kind: SnapshotKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SnapshotResult {
    fn reason(kind: SnapshotKind, code: &'static str) -> Self {
        Self {
            kind,
            file_name: None,
            reason: Some(code.to_string()),
        }
    }
}

/// Stable file name: first 16 bytes of SHA-256(url) as hex + `.png`.
pub fn snapshot_file_name(url: &Url) -> String {
    format!("{}.png", cleanup::short_hash(url.as_str().as_bytes(), 16))
}

/// Longest wait for the pre-flight's response headers.
const PREFLIGHT_HEADERS_TIMEOUT: Duration = Duration::from_secs(15);
/// Longest wait for the pre-flight's body excerpt; a page whose body never ends is still
/// captured with the remaining budget.
const PREFLIGHT_BODY_TIMEOUT: Duration = Duration::from_secs(5);

/// What the guarded pre-flight request found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Preflight {
    /// The page is behind a security verification wall or answers 401/403.
    Challenge,
    /// The page answered with an error status; a capture would only show the error page.
    HttpError { status: u16 },
    /// Safe to capture: the URL the guarded client ended on, plus the vetted address
    /// its host resolves to (`None` for an IP literal, which needs no lookup).
    Ready { url: Url, pin: Option<HostPin> },
}

/// One guarded GET before the expensive capture, since the browser itself has no SSRF guard:
/// detects challenge walls and error statuses, and reports the final URL to capture.
pub async fn preflight<R: Runtime>(app: &AppHandle<R>, url: &Url) -> AppResult<Preflight> {
    let deadline = Instant::now() + app.state::<AppState>().snapshot_timeout();
    preflight_until(app, url, deadline).await
}

/// [`preflight`] within the capture budget ending at `deadline`. Headers that do not arrive in
/// time are `AppError::Timeout`; a slow body only cuts the challenge excerpt short.
async fn preflight_until<R: Runtime>(
    app: &AppHandle<R>,
    url: &Url,
    deadline: Instant,
) -> AppResult<Preflight> {
    let settings = settings::load(app).await?;
    let policy = AddressPolicy::for_web(settings.allow_private_network);
    check_url(url, policy)?;

    let send = app
        .state::<AppState>()
        .http
        .web(settings.allow_private_network)
        .get(url.clone())
        .send();
    let headers_deadline = deadline.min(Instant::now() + PREFLIGHT_HEADERS_TIMEOUT);
    let response = tokio::time::timeout_at(headers_deadline, send)
        .await
        .map_err(|_| AppError::Timeout("Snapshot pre-check: the request timed out.".into()))?
        .map_err(|e| AppError::from_reqwest("Snapshot pre-check failed", &e))?;

    let status = response.status().as_u16();
    let final_url = response.url().clone();
    let cf_mitigated = header_text(&response, "cf-mitigated");
    let content_type = header_text(&response, reqwest::header::CONTENT_TYPE);
    let body_deadline = deadline.min(Instant::now() + PREFLIGHT_BODY_TIMEOUT);
    let bytes = tokio::time::timeout_at(
        body_deadline,
        read_limited(
            response,
            EXCERPT_BYTES,
            Overflow::Truncate,
            "Snapshot pre-check",
        ),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or_default();
    // Decoding and lowercasing up to `EXCERPT_BYTES` is CPU work, so it leaves the async runtime.
    let final_url_text = final_url.to_string();
    let is_challenge = run_blocking(move || {
        let body = decode_text(&bytes, content_type.as_deref());
        Ok(challenge::is_challenge(&ChallengeInput {
            status,
            final_url: &final_url_text,
            cf_mitigated: cf_mitigated.as_deref(),
            body: &body,
        }))
    })
    .await?;
    if is_challenge {
        return Ok(Preflight::Challenge);
    }
    // 401/403 are a wall to get past; 408/425/429 and 5xx pass on their own, so they stay
    // retryable and are not remembered as a challenge.
    if matches!(status, 401 | 403) {
        return Ok(Preflight::Challenge);
    }
    let (ok, _, _, _) = classify_status(status);
    if !ok || matches!(status, 408 | 425 | 429) {
        return Ok(Preflight::HttpError { status });
    }

    let pin = vet_browser_target(&final_url, policy).await?;
    Ok(Preflight::Ready {
        url: final_url,
        pin,
    })
}

/// The guarded half of [`preflight`]: validates a URL the browser is about to open on its own
/// terms (not only as a redirect hop) and resolves the address it must be pinned to.
pub async fn vet_browser_target(url: &Url, policy: AddressPolicy) -> AppResult<Option<HostPin>> {
    check_url(url, policy)?;
    pin_for(url, policy).await
}

/// Resolves `url`'s host through the guard's resolver and returns the address the browser must
/// use. IP literals need no pin (they were validated by `check_url`).
async fn pin_for(url: &Url, policy: AddressPolicy) -> AppResult<Option<HostPin>> {
    let Some(Host::Domain(domain)) = url.host() else {
        return Ok(None);
    };
    if !HostPin::is_pinnable_host(domain) {
        return Err(AppError::BlockedAddress(format!(
            "The host \"{domain}\" cannot be pinned for capture."
        )));
    }
    let name: Name = domain
        .parse()
        .map_err(|_| AppError::invalid_input(format!("Invalid host name \"{domain}\".")))?;
    let addresses = GuardedResolver::new(policy)
        .resolve(name)
        .await
        .map_err(|error| {
            match find_source::<BlockedAddressError>(error.as_ref() as &dyn std::error::Error) {
                Some(blocked) => AppError::BlockedAddress(blocked.to_string()),
                None => AppError::network(format!("Snapshot pre-check failed: {error}")),
            }
        })?;
    let ip: IpAddr = addresses
        .map(|address| address.ip())
        .next()
        .ok_or_else(|| AppError::network(format!("The host {domain} could not be found.")))?;
    Ok(Some(HostPin {
        host: domain.to_string(),
        ip,
    }))
}

/// Captures a snapshot. Validation / infrastructure problems are `Err(AppError)`; page-level
/// outcomes (challenge wall, error status, timeout, cancellation, no runtime) are `Ok(kind)`.
pub async fn capture<R: Runtime>(app: &AppHandle<R>, raw_url: &str) -> AppResult<SnapshotResult> {
    let state = app.state::<AppState>();
    let cancel = state.snapshot_cancel_token();
    let cancelled = || SnapshotResult::reason(SnapshotKind::Error, reason::CANCELLED);
    let url = normalize_target_url(raw_url)?;
    let settings = settings::load(app).await?;
    check_url(&url, AddressPolicy::for_web(settings.allow_private_network))?;

    let backend = match &state.snapshot_backend {
        Backend::Chromium(backend) => backend.clone(),
        Backend::Disabled(detail) => {
            log::debug!("snapshot capture unavailable: {detail}");
            return Ok(SnapshotResult::reason(
                SnapshotKind::RuntimeMissing,
                reason::RUNTIME_UNAVAILABLE,
            ));
        }
    };

    // The permit covers the pre-flight too: a queue of captures must not fire every pre-check.
    let permit = tokio::select! {
        biased;
        () = cancel.cancelled() => return Ok(cancelled()),
        permit = state.snapshot_permits.clone().acquire_owned() => permit,
    };
    let _permit = permit.map_err(|_| AppError::internal("Snapshot queue is closed."))?;

    // The budget starts once the capture may run, so time spent queued is not counted.
    let deadline = Instant::now() + state.snapshot_timeout();
    let preflight = tokio::select! {
        biased;
        () = cancel.cancelled() => return Ok(cancelled()),
        preflight = preflight_until(app, &url, deadline) => preflight,
    };
    // The pre-check's failure is fatal: the browser has no SSRF guard of its own.
    let (target, pin) = match preflight {
        Err(AppError::Timeout(_)) => {
            return Ok(SnapshotResult::reason(
                SnapshotKind::Error,
                reason::CAPTURE_TIMEOUT,
            ))
        }
        Err(error) => return Err(error),
        Ok(Preflight::Challenge) => {
            return Ok(SnapshotResult::reason(
                SnapshotKind::Challenge,
                reason::SECURITY_VERIFICATION_WALL,
            ))
        }
        Ok(Preflight::HttpError { status }) => {
            log::debug!("snapshot pre-check answered HTTP {status}; nothing is captured");
            return Ok(SnapshotResult::reason(
                SnapshotKind::Error,
                reason::HTTP_ERROR,
            ));
        }
        Ok(Preflight::Ready { url, pin }) => (url, pin),
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining < backend::MIN_CAPTURE_BUDGET {
        return Ok(SnapshotResult::reason(
            SnapshotKind::Error,
            reason::CAPTURE_TIMEOUT,
        ));
    }

    let dir = state.snapshot_dir.clone();
    let create_dir = dir.clone();
    run_blocking(move || Ok(std::fs::create_dir_all(create_dir)?)).await?;
    // The file is named after the URL the renderer asked for, not the redirect target.
    let file_name = snapshot_file_name(&url);
    // Unique temp name so concurrent captures of the same URL never share a file.
    let tmp_name = format!(
        "{}-{}.tmp.png",
        file_name.trim_end_matches(".png"),
        next_temp_id()
    );
    let tmp_path = dir.join(&tmp_name);

    match backend
        .capture(&target, pin.as_ref(), &tmp_path, remaining, &cancel)
        .await
    {
        Ok(()) => {
            if let Err(error) = tokio::fs::rename(&tmp_path, dir.join(&file_name)).await {
                // A left-behind `.tmp.png` counts against the cache budget and is never evicted.
                let _ = tokio::fs::remove_file(&tmp_path).await;
                return Err(error.into());
            }
            Ok(SnapshotResult {
                kind: SnapshotKind::Image,
                file_name: Some(file_name),
                reason: None,
            })
        }
        Err(failure) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            if failure.is_cancelled() {
                return Ok(cancelled());
            }
            // The code is safe for the release log; the detail may hold paths and stderr.
            log::warn!("snapshot capture failed: {}", failure.code);
            log::debug!("snapshot capture failure detail: {}", failure.detail);
            let kind = if failure.runtime_missing {
                SnapshotKind::RuntimeMissing
            } else {
                SnapshotKind::Error
            };
            Ok(SnapshotResult::reason(kind, failure.code))
        }
    }
}

/// Renders `url` on its own permits (not [`capture`]'s) and returns the serialized DOM; `None`
/// when there is no browser, no time left or the run failed. Shares [`capture`]'s guard and pin.
pub async fn render_dom<R: Runtime>(
    app: &AppHandle<R>,
    url: &Url,
    policy: AddressPolicy,
    budget: Duration,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Option<String> {
    let state = app.state::<AppState>();
    let Backend::Chromium(backend) = &state.snapshot_backend else {
        return None;
    };
    let backend = backend.clone();
    let pin = match vet_browser_target(url, policy).await {
        Ok(pin) => pin,
        Err(error) => {
            log::debug!("render: the target was refused: {error}");
            return None;
        }
    };

    let permits = state.render_permits.clone();
    // Queuing is bounded by the caller's deadline: past this point a whole budget does not fit.
    let queue_until = deadline.checked_sub(budget)?;
    let permit = tokio::select! {
        biased;
        () = cancel.cancelled() => return None,
        permit = tokio::time::timeout_at(queue_until, permits.acquire_owned()) => permit,
    };
    let _permit = permit.ok()?.ok()?;
    // The budget starts here, so the browser never pays for the time the queue took.
    if deadline.saturating_duration_since(Instant::now()) < budget {
        return None;
    }
    match backend.dump_dom(url, pin.as_ref(), budget, cancel).await {
        Ok(dom) => Some(dom),
        Err(failure) => {
            log::debug!("render: the browser could not render the page: {failure}");
            None
        }
    }
}

pub async fn save_uploaded_preview<R: Runtime>(
    app: &AppHandle<R>,
    resource_id: String,
    bytes: Vec<u8>,
    ext: &str,
) -> AppResult<String> {
    let ext = cleanup::ImageExt::parse(ext)?;
    let dir = app.state::<AppState>().snapshot_dir.clone();
    run_blocking(move || cleanup::save_uploaded_preview(&dir, &resource_id, &bytes, ext)).await
}

pub async fn delete<R: Runtime>(app: &AppHandle<R>, file_names: Vec<String>) -> AppResult<()> {
    let dir = app.state::<AppState>().snapshot_dir.clone();
    run_blocking(move || cleanup::delete_snapshots(&dir, &file_names)).await
}

/// Factory reset: deletes every snapshot file, uploads included (only in-flight temp files
/// survive). Returns the number of deleted files.
pub async fn reset<R: Runtime>(app: &AppHandle<R>) -> AppResult<u32> {
    let dir = app.state::<AppState>().snapshot_dir.clone();
    run_blocking(move || cleanup::reset_snapshots(&dir)).await
}

/// Current size of the snapshot directory in bytes.
pub async fn dir_bytes<R: Runtime>(app: &AppHandle<R>) -> AppResult<u64> {
    let dir = app.state::<AppState>().snapshot_dir.clone();
    run_blocking(move || cleanup::dir_bytes(&dir)).await
}

/// Start-up maintenance: prune unreferenced files + enforce the 500 MB size cap.
pub async fn maintain<R: Runtime>(
    app: &AppHandle<R>,
    keep: Vec<String>,
) -> AppResult<cleanup::MaintenanceReport> {
    let dir = app.state::<AppState>().snapshot_dir.clone();
    run_blocking(move || cleanup::maintain(&dir, &keep, cleanup::MAX_CACHE_BYTES)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_is_stable_hash() {
        let url = Url::parse("https://example.com/").expect("url");
        let name = snapshot_file_name(&url);
        assert_eq!(name.len(), 32 + 4);
        assert_eq!(name, snapshot_file_name(&url));
        assert!(cleanup::is_safe_file_name(&name));
    }

    #[test]
    fn an_http_error_serializes_as_an_error_with_its_code() {
        let value = serde_json::to_value(SnapshotResult::reason(
            SnapshotKind::Error,
            reason::HTTP_ERROR,
        ))
        .expect("serialize");
        assert_eq!(value["kind"], "error");
        assert_eq!(value["reason"], "httpError");
    }

    #[test]
    fn a_budget_too_small_to_render_never_launches_a_browser() {
        assert!(
            backend::MIN_CAPTURE_BUDGET >= Duration::from_secs(1),
            "a launch that cannot even fast-forward the page is wasted"
        );
        assert!(backend::MIN_CAPTURE_BUDGET < super::backend::SNAPSHOT_TIMEOUT);
    }

    #[test]
    fn serializes_contract_shape() {
        let value = serde_json::to_value(SnapshotResult::reason(
            SnapshotKind::RuntimeMissing,
            reason::RUNTIME_UNAVAILABLE,
        ))
        .expect("serialize");
        assert_eq!(value["kind"], "runtimeMissing");
        assert_eq!(value["reason"], "runtimeUnavailable");
        assert!(value.get("fileName").is_none());
    }
}
