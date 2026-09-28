//! Read-only, tolerant view of the on-disk library (`library.json`, schema 3).
//! Unknown fields are ignored, missing ones default, and an unreadable record is skipped without
//! failing the load; an unknown schema version is a hard error.

use std::path::Path;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::error::{AppError, AppResult};
use crate::library;

/// The only schema this build understands; must match `PERSIST_VERSION` in src/store/migrate.ts.
pub const SCHEMA_VERSION: i64 = 3;

/// The category of a record that has none, matching the renderer's fallback.
pub const FALLBACK_CATEGORY_ID: &str = "other";

/// `ai.status` values meaning no usable analysis exists yet.
const UNANALYZED_STATUSES: [&str; 3] = ["none", "failed", "pending"];

/// The renderer stores any finite number, so a fraction is truncated instead of failing the record.
fn truncated(number: &serde_json::Number) -> Option<i64> {
    if let Some(whole) = number.as_i64() {
        return Some(whole);
    }
    let value = number.as_f64()?;
    let in_range = value.is_finite() && value >= i64::MIN as f64 && value < i64::MAX as f64;
    in_range.then(|| value.trunc() as i64)
}

fn whole<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let number = serde_json::Number::deserialize(deserializer)?;
    truncated(&number).ok_or_else(|| D::Error::custom(format!("{number} is out of range")))
}

fn whole_opt<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    match Option::<serde_json::Number>::deserialize(deserializer)? {
        None => Ok(None),
        Some(number) => truncated(&number)
            .map(Some)
            .ok_or_else(|| D::Error::custom(format!("{number} is out of range"))),
    }
}

