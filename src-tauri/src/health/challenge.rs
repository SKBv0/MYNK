//! Bot-protection / challenge page detection via weighted signals. Body-only Cloudflare markers
//! score MEDIUM only on a short page or a non-success status, because Bot Fight Mode injects them
//! into ordinary 200 pages too.

/// Reached by one STRONG signal alone, or at least a MEDIUM plus a WEAK one.
pub const CHALLENGE_THRESHOLD: u32 = 3;

/// Bytes of the body inspected.
pub const EXCERPT_BYTES: usize = 256 * 1024;

const STRONG: u32 = 3;
const MEDIUM: u32 = 2;
const WEAK: u32 = 1;

#[derive(Debug, Clone, Copy, Default)]
pub struct ChallengeInput<'a> {
    pub status: u16,
    pub final_url: &'a str,
    /// Value of the `cf-mitigated` response header, if any.
    pub cf_mitigated: Option<&'a str>,
    /// Beginning of the (decoded) body.
    pub body: &'a str,
}

fn page_title(lower_body: &str) -> Option<&str> {
    let start = lower_body.find("<title")?;
    let open_end = lower_body[start..].find('>')? + start + 1;
    let close = lower_body[open_end..].find("</title>")? + open_end;
    Some(lower_body[open_end..close].trim())
}

/// Rough visible-text length: characters outside `<…>` tags, short page vs. real page.
fn visible_text_len(body: &str) -> usize {
    let mut in_tag = false;
    let mut count = 0usize;
    for c in body.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag && !c.is_whitespace() => count += 1,
            _ => {}
        }
    }
    count
}

pub fn challenge_score(input: &ChallengeInput<'_>) -> u32 {
    let mut score = 0u32;
    let url = input.final_url.to_ascii_lowercase();
    let body = input.body.to_lowercase();
    let title = page_title(&body).unwrap_or_default();

    if cf_mitigated_is_challenge(input.cf_mitigated) {
        score += STRONG;
    }
    if url_is_challenge(&url) {
        score += STRONG;
    }
    let short_page = visible_text_len(input.body) < 1500;
    let non_success = !(200..300).contains(&input.status);
    if title.starts_with("just a moment") || title == "attention required! | cloudflare" {
        score += STRONG;
    }
    // DataDome / PerimeterX / Imperva interstitials, and Reddit's own JS check.
    if body.contains("captcha-delivery.com")
        || body.contains("px-captcha")
        || body.contains("_incapsula_resource")
        || body.contains("name=\"js_challenge\"")
    {
        score += STRONG;
    }

    let cloudflare_body = body.contains("/cdn-cgi/challenge-platform/")
        || body.contains("_cf_chl_opt")
        || body.contains("cf-chl-")
        || body.contains("cf_chl_");
    if cloudflare_body && (short_page || non_success) {
        score += MEDIUM;
    }
    let captcha_widget = body.contains("g-recaptcha")
        || body.contains("h-captcha")
        || body.contains("cf-turnstile")
        || body.contains("challenges.cloudflare.com/turnstile");
    if captcha_widget && short_page {
        score += MEDIUM;
    }
    if [
        "checking your browser before accessing",
        "verify you are human",
        "verifying you are human",
        "please complete the security check",
        "enable javascript and cookies to continue",
        "robot olmadığınızı doğrulayın",
        "güvenlik doğrulaması",
    ]
    .iter()
    .any(|phrase| body.contains(phrase))
    {
        score += MEDIUM;
    }

    if matches!(input.status, 403 | 429 | 503) {
        score += WEAK;
    }
    if short_page && (body.contains("captcha") || body.contains("security check")) {
        score += WEAK;
    }

    score
}

pub fn is_challenge(input: &ChallengeInput<'_>) -> bool {
    challenge_score(input) >= CHALLENGE_THRESHOLD
}

/// Cloudflare's `cf-mitigated: challenge` response header.
pub fn cf_mitigated_is_challenge(value: Option<&str>) -> bool {
    value.is_some_and(|v| v.trim().eq_ignore_ascii_case("challenge"))
}

