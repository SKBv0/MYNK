//! Query engine over a loaded [`Library`]: keyword ranking (title > tags > host > rest) with
//! ANDed filters and tiered relaxation for natural-language queries. Semantic and Hybrid modes
//! degrade to keyword search when the embedding index is unavailable, and say so in the outcome.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

use super::model::{Collection, Library, Resource};
use super::semantic::SemanticError;
use super::text::{
    matches_any_normalized, normalize_search_text, normalized_keywords, token_key,
    token_match_kind, tokenize,
};

pub const DEFAULT_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 500;
/// Reciprocal rank fusion constant; 60 is the standard value from the original RRF paper.
pub const RRF_K: f32 = 60.0;
/// Added when the query is exactly the record's title: as much as one token can earn from all
/// four fields at once, so field bonuses alone cannot catch it.
const EXACT_TITLE_BONUS: f32 = 10.0;
/// Tie-breaking nudge for favorites.
const FAVORITE_BONUS: f32 = 0.5;

/// English and Turkish function words dropped during relaxed matching; already normalized.
pub const STOP_WORDS: &[&str] = &[
    "a", "an", "the", "about", "that", "this", "in", "on", "of", "for", "with", "to", "and", "or",
    "is", "was", "bir", "ve", "ile", "icin", "hakkinda", "su", "bu", "o", "gibi", "olan",
];

/// Said when the answer needed [`STOP_WORDS`] dropped to find anything.
pub const RELAXED_STOP_WORDS_NOTE: &str =
    "keyword search ignored common words to find more matches";
/// Said when the answer contains records that matched only some of the query's words.
pub const RELAXED_PARTIAL_NOTE: &str = "keyword search relaxed to partial matches";
/// Said when there was no query, so the answer is a listing instead of a ranking.
pub const EMPTY_QUERY_NOTE: &str = "empty query: listing the records the filters select";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SearchMode {
    /// Keyword first, embeddings second, fused with RRF. The default.
    #[default]
    Hybrid,
    Keyword,
    Semantic,
}

impl SearchMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SearchMode::Hybrid => "hybrid",
            SearchMode::Keyword => "keyword",
            SearchMode::Semantic => "semantic",
        }
    }

    /// Parses the wire value (`hybrid` / `keyword` / `semantic`); anything else is `None`.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "hybrid" => Some(SearchMode::Hybrid),
            "keyword" => Some(SearchMode::Keyword),
            "semantic" => Some(SearchMode::Semantic),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchedBy {
    Keyword,
    Semantic,
    Both,
}

impl MatchedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchedBy::Keyword => "keyword",
            MatchedBy::Semantic => "semantic",
            MatchedBy::Both => "both",
        }
    }
}

/// Everything that narrows the candidate set before ranking. All conditions are ANDed; an unset
/// field does not filter.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Filters {
    pub category: Option<String>,
    pub tag: Option<String>,
    pub collection_id: Option<String>,
    /// Inclusive lower bound on `createdAt` (epoch ms).
    pub added_after: Option<i64>,
    /// Inclusive upper bound on `createdAt` (epoch ms).
    pub added_before: Option<i64>,
    /// Only records never opened from inside MYNK (`lastOpenedAt == null`).
    pub unopened_only: bool,
    pub favorites_only: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    pub text: String,
    pub mode: SearchMode,
    pub limit: usize,
    pub filters: Filters,
}

impl Default for Query {
    fn default() -> Self {
        Self {
            text: String::new(),
            mode: SearchMode::default(),
            limit: DEFAULT_LIMIT,
            filters: Filters::default(),
        }
    }
}

impl Query {
    /// A keyword-only query with the default limit.
    pub fn keyword(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            mode: SearchMode::Keyword,
            ..Self::default()
        }
    }

    pub fn effective_limit(&self) -> usize {
        self.limit.min(MAX_LIMIT)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit<'a> {
    pub resource: &'a Resource,
    pub score: f32,
    pub matched_by: MatchedBy,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchOutcome<'a> {
    pub hits: Vec<Hit<'a>>,
    /// The mode that ran; differs from `Query::mode` when semantic search was unavailable.
    pub mode_used: SearchMode,
    /// Set when the answer is not what was asked for (semantic fell back to keyword).
    pub note: Option<String>,
}

/// The normalized columns a record is matched against.
#[derive(Debug, Clone, Default)]
pub struct SearchFields {
    pub all: String,
    pub title: String,
    pub host: String,
    pub tags: String,
    /// [`token_key`] of the title, for the exact-title bonus.
    pub title_key: String,
    /// Each tag normalized on its own, for the tag filter.
    pub tag_list: Vec<String>,
}

