//! Ready-made views over a loaded [`Library`] for questions that are not a free-text search:
//! recent, unopened, stats, tags, collections, get. Pure reads returning borrowed records.

use std::collections::hash_map::Entry;
use std::collections::HashMap;

use super::model::{Collection, Library, Resource};
use super::search::{host_of, search_fields, Membership, SearchFields};
use super::text::normalize_search_text;

/// Library-wide counters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stats {
    pub total: usize,
    /// `(category id, count)`, most common first, then alphabetically for a stable answer.
    pub by_category: Vec<(String, usize)>,
    pub analyzed: usize,
    pub unanalyzed: usize,
    /// Records the last health scan found dead.
    pub broken: usize,
    pub favorites: usize,
    /// `createdAt` of the most recently added record.
    pub newest_created_at: Option<i64>,
    pub collections: usize,
    /// Records skipped while loading; non-zero means the answer is incomplete.
    pub skipped: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CollectionSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub member_count: usize,
}

/// Sorts `(name, count)` pairs by count then name, so repeated calls answer identically.
fn sort_by_count(mut counts: Vec<(String, usize)>) -> Vec<(String, usize)> {
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    counts
}

fn bump(counts: &mut Vec<(String, usize)>, key: &str) {
    match counts.iter_mut().find(|(existing, _)| existing == key) {
        Some((_, count)) => *count += 1,
        None => counts.push((key.to_string(), 1)),
    }
}

/// Records created at or after `since_ms` (all of them when it is `None`), newest first.
/// `unopened_only` keeps the ones never opened from inside MYNK.
pub fn recent(
    lib: &Library,
    since_ms: Option<i64>,
    limit: usize,
    unopened_only: bool,
) -> Vec<&Resource> {
    let mut found: Vec<&Resource> = lib
        .resources
        .iter()
        .filter(|resource| since_ms.is_none_or(|since| resource.created_at >= since))
        .filter(|resource| !unopened_only || resource.last_opened_at.is_none())
        .collect();
    found.sort_by_key(|resource| std::cmp::Reverse(resource.created_at));
    found.truncate(limit);
    found
}

/// Records never opened from inside MYNK, newest first; says nothing about browser visits,
/// only what was opened through the app.
pub fn unopened(lib: &Library, since_ms: Option<i64>, limit: usize) -> Vec<&Resource> {
    recent(lib, since_ms, limit, true)
}

pub fn stats(lib: &Library) -> Stats {
    let mut stats = Stats {
        total: lib.resources.len(),
        collections: lib.collections.len(),
        skipped: lib.skipped,
        ..Stats::default()
    };
    let mut by_category: Vec<(String, usize)> = Vec::new();
    for resource in &lib.resources {
        bump(&mut by_category, resource.category());
        if resource.is_unanalyzed() {
            stats.unanalyzed += 1;
        } else {
            stats.analyzed += 1;
        }
        if resource.is_broken() {
            stats.broken += 1;
        }
        if resource.is_favorite {
            stats.favorites += 1;
        }
        stats.newest_created_at = Some(match stats.newest_created_at {
            Some(newest) => newest.max(resource.created_at),
            None => resource.created_at,
        });
    }
    stats.by_category = sort_by_count(by_category);
    stats
}

/// Every tag with how many records carry it, most used first; tags fold together under the same
/// normalization as search, and the first spelling seen is reported.
pub fn tags(lib: &Library) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for resource in &lib.resources {
        let mut seen: Vec<String> = Vec::new();
        for tag in &resource.tags {
            let key = normalize_search_text(tag.trim());
            if key.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            match at.entry(key) {
                Entry::Occupied(slot) => {
                    if let Some((_, count)) = counts.get_mut(*slot.get()) {
                        *count += 1;
                    }
                }
                Entry::Vacant(slot) => {
                    slot.insert(counts.len());
                    counts.push((tag.trim().to_string(), 1));
                }
            }
        }
    }
    sort_by_count(counts)
}

/// Every collection with how many records belong to it (pinned ids plus a keyword hit).
/// Normalizes search columns on the spot; a caller holding them uses [`collections_with_fields`].
pub fn collections(lib: &Library) -> Vec<CollectionSummary> {
    let fields: Vec<SearchFields> = lib.resources.iter().map(search_fields).collect();
    collections_with_fields(lib, &fields)
}