/// Cheap URL-only check used by link health (no body available).
pub fn url_is_challenge(final_url: &str) -> bool {
    let url = final_url.to_ascii_lowercase();
    url.contains("/cdn-cgi/challenge-platform") || url.contains("__cf_chl")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(status: u16, url: &'a str, body: &'a str) -> ChallengeInput<'a> {
        ChallengeInput {
            status,
            final_url: url,
            cf_mitigated: None,
            body,
        }
    }

    #[test]
    fn cloudflare_interstitial_is_challenge() {
        let body = r#"<html><head><title>Just a moment...</title></head><body>
            <script>window._cf_chl_opt={cvId:'3'};</script>
            <div>Checking your browser before accessing example.com.</div></body></html>"#;
        assert!(is_challenge(&input(403, "https://example.com/", body)));
    }

    #[test]
    fn cf_mitigated_header_is_challenge() {
        let mut i = input(403, "https://example.com/", "<html></html>");
        i.cf_mitigated = Some("challenge");
        assert!(is_challenge(&i));
    }

    #[test]
    fn the_cf_mitigated_value_is_read_loosely() {
        assert!(cf_mitigated_is_challenge(Some(" Challenge ")));
        assert!(!cf_mitigated_is_challenge(Some("block")));
        assert!(!cf_mitigated_is_challenge(None));
    }

    #[test]
    fn datadome_is_challenge() {
        let body = r#"<html><body><iframe src="https://geo.captcha-delivery.com/captcha/"></iframe></body></html>"#;
        assert!(is_challenge(&input(403, "https://shop.example/", body)));
    }

    #[test]
    fn mentioning_cloudflare_with_403_is_not_challenge() {
        let body = "<html><head><title>Forbidden</title></head><body>\
            <p>This site is protected by Cloudflare. Access denied.</p></body></html>";
        assert!(!is_challenge(&input(403, "https://example.com/", body)));
    }

    #[test]
    fn verification_in_url_is_not_challenge() {
        let body = "<html><head><title>Verify your email</title></head><body>ok</body></html>";
        assert!(!is_challenge(&input(
            200,
            "https://example.com/account/email-verification",
            body
        )));
    }

    #[test]
    fn long_page_with_recaptcha_form_is_not_challenge() {
        let article = "Lorem ipsum dolor sit amet. ".repeat(200);
        let body = format!(
            "<html><head><title>Contact us</title></head><body><article>{article}</article>\
             <form><div class=\"g-recaptcha\"></div></form></body></html>"
        );
        assert!(!is_challenge(&input(
            200,
            "https://example.com/contact",
            &body
        )));
    }

    #[test]
    fn short_captcha_page_with_403_is_challenge() {
        let body = "<html><head><title>Security check</title></head><body>\
            <p>Please complete the security check to access the site.</p>\
            <div class=\"h-captcha\"></div></body></html>";
        assert!(is_challenge(&input(403, "https://example.com/", body)));
    }

    fn normal_article(extra: &str) -> String {
        let article = "<p>Rust ownership explained in plain words for everyone. </p>".repeat(900);
        format!(
            "<html><head><title>An ordinary article</title>{extra}</head><body>             <article>{article}</article></body></html>"
        )
    }

    #[test]
    fn injected_cloudflare_jsd_script_on_a_normal_page_is_not_challenge() {
        let jsd = "<script>(function(){window.__CF$cv$params={r:'8a1b',t:'MTcy'};            var a=document.createElement('script');            a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';            document.getElementsByTagName('head')[0].appendChild(a);})();</script>";
        let body = normal_article(jsd);
        assert!(body.len() > 50_000, "{}", body.len());
        let page = input(200, "https://blog.example/post", &body);
        assert!(!is_challenge(&page), "score {}", challenge_score(&page));

        // Even a short 200 page with only the injected script is not a wall.
        let short = format!("<html><head><title>Home</title>{jsd}</head><body>Hi</body></html>");
        assert!(!is_challenge(&input(200, "https://blog.example/", &short)));
    }

    #[test]
    fn cloudflare_body_markers_count_with_support() {
        let body = "<html><head><title>Checking</title></head><body>            <script>window._cf_chl_opt={cType:'managed'};</script></body></html>";
        // Short page + 403: medium + weak reaches the threshold.
        assert!(is_challenge(&input(403, "https://example.com/", body)));
        // The same markers on a long, successful page do not.
        let long = normal_article("<script>window._cf_chl_opt={cType:'managed'};</script>");
        assert!(!is_challenge(&input(200, "https://example.com/", &long)));
    }

    #[test]
    fn a_real_interstitial_with_its_header_is_challenge() {
        let body = r#"<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
            <meta http-equiv="refresh" content="390"></head><body><div class="main-wrapper">
            <noscript>Enable JavaScript and cookies to continue</noscript></div>
            <script>(function(){window._cf_chl_opt={cvId:'3',cZone:'example.com',cType:'managed'};
            var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=8a1b';
            document.getElementsByTagName('head')[0].appendChild(a);}());</script></body></html>"#;
        let mut page = input(403, "https://example.com/", body);
        page.cf_mitigated = Some("challenge");
        assert!(is_challenge(&page));
        // The header alone and the interstitial alone are each enough.
        page.cf_mitigated = None;
        assert!(is_challenge(&page));
        let mut header_only = input(200, "https://example.com/", "");
        header_only.cf_mitigated = Some("challenge");
        assert!(is_challenge(&header_only));
        assert!(is_challenge(&input(
            200,
            "https://example.com/?__cf_chl_rt_tk=abc",
            "<html></html>"
        )));
    }

    #[test]
    fn url_check_flags_only_challenge_paths() {
        assert!(url_is_challenge(
            "https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate"
        ));
        assert!(!url_is_challenge("https://example.com/verification"));
    }
}