/// Hostname without a leading `www.`; empty when the input is not an http(s) URL.
pub fn host_of(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let parsed = match url::Url::parse(trimmed) {
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => Some(parsed),
        // An unsupported scheme (`mailto:`, `javascript:`) is not a page, unlike a bare host.
        Ok(_) => None,
        Err(_) => url::Url::parse(&format!("https://{trimmed}")).ok(),
    };
    let Some(parsed) = parsed else {
        return String::new();
    };
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

pub fn search_fields(resource: &Resource) -> SearchFields {
    let title = normalize_search_text(&resource.title);
    let host = normalize_search_text(&host_of(&resource.url));
    let tags = normalize_search_text(&resource.tags.join(" "));
    let all = [
        title.as_str(),
        &normalize_search_text(&resource.description),
        &normalize_search_text(&resource.url),
        host.as_str(),
        tags.as_str(),
        &normalize_search_text(&resource.summary.join(" ")),
        &normalize_search_text(&resource.folder_path.join(" ")),
    ]
    .join("\n");
    SearchFields {
        all,
        title,
        host,
        tags,
        title_key: token_key(&resource.title),
        tag_list: resource
            .tags
            .iter()
            .map(|tag| normalize_search_text(tag))
            .collect(),
    }
}

/// Score of one query token against one record: 0 when absent, otherwise 1 plus field bonuses.
fn token_score(fields: &SearchFields, token: &str) -> f32 {
    if !fields.all.contains(token) {
        return 0.0;
    }
    let mut score = 1.0f32;
    // Whole word > word start > inside a word.
    match token_match_kind(&fields.title, token, 3) {
        3 => score += 5.0,
        2 => score += 4.0,
        1 => score += 2.0,
        _ => {}
    }
    if fields.tags.contains(token) {
        score += 2.0;
    }
    if fields.host.contains(token) {
        score += 2.0;
    }
    if token_match_kind(&fields.all, token, 2) >= 2 {
        score += 1.0;
    }
    score
}

/// One collection's membership rule, indexed once so testing a record costs no normalization.
pub struct Membership<'a> {
    pinned_ids: HashSet<&'a str>,
    keywords: Vec<String>,
}

impl<'a> Membership<'a> {
    pub fn of(collection: &'a Collection) -> Self {
        Self {
            pinned_ids: collection.pinned_ids.iter().map(String::as_str).collect(),
            keywords: normalized_keywords(&collection.keywords),
        }
    }

    /// Pinned by id, or a keyword starting a word in the record's search text.
    pub fn contains(&self, resource: &Resource, fields: &SearchFields) -> bool {
        self.pinned_ids.contains(resource.id.as_str())
            || matches_any_normalized(&fields.all, &self.keywords)
    }
}

/// `wanted_tag` is `f.tag`, normalized once per query instead of once per record.
fn passes_filters(
    resource: &Resource,
    fields: &SearchFields,
    f: &Filters,
    wanted_tag: Option<&str>,
    collection: Option<&Membership<'_>>,
) -> bool {
    if f.favorites_only && !resource.is_favorite {
        return false;
    }
    if f.unopened_only && resource.last_opened_at.is_some() {
        return false;
    }
    if let Some(category) = &f.category {
        if !resource.category().eq_ignore_ascii_case(category.trim()) {
            return false;
        }
    }
    if let Some(wanted) = wanted_tag {
        if !fields.tag_list.iter().any(|stored| stored == wanted) {
            return false;
        }
    }
    if f.added_after
        .is_some_and(|after| resource.created_at < after)
    {
        return false;
    }
    if f.added_before
        .is_some_and(|before| resource.created_at > before)
    {
        return false;
    }
    if let Some(collection) = collection {
        if !collection.contains(resource, fields) {
            return false;
        }
    }
    true
}

struct Candidate<'a> {
    resource: &'a Resource,
    score: f32,
}

/// Higher score first, then favorites, then newer. Equal entries keep their input order.
fn rank_order(a: &Candidate<'_>, b: &Candidate<'_>) -> std::cmp::Ordering {
    b.score
        .partial_cmp(&a.score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| b.resource.is_favorite.cmp(&a.resource.is_favorite))
        .then_with(|| b.resource.created_at.cmp(&a.resource.created_at))
}

/// Everything one pass over the library produces: the filtered set and the keyword ranking
/// within it.
#[derive(Default)]
struct Ranking<'a> {
    filtered_ids: HashSet<&'a str>,
    candidates: Vec<Candidate<'a>>,
    /// Which relaxation the ranking needed, if any.
    relaxed: Option<&'static str>,
}

/// Sum of the matched tokens' scores, plus how many matched; `None` if fewer than `needed` did.
fn score_tokens(fields: &SearchFields, tokens: &[String], needed: usize) -> Option<(f32, usize)> {
    let mut sum = 0.0f32;
    let mut matched = 0usize;
    for token in tokens {
        let value = token_score(fields, token);
        if value > 0.0 {
            sum += value;
            matched += 1;
        }
    }
    (matched > 0 && matched >= needed).then_some((sum, matched))
}

