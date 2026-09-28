//! Semantic ranking: embeddings from Ollama, cached in `<cache dir>/semantic.sqlite`. Text in,
//! `(resource id, score)` pairs out; the index is lazily built and search falls back to keyword
//! matching when it cannot answer. Used only by `mynk-mcp`, and kept Tauri-free so it can be.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::embed::index::{self, Index};
use super::embed::ollama::{pick_embedding_model, EmbedClient, BATCH_SIZE, NO_EMBEDDING_MODEL};
use super::embed::settings_file::{self, EmbedSettings};
use super::model::{Library, Resource};
use crate::util::{lock, now_ms};

/// How long [`rank_async`] spends filling a missing index before answering anyway. A hard limit:
/// a batch that would outlast it is abandoned.
pub const LAZY_BUILD_BUDGET: Duration = Duration::from_secs(8);
/// How long a model resolved from `/api/tags` is reused, so a run of searches probes it once.
const MODEL_CACHE_TTL: Duration = Duration::from_secs(60);
/// A semantic answer needs at least half the library indexed, or ranking would be arbitrary.
const MIN_COVERAGE_NUMERATOR: usize = 1;
const MIN_COVERAGE_DENOMINATOR: usize = 2;

/// Reported when the caller asks for a semantic answer without giving anything to match.
pub const EMPTY_QUERY: &str = "an empty query has nothing to embed";

/// Why a semantic answer could not be produced; every message is shown to the caller as a reason.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SemanticError {
    /// Something the user can fix: no index, no embedding model, no reachable server.
    #[error("{0}")]
    Unavailable(String),
    /// The index file could not be read or written.
    #[error("{0}")]
    Io(String),
    /// Ollama answered, but not with something usable.
    #[error("{0}")]
    Provider(String),
}

/// Progress of a [`build`], reported after every batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildProgress {
    /// Records with an up-to-date embedding.
    pub embedded: usize,
    pub total: usize,
}

/// What a [`build`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildReport {
    /// Records with an up-to-date embedding when the build stopped.
    pub embedded: usize,
    pub total: usize,
    /// False when the time budget ran out; the rest is picked up by the next call.
    pub complete: bool,
    pub model: String,
}

/// Not `Clone`, because the progress callback is a closure; construct it via `default()`.
#[derive(Default)]
pub struct BuildOptions {
    /// Stop starting new batches once this much time has passed; `None` means no limit.
    pub time_budget: Option<Duration>,
    /// Called after every batch, on the task running the build.
    pub on_progress: Option<Box<dyn Fn(BuildProgress) + Send + Sync>>,
}

impl std::fmt::Debug for BuildOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BuildOptions")
            .field("time_budget", &self.time_budget)
            .field("on_progress", &self.on_progress.is_some())
            .finish()
    }
}

/// A semantic answer plus what the caller has to be told about it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ranked {
    /// `(resource id, score)` pairs, best first.
    pub hits: Vec<(String, f32)>,
    /// Set while the index does not cover every record, so the answer can say so.
    pub note: Option<String>,
}

/// What the index holds. Cheap: no network, no embedding, no writes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexStatus {
    pub indexed: usize,
    /// The model the stored vectors were produced with, if the index has ever been built.
    pub model: Option<String>,
    /// When the newest vector was written (epoch ms).
    pub updated_at: Option<i64>,
}

fn too_thin(indexed: usize, total: usize) -> bool {
    indexed == 0 || indexed * MIN_COVERAGE_DENOMINATOR < total * MIN_COVERAGE_NUMERATOR
}

fn coverage_message(indexed: usize, total: usize) -> String {
    format!("semantic index {indexed} of {total} built; run `mynk-mcp index`")
}

/// How many of `wanted` the index holds with the right content hash; `COUNT(*)` would also count
/// rows of deleted records, of other models and of text that has changed.
fn coverage_of(stored: &HashMap<String, String>, wanted: &[Wanted]) -> usize {
    wanted
        .iter()
        .filter(|item| stored.get(&item.id) == Some(&item.hash))
        .count()
}

