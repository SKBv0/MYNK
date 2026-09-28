//! URL analysis: fetch → readable text + metadata → grounded LLM extraction.

pub mod html;
pub mod prompt;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::catalog::model::FALLBACK_CATEGORY_ID;
use crate::error::{truncate_chars, AppError, AppResult};
use crate::health::challenge::{self, ChallengeInput, EXCERPT_BYTES};
use crate::http::body::{decode_text, read_limited, Overflow, PAGE_BODY_LIMIT};
use crate::http::guard::{check_url, AddressPolicy};
use crate::http::{
    accept_language, header_text, normalize_target_url, APP_USER_AGENT, LLM_TIMEOUT,
};
use crate::providers::json::{parse_analysis, ParsedAnalysis};
use crate::providers::{self, CompletionRequest, Message, ResponseFormat, Role};
use crate::settings;
use crate::snapshot;
use crate::state::{run_blocking, AppState};
use crate::util::cap_chars;
use html::PageContent;

/// Stable, language-independent category ids (mirrors `CATEGORY_IDS` in ipcTypes.ts).
pub const CATEGORY_IDS: [&str; 15] = [
    "development",
    "design",
    "research",
    "business",
    "news",
    "learning",
    "tools",
    "entertainment",
    "finance",
    "health",
    "shopping",
    "travel",
    "reference",
    "social",
    "other",
];

/// Readable text shorter than this is "insufficient": the LLM never sees page text.
pub const MIN_READABLE_CHARS: usize = 200;

/// End-to-end budget for one analysis: the page fetch, an optional browser render and up to
/// two model calls share it; anything slower is reported as a timeout.
pub const ANALYZE_TIMEOUT: Duration = Duration::from_secs(300);

/// The browser's own share of [`ANALYZE_TIMEOUT`], counted from the moment it may start. It is
/// also the minimum remaining budget for the fallback to be worth queuing for.
pub const BROWSER_FALLBACK_BUDGET: Duration = Duration::from_secs(30);

/// Kept free for the model after a browser render: a first call plus one repair.
const MODEL_RESERVE: Duration = Duration::from_secs(2 * LLM_TIMEOUT.as_secs());

/// When the browser render has to be over, so the model calls after it still fit the budget.
fn render_deadline(deadline: Instant) -> Option<Instant> {
    deadline.checked_sub(MODEL_RESERVE)
}

/// `UiLanguage` in ipcTypes.ts.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    #[default]
    En,
    Tr,
}

impl Lang {
    /// BCP 47 tag, for `Accept-Language` on the pages this analysis fetches.
    pub fn tag(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Tr => "tr",
        }
    }

    pub fn english_name(self) -> &'static str {
        match self {
            Lang::En => "English",
            Lang::Tr => "Turkish",
        }
    }

    /// Instruction appended to every system prompt.
    pub fn respond_instruction(self) -> String {
        format!("Respond in {}.", self.english_name())
    }
}

/// Where the analyzed title, description and text came from (`AnalyzeSource` in ipcTypes.ts).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnalyzeSource {
    /// The guarded HTTP fetch.
    Http,
    /// The headless browser's rendered DOM.
    Browser,
}

/// `AnalyzeResult` in ipcTypes.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResult {
    pub title: String,
    pub description: String,
    pub category_id: String,
    pub tags: Vec<String>,
    pub summary: Vec<String>,
    pub insufficient_content: bool,
    pub confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    pub final_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<AnalyzeSource>,
    /// The AI provider could not be used. The page was already read, so the metadata above is
    /// real; the renderer keeps the title and treats this like the error it wraps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_error: Option<serde_json::Value>,
}

struct Fetched {
    final_url: Url,
    /// HTTP 2xx and an HTML/text body was read.
    ok: bool,
    status: u16,
    cf_mitigated: Option<String>,
    /// The response carried markup; `false` for PDFs, images and bodies that were never read.
    markup: bool,
    html: Option<String>,
}

