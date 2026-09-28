//! The embedding index end to end, against a fake Ollama on loopback (real HTTP server, no real
//! network access, no model ever pulled). Checks the real SQLite cache file, incremental
//! rebuilds, the time budget, and the two refusals that matter.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::catalog::embed::settings_file;
use app_lib::catalog::model::{Library, Resource};
use app_lib::catalog::semantic::{self, BuildOptions, BuildProgress, SemanticError};
use app_lib::mcp::engine::{Engine, SearchRequest};
use serde_json::{json, Value};

use crate::support::server::{Reply, TestServer};

/// Dimension of the fake embeddings; large enough that fixture words don't collide into one bucket.
const DIM: usize = 256;

/// A deterministic stand-in for an embedding model: one bucket per word (FNV-1a modulo [`DIM`]),
/// counted, so texts sharing words get a high cosine similarity.
fn fake_vector(text: &str) -> Vec<f32> {
    let mut vector = vec![0f32; DIM];
    for word in text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
    {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in word.to_lowercase().bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        let bucket = usize::try_from(hash % DIM as u64).unwrap_or(0);
        vector[bucket] += 1.0;
    }
    // A model never answers with a zero vector; an all-zero one would make every score 0.5.
    if vector.iter().all(|value| *value == 0.0) {
        vector[0] = 1.0;
    }
    vector
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A fake Ollama whose model list can be changed while the test runs.
struct FakeOllama {
    server: TestServer,
    models: Arc<Mutex<Vec<String>>>,
    /// While set, only single-input requests are served, so a build fails where a query still
    /// succeeds.
    refuse_batches: Arc<Mutex<bool>>,
}

impl FakeOllama {
    async fn start(models: &[&str], embed_delay_ms: u64) -> Self {
        let server = TestServer::start().await;
        let models: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(
            models.iter().map(|name| (*name).to_string()).collect(),
        ));
        let refuse_batches = Arc::new(Mutex::new(false));

        let listed = Arc::clone(&models);
        server.route("/api/tags", move |_request| {
            let models: Vec<Value> = lock(&listed)
                .iter()
                .map(|name| {
                    // Chat models report their own architecture, which the family rule must not
                    // mistake for an embedding one.
                    let family = if name.contains("embed") || name.contains("bge") {
                        "bert"
                    } else {
                        "llama"
                    };
                    json!({ "name": name, "details": { "family": family } })
                })
                .collect();
            Reply::json(&json!({ "models": models }))
        });

        let installed = Arc::clone(&models);
        let refusing = Arc::clone(&refuse_batches);
        server.route("/api/embed", move |request| {
            let body = request.json();
            let model = body["model"].as_str().unwrap_or_default().to_string();
            if !lock(&installed).iter().any(|name| name == &model) {
                return Reply::text(
                    404,
                    "application/json",
                    json!({ "error": format!("model '{model}' not found") }).to_string(),
                );
            }
            let inputs: Vec<&str> = body["input"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .map(|value| value.as_str().unwrap_or_default())
                        .collect()
                })
                .unwrap_or_default();
            if inputs.len() > 1 && *lock(&refusing) {
                return Reply::text(
                    503,
                    "application/json",
                    json!({ "error": "the model is loading" }).to_string(),
                );
            }
            let embeddings: Vec<Vec<f32>> = inputs.iter().map(|input| fake_vector(input)).collect();
            Reply::json(&json!({ "model": model, "embeddings": embeddings }))
                .with_delay(embed_delay_ms)
        });

        Self {
            server,
            models,
            refuse_batches,
        }
    }

    fn install_only(&self, models: &[&str]) {
        *lock(&self.models) = models.iter().map(|name| (*name).to_string()).collect();
    }

    fn refuse_batches(&self, refuse: bool) {
        *lock(&self.refuse_batches) = refuse;
    }

    /// How many inputs the server was asked to embed since the last [`Self::reset`].
    fn embedded_inputs(&self) -> usize {
        self.server
            .requests_to("/api/embed")
            .iter()
            .map(|request| {
                request.json()["input"]
                    .as_array()
                    .map_or(0, |inputs| inputs.len())
            })
            .sum()
    }

    fn embed_calls(&self) -> usize {
        self.server.hits("/api/embed")
    }

    fn reset(&self) {
        self.server.reset_log();
    }
}

