//! Everything an agent can ask, in one Tauri-free, transport-free place.
//!
//! Answers are built by [`super::output`], which keeps file paths and media names out of them.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::catalog::inbox::{self, InboxEntry};
use crate::catalog::model::Library;
use crate::catalog::search::{self, Filters, Query, SearchMode};
use crate::catalog::views;
use crate::error::{AppError, AppResult};
use crate::paths;

use super::library_cache::{LibraryCache, Loaded};
use super::output;
use super::running;
use super::semantic_link;
use super::time;

pub const DEFAULT_LIMIT: u32 = search::DEFAULT_LIMIT as u32;
/// Most hits any single answer may carry.
pub const MAX_LIMIT: u32 = 100;
/// Default window for `list_recent` / `list_unopened`.
pub const DEFAULT_DAYS: u32 = 7;
/// Records a `mynk://collection/{id}` read embeds before it stops.
pub const MAX_COLLECTION_MEMBERS: usize = 100;
/// Longest `search_bookmarks` query. Every token is matched against every record, so an
/// unbounded query is unbounded work.
pub const MAX_QUERY_CHARS: usize = 512;

/// A `search_bookmarks` call, in the shape both front ends can build.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchRequest {
    pub query: String,
    pub mode: Option<String>,
    pub limit: Option<u32>,
    pub category: Option<String>,
    pub tag: Option<String>,
    pub collection_id: Option<String>,
    pub added_after: Option<String>,
    pub added_before: Option<String>,
    pub unopened_only: bool,
    pub favorites_only: bool,
}

/// An `add_bookmark` call.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AddRequest {
    pub url: String,
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub note: Option<String>,
    /// Who is adding it (`mcp:<client>` or `cli`); recorded, never acted on.
    pub source: String,
}

/// A `list_recent` / `list_unopened` call. `since` wins over `days` when both are given.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListRequest {
    pub days: Option<u32>,
    pub since: Option<String>,
    pub limit: Option<u32>,
    pub unopened_only: bool,
}

/// The library, the directories it lives in, and the questions that can be asked of it.
#[derive(Debug)]
pub struct Engine {
    cache: LibraryCache,
    cache_dir: PathBuf,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::invalid_input(message.into())
}

impl Engine {
    /// The real data and cache directories, honoring `MYNK_DATA_DIR` / `MYNK_CACHE_DIR`.
    pub fn from_env() -> AppResult<Self> {
        Ok(Self::new(paths::data_dir()?, paths::cache_dir()?))
    }