/// Runs one blocking SQLite step off the async worker and hands the open index back, so a whole
/// search needs a single `Index::open`.
async fn on_index<T: Send + 'static>(
    index: Index,
    work: impl FnOnce(&mut Index) -> Result<T, SemanticError> + Send + 'static,
) -> Result<(Index, T), SemanticError> {
    tokio::task::spawn_blocking(move || {
        let mut index = index;
        let value = work(&mut index)?;
        Ok((index, value))
    })
    .await
    .map_err(|error| SemanticError::Io(format!("the semantic index task failed: {error}")))?
}

/// Opens the index off the async worker.
async fn open_index(cache_dir: &Path) -> Result<Index, SemanticError> {
    let cache_dir = cache_dir.to_path_buf();
    tokio::task::spawn_blocking(move || Index::open(&cache_dir))
        .await
        .map_err(|error| SemanticError::Io(format!("the semantic index task failed: {error}")))?
}

/// The model the index was last built with, or `None` when it has never been built or cannot be
/// read; only used to prefer a model, never to decide whether the index is usable.
fn stored_model(cache_dir: &Path) -> Option<String> {
    if !crate::paths::semantic_index_path(cache_dir).is_file() {
        return None;
    }
    Index::open(cache_dir).ok()?.model().ok().flatten()
}

/// Reads [`IndexStatus`] from `cache_dir`; a missing or unreadable index reads as empty, so
/// `doctor` never fails on it.
pub fn status(cache_dir: &Path) -> IndexStatus {
    if !crate::paths::semantic_index_path(cache_dir).is_file() {
        return IndexStatus::default();
    }
    match Index::open(cache_dir) {
        Ok(index) => IndexStatus {
            indexed: index.count().unwrap_or_default(),
            model: index.model().ok().flatten(),
            updated_at: index.updated_at().ok().flatten(),
        },
        Err(error) => {
            log::warn!("semantic: the index could not be opened: {error}");
            IndexStatus::default()
        }
    }
}

/// Bumped by every write this process makes, so its own changes invalidate the cache even when
/// the file system's timestamps are too coarse to notice them.
static WRITES: AtomicU64 = AtomicU64::new(0);

/// Identity of the index file: this process's write counter plus size/mtime of the database and
/// its write-ahead log, since a WAL commit can land there before the main file changes.
/// write-ahead log, since a WAL commit can land there before the main file changes.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp {
    writes: u64,
    main: Option<(u128, u64)>,
    wal: Option<(u128, u64)>,
}

fn file_stamp(path: &Path) -> Option<(u128, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos());
    Some((modified, metadata.len()))
}

fn stamp(cache_dir: &Path) -> Stamp {
    let path = crate::paths::semantic_index_path(cache_dir);
    let mut wal = path.clone().into_os_string();
    wal.push("-wal");
    Stamp {
        writes: WRITES.load(Ordering::Relaxed),
        main: file_stamp(&path),
        wal: file_stamp(Path::new(&wal)),
    }
}

/// A large library's vector set can reach ~60 MB, so searches share one copy.
type Vectors = Arc<Vec<(String, Vec<f32>)>>;

struct CachedVectors {
    cache_dir: PathBuf,
    model: String,
    stamp: Stamp,
    vectors: Vectors,
}

static VECTORS: OnceLock<Mutex<Option<CachedVectors>>> = OnceLock::new();

/// The cached vector set, if it was loaded from this directory for this model and the index has
/// not changed since.
fn cached_vectors(cache_dir: &Path, model: &str, current: &Stamp) -> Option<Vectors> {
    let guard = lock(VECTORS.get_or_init(|| Mutex::new(None)));
    let cached = guard.as_ref()?;
    (cached.cache_dir == cache_dir && cached.model == model && &cached.stamp == current)
        .then(|| Arc::clone(&cached.vectors))
}