/// The two directories the index works with, plus the settings file the app would have written.
struct Dirs {
    _temp: tempfile::TempDir,
    data: std::path::PathBuf,
    cache: std::path::PathBuf,
}

fn dirs(base_url: &str, allow_private_network: bool) -> Dirs {
    dirs_with_model(base_url, allow_private_network, "")
}

/// [`dirs`] with the embedding model the user picked in Settings (empty means none).
fn dirs_with_model(base_url: &str, allow_private_network: bool, embedding_model: &str) -> Dirs {
    let temp = tempfile::tempdir().expect("temp dir");
    let data = temp.path().join("data");
    let cache = temp.path().join("cache");
    std::fs::create_dir_all(&data).expect("data dir");
    // Exactly the file `tauri-plugin-store` writes into the app data directory.
    std::fs::write(
        data.join("settings.store.json"),
        json!({
            "ai": {
                "provider": "ollama",
                "ollamaBaseUrl": base_url,
                "ollamaModel": "qwen3.5:9b",
                "openrouterModel": "",
                "allowPrivateNetwork": allow_private_network,
                "embeddingModel": embedding_model
            }
        })
        .to_string(),
    )
    .expect("settings file");
    Dirs {
        _temp: temp,
        data,
        cache,
    }
}

fn resource(id: &str, title: &str, tags: &[&str], description: &str) -> Resource {
    Resource {
        id: id.to_string(),
        url: format!("https://example.com/{id}"),
        url_key: format!("example.com/{id}"),
        title: title.to_string(),
        description: description.to_string(),
        category_id: "development".to_string(),
        tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
        created_at: 1_757_000_000_000,
        ..Resource::default()
    }
}

/// Three records that share no vocabulary, so the ranking is not a coin toss.
fn library() -> Library {
    Library {
        version: 3,
        saved_at: 1_757_700_000_000,
        resources: vec![
            resource(
                "r1",
                "Ownership in Rust",
                &["rust", "memory"],
                "Borrowing and lifetimes explained",
            ),
            resource(
                "r2",
                "Yazılım Geliştirme Rehberi",
                &["yazılım", "rehber"],
                "Türkçe kaynaklar",
            ),
            resource(
                "r3",
                "Sourdough bread recipe",
                &["baking", "food"],
                "Flour water salt starter",
            ),
        ],
        collections: Vec::new(),
        skipped: 0,
    }
}

/// A library of `count` records, each with its own distinctive word.
fn big_library(count: usize) -> Library {
    Library {
        version: 3,
        saved_at: 1_757_700_000_000,
        resources: (0..count)
            .map(|i| {
                resource(
                    &format!("r{i}"),
                    &format!("Record number{i}"),
                    &["bulk"],
                    "",
                )
            })
            .collect(),
        collections: Vec::new(),
        skipped: 0,
    }
}

/// The same records as [`big_library`], in the shape `library.json` holds them.
fn library_json(count: usize) -> String {
    let resources: Vec<Value> = (0..count)
        .map(|i| {
            json!({
                "id": format!("r{i}"),
                "url": format!("https://example.com/r{i}"),
                "title": format!("Record number{i}"),
                "description": "",
                "categoryId": "development",
                "tags": ["bulk"],
                "createdAt": 1_757_000_000_000i64,
            })
        })
        .collect();
    json!({
        "version": 3,
        "savedAt": 1_757_700_000_000i64,
        "resources": resources,
        "collections": [],
    })
    .to_string()
}

