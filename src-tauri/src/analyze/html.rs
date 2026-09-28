//! HTML → readable text + metadata.

use scraper::{ElementRef, Html, Node, Selector};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::util::{cap_chars, collapse_whitespace};

/// Maximum words of readable text kept for the prompt.
pub const MAX_WORDS: usize = 4000;

/// Maximum characters of readable text kept for the prompt; bounds size regardless of word count.
pub const MAX_READABLE_CHARS: usize = 40_000;

/// Longest single whitespace-free token kept; longer runs are cut.
pub const MAX_TOKEN_CHARS: usize = 200;

/// Markup budget checked before parsing: opening tags scanned in the body.
pub const MAX_OPEN_TAGS: usize = 40_000;

/// Markup budget checked before parsing: estimated element nesting depth.
pub const MAX_ESTIMATED_DEPTH: usize = 2_000;

/// Tags that never raise the estimated depth (void elements and optional-end-tag elements).
const NON_NESTING_TAGS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr", "p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead",
    "tbody", "tfoot", "colgroup", "rp", "rt", "html", "head", "body",
];

/// Elements whose content is never readable text.
const SKIP_TAGS: &[&str] = &[
    "script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "button",
    "iframe", "template", "select", "option", "canvas", "video", "audio", "picture", "object",
    "embed", "dialog", "menu",
];

const BLOCK_TAGS: &[&str] = &[
    "p",
    "div",
    "section",
    "article",
    "main",
    "li",
    "ul",
    "ol",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "tr",
    "table",
    "blockquote",
    "pre",
    "dd",
    "dt",
    "figcaption",
    "hr",
];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageContent {
    pub title: Option<String>,
    pub meta_description: Option<String>,
    pub og_title: Option<String>,
    pub og_description: Option<String>,
    /// `og:type` (`website`, `article`, `profile`, ...), lowercased.
    pub og_type: Option<String>,
    pub image_url: Option<Url>,
    pub favicon_url: Option<Url>,
    pub readable_text: String,
    pub word_count: usize,
}

impl PageContent {
    /// Best page title: og:title → <title> → first <h1>.
    pub fn best_title(&self) -> Option<&str> {
        self.og_title
            .as_deref()
            .or(self.title.as_deref())
            .filter(|t| !t.is_empty())
    }

    pub fn best_description(&self) -> Option<&str> {
        self.meta_description
            .as_deref()
            .or(self.og_description.as_deref())
            .filter(|d| !d.is_empty())
    }
}

fn selector(css: &str) -> Option<Selector> {
    Selector::parse(css).ok()
}

fn first_attr(document: &Html, css: &str, attr: &str) -> Option<String> {
    let sel = selector(css)?;
    document
        .select(&sel)
        .filter_map(|el| el.value().attr(attr))
        .map(collapse_whitespace)
        .find(|value| !value.is_empty())
}

fn first_text(document: &Html, css: &str) -> Option<String> {
    let sel = selector(css)?;
    document
        .select(&sel)
        .map(|el| collapse_whitespace(&el.text().collect::<String>()))
        .find(|text| !text.is_empty())
}

fn http_url(base: &Url, href: &str) -> Option<Url> {
    let joined = base.join(href.trim()).ok()?;
    matches!(joined.scheme(), "http" | "https").then_some(joined)
}

/// Picks the favicon from `<link rel=icon|apple-touch-icon>`, falling back to `/favicon.ico`.
fn find_favicon(document: &Html, base: &Url) -> Option<Url> {
    let sel = selector("link[rel][href]")?;
    let mut icon: Option<Url> = None;
    let mut apple: Option<Url> = None;
    for el in document.select(&sel) {
        let rel = el
            .value()
            .attr("rel")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let tokens: Vec<&str> = rel.split_whitespace().collect();
        let Some(href) = el.value().attr("href") else {
            continue;
        };
        if icon.is_none() && tokens.contains(&"icon") {
            icon = http_url(base, href);
        } else if apple.is_none()
            && tokens
                .iter()
                .any(|t| *t == "apple-touch-icon" || *t == "apple-touch-icon-precomposed")
        {
            apple = http_url(base, href);
        }
    }
    icon.or(apple).or_else(|| base.join("/favicon.ico").ok())
}

fn is_hidden(el: &ElementRef<'_>) -> bool {
    let value = el.value();
    value.attr("hidden").is_some()
        || value
            .attr("aria-hidden")
            .is_some_and(|v| v.eq_ignore_ascii_case("true"))
}

