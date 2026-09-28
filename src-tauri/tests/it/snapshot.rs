//! Snapshot capture wiring: challenge and error-status detection through the guarded pre-flight,
//! stable reason codes, the shared time budget, cancellation and the concurrency budget.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use app_lib::commands::media::cancel_snapshot_captures;
use app_lib::http::guard::AddressPolicy;
use app_lib::http::normalize_target_url;
use app_lib::snapshot::backend::{reason, Backend, ChromiumBackend};
use app_lib::snapshot::{capture, preflight, render_dom, Preflight, SnapshotKind, SnapshotResult};
use tokio::time::Instant as TokioInstant;
use tokio_util::sync::CancellationToken;

use crate::support::server::{Chunk, Reply, TestServer};
use crate::support::{
    capture_browser, ollama_settings, test_app, test_app_with_backend, TestApp, CF_INTERSTITIAL,
};

/// An ordinary long article with the script Bot Fight Mode injects into normal pages.
fn article_with_jsd_script() -> String {
    let jsd = "<script>(function(){window.__CF$cv$params={r:'8a1b2c3d',t:'MTcyNjE='};\
        var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';\
        document.getElementsByTagName('head')[0].appendChild(a);})();</script>";
    let text = "<p>A perfectly normal paragraph about programming languages.</p>".repeat(900);
    format!("<!doctype html><html><head><title>Article</title>{jsd}</head><body><article>{text}</article></body></html>")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cloudflare_interstitial_is_reported_as_a_challenge() {
    let server = TestServer::start().await;
    server.route("/wall", |_| {
        Reply::text(403, "text/html; charset=UTF-8", CF_INTERSTITIAL)
            .with_header("cf-mitigated", "challenge")
    });
    server.route("/wall-no-header", |_| {
        Reply::text(403, "text/html; charset=UTF-8", CF_INTERSTITIAL)
    });
    server.route("/header-only", |_| {
        Reply::text(403, "text/html", "").with_header("cf-mitigated", "challenge")
    });
    server.route("/article", |_| Reply::html(article_with_jsd_script()));
    let app = test_app(ollama_settings(&server.base()));

    for path in ["/wall", "/wall-no-header", "/header-only"] {
        let url = normalize_target_url(&server.url(path)).expect("url");
        assert_eq!(
            preflight(&app.handle(), &url).await.expect("pre-flight"),
            Preflight::Challenge,
            "{path}"
        );
    }

    // Bot Fight Mode's injected script alone does not make a page a wall.
    let article = normalize_target_url(&server.url("/article")).expect("url");
    match preflight(&app.handle(), &article)
        .await
        .expect("pre-flight")
    {
        Preflight::Ready { url, .. } => assert!(url.path().ends_with("/article")),
        other => panic!("a normal article is capturable, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_runtime_reports_a_code_not_a_description() {
    let server = TestServer::start().await;
    server.route("/page", |_| Reply::html("<html><body>x</body></html>"));
    let app = test_app(ollama_settings(&server.base()));

    let result = capture(&app.handle(), &server.url("/page"))
        .await
        .expect("page-level outcome");
    assert_eq!(result.kind, SnapshotKind::RuntimeMissing);
    assert_eq!(result.reason.as_deref(), Some(reason::RUNTIME_UNAVAILABLE));
    assert_eq!(server.total_hits(), 0, "no pre-flight without a runtime");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_preflight_waits_for_a_capture_permit() {
    let server = TestServer::start().await;
    server.route("/page", |_| {
        Reply::html("<!doctype html><html><body><h1>queued</h1></body></html>")
    });
    let Some(browser) = capture_browser() else {
        return;
    };
    let app = test_app_with_backend(ollama_settings(&server.base()), Backend::Chromium(browser));

    let permits = app.state().snapshot_permits.clone();
    let held = permits
        .clone()
        .acquire_many_owned(u32::try_from(permits.available_permits()).expect("permits"))
        .await
        .expect("take every permit");

    let handle = app.handle();
    let url = server.url("/page");
    let task = tokio::spawn(async move { capture(&handle, &url).await });

    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        server.hits("/page"),
        0,
        "no pre-flight while the queue is full"
    );

    drop(held);
    let reached = tokio::time::timeout(Duration::from_secs(10), async {
        while server.hits("/page") == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(reached.is_ok(), "the pre-flight runs once a permit is free");
    task.abort();
    let _ = task.await;
}

/// A backend whose browser does not exist: reaching it shows up as `browserLaunchFailed`.
fn unlaunchable_app(server: &TestServer) -> TestApp {
    test_app_with_backend(
        ollama_settings(&server.base()),
        Backend::Chromium(ChromiumBackend::new(PathBuf::from(
            "/nonexistent/mynk-it-chrome",
        ))),
    )
}

/// A test app with this machine's own browser, keeping its capture profiles inside `profiles`;
/// `None` where nothing is installed.
fn real_browser_app(server: &TestServer, profiles: &Path) -> Option<TestApp> {
    let backend = capture_browser()?;
    Some(test_app_with_backend(
        ollama_settings(&server.base()),
        Backend::Chromium(backend.with_profile_root(profiles.to_path_buf())),
    ))
}

/// Headers immediately, then a body that never ends.
fn never_ending_page() -> Reply {
    Reply::chunked(
        "text/html",
        vec![
            Chunk::now("<!doctype html><html><body>"),
            Chunk::after(600_000, "never"),
        ],
    )
}

fn entries(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default()
}

fn assert_reason(result: &SnapshotResult, kind: SnapshotKind, code: &str) {
    assert_eq!(result.kind, kind, "{result:?}");
    assert_eq!(result.reason.as_deref(), Some(code), "{result:?}");
    assert!(result.file_name.is_none(), "{result:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_error_status_is_reported_instead_of_captured() {
    let server = TestServer::start().await;
    server.route("/missing", |_| {
        Reply::text(404, "text/html", "<h1>Not found</h1>")
    });
    server.route("/gone", |_| Reply::status(410));
    server.route("/boom", |_| Reply::text(500, "text/html", "<h1>Oops</h1>"));
    server.route("/unavailable", |_| Reply::status(503));
    server.route("/forbidden", |_| {
        Reply::text(403, "text/html", "<h1>Forbidden</h1>")
    });
    server.route("/login", |_| Reply::status(401));
    server.route("/limited", |_| Reply::status(429));
    server.route("/page", |_| Reply::html("<html><body>fine</body></html>"));
    let app = unlaunchable_app(&server);

    for (path, status) in [("/missing", 404u16), ("/limited", 429)] {
        let url = normalize_target_url(&server.url(path)).expect("url");
        assert_eq!(
            preflight(&app.handle(), &url).await.expect("pre-flight"),
            Preflight::HttpError { status },
            "{path}"
        );
    }

    for path in ["/missing", "/gone", "/boom", "/unavailable"] {
        let result = capture(&app.handle(), &server.url(path))
            .await
            .expect("page-level outcome");
        assert_reason(&result, SnapshotKind::Error, reason::HTTP_ERROR);
    }
    // Link health counts these as protected pages, not broken ones.
    for path in ["/forbidden", "/login"] {
        let result = capture(&app.handle(), &server.url(path))
            .await
            .expect("page-level outcome");
        assert_reason(
            &result,
            SnapshotKind::Challenge,
            reason::SECURITY_VERIFICATION_WALL,
        );
    }
    // 429 passes on its own, so it is a retryable error rather than a remembered wall.
    let limited = capture(&app.handle(), &server.url("/limited"))
        .await
        .expect("page-level outcome");
    assert_reason(&limited, SnapshotKind::Error, reason::HTTP_ERROR);
    // A healthy page does reach the browser.
    let result = capture(&app.handle(), &server.url("/page"))
        .await
        .expect("page-level outcome");
    assert_eq!(
        result.reason.as_deref(),
        Some(reason::BROWSER_LAUNCH_FAILED)
    );
    assert!(
        entries(app.snapshot_dir()).is_empty(),
        "nothing may be written"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn headers_that_never_come_end_the_capture_within_its_budget() {
    let server = TestServer::start().await;
    server.route("/silent", |_| Reply::html("late").with_delay(600_000));
    let app = unlaunchable_app(&server);
    let budget = Duration::from_millis(1500);
    app.state().set_snapshot_timeout(budget);

    let started = Instant::now();
    let result = capture(&app.handle(), &server.url("/silent"))
        .await
        .expect("page-level outcome");
    let elapsed = started.elapsed();
    assert_reason(&result, SnapshotKind::Error, reason::CAPTURE_TIMEOUT);
    assert!(
        elapsed < budget + Duration::from_secs(1),
        "took {elapsed:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_never_ending_body_leaves_the_browser_only_the_rest_of_the_budget() {
    let server = TestServer::start().await;
    server.route("/hang", |_| never_ending_page());
    let app = unlaunchable_app(&server);

    // A budget shorter than the body wait: nothing is left for the browser.
    let budget = Duration::from_millis(1500);
    app.state().set_snapshot_timeout(budget);
    let started = Instant::now();
    let result = capture(&app.handle(), &server.url("/hang"))
        .await
        .expect("page-level outcome");
    let elapsed = started.elapsed();
    assert_reason(&result, SnapshotKind::Error, reason::CAPTURE_TIMEOUT);
    assert!(
        elapsed < budget + Duration::from_secs(1),
        "took {elapsed:?}"
    );

    // A longer budget: the body wait is cut short and the browser still gets its turn.
    let budget = Duration::from_secs(12);
    app.state().set_snapshot_timeout(budget);
    let started = Instant::now();
    let result = capture(&app.handle(), &server.url("/hang"))
        .await
        .expect("page-level outcome");
    let elapsed = started.elapsed();
    assert_eq!(
        result.reason.as_deref(),
        Some(reason::BROWSER_LAUNCH_FAILED),
        "{result:?}"
    );
    assert!(elapsed < budget, "took {elapsed:?}");
}

/// A browser needs its virtual-time budget to render anything; less than that is a timeout, not
/// a launch that can only fail slowly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remainder_too_small_to_render_never_reaches_the_browser() {
    let server = TestServer::start().await;
    server.route("/slow", |_| {
        Reply::html("<html><body>slow</body></html>").with_delay(2000)
    });
    let app = unlaunchable_app(&server);
    app.state()
        .set_snapshot_timeout(Duration::from_millis(4000));

    let result = capture(&app.handle(), &server.url("/slow"))
        .await
        .expect("page-level outcome");
    assert_reason(&result, SnapshotKind::Error, reason::CAPTURE_TIMEOUT);
    assert_eq!(server.hits("/slow"), 1, "only the pre-flight ran");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_page_that_starts_a_download_leaves_nothing_behind() {
    let Some(backend) = capture_browser() else {
        return;
    };
    let profiles = tempfile::tempdir().expect("profile root");
    let server = TestServer::start().await;
    server.route("/payload.bin", |_| {
        Reply::bytes("application/octet-stream", vec![7u8; 2048]).with_header(
            "content-disposition",
            "attachment; filename=\"payload.bin\"",
        )
    });
    server.route("/downloader", |_| {
        Reply::html(
            "<!doctype html><html><body><h1>downloading</h1><script>\
             const a=document.createElement('a');a.href='/payload.bin';a.download='payload.bin';\
             document.body.appendChild(a);a.click();</script></body></html>",
        )
    });
    let app = test_app_with_backend(
        ollama_settings(&server.base()),
        Backend::Chromium(backend.with_profile_root(profiles.path().to_path_buf())),
    );

    // A started download keeps headless Chrome alive, so this capture runs out its budget.
    app.state().set_snapshot_timeout(Duration::from_secs(10));
    let result = capture(&app.handle(), &server.url("/downloader"))
        .await
        .expect("page-level outcome");
    eprintln!(
        "download capture: {result:?}, payload requested {} time(s)",
        server.hits("/payload.bin")
    );
    assert!(
        entries(profiles.path()).is_empty(),
        "the profile and anything downloaded into it are gone: {:?}",
        entries(profiles.path())
    );
    // A download must never become a preview file, whatever the capture itself ended as.
    let left: Vec<String> = entries(app.snapshot_dir())
        .iter()
        .filter_map(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .collect();
    assert!(left.iter().all(|name| name.ends_with(".png")), "{left:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_queued_capture_is_cancelled_and_later_ones_still_run() {
    let server = TestServer::start().await;
    server.route("/page", |_| Reply::html("<html><body>queued</body></html>"));
    let app = unlaunchable_app(&server);

    let permits = app.state().snapshot_permits.clone();
    let held = permits
        .clone()
        .acquire_many_owned(u32::try_from(permits.available_permits()).expect("permits"))
        .await
        .expect("take every permit");
    let handle = app.handle();
    let url = server.url("/page");
    let queued = tokio::spawn(async move { capture(&handle, &url).await });
    tokio::time::sleep(Duration::from_millis(200)).await;

    cancel_snapshot_captures(app.state()).await.expect("cancel");
    let result = tokio::time::timeout(Duration::from_secs(2), queued)
        .await
        .expect("the queued capture ends at once")
        .expect("join")
        .expect("page-level outcome");
    assert_reason(&result, SnapshotKind::Error, reason::CANCELLED);
    assert_eq!(
        server.hits("/page"),
        0,
        "a cancelled capture pre-checks nothing"
    );

    drop(held);
    let later = capture(&app.handle(), &server.url("/page"))
        .await
        .expect("page-level outcome");
    assert_eq!(
        later.reason.as_deref(),
        Some(reason::BROWSER_LAUNCH_FAILED),
        "a capture started after the cancel runs: {later:?}"
    );
    assert_eq!(server.hits("/page"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_stops_a_running_browser_and_cleans_up() {
    let Some(backend) = capture_browser() else {
        return;
    };
    let profiles = tempfile::tempdir().expect("profile root");
    let server = TestServer::start().await;
    server.route("/hang", |_| never_ending_page());
    server.route("/page", |_| {
        Reply::html("<!doctype html><html><body><h1>after the cancel</h1></body></html>")
    });
    let app = test_app_with_backend(
        ollama_settings(&server.base()),
        Backend::Chromium(backend.with_profile_root(profiles.path().to_path_buf())),
    );

    let handle = app.handle();
    let url = server.url("/hang");
    let task = tokio::spawn(async move { capture(&handle, &url).await });
    // The pre-flight is one request; the browser's own load is the second.
    let browser_loading = tokio::time::timeout(Duration::from_secs(30), async {
        while server.hits("/hang") < 2 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(
        browser_loading.is_ok(),
        "the browser never requested the page"
    );
    assert_eq!(entries(profiles.path()).len(), 1, "one live profile");

    let started = Instant::now();
    cancel_snapshot_captures(app.state()).await.expect("cancel");
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("the capture ends after the cancel")
        .expect("join")
        .expect("page-level outcome");
    let elapsed = started.elapsed();
    assert_reason(&result, SnapshotKind::Error, reason::CANCELLED);
    assert!(elapsed < Duration::from_secs(2), "took {elapsed:?}");
    assert!(
        entries(profiles.path()).is_empty(),
        "profile left behind: {:?}",
        entries(profiles.path())
    );
    assert!(
        entries(app.snapshot_dir()).is_empty(),
        "temp image left behind: {:?}",
        entries(app.snapshot_dir())
    );

    let later = capture(&app.handle(), &server.url("/page"))
        .await
        .expect("page-level outcome");
    assert_eq!(later.kind, SnapshotKind::Image, "{later:?}");
    let file = later.file_name.expect("file name");
    assert!(app.snapshot_dir().join(&file).is_file());
    assert!(entries(profiles.path()).is_empty());
}

/// Three fallbacks against two render permits; the one that queues may finish later than the
/// budget itself.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_queued_render_gets_its_whole_budget_after_the_wait() {
    let profiles = tempfile::tempdir().expect("profile root");
    let server = TestServer::start().await;
    server.route("/hang", |_| never_ending_page());
    server.route("/page", |_| {
        Reply::html("<!doctype html><html><body><h1>rendered after the queue</h1></body></html>")
    });
    let Some(app) = real_browser_app(&server, profiles.path()) else {
        return;
    };

    let budget = Duration::from_secs(5);
    let deadline = TokioInstant::now() + Duration::from_secs(120);
    let policy = AddressPolicy::for_web(true);
    let hang = normalize_target_url(&server.url("/hang")).expect("url");
    let holders: Vec<_> = (0..2)
        .map(|_| {
            let handle = app.handle();
            let url = hang.clone();
            tokio::spawn(async move {
                render_dom(
                    &handle,
                    &url,
                    policy,
                    budget,
                    deadline,
                    &CancellationToken::new(),
                )
                .await
            })
        })
        .collect();
    let taken = tokio::time::timeout(Duration::from_secs(10), async {
        while app.state().render_permits.available_permits() > 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(taken.is_ok(), "the first two renders never started");

    let page = normalize_target_url(&server.url("/page")).expect("url");
    let started = Instant::now();
    let dom = render_dom(
        &app.handle(),
        &page,
        policy,
        budget,
        deadline,
        &CancellationToken::new(),
    )
    .await;
    let elapsed = started.elapsed();

    assert!(
        dom.is_some_and(|dom| dom.contains("rendered after the queue")),
        "the queued render produced nothing in {elapsed:?}"
    );
    assert!(
        elapsed > budget,
        "the wait was taken out of the browser's budget: {elapsed:?}"
    );
    for holder in holders {
        assert!(
            holder.await.expect("join").is_none(),
            "a page that never ends renders nothing"
        );
    }
    assert!(
        entries(profiles.path()).is_empty(),
        "profile left behind: {:?}",
        entries(profiles.path())
    );
}

/// Previews and the analysis fallback hold separate permits.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_preview_and_a_render_run_at_the_same_time() {
    let profiles = tempfile::tempdir().expect("profile root");
    let server = TestServer::start().await;
    server.route("/hang", |_| never_ending_page());
    server.route("/shot", |_| {
        Reply::html("<!doctype html><html><body><h1>preview</h1></body></html>")
    });
    server.route("/page", |_| {
        Reply::html("<!doctype html><html><body><h1>fallback</h1></body></html>")
    });
    let Some(app) = real_browser_app(&server, profiles.path()) else {
        return;
    };
    app.state().set_snapshot_timeout(Duration::from_secs(10));

    // One preview runs its browser out; the other permit is held, so the preview pool is empty.
    let previews = app.state().snapshot_permits.clone();
    let held = previews
        .clone()
        .acquire_owned()
        .await
        .expect("one preview permit");
    let handle = app.handle();
    let hang = server.url("/hang");
    let running = tokio::spawn(async move { capture(&handle, &hang).await });
    let started = tokio::time::timeout(Duration::from_secs(20), async {
        while previews.available_permits() > 0 || server.hits("/hang") == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(started.is_ok(), "the preview never took the last permit");

    let page = normalize_target_url(&server.url("/page")).expect("url");
    let dom = render_dom(
        &app.handle(),
        &page,
        AddressPolicy::for_web(true),
        Duration::from_secs(30),
        TokioInstant::now() + Duration::from_secs(60),
        &CancellationToken::new(),
    )
    .await;
    assert!(
        dom.is_some_and(|dom| dom.contains("fallback")),
        "the fallback waited for a preview permit"
    );
    assert!(
        !running.is_finished(),
        "the preview was still running while the fallback rendered"
    );

    drop(held);
    let preview = tokio::time::timeout(Duration::from_secs(30), running)
        .await
        .expect("the preview ends with its own budget")
        .expect("join")
        .expect("page-level outcome");
    assert_reason(&preview, SnapshotKind::Error, reason::CAPTURE_TIMEOUT);

    // Conversely, a full render queue leaves the preview permits alone.
    let renders = app.state().render_permits.clone();
    let held = renders
        .clone()
        .acquire_many_owned(u32::try_from(renders.available_permits()).expect("permits"))
        .await
        .expect("every render permit");
    let shot = capture(&app.handle(), &server.url("/shot"))
        .await
        .expect("page-level outcome");
    assert_eq!(shot.kind, SnapshotKind::Image, "{shot:?}");
    drop(held);
    assert!(
        entries(profiles.path()).is_empty(),
        "profile left behind: {:?}",
        entries(profiles.path())
    );
}