fn remember_vectors(cache_dir: &Path, model: &str, stamp: Stamp, vectors: &Vectors) {
    *lock(VECTORS.get_or_init(|| Mutex::new(None))) = Some(CachedVectors {
        cache_dir: cache_dir.to_path_buf(),
        model: model.to_string(),
        stamp,
        vectors: Arc::clone(vectors),
    });
}

/// Test hook: forgets the cached vectors, so a test that rewrote the index sees the new one.
/// Nothing in MYNK deletes the index file; a rebuild is noticed through [`stamp`].
pub fn forget_cached_vectors() {
    WRITES.fetch_add(1, Ordering::Relaxed);
    if let Some(cell) = VECTORS.get() {
        *lock(cell) = None;
    }
}

/// Cosine similarity, accumulated in f64 so a 4096-dimension vector does not drift.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut norm_a, mut norm_b) = (0f64, 0f64, 0f64);
    for (left, right) in a.iter().zip(b.iter()) {
        dot += f64::from(*left) * f64::from(*right);
        norm_a += f64::from(*left) * f64::from(*left);
        norm_b += f64::from(*right) * f64::from(*right);
    }
    if norm_a <= 0.0 || norm_b <= 0.0 {
        return 0.0;
    }
    (dot / (norm_a.sqrt() * norm_b.sqrt())) as f32
}

/// Cosine similarity mapped onto `0..=1`; monotone, so rank order is unchanged.
fn score_of(similarity: f32) -> f32 {
    ((similarity + 1.0) / 2.0).clamp(0.0, 1.0)
}

/// Best `limit` matches for `query_vector` among `vectors`, ignoring ids that are not in `alive`.
/// Ties break by id so two runs over the same data answer in the same order.
fn top_matches(
    vectors: &[(String, Vec<f32>)],
    query_vector: &[f32],
    alive: &HashSet<&str>,
    limit: usize,
) -> Vec<(String, f32)> {
    let mut scored: Vec<(String, f32)> = vectors
        .iter()
        .filter(|(id, _)| alive.contains(id.as_str()))
        .map(|(id, vector)| (id.clone(), score_of(cosine(vector, query_vector))))
        .collect();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    scored.truncate(limit);
    scored
}

/// The model resolved from `/api/tags` per base URL, and when.
static MODELS: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
/// More addresses than one machine ever uses; past it the oldest entry makes room.
const MODEL_CACHE_SLOTS: usize = 32;

fn models() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    MODELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_model(base_url: &str) -> Option<String> {
    let guard = lock(models());
    guard
        .get(base_url)
        .filter(|(_, at)| at.elapsed() < MODEL_CACHE_TTL)
        .map(|(model, _)| model.clone())
}

fn remember_model(base_url: &str, model: &str) {
    let mut guard = lock(models());
    guard.retain(|_, (_, at)| at.elapsed() < MODEL_CACHE_TTL);
    while guard.len() >= MODEL_CACHE_SLOTS {
        let oldest = guard
            .iter()
            .min_by_key(|(_, (_, at))| *at)
            .map(|(url, _)| url.clone());
        match oldest {
            Some(url) => drop(guard.remove(&url)),
            None => break,
        }
    }
    guard.insert(base_url.to_string(), (model.to_string(), Instant::now()));
}

/// A client plus the model it will use. Resolving the model costs one `GET /api/tags`, so both
/// public entry points do it once and hand the result to everything underneath.
struct Session {
    client: EmbedClient,
    model: String,
}