fn ids(ranked: &[(String, f32)]) -> Vec<&str> {
    ranked.iter().map(|(id, _)| id.as_str()).collect()
}

/// Fails if an env override is set, since it would pick the model instead.
fn assert_no_model_override() {
    assert!(
        settings_file::model_override().is_none(),
        "unset {} before running these tests",
        settings_file::EMBED_MODEL_ENV
    );
}

#[tokio::test]
async fn builds_the_index_and_then_answers_from_it() {
    assert_no_model_override();
    let ollama = FakeOllama::start(
        &["qwen3.5:9b", "bge-m3:latest", "nomic-embed-text:latest"],
        0,
    )
    .await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = library();

    let progress: Arc<Mutex<Vec<BuildProgress>>> = Arc::new(Mutex::new(Vec::new()));
    let collected = Arc::clone(&progress);
    let report = semantic::build(
        &lib,
        &dirs.data,
        &dirs.cache,
        BuildOptions {
            time_budget: None,
            on_progress: Some(Box::new(move |step| lock(&collected).push(step))),
        },
    )
    .await
    .expect("build");

    assert_eq!(report.embedded, 3);
    assert_eq!(report.total, 3);
    assert!(report.complete);
    assert_eq!(
        report.model, "nomic-embed-text:latest",
        "the preferred model wins over the other embedding model on the server"
    );
    assert_eq!(
        lock(&progress).last().copied(),
        Some(BuildProgress {
            embedded: 3,
            total: 3
        })
    );
    assert_eq!(ollama.embed_calls(), 1, "three records are one batch");

    let status = semantic::status(&dirs.cache);
    assert_eq!(status.indexed, 3);
    assert_eq!(status.model.as_deref(), Some("nomic-embed-text:latest"));
    assert!(status.updated_at.unwrap_or_default() > 0);
    assert!(
        app_lib::paths::semantic_index_path(&dirs.cache).is_file(),
        "the index lives in the cache directory"
    );

    let ranked = semantic::rank_async(&lib, &dirs.data, &dirs.cache, "rust ownership", 10)
        .await
        .expect("rank");
    assert_eq!(ranked.hits.len(), 3);
    assert_eq!(ranked.note, None, "a complete index makes no excuses");
    assert_eq!(ids(&ranked.hits)[0], "r1", "{ranked:?}");
    assert!(ranked.hits[0].1 > ranked.hits[1].1, "{ranked:?}");
    assert!(
        ranked
            .hits
            .iter()
            .all(|(_, score)| (0.0..=1.0).contains(score)),
        "{ranked:?}"
    );
    assert_eq!(
        ollama.embed_calls(),
        2,
        "the query costs exactly one more embedding request"
    );

    // The limit is honored and the answer stays in ranked order.
    let top = semantic::rank_async(&lib, &dirs.data, &dirs.cache, "rust ownership", 1)
        .await
        .expect("rank");
    assert_eq!(ids(&top.hits), vec!["r1"]);
}

#[tokio::test]
async fn a_search_builds_the_missing_index_on_its_own() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = library();

    assert_eq!(semantic::status(&dirs.cache).indexed, 0);
    let ranked = semantic::rank_async(&lib, &dirs.data, &dirs.cache, "sourdough bread", 10)
        .await
        .expect("rank builds what it needs");
    assert_eq!(ids(&ranked.hits)[0], "r3", "{ranked:?}");
    assert_eq!(semantic::status(&dirs.cache).indexed, 3);
}

