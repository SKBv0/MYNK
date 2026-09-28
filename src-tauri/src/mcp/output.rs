//! Records to JSON; the one place that decides which fields an agent can see.
//!
//! Every field is written out by hand; no file path or media name can reach an answer this way.

use serde_json::{json, Value};

use crate::catalog::model::Resource;
use crate::catalog::search::{Hit, SearchOutcome};
use crate::catalog::views::{CollectionSummary, Stats};

use super::time::{to_iso, to_iso_opt};

/// Said in every answer that reports "never opened": MYNK only records opens through its own UI.
pub const VISIT_CAVEAT: &str =
    "Only opens from inside MYNK are recorded; browser visits are unknown.";

/// The shape every list and every hit shares.
pub fn record(resource: &Resource) -> Value {
    json!({
        "id": resource.id,
        "url": resource.url,
        "title": resource.title,
        "description": resource.description,
        "tags": resource.tags,
        "category": resource.category(),
        "summary": resource.summary,
        "createdAt": to_iso(resource.created_at),
        "lastOpenedAt": to_iso_opt(resource.last_opened_at),
        "isFavorite": resource.is_favorite,
    })
}

/// [`record`] plus the housekeeping fields only `get_bookmark` and the resource reader need.
pub fn record_detailed(resource: &Resource) -> Value {
    let mut value = record(resource);
    if let Value::Object(map) = &mut value {
        map.insert(
            "updatedAt".into(),
            json!(to_iso_opt(Some(resource.updated_at))),
        );
        map.insert(
            "analysis".into(),
            json!({
                "status": resource.ai.status,
                "analyzedAt": to_iso_opt(resource.ai.analyzed_at),
                "needsAnalysis": resource.is_unanalyzed(),
            }),
        );
        map.insert(
            "link".into(),
            json!({
                "status": resource.health.status,
                "checkedAt": to_iso_opt(resource.health.checked_at),
                "httpStatus": resource.health.http_status,
            }),
        );
    }
    value
}

/// Rounds to four decimals through `f64`, avoiding `f32`-widening noise.
fn round4(value: f32) -> f64 {
    (f64::from(value) * 10_000.0).round() / 10_000.0
}

/// One search hit: the record, `rank`, and `score` relative to the best hit (1.0 at the top).
pub fn hit(found: &Hit<'_>, rank: usize, best: f32) -> Value {
    let mut value = record(found.resource);
    if let Value::Object(map) = &mut value {
        let relative = if best > 0.0 { found.score / best } else { 0.0 };
        map.insert("rank".into(), json!(rank));
        map.insert("score".into(), json!(round4(relative)));
        map.insert("matchedBy".into(), json!(found.matched_by.as_str()));
    }
    value
}

/// The whole `search_bookmarks` answer, including the `modeUsed` / `note` pair.
pub fn search(outcome: &SearchOutcome<'_>) -> Value {
    let best = outcome
        .hits
        .iter()
        .map(|found| found.score)
        .fold(0.0f32, f32::max);
    json!({
        "hits": outcome
            .hits
            .iter()
            .enumerate()
            .map(|(index, found)| hit(found, index + 1, best))
            .collect::<Vec<_>>(),
        "modeUsed": outcome.mode_used.as_str(),
        "note": outcome.note,
        "total": outcome.hits.len(),
    })
}

/// A list answer (`list_recent`, `list_unopened`), optionally carrying the visit caveat.
pub fn list(records: &[&Resource], note: Option<&str>) -> Value {
    json!({
        "bookmarks": records.iter().map(|r| record(r)).collect::<Vec<_>>(),
        "total": records.len(),
        "note": note,
    })
}

pub fn collections(summaries: &[CollectionSummary]) -> Value {
    json!({
        "collections": summaries
            .iter()
            .map(|summary| json!({
                "id": summary.id,
                "name": summary.name,
                "description": summary.description,
                "count": summary.member_count,
            }))
            .collect::<Vec<_>>(),
        "total": summaries.len(),
    })
}

/// `(name, count)` pairs as `{ name, count }` objects under `key`.
pub fn counted(key: &str, counts: &[(String, usize)]) -> Value {
    json!({
        key: counts
            .iter()
            .map(|(name, count)| json!({ "name": name, "count": count }))
            .collect::<Vec<_>>(),
        "total": counts.len(),
    })
}