/// One relaxation tier: records not already ranked that match at least `needed` of `tokens`.
/// A partial tier scores by match count first, with the token-score sum only breaking ties.
fn rank_tier<'a>(
    filtered: &[(usize, &'a Resource)],
    fields: &[SearchFields],
    tokens: &[String],
    needed: usize,
    query_key: &str,
    seen: &HashSet<&str>,
) -> Vec<Candidate<'a>> {
    let mut tier: Vec<Candidate<'a>> = Vec::new();
    for (index, resource) in filtered {
        if seen.contains(resource.id.as_str()) {
            continue;
        }
        let Some(fields) = fields.get(*index) else {
            continue;
        };
        let Some((sum, matched)) = score_tokens(fields, tokens, needed) else {
            continue;
        };
        let score = if matched == tokens.len() {
            let mut score = sum;
            if !query_key.is_empty() && fields.title_key == query_key {
                score += EXACT_TITLE_BONUS;
            }
            if resource.is_favorite {
                score += FAVORITE_BONUS;
            }
            score
        } else {
            // `sum / (sum + 1)` stays in (0, 1), so the count decides and the sum breaks ties.
            matched as f32 + sum / (sum + 1.0)
        };
        tier.push(Candidate { resource, score });
    }
    tier
}

/// Appends a relaxed tier below everything ranked so far, rescaled so its best hit stays under
/// the worst hit above it, keeping scores monotonic across the whole answer.
fn append_tier<'a>(ranked: &mut Vec<Candidate<'a>>, mut tier: Vec<Candidate<'a>>) {
    if tier.is_empty() {
        return;
    }
    tier.sort_by(rank_order);
    if let Some(floor) = ranked.last().map(|candidate| candidate.score) {
        let ceiling = floor * 0.5;
        let top = tier.first().map_or(0.0, |candidate| candidate.score);
        let factor = if top > 0.0 && ceiling > 0.0 {
            ceiling / top
        } else {
            0.0
        };
        for candidate in &mut tier {
            candidate.score *= factor;
        }
    }
    ranked.extend(tier);
}

fn ranked_ids<'a>(ranked: &[Candidate<'a>]) -> HashSet<&'a str> {
    ranked
        .iter()
        .map(|candidate| candidate.resource.id.as_str())
        .collect()
}

/// Records passing `filters`, with their library index; `None` for an unknown collection id.
fn apply_filters<'a>(
    lib: &'a Library,
    fields: &[SearchFields],
    filters: &Filters,
) -> Option<Vec<(usize, &'a Resource)>> {
    let collection = match &filters.collection_id {
        None => None,
        Some(id) => Some(Membership::of(lib.collection(id)?)),
    };
    let wanted_tag = filters
        .tag
        .as_deref()
        .map(|tag| normalize_search_text(tag.trim()));
    let mut filtered: Vec<(usize, &'a Resource)> = Vec::new();
    for (index, resource) in lib.resources.iter().enumerate() {
        let Some(fields) = fields.get(index) else {
            continue;
        };
        if passes_filters(
            resource,
            fields,
            filters,
            wanted_tag.as_deref(),
            collection.as_ref(),
        ) {
            filtered.push((index, resource));
        }
    }
    Some(filtered)
}

/// Ids of the records passing `filters`, so a semantic ranker can rank only among them.
pub fn filtered_ids<'a>(
    lib: &'a Library,
    fields: &[SearchFields],
    filters: &Filters,
) -> HashSet<&'a str> {
    apply_filters(lib, fields, filters)
        .unwrap_or_default()
        .into_iter()
        .map(|(_, resource)| resource.id.as_str())
        .collect()
}

fn rank_keywords<'a>(lib: &'a Library, query: &Query, fields: &[SearchFields]) -> Ranking<'a> {
    // A set decides membership, so deduplicating stays linear in the number of query words.
    let mut seen_tokens: HashSet<String> = HashSet::new();
    let mut tokens: Vec<String> = Vec::new();
    for token in tokenize(&query.text) {
        if seen_tokens.insert(token.clone()) {
            tokens.push(token);
        }
    }
    let query_key = token_key(&query.text);
    let limit = query.effective_limit();

    let Some(filtered) = apply_filters(lib, fields, &query.filters) else {
        return Ranking::default();
    };
    let filtered_ids: HashSet<&'a str> = filtered
        .iter()
        .map(|(_, resource)| resource.id.as_str())
        .collect();

    if tokens.is_empty() {
        let mut candidates: Vec<Candidate<'a>> = filtered
            .into_iter()
            .map(|(_, resource)| Candidate {
                resource,
                score: 0.0,
            })
            .collect();
        candidates.sort_by(rank_order);
        return Ranking {
            filtered_ids,
            candidates,
            relaxed: None,
        };
    }

    // Tier 1: every token has to match.
    let mut candidates: Vec<Candidate<'a>> = Vec::new();
    let mut relaxed: Option<&'static str> = None;
    append_tier(
        &mut candidates,
        rank_tier(
            &filtered,
            fields,
            &tokens,
            tokens.len(),
            &query_key,
            &HashSet::new(),
        ),
    );

    let content: Vec<String> = tokens
        .iter()
        .filter(|token| !STOP_WORDS.contains(&token.as_str()))
        .cloned()
        .collect();

    // Tier 2: the same AND without the function words.
    if candidates.len() < limit && !content.is_empty() && content.len() < tokens.len() {
        let seen = ranked_ids(&candidates);
        let tier = rank_tier(
            &filtered,
            fields,
            &content,
            content.len(),
            &query_key,
            &seen,
        );
        if !tier.is_empty() {
            relaxed = Some(RELAXED_STOP_WORDS_NOTE);
        }
        append_tier(&mut candidates, tier);
    }

    // Tier 3: at least half the meaningful words.
    let partial: &[String] = if content.is_empty() {
        &tokens
    } else {
        &content
    };
    if candidates.len() < limit && partial.len() > 1 {
        let seen = ranked_ids(&candidates);
        let tier = rank_tier(
            &filtered,
            fields,
            partial,
            partial.len().div_ceil(2),
            &query_key,
            &seen,
        );
        if !tier.is_empty() {
            relaxed = Some(RELAXED_PARTIAL_NOTE);
        }
        append_tier(&mut candidates, tier);
    }

    Ranking {
        filtered_ids,
        candidates,
        relaxed,
    }
}