#[tokio::test]
async fn a_search_indexes_the_records_added_since_the_last_build() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let mut lib = library();

    semantic::rank_async(&lib, &dirs.data, &dirs.cache, "rust", 10)
        .await
        .expect("the first search builds the index");
    assert_eq!(semantic::status(&dirs.cache).indexed, 3);

    // As many new records as there are old ones, so the row count alone still looks healthy.
    lib.resources.push(resource(
        "r4",
        "Kombucha brewing",
        &["fermentation"],
        "Scoby sugar tea",
    ));
    lib.resources.push(resource(
        "r5",
        "Cheesemaking at home",
        &["dairy"],
        "Rennet curd whey",
    ));
    lib.resources.push(resource(
        "r6",
        "Kimchi jars",
        &["fermentation"],
        "Napa cabbage gochugaru",
    ));
    ollama.reset();

    let ranked = semantic::rank_async(&lib, &dirs.data, &dirs.cache, "kombucha brewing", 10)
        .await
        .expect("rank");
    assert_eq!(ids(&ranked.hits)[0], "r4", "{ranked:?}");
    assert_eq!(
        ranked.note, None,
        "the index caught up, so there is no note"
    );
    assert_eq!(semantic::status(&dirs.cache).indexed, 6);
    assert_eq!(
        ollama.embedded_inputs(),
        4,
        "three new records plus the query"
    );

    // An edited record is re-embedded by the next search too, not only a new one.
    lib.resources[0].title = "Borrowing in Rust".to_string();
    ollama.reset();
    let ranked = semantic::rank_async(&lib, &dirs.data, &dirs.cache, "borrowing in rust", 10)
        .await
        .expect("rank");
    assert_eq!(ids(&ranked.hits)[0], "r1", "{ranked:?}");
    assert_eq!(
        ollama.embedded_inputs(),
        2,
        "the edited record plus the query"
    );
}

#[tokio::test]
async fn a_rebuild_only_embeds_what_changed() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let mut lib = library();

    semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("first build");
    ollama.reset();

    // Nothing changed: no request at all, and the report still says the index is complete.
    let report = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("second build");
    assert_eq!(report.embedded, 3);
    assert!(report.complete);
    assert_eq!(
        ollama.embed_calls(),
        0,
        "an unchanged library costs nothing"
    );

    // One edited record is re-embedded on its own.
    lib.resources[1].title = "Yazılım Mimarisi".to_string();
    ollama.reset();
    let report = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("third build");
    assert_eq!(report.embedded, 3);
    assert_eq!(ollama.embedded_inputs(), 1, "only the edited record");

    // A deleted bookmark leaves the index with it, and cannot be returned by a search.
    lib.resources.remove(2);
    ollama.reset();
    semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("fourth build");
    assert_eq!(ollama.embedded_inputs(), 0, "deleting embeds nothing");
    assert_eq!(semantic::status(&dirs.cache).indexed, 2);
    let ranked = semantic::rank_async(&lib, &dirs.data, &dirs.cache, "sourdough bread", 10)
        .await
        .expect("rank");
    assert!(!ids(&ranked.hits).contains(&"r3"), "{ranked:?}");
}

#[tokio::test]
async fn a_different_model_rebuilds_the_whole_index() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest", "bge-m3:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = library();

    let report = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("build");
    assert_eq!(report.model, "nomic-embed-text:latest");

    // The preferred model is uninstalled; vectors from two models cannot be compared.
    ollama.install_only(&["bge-m3:latest"]);
    ollama.reset();
    let report = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("rebuild");
    assert_eq!(report.model, "bge-m3:latest");
    assert_eq!(report.embedded, 3);
    assert_eq!(
        ollama.embedded_inputs(),
        3,
        "every record is embedded again"
    );
    let status = semantic::status(&dirs.cache);
    assert_eq!(status.model.as_deref(), Some("bge-m3:latest"));
    assert_eq!(status.indexed, 3);
}