async fn fetch_page(client: &reqwest::Client, url: &Url, lang: Lang) -> AppResult<Fetched> {
    let failed = |final_url: Url, status: u16, cf_mitigated: Option<String>| Fetched {
        final_url,
        ok: false,
        status,
        cf_mitigated,
        markup: false,
        html: None,
    };
    // The reader's own language, so the page comes back in the language the summary will be in.
    let language = accept_language(lang.tag());
    let request = || {
        client
            .get(url.clone())
            .header(reqwest::header::ACCEPT_LANGUAGE, language.clone())
    };
    // An unreachable page is a failure, not empty content: it keeps its title and can be retried.
    let response = match request().send().await {
        Ok(response) => response,
        Err(error) => {
            let mapped = AppError::from_reqwest("Could not fetch the page", &error);
            // Some bot walls reset the connection for browser user agents yet serve a plain one.
            let retry =
                matches!(mapped, AppError::Network { status: None, .. }) && !error.is_connect();
            let retried = if retry {
                request()
                    .header(reqwest::header::USER_AGENT, APP_USER_AGENT)
                    .send()
                    .await
                    .ok()
            } else {
                None
            };
            match retried {
                Some(response) => {
                    log::info!("analyze: served after retry with the plain user agent");
                    response
                }
                None => {
                    log::info!("analyze: fetch failed ({}): {mapped}", mapped.kind());
                    return Err(mapped);
                }
            }
        }
    };

    let final_url = response.url().clone();
    let status = response.status().as_u16();
    let cf_mitigated = header_text(&response, "cf-mitigated");
    if matches!(status, 404 | 410) {
        return Err(AppError::NotFound(format!(
            "The page does not exist (HTTP {status})."
        )));
    }
    if !response.status().is_success() {
        // Bot walls and server errors (401/403/429/5xx): the page exists; the caller may still
        // try the rendered DOM.
        return Ok(failed(final_url, status, cf_mitigated));
    }
    let content_type =
        header_text(&response, reqwest::header::CONTENT_TYPE).map(|ct| ct.to_ascii_lowercase());
    let is_text = content_type
        .as_deref()
        .is_none_or(|ct| ct.contains("html") || ct.contains("xml") || ct.starts_with("text/"));
    if !is_text {
        // PDFs, images and the like: reachable, but not readable as text.
        return Ok(Fetched {
            final_url,
            ok: true,
            status,
            cf_mitigated,
            markup: false,
            html: None,
        });
    }
    match read_limited(response, PAGE_BODY_LIMIT, Overflow::Truncate, "Page body").await {
        Ok(bytes) => Ok(Fetched {
            final_url,
            ok: true,
            status,
            cf_mitigated,
            markup: true,
            html: Some(decode_text(&bytes, content_type.as_deref())),
        }),
        Err(error) => {
            log::info!("analyze: body read failed: {error}");
            Ok(failed(final_url, status, cf_mitigated))
        }
    }
}

/// confidence = 0.6·grounding + 0.25·min(1, words/400) + 0.15·fetch_ok; ≤ 0.3 if insufficient.
pub fn compute_confidence(
    grounding: Option<f64>,
    llm_used: bool,
    word_count: usize,
    fetch_ok: bool,
    insufficient: bool,
) -> f64 {
    let grounding = if llm_used {
        grounding.unwrap_or(0.5).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let words = (word_count as f64 / 400.0).min(1.0);
    let fetch = if fetch_ok { 1.0 } else { 0.0 };
    let mut confidence = 0.6 * grounding + 0.25 * words + 0.15 * fetch;
    if insufficient {
        confidence = confidence.min(0.3);
    }
    (confidence.clamp(0.0, 1.0) * 100.0).round() / 100.0
}

/// Title comes from the page; the model's title is used only when the page title contains it
/// (e.g. the model dropped a " | Site" suffix) or when the page has no title but real text.
fn choose_title(page: &PageContent, model_title: &str, host: &str, insufficient: bool) -> String {
    let model_title = model_title.trim();
    let title = match page.best_title() {
        Some(page_title) => {
            if !model_title.is_empty()
                && page_title
                    .to_lowercase()
                    .contains(&model_title.to_lowercase())
            {
                model_title.to_string()
            } else {
                page_title.to_string()
            }
        }
        None if !model_title.is_empty() && !insufficient => model_title.to_string(),
        None => host.to_string(),
    };
    truncate_title(&title, prompt::MAX_TITLE_CHARS)
}

/// Cuts a long title at a word boundary; the ellipsis counts toward `max`.
fn truncate_title(title: &str, max: usize) -> String {
    let title = title.trim();
    if title.chars().count() <= max {
        return title.to_string();
    }
    let head: String = title.chars().take(max - 1).collect();
    // A cut that keeps most of the text may fall back to the last space; a shorter one keeps
    // a word fragment rather than dropping half the title.
    let cut = match head.rfind(char::is_whitespace) {
        Some(at) if at >= head.len() * 3 / 5 => head[..at].trim_end().to_string(),
        _ => head,
    };
    format!("{cut}…")
}

struct BuildInput<'a> {
    page: &'a PageContent,
    fetched_ok: bool,
    final_url: &'a Url,
    host: &'a str,
    content_insufficient: bool,
    llm_used: bool,
    source: AnalyzeSource,
}

