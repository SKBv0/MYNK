//! Tolerant parsing of LLM JSON output.
//!
//! Strip code fences, find the first balanced JSON object, then deserialize leniently.

use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::analyze::CATEGORY_IDS;
use crate::catalog::model::FALLBACK_CATEGORY_ID;
use crate::catalog::text::normalize_search_text;
use crate::util::collapse_whitespace;

pub const MAX_TAGS: usize = 8;
pub const MAX_TAG_CHARS: usize = 32;
pub const MAX_SUMMARY: usize = 5;

/// Removes a surrounding Markdown code fence (```json … ```), if present.
pub fn strip_code_fence(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let rest = match rest.find('\n') {
        Some(newline) => &rest[newline + 1..],
        None => rest,
    };
    rest.trim_end().strip_suffix("```").unwrap_or(rest).trim()
}

/// How many `{` positions are tried before giving up (bounded work on hostile input).
const MAX_OBJECT_CANDIDATES: usize = 64;

/// Returns the balanced `{…}` slice that starts at `start`, respecting string literals and
/// escapes. `None` when the braces never balance out.
fn balanced_object_at(text: &str, start: usize) -> Option<&str> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (i, &b) in text.as_bytes().iter().enumerate().skip(start) {
        if in_string {
            match b {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Every balanced `{…}` slice in `text`, in order of its opening brace.
fn object_candidates(text: &str) -> impl Iterator<Item = &str> {
    text.match_indices('{')
        .take(MAX_OBJECT_CANDIDATES)
        .filter_map(|(start, _)| balanced_object_at(text, start))
}

/// Parses the first JSON object found in model output.
pub fn extract_object(text: &str) -> Option<Value> {
    let body = strip_code_fence(text);
    if let Ok(value @ Value::Object(_)) = serde_json::from_str::<Value>(body) {
        return Some(value);
    }
    // A balanced but meaningless candidate can precede the real answer; keep trying braces.
    object_candidates(body).find_map(|candidate| match serde_json::from_str::<Value>(candidate) {
        Ok(value @ Value::Object(_)) => Some(value),
        _ => None,
    })
}

fn lenient_string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(s) => s,
        Value::Number(n) => n.to_string(),
        Value::Array(items) => items
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    })
}

fn lenient_list<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect(),
        Value::String(s) => s.split(['\n', ',', ';']).map(str::to_string).collect(),
        _ => Vec::new(),
    })
}

fn lenient_bool<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::Bool(b) => b,
        Value::String(s) => matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "yes" | "1"),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        _ => false,
    })
}

fn lenient_f64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches('%').parse::<f64>().ok(),
        _ => None,
    })
}

/// Lenient intermediate representation of the analysis JSON.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawAnalysis {
    #[serde(deserialize_with = "lenient_string")]
    title: String,
    #[serde(deserialize_with = "lenient_string")]
    description: String,
    #[serde(
        alias = "categoryId",
        alias = "category",
        deserialize_with = "lenient_string"
    )]
    category_id: String,
    #[serde(alias = "keywords", deserialize_with = "lenient_list")]
    tags: Vec<String>,
    #[serde(
        alias = "key_points",
        alias = "summary_points",
        deserialize_with = "lenient_list"
    )]
    summary: Vec<String>,
    #[serde(alias = "insufficientContent", deserialize_with = "lenient_bool")]
    insufficient_content: bool,
    #[serde(deserialize_with = "lenient_f64")]
    grounding: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedAnalysis {
    pub title: String,
    pub description: String,
    pub category_id: String,
    pub tags: Vec<String>,
    pub summary: Vec<String>,
    pub insufficient_content: bool,
    /// 0..1 when the model reported it.
    pub grounding: Option<f64>,
}

