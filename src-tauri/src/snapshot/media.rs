//! Local cache for remote favicons / og:images (the webview never loads a remote image itself).
//! Downloads go through the SSRF-guarded client and must pass a content-type + magic-byte check;
//! SVG is accepted only when it has no active or external content.

use std::path::Path;

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use super::cleanup::{self, short_hash};
use crate::error::{AppError, AppResult};
use crate::http::body::{read_limited, Overflow};
use crate::http::guard::{check_url, AddressPolicy};
use crate::http::header_text;
use crate::settings;
use crate::state::{run_blocking, AppState};

pub const MAX_FAVICON_BYTES: usize = 512 * 1024;
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_URL_CHARS: usize = 4096;
const IMAGE_ACCEPT: &str = "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5";

/// `RemoteImageKind` in ipcTypes.ts.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteImageKind {
    Favicon,
    Image,
}

impl RemoteImageKind {
    fn prefix(self) -> &'static str {
        match self {
            RemoteImageKind::Favicon => "fav",
            RemoteImageKind::Image => "img",
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            RemoteImageKind::Favicon => MAX_FAVICON_BYTES,
            RemoteImageKind::Image => MAX_IMAGE_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CachedFormat {
    Png,
    Jpeg,
    Webp,
    Gif,
    Ico,
    Svg,
}

pub const ALL_FORMATS: [CachedFormat; 6] = [
    CachedFormat::Png,
    CachedFormat::Jpeg,
    CachedFormat::Webp,
    CachedFormat::Gif,
    CachedFormat::Ico,
    CachedFormat::Svg,
];

impl CachedFormat {
    pub fn ext(self) -> &'static str {
        match self {
            CachedFormat::Png => "png",
            CachedFormat::Jpeg => "jpg",
            CachedFormat::Webp => "webp",
            CachedFormat::Gif => "gif",
            CachedFormat::Ico => "ico",
            CachedFormat::Svg => "svg",
        }
    }
}

/// The eight bytes every PNG file starts with.
pub const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Detects a raster format from magic bytes.
pub fn sniff_raster(bytes: &[u8]) -> Option<CachedFormat> {
    if bytes.starts_with(&PNG_SIGNATURE) {
        Some(CachedFormat::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(CachedFormat::Jpeg)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(CachedFormat::Webp)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(CachedFormat::Gif)
    } else if bytes.len() >= 6 && bytes[0..4] == [0x00, 0x00, 0x01, 0x00] && bytes[4..6] != [0, 0] {
        // ICONDIR: reserved 0, type 1 (icon), count > 0.
        Some(CachedFormat::Ico)
    } else {
        None
    }
}

/// Markers of active or external content that make an SVG unsafe to store: `<style>` can hide
/// `url()`s from the scan below, and the `<animate*>`/`<set>` family can rewrite `href` post-load.
const SVG_FORBIDDEN_TAGS: &[&str] = &[
    "script",
    "foreignobject",
    "iframe",
    "embed",
    "object",
    "use",
    "style",
    "animate",
    "set",
];

/// Markers that are not tag names.
const SVG_FORBIDDEN_MARKERS: &[&str] = &["<!doctype", "<!entity", "javascript:", "@import"];

/// True when `bytes` is a UTF-8 SVG without scripts, event handlers, foreignObject, DTDs or
/// external references (`href` must be a local `#fragment` or a non-SVG `data:image/`).
pub fn is_safe_svg(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let lowered = text.trim_start_matches('\u{feff}').to_ascii_lowercase();
    let head = lowered.trim_start();
    if !(head.starts_with("<svg") || head.starts_with("<?xml") || head.starts_with("<!--")) {
        return false;
    }
    if !lowered.contains("<svg") {
        return false;
    }
    if SVG_FORBIDDEN_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return false;
    }
    if has_forbidden_tag(&lowered) || has_event_handler_attribute(&lowered) {
        return false;
    }
    // An external reference can beacon, and a nested SVG carries active content past this scan.
    for (pos, _) in lowered.match_indices("href") {
        let rest = lowered[pos + 4..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let value = rest.trim_start().trim_start_matches(['"', '\'']);
        let allowed = value.starts_with('#')
            || (value.starts_with("data:image/") && !value.starts_with("data:image/svg"));
        if !allowed {
            return false;
        }
    }
    for (pos, _) in lowered.match_indices("url(") {
        let value = lowered[pos + 4..]
            .trim_start()
            .trim_start_matches(['"', '\'']);
        if !value.starts_with('#') {
            return false;
        }
    }
    true
}

/// Finds an opening tag from [`SVG_FORBIDDEN_TAGS`], with or without a namespace prefix
/// (`<script`, `<s:script`).
fn has_forbidden_tag(lowered: &str) -> bool {
    lowered.match_indices('<').any(|(pos, _)| {
        let rest = &lowered[pos + 1..];
        let name = match rest.split_once(':') {
            Some((prefix, after))
                if !prefix.is_empty() && prefix.bytes().all(|b| b.is_ascii_alphanumeric()) =>
            {
                after
            }
            _ => rest,
        };
        SVG_FORBIDDEN_TAGS.iter().any(|tag| name.starts_with(tag))
    })
}

/// Finds `on<letters>=` preceded by whitespace, a quote or a namespace colon (an attribute, not
/// text like "icon=").
fn has_event_handler_attribute(lowered: &str) -> bool {
    let bytes = lowered.as_bytes();
    for (pos, _) in lowered.match_indices("on") {
        let preceded = pos.checked_sub(1).map(|i| bytes[i]).is_some_and(|b| {
            b.is_ascii_whitespace() || b == b'"' || b == b'\'' || b == b'/' || b == b':'
        });
        if !preceded {
            continue;
        }
        let name_len = bytes[pos + 2..]
            .iter()
            .take_while(|b| b.is_ascii_alphabetic())
            .count();
        if name_len == 0 {
            continue;
        }
        let after = lowered[pos + 2 + name_len..].trim_start();
        if after.starts_with('=') {
            return true;
        }
    }
    false
}

/// Content types a server may send for an accepted image format (validation is by magic bytes).
fn content_type_acceptable(content_type: Option<&str>, format: CachedFormat) -> bool {
    let Some(ct) = content_type else {
        return true;
    };
    let mime = ct
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if mime.is_empty()
        || mime.starts_with("image/")
        || mime == "application/octet-stream"
        || mime == "binary/octet-stream"
    {
        return true;
    }
    match format {
        CachedFormat::Svg => matches!(mime.as_str(), "text/xml" | "application/xml" | "text/plain"),
        // Some servers send favicon.ico as text/plain.
        CachedFormat::Ico => mime == "text/plain",
        _ => false,
    }
}

/// Validates a downloaded body and returns its format.
pub fn validate_image(bytes: &[u8], content_type: Option<&str>) -> AppResult<CachedFormat> {
    if bytes.is_empty() {
        return Err(AppError::Parse("The image is empty.".to_string()));
    }
    let format = match sniff_raster(bytes) {
        Some(format) => format,
        None if is_safe_svg(bytes) => CachedFormat::Svg,
        None => {
            return Err(AppError::Parse(
                "The response is not a supported image (png, jpg, webp, gif, ico, safe svg)."
                    .to_string(),
            ))
        }
    };
    if !content_type_acceptable(content_type, format) {
        return Err(AppError::Parse(
            "The server did not send an image content type.".to_string(),
        ));
    }
    Ok(format)
}

/// Base name (without extension) for a cached URL.
pub fn cache_stem(url: &Url, kind: RemoteImageKind) -> String {
    format!(
        "{}-{}",
        kind.prefix(),
        short_hash(url.as_str().as_bytes(), 16)
    )
}

/// An already cached file for `stem`, if any.
pub fn find_cached(dir: &Path, stem: &str) -> Option<String> {
    ALL_FORMATS
        .iter()
        .map(|format| format!("{stem}.{}", format.ext()))
        .find(|name| dir.join(name).is_file())
}

/// Parses and validates a remote image URL (http/https with a host only).
pub fn parse_image_url(raw: &str) -> AppResult<Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_URL_CHARS {
        return Err(AppError::invalid_input("Invalid image URL."));
    }
    let url = Url::parse(trimmed)
        .map_err(|e| AppError::invalid_input(format!("Invalid image URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(AppError::invalid_input(
            "Only http/https image URLs are supported.",
        ));
    }
    Ok(url)
}

/// Downloads (or finds) the cached copy of a remote image; returns its file name.
pub async fn cache_remote_image<R: Runtime>(
    app: &AppHandle<R>,
    raw_url: &str,
    kind: RemoteImageKind,
) -> AppResult<String> {
    let url = parse_image_url(raw_url)?;
    let state = app.state::<AppState>();
    let dir = state.snapshot_dir.clone();
    let stem = cache_stem(&url, kind);

    // At most six `is_file` calls on a local directory: not worth a blocking task.
    if let Some(existing) = find_cached(&dir, &stem) {
        return Ok(existing);
    }

    let settings = settings::load(app).await?;
    check_url(&url, AddressPolicy::for_web(settings.allow_private_network))?;
    let response = state
        .http
        .web(settings.allow_private_network)
        .get(url.clone())
        .header(ACCEPT, IMAGE_ACCEPT)
        .send()
        .await
        .map_err(|e| AppError::from_reqwest("Could not download the image", &e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::Network {
            message: format!("The image request failed with HTTP {}.", status.as_u16()),
            status: Some(status.as_u16()),
            code: None,
        });
    }
    let content_type = header_text(&response, CONTENT_TYPE);
    let bytes = read_limited(response, kind.max_bytes(), Overflow::Error, "Image").await?;
    let format = validate_image(&bytes, content_type.as_deref())?;
    let name = format!("{stem}.{}", format.ext());

    let write_name = name.clone();
    run_blocking(move || {
        std::fs::create_dir_all(&dir)?;
        cleanup::write_atomically(&dir, &write_name, &bytes)
    })
    .await?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];