/// Fuses two ranked id lists via RRF: each contributes `1 / (k + rank)`. Ties keep the order
/// ids were first seen in (the keyword list's).
pub fn reciprocal_rank_fusion(keyword: &[&str], semantic: &[&str], k: f32) -> Vec<(String, f32)> {
    let mut fused: Vec<(String, f32)> = Vec::with_capacity(keyword.len() + semantic.len());
    let mut at: HashMap<&str, usize> = HashMap::with_capacity(keyword.len() + semantic.len());
    for list in [keyword, semantic] {
        for (rank, id) in list.iter().copied().enumerate() {
            let contribution = 1.0 / (k + (rank as f32) + 1.0);
            match at.entry(id) {
                Entry::Occupied(slot) => {
                    if let Some((_, score)) = fused.get_mut(*slot.get()) {
                        *score += contribution;
                    }
                }
                Entry::Vacant(slot) => {
                    slot.insert(fused.len());
                    fused.push((id.to_string(), contribution));
                }
            }
        }
    }
    // `sort_by` is stable, so equal scores keep the insertion order.
    fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    fused
}

/// A semantic ranker: query text and limit in, `(resource id, score)` pairs out, best first.
/// Injected so the fusion can be tested without an embedding server.
pub type SemanticRanker<'r> = &'r dyn Fn(&str, usize) -> Result<Vec<(String, f32)>, SemanticError>;

/// How many semantic hits to ask for: more than `limit`, so the fusion has something to work with.
pub fn semantic_fetch_size(limit: usize) -> usize {
    limit.saturating_mul(4).min(MAX_LIMIT)
}

fn unavailable_note(reason: &str) -> String {
    format!("semantic index unavailable: {reason}; answered with keyword search")
}

/// Joins up to two notes with `; `, `first` first.
pub fn join_notes(first: Option<String>, second: Option<&str>) -> Option<String> {
    match (first, second) {
        (Some(first), Some(second)) => Some(format!("{first}; {second}")),
        (Some(only), None) => Some(only),
        (None, Some(only)) => Some(only.to_string()),
        (None, None) => None,
    }
}

/// First record per id, so the fusion resolves a hit without scanning the library for it.
fn resources_by_id(lib: &Library) -> HashMap<&str, &Resource> {
    let mut by_id: HashMap<&str, &Resource> = HashMap::with_capacity(lib.resources.len());
    for resource in &lib.resources {
        by_id.entry(resource.id.as_str()).or_insert(resource);
    }
    by_id
}

/// Runs `query` against `lib`; `semantic` is the ranker to fuse with (`None` = keyword only).
/// Normalizes the search columns on the spot; a caller holding them uses [`search_with_fields`].
pub fn search_with<'a>(
    lib: &'a Library,
    query: &Query,
    semantic: Option<SemanticRanker<'_>>,
) -> SearchOutcome<'a> {
    let fields: Vec<SearchFields> = lib.resources.iter().map(search_fields).collect();
    search_with_fields(lib, &fields, query, semantic)
}