/// Maps free-form category text to one of `CATEGORY_IDS` (unknown → `FALLBACK_CATEGORY_ID`).
/// Label and table are both folded, so "Alışveriş", "ALIŞVERİŞ" and "alisveris" are one key.
pub fn normalize_category(raw: &str) -> String {
    let key = normalize_search_text(raw.trim());
    if let Some(id) = CATEGORY_IDS.iter().find(|id| **id == key) {
        return (*id).to_string();
    }
    const SYNONYMS: &[(&str, &str)] = &[
        ("dev", "development"),
        ("programming", "development"),
        ("software", "development"),
        ("code", "development"),
        ("coding", "development"),
        ("engineering", "development"),
        ("technology", "development"),
        ("yazılım", "development"),
        ("ui", "design"),
        ("ux", "design"),
        ("tasarım", "design"),
        ("science", "research"),
        ("academic", "research"),
        ("paper", "research"),
        ("araştırma", "research"),
        ("marketing", "business"),
        ("startup", "business"),
        ("iş", "business"),
        ("media", "news"),
        ("haber", "news"),
        ("education", "learning"),
        ("tutorial", "learning"),
        ("course", "learning"),
        ("eğitim", "learning"),
        ("tool", "tools"),
        ("utility", "tools"),
        ("productivity", "tools"),
        ("araç", "tools"),
        ("araçlar", "tools"),
        ("games", "entertainment"),
        ("gaming", "entertainment"),
        ("music", "entertainment"),
        ("video", "entertainment"),
        ("eğlence", "entertainment"),
        ("crypto", "finance"),
        ("investing", "finance"),
        ("finans", "finance"),
        ("medical", "health"),
        ("fitness", "health"),
        ("sağlık", "health"),
        ("e-commerce", "shopping"),
        ("ecommerce", "shopping"),
        ("e-ticaret", "shopping"),
        ("marketplace", "shopping"),
        ("store", "shopping"),
        ("shop", "shopping"),
        ("retail", "shopping"),
        ("alışveriş", "shopping"),
        ("mağaza", "shopping"),
        ("hotel", "travel"),
        ("hotels", "travel"),
        ("flight", "travel"),
        ("flights", "travel"),
        ("tourism", "travel"),
        ("maps", "travel"),
        ("seyahat", "travel"),
        ("gezi", "travel"),
        ("tatil", "travel"),
        ("otel", "travel"),
        ("uçuş", "travel"),
        ("turizm", "travel"),
        ("harita", "travel"),
        ("documentation", "reference"),
        ("docs", "reference"),
        ("wiki", "reference"),
        ("kaynak", "reference"),
        ("social media", "social"),
        ("community", "social"),
        ("forum", "social"),
        ("sosyal", "social"),
    ];
    SYNONYMS
        .iter()
        .map(|(synonym, id)| (normalize_search_text(synonym), id))
        .find(|(synonym, _)| key == *synonym || key.starts_with(&format!("{synonym} ")))
        .map(|(_, id)| (*id).to_string())
        .unwrap_or_else(|| FALLBACK_CATEGORY_ID.to_string())
}

/// Trims, strips `#`, collapses whitespace, truncates to 32 chars, dedupes (case-insensitive),
/// keeps at most 8.
pub fn normalize_tags(raw: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut tags = Vec::new();
    for tag in raw {
        let cleaned = collapse_whitespace(tag.trim().trim_start_matches('#'));
        let cleaned: String = cleaned
            .trim_matches(|c: char| c == '"' || c == '\'' || c == '.')
            .chars()
            .take(MAX_TAG_CHARS)
            .collect();
        let cleaned = cleaned.trim().to_string();
        if cleaned.is_empty() || !seen.insert(cleaned.to_lowercase()) {
            continue;
        }
        tags.push(cleaned);
        if tags.len() >= MAX_TAGS {
            break;
        }
    }
    tags
}

pub fn normalize_summary(raw: &[String]) -> Vec<String> {
    raw.iter()
        .map(|s| collapse_whitespace(s.trim().trim_start_matches(['-', '*', '•']).trim()))
        .filter(|s| !s.is_empty())
        .take(MAX_SUMMARY)
        .collect()
}

