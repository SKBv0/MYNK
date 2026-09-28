//! Size limits, charset decoding and timeout mapping over real responses.

use std::time::Duration;

use app_lib::error::AppError;
use app_lib::http::body::{decode_text, read_limited, Overflow, API_BODY_LIMIT, PAGE_BODY_LIMIT};
use reqwest::Client;

use crate::support::server::{Chunk, Reply, TestServer};

fn client() -> Client {
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("client")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_bodies_are_truncated_at_the_limit() {
    let server = TestServer::start().await;
    server.route("/huge", |_| Reply::html("x".repeat(5 * 1024 * 1024)));

    let response = client()
        .get(server.url("/huge"))
        .send()
        .await
        .expect("request");
    let bytes = read_limited(response, PAGE_BODY_LIMIT, Overflow::Truncate, "Page body")
        .await
        .expect("truncates instead of failing");
    assert_eq!(bytes.len(), PAGE_BODY_LIMIT);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn api_bodies_over_the_limit_are_rejected() {
    let server = TestServer::start().await;
    server.route("/declared", |_| {
        Reply::text(200, "application/json", "y".repeat(API_BODY_LIMIT + 1024))
    });
    server.route("/chunked", |_| {
        let chunks = (0..5)
            .map(|_| Chunk::now(vec![b'z'; 1024 * 1024]))
            .collect();
        Reply::chunked("application/json", chunks)
    });

    for path in ["/declared", "/chunked"] {
        let response = client()
            .get(server.url(path))
            .send()
            .await
            .expect("request");
        let error = read_limited(response, API_BODY_LIMIT, Overflow::Error, "API")
            .await
            .expect_err("oversized API bodies must fail");
        assert_eq!(error.kind(), "network", "{path}: {error}");
        assert!(
            error.to_string().contains("too large") || error.to_string().contains("exceeded"),
            "{path}: {error}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn non_utf8_bodies_are_decoded_from_the_content_type() {
    let server = TestServer::start().await;
    // "Güzel Şeker" in ISO-8859-9.
    let latin5: Vec<u8> = vec![
        0x47, 0xFC, 0x7A, 0x65, 0x6C, 0x20, 0xDE, 0x65, 0x6B, 0x65, 0x72,
    ];
    server.route("/tr", move |_| {
        Reply::text(200, "text/html; charset=ISO-8859-9", latin5.clone())
    });

    let response = client()
        .get(server.url("/tr"))
        .send()
        .await
        .expect("request");
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = read_limited(response, PAGE_BODY_LIMIT, Overflow::Truncate, "Page body")
        .await
        .expect("body");
    assert_eq!(decode_text(&bytes, content_type.as_deref()), "Güzel Şeker");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_responses_map_to_a_timeout_error() {
    let server = TestServer::start().await;
    server.route("/slow", |_| Reply::html("late").with_delay(2_000));

    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(300))
        .build()
        .expect("client");
    let error = client
        .get(server.url("/slow"))
        .send()
        .await
        .expect_err("must time out");
    assert_eq!(AppError::from_reqwest("Fetch", &error).kind(), "timeout");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_connection_maps_to_a_network_error() {
    let server = TestServer::start().await;
    server.route("/rude", |_| Reply::Close);

    let error = client()
        .get(server.url("/rude"))
        .send()
        .await
        .expect_err("closed connection");
    let mapped = AppError::from_reqwest("Fetch", &error);
    assert_eq!(mapped.kind(), "network", "{mapped}");
}