    #[test]
    fn sniffs_raster_formats() {
        assert_eq!(sniff_raster(PNG), Some(CachedFormat::Png));
        assert_eq!(
            sniff_raster(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some(CachedFormat::Jpeg)
        );
        assert_eq!(
            sniff_raster(b"RIFF\0\0\0\0WEBPVP8 "),
            Some(CachedFormat::Webp)
        );
        assert_eq!(sniff_raster(b"GIF89a...."), Some(CachedFormat::Gif));
        assert_eq!(
            sniff_raster(&[0, 0, 1, 0, 1, 0, 16, 16]),
            Some(CachedFormat::Ico)
        );
        assert_eq!(sniff_raster(&[0, 0, 1, 0, 0, 0]), None);
        assert_eq!(sniff_raster(b"<html>"), None);
    }

    #[test]
    fn accepts_plain_svg() {
        let svg = br##"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="16" height="16"/><use-not-really/></svg>"##;
        assert!(!is_safe_svg(svg));
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16z" fill="url(#g)"/><a href="#top"/></svg>"##;
        assert!(is_safe_svg(svg));
        assert_eq!(
            validate_image(svg, Some("image/svg+xml")).expect("svg"),
            CachedFormat::Svg
        );
    }

    #[test]
    fn rejects_svg_styles_and_animations() {
        for case in [
            &b"<svg><style>rect{fill:red}</style><rect/></svg>"[..],
            b"<svg><STYLE type=\"text/css\">@font-face{}</STYLE></svg>",
            b"<svg><a href=\"#x\"><animate attributeName=\"href\" to=\"https://evil.example\"/></a></svg>",
            b"<svg><a href=\"#x\"><set attributeName=\"href\" to=\"#y\"/></a></svg>",
            b"<svg><rect><animateMotion dur=\"1s\"/></rect></svg>",
            b"<svg><rect><animateTransform attributeName=\"transform\"/></rect></svg>",
        ] {
            assert!(!is_safe_svg(case), "{}", String::from_utf8_lossy(case));
        }
    }

    #[test]
    fn rejects_active_svg() {
        let cases: [&[u8]; 8] = [
            b"<svg><script>alert(1)</script></svg>",
            b"<svg onload=\"alert(1)\"></svg>",
            b"<svg><rect onclick = 'x'/></svg>",
            b"<svg><foreignObject><div/></foreignObject></svg>",
            b"<!DOCTYPE svg [<!ENTITY x SYSTEM \"file:///c:/x\">]><svg>&x;</svg>",
            b"<svg><image href=\"https://tracker.example/p.gif\"/></svg>",
            b"<svg><rect style=\"fill:url(https://x.example/a)\"/></svg>",
            b"<svg><a xlink:href=\"javascript:alert(1)\"/></svg>",
        ];
        for case in cases {
            assert!(!is_safe_svg(case), "{}", String::from_utf8_lossy(case));
        }
        assert!(!is_safe_svg(b"<html><svg></svg></html>"));
        assert!(!is_safe_svg(&[0xFF, 0xFE, 0x00]));
        // "icon=" inside an attribute value is not an event handler.
        assert!(is_safe_svg(b"<svg data-name=\"x icon\" class=\"a\"></svg>"));
    }

    #[test]
    fn rejects_namespace_prefixed_and_nested_svg() {
        let cases: [&[u8]; 7] = [
            b"<svg><s:script>alert(1)</s:script></svg>",
            b"<svg><a:foreignObject><div/></a:foreignObject></svg>",
            b"<svg><x:use href=\"#a\"/></svg>",
            b"<svg><ns:style>rect{fill:red}</ns:style></svg>",
            b"<svg s:onload=\"alert(1)\"></svg>",
            b"<svg><image href=\"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=\"/></svg>",
            b"<svg><a xlink:href=\"data:image/svg+xml,%3Csvg%3E\"/></svg>",
        ];
        for case in cases {
            assert!(!is_safe_svg(case), "{}", String::from_utf8_lossy(case));
        }
        // A prefixed tag that is not on the list, and a raster data URL, stay acceptable.
        assert!(is_safe_svg(
            b"<svg><svg:rect fill=\"#f00\"/><image href=\"data:image/png;base64,AAAA\"/></svg>"
        ));
    }

    #[test]
    fn validates_content_type_and_magic() {
        assert_eq!(
            validate_image(PNG, Some("image/png")).expect("png"),
            CachedFormat::Png
        );
        assert_eq!(validate_image(PNG, None).expect("png"), CachedFormat::Png);
        assert!(validate_image(PNG, Some("text/html; charset=utf-8")).is_err());
        assert!(validate_image(b"<html>not an image</html>", Some("image/png")).is_err());
        assert!(validate_image(b"", Some("image/png")).is_err());
        assert_eq!(
            validate_image(&[0, 0, 1, 0, 1, 0], Some("text/plain")).expect("ico"),
            CachedFormat::Ico
        );
    }

    #[test]
    fn cache_stems_differ_by_kind_and_cached_files_are_found() {
        let url = Url::parse("https://example.com/favicon.ico").expect("url");
        let fav = cache_stem(&url, RemoteImageKind::Favicon);
        let img = cache_stem(&url, RemoteImageKind::Image);
        assert!(fav.starts_with("fav-") && img.starts_with("img-"));
        assert_ne!(fav, img);
        assert!(cleanup::is_safe_file_name(&format!("{fav}.svg")));

        let dir = std::env::temp_dir().join(format!(
            "mynk-media-{}-{}",
            std::process::id(),
            short_hash(format!("{:?}", std::time::SystemTime::now()).as_bytes(), 4)
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        assert_eq!(find_cached(&dir, &fav), None);
        std::fs::write(dir.join(format!("{fav}.ico")), b"x").expect("write");
        assert_eq!(find_cached(&dir, &fav), Some(format!("{fav}.ico")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_image_urls() {
        assert!(parse_image_url("https://example.com/a.png").is_ok());
        assert!(parse_image_url("http://example.com/a.png").is_ok());
        assert!(parse_image_url("file:///C:/Windows/win.ini").is_err());
        assert!(parse_image_url("data:image/png;base64,AAAA").is_err());
        assert!(parse_image_url("example.com/a.png").is_err());
        assert!(parse_image_url("").is_err());
    }
}
