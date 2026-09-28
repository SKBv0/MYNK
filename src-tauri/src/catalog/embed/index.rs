//! The embedding index: `<cache dir>/semantic.sqlite`, one row per bookmark keyed by
//! `resource_id`; the stored `content_hash` (text + model) says which records still need work.
//! WAL mode, because a `mynk-mcp` server and `mynk-mcp index` may have it open at once.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::catalog::model::Resource;
use crate::catalog::semantic::SemanticError;
use crate::paths::semantic_index_path;
use crate::util::{cap_chars, sha256_hex, sqlite_detail};

/// How long a writer waits for the other process's transaction before giving up.
const BUSY_TIMEOUT_MS: u32 = 5_000;
/// Meta key holding the model every stored vector was produced with.
const MODEL_KEY: &str = "model";
/// Guards against a corrupt or hostile `dim` turning into a huge allocation. A vector longer than
/// this can never be decoded, so the embedding client refuses one before it is stored.
pub const MAX_DIM: usize = 16_384;

/// One record's embedding, as stored.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub resource_id: String,
    pub url_key: String,
    pub content_hash: String,
    pub model: String,
    pub vector: Vec<f32>,
    pub updated_at: i64,
}

/// Turns a SQLite failure into an index error; the full error goes to the log only.
fn db_error(context: &str, error: &rusqlite::Error) -> SemanticError {
    log::warn!("semantic index: {context}: {error}");
    SemanticError::Io(format!("{context} ({})", sqlite_detail(error)))
}

/// The text a record is embedded from: title, tags, category, description, summary.
/// Deterministic: this is hashed, so any change here re-embeds the whole library.
pub fn document_text(resource: &Resource) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(5);
    let title = resource.title.trim();
    if !title.is_empty() {
        parts.push(title.to_string());
    }
    let tags: Vec<&str> = resource
        .tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .collect();
    if !tags.is_empty() {
        parts.push(format!("tags: {}", tags.join(", ")));
    }
    let category = resource.category_id.trim();
    if !category.is_empty() {
        parts.push(format!("category: {category}"));
    }
    let description = resource.description.trim();
    if !description.is_empty() {
        parts.push(format!("description: {description}"));
    }
    let summary: Vec<&str> = resource
        .summary
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect();
    if !summary.is_empty() {
        parts.push(format!("summary: {}", summary.join(" ")));
    }
    let text = parts.join("\n");
    // A record with no text at all would otherwise be sent to the model as an empty string.
    let text = if text.trim().is_empty() {
        resource.url.trim().to_string()
    } else {
        text
    };
    cap_chars(&text, super::ollama::MAX_INPUT_CHARS).to_string()
}

/// `sha256(model + "\n" + text)`, hex. Covers the model so switching models invalidates rows
/// even if the text is untouched.
pub fn content_hash(model: &str, text: &str) -> String {
    sha256_hex(&[model.as_bytes(), b"\n", text.as_bytes()], 32)
}

/// f32 little endian, one after the other. A fixed byte order, so a cache file copied between
/// machines reads the same way it was written.
fn encode_vector(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn decode_vector(bytes: &[u8], dim: usize) -> Option<Vec<f32>> {
    if dim == 0 || dim > MAX_DIM || bytes.len() != dim * 4 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| {
                let mut buffer = [0u8; 4];
                buffer.copy_from_slice(chunk);
                f32::from_le_bytes(buffer)
            })
            .collect(),
    )
}

pub struct Index {
    conn: Connection,
}

impl Index {
    /// Opens (creating if needed) the index inside `cache_dir`.
    pub fn open(cache_dir: &Path) -> Result<Self, SemanticError> {
        std::fs::create_dir_all(cache_dir).map_err(|error| {
            log::warn!("semantic index: could not create the cache directory: {error}");
            SemanticError::Io("the cache directory could not be created".to_string())
        })?;
        let path = semantic_index_path(cache_dir);
        let conn = Connection::open(&path)
            .map_err(|error| db_error("the semantic index could not be opened", &error))?;
        Self::prepare(&conn)?;
        Ok(Self { conn })
    }

    /// In-memory index, for tests that only exercise the SQL.
    #[cfg(test)]
    fn memory() -> Result<Self, SemanticError> {
        let conn = Connection::open_in_memory().expect("in-memory database");
        Self::prepare(&conn)?;
        Ok(Self { conn })
    }

