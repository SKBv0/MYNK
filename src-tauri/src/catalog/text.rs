//! Text normalization and tokenization, matching the renderer's `src/lib/text.ts`: Turkish-aware
//! lowercasing, canonical decomposition with every `\p{M}` dropped, dotless `ı` folded onto `i`.
//! The Unicode data lives in `fold_tables`, which a renderer test keeps in step.

use std::cmp::Ordering;

use super::fold_tables::{BASE_LETTERS, BASE_SEQUENCES, MARK_RANGES, NON_WORD_ALPHABETIC};

/// Hangul syllables decompose by formula (Unicode §3.12), without a table.
const HANGUL_FIRST: u32 = 0xAC00;
const HANGUL_LAST: u32 = 0xD7A3;
const JAMO_L: u32 = 0x1100;
const JAMO_V: u32 = 0x1161;
const JAMO_T: u32 = 0x11A7;
const JAMO_T_COUNT: u32 = 28;
const JAMO_VT_COUNT: u32 = 21 * JAMO_T_COUNT;

fn in_ranges(c: char, ranges: &[(u32, u32)]) -> bool {
    let cp = u32::from(c);
    ranges
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                Ordering::Less
            } else if lo > cp {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        })
        .is_ok()
}

fn push_code_point(out: &mut String, cp: u32) {
    if let Some(c) = char::from_u32(cp) {
        out.push(if c == 'ı' { 'i' } else { c });
    }
}

/// Appends the base letter(s) `c` keeps after NFD and mark removal, or `c` itself.
fn push_base(out: &mut String, c: char) {
    let cp = u32::from(c);
    if (HANGUL_FIRST..=HANGUL_LAST).contains(&cp) {
        let index = cp - HANGUL_FIRST;
        push_code_point(out, JAMO_L + index / JAMO_VT_COUNT);
        push_code_point(out, JAMO_V + (index % JAMO_VT_COUNT) / JAMO_T_COUNT);
        if !index.is_multiple_of(JAMO_T_COUNT) {
            push_code_point(out, JAMO_T + index % JAMO_T_COUNT);
        }
    } else if let Ok(at) = BASE_LETTERS.binary_search_by_key(&cp, |&(from, _)| from) {
        push_code_point(out, BASE_LETTERS[at].1);
    } else if let Ok(at) = BASE_SEQUENCES.binary_search_by_key(&cp, |&(from, _)| from) {
        for &base in BASE_SEQUENCES[at].1 {
            push_code_point(out, base);
        }
    } else {
        out.push(if c == 'ı' { 'i' } else { c });
    }
}

/// Case- and diacritic-insensitive normalization shared by search, keyword matching and tag
/// comparison.
pub fn normalize_search_text(value: &str) -> String {
    // `toLocaleLowerCase('tr')`: the dotted and dotless I pair, then the full Unicode mapping.
    let turkish: String = value
        .chars()
        .map(|c| match c {
            'I' => 'ı',
            'İ' => 'i',
            other => other,
        })
        .collect();
    let lowered = turkish.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    for c in lowered.chars() {
        if !in_ranges(c, MARK_RANGES) {
            push_base(&mut out, c);
        }
    }
    out
}

/// True for the characters that hold a token together: `\p{L}` and `\p{N}`.
pub fn is_word_char(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphanumeric();
    }
    c.is_alphanumeric() && !in_ranges(c, MARK_RANGES) && !in_ranges(c, NON_WORD_ALPHABETIC)
}

/// Splits normalized text into search tokens.
pub fn tokenize(value: &str) -> Vec<String> {
    normalize_search_text(value)
        .split(|c: char| !is_word_char(c))
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .collect()
}

/// Tokens of `value` joined by a single space, for exact-title comparison.
pub fn token_key(value: &str) -> String {
    tokenize(value).join(" ")
}

/// How `token` occurs in `text`: 0 absent, 1 mid-word, 2 word-start, 3 whole word.
/// `enough == 2` returns as soon as a word start is found. Both must already be normalized.
pub fn token_match_kind(text: &str, token: &str, enough: u8) -> u8 {
    if token.is_empty() || text.is_empty() {
        return 0;
    }
    let mut from = 0usize;
    let mut best = 0u8;
    while let Some(offset) = text[from..].find(token) {
        let index = from + offset;
        best = best.max(1);
        let starts_word = !text[..index].chars().next_back().is_some_and(is_word_char);
        if starts_word {
            let follows = text[index + token.len()..].chars().next();
            if !follows.is_some_and(is_word_char) {
                return 3;
            }
            if enough == 2 {
                return 2;
            }
            best = 2;
        }
        // Advance one character, like `indexOf(token, index + 1)`.
        from = index + text[index..].chars().next().map_or(1, char::len_utf8);
        if from >= text.len() {
            break;
        }
    }
    best
}