impl Session {
    /// `reuse_model` answers from the model cache when it can; an explicit build asks the server.
    async fn open(
        data_dir: &Path,
        cache_dir: &Path,
        reuse_model: bool,
    ) -> Result<Self, SemanticError> {
        let settings: EmbedSettings = settings_file::load(data_dir);
        let client = EmbedClient::new(&settings)?;
        // An explicit MYNK_EMBED_MODEL is trusted without checking the server first.
        if let Some(model) = settings_file::model_override() {
            return Ok(Self { client, model });
        }
        // So is the model chosen in Settings; a wrong name fails at the first embed call.
        if let Some(model) = settings.embedding_model.clone() {
            return Ok(Self { client, model });
        }
        if let Some(model) = reuse_model
            .then(|| cached_model(&settings.ollama_base_url))
            .flatten()
        {
            return Ok(Self { client, model });
        }
        let installed = client.installed_models().await?;
        // The model the index already holds wins while the server still lists it, so two
        // processes reading the same `/api/tags` in a different order do not re-embed everything.
        let model = stored_model(cache_dir)
            .filter(|stored| installed.iter().any(|m| &m.name == stored))
            .or_else(|| pick_embedding_model(&installed))
            .ok_or_else(|| SemanticError::Unavailable(NO_EMBEDDING_MODEL.to_string()))?;
        remember_model(&settings.ollama_base_url, &model);
        Ok(Self { client, model })
    }

    /// Every record as the index wants it.
    fn wanted(&self, lib: &Library) -> Vec<Wanted> {
        lib.resources
            .iter()
            .map(|r| Wanted::of(r, &self.model))
            .collect()
    }

    /// Brings `store` up to date with `wanted`, and hands it back so one search opens the index
    /// only once.
    async fn build(
        &self,
        wanted: &[Wanted],
        store: Index,
        options: &BuildOptions,
    ) -> Result<(Index, BuildReport), SemanticError> {
        let started = Instant::now();
        let model = self.model.clone();
        // A transient SQLite failure must not be read as "another model built this".
        let (store, changed) = on_index(store, move |store| {
            if store.model()?.as_deref() == Some(model.as_str()) {
                return Ok(false);
            }
            // Rows of the other model stay: `vectors_for` never mixes two models, and a second
            // process may still be using them.
            store.set_model(&model)?;
            Ok(true)
        })
        .await?;
        if changed {
            WRITES.fetch_add(1, Ordering::Relaxed);
        }

        let ids: HashSet<String> = wanted.iter().map(|item| item.id.clone()).collect();
        let (store, dropped) = on_index(store, move |store| {
            store.retain(&ids.iter().map(String::as_str).collect())
        })
        .await?;
        if dropped > 0 {
            WRITES.fetch_add(1, Ordering::Relaxed);
        }

        let (mut store, stored) = on_index(store, |store| store.hashes()).await?;
        let pending: Vec<&Wanted> = wanted
            .iter()
            .filter(|item| stored.get(&item.id) != Some(&item.hash))
            .collect();

        let total = wanted.len();
        let mut embedded = total.saturating_sub(pending.len());
        let mut complete = true;
        for batch in pending.chunks(BATCH_SIZE) {
            // A single `embed` would otherwise hold the caller for its own longer timeout.
            let left = match options.time_budget {
                None => None,
                Some(budget) => match budget.checked_sub(started.elapsed()) {
                    Some(left) if !left.is_zero() => Some(left),
                    _ => {
                        complete = false;
                        break;
                    }
                },
            };
            let inputs: Vec<String> = batch.iter().map(|item| item.text.clone()).collect();
            let embedding = self.client.embed(&self.model, &inputs);
            let vectors = match left {
                None => embedding.await?,
                Some(left) => match tokio::time::timeout(left, embedding).await {
                    Ok(vectors) => vectors?,
                    Err(_) => {
                        complete = false;
                        break;
                    }
                },
            };
            let now = now_ms();
            let rows: Vec<index::Row> = batch
                .iter()
                .zip(vectors)
                .map(|(item, vector)| index::Row {
                    resource_id: item.id.clone(),
                    url_key: item.url_key.clone(),
                    content_hash: item.hash.clone(),
                    model: self.model.clone(),
                    vector,
                    updated_at: now,
                })
                .collect();
            store = on_index(store, move |store| store.put(&rows)).await?.0;
            WRITES.fetch_add(1, Ordering::Relaxed);
            embedded += batch.len();
            if let Some(report) = &options.on_progress {
                report(BuildProgress { embedded, total });
            }
        }
        Ok((
            store,
            BuildReport {
                embedded,
                total,
                complete,
                model: self.model.clone(),
            },
        ))
    }
}