#[tokio::test]
async fn the_model_chosen_in_settings_wins_over_the_server_s_pick() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest", "bge-m3:latest"], 0).await;
    let dirs = dirs_with_model(&ollama.server.base(), false, " bge-m3:latest ");
    let lib = library();

    let report = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("build");
    assert_eq!(
        report.model, "bge-m3:latest",
        "the setting is trimmed and used"
    );
    assert_eq!(
        ollama.server.hits("/api/tags"),
        0,
        "a chosen model is not looked up on the server first"
    );
    let requested: Vec<String> = ollama
        .server
        .requests_to("/api/embed")
        .iter()
        .map(|request| {
            request.json()["model"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    assert!(!requested.is_empty());
    assert!(
        requested.iter().all(|model| model == "bge-m3:latest"),
        "{requested:?}"
    );
}

#[tokio::test]
async fn a_spent_budget_stops_the_build_and_the_next_call_finishes_it() {
    assert_no_model_override();
    // Slow enough that the budget is gone after the first batch of 32.
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 80).await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = big_library(40);

    let report = semantic::build(
        &lib,
        &dirs.data,
        &dirs.cache,
        BuildOptions {
            time_budget: Some(Duration::from_millis(20)),
            on_progress: None,
        },
    )
    .await
    .expect("partial build");
    assert!(!report.complete, "the budget ran out: {report:?}");
    assert!(report.embedded < 40, "{report:?}");
    assert_eq!(report.total, 40);
    let stored = report.embedded;

    // The rest is picked up by the next call, and nothing already stored is embedded twice.
    ollama.reset();
    let report = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("finishing build");
    assert!(report.complete, "{report:?}");
    assert_eq!(report.embedded, 40);
    assert_eq!(
        ollama.embedded_inputs(),
        40 - stored,
        "only what the first call did not store is embedded again"
    );
    assert_eq!(semantic::status(&dirs.cache).indexed, 40);
}

/// An `embed` already in flight must not hold the caller for its own 60-second timeout.
#[tokio::test]
async fn the_budget_also_cuts_a_batch_that_is_already_in_flight() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 2000).await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = library();

    let started = std::time::Instant::now();
    let report = semantic::build(
        &lib,
        &dirs.data,
        &dirs.cache,
        BuildOptions {
            time_budget: Some(Duration::from_millis(100)),
            on_progress: None,
        },
    )
    .await
    .expect("partial build");
    let elapsed = started.elapsed();

    assert!(!report.complete, "{report:?}");
    assert_eq!(report.embedded, 0, "the only batch never came back");
    assert!(
        elapsed < Duration::from_millis(1500),
        "the budget has to be an upper bound, waited {elapsed:?}"
    );
    assert_eq!(semantic::status(&dirs.cache).indexed, 0);
}

#[tokio::test]
async fn a_partly_built_index_answers_with_a_note_that_says_so() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    app_lib::library::save(&dirs.data, &library_json(4)).expect("seed");

    // Only the first two of the four records reach the index.
    semantic::rank_async(&big_library(2), &dirs.data, &dirs.cache, "number0", 5)
        .await
        .expect("rank");
    assert_eq!(semantic::status(&dirs.cache).indexed, 2);

    // Ollama can still embed the query, but not the batch the top-up would need.
    ollama.refuse_batches(true);
    let engine = Engine::new(&dirs.data, &dirs.cache);
    let answer = engine
        .search(&SearchRequest {
            query: "number1".into(),
            ..SearchRequest::default()
        })
        .await
        .expect("search");

    let note = answer["note"].as_str().unwrap_or_default();
    assert!(note.contains("semantic index 2 of 4 built"), "{note}");
    assert!(note.contains("mynk-mcp index"), "{note}");
    assert_eq!(
        answer["hits"][0]["id"], "r1",
        "a partial index still answers: {answer}"
    );
    assert_eq!(semantic::status(&dirs.cache).indexed, 2);
}

#[tokio::test]
async fn repeated_searches_resolve_the_model_once() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = library();

    semantic::rank_async(&lib, &dirs.data, &dirs.cache, "rust ownership", 5)
        .await
        .expect("rank");
    let probes = ollama.server.hits("/api/tags");
    assert!(probes <= 1, "one probe is enough to start, made {probes}");

    for query in ["sourdough bread", "yazılım", "kombucha"] {
        semantic::rank_async(&lib, &dirs.data, &dirs.cache, query, 5)
            .await
            .expect("rank");
    }
    assert_eq!(
        ollama.server.hits("/api/tags"),
        probes,
        "later searches reuse the model instead of probing again"
    );
}