    pub fn new(data_dir: impl Into<PathBuf>, cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            cache: LibraryCache::new(data_dir),
            cache_dir: cache_dir.into(),
        }
    }

    pub fn data_dir(&self) -> &Path {
        self.cache.data_dir()
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    pub fn library(&self) -> AppResult<Arc<Library>> {
        self.cache.load()
    }

    /// The library with its search columns, for the questions that match against them.
    fn indexed(&self) -> AppResult<Arc<Loaded>> {
        self.cache.loaded()
    }

    fn limit(value: Option<u32>) -> AppResult<usize> {
        let limit = value.unwrap_or(DEFAULT_LIMIT);
        if limit == 0 || limit > MAX_LIMIT {
            return Err(invalid(format!("limit must be between 1 and {MAX_LIMIT}.")));
        }
        Ok(limit as usize)
    }

    fn mode(value: Option<&str>) -> AppResult<SearchMode> {
        match value {
            None => Ok(SearchMode::default()),
            Some(raw) => SearchMode::parse(raw)
                .ok_or_else(|| invalid("mode must be \"hybrid\", \"keyword\" or \"semantic\".")),
        }
    }

    fn instant(field: &str, value: Option<&String>, now: i64) -> AppResult<Option<i64>> {
        match value {
            None => Ok(None),
            Some(raw) => time::parse_instant(raw, now)
                .map(Some)
                .map_err(|message| invalid(format!("{field}: {message}"))),
        }
    }

    fn filters(request: &SearchRequest, now: i64) -> AppResult<Filters> {
        let trimmed = |value: &Option<String>| {
            value
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        Ok(Filters {
            category: trimmed(&request.category),
            tag: trimmed(&request.tag),
            collection_id: trimmed(&request.collection_id),
            added_after: Self::instant("added_after", request.added_after.as_ref(), now)?,
            added_before: Self::instant("added_before", request.added_before.as_ref(), now)?,
            unopened_only: request.unopened_only,
            favorites_only: request.favorites_only,
        })
    }

    /// Degrades to keyword matching when the embedding index is unavailable, and says why.
    pub async fn search(&self, request: &SearchRequest) -> AppResult<Value> {
        let now = time::now_ms();
        if request.query.chars().count() > MAX_QUERY_CHARS {
            return Err(invalid(format!(
                "query must be at most {MAX_QUERY_CHARS} characters."
            )));
        }
        let query = Query {
            text: request.query.trim().to_string(),
            mode: Self::mode(request.mode.as_deref())?,
            limit: Self::limit(request.limit)?,
            filters: Self::filters(request, now)?,
        };
        let searchable = !crate::catalog::text::token_key(&query.text).is_empty();
        if !searchable && query.filters == Filters::default() {
            return Err(invalid(
                "A query or at least one filter is required; use list_recent to browse the library.",
            ));
        }
        let loaded = self.indexed()?;
        let library = loaded.library();
        let fields = loaded.fields();

        if query.mode == SearchMode::Keyword || !searchable {
            return Ok(output::search(&search::search_with_fields(
                library, fields, &query, None,
            )));
        }
        // Filters narrow the candidates first, so the cut keeps records a filter would allow.
        let only = (query.filters != Filters::default())
            .then(|| search::filtered_ids(library, fields, &query.filters));
        let ranked = semantic_link::rank(
            library,
            self.data_dir(),
            &self.cache_dir,
            &query.text,
            search::semantic_fetch_size(query.effective_limit()),
            only.as_ref(),
        )
        .await;
        let outcome = match ranked {
            Ok(ranked) => {
                let ranker = |_: &str, _: usize| Ok(ranked.hits.clone());
                let mut outcome =
                    search::search_with_fields(library, fields, &query, Some(&ranker));
                // An index that does not cover the whole library still answers, and says so.
                outcome.note = search::join_notes(ranked.note, outcome.note.as_deref());
                outcome
            }
            Err(error) => {
                let ranker = |_: &str, _: usize| Err(error.clone());
                search::search_with_fields(library, fields, &query, Some(&ranker))
            }
        };
        Ok(output::search(&outcome))
    }

    /// One record by id or URL.
    pub fn get(&self, id_or_url: &str) -> AppResult<Value> {
        let needle = id_or_url.trim();
        if needle.is_empty() {
            return Err(invalid("An id or a URL is required."));
        }
        let library = self.library()?;
        let found = views::get(&library, needle)
            .ok_or_else(|| AppError::NotFound(format!("No bookmark matches \"{needle}\".")))?;
        Ok(output::record_detailed(found))
    }

    fn since(request: &ListRequest, now: i64, default_days: u32) -> AppResult<Option<i64>> {
        if let Some(raw) = request.since.as_ref() {
            return time::parse_instant(raw, now)
                .map(Some)
                .map_err(|message| invalid(format!("since: {message}")));
        }
        Ok(Some(time::days_before(
            now,
            request.days.unwrap_or(default_days),
        )))
    }

    /// Recently added records, newest first.
    pub fn recent(&self, request: &ListRequest) -> AppResult<Value> {
        let now = time::now_ms();
        let since = Self::since(request, now, DEFAULT_DAYS)?;
        let limit = Self::limit(request.limit)?;
        let library = self.library()?;
        let found = views::recent(&library, since, limit, request.unopened_only);
        let note = request.unopened_only.then_some(output::VISIT_CAVEAT);
        Ok(output::list(&found, note))
    }

    /// Records never opened from inside MYNK; always carries the visit caveat.
    pub fn unopened(&self, request: &ListRequest) -> AppResult<Value> {
        let now = time::now_ms();
        let since = Self::since(request, now, DEFAULT_DAYS)?;
        let limit = Self::limit(request.limit)?;
        let library = self.library()?;
        let found = views::unopened(&library, since, limit);
        Ok(output::list(&found, Some(output::VISIT_CAVEAT)))
    }

    pub fn collections(&self) -> AppResult<Value> {
        let loaded = self.indexed()?;
        Ok(output::collections(&views::collections_with_fields(
            loaded.library(),
            loaded.fields(),
        )))
    }

    pub fn tags(&self) -> AppResult<Value> {
        let library = self.library()?;
        Ok(output::counted("tags", &views::tags(&library)))
    }

    /// Category ids in use, with their counts; display names are resolved by the app.
    pub fn categories(&self) -> AppResult<Value> {
        let library = self.library()?;
        Ok(output::counted(
            "categories",
            &views::stats(&library).by_category,
        ))
    }

    pub fn stats(&self) -> AppResult<Value> {
        let library = self.library()?;
        let mut value = output::stats(&views::stats(&library));
        if let Value::Object(map) = &mut value {
            map.insert("pendingInbox".into(), json!(inbox::count(self.data_dir())));
            map.insert(
                "appRunning".into(),
                json!(running::app_is_running(self.data_dir(), time::now_ms())),
            );
        }
        Ok(value)
    }

    /// Hands a bookmark to MYNK through the inbox; never writes `library.json` directly.
    pub fn add(&self, request: &AddRequest) -> AppResult<Value> {
        let mut entry = InboxEntry::new(request.url.trim(), request.source.trim());
        entry.title = request
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        entry.tags = request.tags.clone();
        entry.note = request
            .note
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        inbox::write(self.data_dir(), &entry)?;
        Ok(json!({
            "queued": true,
            "appearsIn": running::appears_in(self.data_dir(), time::now_ms()),
            "url": entry.url.trim(),
        }))
    }

    /// The body behind `mynk://bookmark/{id}`.
    pub fn bookmark_resource(&self, id: &str) -> AppResult<Value> {
        self.get(id)
    }

    /// The body behind `mynk://collection/{id}`: the collection plus the records in it.
    pub fn collection_resource(&self, id: &str) -> AppResult<Value> {
        let wanted = id.trim();
        let loaded = self.indexed()?;
        let library = loaded.library();
        let summary = views::collections_with_fields(library, loaded.fields())
            .into_iter()
            .find(|summary| summary.id == wanted)
            .ok_or_else(|| AppError::NotFound(format!("No collection has the id \"{wanted}\".")))?;
        let query = Query {
            filters: Filters {
                collection_id: Some(summary.id.clone()),
                ..Filters::default()
            },
            limit: MAX_COLLECTION_MEMBERS,
            ..Query::keyword("")
        };
        let outcome = search::search_with_fields(library, loaded.fields(), &query, None);
        let members: Vec<_> = outcome.hits.iter().map(|hit| hit.resource).collect();
        Ok(output::collection_resource(&summary, &members))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library_json() -> String {
        json!({
            "version": 3,
            "savedAt": 1_757_289_600_000i64,
            "resources": [
                {
                    "id": "r1",
                    "url": "https://doc.rust-lang.org/book/",
                    "title": "Ownership in Rust",
                    "description": "Borrowing and lifetimes.",
                    "categoryId": "development",
                    "tags": ["rust", "memory"],
                    "createdAt": 1_757_289_600_000i64,
                    "lastOpenedAt": 1_757_376_000_000i64,
                    "isFavorite": true,
                    "ai": { "status": "ok", "analyzedAt": 1_757_289_600_000i64 },
                    "media": { "snapshotFile": "shot.png" },
                    "health": { "status": "alive", "httpStatus": 200 }
                },
                {
                    "id": "r2",
                    "url": "https://tr.example.com/yazilim",
                    "title": "Yazılım Geliştirme",
                    "categoryId": "learning",
                    "tags": ["yazılım"],
                    "createdAt": 1_757_203_200_000i64,
                    "lastOpenedAt": null
                }
            ],
            "collections": [
                { "id": "c1", "name": "Rust", "description": "Rust reading", "keywords": ["rust"], "pinnedIds": [] }
            ]
        })
        .to_string()
    }

    fn engine() -> (tempfile::TempDir, Engine) {
        let dir = tempfile::tempdir().expect("temp dir");
        crate::library::save(dir.path(), &library_json()).expect("seed");
        let engine = Engine::new(dir.path(), dir.path().join("cache"));
        (dir, engine)
    }

    fn ids(value: &Value, key: &str) -> Vec<String> {
        value[key]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["id"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn keyword_search_answers_without_a_note() {
        let (_dir, engine) = engine();
        let value = engine
            .search(&SearchRequest {
                query: "ownership".into(),
                mode: Some("keyword".into()),
                ..SearchRequest::default()
            })
            .await
            .expect("search");
        assert_eq!(ids(&value, "hits"), vec!["r1"]);
        assert_eq!(value["modeUsed"], "keyword");
        assert_eq!(value["note"], Value::Null);
        assert_eq!(value["total"], 1);
        assert_eq!(value["hits"][0]["matchedBy"], "keyword");
    }

    #[tokio::test]
    async fn a_hybrid_search_reports_the_mode_it_ran() {
        let (_dir, engine) = engine();
        let value = engine
            .search(&SearchRequest {
                query: "ownership".into(),
                ..SearchRequest::default()
            })
            .await
            .expect("search");
        let mode = value["modeUsed"].as_str().unwrap_or_default().to_string();
        assert!(matches!(mode.as_str(), "hybrid" | "keyword"), "{mode}");
        if mode == "keyword" {
            let note = value["note"].as_str().unwrap_or_default();
            assert!(
                note.starts_with("semantic index unavailable:"),
                "a downgrade has to explain itself: {note}"
            );
        }
        assert!(ids(&value, "hits").contains(&"r1".to_string()));
    }

    #[tokio::test]
    async fn an_empty_query_without_a_filter_is_refused() {
        let (_dir, engine) = engine();
        for query in ["", "   "] {
            let error = engine
                .search(&SearchRequest {
                    query: query.into(),
                    ..SearchRequest::default()
                })
                .await
                .expect_err("nothing to search for");
            assert_eq!(error.kind(), "invalidInput", "{query:?}");
            assert!(error.to_string().contains("list_recent"), "{error}");
        }
    }

    #[tokio::test]
    async fn an_empty_query_with_a_filter_lists_and_says_it_listed() {
        let (_dir, engine) = engine();
        let value = engine
            .search(&SearchRequest {
                query: String::new(),
                unopened_only: true,
                ..SearchRequest::default()
            })
            .await
            .expect("search");
        assert_eq!(ids(&value, "hits"), vec!["r2"]);
        assert_eq!(value["modeUsed"], "keyword");
        assert_eq!(
            value["note"],
            crate::catalog::search::EMPTY_QUERY_NOTE,
            "an empty query is a listing, not a downgraded semantic search"
        );
    }

    #[tokio::test]
    async fn a_sentence_shaped_query_answers_instead_of_returning_nothing() {
        let (_dir, engine) = engine();
        let value = engine
            .search(&SearchRequest {
                query: "article about memory safety in rust".into(),
                mode: Some("keyword".into()),
                ..SearchRequest::default()
            })
            .await
            .expect("search");
        assert_eq!(ids(&value, "hits"), vec!["r1"]);
        assert_eq!(
            value["note"],
            crate::catalog::search::RELAXED_PARTIAL_NOTE,
            "the answer says it was relaxed"
        );
        assert_eq!(value["hits"][0]["rank"], 1);
        assert_eq!(value["hits"][0]["score"], 1.0);
    }

    fn filtered(mutate: impl FnOnce(&mut SearchRequest)) -> SearchRequest {
        let mut request = SearchRequest {
            mode: Some("keyword".into()),
            ..SearchRequest::default()
        };
        mutate(&mut request);
        request
    }

    #[tokio::test]
    async fn search_filters_are_applied() {
        let (_dir, engine) = engine();
        let cases: Vec<(SearchRequest, Vec<&str>)> = vec![
            (
                filtered(|r| r.category = Some("learning".into())),
                vec!["r2"],
            ),
            (filtered(|r| r.unopened_only = true), vec!["r2"]),
            (filtered(|r| r.favorites_only = true), vec!["r1"]),
            (
                filtered(|r| r.collection_id = Some("c1".into())),
                vec!["r1"],
            ),
            (filtered(|r| r.tag = Some("YAZILIM".into())), vec!["r2"]),
        ];
        for (request, expected) in cases {
            let value = engine.search(&request).await.expect("search");
            assert_eq!(ids(&value, "hits"), expected, "{request:?}");
        }
    }

    #[tokio::test]
    async fn search_rejects_input_it_cannot_honor() {
        let (_dir, engine) = engine();
        let cases: Vec<(SearchRequest, &str)> = vec![
            (filtered(|r| r.mode = Some("fuzzy".into())), "hybrid"),
            (filtered(|r| r.limit = Some(0)), "between 1 and 100"),
            (
                filtered(|r| r.limit = Some(MAX_LIMIT + 1)),
                "between 1 and 100",
            ),
            (
                filtered(|r| r.added_after = Some("last tuesday".into())),
                "added_after",
            ),
            (
                filtered(|r| r.query = "rust ".repeat(MAX_QUERY_CHARS)),
                "at most 512 characters",
            ),
        ];
        for (request, expected) in cases {
            let error = engine.search(&request).await.expect_err("must be refused");
            assert_eq!(error.kind(), "invalidInput", "{request:?}");
            assert!(
                error.to_string().contains(expected),
                "{error} ({request:?})"
            );
        }

        // The limit itself is still answered.
        let longest = filtered(|r| r.query = "a".repeat(MAX_QUERY_CHARS));
        engine
            .search(&longest)
            .await
            .expect("a query at the limit is fine");
    }

    #[tokio::test]
    async fn a_relative_window_filters_by_age() {
        let (_dir, engine) = engine();
        let value = engine
            .search(&SearchRequest {
                mode: Some("keyword".into()),
                added_after: Some("24h".into()),
                ..SearchRequest::default()
            })
            .await
            .expect("search");
        assert_eq!(value["total"], 0);
    }

    #[test]
    fn get_finds_a_record_by_id_or_url_and_says_so_when_it_cannot() {
        let (_dir, engine) = engine();
        assert_eq!(
            engine.get("r1").expect("by id")["title"],
            "Ownership in Rust"
        );
        assert_eq!(
            engine
                .get("http://www.doc.rust-lang.org/book")
                .expect("by url")["id"],
            "r1"
        );
        let error = engine.get("nope").expect_err("missing");
        assert_eq!(error.kind(), "notFound");
        assert_eq!(engine.get("  ").expect_err("blank").kind(), "invalidInput");
    }

    #[test]
    fn recent_and_unopened_carry_the_visit_caveat_where_it_matters() {
        let (_dir, engine) = engine();
        let all = engine
            .recent(&ListRequest {
                since: Some("1970-01-01".into()),
                ..ListRequest::default()
            })
            .expect("recent");
        assert_eq!(ids(&all, "bookmarks"), vec!["r1", "r2"]);
        assert_eq!(all["note"], Value::Null, "a plain list needs no caveat");

        let unopened = engine
            .unopened(&ListRequest {
                since: Some("1970-01-01".into()),
                ..ListRequest::default()
            })
            .expect("unopened");
        assert_eq!(ids(&unopened, "bookmarks"), vec!["r2"]);
        assert_eq!(unopened["note"], output::VISIT_CAVEAT);

        let filtered = engine
            .recent(&ListRequest {
                since: Some("1970-01-01".into()),
                unopened_only: true,
                ..ListRequest::default()
            })
            .expect("recent unopened");
        assert_eq!(filtered["note"], output::VISIT_CAVEAT);

        assert_eq!(
            engine.recent(&ListRequest::default()).expect("recent")["total"],
            0
        );
    }

    #[test]
    fn the_summary_views_count_what_is_there() {
        let (_dir, engine) = engine();
        let tags = engine.tags().expect("tags");
        assert_eq!(tags["total"], 3);
        let categories = engine.categories().expect("categories");
        assert_eq!(categories["categories"][0]["name"], "development");
        let collections = engine.collections().expect("collections");
        assert_eq!(collections["collections"][0]["count"], 1);
        let stats = engine.stats().expect("stats");
        assert_eq!(stats["total"], 2);
        assert_eq!(stats["pendingInbox"], 0);
        assert_eq!(stats["appRunning"], false);
    }

    #[test]
    fn adding_writes_to_the_inbox_and_leaves_the_library_alone() {
        let (dir, engine) = engine();
        let before = std::fs::read_to_string(dir.path().join("library.json")).expect("library");
        let value = engine
            .add(&AddRequest {
                url: " https://example.com/new ".into(),
                title: Some("  ".into()),
                tags: vec!["rust".into(), "rust".into()],
                note: Some("read later".into()),
                source: "mcp:test-client".into(),
            })
            .expect("add");
        assert_eq!(value["queued"], true);
        assert_eq!(value["appearsIn"], "next-launch");
        assert_eq!(inbox::count(engine.data_dir()), 1);

        let drained = inbox::drain(engine.data_dir()).expect("drain");
        assert_eq!(drained[0].url, "https://example.com/new");
        assert_eq!(drained[0].title, None, "a blank title is dropped");
        assert_eq!(drained[0].tags, vec!["rust"], "duplicates are dropped");
        assert_eq!(drained[0].source, "mcp:test-client");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("library.json")).expect("library"),
            before,
            "the library the app owns is never touched"
        );
    }

    #[test]
    fn adding_refuses_what_the_app_could_not_import() {
        let (_dir, engine) = engine();
        for url in [
            "",
            "javascript:alert(1)",
            "file:///C:/Windows/win.ini",
            "nope",
        ] {
            let error = engine
                .add(&AddRequest {
                    url: url.into(),
                    source: "cli".into(),
                    ..AddRequest::default()
                })
                .expect_err(url);
            assert_eq!(error.kind(), "invalidInput", "{url}");
        }
        assert_eq!(inbox::count(engine.data_dir()), 0);
    }

    #[test]
    fn a_fresh_heartbeat_changes_what_add_promises() {
        let (dir, engine) = engine();
        let now = time::now_ms();
        std::fs::write(
            dir.path().join(running::RUNNING_FILE),
            json!({ "pid": 1, "startedAt": now, "heartbeatAt": now }).to_string(),
        )
        .expect("heartbeat");
        let value = engine
            .add(&AddRequest {
                url: "https://example.com/live".into(),
                source: "cli".into(),
                ..AddRequest::default()
            })
            .expect("add");
        assert_eq!(value["appearsIn"], "seconds");
        assert_eq!(engine.stats().expect("stats")["appRunning"], true);
    }

    #[test]
    fn resources_resolve_by_id_and_report_what_is_missing() {
        let (_dir, engine) = engine();
        assert_eq!(
            engine.bookmark_resource("r2").expect("bookmark")["id"],
            "r2"
        );
        let collection = engine.collection_resource("c1").expect("collection");
        assert_eq!(collection["name"], "Rust");
        assert_eq!(collection["count"], 1);
        assert_eq!(ids(&collection, "bookmarks"), vec!["r1"]);
        assert_eq!(
            engine
                .collection_resource("c9")
                .expect_err("missing")
                .kind(),
            "notFound"
        );
    }

    #[test]
    fn the_environment_decides_the_directories() {
        let engine = Engine::new("/tmp/mynk-data", "/tmp/mynk-cache");
        assert_eq!(engine.data_dir(), Path::new("/tmp/mynk-data"));
        assert_eq!(engine.cache_dir(), Path::new("/tmp/mynk-cache"));
    }
}