/// Max DOM depth walked before `collect_text` stops descending; deeper subtrees are skipped.
/// The binary aborts on panic, so unbounded recursion here would crash the whole app.
const MAX_DEPTH: usize = 256;

fn collect_text(
    element: ElementRef<'_>,
    out: &mut String,
    depth: usize,
    cancel: &CancellationToken,
) {
    if depth >= MAX_DEPTH || cancel.is_cancelled() {
        return;
    }
    for child in element.children() {
        match child.value() {
            Node::Text(text) => out.push_str(text),
            Node::Element(el) => {
                let name = el.name();
                if SKIP_TAGS.contains(&name) {
                    continue;
                }
                let Some(child_ref) = ElementRef::wrap(child) else {
                    continue;
                };
                if is_hidden(&child_ref) {
                    continue;
                }
                let block = BLOCK_TAGS.contains(&name);
                if block {
                    out.push('\n');
                }
                collect_text(child_ref, out, depth + 1, cancel);
                if block {
                    out.push('\n');
                }
            }
            _ => {}
        }
    }
}

/// Normalizes whitespace, drops empty lines, and caps words/chars/token length to module limits.
fn normalize_readable(raw: &str) -> (String, usize) {
    let mut out = String::new();
    let mut words = 0usize;
    let mut chars = 0usize;
    'lines: for line in raw.lines() {
        let mut line_started = false;
        for word in line.split_whitespace() {
            if words >= MAX_WORDS {
                break 'lines;
            }
            let separator = usize::from(!out.is_empty());
            let budget = MAX_READABLE_CHARS.saturating_sub(chars + separator);
            if budget == 0 {
                break 'lines;
            }
            let word = cap_chars(word, MAX_TOKEN_CHARS.min(budget));
            if separator == 1 {
                out.push(if line_started { ' ' } else { '\n' });
            }
            out.push_str(word);
            chars += separator + word.chars().count();
            words += 1;
            line_started = true;
        }
    }
    (out, words)
}

/// Pre-parse budget: cuts the markup before a tag that would exceed `MAX_OPEN_TAGS` or
/// `MAX_ESTIMATED_DEPTH`. `<svg>`/`<math>` nesting uses its own counter since `/>` closes there.
pub fn limit_markup(html: &str) -> &str {
    let bytes = html.as_bytes();
    let mut open_tags = 0usize;
    let mut depth = 0usize;
    // Inside `<svg>`/`<math>`: the root name with how many are open, and the depth below them.
    let mut foreign: Option<(String, usize)> = None;
    let mut foreign_depth = 0usize;
    let mut index = 0usize;
    while let Some(offset) = bytes[index..].iter().position(|b| *b == b'<') {
        let start = index + offset;
        index = start + 1;
        let rest = &bytes[index..];
        let closing = rest.first() == Some(&b'/');
        let name_bytes = &rest[usize::from(closing)..];
        if !name_bytes.first().is_some_and(u8::is_ascii_alphabetic) {
            continue;
        }
        let name_len = name_bytes
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric())
            .count();
        let name = String::from_utf8_lossy(&name_bytes[..name_len]).to_ascii_lowercase();
        let attrs_start = index + usize::from(closing) + name_len;
        let Some((tag_end, self_closing)) = tag_end(bytes, attrs_start) else {
            break; // an unterminated tag runs to the end of the input
        };
        index = tag_end;

        if let Some((root, roots)) = foreign.as_mut() {
            if closing {
                if name == *root {
                    *roots -= 1;
                    if *roots == 0 {
                        foreign = None;
                        foreign_depth = 0;
                        depth = depth.saturating_sub(1);
                    }
                } else {
                    foreign_depth = foreign_depth.saturating_sub(1);
                }
                continue;
            }
            open_tags += 1;
            if !self_closing {
                if name == *root {
                    *roots += 1;
                } else {
                    foreign_depth += 1;
                }
            }
            if open_tags > MAX_OPEN_TAGS || foreign_depth > MAX_ESTIMATED_DEPTH {
                return &html[..start];
            }
            continue;
        }

        let nests = !NON_NESTING_TAGS.contains(&name.as_str());
        if closing {
            if nests {
                depth = depth.saturating_sub(1);
            }
            continue;
        }
        open_tags += 1;
        let foreign_name = name == "svg" || name == "math";
        // `<svg/>` is closed by the parser (foreign content honors `/>`), so it does not nest.
        let foreign_root = foreign_name && !self_closing;
        if nests && !(foreign_name && self_closing) {
            depth += 1;
        }
        if open_tags > MAX_OPEN_TAGS || depth > MAX_ESTIMATED_DEPTH {
            return &html[..start];
        }
        if foreign_root {
            foreign = Some((name, 1));
            continue;
        }
        if name == "script" || name == "style" {
            // Raw text: `<` inside a script is not a tag. Jump past the matching end tag.
            let end_tag = format!("</{name}");
            match find_ignore_ascii_case(&bytes[index..], end_tag.as_bytes()) {
                Some(end) => {
                    index += end + end_tag.len();
                    depth = depth.saturating_sub(1);
                }
                None => break,
            }
        }
    }
    html
}

