//! `mynk-mcp doctor`: directories, library, inbox, index and Ollama, in one report.
//!
//! Nothing here fails: a section that cannot be determined reports `unavailable` instead.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use url::Url;

use crate::catalog::embed::ollama::is_embedding_tag;
use crate::catalog::embed::settings_file::{self, EmbedSettings};
use crate::catalog::inbox;
use crate::catalog::model::SCHEMA_VERSION;
use crate::http::body::{read_limited, Overflow, API_BODY_LIMIT};
use crate::http::guard::{check_url, AddressPolicy};
use crate::http::ollama::TagsResponse;
use crate::http::HttpClients;
use crate::library::LIBRARY_FILE;

use super::engine::Engine;
use super::running;
use super::semantic_link;
use super::time;

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// One section of the report: reachable, or a short reason why not.
fn probe_result(ok: bool, detail: impl Into<String>) -> Value {
    json!({ "ok": ok, "detail": detail.into() })
}

/// Why the app would refuse to contact the configured Ollama address, in the app's own words.
fn refusal(settings: &EmbedSettings) -> Option<String> {
    let url = match Url::parse(&settings.ollama_base_url) {
        Ok(url) => url,
        Err(error) => return Some(format!("Ollama base URL is not valid: {error}")),
    };
    check_url(
        &url,
        AddressPolicy::for_ollama(settings.allow_private_network),
    )
    .err()
    .map(|error| error.to_string())
}

/// Probes Ollama through the app's guarded HTTP client, so SSRF policy applies here too. The
/// address comes from the same tolerant reader the embedding client uses.
async fn probe_ollama(settings: &EmbedSettings) -> Value {
    if let Some(reason) = refusal(settings) {
        return probe_result(false, format!("unavailable: {reason}"));
    }
    let clients = match HttpClients::new() {
        Ok(clients) => clients,
        Err(error) => return probe_result(false, format!("unavailable: {error}")),
    };
    let url = format!("{}/api/tags", settings.ollama_base_url);
    let response = clients
        .ollama(settings.allow_private_network)
        .get(&url)
        .timeout(PROBE_TIMEOUT)
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {
            let reachable = format!("reachable at {}", settings.ollama_base_url);
            let raw = match read_limited(
                response,
                API_BODY_LIMIT,
                Overflow::Error,
                "Ollama model list",
            )
            .await
            {
                Ok(raw) => raw,
                Err(error) => {
                    return probe_result(
                        false,
                        format!("{reachable}, but its model list could not be read: {error}"),
                    )
                }
            };
            match settings.embedding_model.as_deref() {
                Some(chosen) if lists_model(&raw, chosen) => probe_result(true, reachable),
                Some(chosen) => probe_result(
                    false,
                    format!("{reachable}, but the embedding model \"{chosen}\" chosen in Settings is not installed"),
                ),
                None if has_embedding_model(&raw) => probe_result(true, reachable),
                None => probe_result(
                    false,
                    format!("{reachable}, but no embedding model is installed; run `ollama pull nomic-embed-text`"),
                ),
            }
        }
        Ok(response) => probe_result(
            false,
            format!(
                "{} answered HTTP {}",
                settings.ollama_base_url,
                response.status().as_u16()
            ),
        ),
        Err(_) => probe_result(
            false,
            format!(
                "unavailable: {} could not be reached",
                settings.ollama_base_url
            ),
        ),
    }
}

/// The whole report as JSON. `--json` prints this; the human-readable form is rendered from it.
pub async fn report(engine: &Engine) -> Value {
    let data_dir: PathBuf = engine.data_dir().to_path_buf();
    let library = match engine.library() {
        // An absent file reads as an empty library; the user needs to hear that it is absent.
        Ok(_)
            if !data_dir.join(LIBRARY_FILE).exists()
                && !data_dir.join(format!("{LIBRARY_FILE}.bak")).exists() =>
        {
            json!({
            "ok": false,
            "expectedSchemaVersion": SCHEMA_VERSION,
            "detail": format!("no {LIBRARY_FILE} in the data dir yet; open MYNK once to create it"),
            })
        }
        Ok(library) => json!({
            "ok": true,
            "schemaVersion": library.version,
            "expectedSchemaVersion": SCHEMA_VERSION,
            "bookmarks": library.resources.len(),
            "collections": library.collections.len(),
            "unreadableRecords": library.skipped,
            "savedAt": time::to_iso_opt(Some(library.saved_at)),
        }),
        Err(error) => json!({
            "ok": false,
            "expectedSchemaVersion": SCHEMA_VERSION,
            "detail": error.to_string(),
        }),
    };

    let settings = settings_file::load(&data_dir);
    let index = semantic_link::status(engine.cache_dir());
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": data_dir.display().to_string(),
        "cacheDir": engine.cache_dir().display().to_string(),
        "library": library,
        "inbox": {
            "pending": inbox::count(&data_dir),
            "setAside": inbox::set_aside_count(&data_dir),
        },
        "app": { "running": running::app_is_running(&data_dir, time::now_ms()) },
        "semanticIndex": {
            "indexed": index.indexed,
            "model": index.model,
            "chosenModel": settings.embedding_model,
            "updatedAt": time::to_iso_opt(index.updated_at),
        },
        "ollama": probe_ollama(&settings).await,
    })
}