/// One record as the index wants it.
struct Wanted {
    id: String,
    url_key: String,
    text: String,
    hash: String,
}

impl Wanted {
    fn of(resource: &Resource, model: &str) -> Self {
        let text = index::document_text(resource);
        let hash = index::content_hash(model, &text);
        Self {
            id: resource.id.clone(),
            url_key: resource.url_key.clone(),
            text,
            hash,
        }
    }
}

/// Brings the embedding index up to date with `lib`, incrementally. A stopped build reports
/// `complete: false` and resumes on the next call.
pub async fn build(
    lib: &Library,
    data_dir: &Path,
    cache_dir: &Path,
    options: BuildOptions,
) -> Result<BuildReport, SemanticError> {
    let session = Session::open(data_dir, cache_dir, false).await?;
    let store = open_index(cache_dir).await?;
    let (_, report) = session.build(&session.wanted(lib), store, &options).await?;
    Ok(report)
}

/// Ranks `query` against the library's embeddings, best first. Anything missing or stale is
/// embedded first (up to [`LAZY_BUILD_BUDGET`]); ids no longer in `lib` are dropped.
pub async fn rank_async(
    lib: &Library,
    data_dir: &Path,
    cache_dir: &Path,
    query: &str,
    limit: usize,
) -> Result<Ranked, SemanticError> {
    rank_among(lib, data_dir, cache_dir, query, limit, None).await
}