/// [`search_with`] over search columns the caller already has, one per record in library order.
pub fn search_with_fields<'a>(
    lib: &'a Library,
    fields: &[SearchFields],
    query: &Query,
    semantic: Option<SemanticRanker<'_>>,
) -> SearchOutcome<'a> {
    let limit = query.effective_limit();
    let Ranking {
        filtered_ids,
        candidates,
        relaxed,
    } = rank_keywords(lib, query, fields);

    let keyword_only = |note: Option<String>| SearchOutcome {
        hits: candidates
            .iter()
            .take(limit)
            .map(|candidate| Hit {
                resource: candidate.resource,
                score: candidate.score,
                matched_by: MatchedBy::Keyword,
            })
            .collect(),
        mode_used: SearchMode::Keyword,
        note: join_notes(note, relaxed),
    };

    if limit == 0 {
        return keyword_only(None);
    }
    // Nothing to embed, so an "index unavailable" note here would be misleading.
    if token_key(&query.text).is_empty() {
        return keyword_only(Some(EMPTY_QUERY_NOTE.to_string()));
    }
    if query.mode == SearchMode::Keyword {
        return keyword_only(None);
    }
    let Some(rank_semantically) = semantic else {
        return keyword_only(Some(unavailable_note("no index is configured")));
    };
    let ranked = match rank_semantically(&query.text, semantic_fetch_size(limit)) {
        Ok(ranked) => ranked,
        Err(error) => return keyword_only(Some(unavailable_note(&error.to_string()))),
    };
    // Filters are authoritative: a semantic hit outside the filtered set is dropped.
    let semantic_ids: Vec<&str> = ranked
        .iter()
        .map(|(id, _)| id.as_str())
        .filter(|id| filtered_ids.contains(id))
        .collect();
    let by_id = resources_by_id(lib);

    if query.mode == SearchMode::Semantic {
        let hits = semantic_ids
            .iter()
            .filter_map(|id| by_id.get(id).copied())
            .take(limit)
            .enumerate()
            .map(|(rank, resource)| Hit {
                resource,
                score: 1.0 / (RRF_K + (rank as f32) + 1.0),
                matched_by: MatchedBy::Semantic,
            })
            .collect();
        // No keyword ranking happened, so there is nothing to relax.
        return SearchOutcome {
            hits,
            mode_used: SearchMode::Semantic,
            note: None,
        };
    }

    let keyword_ids: Vec<&str> = candidates
        .iter()
        .map(|candidate| candidate.resource.id.as_str())
        .collect();
    let in_keyword: HashSet<&str> = keyword_ids.iter().copied().collect();
    let in_semantic: HashSet<&str> = semantic_ids.iter().copied().collect();
    let hits = reciprocal_rank_fusion(&keyword_ids, &semantic_ids, RRF_K)
        .into_iter()
        .filter_map(|(id, score)| {
            let resource = by_id.get(id.as_str()).copied()?;
            let matched_by = match (
                in_keyword.contains(id.as_str()),
                in_semantic.contains(id.as_str()),
            ) {
                (true, true) => MatchedBy::Both,
                (false, true) => MatchedBy::Semantic,
                _ => MatchedBy::Keyword,
            };
            Some(Hit {
                resource,
                score,
                matched_by,
            })
        })
        .take(limit)
        .collect();
    SearchOutcome {
        hits,
        mode_used: SearchMode::Hybrid,
        note: join_notes(None, relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resource(id: &str, url: &str, title: &str) -> Resource {
        Resource {
            id: id.to_string(),
            url: url.to_string(),
            title: title.to_string(),
            created_at: 1_000,
            ..Resource::default()
        }
    }

    fn fixture() -> Library {
        let mut rust = resource(
            "r1",
            "https://doc.rust-lang.org/book/ownership.html",
            "Ownership in Rust",
        );
        rust.tags = vec!["rust".into(), "memory".into()];
        rust.description = "Borrowing and lifetimes".into();
        rust.category_id = "development".into();
        rust.created_at = 3_000;
        rust.last_opened_at = Some(9_000);

        let mut turkish = resource("r2", "https://tr.example.com/yazilim", "Yazılım Geliştirme");
        turkish.summary = vec!["Türkçe yazılım kaynakları".into()];
        turkish.tags = vec!["yazılım".into()];
        turkish.category_id = "learning".into();
        turkish.created_at = 2_000;
        turkish.is_favorite = true;

        let mut blog = resource(
            "r3",
            "https://blog.example.com/rust-ownership-notes",
            "Notes",
        );
        blog.description = "Some thoughts about rust ownership".into();
        blog.category_id = "development".into();
        blog.created_at = 1_000;

        Library {
            version: 3,
            saved_at: 0,
            resources: vec![rust, turkish, blog],
            collections: vec![Collection {
                id: "c1".into(),
                name: "Rust".into(),
                description: String::new(),
                keywords: vec!["rust".into()],
                pinned_ids: vec!["r2".into()],
            }],
            skipped: 0,
        }
    }

    fn ids(outcome: &SearchOutcome<'_>) -> Vec<String> {
        outcome
            .hits
            .iter()
            .map(|hit| hit.resource.id.clone())
            .collect()
    }

    #[test]
    fn host_drops_www_and_ignores_non_http_schemes() {
        assert_eq!(host_of("https://www.Example.COM/a?b=1"), "example.com");
        assert_eq!(host_of("http://tr.example.com"), "tr.example.com");
        assert_eq!(host_of("example.com/x"), "example.com");
        assert_eq!(host_of("mailto:a@b.c"), "");
        assert_eq!(host_of(""), "");
    }

    #[test]
    fn title_outranks_description() {
        let lib = fixture();
        let outcome = search_with(&lib, &Query::keyword("ownership"), None);
        assert_eq!(outcome.mode_used, SearchMode::Keyword);
        assert_eq!(ids(&outcome), vec!["r1", "r3"]);
        assert!(outcome.hits[0].score > outcome.hits[1].score);
        assert!(outcome
            .hits
            .iter()
            .all(|hit| hit.matched_by == MatchedBy::Keyword));
    }

    #[test]
    fn every_token_must_match_before_anything_is_relaxed() {
        let lib = fixture();
        let outcome = search_with(&lib, &Query::keyword("rust ownership"), None);
        assert_eq!(ids(&outcome), vec!["r1", "r3"]);
        assert_eq!(outcome.note, None, "the strict tier answered on its own");
    }

    #[test]
    fn a_token_nothing_matches_falls_back_to_the_partial_tier() {
        let lib = fixture();
        let outcome = search_with(&lib, &Query::keyword("rust python"), None);
        assert_eq!(ids(&outcome), vec!["r1", "r3"]);
        assert_eq!(outcome.note.as_deref(), Some(RELAXED_PARTIAL_NOTE));
        assert!(outcome
            .hits
            .iter()
            .all(|hit| hit.matched_by == MatchedBy::Keyword));

        let outcome = search_with(&lib, &Query::keyword("haskell ocaml"), None);
        assert!(outcome.hits.is_empty());
        assert_eq!(
            outcome.note, None,
            "nothing was relaxed because nothing hit"
        );
    }

    #[test]
    fn a_natural_language_query_answers_instead_of_returning_nothing() {
        let lib = fixture();
        let outcome = search_with(
            &lib,
            &Query::keyword("article about memory safety in rust"),
            None,
        );
        assert_eq!(
            ids(&outcome),
            vec!["r1"],
            "only the record carrying both \"memory\" and \"rust\" matches half the words"
        );
        assert_eq!(outcome.note.as_deref(), Some(RELAXED_PARTIAL_NOTE));
    }

    #[test]
    fn the_stop_word_tier_runs_before_the_partial_one() {
        let lib = fixture();
        let outcome = search_with(&lib, &Query::keyword("ownership in rust"), None);
        assert_eq!(ids(&outcome), vec!["r1", "r3"]);
        assert_eq!(
            outcome.note.as_deref(),
            Some(RELAXED_STOP_WORDS_NOTE),
            "\"in\" is a stop word, and the rest still match strictly"
        );
    }

    #[test]
    fn relaxed_hits_rank_below_strict_ones_and_scores_fall_monotonically() {
        let lib = fixture();
        let outcome = search_with(&lib, &Query::keyword("rust memory"), None);
        assert_eq!(ids(&outcome), vec!["r1", "r3"]);
        assert_eq!(outcome.note.as_deref(), Some(RELAXED_PARTIAL_NOTE));
        let scores: Vec<f32> = outcome.hits.iter().map(|hit| hit.score).collect();
        assert!(
            scores.windows(2).all(|pair| pair[0] > pair[1]),
            "{scores:?}"
        );
        assert!(scores.iter().all(|score| *score > 0.0), "{scores:?}");
    }

    #[test]
    fn a_full_strict_answer_is_never_relaxed() {
        let lib = fixture();
        let query = Query {
            limit: 1,
            ..Query::keyword("rust memory")
        };
        let outcome = search_with(&lib, &query, None);
        assert_eq!(ids(&outcome), vec!["r1"]);
        assert_eq!(
            outcome.note, None,
            "one strict hit already fills a limit of one, so r3 is never looked for"
        );
    }

    #[test]
    fn the_stop_word_list_is_already_normalized() {
        for word in STOP_WORDS {
            assert_eq!(&normalize_search_text(word), word, "{word}");
            assert_eq!(tokenize(word), vec![word.to_string()], "{word}");
        }
        for turkish in ["için", "hakkında", "şu"] {
            assert!(
                STOP_WORDS.contains(&normalize_search_text(turkish).as_str()),
                "{turkish}"
            );
        }
    }

    #[test]
    fn a_turkish_query_matches_a_turkish_record() {
        let lib = fixture();
        for query in ["YAZILIM", "yazilim", "Yazılım"] {
            assert_eq!(
                ids(&search_with(&lib, &Query::keyword(query), None)),
                vec!["r2"],
                "query {query}"
            );
        }
        assert_eq!(
            ids(&search_with(&lib, &Query::keyword("geliştirme"), None)),
            vec!["r2"]
        );
    }

    #[test]
    fn whole_words_beat_prefixes() {
        let mut lib = fixture();
        let mut rustaceans = resource("r4", "https://example.org/rustaceans", "Rustaceans");
        rustaceans.created_at = 4_000;
        lib.resources.push(rustaceans);

        let ranked = ids(&search_with(&lib, &Query::keyword("rust"), None));
        let whole = ranked.iter().position(|id| id == "r1").expect("r1");
        let prefix = ranked.iter().position(|id| id == "r4").expect("r4");
        assert!(whole < prefix, "{ranked:?}");
    }

    #[test]
    fn an_exact_title_query_wins() {
        let lib = fixture();
        let outcome = search_with(&lib, &Query::keyword("notes"), None);
        assert_eq!(ids(&outcome), vec!["r3"]);
        assert!(outcome.hits[0].score > EXACT_TITLE_BONUS);
    }

    #[test]
    fn filters_are_anded() {
        let lib = fixture();
        let filtered = |filters: Filters| {
            let query = Query {
                filters,
                ..Query::keyword("")
            };
            ids(&search_with(&lib, &query, None))
        };
        assert_eq!(
            filtered(Filters {
                category: Some("development".into()),
                ..Filters::default()
            }),
            vec!["r1", "r3"]
        );
        assert_eq!(
            filtered(Filters {
                tag: Some("YAZILIM".into()),
                ..Filters::default()
            }),
            vec!["r2"],
            "tags compare through the same normalisation as search"
        );
        assert_eq!(
            filtered(Filters {
                unopened_only: true,
                ..Filters::default()
            }),
            vec!["r2", "r3"]
        );
        assert_eq!(
            filtered(Filters {
                favorites_only: true,
                ..Filters::default()
            }),
            vec!["r2"]
        );
        assert_eq!(
            filtered(Filters {
                added_after: Some(2_000),
                added_before: Some(3_000),
                ..Filters::default()
            }),
            vec!["r2", "r1"],
            "both bounds are inclusive; favourites break the tie"
        );
        assert_eq!(
            filtered(Filters {
                collection_id: Some("c1".into()),
                ..Filters::default()
            }),
            vec!["r2", "r1", "r3"]
        );
        assert!(filtered(Filters {
            collection_id: Some("missing".into()),
            ..Filters::default()
        })
        .is_empty());
        assert!(filtered(Filters {
            category: Some("development".into()),
            favorites_only: true,
            ..Filters::default()
        })
        .is_empty());
    }

    #[test]
    fn a_record_without_a_category_is_found_under_other() {
        let mut lib = fixture();
        lib.resources[0].category_id = String::new();
        let query = Query {
            filters: Filters {
                category: Some("other".into()),
                ..Filters::default()
            },
            ..Query::keyword("")
        };
        assert_eq!(
            ids(&search_with(&lib, &query, None)),
            vec![lib.resources[0].id.as_str()],
            "the filter uses the same fallback the stats count under"
        );
    }

    #[test]
    fn an_empty_query_lists_the_filtered_set_favorites_then_newest_first() {
        let lib = fixture();
        let outcome = search_with(&lib, &Query::keyword("   "), None);
        assert_eq!(ids(&outcome), vec!["r2", "r1", "r3"]);
        assert!(outcome.hits.iter().all(|hit| hit.score == 0.0));
        assert_eq!(
            outcome.note.as_deref(),
            Some(EMPTY_QUERY_NOTE),
            "the answer says it is a listing rather than a ranking"
        );
    }

    #[test]
    fn an_empty_query_never_blames_the_semantic_index() {
        let lib = fixture();
        let ranker =
            |_: &str, _: usize| Err(SemanticError::Unavailable("Ollama is not running".into()));
        for mode in [SearchMode::Hybrid, SearchMode::Semantic] {
            let query = Query {
                mode,
                ..Query::keyword("")
            };
            let outcome = search_with(&lib, &query, Some(&ranker));
            assert_eq!(outcome.mode_used, SearchMode::Keyword, "{mode:?}");
            assert_eq!(outcome.note.as_deref(), Some(EMPTY_QUERY_NOTE), "{mode:?}");
            assert_eq!(ids(&outcome), vec!["r2", "r1", "r3"], "{mode:?}");
        }
    }

    #[test]
    fn the_limit_is_honored_and_capped() {
        let lib = fixture();
        let outcome = search_with(
            &lib,
            &Query {
                limit: 2,
                ..Query::keyword("")
            },
            None,
        );
        assert_eq!(outcome.hits.len(), 2);
        let none = search_with(
            &lib,
            &Query {
                limit: 0,
                ..Query::keyword("")
            },
            None,
        );
        assert!(none.hits.is_empty());
        assert_eq!(
            Query {
                limit: 100_000,
                ..Query::default()
            }
            .effective_limit(),
            MAX_LIMIT
        );
    }

    #[test]
    fn rrf_rewards_agreement_between_the_two_lists() {
        let keyword = ["a", "b", "c"];
        let semantic = ["c", "d"];
        let fused = reciprocal_rank_fusion(&keyword, &semantic, RRF_K);
        let order: Vec<&str> = fused.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(order, vec!["c", "a", "b", "d"], "{fused:?}");

        let score = |id: &str| {
            fused
                .iter()
                .find(|(other, _)| other == id)
                .map(|(_, score)| *score)
                .unwrap_or_default()
        };
        // c: rank 3 of the keyword list plus rank 1 of the semantic list.
        let expected = 1.0 / (RRF_K + 3.0) + 1.0 / (RRF_K + 1.0);
        assert!((score("c") - expected).abs() < 1e-6, "{}", score("c"));
        assert!(score("a") > score("b"));
        assert!(reciprocal_rank_fusion(&[], &[], RRF_K).is_empty());
    }

    #[test]
    fn hybrid_adds_what_the_keywords_missed() {
        let lib = fixture();
        let ranker = |_text: &str, _limit: usize| Ok(vec![("r2".to_string(), 0.9f32)]);
        let query = Query {
            mode: SearchMode::Hybrid,
            ..Query::keyword("rust")
        };
        let outcome = search_with(&lib, &query, Some(&ranker));
        assert_eq!(outcome.mode_used, SearchMode::Hybrid);
        assert_eq!(outcome.note, None);
        let labels: Vec<(String, MatchedBy)> = outcome
            .hits
            .iter()
            .map(|hit| (hit.resource.id.clone(), hit.matched_by))
            .collect();
        assert!(
            labels.contains(&("r2".to_string(), MatchedBy::Semantic)),
            "{labels:?}"
        );
        assert!(
            labels.contains(&("r1".to_string(), MatchedBy::Keyword)),
            "{labels:?}"
        );
    }

    #[test]
    fn a_record_both_rankings_find_is_labeled_both() {
        let lib = fixture();
        let ranker = |_text: &str, _limit: usize| Ok(vec![("r3".to_string(), 0.9f32)]);
        let query = Query {
            mode: SearchMode::Hybrid,
            ..Query::keyword("rust")
        };
        let outcome = search_with(&lib, &query, Some(&ranker));
        assert_eq!(outcome.hits[0].resource.id, "r3");
        assert_eq!(outcome.hits[0].matched_by, MatchedBy::Both);
    }

    #[test]
    fn semantic_hits_outside_the_filtered_set_are_dropped() {
        let lib = fixture();
        let ranker = |_text: &str, _limit: usize| Ok(vec![("r2".to_string(), 0.9f32)]);
        let query = Query {
            mode: SearchMode::Semantic,
            filters: Filters {
                category: Some("development".into()),
                ..Filters::default()
            },
            ..Query::keyword("rust")
        };
        let outcome = search_with(&lib, &query, Some(&ranker));
        assert_eq!(outcome.mode_used, SearchMode::Semantic);
        assert!(
            outcome.hits.is_empty(),
            "r2 is not in the development category"
        );
    }

    #[test]
    fn an_unavailable_index_falls_back_to_keyword_and_says_so() {
        let lib = fixture();
        let ranker = |_text: &str, _limit: usize| {
            Err(SemanticError::Unavailable("Ollama is not running".into()))
        };
        for mode in [SearchMode::Hybrid, SearchMode::Semantic] {
            let query = Query {
                mode,
                ..Query::keyword("rust")
            };
            let outcome = search_with(&lib, &query, Some(&ranker));
            assert_eq!(outcome.mode_used, SearchMode::Keyword, "{mode:?}");
            let note = outcome.note.expect("a note explains the downgrade");
            assert!(note.starts_with("semantic index unavailable:"), "{note}");
            assert!(note.contains("Ollama is not running"), "{note}");
            assert!(!outcome.hits.is_empty(), "the keyword answer still stands");
        }
    }

    #[test]
    fn a_hybrid_search_without_a_ranker_degrades_to_keyword() {
        let lib = fixture();
        let outcome = search_with(
            &lib,
            &Query {
                text: "rust".into(),
                ..Query::default()
            },
            None,
        );
        assert_eq!(outcome.mode_used, SearchMode::Keyword);
        assert!(outcome
            .note
            .unwrap_or_default()
            .starts_with("semantic index unavailable:"));
        assert_eq!(
            search_with(&lib, &Query::keyword("rust"), None).note,
            None,
            "a keyword query was never promised an index"
        );
    }

    #[test]
    fn both_notes_reach_the_caller_together() {
        let lib = fixture();
        let ranker =
            |_: &str, _: usize| Err(SemanticError::Unavailable("Ollama is not running".into()));
        let query = Query {
            mode: SearchMode::Hybrid,
            ..Query::keyword("rust python")
        };
        let note = search_with(&lib, &query, Some(&ranker))
            .note
            .expect("two things happened");
        assert!(note.starts_with("semantic index unavailable:"), "{note}");
        assert!(note.ends_with(RELAXED_PARTIAL_NOTE), "{note}");
    }

    #[test]
    fn search_modes_parse_from_and_print_as_wire_values() {
        assert_eq!(SearchMode::parse("Hybrid"), Some(SearchMode::Hybrid));
        assert_eq!(SearchMode::parse(" keyword "), Some(SearchMode::Keyword));
        assert_eq!(SearchMode::parse("semantic"), Some(SearchMode::Semantic));
        assert_eq!(SearchMode::parse("magic"), None);
        assert_eq!(SearchMode::default().as_str(), "hybrid");
        assert_eq!(MatchedBy::Both.as_str(), "both");
        assert_eq!(MatchedBy::Semantic.as_str(), "semantic");
    }
}