#[tokio::test]
async fn a_budget_that_is_already_gone_embeds_nothing() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = library();

    let report = semantic::build(
        &lib,
        &dirs.data,
        &dirs.cache,
        BuildOptions {
            time_budget: Some(Duration::ZERO),
            on_progress: None,
        },
    )
    .await
    .expect("build");
    assert_eq!(report.embedded, 0);
    assert!(!report.complete);
    assert_eq!(ollama.embed_calls(), 0);
    assert_eq!(semantic::status(&dirs.cache).indexed, 0);
}

#[tokio::test]
async fn an_ollama_without_an_embedding_model_says_what_to_pull() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["qwen3.5:9b", "llama3.2:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = library();

    let error = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect_err("nothing on this server can embed");
    assert!(matches!(error, SemanticError::Unavailable(_)), "{error:?}");
    assert_eq!(
        error.to_string(),
        "no embedding model on Ollama; run `ollama pull nomic-embed-text`"
    );
    // The same reason reaches the search, which is what the agent is told.
    let error = semantic::rank_async(&lib, &dirs.data, &dirs.cache, "rust", 10)
        .await
        .expect_err("no model");
    assert!(error.to_string().contains("ollama pull"), "{error}");
    assert_eq!(ollama.embed_calls(), 0, "no model, no embedding request");
}

#[tokio::test]
async fn a_private_base_url_is_refused_while_private_networks_are_off() {
    assert_no_model_override();
    let lib = library();
    // A LAN address, with the setting the app defaults to.
    let blocked = dirs("http://10.0.0.5:11434", false);
    let error = semantic::build(&lib, &blocked.data, &blocked.cache, BuildOptions::default())
        .await
        .expect_err("the address policy must refuse this");
    assert!(matches!(error, SemanticError::Unavailable(_)), "{error:?}");
    assert!(error.to_string().contains("10.0.0.5"), "{error}");
    assert!(
        error.to_string().contains("Allow private network"),
        "the message says how to allow it: {error}"
    );
    assert!(
        !app_lib::paths::semantic_index_path(&blocked.cache).exists(),
        "a refused build does not create an index"
    );

    // A metadata address stays blocked even when private networks are allowed.
    let metadata = dirs("http://169.254.169.254", true);
    let error = semantic::build(
        &lib,
        &metadata.data,
        &metadata.cache,
        BuildOptions::default(),
    )
    .await
    .expect_err("cloud metadata is never allowed");
    assert!(matches!(error, SemanticError::Unavailable(_)), "{error:?}");
}

#[tokio::test]
async fn the_index_survives_being_reopened_by_a_second_process() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = library();

    semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("build");

    // What `mynk-mcp doctor` does with a database the app wrote: read it without building.
    let status = semantic::status(&dirs.cache);
    assert_eq!(status.indexed, 3);

    // A second reader reloads the cached vectors instead of answering from a stale copy.
    semantic::forget_cached_vectors();
    let ranked = semantic::rank_async(&lib, &dirs.data, &dirs.cache, "yazılım rehberi", 10)
        .await
        .expect("rank");
    assert_eq!(ids(&ranked.hits)[0], "r2", "{ranked:?}");
}