/// Parses model output into a normalized analysis. `None` when no usable object was found.
pub fn parse_analysis(text: &str) -> Option<ParsedAnalysis> {
    let value = extract_object(text)?;
    let raw: RawAnalysis = serde_json::from_value(value).ok()?;
    let parsed = ParsedAnalysis {
        title: collapse_whitespace(&raw.title),
        description: collapse_whitespace(&raw.description),
        category_id: normalize_category(&raw.category_id),
        tags: normalize_tags(&raw.tags),
        summary: normalize_summary(&raw.summary),
        insufficient_content: raw.insufficient_content,
        grounding: raw
            .grounding
            .filter(|g| g.is_finite())
            .map(|g| if g > 1.0 { g / 100.0 } else { g })
            .map(|g| g.clamp(0.0, 1.0)),
    };
    // An object with none of the expected fields is not a usable answer.
    if parsed.title.is_empty()
        && parsed.description.is_empty()
        && parsed.tags.is_empty()
        && parsed.summary.is_empty()
    {
        return None;
    }
    Some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_fences() {
        assert_eq!(strip_code_fence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_code_fence("```\n{}\n```"), "{}");
        assert_eq!(strip_code_fence("  {}  "), "{}");
    }

    #[test]
    fn finds_first_balanced_object() {
        let text = r#"Sure! {"a": "brace } in string", "b": {"c": 1}} trailing {"x":2}"#;
        assert_eq!(
            object_candidates(text).next(),
            Some(r#"{"a": "brace } in string", "b": {"c": 1}}"#)
        );
        assert_eq!(object_candidates("no json").next(), None);
        assert_eq!(object_candidates("{unclosed").next(), None);
    }

    #[test]
    fn parses_lenient_analysis() {
        let text = r#"Here you go:
```json
{"title": "Rust Book", "description": "The official guide.", "category": "Programming",
 "tags": "rust, #systems, Rust, a-very-long-tag-name-that-goes-beyond-the-limit",
 "summary": "- One.\n- Two.", "grounding": "85", "insufficient_content": "false"}
```"#;
        let parsed = parse_analysis(text).expect("parses");
        assert_eq!(parsed.title, "Rust Book");
        assert_eq!(parsed.category_id, "development");
        assert_eq!(parsed.tags.len(), 3);
        assert_eq!(parsed.tags[0], "rust");
        assert_eq!(parsed.tags[1], "systems");
        assert!(parsed.tags[2].chars().count() <= MAX_TAG_CHARS);
        assert_eq!(parsed.summary, vec!["One.", "Two."]);
        assert_eq!(parsed.grounding, Some(0.85));
        assert!(!parsed.insufficient_content);
    }

    #[test]
    fn caps_tags_and_summary_and_maps_unknown_category_to_other() {
        let tags: Vec<String> = (0..20).map(|i| format!("tag{i}")).collect();
        let summary: Vec<String> = (0..9).map(|i| format!("s{i}")).collect();
        let json = serde_json::json!({
            "title": "T", "category_id": "astrology", "tags": tags, "summary": summary,
            "grounding": 3.5
        })
        .to_string();
        let parsed = parse_analysis(&json).expect("parses");
        assert_eq!(parsed.category_id, "other");
        assert_eq!(parsed.tags.len(), MAX_TAGS);
        assert_eq!(parsed.summary.len(), MAX_SUMMARY);
        assert_eq!(parsed.grounding, Some(0.035));
    }

    #[test]
    fn skips_balanced_braces_in_the_preamble() {
        let text = r#"Mind the { and } braces: {"title": "Rust Book", "category": "dev"}"#;
        // The first balanced candidate is the prose one, and it is not JSON.
        assert_eq!(object_candidates(text).next(), Some("{ and }"));
        let parsed = parse_analysis(text).expect("the real object is found behind the prose");
        assert_eq!(parsed.title, "Rust Book");
        assert_eq!(parsed.category_id, "development");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_analysis("I cannot help with that.").is_none());
        assert!(parse_analysis("{\"unrelated\": true}").is_none());
    }

    #[test]
    fn normalizes_category_labels_in_both_languages() {
        assert_eq!(normalize_category("Design"), "design");
        assert_eq!(normalize_category(" tools "), "tools");
        assert_eq!(normalize_category("Eğitim"), "learning");
        assert_eq!(normalize_category(""), "other");
    }

    #[test]
    fn shopping_and_travel_match_labels_in_both_languages() {
        for label in [
            "Shopping",
            "E-Commerce",
            "ecommerce",
            "Marketplace",
            "Store",
            "Alışveriş",
            "E-ticaret",
            "Mağaza",
        ] {
            assert_eq!(normalize_category(label), "shopping", "{label}");
        }
        for label in [
            "Travel", "Hotels", "Flights", "Tourism", "Maps", "Seyahat", "Gezi", "Tatil", "Otel",
            "Uçuş", "Harita",
        ] {
            assert_eq!(normalize_category(label), "travel", "{label}");
        }
    }

    /// Lowercasing `İ` leaves a combining dot behind, and `ALIŞVERİŞ` carries a dotless `I`.
    #[test]
    fn turkish_casing_does_not_hide_a_category() {
        assert_eq!(normalize_category("ALIŞVERİŞ"), "shopping");
        assert_eq!(normalize_category("alisveris"), "shopping");
        assert_eq!(normalize_category("İş"), "business");
        assert_eq!(normalize_category("UI"), "design", "ASCII I stays ASCII");
        assert_eq!(normalize_category("EĞİTİM"), "learning");
    }
}
