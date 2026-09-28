//! SSRF guard over real sockets and real DNS: the production clients, the guarded resolver and
//! the per-hop redirect policy.

use std::time::Duration;

use app_lib::error::AppError;
use std::net::SocketAddr;

use app_lib::http::guard::{
    check_url, redirect_policy, vet_resolved, AddressPolicy, BlockedAddressError, DnsLookupError,
    GuardedResolver, MAX_REDIRECTS,
};
use app_lib::http::{normalize_target_url, HttpClients};
use reqwest::dns::{Name, Resolve};
use reqwest::Client;
use url::Url;

use crate::support::server::{Reply, TestServer};

/// A client built from the production guard pieces; only the policy is chosen by the test.
fn guarded_client(policy: AddressPolicy) -> Client {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(redirect_policy(policy))
        .dns_resolver(GuardedResolver::new(policy))
        .no_proxy()
        .build()
        .expect("client")
}

fn map(context: &str, error: reqwest::Error) -> AppError {
    AppError::from_reqwest(context, &error)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ip_literals_are_stopped_by_check_url_and_loopback_opens_up_with_the_flag() {
    let server = TestServer::start().await;
    server.route("/", |_| Reply::html("hello"));
    let target = Url::parse(&server.url("/")).expect("url");

    // reqwest never consults the DNS resolver for an IP literal; check_url is what stops this.
    assert_eq!(
        check_url(&target, AddressPolicy::PublicOnly)
            .expect_err("loopback must be refused")
            .kind(),
        "blockedAddress"
    );
    assert_eq!(server.total_hits(), 0);

    check_url(&target, AddressPolicy::AllowPrivate).expect("private policy allows loopback");
    let clients = HttpClients::new().expect("clients");
    let response = clients
        .web(true)
        .get(server.url("/"))
        .send()
        .await
        .expect("allowPrivateNetwork must permit loopback");
    assert_eq!(response.status(), 200);
    assert_eq!(server.hits("/"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolver_uses_real_dns_and_applies_the_policy() {
    let name = || -> Name { "localhost".parse().expect("name") };
    let blocked = GuardedResolver::new(AddressPolicy::PublicOnly)
        .resolve(name())
        .await
        .err()
        .expect("localhost is loopback");
    assert!(blocked.downcast_ref::<BlockedAddressError>().is_some());

    let allowed = GuardedResolver::new(AddressPolicy::AllowLoopback)
        .resolve(name())
        .await
        .expect("loopback policy resolves localhost");
    assert!(allowed.count() > 0);

    let unknown: Name = "mynk-nonexistent-host.invalid".parse().expect("name");
    let error = GuardedResolver::new(AddressPolicy::AllowPrivate)
        .resolve(unknown)
        .await
        .err()
        .expect("an unresolvable name must fail");
    let dns = error
        .downcast_ref::<DnsLookupError>()
        .expect("DnsLookupError");
    assert!(dns.not_found, "expected an authoritative NXDOMAIN: {dns}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hostname_that_resolves_to_loopback_is_blocked_end_to_end() {
    let server = TestServer::start().await;
    server.route("/", |_| Reply::html("hello"));
    let port = server.base().rsplit(':').next().unwrap_or("0").to_string();

    let client = guarded_client(AddressPolicy::PublicOnly);
    let error = client
        .get(format!("http://localhost:{port}/"))
        .send()
        .await
        .expect_err("localhost must not be reachable under PublicOnly");
    assert_eq!(map("fetch", error).kind(), "blockedAddress");
    assert_eq!(server.total_hits(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redirect_hops_are_re_validated() {
    let server = TestServer::start().await;
    server.route("/to-private", |_| {
        Reply::redirect(302, "http://10.0.0.7/secret")
    });
    server.route("/to-metadata", |_| {
        Reply::redirect(302, "http://169.254.169.254/latest/meta-data/")
    });

    let loopback = guarded_client(AddressPolicy::AllowLoopback);
    let error = loopback
        .get(server.url("/to-private"))
        .send()
        .await
        .expect_err("a redirect into private space must be refused");
    assert_eq!(map("fetch", error).kind(), "blockedAddress");

    // Even with private networking enabled, cloud metadata stays out of reach.
    let private = guarded_client(AddressPolicy::AllowPrivate);
    let error = private
        .get(server.url("/to-metadata"))
        .send()
        .await
        .expect_err("metadata endpoints are never allowed");
    assert_eq!(map("fetch", error).kind(), "blockedAddress");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn allowed_redirect_chains_are_followed_and_capped() {
    let server = TestServer::start().await;
    server.route("/a", |_| Reply::redirect(302, "/b"));
    server.route("/b", |_| Reply::redirect(301, "/final"));
    server.route("/final", |_| Reply::html("arrived"));
    let base = server.base();
    server.route("/loop", {
        let base = base.clone();
        move |_| Reply::redirect(302, &format!("{base}/loop"))
    });

    let client = guarded_client(AddressPolicy::AllowLoopback);
    let response = client.get(server.url("/a")).send().await.expect("follows");
    assert_eq!(response.status(), 200);
    assert!(response.url().path().ends_with("/final"));
    assert_eq!(response.text().await.expect("body"), "arrived");

    let error = client
        .get(server.url("/loop"))
        .send()
        .await
        .expect_err("redirect loops must stop");
    assert!(error.is_redirect(), "{error}");
    // The first request plus MAX_REDIRECTS followed hops.
    assert_eq!(server.hits("/loop"), MAX_REDIRECTS + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exactly_max_redirects_hops_are_allowed() {
    let server = TestServer::start().await;
    // /hop1 -> /hop2 -> … -> /hop{MAX_REDIRECTS + 1} -> /arrived
    for i in 1..=MAX_REDIRECTS + 1 {
        let next = if i == MAX_REDIRECTS + 1 {
            "/arrived".to_string()
        } else {
            format!("/hop{}", i + 1)
        };
        server.route(&format!("/hop{i}"), move |_| {
            Reply::redirect(302, next.as_str())
        });
    }
    server.route("/arrived", |_| Reply::html("arrived"));
    let client = guarded_client(AddressPolicy::AllowLoopback);

    // Starting at /hop2 there are exactly MAX_REDIRECTS hops left: all of them are followed.
    let response = client
        .get(server.url("/hop2"))
        .send()
        .await
        .expect("MAX_REDIRECTS hops must be allowed");
    assert_eq!(response.status(), 200);
    assert!(response.url().path().ends_with("/arrived"));

    // Starting at /hop1 needs MAX_REDIRECTS + 1 hops, one too many.
    server.reset_log();
    let error = client
        .get(server.url("/hop1"))
        .send()
        .await
        .expect_err("one hop past the limit must be refused");
    assert!(error.is_redirect(), "{error}");
    assert_eq!(server.hits("/arrived"), 0, "the last hop is never taken");
}

#[test]
fn check_url_rejects_non_http_and_reserved_hosts() {
    let url = |s: &str| Url::parse(s).expect("url");
    assert!(check_url(&url("https://example.com/x"), AddressPolicy::PublicOnly).is_ok());
    assert_eq!(
        check_url(&url("http://127.0.0.1:8080/"), AddressPolicy::PublicOnly)
            .expect_err("loopback")
            .kind(),
        "blockedAddress"
    );
    assert!(check_url(&url("http://[::1]/"), AddressPolicy::AllowLoopback).is_ok());
    assert_eq!(
        check_url(
            &url("http://169.254.169.254/latest"),
            AddressPolicy::AllowPrivate
        )
        .expect_err("metadata")
        .kind(),
        "blockedAddress"
    );
    assert_eq!(
        check_url(&url("ftp://example.com/"), AddressPolicy::AllowPrivate)
            .expect_err("scheme")
            .kind(),
        "invalidInput"
    );
}

#[test]
fn alternative_ipv4_spellings_are_normalized_and_blocked() {
    for raw in [
        "http://2130706433/",
        "http://0177.0.0.1/",
        "http://0x7f.1/",
        "http://0x7f000001/",
        "http://127.1/",
        "http://0177.1/",
        "http://017700000001/",
    ] {
        let url = normalize_target_url(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
        assert_eq!(url.host_str(), Some("127.0.0.1"), "{raw}");
        assert_eq!(
            check_url(&url, AddressPolicy::PublicOnly)
                .expect_err(raw)
                .kind(),
            "blockedAddress",
            "{raw}"
        );
    }
    // The same spellings of the metadata address stay blocked even with private networking.
    for raw in [
        "http://2852039166/",
        "http://0xa9.0xfe.0xa9.0xfe/",
        "http://0251.0376.43518/",
    ] {
        let url = normalize_target_url(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
        assert_eq!(url.host_str(), Some("169.254.169.254"), "{raw}");
        assert!(
            check_url(&url, AddressPolicy::AllowPrivate).is_err(),
            "{raw}"
        );
    }
}

#[test]
fn a_name_resolving_to_public_and_blocked_addresses_is_refused_entirely() {
    let addr = |s: &str| -> SocketAddr { format!("{s}:0").parse().expect("socket addr") };

    let mixed = vec![addr("93.184.216.34"), addr("127.0.0.1")];
    let error = vet_resolved("rebind.example", mixed, AddressPolicy::PublicOnly)
        .expect_err("one loopback answer taints the whole name");
    assert!(error.downcast_ref::<BlockedAddressError>().is_some());

    let reversed = vec![addr("10.0.0.1"), addr("93.184.216.34")];
    assert!(vet_resolved("rebind.example", reversed, AddressPolicy::PublicOnly).is_err());

    let v6_mixed = vec![addr("[2606:4700::1111]"), addr("[::1]")];
    assert!(vet_resolved("rebind.example", v6_mixed, AddressPolicy::PublicOnly).is_err());

    // Private networking allows the private answer, but metadata is never allowed.
    let metadata = vec![addr("192.168.1.2"), addr("169.254.169.254")];
    assert!(vet_resolved("rebind.example", metadata, AddressPolicy::AllowPrivate).is_err());

    let public = vec![addr("93.184.216.34"), addr("[2606:2800:220:1::1]")];
    assert_eq!(
        vet_resolved("example.com", public.clone(), AddressPolicy::PublicOnly).expect("public"),
        public
    );

    let empty = vet_resolved("nothing.example", Vec::new(), AddressPolicy::PublicOnly)
        .expect_err("no answers");
    assert!(empty
        .downcast_ref::<DnsLookupError>()
        .is_some_and(|dns| dns.not_found));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redirect_that_changes_the_scheme_is_refused() {
    let server = TestServer::start().await;
    server.route("/to-file", |_| Reply::redirect(302, "file:///etc/passwd"));
    server.route("/to-windows-file", |_| {
        Reply::redirect(302, "file:///C:/Windows/win.ini")
    });
    server.route("/to-ftp", |_| Reply::redirect(301, "ftp://127.0.0.1/pub"));

    let clients = HttpClients::new().expect("clients");
    for path in ["/to-file", "/to-windows-file", "/to-ftp"] {
        for client in [
            &guarded_client(AddressPolicy::AllowPrivate),
            clients.web(true),
        ] {
            // Either outcome is safe; what must never happen is a followed hop.
            match client.get(server.url(path)).send().await {
                Ok(response) => {
                    assert!(response.status().is_redirection(), "{path}: {response:?}");
                    assert_eq!(
                        response.url().as_str(),
                        server.url(path),
                        "{path}: the redirect must not be followed"
                    );
                }
                Err(error) => {
                    let mapped = map("fetch", error);
                    assert!(
                        matches!(mapped.kind(), "blockedAddress" | "network"),
                        "{path}: {} {mapped}",
                        mapped.kind()
                    );
                }
            }
        }
    }
    assert_eq!(
        server.hits("/to-file"),
        2,
        "one request per client, no hop taken"
    );
}