/// [`collections`] over search columns the caller already has, one per record in library order.
pub fn collections_with_fields(lib: &Library, fields: &[SearchFields]) -> Vec<CollectionSummary> {
    lib.collections
        .iter()
        .map(|collection| CollectionSummary {
            id: collection.id.clone(),
            name: collection.name.clone(),
            description: collection.description.clone(),
            member_count: member_count(lib, collection, fields),
        })
        .collect()
}

fn member_count(lib: &Library, collection: &Collection, fields: &[SearchFields]) -> usize {
    let membership = Membership::of(collection);
    lib.resources
        .iter()
        .enumerate()
        .filter(|(index, resource)| {
            fields
                .get(*index)
                .is_some_and(|fields| membership.contains(resource, fields))
        })
        .count()
}

/// Loose comparison key for a URL: scheme, `www.`, a trailing slash and the fragment dropped.
/// Not the renderer's `canonicalUrlKey`, which also strips query parameters; both sides use this.
fn loose_url_key(value: &str) -> String {
    let trimmed = value.trim();
    let host = host_of(trimmed);
    if host.is_empty() {
        return trimmed.to_lowercase();
    }
    let rest = trimmed
        .split_once("://")
        .map_or(trimmed, |(_, rest)| rest)
        .split('#')
        .next()
        .unwrap_or_default();
    let path = rest.split_once('/').map_or("", |(_, path)| path);
    let path = path.trim_end_matches('/');
    format!("{host}/{}", path.to_lowercase())
}