    fn prepare(conn: &Connection) -> Result<(), SemanticError> {
        conn.busy_timeout(std::time::Duration::from_millis(u64::from(BUSY_TIMEOUT_MS)))
            .map_err(|error| db_error("the semantic index could not be configured", &error))?;
        // WAL lets a running server search while `mynk-mcp index` writes.
        let _: Option<String> = conn
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .optional()
            .map_err(|error| db_error("the semantic index could not be configured", &error))?;
        conn.execute_batch(
            "PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS embeddings (
                 resource_id  TEXT PRIMARY KEY,
                 url_key      TEXT NOT NULL DEFAULT '',
                 content_hash TEXT NOT NULL,
                 model        TEXT NOT NULL,
                 dim          INTEGER NOT NULL,
                 vector       BLOB NOT NULL,
                 updated_at   INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS meta (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )
        .map_err(|error| db_error("the semantic index could not be created", &error))
    }

    /// The model every stored vector was produced with, if the index has been built once.
    pub fn model(&self) -> Result<Option<String>, SemanticError> {
        self.conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [MODEL_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| db_error("the semantic index could not be read", &error))
    }

    pub fn set_model(&self, model: &str) -> Result<(), SemanticError> {
        self.conn
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![MODEL_KEY, model],
            )
            .map(|_| ())
            .map_err(|error| db_error("the semantic index could not be updated", &error))
    }

    pub fn count(&self) -> Result<usize, SemanticError> {
        self.conn
            .query_row("SELECT COUNT(*) FROM embeddings", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|count| usize::try_from(count).unwrap_or(0))
            .map_err(|error| db_error("the semantic index could not be read", &error))
    }

