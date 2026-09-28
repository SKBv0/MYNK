//! Shared HTTP clients. Built once at startup and stored in `AppState`.

pub mod body;
pub mod guard;
pub mod ollama;

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE};
use reqwest::redirect::Policy;
use reqwest::Client;
use url::Url;

use crate::error::{AppError, AppResult};
use guard::{redirect_policy, AddressPolicy, GuardedResolver};

/// Realistic desktop browser UA; many sites reject unknown agents with 403.
pub const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
pub const APP_USER_AGENT: &str = concat!("MYNK/", env!("CARGO_PKG_VERSION"));

/// Sent when no UI language is in play (health scans, media and favicon fetches). Kept
/// neutral so it does not reveal which language the user reads.
pub const DEFAULT_ACCEPT_LANGUAGE: &str = "en-US,en;q=0.9";

pub const WEB_TIMEOUT: Duration = Duration::from_secs(15);
pub const LLM_TIMEOUT: Duration = Duration::from_secs(120);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

pub struct HttpClients {
    web_public: Client,
    web_private: Client,
    ollama_loopback: Client,
    ollama_private: Client,
    openrouter: Client,
}

/// A response header as text; `None` when it is missing or not visible ASCII.
pub fn header_text(
    response: &reqwest::Response,
    name: impl reqwest::header::AsHeaderName,
) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// `Accept-Language` for a request made on the user's behalf, from the UI language tag. English
/// stays behind it as the fallback most sites can serve.
pub fn accept_language(tag: &str) -> HeaderValue {
    let tag = tag.trim();
    if tag.is_empty() || tag.eq_ignore_ascii_case("en") {
        return HeaderValue::from_static(DEFAULT_ACCEPT_LANGUAGE);
    }
    HeaderValue::from_str(&format!("{tag},en-US;q=0.9,en;q=0.8"))
        .unwrap_or_else(|_| HeaderValue::from_static(DEFAULT_ACCEPT_LANGUAGE))
}

fn web_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        ),
    );
    headers.insert(
        ACCEPT_LANGUAGE,
        HeaderValue::from_static(DEFAULT_ACCEPT_LANGUAGE),
    );
    headers
}

/// Web client: guarded resolver + per-hop redirect checks; no proxy, so the guard always sees
/// the real target host. HTTP/1.1 only: some sites reset h2 streams mid-response.
fn build_web(policy: AddressPolicy) -> AppResult<Client> {
    Client::builder()
        .user_agent(BROWSER_USER_AGENT)
        .http1_only()
        .default_headers(web_headers())
        .timeout(WEB_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(redirect_policy(policy))
        .dns_resolver(GuardedResolver::new(policy))
        .no_proxy()
        .build()
        .map_err(|e| AppError::internal(format!("Could not build HTTP client: {e}")))
}

/// Ollama client: guarded, no redirects, long timeout.
fn build_ollama(policy: AddressPolicy) -> AppResult<Client> {
    ollama::build_client(policy, LLM_TIMEOUT)
        .map_err(|e| AppError::internal(format!("Could not build HTTP client: {e}")))
}

/// OpenRouter client: fixed public host, no redirects, and the system proxy is allowed because the
/// destination is hard-coded; `.no_proxy()` here would cut off proxy-only corporate networks.
fn build_openrouter() -> AppResult<Client> {
    Client::builder()
        .user_agent(APP_USER_AGENT)
        .timeout(LLM_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(Policy::none())
        .build()
        .map_err(|e| AppError::internal(format!("Could not build HTTP client: {e}")))
}

impl HttpClients {
    pub fn new() -> AppResult<Self> {
        Ok(Self {
            web_public: build_web(AddressPolicy::PublicOnly)?,
            web_private: build_web(AddressPolicy::AllowPrivate)?,
            ollama_loopback: build_ollama(AddressPolicy::AllowLoopback)?,
            ollama_private: build_ollama(AddressPolicy::AllowPrivate)?,
            openrouter: build_openrouter()?,
        })
    }

    /// Client for bookmark / page URLs.
    pub fn web(&self, allow_private_network: bool) -> &Client {
        if allow_private_network {
            &self.web_private
        } else {
            &self.web_public
        }
    }

    pub fn ollama(&self, allow_private_network: bool) -> &Client {
        if allow_private_network {
            &self.ollama_private
        } else {
            &self.ollama_loopback
        }
    }

    pub fn openrouter(&self) -> &Client {
        &self.openrouter
    }
}

/// True when `raw` starts with `<scheme>:` (and not `host:port`).
fn has_scheme(raw: &str) -> bool {
    let Some(colon) = raw.find(':') else {
        return false;
    };
    let scheme = &raw[..colon];
    let mut chars = scheme.chars();
    let valid_scheme = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    let after = raw[colon + 1..].chars().next();
    valid_scheme && !after.is_some_and(|c| c.is_ascii_digit())
}

/// Parses a user/bookmark URL: adds `https://` when no scheme is given, accepts only
/// http/https with a host. Does NOT apply the SSRF policy (see `guard::check_url`).
pub fn normalize_target_url(raw: &str) -> AppResult<Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_input("URL cannot be empty."));
    }
    let candidate = if has_scheme(trimmed) {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url =
        Url::parse(&candidate).map_err(|e| AppError::invalid_input(format!("Invalid URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::invalid_input(
            "Only http/https URLs are supported.",
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(AppError::invalid_input("URL must include a host."));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_language_preference_names_no_user() {
        let headers = web_headers();
        assert_eq!(
            headers[ACCEPT_LANGUAGE],
            HeaderValue::from_static("en-US,en;q=0.9")
        );
        assert_eq!(accept_language("en"), headers[ACCEPT_LANGUAGE]);
        assert_eq!(accept_language("  "), headers[ACCEPT_LANGUAGE]);
        assert_eq!(accept_language("tr"), "tr,en-US;q=0.9,en;q=0.8");
        // A tag that cannot go in a header falls back to the default.
        assert_eq!(accept_language("t\nr"), headers[ACCEPT_LANGUAGE]);
    }

    #[test]
    fn normalizes_target_urls() {
        let ok = |s: &str| normalize_target_url(s).expect(s).to_string();
        assert_eq!(ok("example.com"), "https://example.com/");
        assert_eq!(ok("localhost:3000/x"), "https://localhost:3000/x");
        assert_eq!(ok(" http://example.com/a?b=1 "), "http://example.com/a?b=1");
        assert!(normalize_target_url("javascript:alert(1)").is_err());
        assert!(normalize_target_url("file:///C:/secret.txt").is_err());
        assert!(normalize_target_url("mailto:a@b.c").is_err());
        assert!(normalize_target_url("").is_err());
    }
}