/// One record by id or by URL. Ids are tried first; a URL matches regardless of scheme, a
/// leading `www.` or a trailing slash.
pub fn get<'a>(lib: &'a Library, id_or_url: &str) -> Option<&'a Resource> {
    let needle = id_or_url.trim();
    if needle.is_empty() {
        return None;
    }
    if let Some(found) = lib.resources.iter().find(|r| r.id == needle) {
        return Some(found);
    }
    if let Some(found) = lib.resources.iter().find(|r| r.url == needle) {
        return Some(found);
    }
    let key = loose_url_key(needle);
    lib.resources
        .iter()
        .find(|resource| loose_url_key(&resource.url) == key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::model::{ResourceAi, ResourceHealth};

    fn resource(id: &str, url: &str, title: &str, created_at: i64) -> Resource {
        Resource {
            id: id.to_string(),
            url: url.to_string(),
            title: title.to_string(),
            created_at,
            ..Resource::default()
        }
    }

    fn fixture() -> Library {
        let mut a = resource("r1", "https://a.example.com/one", "Rust ownership", 3_000);
        a.tags = vec!["Rust".into(), "memory".into()];
        a.category_id = "development".into();
        a.ai = ResourceAi {
            status: "ok".into(),
            analyzed_at: Some(1),
            confidence: Some(0.8),
        };
        a.is_favorite = true;
        a.last_opened_at = Some(5_000);

        let mut b = resource("r2", "https://b.example.com/two/", "Yazılım", 2_000);
        b.tags = vec!["rust".into(), "yazılım".into()];
        b.category_id = "development".into();
        b.health = ResourceHealth {
            status: "dead".into(),
            checked_at: Some(2),
            http_status: Some(404),
        };

        let mut c = resource("r3", "https://c.example.com/three", "Design notes", 1_000);
        c.category_id = "design".into();
        c.ai = ResourceAi {
            status: "failed".into(),
            analyzed_at: None,
            confidence: None,
        };

        Library {
            version: 3,
            saved_at: 0,
            resources: vec![a, b, c],
            collections: vec![
                Collection {
                    id: "c1".into(),
                    name: "Rust".into(),
                    description: "Rust reading".into(),
                    keywords: vec!["rust".into()],
                    pinned_ids: vec![],
                },
                Collection {
                    id: "c2".into(),
                    name: "Pinned".into(),
                    description: String::new(),
                    keywords: vec![],
                    pinned_ids: vec!["r3".into(), "missing".into()],
                },
            ],
            skipped: 1,
        }
    }

    fn ids(found: &[&Resource]) -> Vec<String> {
        found.iter().map(|r| r.id.clone()).collect()
    }

    #[test]
    fn recent_respects_the_window_the_limit_and_the_order() {
        let lib = fixture();
        assert_eq!(ids(&recent(&lib, None, 10, false)), vec!["r1", "r2", "r3"]);
        assert_eq!(
            ids(&recent(&lib, Some(2_000), 10, false)),
            vec!["r1", "r2"],
            "the lower bound is inclusive"
        );
        assert_eq!(ids(&recent(&lib, None, 2, false)), vec!["r1", "r2"]);
        assert!(recent(&lib, None, 0, false).is_empty());
        assert!(recent(&lib, Some(9_999), 10, false).is_empty());
    }

    #[test]
    fn unopened_skips_records_opened_from_inside_mynk() {
        let lib = fixture();
        assert_eq!(ids(&unopened(&lib, None, 10)), vec!["r2", "r3"]);
        assert_eq!(ids(&unopened(&lib, Some(2_000), 10)), vec!["r2"]);
        assert_eq!(
            ids(&recent(&lib, None, 10, true)),
            ids(&unopened(&lib, None, 10))
        );
    }

    #[test]
    fn stats_count_every_dimension() {
        let lib = fixture();
        let counted = stats(&lib);
        assert_eq!(counted.total, 3);
        assert_eq!(
            counted.by_category,
            vec![("development".to_string(), 2), ("design".to_string(), 1)]
        );
        assert_eq!(counted.analyzed, 1, "only r1 has a usable analysis");
        assert_eq!(
            counted.unanalyzed, 2,
            "`none` and `failed` both need analysis"
        );
        assert_eq!(counted.broken, 1);
        assert_eq!(counted.favorites, 1);
        assert_eq!(counted.newest_created_at, Some(3_000));
        assert_eq!(counted.collections, 2);
        assert_eq!(counted.skipped, 1);

        let empty = stats(&Library::empty());
        assert_eq!(empty.total, 0);
        assert_eq!(empty.newest_created_at, None);
        assert!(empty.by_category.is_empty());
    }

    #[test]
    fn a_missing_category_counts_as_other() {
        let mut lib = Library::empty();
        lib.resources
            .push(resource("r1", "https://x.example", "X", 1));
        let mut blank = resource("r2", "https://y.example", "Y", 2);
        blank.category_id = "  ".to_string();
        lib.resources.push(blank);
        assert_eq!(stats(&lib).by_category, vec![("other".to_string(), 2)]);
    }

    #[test]
    fn tags_are_counted_case_insensitively() {
        let lib = fixture();
        assert_eq!(
            tags(&lib),
            vec![
                ("Rust".to_string(), 2),
                ("memory".to_string(), 1),
                ("yazılım".to_string(), 1),
            ],
            "the first spelling seen wins, counts are folded"
        );
        assert!(tags(&Library::empty()).is_empty());
    }

    #[test]
    fn a_repeated_tag_counts_once_per_record() {
        let mut lib = Library::empty();
        let mut only = resource("r1", "https://x.example", "X", 1);
        only.tags = vec!["AI".into(), "ai".into(), "  ".into()];
        lib.resources.push(only);
        assert_eq!(tags(&lib), vec![("AI".to_string(), 1)]);
    }

    #[test]
    fn collection_membership_is_pinned_ids_plus_keywords() {
        let lib = fixture();
        let summaries = collections(&lib);
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].id, "c1");
        assert_eq!(summaries[0].name, "Rust");
        assert_eq!(summaries[0].description, "Rust reading");
        assert_eq!(
            summaries[0].member_count, 2,
            "r1 by title, r2 by tag; r3 mentions neither"
        );
        assert_eq!(
            summaries[1].member_count, 1,
            "a pinned id that no longer exists is not a member"
        );
        assert!(collections(&Library::empty()).is_empty());
    }

    #[test]
    fn get_finds_a_record_by_id_or_any_spelling_of_its_url() {
        let lib = fixture();
        assert_eq!(get(&lib, "r2").map(|r| r.id.as_str()), Some("r2"));
        assert_eq!(get(&lib, "  r2  ").map(|r| r.id.as_str()), Some("r2"));
        assert_eq!(
            get(&lib, "https://b.example.com/two/").map(|r| r.id.as_str()),
            Some("r2")
        );
        for spelling in [
            "http://b.example.com/two",
            "https://www.b.example.com/two/",
            "b.example.com/two",
            "https://b.example.com/two#section",
        ] {
            assert_eq!(
                get(&lib, spelling).map(|r| r.id.as_str()),
                Some("r2"),
                "{spelling}"
            );
        }
        assert!(get(&lib, "https://unknown.example/").is_none());
        assert!(get(&lib, "").is_none());
        assert!(get(&lib, "   ").is_none());
    }
}