/// The keywords worth testing, normalized once so a caller can reuse them across records.
pub fn normalized_keywords(keywords: &[String]) -> Vec<String> {
    keywords
        .iter()
        .map(|keyword| normalize_search_text(keyword.trim()))
        .filter(|keyword| !keyword.is_empty())
        .collect()
}

/// True when any keyword from [`normalized_keywords`] starts a word in `haystack`.
pub fn matches_any_normalized(haystack: &str, keywords: &[String]) -> bool {
    keywords
        .iter()
        .any(|keyword| token_match_kind(haystack, keyword, 2) >= 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turkish_letters_lowercase_and_fold_to_ascii() {
        assert_eq!(normalize_search_text("Öwnershıp"), "ownership");
        assert_eq!(normalize_search_text("İSTANBUL"), "istanbul");
        assert_eq!(normalize_search_text("Ça"), "ca");
        assert_eq!(normalize_search_text("IŞIK"), "isik");
        assert_eq!(
            normalize_search_text("Yazılım Geliştirme"),
            "yazilim gelistirme"
        );
        assert_eq!(normalize_search_text("ĞÜŞİÖÇ"), "gusioc");
    }

    #[test]
    fn latin_accents_are_folded() {
        assert_eq!(normalize_search_text("Café Ñoño"), "cafe nono");
        assert_eq!(
            normalize_search_text("Łódź"),
            "łodz",
            "ł has no decomposition"
        );
        assert_eq!(
            normalize_search_text("Ærø"),
            "ærø",
            "æ and ø have no decomposition"
        );
        assert_eq!(normalize_search_text("cafe\u{0301}"), "cafe");
    }

    /// Same vectors as `src/lib/text.test.ts`: both processes fold text identically.
    #[test]
    fn shared_vectors_match_the_renderer() {
        #[derive(serde::Deserialize)]
        struct Vector {
            input: String,
            normalized: String,
            tokens: Vec<String>,
        }
        let vectors: Vec<Vector> =
            serde_json::from_str(include_str!("text_vectors.json")).expect("vectors");
        assert!(!vectors.is_empty());
        for vector in vectors {
            assert_eq!(
                normalize_search_text(&vector.input),
                vector.normalized,
                "{:?}",
                vector.input
            );
            assert_eq!(tokenize(&vector.input), vector.tokens, "{:?}", vector.input);
        }
    }

    #[test]
    fn keywords_match_across_scripts() {
        let keywords = normalized_keywords(&["bucuresti".to_string(), "йога".to_string()]);
        assert!(matches_any_normalized(
            &normalize_search_text("București guide"),
            &keywords
        ));
        assert!(matches_any_normalized(
            &normalize_search_text("Йога дома"),
            &keywords
        ));
    }

    #[test]
    fn empty_and_symbol_only_input_yields_no_tokens() {
        assert_eq!(normalize_search_text(""), "");
        assert_eq!(tokenize("  --  "), Vec::<String>::new());
        assert_eq!(tokenize(""), Vec::<String>::new());
    }

    #[test]
    fn tokenization_splits_on_non_alphanumeric() {
        assert_eq!(
            tokenize("React-Native, v18.2 (İyi)"),
            vec!["react", "native", "v18", "2", "iyi"]
        );
        assert_eq!(token_key("  Ownership  in   Rust "), "ownership in rust");
    }

    #[test]
    fn token_match_kind_ranks_whole_word_over_word_start_over_mid_word() {
        assert_eq!(token_match_kind("rust ownership", "rust", 3), 3);
        assert_eq!(token_match_kind("rustaceans", "rust", 3), 2);
        assert_eq!(token_match_kind("trustaceans", "rust", 3), 1);
        assert_eq!(token_match_kind("nothing here", "rust", 3), 0);
        assert_eq!(token_match_kind("rustaceans rust", "rust", 2), 2);
        assert_eq!(token_match_kind("rustaceans rust", "rust", 3), 3);
        assert_eq!(token_match_kind("yazılımcı", "yazılım", 3), 2);
        assert_eq!(token_match_kind("çok yazılım", "yazılım", 3), 3);
        assert_eq!(token_match_kind("abc", "", 3), 0);
    }

    #[test]
    fn keyword_matching_is_token_start_anchored() {
        let keywords = normalized_keywords(&["yazılım".to_string(), "react".to_string()]);
        assert!(matches_any_normalized(
            &normalize_search_text("Yazılımcılar için"),
            &keywords
        ));
        assert!(matches_any_normalized(
            &normalize_search_text("react-native docs"),
            &keywords
        ));
        assert!(!matches_any_normalized(
            &normalize_search_text("preact islands"),
            &keywords
        ));
        assert!(!matches_any_normalized("anything", &[]));
        assert!(
            normalized_keywords(&["   ".to_string()]).is_empty(),
            "a blank keyword is dropped rather than matching everything"
        );
    }
}