/// [`rank_async`] ranking only the records in `only` (when set), so filters apply before the cut.
pub async fn rank_among(
    lib: &Library,
    data_dir: &Path,
    cache_dir: &Path,
    query: &str,
    limit: usize,
    only: Option<&HashSet<&str>>,
) -> Result<Ranked, SemanticError> {
    if query.trim().is_empty() {
        return Err(SemanticError::Unavailable(EMPTY_QUERY.to_string()));
    }
    if limit == 0 || lib.resources.is_empty() {
        return Ok(Ranked::default());
    }

    let total = lib.resources.len();
    let session = Session::open(data_dir, cache_dir, true).await?;
    let wanted = session.wanted(lib);

    // One open, one hash scan: everything below reuses this handle.
    let (store, stored) = on_index(open_index(cache_dir).await?, |store| store.hashes()).await?;
    let mut covered = coverage_of(&stored, &wanted);
    drop(stored);
    let mut store = Some(store);

    let mut stopped = None;
    if covered < total {
        // Every batch reports how much is up to date, so a failed build needs no second scan.
        let written = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&written);
        let options = BuildOptions {
            time_budget: Some(LAZY_BUILD_BUDGET),
            on_progress: Some(Box::new(move |progress: BuildProgress| {
                seen.store(progress.embedded, Ordering::Relaxed);
            })),
        };
        let handle = match store.take() {
            Some(handle) => handle,
            None => open_index(cache_dir).await?,
        };
        match session.build(&wanted, handle, &options).await {
            Ok((handle, report)) => {
                store = Some(handle);
                covered = report.embedded;
            }
            // What is already stored stays usable when topping it up fails.
            Err(error) => {
                covered = covered.max(written.load(Ordering::Relaxed));
                stopped = Some(error);
            }
        }
    }
    if too_thin(covered, total) {
        return Err(
            stopped.unwrap_or_else(|| SemanticError::Unavailable(coverage_message(covered, total)))
        );
    }

    let embedded = session
        .client
        .embed(&session.model, &[query.to_string()])
        .await?;
    let query_vector = embedded
        .into_iter()
        .next()
        .ok_or_else(|| SemanticError::Provider("Ollama did not embed the query".to_string()))?;

    let current = stamp(cache_dir);
    let vectors = match cached_vectors(cache_dir, &session.model, &current) {
        Some(vectors) => vectors,
        None => {
            let model = session.model.clone();
            let handle = match store {
                Some(handle) => handle,
                None => open_index(cache_dir).await?,
            };
            let (_, loaded) = on_index(handle, move |store| store.vectors_for(&model)).await?;
            let vectors: Vectors = Arc::new(loaded);
            remember_vectors(cache_dir, &session.model, current, &vectors);
            vectors
        }
    };

    let alive: HashSet<&str> = lib
        .resources
        .iter()
        .map(|resource| resource.id.as_str())
        .filter(|id| only.is_none_or(|only| only.contains(id)))
        .collect();
    Ok(Ranked {
        hits: top_matches(&vectors, &query_vector, &alive, limit),
        note: (covered < total).then(|| coverage_message(covered, total)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_index_covering_less_than_half_the_library_is_too_thin() {
        assert!(too_thin(0, 0), "an empty index is never an answer");
        assert!(too_thin(0, 10));
        assert!(too_thin(4, 10), "less than half");
        assert!(!too_thin(5, 10), "exactly half is enough");
        assert!(!too_thin(10, 10));
        assert_eq!(
            coverage_message(4, 10),
            "semantic index 4 of 10 built; run `mynk-mcp index`"
        );
    }

    #[test]
    fn cosine_ignores_length_and_its_score_stays_within_zero_and_one() {
        let a = vec![1.0f32, 0.0];
        assert!((cosine(&a, &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&a, &[0.0, 1.0]).abs() < 1e-6);
        assert!((cosine(&a, &[-1.0, 0.0]) + 1.0).abs() < 1e-6);
        assert!((cosine(&a, &[5.0, 0.0]) - 1.0).abs() < 1e-6, "length free");
        // Anything unusable returns 0, never a panic or NaN.
        assert_eq!(cosine(&a, &[1.0, 0.0, 0.0]), 0.0);
        assert_eq!(cosine(&[], &[]), 0.0);
        assert_eq!(cosine(&a, &[0.0, 0.0]), 0.0);

        assert!((score_of(1.0) - 1.0).abs() < 1e-6);
        assert!((score_of(0.0) - 0.5).abs() < 1e-6);
        assert!((score_of(-1.0)).abs() < 1e-6);
        assert!((0.0..=1.0).contains(&score_of(2.0)));
        assert!((0.0..=1.0).contains(&score_of(-2.0)));
    }

    #[test]
    fn the_best_matches_come_first_and_deleted_records_are_dropped() {
        let vectors = vec![
            ("r1".to_string(), vec![1.0f32, 0.0]),
            ("r2".to_string(), vec![0.0, 1.0]),
            ("r3".to_string(), vec![0.9, 0.1]),
            ("gone".to_string(), vec![1.0, 0.0]),
        ];
        let alive: HashSet<&str> = ["r1", "r2", "r3"].into_iter().collect();
        let ranked = top_matches(&vectors, &[1.0, 0.0], &alive, 10);
        let ids: Vec<&str> = ranked.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["r1", "r3", "r2"]);
        assert!(ranked.iter().all(|(_, score)| (0.0..=1.0).contains(score)));
        assert!(ranked[0].1 > ranked[1].1 && ranked[1].1 > ranked[2].1);
        assert_eq!(top_matches(&vectors, &[1.0, 0.0], &alive, 2).len(), 2);

        let tied = vec![
            ("b".to_string(), vec![1.0f32, 0.0]),
            ("a".to_string(), vec![1.0, 0.0]),
        ];
        let ids: Vec<String> =
            top_matches(&tied, &[1.0, 0.0], &["a", "b"].into_iter().collect(), 2)
                .into_iter()
                .map(|(id, _)| id)
                .collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn the_embedded_text_of_a_record_carries_its_model_into_the_hash() {
        let mut resource = Resource {
            id: "r1".into(),
            url: "https://example.com/a".into(),
            url_key: "example.com/a".into(),
            title: "Ownership".into(),
            ..Resource::default()
        };
        let first = Wanted::of(&resource, "nomic-embed-text");
        assert_eq!(first.id, "r1");
        assert_eq!(first.url_key, "example.com/a");
        assert_eq!(first.text, "Ownership");
        assert_ne!(first.hash, Wanted::of(&resource, "bge-m3").hash);
        resource.title = "Borrowing".into();
        assert_ne!(first.hash, Wanted::of(&resource, "nomic-embed-text").hash);
    }

    #[test]
    fn an_empty_query_is_refused_and_an_empty_library_has_no_answer() {
        let lib = Library::empty();
        let dir = tempfile::tempdir().expect("temp dir");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let blank = runtime.block_on(rank_async(&lib, dir.path(), dir.path(), "   ", 10));
        assert_eq!(
            blank.expect_err("a blank query cannot be embedded"),
            SemanticError::Unavailable(EMPTY_QUERY.to_string())
        );
        let none = runtime
            .block_on(rank_async(&lib, dir.path(), dir.path(), "rust", 10))
            .expect("an empty library has no matches");
        assert_eq!(none, Ranked::default());
    }

    #[test]
    fn coverage_counts_only_records_whose_stored_text_is_still_current() {
        let dir = tempfile::tempdir().expect("temp dir");
        let resource = Resource {
            id: "r1".into(),
            title: "Ownership".into(),
            ..Resource::default()
        };
        let wanted = vec![Wanted::of(&resource, "nomic-embed-text")];
        assert_eq!(
            coverage_of(&HashMap::new(), &wanted),
            0,
            "no index file, no cover"
        );
        assert!(!crate::paths::semantic_index_path(dir.path()).exists());

        let mut store = Index::open(dir.path()).expect("index");
        store
            .put(&[index::Row {
                resource_id: "r1".into(),
                url_key: String::new(),
                content_hash: wanted[0].hash.clone(),
                model: "nomic-embed-text".into(),
                vector: vec![1.0, 0.0],
                updated_at: 1,
            }])
            .expect("put");
        let stored = store.hashes().expect("hashes");
        assert_eq!(coverage_of(&stored, &wanted), 1);

        // After an edit, COUNT(*) still counts the row, but the row does not cover the record.
        let edited = Resource {
            title: "Borrowing".into(),
            ..resource
        };
        let wanted = vec![Wanted::of(&edited, "nomic-embed-text")];
        assert_eq!(coverage_of(&stored, &wanted), 0);
        assert_eq!(status(dir.path()).indexed, 1, "the row is still there");
    }

    /// The index names its model, so a process whose `/api/tags` order differs keeps using it.
    #[test]
    fn the_model_the_index_already_holds_is_readable() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(stored_model(dir.path()), None, "no file, no model");
        let store = Index::open(dir.path()).expect("index");
        assert_eq!(stored_model(dir.path()), None, "never built, no model");
        store.set_model("bge-m3:latest").expect("set model");
        drop(store);
        assert_eq!(stored_model(dir.path()).as_deref(), Some("bge-m3:latest"));
    }

    #[test]
    fn the_status_of_a_directory_without_an_index_is_empty() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(status(dir.path()), IndexStatus::default());
        assert_eq!(status(&dir.path().join("nope")), IndexStatus::default());
        assert!(!crate::paths::semantic_index_path(dir.path()).exists());
    }

    #[test]
    fn build_options_default_to_no_budget_and_no_progress() {
        let options = BuildOptions::default();
        assert_eq!(options.time_budget, None);
        assert!(options.on_progress.is_none());
        assert!(format!("{options:?}").contains("on_progress: false"));
    }
}