fn build_result(input: &BuildInput<'_>, parsed: Option<ParsedAnalysis>) -> AnalyzeResult {
    let page = input.page;
    let parsed = parsed.unwrap_or_else(|| ParsedAnalysis {
        title: String::new(),
        description: String::new(),
        category_id: FALLBACK_CATEGORY_ID.to_string(),
        tags: Vec::new(),
        summary: Vec::new(),
        insufficient_content: input.content_insufficient,
        grounding: if input.llm_used { Some(0.0) } else { None },
    });
    let insufficient = input.content_insufficient || parsed.insufficient_content;
    let description = if parsed.description.is_empty() {
        page.best_description().unwrap_or_default().to_string()
    } else {
        parsed.description.clone()
    };

    AnalyzeResult {
        title: choose_title(page, &parsed.title, input.host, insufficient),
        description: truncate_chars(&description, prompt::MAX_DESCRIPTION_CHARS),
        category_id: parsed.category_id,
        tags: parsed.tags,
        // A metadata-only page keeps one grounded line, so it does not read as a failed analysis.
        summary: if insufficient {
            parsed.summary.into_iter().take(1).collect()
        } else {
            parsed.summary
        },
        insufficient_content: insufficient,
        confidence: compute_confidence(
            parsed.grounding,
            input.llm_used,
            page.word_count,
            input.fetched_ok,
            insufficient,
        ),
        favicon_url: page.favicon_url.as_ref().map(Url::to_string).or_else(|| {
            input
                .final_url
                .join("/favicon.ico")
                .ok()
                .map(|u| u.to_string())
        }),
        image_url: page.image_url.as_ref().map(Url::to_string),
        final_url: input.final_url.to_string(),
        source: Some(input.source),
        setup_error: None,
    }
}

/// Page text sent on the second try after a context overflow.
const RETRY_TEXT_CHARS: usize = 4_000;

pub async fn analyze<R: Runtime>(
    app: &AppHandle<R>,
    raw_url: &str,
    lang: Lang,
) -> AppResult<AnalyzeResult> {
    analyze_within(app, raw_url, lang, ANALYZE_TIMEOUT).await
}

/// [`analyze`] with an explicit end-to-end budget (tests use a short one).
pub async fn analyze_within<R: Runtime>(
    app: &AppHandle<R>,
    raw_url: &str,
    lang: Lang,
    budget: Duration,
) -> AppResult<AnalyzeResult> {
    let deadline = Instant::now() + budget;
    match tokio::time::timeout(budget, analyze_inner(app, raw_url, lang, deadline)).await {
        Ok(result) => result,
        Err(_) => Err(AppError::Timeout(format!(
            "The analysis did not finish within {} seconds.",
            budget.as_secs_f64().ceil()
        ))),
    }
}

/// Extracted page plus whether the markup it came from scored as a bot wall.
struct Extracted {
    page: PageContent,
    challenge: bool,
}

/// Parses `body` off the async runtime and scores it for a challenge wall in the same pass, so
/// a multi-megabyte page is only handed to a blocking thread once.
async fn extract_page(
    body: String,
    base: &Url,
    status: u16,
    cf_mitigated: Option<String>,
    cancel: &CancellationToken,
) -> AppResult<Option<Extracted>> {
    let base = base.clone();
    let cancel = cancel.clone();
    run_blocking(move || {
        let final_url = base.to_string();
        let challenge = challenge::is_challenge(&ChallengeInput {
            status,
            final_url: &final_url,
            cf_mitigated: cf_mitigated.as_deref(),
            body: cap_chars(&body, EXCERPT_BYTES),
        });
        Ok(html::extract_cancellable(&body, &base, &cancel)
            .map(|page| Extracted { page, challenge }))
    })
    .await
}