/// A vector longer than the index can decode would make coverage look complete while every
/// search came back empty, so it is refused before it is stored.
#[tokio::test]
async fn an_embedding_too_long_to_store_is_refused() {
    assert_no_model_override();
    let server = TestServer::start().await;
    server.route("/api/tags", |_| {
        Reply::json(&json!({ "models": [{ "name": "nomic-embed-text:latest" }] }))
    });
    server.route("/api/embed", |request| {
        let inputs = request.json()["input"].as_array().map_or(0, Vec::len);
        let oversized = vec![0.5f32; app_lib::catalog::embed::index::MAX_DIM + 1];
        let embeddings: Vec<&Vec<f32>> = (0..inputs).map(|_| &oversized).collect();
        Reply::json(&json!({ "model": "nomic-embed-text:latest", "embeddings": embeddings }))
    });
    let dirs = dirs(&server.base(), false);
    let lib = Library {
        resources: vec![resource("r1", "Ownership in Rust", &["rust"], "")],
        ..library()
    };

    let error = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect_err("a vector that long can never be read back");
    assert!(matches!(error, SemanticError::Provider(_)), "{error:?}");
    assert!(error.to_string().contains("dimension"), "{error}");
    assert_eq!(
        semantic::status(&dirs.cache).indexed,
        0,
        "nothing unusable reaches the index"
    );
}

/// Two processes can resolve different models (an env override in one, a different `/api/tags`
/// order in the other). Neither may empty the other's work, and the index may not grow for it.
#[tokio::test]
async fn two_models_share_the_index_without_wiping_each_other() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest", "bge-m3:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = library();

    let first = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("build");
    assert_eq!(first.model, "nomic-embed-text:latest");

    // A second process resolves the other model and rebuilds with it.
    let index = app_lib::paths::semantic_index_path(&dirs.cache);
    let conn = rusqlite::Connection::open(&index).expect("open the index");
    conn.execute(
        "UPDATE embeddings SET model = 'bge-m3:latest', content_hash = 'other' \
         WHERE resource_id = 'r1'",
        [],
    )
    .expect("pretend the other process wrote r1");
    drop(conn);
    semantic::forget_cached_vectors();

    let again = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("rebuild");
    assert_eq!(again.model, "nomic-embed-text:latest");
    assert_eq!(again.embedded, 3);
    assert_eq!(
        semantic::status(&dirs.cache).indexed,
        3,
        "one row per record, whatever the model"
    );

    // The model the index already holds wins while the server still lists it.
    ollama.install_only(&["bge-m3:latest", "nomic-embed-text:latest"]);
    ollama.reset();
    semantic::forget_cached_vectors();
    let ranked = semantic::rank_async(&lib, &dirs.data, &dirs.cache, "rust ownership", 10)
        .await
        .expect("rank");
    assert_eq!(ids(&ranked.hits)[0], "r1", "{ranked:?}");
    assert_eq!(
        ranked.note, None,
        "nothing was re-embedded, so the index still covers the library: {ranked:?}"
    );
    assert_eq!(
        ollama.embedded_inputs(),
        1,
        "only the query is embedded again"
    );
}

#[tokio::test]
async fn an_unreadable_index_stops_the_build_instead_of_emptying_it() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let lib = library();

    semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("build");
    assert_eq!(semantic::status(&dirs.cache).indexed, 3);

    let index = app_lib::paths::semantic_index_path(&dirs.cache);
    // A `meta` the schema cannot read: opening recreates a missing table, but not a broken one.
    let conn = rusqlite::Connection::open(&index).expect("open the index");
    conn.execute_batch(
        "DROP TABLE meta; CREATE TABLE meta (key TEXT PRIMARY KEY, other TEXT NOT NULL);",
    )
    .expect("break meta");
    drop(conn);
    semantic::forget_cached_vectors();

    let error = semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect_err("the model row cannot be read");
    assert!(matches!(error, SemanticError::Io(_)), "{error:?}");
    assert_eq!(
        semantic::status(&dirs.cache).indexed,
        3,
        "the vectors survive a transient failure"
    );
}