/// Finds the `>` ending the tag whose attributes start at `from`, skipping quoted values.
/// Returns the index past `>` and whether it's self-closing, or `None` if the input ends first.
fn tag_end(bytes: &[u8], from: usize) -> Option<(usize, bool)> {
    let mut quote: Option<u8> = None;
    let mut after_equals = false;
    let mut previous = 0u8;
    for (offset, &byte) in bytes.get(from..)?.iter().enumerate() {
        if let Some(open) = quote {
            if byte == open {
                quote = None;
                previous = byte;
            }
            continue;
        }
        match byte {
            b'>' => return Some((from + offset + 1, previous == b'/')),
            b'"' | b'\'' if after_equals => {
                quote = Some(byte);
                after_equals = false;
            }
            b'=' => after_equals = true,
            _ if byte.is_ascii_whitespace() => continue,
            _ => after_equals = false,
        }
        previous = byte;
    }
    None
}

fn find_ignore_ascii_case(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
}

fn readable_text(document: &Html, cancel: &CancellationToken) -> (String, usize) {
    let roots = ["article", "main", "[role=main]", "body"];
    let mut best: Option<(String, usize)> = None;
    for css in roots {
        if cancel.is_cancelled() {
            break;
        }
        let Some(sel) = selector(css) else { continue };
        let Some(root) = document.select(&sel).next() else {
            continue;
        };
        let mut raw = String::new();
        collect_text(root, &mut raw, 0, cancel);
        let (text, words) = normalize_readable(&raw);
        // Prefer the most specific container, but only if it carries real content.
        if text.chars().count() >= 200 {
            return (text, words);
        }
        if best.as_ref().is_none_or(|(b, _)| text.len() > b.len()) {
            best = Some((text, words));
        }
    }
    best.unwrap_or_default()
}

/// Extracts metadata and readable text. `base` is the final URL after redirects.
pub fn extract(html: &str, base: &Url) -> PageContent {
    extract_cancellable(html, base, &CancellationToken::new()).unwrap_or_default()
}