fn status_code_opt<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u16>, D::Error> {
    match whole_opt(deserializer)? {
        None => Ok(None),
        Some(code) => u16::try_from(code)
            .map(Some)
            .map_err(|_| D::Error::custom(format!("{code} is not an HTTP status"))),
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceAi {
    #[serde(default = "ai_status_default")]
    pub status: String,
    #[serde(default, deserialize_with = "whole_opt")]
    pub analyzed_at: Option<i64>,
    #[serde(default)]
    pub confidence: Option<f64>,
}

fn ai_status_default() -> String {
    "none".to_string()
}

impl Default for ResourceAi {
    fn default() -> Self {
        Self {
            status: ai_status_default(),
            analyzed_at: None,
            confidence: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceHealth {
    #[serde(default = "health_status_default")]
    pub status: String,
    #[serde(default, deserialize_with = "whole_opt")]
    pub checked_at: Option<i64>,
    #[serde(default, deserialize_with = "status_code_opt")]
    pub http_status: Option<u16>,
}

fn health_status_default() -> String {
    "unknown".to_string()
}

impl Default for ResourceHealth {
    fn default() -> Self {
        Self {
            status: health_status_default(),
            checked_at: None,
            http_status: None,
        }
    }
}

/// One bookmark; mirrors the renderer's `Resource` minus file-path and UI-only fields.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub url_key: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category_id: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub summary: Vec<String>,
    #[serde(default)]
    pub folder_path: Vec<String>,
    #[serde(default, deserialize_with = "whole")]
    pub created_at: i64,
    #[serde(default, deserialize_with = "whole")]
    pub updated_at: i64,
    /// When the record was last opened from inside MYNK; browser history is not read.
    #[serde(default, deserialize_with = "whole_opt")]
    pub last_opened_at: Option<i64>,
    #[serde(default)]
    pub is_favorite: bool,
    #[serde(default)]
    pub ai: ResourceAi,
    #[serde(default)]
    pub health: ResourceHealth,
}

impl Resource {
    /// The category to count, show and filter by: a blank id reads as [`FALLBACK_CATEGORY_ID`].
    pub fn category(&self) -> &str {
        if self.category_id.trim().is_empty() {
            FALLBACK_CATEGORY_ID
        } else {
            &self.category_id
        }
    }

    /// True while the record has no usable AI analysis.
    pub fn is_unanalyzed(&self) -> bool {
        UNANALYZED_STATUSES.contains(&self.ai.status.as_str())
    }

    /// True when the last health scan found the link dead.
    pub fn is_broken(&self) -> bool {
        self.health.status == "dead"
    }
}

/// A manual or smart collection, minus presentation-only fields.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub pinned_ids: Vec<String>,
}

/// The parsed library; `chats`, `settings` and `healthMeta` are not read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Library {
    pub version: i64,
    pub saved_at: i64,
    pub resources: Vec<Resource>,
    pub collections: Vec<Collection>,
    /// Records (bookmarks and collections) that could not be read and were left out.
    pub skipped: usize,
}

impl Library {
    /// An empty library at the current schema version.
    pub fn empty() -> Self {
        Self {
            version: SCHEMA_VERSION,
            ..Self::default()
        }
    }

    pub fn collection(&self, id: &str) -> Option<&Collection> {
        self.collections.iter().find(|c| c.id == id)
    }
}

/// The raw envelope, checked before any record is parsed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLibrary {
    #[serde(default)]
    version: i64,
    #[serde(default, deserialize_with = "whole")]
    saved_at: i64,
    #[serde(default)]
    resources: Vec<serde_json::Value>,
    #[serde(default)]
    collections: Vec<serde_json::Value>,
}

/// A record without an id or an http(s) URL cannot be addressed or opened.
fn usable(resource: &Resource) -> bool {
    !resource.id.is_empty()
        && (resource.url.starts_with("http://") || resource.url.starts_with("https://"))
}

/// Parses library JSON; fails on an unknown schema, skips unreadable records.
pub fn parse(json: &str) -> AppResult<Library> {
    let raw: RawLibrary = serde_json::from_str(json)
        .map_err(|error| AppError::Parse(format!("The library file could not be read: {error}")))?;
    if raw.version != SCHEMA_VERSION {
        return Err(AppError::storage(format!(
            "MYNK library schema {} is not supported by this version (it reads schema {}).",
            raw.version, SCHEMA_VERSION
        )));
    }

    let mut skipped = 0usize;
    let mut resources = Vec::with_capacity(raw.resources.len());
    for value in raw.resources {
        match serde_json::from_value::<Resource>(value) {
            Ok(resource) if usable(&resource) => resources.push(resource),
            _ => skipped += 1,
        }
    }
    let mut collections = Vec::with_capacity(raw.collections.len());
    for value in raw.collections {
        match serde_json::from_value::<Collection>(value) {
            Ok(collection) if !collection.id.is_empty() => collections.push(collection),
            _ => skipped += 1,
        }
    }
    if skipped > 0 {
        log::warn!("catalog: skipped {skipped} unreadable record(s) in library.json");
    }

    Ok(Library {
        version: raw.version,
        saved_at: raw.saved_at,
        resources,
        collections,
        skipped,
    })
}

/// Reads and parses `<data_dir>/library.json`, or [`Library::empty`] if there is none.
pub fn load(data_dir: &Path) -> AppResult<Library> {
    let loaded = library::load(data_dir)?;
    match loaded.json {
        Some(json) => parse(&json),
        None => Ok(Library::empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const V3_FIXTURE: &str = r##"{
      "version": 3,
      "savedAt": 1757700000000,
      "resources": [
        {
          "id": "r1",
          "url": "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
          "urlKey": "doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
          "title": "Ownership in Rust",
          "titleEditedByUser": true,
          "description": "How ownership, borrowing and lifetimes work.",
          "categoryId": "development",
          "tags": ["rust", "ownership"],
          "summary": ["Every value has a single owner."],
          "folderPath": ["Bookmarks bar", "Dev"],
          "createdAt": 1757000000000,
          "updatedAt": 1757100000000,
          "lastOpenedAt": null,
          "isFavorite": true,
          "ai": { "status": "ok", "analyzedAt": 1757100000000, "confidence": 0.9 },
          "media": { "snapshotFile": "secret.png", "faviconUrl": "https://x.test/f.ico" },
          "health": { "status": "alive", "checkedAt": 1757200000000, "httpStatus": 200 },
          "somethingTheRendererAddedLater": { "nested": true }
        },
        { "not": "a resource" },
        {
          "id": "r2",
          "url": "https://tr.example.com/yazilim",
          "title": "Yazılım Geliştirme"
        },
        { "id": "", "url": "https://empty-id.example" },
        { "id": "r3", "url": "ftp://files.example/x" }
      ],
      "collections": [
        {
          "id": "c1",
          "name": "Rust",
          "description": "Rust reading",
          "keywords": ["rust"],
          "pinnedIds": ["r2"],
          "color": "#f00",
          "createdAt": 1,
          "updatedAt": 2
        }
      ],
      "chats": { "global": [{ "id": "m1", "role": "user", "content": "hi" }] },
      "settings": { "lang": "tr" },
      "healthMeta": { "hasRun": true, "lastScanAt": 1 }
    }"##;

    #[test]
    fn reads_a_v3_library_and_skips_broken_records() {
        let lib = parse(V3_FIXTURE).expect("parse");
        assert_eq!(lib.version, 3);
        assert_eq!(lib.saved_at, 1_757_700_000_000);
        assert_eq!(lib.resources.len(), 2, "three records are unusable");
        assert_eq!(lib.skipped, 3);
        assert_eq!(lib.collections.len(), 1);

        let first = &lib.resources[0];
        assert_eq!(first.id, "r1");
        assert_eq!(first.title, "Ownership in Rust");
        assert_eq!(first.category_id, "development");
        assert_eq!(first.tags, vec!["rust", "ownership"]);
        assert_eq!(first.folder_path, vec!["Bookmarks bar", "Dev"]);
        assert!(first.is_favorite);
        assert_eq!(first.last_opened_at, None);
        assert_eq!(first.ai.status, "ok");
        assert_eq!(first.health.http_status, Some(200));
        assert!(!first.is_unanalyzed());
        assert!(!first.is_broken());

        let second = &lib.resources[1];
        assert_eq!(second.category_id, "");
        assert!(second.tags.is_empty());
        assert_eq!(second.ai.status, "none");
        assert_eq!(second.health.status, "unknown");
        assert!(second.is_unanalyzed());

        let collection = lib.collection("c1").expect("collection");
        assert_eq!(collection.name, "Rust");
        assert_eq!(collection.keywords, vec!["rust"]);
        assert_eq!(collection.pinned_ids, vec!["r2"]);
    }

    #[test]
    fn fractional_numbers_are_truncated_and_non_numbers_still_skip_the_record() {
        let json = r#"{
          "version": 3,
          "savedAt": 1757700000000.5,
          "resources": [
            {
              "id": "r1",
              "url": "https://example.com/a",
              "createdAt": 1757000000000.75,
              "lastOpenedAt": 1757000000001.2,
              "health": { "status": "alive", "checkedAt": 5.9, "httpStatus": 200.0 }
            },
            { "id": "r2", "url": "https://example.com/b", "health": { "httpStatus": 404.6 } },
            { "id": "r3", "url": "https://example.com/c", "createdAt": "yesterday" },
            { "id": "r4", "url": "https://example.com/d", "health": { "httpStatus": 70000 } }
          ],
          "collections": []
        }"#;
        let lib = parse(json).expect("parse");
        assert_eq!(lib.saved_at, 1_757_700_000_000);
        let ids: Vec<&str> = lib.resources.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["r1", "r2"]);
        assert_eq!(
            lib.skipped, 2,
            "a string and an impossible status are still rejected"
        );
        let first = &lib.resources[0];
        assert_eq!(first.created_at, 1_757_000_000_000);
        assert_eq!(first.last_opened_at, Some(1_757_000_000_001));
        assert_eq!(first.health.checked_at, Some(5));
        assert_eq!(first.health.http_status, Some(200));
        assert_eq!(lib.resources[1].health.http_status, Some(404));
    }

    #[test]
    fn media_file_names_and_favicons_are_not_parsed() {
        let lib = parse(V3_FIXTURE).expect("parse");
        let json = serde_json::to_string(&lib.resources).expect("serialize");
        assert!(!json.contains("secret.png"), "{json}");
        assert!(!json.contains("media"), "{json}");
        assert!(!json.contains("faviconUrl"), "{json}");
    }

    #[test]
    fn an_unknown_schema_version_is_a_hard_error() {
        let error = parse(r#"{"version":4,"resources":[]}"#).expect_err("schema 4");
        assert_eq!(error.kind(), "storage");
        assert!(
            error
                .to_string()
                .starts_with("MYNK library schema 4 is not supported"),
            "{error}"
        );
        let error = parse(r#"{"resources":[]}"#).expect_err("no version");
        assert!(error.to_string().contains("schema 0"), "{error}");
    }

    #[test]
    fn invalid_json_is_a_parse_error() {
        let error = parse("{broken").expect_err("not json");
        assert_eq!(error.kind(), "parse");
    }

    #[test]
    fn a_missing_library_file_loads_as_empty() {
        let dir = tempfile::tempdir().expect("temp dir");
        let lib = load(dir.path()).expect("load");
        assert_eq!(lib, Library::empty());
        assert_eq!(lib.version, SCHEMA_VERSION);
        assert!(lib.resources.is_empty());
    }

    #[test]
    fn loads_from_the_data_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        library::save(dir.path(), V3_FIXTURE).expect("save");
        let lib = load(dir.path()).expect("load");
        assert_eq!(lib.resources.len(), 2);
    }
}
