//! Size-limited body reading and charset decoding.

use encoding_rs::{Encoding, UTF_8};
use reqwest::Response;

use crate::error::{AppError, AppResult};

/// Maximum bytes read from a web page.
pub const PAGE_BODY_LIMIT: usize = 2 * 1024 * 1024;
/// Maximum bytes read from an API (LLM provider) response.
pub const API_BODY_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overflow {
    /// Stop reading and keep the first `limit` bytes (web pages).
    Truncate,
    /// Fail with a parse error (API responses must be complete).
    Error,
}

/// Reads at most `limit` bytes of the body without ever buffering more than that.
pub async fn read_limited(
    mut response: Response,
    limit: usize,
    overflow: Overflow,
    context: &str,
) -> AppResult<Vec<u8>> {
    if overflow == Overflow::Error {
        if let Some(len) = response.content_length() {
            if len > limit as u64 {
                // No dedicated size error kind exists; `network` fits better than `parse` here.
                return Err(AppError::network(format!(
                    "{context}: the response is too large ({len} bytes, limit {limit})."
                )));
            }
        }
    }

    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|e| AppError::from_reqwest(context, &e))?;
        let Some(chunk) = chunk else { break };
        let remaining = limit.saturating_sub(buffer.len());
        if chunk.len() > remaining {
            match overflow {
                Overflow::Truncate => {
                    buffer.extend_from_slice(&chunk[..remaining]);
                    break;
                }
                Overflow::Error => {
                    return Err(AppError::network(format!(
                        "{context}: the response exceeded the {limit} byte limit."
                    )));
                }
            }
        }
        buffer.extend_from_slice(&chunk);
    }
    Ok(buffer)
}

fn charset_from_content_type(content_type: &str) -> Option<&str> {
    content_type.split(';').skip(1).find_map(|param| {
        let (key, value) = param.split_once('=')?;
        if key.trim().eq_ignore_ascii_case("charset") {
            Some(value.trim().trim_matches(|c| c == '"' || c == '\''))
        } else {
            None
        }
    })
}

/// Looks for `<meta charset=...>` / `<meta http-equiv content="...charset=...">` in the
/// first 4 KB (HTML spec prescan, simplified).
fn charset_from_meta(bytes: &[u8]) -> Option<&'static Encoding> {
    let head = &bytes[..bytes.len().min(4096)];
    let lowered: Vec<u8> = head.iter().map(|b| b.to_ascii_lowercase()).collect();
    let text = String::from_utf8_lossy(&lowered);
    let mut search_from = 0;
    while let Some(pos) = text[search_from..].find("charset") {
        let start = search_from + pos + "charset".len();
        let rest = text[start..].trim_start();
        if let Some(rest) = rest.strip_prefix('=') {
            let rest = rest.trim_start().trim_start_matches(['"', '\'']);
            let label: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
                .collect();
            if let Some(encoding) = Encoding::for_label(label.as_bytes()) {
                return Some(encoding);
            }
        }
        search_from = start;
    }
    None
}

/// A `<meta charset>` claiming UTF-16 is always wrong: the prescan only found the tag because
/// the bytes are ASCII-compatible, which UTF-16 is not. A `Content-Type` header can still say so.
fn utf16_meta_means_utf8(encoding: &'static Encoding) -> &'static Encoding {
    if encoding == encoding_rs::UTF_16LE || encoding == encoding_rs::UTF_16BE {
        UTF_8
    } else {
        encoding
    }
}

/// Decodes an HTML/text body: BOM → Content-Type charset → `<meta charset>` → UTF-8.
pub fn decode_text(bytes: &[u8], content_type: Option<&str>) -> String {
    if let Some((encoding, _)) = Encoding::for_bom(bytes) {
        return encoding.decode_with_bom_removal(bytes).0.into_owned();
    }
    let encoding = content_type
        .and_then(charset_from_content_type)
        .and_then(|label| Encoding::for_label(label.as_bytes()))
        .or_else(|| charset_from_meta(bytes).map(utf16_meta_means_utf8))
        .unwrap_or(UTF_8);
    encoding.decode_without_bom_handling(bytes).0.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_content_type_charset() {
        // "Güzel" in windows-1254 (Turkish).
        let bytes = [0x47, 0xFC, 0x7A, 0x65, 0x6C];
        assert_eq!(
            decode_text(&bytes, Some("text/html; charset=windows-1254")),
            "Güzel"
        );
    }

    #[test]
    fn decodes_meta_charset() {
        let mut html = b"<html><head><meta charset=\"iso-8859-9\"></head><body>".to_vec();
        html.extend_from_slice(&[0xDE, 0x65, 0x6B, 0x65, 0x72]); // "Şeker"
        let decoded = decode_text(&html, Some("text/html"));
        assert!(decoded.contains("Şeker"), "{decoded}");
    }

    #[test]
    fn defaults_to_utf8() {
        assert_eq!(decode_text("çay".as_bytes(), None), "çay");
    }

    #[test]
    fn utf16_is_honored_from_the_header_but_not_from_meta() {
        // "hi" in UTF-16LE, no BOM: the header is the only thing that can say so.
        let utf16 = [0x68, 0x00, 0x69, 0x00];
        assert_eq!(decode_text(&utf16, Some("text/html; charset=utf-16")), "hi");

        // An ASCII-compatible document cannot be UTF-16, whatever its <meta> claims.
        let html = b"<html><head><meta charset=\"utf-16\"></head><body>caf\xc3\xa9</body></html>";
        assert!(decode_text(html, Some("text/html")).contains("café"));
    }
}