pub fn stats(stats: &Stats) -> Value {
    json!({
        "total": stats.total,
        "byCategory": stats
            .by_category
            .iter()
            .map(|(name, count)| json!({ "name": name, "count": count }))
            .collect::<Vec<_>>(),
        "analyzed": stats.analyzed,
        "unanalyzed": stats.unanalyzed,
        "brokenLinks": stats.broken,
        "favorites": stats.favorites,
        "collections": stats.collections,
        "newestAddedAt": to_iso_opt(stats.newest_created_at),
        "unreadableRecords": stats.skipped,
    })
}

/// The `mynk://collection/{id}` body: the collection and the records that belong to it.
pub fn collection_resource(summary: &CollectionSummary, members: &[&Resource]) -> Value {
    json!({
        "id": summary.id,
        "name": summary.name,
        "description": summary.description,
        "count": summary.member_count,
        "bookmarks": members.iter().map(|r| record(r)).collect::<Vec<_>>(),
    })
}

/// The shape of every answer, declared for `outputSchema`. These types are never constructed.
pub mod schema {
    use rmcp::model::JsonObject;
    use rmcp::schemars::{self, JsonSchema};
    use std::sync::Arc;

    /// One bookmark, as every list and every hit carries it.
    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct BookmarkRecord {
        /// The MYNK id, which addresses it in `get_bookmark` and `mynk://bookmark/{id}`.
        pub id: String,
        pub url: String,
        pub title: String,
        pub description: String,
        pub tags: Vec<String>,
        /// Category id (not a display name); the ids in use come from `list_categories`.
        pub category: String,
        /// The AI summary, one line per bullet. Empty until the record has been analyzed.
        pub summary: Vec<String>,
        /// ISO-8601 UTC.
        pub created_at: String,
        /// ISO-8601 UTC, or null: MYNK only records opens through its own window.
        pub last_opened_at: Option<String>,
        pub is_favorite: bool,
    }