/// [`extract`] for work on the blocking pool; returns `None` when cancelled.
/// `spawn_blocking` can't be aborted, so `cancel` frees the thread early between stages.
pub fn extract_cancellable(
    html: &str,
    base: &Url,
    cancel: &CancellationToken,
) -> Option<PageContent> {
    let limited = limit_markup(html);
    if limited.len() < html.len() {
        log::info!(
            "analyze: markup over budget, parsing the first {} of {} bytes",
            limited.len(),
            html.len()
        );
    }
    if cancel.is_cancelled() {
        return None;
    }
    let document = Html::parse_document(limited);
    if cancel.is_cancelled() {
        return None;
    }

    let base = first_attr(&document, "base[href]", "href")
        .and_then(|href| http_url(base, &href))
        .unwrap_or_else(|| base.clone());

    let title = first_text(&document, "head title").or_else(|| first_text(&document, "title"));
    let og_title = first_attr(&document, "meta[property='og:title']", "content");
    let meta_description = first_attr(&document, "meta[name='description']", "content")
        .or_else(|| first_attr(&document, "meta[name='Description']", "content"));
    let og_description = first_attr(&document, "meta[property='og:description']", "content");
    let og_type = first_attr(&document, "meta[property='og:type']", "content")
        .map(|value| value.trim().to_lowercase());
    let image_url = first_attr(&document, "meta[property='og:image']", "content")
        .or_else(|| first_attr(&document, "meta[property='og:image:url']", "content"))
        .or_else(|| first_attr(&document, "meta[name='twitter:image']", "content"))
        .or_else(|| first_attr(&document, "meta[property='twitter:image']", "content"))
        .and_then(|href| http_url(&base, &href));
    let favicon_url = find_favicon(&document, &base);
    let (readable_text, word_count) = readable_text(&document, cancel);
    if cancel.is_cancelled() {
        return None;
    }
    let title = title.or_else(|| first_text(&document, "h1"));

    Some(PageContent {
        title,
        meta_description,
        og_title,
        og_description,
        og_type,
        image_url,
        favicon_url,
        readable_text,
        word_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("http://example.com:8080/blog/post").expect("url")
    }

    #[test]
    fn extracts_metadata_and_text() {
        let html = r#"<!doctype html><html lang="tr-TR"><head>
            <title> Rust  Notes | Blog </title>
            <meta name="description" content="Notes about Rust.">
            <meta property="og:image" content="/img/cover.png">
            <link rel="shortcut icon" href="/static/fav.png">
            <style>body { color: red }</style>
            <script>var tracking = "do not include";</script>
            </head><body>
            <nav>Home About</nav>
            <header>Site header</header>
            <article><h1>Ownership</h1><p>Every value in Rust has an owner.</p>
            <p aria-hidden="true">hidden text</p><p>When the owner goes out of scope the value is dropped.</p></article>
            <footer>Copyright</footer>
            </body></html>"#;
        let page = extract(html, &base());
        assert_eq!(page.title.as_deref(), Some("Rust Notes | Blog"));
        assert_eq!(page.meta_description.as_deref(), Some("Notes about Rust."));
        assert_eq!(
            page.image_url.as_ref().map(Url::as_str),
            Some("http://example.com:8080/img/cover.png")
        );
        assert_eq!(
            page.favicon_url.as_ref().map(Url::as_str),
            Some("http://example.com:8080/static/fav.png")
        );
        assert!(page
            .readable_text
            .contains("Every value in Rust has an owner."));
        assert!(!page.readable_text.contains("tracking"));
        assert!(!page.readable_text.contains("Home About"));
        assert!(!page.readable_text.contains("Copyright"));
        assert!(!page.readable_text.contains("hidden text"));
        assert!(!page.readable_text.contains("color: red"));
    }

    #[test]
    fn favicon_fallback_keeps_port() {
        let page = extract("<html><head></head><body>x</body></html>", &base());
        assert_eq!(
            page.favicon_url.as_ref().map(Url::as_str),
            Some("http://example.com:8080/favicon.ico")
        );
    }

    #[test]
    fn caps_word_count() {
        let body = "word ".repeat(MAX_WORDS + 500);
        let html = format!("<html><body><main><p>{body}</p></main></body></html>");
        let page = extract(&html, &base());
        assert_eq!(page.word_count, MAX_WORDS);
    }

    #[test]
    fn deep_nesting_returns_instead_of_overflowing_the_stack() {
        // html5ever is quadratic in nesting depth, so 10k is as deep as a test can afford.
        const NESTING: usize = 10_000;
        let mut html = String::with_capacity(NESTING * 8);
        html.push_str("<html><body><main><p>Text near the surface of the document.</p>");
        for _ in 0..NESTING {
            html.push_str("<div>");
        }
        html.push_str("buried");

        let page = extract(&html, &base());
        assert!(page
            .readable_text
            .contains("Text near the surface of the document."));
        assert!(
            !page.readable_text.contains("buried"),
            "content below the depth cap is skipped"
        );
    }

    #[test]
    fn a_single_huge_token_is_capped_in_characters() {
        // One 2 MB word with no whitespace; MAX_WORDS alone does not bound it.
        let token = "x".repeat(2 * 1024 * 1024);
        let html = format!("<html><body><main><p>{token}</p></main></body></html>");
        let page = extract(&html, &base());
        assert_eq!(page.word_count, 1);
        assert_eq!(page.readable_text.chars().count(), MAX_TOKEN_CHARS);
    }

    #[test]
    fn readable_text_is_capped_in_characters_on_char_boundaries() {
        let body = "çağrışım ".repeat(30_000);
        let (text, words) = normalize_readable(&body);
        assert!(text.chars().count() <= MAX_READABLE_CHARS);
        assert!(words <= MAX_WORDS);
        let long_words = format!("{} ", "ğ".repeat(150)).repeat(1_000);
        let (text, _) = normalize_readable(&long_words);
        assert_eq!(text.chars().count(), MAX_READABLE_CHARS);
        assert!(text
            .split(' ')
            .all(|w| w.chars().count() <= MAX_TOKEN_CHARS));
    }

    #[test]
    fn markup_budget_cuts_pathological_nesting_before_parsing() {
        let head = "<html><head><title>Kept</title>\
                    <meta name=\"description\" content=\"D\"></head><body>";
        let deep = format!(
            "{head}<main><p>Surface text.</p>{}",
            "<div>".repeat(400_000)
        );
        let limited = limit_markup(&deep);
        assert!(
            limited.len() < 20_000,
            "cut at the depth budget: {}",
            limited.len()
        );
        assert!(limited.starts_with(head));

        let page = extract(&deep, &base());
        assert_eq!(page.title.as_deref(), Some("Kept"));
        assert_eq!(page.meta_description.as_deref(), Some("D"));
        assert!(page.readable_text.contains("Surface text."));

        let flat = format!("{head}{}", "<span>a</span>".repeat(MAX_OPEN_TAGS + 10));
        assert!(limit_markup(&flat).len() < flat.len());
    }

    #[test]
    fn self_closing_svg_shapes_do_not_exhaust_the_depth_budget() {
        let text = "This article text follows a large inline icon and must survive the budget.";
        let html = format!(
            "<html><head><title>Icon</title></head><body><svg>{}</svg><main><p>{}</p></main></body></html>",
            "<path d='x'/>".repeat(5_000),
            text.repeat(4)
        );
        assert_eq!(limit_markup(&html).len(), html.len(), "nothing is cut");
        let page = extract(&html, &base());
        assert!(page.readable_text.contains(text), "{}", page.readable_text);

        // Quoted `>` and `/>` inside attribute values do not end or self-close the tag.
        let quoted = format!(
            "<svg>{}</svg><main>ok</main>",
            "<path title=\"a > b\" d='M0/>'/>".repeat(5_000)
        );
        assert_eq!(limit_markup(&quoted).len(), quoted.len());

        let math = format!(
            "<math>{}</math><svg><svg>{}</svg></svg><main>ok</main>",
            "<mspace/>".repeat(3_000),
            "<circle r='1'/>".repeat(3_000)
        );
        assert_eq!(limit_markup(&math).len(), math.len());
    }

    #[test]
    fn deep_foreign_content_and_html_nesting_are_still_cut() {
        // Unclosed elements inside an SVG nest in the parser.
        let deep_svg = format!("<body><svg>{}</svg><main>x</main>", "<g>".repeat(5_000));
        let limited = limit_markup(&deep_svg);
        assert!(limited.len() < deep_svg.len());
        assert!(limited.len() < 3 * (MAX_ESTIMATED_DEPTH + 10) + 16);

        // In HTML content `<div/>` stays open, so it keeps counting.
        let html_self_closing = format!("<body>{}", "<div/>".repeat(5_000));
        assert!(limit_markup(&html_self_closing).len() < html_self_closing.len());
    }

    #[test]
    fn markup_budget_leaves_normal_pages_alone() {
        let mut html =
            String::from("<!DOCTYPE html><html><head><script>if (a < b && c<d) {}</script>");
        html.push_str("<style>a<b{}</style></head><body>");
        // Unclosed <p>/<li> and void tags do not nest.
        html.push_str(&"<p>para<br><img src=x><li>item".repeat(5_000));
        html.push_str(&"<div><span>x</span></div>".repeat(5_000));
        html.push_str("</body></html>");
        assert_eq!(limit_markup(&html).len(), html.len());
    }

    #[test]
    fn a_cancelled_extraction_returns_nothing() {
        let token = CancellationToken::new();
        token.cancel();
        let html = "<html><head><title>x</title></head><body><p>text</p></body></html>";
        assert_eq!(extract_cancellable(html, &base(), &token), None);
    }

    #[test]
    fn ignores_non_http_icons() {
        let html = r#"<html><head><link rel="icon" href="javascript:alert(1)"></head></html>"#;
        let page = extract(html, &base());
        assert_eq!(
            page.favicon_url.as_ref().map(Url::as_str),
            Some("http://example.com:8080/favicon.ico")
        );
    }
}