#[tokio::test]
async fn the_embedded_text_carries_the_record_and_no_file_names() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    let mut lib = library();
    lib.resources[0].summary = vec!["Every value has a single owner.".to_string()];

    semantic::build(&lib, &dirs.data, &dirs.cache, BuildOptions::default())
        .await
        .expect("build");

    let sent: Vec<String> = ollama
        .server
        .requests_to("/api/embed")
        .iter()
        .flat_map(|request| {
            request.json()["input"]
                .as_array()
                .map(|inputs| {
                    inputs
                        .iter()
                        .map(|value| value.as_str().unwrap_or_default().to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(sent.len(), 3);
    let first = sent
        .iter()
        .find(|text| text.starts_with("Ownership in Rust"))
        .expect("the first record's text");
    for needle in [
        "tags: rust, memory",
        "category: development",
        "description: Borrowing and lifetimes explained",
        "summary: Every value has a single owner.",
    ] {
        assert!(first.contains(needle), "{needle} missing from {first:?}");
    }
    // The model is asked by name, and the payload is the documented shape.
    let body: HashMap<String, Value> = serde_json::from_slice(
        &ollama
            .server
            .requests_to("/api/embed")
            .first()
            .expect("a request")
            .body,
    )
    .expect("json body");
    assert_eq!(
        body.get("model").and_then(Value::as_str),
        Some("nomic-embed-text:latest")
    );
    assert!(body.get("input").is_some_and(Value::is_array));
}

#[test]
fn an_absent_index_has_an_empty_status() {
    let temp = tempfile::tempdir().expect("temp dir");
    let cache: &Path = temp.path();
    let status = semantic::status(cache);
    assert_eq!(status.indexed, 0);
    assert_eq!(status.model, None);
    assert_eq!(status.updated_at, None);
    assert!(!app_lib::paths::semantic_index_path(cache).exists());
}

#[tokio::test]
async fn a_filtered_semantic_search_ranks_among_the_records_the_filter_allows() {
    assert_no_model_override();
    let ollama = FakeOllama::start(&["nomic-embed-text:latest"], 0).await;
    let dirs = dirs(&ollama.server.base(), false);
    // 280 close matches outrank the 20 tagged ones, which share only one query word.
    let resources: Vec<Value> = (0..300)
        .map(|i| {
            let tagged = i % 15 == 0;
            json!({
                "id": format!("r{i}"),
                "url": format!("https://example.com/r{i}"),
                "title": if tagged { format!("Rust notes {i}") } else { format!("Rust ownership borrowing guide {i}") },
                "description": "",
                "categoryId": "development",
                "tags": if tagged { vec!["picked"] } else { vec!["bulk"] },
                "createdAt": 1_757_000_000_000i64,
            })
        })
        .collect();
    let json = json!({
        "version": 3,
        "savedAt": 1_757_700_000_000i64,
        "resources": resources,
        "collections": [],
    });
    app_lib::library::save(&dirs.data, &json.to_string()).expect("seed");

    let engine = Engine::new(&dirs.data, &dirs.cache);
    for mode in ["semantic", "hybrid"] {
        let answer = engine
            .search(&SearchRequest {
                query: "rust ownership borrowing".into(),
                mode: Some(mode.into()),
                limit: Some(10),
                tag: Some("picked".into()),
                ..SearchRequest::default()
            })
            .await
            .expect("search");
        let hits = answer["hits"].as_array().cloned().unwrap_or_default();
        assert_eq!(hits.len(), 10, "{mode}: {answer}");
        for hit in &hits {
            let id = hit["id"].as_str().unwrap_or_default();
            let number: usize = id.trim_start_matches('r').parse().unwrap_or(1);
            assert_eq!(number % 15, 0, "{mode}: {id} is not tagged");
        }
        assert_eq!(answer["modeUsed"], mode, "{answer}");
        let semantic_hits = hits
            .iter()
            .filter(|hit| hit["matchedBy"] != "keyword")
            .count();
        assert_eq!(
            semantic_hits, 10,
            "{mode}: the ranker saw the tagged records: {answer}"
        );
    }
}