    /// When the newest vector was written (epoch ms), or `None` for an empty index.
    pub fn updated_at(&self) -> Result<Option<i64>, SemanticError> {
        self.conn
            .query_row("SELECT MAX(updated_at) FROM embeddings", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .map_err(|error| db_error("the semantic index could not be read", &error))
    }

    /// `resource_id -> content_hash` for everything stored, so the build can tell in one query
    /// which records still need work.
    pub fn hashes(&self) -> Result<HashMap<String, String>, SemanticError> {
        let mut statement = self
            .conn
            .prepare("SELECT resource_id, content_hash FROM embeddings")
            .map_err(|error| db_error("the semantic index could not be read", &error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| db_error("the semantic index could not be read", &error))?;
        let mut hashes = HashMap::new();
        for row in rows {
            let (id, hash) =
                row.map_err(|error| db_error("the semantic index could not be read", &error))?;
            hashes.insert(id, hash);
        }
        Ok(hashes)
    }

    /// Every vector stored for `model`, id first. Rows of another model stay where they are: two
    /// processes may resolve different models, and neither may empty the other's work.
    pub fn vectors_for(&self, model: &str) -> Result<Vec<(String, Vec<f32>)>, SemanticError> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT resource_id, dim, vector FROM embeddings
                 WHERE model = ?1 ORDER BY resource_id",
            )
            .map_err(|error| db_error("the semantic index could not be read", &error))?;
        let rows = statement
            .query_map([model], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(|error| db_error("the semantic index could not be read", &error))?;
        let mut vectors = Vec::new();
        let mut broken = 0usize;
        for row in rows {
            let (id, dim, bytes) =
                row.map_err(|error| db_error("the semantic index could not be read", &error))?;
            match usize::try_from(dim)
                .ok()
                .and_then(|dim| decode_vector(&bytes, dim))
            {
                Some(vector) => vectors.push((id, vector)),
                // A truncated file must cost accuracy, not the whole search.
                None => broken += 1,
            }
        }
        if broken > 0 {
            log::warn!("semantic index: skipped {broken} unreadable vector(s)");
        }
        Ok(vectors)
    }

    /// Writes (or replaces) `rows` in one transaction, so a crash mid-batch leaves the index
    /// consistent and the next build redoes that batch.
    pub fn put(&mut self, rows: &[Row]) -> Result<(), SemanticError> {
        if rows.is_empty() {
            return Ok(());
        }
        let tx = self
            .conn
            .transaction()
            .map_err(|error| db_error("the semantic index could not be updated", &error))?;
        {
            let mut statement = tx
                .prepare(
                    "INSERT INTO embeddings
                         (resource_id, url_key, content_hash, model, dim, vector, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(resource_id) DO UPDATE SET
                         url_key = excluded.url_key,
                         content_hash = excluded.content_hash,
                         model = excluded.model,
                         dim = excluded.dim,
                         vector = excluded.vector,
                         updated_at = excluded.updated_at",
                )
                .map_err(|error| db_error("the semantic index could not be updated", &error))?;
            for row in rows {
                statement
                    .execute(params![
                        row.resource_id,
                        row.url_key,
                        row.content_hash,
                        row.model,
                        i64::try_from(row.vector.len()).unwrap_or(0),
                        encode_vector(&row.vector),
                        row.updated_at,
                    ])
                    .map_err(|error| db_error("the semantic index could not be updated", &error))?;
            }
        }
        tx.commit()
            .map_err(|error| db_error("the semantic index could not be updated", &error))
    }

    /// Drops every row whose id is not in `keep` and returns how many went. This is how a
    /// deleted bookmark leaves the index; a stale id could otherwise resurrect it in a search.
    pub fn retain(&mut self, keep: &HashSet<&str>) -> Result<usize, SemanticError> {
        let stored: Vec<String> = self.hashes()?.into_keys().collect();
        let stale: Vec<&String> = stored
            .iter()
            .filter(|id| !keep.contains(id.as_str()))
            .collect();
        if stale.is_empty() {
            return Ok(0);
        }
        let tx = self
            .conn
            .transaction()
            .map_err(|error| db_error("the semantic index could not be updated", &error))?;
        {
            let mut statement = tx
                .prepare("DELETE FROM embeddings WHERE resource_id = ?1")
                .map_err(|error| db_error("the semantic index could not be updated", &error))?;
            for id in &stale {
                statement
                    .execute(params![id])
                    .map_err(|error| db_error("the semantic index could not be updated", &error))?;
            }
        }
        tx.commit()
            .map_err(|error| db_error("the semantic index could not be updated", &error))?;
        Ok(stale.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resource(id: &str) -> Resource {
        Resource {
            id: id.to_string(),
            url: format!("https://example.com/{id}"),
            url_key: format!("example.com/{id}"),
            title: "Ownership in Rust".to_string(),
            description: "How borrowing works.".to_string(),
            category_id: "development".to_string(),
            tags: vec!["rust".to_string(), "memory".to_string()],
            summary: vec!["Every value has one owner.".to_string()],
            ..Resource::default()
        }
    }

    fn row(id: &str, hash: &str, vector: Vec<f32>) -> Row {
        Row {
            resource_id: id.to_string(),
            url_key: format!("example.com/{id}"),
            content_hash: hash.to_string(),
            model: "nomic-embed-text".to_string(),
            vector,
            updated_at: 1_757_000_000_000,
        }
    }

    #[test]
    fn the_embedded_text_is_deterministic_and_skips_empty_fields() {
        let resource = resource("r1");
        let text = document_text(&resource);
        assert_eq!(
            text,
            "Ownership in Rust\ntags: rust, memory\ncategory: development\n\
             description: How borrowing works.\nsummary: Every value has one owner."
        );
        assert_eq!(document_text(&resource), text, "same input, same text");

        let mut bare = Resource {
            id: "r2".into(),
            url: "https://example.com/bare".into(),
            ..Resource::default()
        };
        assert_eq!(
            document_text(&bare),
            "https://example.com/bare",
            "a record with no text falls back to its URL instead of embedding nothing"
        );
        bare.title = "Notes".into();
        assert_eq!(document_text(&bare), "Notes");

        // Long records are cut on a character boundary, not a byte one.
        let mut long = resource.clone();
        long.description = "ş".repeat(super::super::ollama::MAX_INPUT_CHARS * 2);
        assert_eq!(
            document_text(&long).chars().count(),
            super::super::ollama::MAX_INPUT_CHARS
        );
    }

    #[test]
    fn the_hash_covers_both_the_text_and_the_model() {
        let text = document_text(&resource("r1"));
        let hash = content_hash("nomic-embed-text", &text);
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, content_hash("nomic-embed-text", &text));
        assert_ne!(hash, content_hash("bge-m3", &text), "model is part of it");
        assert_ne!(hash, content_hash("nomic-embed-text", &format!("{text} ")));
    }

    #[test]
    fn vectors_survive_a_round_trip() {
        let vector = vec![0.5f32, -0.25, 0.0, 1.5];
        let bytes = encode_vector(&vector);
        assert_eq!(bytes.len(), 16);
        assert_eq!(decode_vector(&bytes, 4), Some(vector));
        assert_eq!(decode_vector(&bytes, 3), None, "length must match dim");
        assert_eq!(decode_vector(&bytes, 0), None);
        assert_eq!(decode_vector(&[], MAX_DIM + 1), None);
    }

    #[test]
    fn rows_are_written_read_replaced_and_retained() {
        let mut index = Index::memory().expect("index");
        assert_eq!(index.count().expect("count"), 0);
        assert_eq!(index.model().expect("model"), None);
        assert_eq!(index.updated_at().expect("updated"), None);

        index.set_model("nomic-embed-text").expect("set model");
        assert_eq!(
            index.model().expect("model").as_deref(),
            Some("nomic-embed-text")
        );

        index
            .put(&[
                row("r1", "h1", vec![1.0, 0.0]),
                row("r2", "h2", vec![0.0, 1.0]),
            ])
            .expect("put");
        assert_eq!(index.count().expect("count"), 2);
        assert_eq!(
            index.updated_at().expect("updated"),
            Some(1_757_000_000_000)
        );
        assert_eq!(
            index.vectors_for("nomic-embed-text").expect("vectors"),
            vec![
                ("r1".to_string(), vec![1.0, 0.0]),
                ("r2".to_string(), vec![0.0, 1.0])
            ]
        );
        let hashes = index.hashes().expect("hashes");
        assert_eq!(hashes.get("r1").map(String::as_str), Some("h1"));

        let mut changed = row("r1", "h1-new", vec![0.5, 0.5]);
        changed.updated_at = 1_757_000_000_001;
        index.put(&[changed]).expect("replace");
        assert_eq!(index.count().expect("count"), 2);
        assert_eq!(
            index
                .hashes()
                .expect("hashes")
                .get("r1")
                .map(String::as_str),
            Some("h1-new")
        );
        assert_eq!(
            index.updated_at().expect("updated"),
            Some(1_757_000_000_001)
        );

        let keep: HashSet<&str> = ["r2"].into_iter().collect();
        assert_eq!(index.retain(&keep).expect("retain"), 1);
        assert_eq!(index.count().expect("count"), 1);
        assert_eq!(index.retain(&keep).expect("retain again"), 0);
        assert!(index.put(&[]).is_ok(), "an empty batch is not an error");
    }

    /// Two processes can resolve different models; neither may answer with the other's vectors.
    #[test]
    fn only_the_asked_model_s_vectors_come_back() {
        let mut index = Index::memory().expect("index");
        let mut other = row("r2", "h2", vec![0.0, 1.0]);
        other.model = "bge-m3".to_string();
        index
            .put(&[row("r1", "h1", vec![1.0, 0.0]), other])
            .expect("put");

        assert_eq!(
            index.vectors_for("nomic-embed-text").expect("vectors"),
            vec![("r1".to_string(), vec![1.0, 0.0])]
        );
        assert_eq!(
            index.vectors_for("bge-m3").expect("vectors"),
            vec![("r2".to_string(), vec![0.0, 1.0])]
        );
        assert!(index.vectors_for("llama3.2").expect("vectors").is_empty());
        assert_eq!(index.count().expect("count"), 2, "both rows stay");

        // One row per record, whatever the model: rebuilding cannot grow the index.
        let mut replaced = row("r2", "h2-new", vec![1.0, 1.0]);
        replaced.model = "nomic-embed-text".to_string();
        index.put(&[replaced]).expect("put");
        assert_eq!(index.count().expect("count"), 2);
        assert!(index.vectors_for("bge-m3").expect("vectors").is_empty());
    }

    #[test]
    fn a_row_whose_blob_does_not_match_its_dim_is_skipped() {
        let mut index = Index::memory().expect("index");
        index.put(&[row("r1", "h1", vec![1.0, 0.0])]).expect("put");
        index
            .conn
            .execute(
                "UPDATE embeddings SET dim = 99 WHERE resource_id = 'r1'",
                [],
            )
            .expect("corrupt the row");
        assert!(index
            .vectors_for("nomic-embed-text")
            .expect("vectors")
            .is_empty());
        assert_eq!(index.count().expect("count"), 1, "the row is still there");
    }

    #[test]
    fn the_file_is_created_in_the_cache_directory_and_reopened() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = dir.path().join("cache");
        {
            let mut index = Index::open(&cache).expect("open");
            index.set_model("bge-m3").expect("model");
            index.put(&[row("r1", "h1", vec![1.0, 2.0])]).expect("put");
        }
        assert!(semantic_index_path(&cache).is_file());
        let reopened = Index::open(&cache).expect("reopen");
        assert_eq!(reopened.count().expect("count"), 1);
        assert_eq!(reopened.model().expect("model").as_deref(), Some("bge-m3"));
        assert_eq!(
            reopened.vectors_for("nomic-embed-text").expect("vectors"),
            vec![("r1".to_string(), vec![1.0, 2.0])]
        );
    }
}