/// Whether the rendered DOM is worth asking for: a wall, a 403, or too little text (any other
/// error status leaves no body). Never for 401/404/410 or non-markup bodies (PDFs, images).
fn wants_rendered_dom(fetched: &Fetched, challenge: bool, content_insufficient: bool) -> bool {
    if fetched.ok && !fetched.markup {
        return false;
    }
    if matches!(fetched.status, 401 | 404 | 410) {
        return false;
    }
    // Only a 2xx body is read, so `challenge` is the wall a 200 status would otherwise hide.
    challenge || fetched.status == 403 || content_insufficient
}

/// Renders the page in the headless browser and extracts it exactly as the HTTP body is
/// extracted. `None` when the rendered DOM is a wall as well, or still too thin to ground on.
async fn render_page<R: Runtime>(
    app: &AppHandle<R>,
    url: &Url,
    policy: AddressPolicy,
    deadline: Instant,
    cancel: &CancellationToken,
) -> AppResult<Option<PageContent>> {
    let Some(dom) =
        snapshot::render_dom(app, url, policy, BROWSER_FALLBACK_BUDGET, deadline, cancel).await
    else {
        return Ok(None);
    };
    // `--dump-dom` reports no status, so the wall is scored on its markup alone.
    let extracted = extract_page(dom, url, 200, None, cancel)
        .await?
        .ok_or_else(AppError::cancelled)?;
    let thin = extracted.page.readable_text.chars().count() < MIN_READABLE_CHARS;
    if extracted.challenge || thin {
        log::info!("analyze: the rendered DOM was a wall or too thin; keeping the HTTP outcome");
        return Ok(None);
    }
    Ok(Some(extracted.page))
}

