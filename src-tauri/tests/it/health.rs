//! Link health scanning against a real server: status classification, HEAD→GET fallback,
//! concurrency limits, progress events and cancellation.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::commands::health::{cancel_health_scan, check_links_health};
use app_lib::health::{network_online, HealthErrorKind, LinkHealthResult, PROGRESS_EVENT};
use serde_json::Value;
use tauri::Listener;

use crate::support::server::{Reply, TestServer};
use crate::support::{app_for, ollama_settings, test_app};

const UNRESOLVABLE: &str = "http://mynk-nonexistent-host.invalid/page";

fn by_url(results: &[LinkHealthResult]) -> HashMap<String, LinkHealthResult> {
    results.iter().map(|r| (r.url.clone(), r.clone())).collect()
}

fn routes(server: &TestServer) {
    server.route("/ok", |_| Reply::html("fine"));
    server.route("/moved", |_| Reply::redirect(301, "/ok"));
    server.route("/gone", |_| Reply::status(410));
    server.route("/missing", |_| Reply::status(404));
    server.route("/forbidden", |_| Reply::status(403));
    server.route("/ratelimited", |_| Reply::status(429));
    server.route("/boom", |_| Reply::status(500));
    server.route("/refuse", |_| Reply::Close);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn statuses_are_classified_per_the_ipc_contract() {
    let server = TestServer::start().await;
    routes(&server);
    let app = app_for(&server);
    let urls: Vec<String> = [
        "/ok",
        "/moved",
        "/gone",
        "/missing",
        "/forbidden",
        "/ratelimited",
        "/boom",
        "/refuse",
    ]
    .iter()
    .map(|path| server.url(path))
    .chain(std::iter::once(UNRESOLVABLE.to_string()))
    .chain(std::iter::once("::not a url::".to_string()))
    .collect();

    let results = check_links_health(app.handle(), urls.clone(), "run-status".to_string())
        .await
        .expect("scan");
    assert_eq!(results.len(), urls.len());
    for (result, url) in results.iter().zip(&urls) {
        assert_eq!(&result.url, url, "results must echo the input verbatim");
    }
    let map = by_url(&results);

    let ok = &map[&server.url("/ok")];
    assert!(ok.ok && !ok.definitely_broken && !ok.preview_blocked);
    assert_eq!(ok.status, Some(200));

    let moved = &map[&server.url("/moved")];
    assert!(moved.ok, "redirects are healthy");
    assert_eq!(moved.status, Some(200));
    assert_eq!(moved.final_url.as_deref(), Some(server.url("/ok").as_str()));

    for path in ["/gone", "/missing"] {
        let dead = &map[&server.url(path)];
        assert!(!dead.ok, "{path}");
        assert!(dead.definitely_broken, "{path} must be definitely broken");
        assert_eq!(dead.error_kind, HealthErrorKind::Http, "{path}");
    }

    for path in ["/forbidden", "/ratelimited"] {
        let walled = &map[&server.url(path)];
        assert!(walled.ok, "{path} is reachable, just not previewable");
        assert!(walled.preview_blocked, "{path}");
        assert!(!walled.definitely_broken, "{path}");
    }

    let boom = &map[&server.url("/boom")];
    assert!(!boom.ok && !boom.definitely_broken);
    assert_eq!(boom.error_kind, HealthErrorKind::Http);

    let refused = &map[&server.url("/refuse")];
    assert!(!refused.ok && !refused.definitely_broken);

    let dns = &map[UNRESOLVABLE];
    assert_eq!(dns.error_kind, HealthErrorKind::Dns);
    assert!(
        !dns.definitely_broken,
        "a reserved .invalid name is never proof, online or not"
    );

    let invalid = &map["::not a url::"];
    assert_eq!(invalid.error_kind, HealthErrorKind::Other);
    assert!(!invalid.definitely_broken, "unparseable input is not proof");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unresolvable_intranet_names_are_not_definitely_broken() {
    let server = TestServer::start().await;
    let app = app_for(&server);
    let online = network_online().await;
    let urls = vec![
        "http://mynk-nonexistent-intranet-host/".to_string(),
        "http://mynk-nonexistent-host.corp/".to_string(),
    ];

    let results = check_links_health(app.handle(), urls.clone(), "run-intranet".into())
        .await
        .expect("scan");
    assert_eq!(results.len(), urls.len());
    for result in &results {
        assert!(!result.ok, "{result:?}");
        assert!(
            !result.definitely_broken,
            "an intranet name is not proof (online: {online}): {result:?}"
        );
    }
    let corp = by_url(&results)["http://mynk-nonexistent-host.corp/"].clone();
    assert_eq!(corp.error_kind, HealthErrorKind::Dns, "{corp:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn loopback_targets_are_blocked_without_the_private_network_flag() {
    let server = TestServer::start().await;
    routes(&server);
    let app = test_app(app_lib::settings::PersistedSettings {
        allow_private_network: false,
        ..ollama_settings(&server.base())
    });

    let results = check_links_health(app.handle(), vec![server.url("/ok")], "run-blocked".into())
        .await
        .expect("scan");
    assert_eq!(results[0].error_kind, HealthErrorKind::Blocked);
    assert!(!results[0].ok && !results[0].definitely_broken);
    assert_eq!(server.total_hits(), 0, "nothing must reach the network");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn head_only_failures_fall_back_to_get() {
    let server = TestServer::start().await;
    server.route("/head-hostile", |req| {
        if req.method == "HEAD" {
            Reply::status(405)
        } else {
            Reply::html("fine")
        }
    });
    let app = app_for(&server);

    let results = check_links_health(
        app.handle(),
        vec![server.url("/head-hostile")],
        "run-head".into(),
    )
    .await
    .expect("scan");
    assert!(results[0].ok, "{:?}", results[0]);
    assert_eq!(results[0].status, Some(200));

    let methods: Vec<String> = server
        .requests_to("/head-hostile")
        .iter()
        .map(|r| r.method.clone())
        .collect();
    assert_eq!(methods, vec!["HEAD".to_string(), "GET".to_string()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn at_most_two_requests_per_host_are_in_flight() {
    let server = TestServer::start().await;
    server.route("/slow", |_| Reply::html("ok").with_delay(120));
    let app = app_for(&server);

    let urls: Vec<String> = (0..8).map(|i| server.url(&format!("/slow?{i}"))).collect();
    let results = check_links_health(app.handle(), urls, "run-host".into())
        .await
        .expect("scan");
    assert!(results.iter().all(|r| r.ok));
    assert!(
        server.max_in_flight_per_host() <= 2,
        "per-host limit breached: {}",
        server.max_in_flight_per_host()
    );
    assert!(
        server.max_in_flight_per_host() >= 2,
        "the scan should use the full per-host budget"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_global_budget_is_eight_requests() {
    // Twelve loopback addresses, so the per-host limit (2) never becomes the binding constraint.
    let server = TestServer::start_hosts(12).await;
    if server.host_count() < 9 {
        eprintln!(
            "skipping: only {} loopback addresses could be bound",
            server.host_count()
        );
        return;
    }
    server.route("/slow", |_| Reply::html("ok").with_delay(150));
    let app = app_for(&server);

    let urls: Vec<String> = (0..server.host_count())
        .map(|i| server.url_on(i, "/slow"))
        .collect();
    let results = check_links_health(app.handle(), urls, "run-global".into())
        .await
        .expect("scan");
    assert!(results.iter().all(|r| r.ok));
    assert_eq!(
        server.max_in_flight(),
        8,
        "the scan must saturate exactly the global budget"
    );
    assert!(server.max_in_flight_per_host() <= 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn progress_events_are_per_call_and_end_at_the_total() {
    let server = TestServer::start().await;
    server.route("/ok", |_| Reply::html("ok").with_delay(60));
    let app = app_for(&server);

    let seen: Arc<Mutex<Vec<(String, u64, u64)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    app.app().listen(PROGRESS_EVENT, move |event| {
        if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
            sink.lock().expect("events").push((
                value["runId"].as_str().unwrap_or_default().to_string(),
                value["processed"].as_u64().unwrap_or_default(),
                value["total"].as_u64().unwrap_or_default(),
            ));
        }
    });

    let urls: Vec<String> = (0..6).map(|i| server.url(&format!("/ok?{i}"))).collect();
    check_links_health(app.handle(), urls, "run-progress".into())
        .await
        .expect("scan");

    let events = seen.lock().expect("events").clone();
    assert!(events.len() >= 2, "at least a start and a final event");
    assert!(events
        .iter()
        .all(|(id, _, total)| id == "run-progress" && *total == 6));
    assert_eq!(events.first().map(|e| e.1), Some(0), "starts at zero");
    assert_eq!(events.last().map(|e| e.1), Some(6), "ends at the total");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_empty_scan_still_reports_progress_and_returns_nothing() {
    let server = TestServer::start().await;
    let app = app_for(&server);
    let seen = Arc::new(AtomicUsize::new(0));
    let sink = Arc::clone(&seen);
    app.app().listen(PROGRESS_EVENT, move |_| {
        sink.fetch_add(1, Ordering::SeqCst);
    });

    let results = check_links_health(app.handle(), Vec::new(), "run-empty".into())
        .await
        .expect("scan");
    assert!(results.is_empty());
    assert!(seen.load(Ordering::SeqCst) >= 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancelled_scan_resolves_with_partial_results() {
    let server = TestServer::start().await;
    server.route("/slow", |_| Reply::html("ok").with_delay(400));
    let app = app_for(&server);

    let urls: Vec<String> = (0..20).map(|i| server.url(&format!("/slow?{i}"))).collect();
    let total = urls.len();
    let run = check_links_health(app.handle(), urls, "run-cancel".into());
    let cancel = async {
        while server.total_hits() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
        cancel_health_scan(app.handle(), "run-cancel".to_string())
            .await
            .expect("cancel");
    };
    let (results, ()) = tokio::join!(run, cancel);
    let results = results.expect("cancelled scans still resolve");
    assert!(
        results.len() < total,
        "cancellation must cut the scan short (got {} of {total})",
        results.len()
    );

    cancel_health_scan(app.handle(), "no-such-run".to_string())
        .await
        .expect("unknown run ids are ignored");
}

/// The per-request timeout is shortened only on this app instance; other scans keep the real one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_timeout_is_not_proof_the_link_is_broken() {
    let server = TestServer::start().await;
    server.route("/hang", |_| Reply::html("too late").with_delay(10_000));
    let app = app_for(&server);
    app.state()
        .set_health_request_timeout(Duration::from_millis(300));

    let started = std::time::Instant::now();
    let results = check_links_health(
        app.handle(),
        vec![server.url("/hang")],
        "run-timeout".into(),
    )
    .await
    .expect("scan");
    let result = &results[0];
    assert_eq!(result.error_kind, HealthErrorKind::Timeout, "{result:?}");
    assert!(!result.ok, "{result:?}");
    assert!(!result.definitely_broken, "a timeout is not definitive");
    assert!(!result.preview_blocked);
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "the shortened timeout must apply: {:?}",
        started.elapsed()
    );
    assert_eq!(
        server.hits("/hang"),
        1,
        "a timed-out HEAD is not retried with GET"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_scans_share_the_per_host_and_global_limits() {
    let server = TestServer::start_hosts(12).await;
    server.route("/slow", |_| Reply::html("ok").with_delay(150));
    let app = app_for(&server);

    // Three chunks against one host: together they may still hold only two of its slots.
    let chunk = |tag: usize| -> Vec<String> {
        (0..6)
            .map(|i| server.url(&format!("/slow?{tag}-{i}")))
            .collect()
    };
    let (a, b, c) = tokio::join!(
        check_links_health(app.handle(), chunk(0), "chunk-a".into()),
        check_links_health(app.handle(), chunk(1), "chunk-b".into()),
        check_links_health(app.handle(), chunk(2), "chunk-c".into()),
    );
    for results in [a, b, c] {
        assert!(results.expect("scan").iter().all(|r| r.ok));
    }
    assert!(
        server.max_in_flight_per_host() <= 2,
        "per-host limit breached across calls: {}",
        server.max_in_flight_per_host()
    );

    if server.host_count() < 9 {
        eprintln!("skipping the global half: too few loopback addresses");
        return;
    }
    let spread = |tag: usize| -> Vec<String> {
        (0..server.host_count())
            .map(|i| server.url_on(i, &format!("/slow?g{tag}-{i}")))
            .collect()
    };
    let (a, b) = tokio::join!(
        check_links_health(app.handle(), spread(0), "spread-a".into()),
        check_links_health(app.handle(), spread(1), "spread-b".into()),
    );
    assert!(a.expect("scan").iter().all(|r| r.ok));
    assert!(b.expect("scan").iter().all(|r| r.ok));
    assert!(
        server.max_in_flight() <= 8,
        "global budget breached across calls: {}",
        server.max_in_flight()
    );
    assert!(server.max_in_flight_per_host() <= 2);
}
