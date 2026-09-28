//! Remote image caching, uploaded previews and snapshot-directory maintenance, all against
//! real files in real temporary directories.

use std::fs;

use app_lib::http::normalize_target_url;
use app_lib::settings::PersistedSettings;
use app_lib::snapshot::backend::Backend;
use app_lib::snapshot::cleanup::{self, MAX_UPLOAD_BYTES};
use app_lib::snapshot::media::{cache_remote_image, RemoteImageKind};
use app_lib::snapshot::{
    capture, delete, maintain, preflight, reset, save_uploaded_preview, Preflight, SnapshotKind,
};

use crate::support::server::{Reply, TestServer};
use crate::support::{
    app_for, offline_app, ollama_settings, test_app, test_app_with_backend,
    test_app_with_real_backend, GIF, ICO, JPEG, PNG, SAFE_SVG, UNSAFE_SVG, WEBP,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_supported_image_format_is_cached_to_disk() {
    let server = TestServer::start().await;
    server.route("/a.png", |_| Reply::bytes("image/png", PNG));
    server.route("/b.jpg", |_| Reply::bytes("image/jpeg", JPEG));
    server.route("/c.webp", |_| Reply::bytes("image/webp", WEBP));
    server.route("/d.gif", |_| Reply::bytes("image/gif", GIF));
    server.route("/e.ico", |_| Reply::bytes("text/plain", ICO));
    server.route("/f.svg", |_| Reply::bytes("image/svg+xml", SAFE_SVG));
    let app = app_for(&server);

    let cases: [(&str, &str, &[u8]); 6] = [
        ("/a.png", "png", PNG),
        ("/b.jpg", "jpg", JPEG),
        ("/c.webp", "webp", WEBP),
        ("/d.gif", "gif", GIF),
        ("/e.ico", "ico", ICO),
        ("/f.svg", "svg", SAFE_SVG),
    ];
    for (path, ext, bytes) in cases {
        let name = cache_remote_image(&app.handle(), &server.url(path), RemoteImageKind::Favicon)
            .await
            .unwrap_or_else(|e| panic!("{path}: {e}"));
        assert!(name.starts_with("fav-"), "{name}");
        assert!(name.ends_with(&format!(".{ext}")), "{name}");
        let stored = fs::read(app.snapshot_dir().join(&name)).expect("stored file");
        assert_eq!(stored, bytes, "{path} must be stored verbatim");
    }

    // The same URL cached as an og:image gets its own name.
    let image = cache_remote_image(&app.handle(), &server.url("/a.png"), RemoteImageKind::Image)
        .await
        .expect("image");
    assert!(image.starts_with("img-"), "{image}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_svg_and_mismatched_content_types_are_refused() {
    let server = TestServer::start().await;
    server.route("/evil.svg", |_| Reply::bytes("image/svg+xml", UNSAFE_SVG));
    server.route("/page.html", |_| {
        Reply::bytes("image/png", b"<html>not an image</html>".to_vec())
    });
    server.route("/mislabelled.png", |_| {
        Reply::bytes("text/html; charset=utf-8", PNG)
    });
    server.route("/empty.png", |_| Reply::bytes("image/png", Vec::new()));
    let app = app_for(&server);

    for path in ["/evil.svg", "/page.html", "/mislabelled.png", "/empty.png"] {
        let error = cache_remote_image(&app.handle(), &server.url(path), RemoteImageKind::Image)
            .await
            .expect_err("must be refused");
        assert_eq!(error.kind(), "parse", "{path}: {error}");
    }
    let files: Vec<_> = fs::read_dir(app.snapshot_dir())
        .expect("dir")
        .flatten()
        .collect();
    assert!(files.is_empty(), "nothing may be written for a refusal");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn per_kind_size_limits_are_enforced() {
    let server = TestServer::start().await;
    server.route("/big-favicon.png", |_| {
        let mut body = PNG.to_vec();
        body.resize(600 * 1024, 0);
        Reply::bytes("image/png", body)
    });
    server.route("/big-image.png", |_| {
        let mut body = PNG.to_vec();
        body.resize(6 * 1024 * 1024, 0);
        Reply::bytes("image/png", body)
    });
    let app = app_for(&server);

    let favicon = cache_remote_image(
        &app.handle(),
        &server.url("/big-favicon.png"),
        RemoteImageKind::Favicon,
    )
    .await
    .expect_err("must be refused");
    // A body over the limit is refused before it is read, so the kind is `network`, not `parse`.
    assert_eq!(favicon.kind(), "network", "{favicon}");

    let image = cache_remote_image(
        &app.handle(),
        &server.url("/big-image.png"),
        RemoteImageKind::Image,
    )
    .await
    .expect_err("must be refused");
    assert_eq!(image.kind(), "network", "{image}");

    // The same body is fine when it fits the og:image budget.
    let ok = cache_remote_image(
        &app.handle(),
        &server.url("/big-favicon.png"),
        RemoteImageKind::Image,
    )
    .await
    .expect("600 KB is under the 5 MB image limit");
    assert!(ok.ends_with(".png"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cached_url_is_served_from_disk_without_a_request() {
    let server = TestServer::start().await;
    server.route("/icon.png", |_| Reply::bytes("image/png", PNG));
    let app = app_for(&server);

    let first = cache_remote_image(
        &app.handle(),
        &server.url("/icon.png"),
        RemoteImageKind::Favicon,
    )
    .await
    .expect("first");
    assert_eq!(server.hits("/icon.png"), 1);

    let second = cache_remote_image(
        &app.handle(),
        &server.url("/icon.png"),
        RemoteImageKind::Favicon,
    )
    .await
    .expect("second");
    assert_eq!(first, second);
    assert_eq!(
        server.hits("/icon.png"),
        1,
        "the cache must not hit the network"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_failures_and_blocked_targets_are_reported() {
    let server = TestServer::start().await;
    server.route("/missing.png", |_| Reply::status(404));
    let app = app_for(&server);

    let error = cache_remote_image(
        &app.handle(),
        &server.url("/missing.png"),
        RemoteImageKind::Favicon,
    )
    .await
    .expect_err("must be refused");
    assert_eq!(error.kind(), "network");
    assert_eq!(error.status(), Some(404));

    for raw in [
        "data:image/png;base64,AAAA",
        "file:///C:/Windows/win.ini",
        "example.com/a.png",
        "",
    ] {
        let error = cache_remote_image(&app.handle(), raw, RemoteImageKind::Favicon)
            .await
            .expect_err("must be refused");
        assert_eq!(error.kind(), "invalidInput", "{raw}");
    }

    // Without the private-network flag a loopback image is refused before any request.
    app.set_settings(PersistedSettings {
        allow_private_network: false,
        ..ollama_settings(&server.base())
    });
    server.reset_log();
    let blocked = cache_remote_image(
        &app.handle(),
        &server.url("/other.png"),
        RemoteImageKind::Favicon,
    )
    .await
    .expect_err("must be refused");
    assert_eq!(blocked.kind(), "blockedAddress");
    assert_eq!(server.total_hits(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uploaded_previews_are_validated_and_written() {
    let app = offline_app();
    let handle = app.handle();

    for (ext, bytes) in [("png", PNG), ("jpeg", JPEG), ("webp", WEBP)] {
        let name = save_uploaded_preview(&handle, "res-1".to_string(), bytes.to_vec(), ext)
            .await
            .unwrap_or_else(|e| panic!("{ext}: {e}"));
        assert!(name.starts_with("upload-"), "{name}");
        assert_eq!(
            fs::read(app.snapshot_dir().join(&name)).expect("stored"),
            bytes
        );
    }

    let bad_ext = save_uploaded_preview(&handle, "res-1".into(), PNG.to_vec(), "gif")
        .await
        .expect_err("must be refused");
    assert_eq!(bad_ext.kind(), "invalidInput");

    let mismatch = save_uploaded_preview(&handle, "res-1".into(), JPEG.to_vec(), "png")
        .await
        .expect_err("must be refused");
    assert_eq!(mismatch.kind(), "invalidInput");

    let empty = save_uploaded_preview(&handle, "res-1".into(), Vec::new(), "png")
        .await
        .expect_err("must be refused");
    assert_eq!(empty.kind(), "invalidInput");

    let mut huge = PNG.to_vec();
    huge.resize(MAX_UPLOAD_BYTES + 1, 0);
    let too_big = save_uploaded_preview(&handle, "res-1".into(), huge, "png")
        .await
        .expect_err("must be refused");
    assert_eq!(too_big.kind(), "invalidInput");
    assert!(too_big.to_string().contains("15 MB"), "{too_big}");
}

/// Backdates a file's access and modification times by `secs` seconds.
fn age(path: &std::path::Path, secs: u64) {
    let when = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(secs))
        .expect("time");
    let file = fs::File::options().write(true).open(path).expect("open");
    file.set_times(fs::FileTimes::new().set_accessed(when).set_modified(when))
        .expect("set times");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maintenance_prunes_unreferenced_files_and_protects_uploads() {
    let app = offline_app();
    let dir = app.snapshot_dir().clone();
    for name in ["keep.png", "orphan.png", "upload-a-b.png", "busy.png.tmp"] {
        fs::write(dir.join(name), vec![0u8; 64]).expect("write");
        age(&dir.join(name), 3_600);
    }
    fs::write(dir.join("fresh.png"), vec![0u8; 64]).expect("write");

    let report = maintain(&app.handle(), vec!["keep.png".to_string()])
        .await
        .expect("maintain");
    assert_eq!(report.deleted_unreferenced, 1, "only the old orphan");
    assert!(report.evicted.is_empty(), "far below the 500 MB cap");
    assert!(dir.join("keep.png").is_file());
    assert!(
        dir.join("upload-a-b.png").is_file(),
        "an unreferenced upload is never pruned"
    );
    assert!(
        dir.join("fresh.png").is_file(),
        "a file written moments ago may not be referenced yet"
    );
    assert!(
        dir.join("busy.png.tmp").is_file(),
        "temp files are left alone"
    );
    assert_eq!(report.total_bytes, 256);

    // Maintenance keeps only what the renderer still references; delete rejects traversal.
    fs::write(dir.join("extra.png"), b"x").expect("write");
    age(&dir.join("extra.png"), 3_600);
    let report = maintain(&app.handle(), vec!["keep.png".to_string()])
        .await
        .expect("maintain");
    assert_eq!(report.deleted_unreferenced, 1);
    assert!(!dir.join("extra.png").exists());

    // An empty keep list still spares the upload.
    let report = maintain(&app.handle(), Vec::new()).await.expect("maintain");
    assert_eq!(report.deleted_unreferenced, 1, "keep.png only");
    assert!(dir.join("upload-a-b.png").is_file());
    fs::write(dir.join("keep.png"), b"x").expect("write");

    for name in [
        "../escape.png",
        "sub/dir.png",
        "C:\\Windows\\win.ini",
        ".hidden",
    ] {
        let error = delete(&app.handle(), vec![name.to_string()])
            .await
            .expect_err("must be refused");
        assert_eq!(error.kind(), "invalidInput", "{name}");
    }
    delete(&app.handle(), vec!["keep.png".into(), "gone.png".into()])
        .await
        .expect("missing files are ignored");
    assert!(!dir.join("keep.png").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_factory_reset_deletes_uploads_and_fresh_files() {
    let app = offline_app();
    let handle = app.handle();
    let dir = app.snapshot_dir().clone();
    let upload = save_uploaded_preview(&handle, "res-1".to_string(), PNG.to_vec(), "png")
        .await
        .expect("upload");
    fs::write(dir.join("fav-fresh.ico"), b"x").expect("write");
    fs::write(dir.join("img-old.png"), b"x").expect("write");
    age(&dir.join("img-old.png"), 3_600);
    fs::write(dir.join("busy.png-9-9.tmp"), b"x").expect("write");

    // Maintenance with an empty keep list spares the upload and the fresh file.
    let report = maintain(&handle, Vec::new()).await.expect("maintain");
    assert_eq!(report.deleted_unreferenced, 1);
    assert!(dir.join(&upload).is_file());
    assert!(dir.join("fav-fresh.ico").is_file());

    assert_eq!(reset(&handle).await.expect("reset"), 2);
    assert!(!dir.join(&upload).exists(), "the upload is gone");
    assert!(!dir.join("fav-fresh.ico").exists(), "no age limit");
    assert!(
        dir.join("busy.png-9-9.tmp").is_file(),
        "an in-flight temp file is left to its writer"
    );
    assert_eq!(reset(&handle).await.expect("reset again"), 0);
}

#[test]
fn the_size_cap_evicts_the_least_recently_used_non_upload_files() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path();
    let write = |name: &str, size: usize, age_secs: u64| {
        fs::write(path.join(name), vec![0u8; size]).expect("write");
        let when = std::time::SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(age_secs))
            .expect("time");
        let file = fs::File::options()
            .write(true)
            .open(path.join(name))
            .expect("open");
        file.set_times(fs::FileTimes::new().set_accessed(when).set_modified(when))
            .expect("set times");
    };
    write("old.png", 400, 3_000);
    write("fav-aa.ico", 100, 2_000);
    write("new.png", 400, 10);
    write("upload-x-y.png", 500, 9_000);

    let keep: Vec<String> = ["old.png", "fav-aa.ico", "new.png", "upload-x-y.png"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    // 1400 bytes total; evicting the least recently used non-upload file is enough to fit.
    let report = cleanup::maintain(path, &keep, 1_000).expect("maintain");
    assert_eq!(report.deleted_unreferenced, 0);
    assert_eq!(report.evicted, vec!["old.png".to_string()]);
    assert_eq!(report.total_bytes, 1_000);
    assert!(
        path.join("upload-x-y.png").is_file(),
        "uploads are never evicted, even when they are the oldest"
    );
    assert!(
        path.join("fav-aa.ico").is_file(),
        "eviction stops at the cap"
    );

    // Tightening the cap evicts the next least recently used file.
    let report = cleanup::maintain(path, &keep, 900).expect("maintain");
    assert_eq!(report.evicted, vec!["fav-aa.ico".to_string()]);
    assert_eq!(report.total_bytes, 900);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_snapshot_produces_a_png_or_reports_a_missing_runtime() {
    let server = TestServer::start().await;
    server.route("/page", |_| {
        Reply::html(
            "<!doctype html><html><head><title>Snapshot</title></head>\
             <body style=\"background:#123456\"><h1>MYNK capture test</h1></body></html>",
        )
    });
    // Its own profile root, so a leftover of this capture can be told from a sibling test's.
    let profiles = tempfile::tempdir().expect("profile root");
    let backend = match Backend::detect() {
        Backend::Chromium(backend) => {
            Backend::Chromium(backend.with_profile_root(profiles.path().to_path_buf()))
        }
        disabled => disabled,
    };
    let app = test_app_with_backend(ollama_settings(&server.base()), backend);
    let backend_available = match &app.state().snapshot_backend {
        Backend::Chromium(backend) => {
            eprintln!(
                "capture backend: chromium at {}",
                backend.browser().display()
            );
            true
        }
        Backend::Disabled(reason) => {
            eprintln!("capture backend disabled: {reason}");
            false
        }
    };

    let result = capture(&app.handle(), &server.url("/page"))
        .await
        .expect("page level outcomes resolve, they do not reject");

    if !backend_available {
        assert_eq!(result.kind, SnapshotKind::RuntimeMissing, "{result:?}");
        assert!(result.reason.is_some());
        return;
    }

    assert_eq!(
        result.kind,
        SnapshotKind::Image,
        "capture failed with: {:?}",
        result.reason
    );
    let name = result.file_name.expect("file name");
    let bytes = fs::read(app.snapshot_dir().join(&name)).expect("stored snapshot");
    assert!(
        bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        "the capture must be a real PNG"
    );
    assert!(bytes.len() > 1024, "suspiciously small capture");
    // The IHDR chunk carries the pixel size: the capture must use the requested viewport.
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("ihdr width"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("ihdr height"));
    eprintln!("captured {} bytes, {width}x{height}", bytes.len());
    assert_eq!((width, height), (1200, 800), "unexpected capture size");
    let leftovers: Vec<_> = fs::read_dir(app.snapshot_dir())
        .expect("dir")
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let profiles_left: Vec<_> = fs::read_dir(profiles.path())
        .expect("profile root")
        .flatten()
        .map(|entry| entry.path())
        .collect();
    assert!(
        profiles_left.is_empty(),
        "the browser profile is removed after a capture: {profiles_left:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_rejects_blocked_and_invalid_targets() {
    let app = test_app(PersistedSettings {
        allow_private_network: false,
        ..ollama_settings("http://127.0.0.1:1")
    });

    let blocked = capture(&app.handle(), "http://127.0.0.1:9/page")
        .await
        .expect_err("loopback is refused before anything is spawned");
    assert_eq!(blocked.kind(), "blockedAddress");

    let invalid = capture(&app.handle(), "file:///C:/Windows/win.ini")
        .await
        .expect_err("only http/https");
    assert_eq!(invalid.kind(), "invalidInput");
}

/// The browser has no SSRF guard of its own, so the pre-flight must abort a refused redirect.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_preflight_redirect_to_a_blocked_address_aborts_the_capture() {
    let server = TestServer::start().await;
    server.route("/to-metadata", |_| {
        Reply::redirect(302, "http://169.254.169.254/latest/meta-data/")
    });
    // Loopback is allowed here; the cloud metadata address never is.
    let app = test_app_with_real_backend(ollama_settings(&server.base()));

    let url = normalize_target_url(&server.url("/to-metadata")).expect("url");
    let error = preflight(&app.handle(), &url)
        .await
        .expect_err("a blocked redirect must not be capturable");
    assert_eq!(error.kind(), "blockedAddress", "{error}");

    if matches!(app.state().snapshot_backend, Backend::Chromium(_)) {
        let error = capture(&app.handle(), &server.url("/to-metadata"))
            .await
            .expect_err("the capture must be rejected, not attempted");
        assert_eq!(error.kind(), "blockedAddress", "{error}");
    }
    let files: Vec<_> = fs::read_dir(app.snapshot_dir())
        .expect("dir")
        .flatten()
        .collect();
    assert!(files.is_empty(), "nothing may be captured: {files:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_preflight_aborts_the_capture() {
    let server = TestServer::start().await;
    server.route("/dead", |_| Reply::Close);
    let app = test_app_with_real_backend(ollama_settings(&server.base()));

    let url = normalize_target_url(&server.url("/dead")).expect("url");
    let error = preflight(&app.handle(), &url)
        .await
        .expect_err("a failed pre-check must not be captured anyway");
    assert_eq!(error.kind(), "network", "{error}");

    if matches!(app.state().snapshot_backend, Backend::Chromium(_)) {
        let error = capture(&app.handle(), &server.url("/dead"))
            .await
            .expect_err("the capture must be rejected");
        assert_eq!(error.kind(), "network", "{error}");
    }
    let files: Vec<_> = fs::read_dir(app.snapshot_dir())
        .expect("dir")
        .flatten()
        .collect();
    assert!(files.is_empty(), "nothing may be captured: {files:?}");
}

/// The browser is pointed at the guarded client's final URL, plus the address the resolver vetted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_preflight_reports_the_final_url_and_a_vetted_address() {
    let server = TestServer::start().await;
    server.route("/start", |_| Reply::redirect(302, "/end"));
    server.route("/end", |_| {
        Reply::html("<!doctype html><html><body>done</body></html>")
    });
    server.route("/wall", |_| {
        Reply::text(
            403,
            "text/html",
            "<html><body>Just a moment...</body></html>",
        )
        .with_header("cf-mitigated", "challenge")
    });
    let app = app_for(&server);

    let url = normalize_target_url(&server.url("/start")).expect("url");
    match preflight(&app.handle(), &url).await.expect("pre-flight") {
        Preflight::Ready { url, pin } => {
            assert!(url.path().ends_with("/end"), "{url} must be the final URL");
            assert_eq!(pin, None, "an IP literal needs no pin");
        }
        other => panic!("unexpected outcome: {other:?}"),
    }

    // A challenge wall is a page-level outcome, not an error.
    let wall = normalize_target_url(&server.url("/wall")).expect("url");
    assert_eq!(
        preflight(&app.handle(), &wall).await.expect("pre-flight"),
        Preflight::Challenge
    );

    // A host name is pinned to the address the guard accepted for it.
    let port = server.base().rsplit(':').next().unwrap_or("0").to_string();
    let named = normalize_target_url(&format!("http://localhost:{port}/end")).expect("url");
    match preflight(&app.handle(), &named).await {
        Ok(Preflight::Ready { pin: Some(pin), .. }) => {
            assert_eq!(pin.host, "localhost");
            assert!(pin.ip.is_loopback(), "{}", pin.ip);
            assert!(pin.resolver_rule().starts_with("MAP localhost "));
        }
        Ok(other) => panic!("localhost must be pinned, got {other:?}"),
        // localhost may resolve to an address the test server does not listen on.
        Err(error) => eprintln!("skipping the pinned-host case: {error}"),
    }
}