async fn analyze_inner<R: Runtime>(
    app: &AppHandle<R>,
    raw_url: &str,
    lang: Lang,
    deadline: Instant,
) -> AppResult<AnalyzeResult> {
    let state = app.state::<AppState>();
    let url = normalize_target_url(raw_url)?;
    let settings = settings::load(app).await?;
    let policy = AddressPolicy::for_web(settings.allow_private_network);
    check_url(&url, policy)?;

    let mut fetched =
        fetch_page(state.http.web(settings.allow_private_network), &url, lang).await?;
    // Blocking parsing cannot be aborted; the drop guard frees its thread at the next check.
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let extracted = match fetched.html.take() {
        Some(body) => extract_page(
            body,
            &fetched.final_url,
            fetched.status,
            fetched.cf_mitigated.clone(),
            &cancel,
        )
        .await?
        .ok_or_else(AppError::cancelled)?,
        None => Extracted {
            page: PageContent::default(),
            challenge: false,
        },
    };
    let mut page = extracted.page;
    let mut source = AnalyzeSource::Http;
    let mut fetched_ok = fetched.ok;
    let mut content_insufficient = page.readable_text.chars().count() < MIN_READABLE_CHARS;

    let render_until = render_deadline(deadline).filter(|until| {
        wants_rendered_dom(&fetched, extracted.challenge, content_insufficient)
            && until.saturating_duration_since(Instant::now()) >= BROWSER_FALLBACK_BUDGET
    });
    if let Some(render_until) = render_until {
        if let Some(rendered) =
            render_page(app, &fetched.final_url, policy, render_until, &cancel).await?
        {
            page = rendered;
            source = AnalyzeSource::Browser;
            fetched_ok = true;
            content_insufficient = false;
            log::info!(
                "analyze: the rendered DOM replaced an unusable HTTP response (HTTP {})",
                fetched.status
            );
        }
    }

    // An unbypassed wall is not the page: its title and text must not name the bookmark.
    if extracted.challenge && source == AnalyzeSource::Http {
        page = PageContent::default();
        fetched_ok = false;
        content_insufficient = true;
    }

    let host = fetched
        .final_url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches("www.")
        .to_string();
    let has_metadata = page.best_title().is_some() || page.best_description().is_some();

    let mut build = BuildInput {
        page: &page,
        fetched_ok,
        final_url: &fetched.final_url,
        host: &host,
        content_insufficient,
        llm_used: false,
        source,
    };

    // Nothing to ground on: return metadata only, never ask the model to guess from the URL.
    if content_insufficient && !has_metadata {
        return Ok(build_result(&build, None));
    }

    // Without a usable provider the page still yields its title and description; returning them
    // with the error keeps a bookmark added without AI from being named after its host.
    let provider = match providers::provider_from_settings(&state, &settings).await {
        Ok(provider) => provider,
        Err(error) => {
            let mut result = build_result(&build, None);
            // The same `{ kind, message, code, model }` shape a rejected command carries.
            result.setup_error = Some(serde_json::to_value(&error).unwrap_or_else(
                |_| serde_json::json!({ "kind": error.kind(), "message": error.to_string() }),
            ));
            return Ok(result);
        }
    };
    let make_messages = |text: &str| {
        let user_prompt = prompt::user_prompt(&prompt::PromptInput {
            url: fetched.final_url.as_str(),
            host: &host,
            html_title: page.title.as_deref(),
            og_title: page.og_title.as_deref(),
            meta_description: page.best_description(),
            readable_text: text,
            word_count: page.word_count,
            insufficient: content_insufficient,
            profile: page
                .og_type
                .as_deref()
                .is_some_and(|kind| kind.starts_with("profile")),
            lang,
        });
        vec![
            Message::new(
                Role::System,
                format!(
                    "{}\n{}",
                    prompt::system_prompt(),
                    lang.respond_instruction()
                ),
            ),
            Message::new(Role::User, user_prompt),
        ]
    };
    let request_for = |messages: Vec<Message>| CompletionRequest {
        messages,
        format: ResponseFormat::JsonSchema(prompt::response_schema()),
        temperature: 0.2,
        max_tokens: Some(1024),
        disable_thinking: true,
    };
    build.llm_used = true;

    let mut messages = make_messages(&page.readable_text);
    let first = match provider.complete(&request_for(messages.clone())).await {
        Ok(first) => first,
        // The token estimate undercounts dense scripts like Japanese, and the context requested
        // shrinks with the text, so the second try sends a short head of the page.
        Err(error) if providers::ollama::is_input_too_long(&error) => {
            log::info!("analyze: the page text overflowed the model's context, retrying shorter");
            messages = make_messages(cap_chars(&page.readable_text, RETRY_TEXT_CHARS));
            provider.complete(&request_for(messages.clone())).await?
        }
        Err(error) => return Err(error),
    };
    let mut parsed = parse_analysis(&first);

    if parsed.is_none() {
        log::info!("analyze: model output was not valid JSON, retrying once");
        messages.push(Message::new(Role::Assistant, truncate_chars(&first, 4000)));
        messages.push(Message::new(Role::User, prompt::REPAIR_PROMPT));
        let repair = CompletionRequest {
            messages,
            format: ResponseFormat::JsonObject,
            temperature: 0.0,
            max_tokens: Some(1024),
            disable_thinking: true,
        };
        let second = provider.complete(&repair).await?;
        parsed = parse_analysis(&second);
        if parsed.is_none() {
            log::warn!(
                "analyze: {} ({}) returned unparseable output twice; using metadata fallback",
                provider.label(),
                provider.model()
            );
        }
    }

    Ok(build_result(&build, parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confidence_weighs_grounding_length_and_fetch_and_caps_thin_pages() {
        assert_eq!(compute_confidence(Some(1.0), true, 400, true, false), 1.0);
        assert_eq!(compute_confidence(None, true, 0, false, false), 0.3);
        assert_eq!(compute_confidence(Some(0.9), true, 800, true, true), 0.3);
        assert_eq!(compute_confidence(None, false, 100, true, true), 0.21);
        assert_eq!(compute_confidence(Some(5.0), true, 100, true, false), 0.81);
    }

    fn page(title: Option<&str>) -> PageContent {
        PageContent {
            title: title.map(str::to_string),
            ..PageContent::default()
        }
    }

    #[test]
    fn a_long_title_is_cut_at_a_word_and_stays_within_the_limit() {
        let long = "GitHub - tauri-apps/tauri: Build smaller, faster, and more secure desktop and mobile applications with a web frontend.";
        let cut = truncate_title(long, 90);
        assert!(cut.chars().count() <= 90, "{cut}");
        assert!(cut.ends_with("…"), "{cut}");
        assert!(!cut.ends_with(" …"), "{cut}");
        let before_ellipsis = cut.trim_end_matches('…');
        assert!(long.starts_with(before_ellipsis), "{cut}");
        assert!(
            long[before_ellipsis.len()..].starts_with(' '),
            "cut inside a word: {cut}"
        );
        assert_eq!(truncate_title("  Short  ", 90), "Short");
        // One unbroken token keeps its head instead of vanishing.
        assert_eq!(
            truncate_title(&"x".repeat(100), 10),
            format!("{}…", "x".repeat(9))
        );
    }

    #[test]
    fn title_is_grounded_in_page() {
        let p = page(Some("Ownership - The Rust Book | Rust"));
        assert_eq!(
            choose_title(&p, "Ownership - The Rust Book", "rust-lang.org", false),
            "Ownership - The Rust Book"
        );
        assert_eq!(
            choose_title(&p, "Totally invented", "rust-lang.org", false),
            "Ownership - The Rust Book | Rust"
        );
        assert_eq!(
            choose_title(&page(None), "Invented", "example.com", true),
            "example.com"
        );
    }

    fn fetched(status: u16, ok: bool, markup: bool) -> Fetched {
        Fetched {
            final_url: Url::parse("https://example.com/").expect("url"),
            ok,
            status,
            cf_mitigated: None,
            markup,
            html: None,
        }
    }

    #[test]
    fn the_browser_is_asked_only_where_it_can_help() {
        let served = fetched(200, true, true);
        assert!(!wants_rendered_dom(&served, false, false));
        // A wall served with 200: neither the status nor the text length gives it away.
        assert!(wants_rendered_dom(&served, true, false));
        assert!(wants_rendered_dom(&served, false, true));
        assert!(wants_rendered_dom(
            &fetched(403, false, false),
            false,
            false
        ));
        for status in [401, 404, 410] {
            assert!(
                !wants_rendered_dom(&fetched(status, false, false), true, true),
                "{status}"
            );
        }
        // Another error status leaves no body to read, so the browser gets a try.
        for status in [408, 429, 500, 503] {
            assert!(
                wants_rendered_dom(&fetched(status, false, false), false, true),
                "{status}"
            );
        }
        // A PDF or an image: reachable, and no rendering makes it readable.
        assert!(!wants_rendered_dom(&fetched(200, true, false), false, true));
    }

    #[test]
    fn a_render_leaves_the_model_its_time() {
        let start = Instant::now();
        let until =
            render_deadline(start + ANALYZE_TIMEOUT).expect("the budget covers the reserve");
        assert_eq!(start + ANALYZE_TIMEOUT - until, 2 * LLM_TIMEOUT);
        // A fetch that used its plain retry as well still leaves the browser its whole share.
        assert!(until - start >= 2 * crate::http::WEB_TIMEOUT + BROWSER_FALLBACK_BUDGET);
    }

    #[test]
    fn thin_page_without_model_answer_falls_back_to_metadata() {
        let url = Url::parse("https://example.com/a").expect("url");
        let p = PageContent {
            title: Some("Example".into()),
            meta_description: Some("Desc".into()),
            ..PageContent::default()
        };
        let result = build_result(
            &BuildInput {
                page: &p,
                fetched_ok: true,
                final_url: &url,
                host: "example.com",
                content_insufficient: true,
                llm_used: true,
                source: AnalyzeSource::Http,
            },
            None,
        );
        assert_eq!(result.title, "Example");
        assert_eq!(result.description, "Desc");
        assert_eq!(result.category_id, "other");
        assert!(result.summary.is_empty());
        assert!(result.insufficient_content);
        assert!(result.confidence <= 0.3);
        assert_eq!(
            result.favicon_url.as_deref(),
            Some("https://example.com/favicon.ico")
        );
        assert_eq!(result.final_url, "https://example.com/a");
    }
}