    /// The same record with the housekeeping `get_bookmark` adds.
    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct BookmarkDetail {
        pub id: String,
        pub url: String,
        pub title: String,
        pub description: String,
        pub tags: Vec<String>,
        pub category: String,
        pub summary: Vec<String>,
        pub created_at: String,
        pub last_opened_at: Option<String>,
        pub is_favorite: bool,
        pub updated_at: Option<String>,
        pub analysis: Analysis,
        pub link: LinkHealth,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct Analysis {
        pub status: String,
        pub analyzed_at: Option<String>,
        pub needs_analysis: bool,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct LinkHealth {
        pub status: String,
        pub checked_at: Option<String>,
        pub http_status: Option<u16>,
    }

    /// A record plus why it was returned.
    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct SearchHit {
        pub id: String,
        pub url: String,
        pub title: String,
        pub description: String,
        pub tags: Vec<String>,
        pub category: String,
        pub summary: Vec<String>,
        pub created_at: String,
        pub last_opened_at: Option<String>,
        pub is_favorite: bool,
        /// 1-based position in this answer. The ordering to rely on.
        pub rank: u32,
        /// How strongly it matched, relative to the best hit in this answer (1.0 at the top).
        pub score: f64,
        /// "keyword", "semantic" or "both".
        pub matched_by: String,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct SearchAnswer {
        pub hits: Vec<SearchHit>,
        /// The mode that ran; can differ from the one requested.
        pub mode_used: String,
        /// Why the answer is not what was asked for: a semantic downgrade, a relaxed keyword
        /// search, or an empty query answered as a listing.
        pub note: Option<String>,
        pub total: u32,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct ListAnswer {
        pub bookmarks: Vec<BookmarkRecord>,
        pub total: u32,
        pub note: Option<String>,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct CollectionEntry {
        pub id: String,
        pub name: String,
        pub description: String,
        pub count: u32,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct CollectionsAnswer {
        pub collections: Vec<CollectionEntry>,
        pub total: u32,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct CountEntry {
        pub name: String,
        pub count: u32,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct TagsAnswer {
        pub tags: Vec<CountEntry>,
        pub total: u32,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct CategoriesAnswer {
        pub categories: Vec<CountEntry>,
        pub total: u32,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct StatsAnswer {
        pub total: u32,
        pub by_category: Vec<CountEntry>,
        pub analyzed: u32,
        pub unanalyzed: u32,
        pub broken_links: u32,
        pub favorites: u32,
        pub collections: u32,
        pub newest_added_at: Option<String>,
        /// Records the reader had to skip because it could not parse them.
        pub unreadable_records: u32,
        /// Bookmarks waiting in the inbox for the app to import.
        pub pending_inbox: u32,
        /// Whether the MYNK window is open.
        pub app_running: bool,
    }

    #[derive(JsonSchema)]
    #[schemars(rename_all = "camelCase")]
    pub struct AddAnswer {
        pub queued: bool,
        /// "seconds" while the app is open, "next-launch" otherwise.
        pub appears_in: String,
        /// The URL as it was queued.
        pub url: String,
    }

    /// The `outputSchema` of a tool that answers with `T`.
    pub fn of<T: JsonSchema + std::any::Any>() -> Arc<JsonObject> {
        rmcp::handler::server::tool::schema_for_output::<T>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::model::{
        Collection, Library, ResourceAi, ResourceHealth, FALLBACK_CATEGORY_ID,
    };
    use crate::catalog::search::{MatchedBy, Query, SearchMode};
    use crate::catalog::views;

    fn resource() -> Resource {
        Resource {
            id: "r1".into(),
            url: "https://doc.rust-lang.org/book/".into(),
            url_key: "doc.rust-lang.org/book".into(),
            title: "Ownership in Rust".into(),
            description: "Borrowing and lifetimes".into(),
            category_id: "development".into(),
            tags: vec!["rust".into()],
            summary: vec!["One owner per value.".into()],
            folder_path: vec!["Bookmarks bar".into(), "Dev".into()],
            created_at: 1_757_289_600_000,
            updated_at: 1_757_293_200_000,
            last_opened_at: Some(1_757_376_000_000),
            is_favorite: true,
            ai: ResourceAi {
                status: "ok".into(),
                analyzed_at: Some(1_757_289_600_000),
                confidence: Some(0.9),
            },
            health: ResourceHealth {
                status: "alive".into(),
                checked_at: Some(1_757_296_800_000),
                http_status: Some(200),
            },
        }
    }

    #[test]
    fn a_record_carries_the_fields_an_agent_needs() {
        let value = record(&resource());
        assert_eq!(value["id"], "r1");
        assert_eq!(value["title"], "Ownership in Rust");
        assert_eq!(value["category"], "development");
        assert_eq!(value["tags"][0], "rust");
        assert_eq!(value["createdAt"], "2025-09-08T00:00:00Z");
        assert_eq!(value["lastOpenedAt"], "2025-09-09T00:00:00Z");
        assert_eq!(value["isFavorite"], true);

        let mut bare = resource();
        bare.category_id = String::new();
        bare.last_opened_at = None;
        let value = record(&bare);
        assert_eq!(value["category"], FALLBACK_CATEGORY_ID);
        assert_eq!(value["lastOpenedAt"], Value::Null, "never opened is null");
    }

    #[test]
    fn no_file_path_or_media_key_can_appear_in_an_answer() {
        let lib = Library {
            version: 3,
            saved_at: 0,
            resources: vec![resource()],
            collections: vec![Collection {
                id: "c1".into(),
                name: "Rust".into(),
                description: String::new(),
                keywords: vec!["rust".into()],
                pinned_ids: vec![],
            }],
            skipped: 0,
        };
        let outcome = crate::catalog::search::search_with(&lib, &Query::keyword("rust"), None);
        let summaries = views::collections(&lib);
        let members: Vec<&Resource> = lib.resources.iter().collect();
        let answers = vec![
            record(&resource()),
            record_detailed(&resource()),
            search(&outcome),
            list(&members, Some(VISIT_CAVEAT)),
            collections(&summaries),
            counted("tags", &views::tags(&lib)),
            stats(&views::stats(&lib)),
            collection_resource(&summaries[0], &members),
        ];
        for answer in answers {
            let text = serde_json::to_string(&answer).expect("serialize");
            for forbidden in [
                "media",
                "snapshotFile",
                "faviconFile",
                "faviconUrl",
                "folderPath",
                "Bookmarks bar",
                "path",
                "file",
                "dir",
            ] {
                assert!(
                    !text.contains(forbidden),
                    "{forbidden} appeared in an answer: {text}"
                );
            }
        }
    }

    #[test]
    fn a_detailed_record_adds_analysis_and_link_health() {
        let value = record_detailed(&resource());
        assert_eq!(value["analysis"]["status"], "ok");
        assert_eq!(value["analysis"]["needsAnalysis"], false);
        assert_eq!(value["link"]["status"], "alive");
        assert_eq!(value["link"]["httpStatus"], 200);
        assert_eq!(value["updatedAt"], "2025-09-08T01:00:00Z");
    }

    #[test]
    fn a_search_answer_reports_the_mode_that_ran() {
        let lib = Library {
            version: 3,
            saved_at: 0,
            resources: vec![resource()],
            collections: Vec::new(),
            skipped: 0,
        };
        let query = Query {
            mode: SearchMode::Hybrid,
            ..Query::keyword("rust")
        };
        let ranker = |_: &str, _: usize| {
            Err(crate::catalog::semantic::SemanticError::Unavailable(
                "no index".into(),
            ))
        };
        let outcome = crate::catalog::search::search_with(&lib, &query, Some(&ranker));
        let value = search(&outcome);
        assert_eq!(
            value["modeUsed"], "keyword",
            "asked for hybrid, got keyword"
        );
        assert!(value["note"]
            .as_str()
            .unwrap_or_default()
            .contains("no index"));
        assert_eq!(value["total"], 1);
        assert_eq!(value["hits"][0]["matchedBy"], "keyword");
        assert!(value["hits"][0]["score"].as_f64().unwrap_or_default() > 0.0);
    }

    fn library_of(count: usize) -> Library {
        let resources = (0..count)
            .map(|index| Resource {
                id: format!("r{index}"),
                url: format!("https://example.com/rust-{index}"),
                title: format!("Rust note {index}"),
                created_at: 1_000 + index as i64,
                ..Resource::default()
            })
            .collect();
        Library {
            version: 3,
            saved_at: 0,
            resources,
            collections: Vec::new(),
            skipped: 0,
        }
    }

    #[test]
    fn scores_are_relative_to_the_best_hit_and_every_hit_carries_its_rank() {
        let lib = library_of(20);
        let ranker = |_: &str, _: usize| Ok(Vec::new());
        let query = Query {
            mode: SearchMode::Hybrid,
            ..Query::keyword("rust")
        };
        let outcome = crate::catalog::search::search_with(&lib, &query, Some(&ranker));
        assert_eq!(outcome.hits.len(), 20);
        let value = search(&outcome);
        let hits = value["hits"].as_array().expect("hits");

        assert_eq!(hits[0]["score"], 1.0, "the best hit is the unit");
        let mut previous = f64::INFINITY;
        for (index, one) in hits.iter().enumerate() {
            assert_eq!(one["rank"], index + 1, "ranks are 1-based and in order");
            let score = one["score"].as_f64().expect("score");
            assert!((0.0..=1.0).contains(&score), "{score}");
            assert!(
                score <= previous,
                "scores never rise: {score} after {previous}"
            );
            previous = score;
            assert_eq!(score, (score * 10_000.0).round() / 10_000.0, "{score}");
            assert!(
                !one["score"].to_string().contains("999999"),
                "{}",
                one["score"]
            );
        }
        let distinct: std::collections::BTreeSet<String> =
            hits.iter().map(|one| one["score"].to_string()).collect();
        assert!(distinct.len() > 3, "{distinct:?}");
    }

    #[test]
    fn a_single_hit_is_the_best_hit() {
        let lib = library_of(1);
        let outcome = crate::catalog::search::search_with(&lib, &Query::keyword("rust"), None);
        let first = &outcome.hits[0];
        assert_eq!(first.matched_by, MatchedBy::Keyword);
        let value = hit(first, 1, first.score);
        assert_eq!(value["score"], 1.0);
        assert_eq!(value["rank"], 1);
        assert_eq!(value["matchedBy"], "keyword");

        let outcome = crate::catalog::search::search_with(&lib, &Query::keyword(""), None);
        let value = search(&outcome);
        assert_eq!(value["hits"][0]["score"], 0.0);
        assert_eq!(value["hits"][0]["rank"], 1);
    }

    #[test]
    fn every_declared_output_schema_matches_the_answer_it_describes() {
        use std::collections::BTreeSet;

        fn declared<T: rmcp::schemars::JsonSchema + std::any::Any>() -> BTreeSet<String> {
            schema::of::<T>()["properties"]
                .as_object()
                .expect("an object schema")
                .keys()
                .cloned()
                .collect()
        }
        fn answered(value: &Value) -> BTreeSet<String> {
            value
                .as_object()
                .expect("an object answer")
                .keys()
                .cloned()
                .collect()
        }

        let lib = Library {
            version: 3,
            saved_at: 0,
            resources: vec![resource()],
            collections: vec![Collection {
                id: "c1".into(),
                name: "Rust".into(),
                description: "Rust reading".into(),
                keywords: vec!["rust".into()],
                pinned_ids: vec![],
            }],
            skipped: 0,
        };
        let outcome = crate::catalog::search::search_with(&lib, &Query::keyword("rust"), None);
        let summaries = views::collections(&lib);
        let members: Vec<&Resource> = lib.resources.iter().collect();

        let one = resource();
        assert_eq!(
            answered(&record(&one)),
            declared::<schema::BookmarkRecord>()
        );
        assert_eq!(
            answered(&record_detailed(&one)),
            declared::<schema::BookmarkDetail>()
        );
        assert_eq!(
            answered(&record_detailed(&one)["analysis"]),
            declared::<schema::Analysis>()
        );
        assert_eq!(
            answered(&record_detailed(&one)["link"]),
            declared::<schema::LinkHealth>()
        );

        let search_answer = search(&outcome);
        assert_eq!(answered(&search_answer), declared::<schema::SearchAnswer>());
        assert_eq!(
            answered(&search_answer["hits"][0]),
            declared::<schema::SearchHit>()
        );
        assert_eq!(
            answered(&list(&members, Some(VISIT_CAVEAT))),
            declared::<schema::ListAnswer>()
        );
        let collections_answer = collections(&summaries);
        assert_eq!(
            answered(&collections_answer),
            declared::<schema::CollectionsAnswer>()
        );
        assert_eq!(
            answered(&collections_answer["collections"][0]),
            declared::<schema::CollectionEntry>()
        );
        let tags_answer = counted("tags", &views::tags(&lib));
        assert_eq!(answered(&tags_answer), declared::<schema::TagsAnswer>());
        assert_eq!(
            answered(&tags_answer["tags"][0]),
            declared::<schema::CountEntry>()
        );
        assert_eq!(
            answered(&counted("categories", &views::stats(&lib).by_category)),
            declared::<schema::CategoriesAnswer>()
        );

        let mut stats_answer = stats(&views::stats(&lib));
        if let Value::Object(map) = &mut stats_answer {
            map.insert("pendingInbox".into(), json!(0));
            map.insert("appRunning".into(), json!(false));
        }
        assert_eq!(answered(&stats_answer), declared::<schema::StatsAnswer>());
        assert_eq!(
            answered(&json!({
                "queued": true,
                "appearsIn": "next-launch",
                "url": "https://example.com/x",
            })),
            declared::<schema::AddAnswer>()
        );
    }

    #[test]
    fn counts_list_as_name_count_pairs_and_empty_stats_have_no_newest_date() {
        let counts = vec![("rust".to_string(), 3), ("design".to_string(), 1)];
        let value = counted("tags", &counts);
        assert_eq!(value["tags"][0]["name"], "rust");
        assert_eq!(value["tags"][0]["count"], 3);
        assert_eq!(value["total"], 2);

        let empty = stats(&Stats::default());
        assert_eq!(empty["total"], 0);
        assert_eq!(empty["newestAddedAt"], Value::Null);
    }

    #[test]
    fn a_list_answer_can_carry_the_visit_caveat() {
        let one = resource();
        let value = list(&[&one], Some(VISIT_CAVEAT));
        assert_eq!(value["total"], 1);
        assert_eq!(value["note"], VISIT_CAVEAT);
        assert_eq!(list(&[], None)["note"], Value::Null);
    }
}