/// Whether a `/api/tags` body lists any model the semantic index could embed with.
fn has_embedding_model(raw: &[u8]) -> bool {
    serde_json::from_slice::<TagsResponse>(raw)
        .map(|parsed| parsed.models.iter().any(is_embedding_tag))
        .unwrap_or(false)
}

/// `doctor` exits non-zero only for this: without a readable library nothing else can work.
pub fn is_healthy(report: &Value) -> bool {
    report["library"]["ok"] == Value::Bool(true)
}

/// Whether a `/api/tags` body names `model` (exact name, or the same name with a `:latest` tag).
fn lists_model(raw: &[u8], model: &str) -> bool {
    let Ok(parsed) = serde_json::from_slice::<Value>(raw) else {
        return false;
    };
    let wanted = model.trim_end_matches(":latest");
    parsed["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["name"].as_str())
        .any(|name| name == model || name.trim_end_matches(":latest") == wanted)
}

fn flag(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

fn text_or(value: &Value, fallback: &str) -> String {
    value.as_str().unwrap_or(fallback).to_string()
}

/// The human-readable rendering of [`report`].
pub fn render(report: &Value) -> String {
    let mut lines = vec![
        format!("mynk-mcp {}", text_or(&report["version"], "?")),
        format!("data dir   {}", text_or(&report["dataDir"], "unavailable")),
        format!("cache dir  {}", text_or(&report["cacheDir"], "unavailable")),
    ];
    let library = &report["library"];
    if library["ok"] == Value::Bool(true) {
        lines.push(format!(
            "library    schema {} (expects {}), {} bookmarks, {} collections, {} unreadable",
            library["schemaVersion"],
            library["expectedSchemaVersion"],
            library["bookmarks"],
            library["collections"],
            library["unreadableRecords"],
        ));
    } else {
        lines.push(format!(
            "library    unavailable: {}",
            text_or(&library["detail"], "unknown")
        ));
    }
    lines.push(format!(
        "inbox      {} waiting, {} set aside as unreadable",
        report["inbox"]["pending"], report["inbox"]["setAside"]
    ));
    lines.push(format!(
        "app open   {}",
        flag(report["app"]["running"] == Value::Bool(true))
    ));
    let index = &report["semanticIndex"];
    lines.push(match index["model"].as_str() {
        Some(model) => format!(
            "index      {} embedded with {} (updated {})",
            index["indexed"],
            model,
            text_or(&index["updatedAt"], "never")
        ),
        None => "index      unavailable: no embedding index has been built yet".to_string(),
    });
    if let Some(chosen) = index["chosenModel"].as_str() {
        lines.push(format!("model      {chosen} (chosen in Settings)"));
    }
    let ollama = &report["ollama"];
    lines.push(format!(
        "ollama     {}",
        text_or(&ollama["detail"], "unavailable")
    ));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_probed_address_is_the_one_the_embedding_client_uses() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(settings_file::load(dir.path()), EmbedSettings::default());

        std::fs::write(
            settings_file::settings_path(dir.path()),
            json!({
                "ai": {
                    "provider": 7,
                    "ollamaBaseUrl": "http://127.0.0.1:11500",
                    "ollamaModel": null,
                    "allowPrivateNetwork": true
                },
                "somethingElse": { "kept": true }
            })
            .to_string(),
        )
        .expect("write");
        let settings = settings_file::load(dir.path());
        assert_eq!(settings.ollama_base_url, "http://127.0.0.1:11500");
        assert!(settings.allow_private_network);
    }

    #[tokio::test]
    async fn an_address_the_app_refuses_is_reported_as_unreachable() {
        let settings = |url: &str, allow_private_network: bool| EmbedSettings {
            ollama_base_url: url.to_string(),
            allow_private_network,
            embedding_model: None,
        };
        let metadata = settings("http://169.254.169.254", true);
        let expected = check_url(
            &Url::parse(&metadata.ollama_base_url).expect("url"),
            AddressPolicy::for_ollama(true),
        )
        .expect_err("metadata is never allowed")
        .to_string();
        let probe = probe_ollama(&metadata).await;
        assert_eq!(probe["ok"], false, "{probe}");
        assert_eq!(probe["detail"], format!("unavailable: {expected}"));

        let private = settings("http://10.0.0.5:11434", false);
        assert!(refusal(&private).is_some_and(|reason| reason.contains("Allow private network")));
        assert_eq!(refusal(&settings("http://10.0.0.5:11434", true)), None);
        assert_eq!(refusal(&settings("http://127.0.0.1:11434", false)), None);
        assert!(refusal(&settings("not a url", false)).is_some());
    }

    #[test]
    fn the_report_renders_every_section_even_when_nothing_works() {
        let report = json!({
            "version": "0.1.0",
            "dataDir": "C:\\data",
            "cacheDir": "C:\\cache",
            "library": { "ok": false, "detail": "MYNK library schema 4 is not supported" },
            "inbox": { "pending": 3, "setAside": 2 },
            "app": { "running": false },
            "semanticIndex": { "indexed": 0, "model": null, "updatedAt": null },
            "ollama": { "ok": false, "detail": "unavailable: http://127.0.0.1:11434 could not be reached" }
        });
        let text = render(&report);
        assert!(text.contains("mynk-mcp 0.1.0"), "{text}");
        assert!(
            text.contains("library    unavailable: MYNK library schema 4"),
            "{text}"
        );
        assert!(
            text.contains("inbox      3 waiting, 2 set aside as unreadable"),
            "{text}"
        );
        assert!(text.contains("app open   no"), "{text}");
        assert!(text.contains("index      unavailable"), "{text}");
        assert!(text.contains("ollama     unavailable"), "{text}");
        assert_eq!(text.lines().count(), 8);
    }

    #[test]
    fn a_healthy_report_names_the_numbers() {
        let report = json!({
            "version": "0.1.0",
            "dataDir": "/data",
            "cacheDir": "/cache",
            "library": {
                "ok": true,
                "schemaVersion": 3,
                "expectedSchemaVersion": 3,
                "bookmarks": 42,
                "collections": 2,
                "unreadableRecords": 0,
                "savedAt": "2025-09-08T00:00:00Z"
            },
            "inbox": { "pending": 0, "setAside": 0 },
            "app": { "running": true },
            "semanticIndex": { "indexed": 40, "model": "bge-m3", "updatedAt": "2025-09-08T00:00:00Z" },
            "ollama": { "ok": true, "detail": "reachable at http://127.0.0.1:11434" }
        });
        let text = render(&report);
        assert!(text.contains("42 bookmarks"), "{text}");
        assert!(text.contains("app open   yes"), "{text}");
        assert!(text.contains("40 embedded with bge-m3"), "{text}");
        assert!(text.contains("ollama     reachable"), "{text}");
    }

    #[test]
    fn a_tags_body_lists_a_model_with_or_without_the_latest_tag() {
        let tags =
            json!({ "models": [{ "name": "bge-m3:latest" }, { "name": "nomic-embed-text:v1.5" }] })
                .to_string();
        assert!(lists_model(tags.as_bytes(), "bge-m3"));
        assert!(lists_model(tags.as_bytes(), "bge-m3:latest"));
        assert!(lists_model(tags.as_bytes(), "nomic-embed-text:v1.5"));
        assert!(!lists_model(tags.as_bytes(), "nomic-embed-text"));
        assert!(!lists_model(b"not json", "bge-m3"));
        assert!(!lists_model(b"{}", "bge-m3"));
    }

    #[tokio::test]
    async fn an_unreadable_library_still_produces_a_full_report() {
        let dir = tempfile::tempdir().expect("temp dir");
        crate::library::save(
            dir.path(),
            &json!({ "version": 4, "resources": [] }).to_string(),
        )
        .expect("seed");
        let engine = Engine::new(dir.path(), dir.path().join("cache"));
        let report = report(&engine).await;
        assert_eq!(report["library"]["ok"], false);
        assert!(report["library"]["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("schema 4"));
        assert_eq!(report["inbox"]["pending"], 0);
        assert_eq!(report["inbox"]["setAside"], 0);
        assert_eq!(report["app"]["running"], false);
        assert_eq!(report["semanticIndex"]["indexed"], 0);
        assert!(report["ollama"]["ok"].is_boolean());
        assert!(!text_or(&report["ollama"]["detail"], "").is_empty());
        assert!(!render(&report).is_empty());
    }
}
