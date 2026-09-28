//! Embedding client for Ollama: `GET /api/tags` to find a model, `POST /api/embed` to use it.
//! Separate from `crate::providers::ollama` (unavailable in `mynk-mcp`) but behind the same SSRF
//! guard. Read-only: nothing here pulls, creates or deletes a model.

use std::time::Duration;

use reqwest::Client;
use serde_json::json;
use url::Url;

use super::settings_file::EmbedSettings;
use crate::catalog::semantic::SemanticError;
use crate::error::{find_source, truncate_chars, MAX_ERROR_BODY_CHARS};
use crate::http::body::{read_limited, Overflow, API_BODY_LIMIT};
use crate::http::guard::{check_url, AddressPolicy, BlockedAddressError};
use crate::http::ollama::{build_client, endpoint, error_detail, TagModel, TagsResponse};
use crate::util::cap_chars;

/// One batch of 32 inputs is a single forward pass per input; a cold model has to load first.
pub const EMBED_TIMEOUT: Duration = Duration::from_secs(60);
const TAGS_TIMEOUT: Duration = Duration::from_secs(15);

/// Inputs per `/api/embed` call. Large enough that 20k records are 625 requests, small enough
/// that a cancelled or timed-out build loses very little work.
pub const BATCH_SIZE: usize = 32;
/// Characters per input. Embedding models truncate at their own context window anyway (512-8192
/// tokens); cutting here keeps the request bounded whatever the model is.
pub const MAX_INPUT_CHARS: usize = 2000;

/// What the user is told when Ollama answers but has nothing that can embed.
pub const NO_EMBEDDING_MODEL: &str =
    "no embedding model on Ollama; run `ollama pull nomic-embed-text`";

/// Model names preferred in this order (prefix match, registry path ignored): `nomic-embed-text`
/// first (small, fast), `bge-m3` as the multilingual fallback for a Turkish library.
const PREFERRED_MODELS: [&str; 2] = ["nomic-embed-text", "bge-m3"];

/// Families of embedding-only models as `/api/tags` reports them (`details.family(ies)`).
const EMBEDDING_FAMILIES: &[&str] = &[
    "bert",
    "nomic-bert",
    "nomic-bert-moe",
    "jina-bert",
    "jina-bert-v2",
    "xlm-roberta",
];
/// Name fragments of embedding models whose family is a chat architecture (qwen3-embedding, ...).
const EMBEDDING_NAME_HINTS: &[&str] = &["embed", "bge-", "all-minilm", "paraphrase-multilingual"];

/// A model `/api/tags` listed, and whether it embeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledModel {
    pub name: String,
    pub embedding: bool,
}

#[derive(Debug)]
pub struct EmbedClient {
    client: Client,
    base_url: String,
}

/// Maps a transport failure: a blocked address or refused connection means the index is
/// unavailable (and reported as a reason); anything else is the provider misbehaving.
fn send_error(base_url: &str, error: &reqwest::Error) -> SemanticError {
    if let Some(blocked) = find_source::<BlockedAddressError>(error) {
        return SemanticError::Unavailable(blocked.to_string());
    }
    if error.is_connect() {
        return SemanticError::Unavailable(format!(
            "could not connect to Ollama at {base_url}; make sure it is running"
        ));
    }
    if error.is_timeout() {
        return SemanticError::Provider(format!("the Ollama request to {base_url} timed out"));
    }
    SemanticError::Provider(truncate_chars(
        &format!("the Ollama request to {base_url} failed: {error}"),
        MAX_ERROR_BODY_CHARS,
    ))
}

fn http_error(context: &str, status: u16, raw: &[u8]) -> SemanticError {
    let detail = error_detail(raw);
    if detail.is_empty() {
        SemanticError::Provider(format!("{context} failed with HTTP {status}"))
    } else {
        SemanticError::Provider(format!("{context} failed with HTTP {status}: {detail}"))
    }
}

#[derive(Debug, serde::Deserialize)]
struct EmbedResponse {
    #[serde(default)]
    embeddings: Vec<Vec<f32>>,
    /// Ollama reports failures in the body even with a 200 status on some builds.
    #[serde(default)]
    error: Option<String>,
}

/// The model name without its registry path (`library/bge-m3:latest` → `bge-m3:latest`).
fn base_name(name: &str) -> String {
    name.rsplit('/').next().unwrap_or(name).to_lowercase()
}

/// `/api/tags` has no capability field, so embedding models are recognized by family and name.
/// The one rule for both the chat model list and the semantic index.
pub fn is_embedding_model(name: &str, family: Option<&str>, families: &[String]) -> bool {
    let family_match = family
        .into_iter()
        .chain(families.iter().map(String::as_str))
        .any(|f| EMBEDDING_FAMILIES.contains(&f.to_lowercase().as_str()));
    let base = base_name(name);
    family_match || EMBEDDING_NAME_HINTS.iter().any(|hint| base.contains(hint))
}

/// [`is_embedding_model`] for one `/api/tags` entry.
pub fn is_embedding_tag(tag: &TagModel) -> bool {
    let details = tag.details.as_ref();
    is_embedding_model(
        &tag.name,
        details.and_then(|d| d.family.as_deref()),
        details
            .and_then(|d| d.families.as_deref())
            .unwrap_or_default(),
    )
}

/// Picks the embedding model to use from what `/api/tags` listed. Deterministic: two processes
/// against the same server must land on the same model; ties resolve by name order.
pub fn pick_embedding_model(models: &[InstalledModel]) -> Option<String> {
    for preferred in PREFERRED_MODELS {
        let best = models
            .iter()
            .map(|model| &model.name)
            .filter(|name| base_name(name).starts_with(preferred))
            .min();
        if let Some(name) = best {
            return Some(name.clone());
        }
    }
    models
        .iter()
        .filter(|model| model.embedding)
        .map(|model| &model.name)
        .min()
        .cloned()
}

impl EmbedClient {
    /// Validates the base URL against the address policy and builds the client. Fails before a
    /// single packet is sent when the URL points somewhere the settings do not allow.
    pub fn new(settings: &EmbedSettings) -> Result<Self, SemanticError> {
        let policy = AddressPolicy::for_ollama(settings.allow_private_network);
        let url = Url::parse(&settings.ollama_base_url).map_err(|error| {
            SemanticError::Unavailable(format!("the Ollama base URL is not valid: {error}"))
        })?;
        check_url(&url, policy).map_err(|error| SemanticError::Unavailable(error.to_string()))?;
        let client = build_client(policy, EMBED_TIMEOUT).map_err(|error| {
            SemanticError::Unavailable(format!("the HTTP client could not be built: {error}"))
        })?;
        Ok(Self {
            client,
            base_url: settings.ollama_base_url.trim_end_matches('/').to_string(),
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn endpoint(&self, path: &str) -> String {
        endpoint(&self.base_url, path)
    }

    /// The models installed on the server (`GET /api/tags`), sorted by name.
    pub async fn installed_models(&self) -> Result<Vec<InstalledModel>, SemanticError> {
        let response = self
            .client
            .get(self.endpoint("api/tags"))
            .timeout(TAGS_TIMEOUT)
            .send()
            .await
            .map_err(|error| send_error(&self.base_url, &error))?;
        let status = response.status();
        let raw = read_limited(
            response,
            API_BODY_LIMIT,
            Overflow::Error,
            "Ollama model list",
        )
        .await
        .map_err(|error| SemanticError::Provider(error.to_string()))?;
        if !status.is_success() {
            return Err(http_error("the Ollama model list", status.as_u16(), &raw));
        }
        let parsed: TagsResponse = serde_json::from_slice(&raw).map_err(|error| {
            SemanticError::Provider(format!("invalid Ollama model list: {error}"))
        })?;
        let mut models: Vec<InstalledModel> = parsed
            .models
            .iter()
            .map(|tag| InstalledModel {
                name: tag.name.trim().to_string(),
                embedding: is_embedding_tag(tag),
            })
            // A name the index stores and a hint prints has to be plain text.
            .filter(|model| crate::util::is_plain_model_name(&model.name))
            .collect();
        models.sort_by(|a, b| a.name.cmp(&b.name));
        models.dedup_by(|a, b| a.name == b.name);
        models.truncate(crate::util::MAX_LOCAL_MODELS);
        Ok(models)
    }

    /// Embeds `inputs` in one `POST /api/embed`; the answer must have one vector per input, same
    /// order, same dimension, or it is a provider error.
    pub async fn embed(
        &self,
        model: &str,
        inputs: &[String],
    ) -> Result<Vec<Vec<f32>>, SemanticError> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        let clipped: Vec<&str> = inputs
            .iter()
            .map(|input| cap_chars(input, MAX_INPUT_CHARS))
            .collect();
        let body = json!({ "model": model, "input": clipped });
        let response = self
            .client
            .post(self.endpoint("api/embed"))
            .json(&body)
            .send()
            .await
            .map_err(|error| send_error(&self.base_url, &error))?;
        let status = response.status();
        let raw = read_limited(
            response,
            API_BODY_LIMIT,
            Overflow::Error,
            "Ollama embeddings",
        )
        .await
        .map_err(|error| SemanticError::Provider(error.to_string()))?;
        if !status.is_success() {
            // A model that is not installed comes back as 404; the error names it.
            if status == reqwest::StatusCode::NOT_FOUND {
                return Err(SemanticError::Unavailable(format!(
                    "the embedding model \"{model}\" is not installed on Ollama; run `ollama pull {model}`"
                )));
            }
            return Err(http_error(
                "the Ollama embedding request",
                status.as_u16(),
                &raw,
            ));
        }
        let parsed: EmbedResponse = serde_json::from_slice(&raw).map_err(|error| {
            SemanticError::Provider(format!("invalid Ollama embedding response: {error}"))
        })?;
        if let Some(error) = parsed.error {
            return Err(SemanticError::Provider(format!(
                "Ollama embedding error: {}",
                truncate_chars(&error, MAX_ERROR_BODY_CHARS)
            )));
        }
        if parsed.embeddings.len() != inputs.len() {
            return Err(SemanticError::Provider(format!(
                "Ollama returned {} embeddings for {} inputs",
                parsed.embeddings.len(),
                inputs.len()
            )));
        }
        let dim = parsed.embeddings.first().map_or(0, Vec::len);
        if dim == 0 {
            return Err(SemanticError::Provider(
                "Ollama returned an empty embedding".to_string(),
            ));
        }
        // Stored, such a vector could never be decoded again: coverage would look complete while
        // every search came back empty.
        if dim > super::index::MAX_DIM {
            return Err(SemanticError::Provider(format!(
                "Ollama returned a {dim}-dimension embedding, more than the {} this index stores",
                super::index::MAX_DIM
            )));
        }
        if parsed.embeddings.iter().any(|vector| vector.len() != dim) {
            return Err(SemanticError::Provider(
                "Ollama returned embeddings of different sizes".to_string(),
            ));
        }
        if parsed
            .embeddings
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
        {
            return Err(SemanticError::Provider(
                "Ollama returned an embedding that is not a number".to_string(),
            ));
        }
        Ok(parsed.embeddings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<InstalledModel> {
        list.iter()
            .map(|name| InstalledModel {
                name: (*name).to_string(),
                embedding: is_embedding_model(name, None, &[]),
            })
            .collect()
    }

    #[test]
    fn the_preferred_model_wins_over_the_merely_possible_one() {
        assert_eq!(
            pick_embedding_model(&names(&[
                "qwen3.5:9b",
                "bge-m3:latest",
                "nomic-embed-text:latest",
                "mxbai-embed-large:latest",
            ])),
            Some("nomic-embed-text:latest".to_string())
        );
        assert_eq!(
            pick_embedding_model(&names(&["qwen3.5:9b", "mxbai-embed-large", "bge-m3:567m"])),
            Some("bge-m3:567m".to_string())
        );
        assert_eq!(
            pick_embedding_model(&names(&["llama3.2:latest", "qwen3-embedding:0.6b"])),
            Some("qwen3-embedding:0.6b".to_string())
        );
        assert_eq!(
            pick_embedding_model(&names(&["library/nomic-embed-text:v1.5"])),
            Some("library/nomic-embed-text:v1.5".to_string()),
            "a registry path does not hide the model name"
        );
        // Two equally preferred tags resolve by name, not by the order the server listed them.
        for order in [
            names(&["nomic-embed-text:latest", "nomic-embed-text:v1.5"]),
            names(&["nomic-embed-text:v1.5", "nomic-embed-text:latest"]),
        ] {
            assert_eq!(
                pick_embedding_model(&order),
                Some("nomic-embed-text:latest".to_string())
            );
        }
    }

    #[test]
    fn models_the_chat_list_calls_embedding_are_the_ones_the_index_can_pick() {
        for name in [
            "all-minilm:latest",
            "bge-large:latest",
            "paraphrase-multilingual",
        ] {
            assert_eq!(
                pick_embedding_model(&names(&["llama3.2:latest", name])),
                Some(name.to_string())
            );
        }
        let tags = serde_json::from_str::<TagsResponse>(
            r#"{"models":[{"name":"llama3.2:latest","details":{"family":"llama"}},
                {"name":"custom:latest","details":{"family":"nomic-bert"}}]}"#,
        )
        .expect("tags");
        let installed: Vec<InstalledModel> = tags
            .models
            .iter()
            .map(|tag| InstalledModel {
                name: tag.name.clone(),
                embedding: is_embedding_tag(tag),
            })
            .collect();
        assert_eq!(
            pick_embedding_model(&installed),
            Some("custom:latest".to_string()),
            "the family alone marks an embedding model"
        );
    }

    #[test]
    fn embedding_models_are_recognized_by_family_and_name() {
        let families = |list: &[&str]| list.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert!(is_embedding_model(
            "nomic-embed-text:latest",
            Some("nomic-bert"),
            &families(&["nomic-bert"])
        ));
        assert!(is_embedding_model(
            "bge-m3:latest",
            Some("bert"),
            &families(&["bert"])
        ));
        assert!(is_embedding_model(
            "qwen3-embedding:0.6b",
            Some("qwen3"),
            &families(&["qwen3"])
        ));
        assert!(is_embedding_model("library/mxbai-embed-large", None, &[]));
        assert!(!is_embedding_model(
            "qwen3.5:9b",
            Some("qwen35"),
            &families(&["qwen35"])
        ));
        assert!(!is_embedding_model("qwen3.6:27b-q4_K_M", None, &[]));
        assert!(!is_embedding_model("llama3.2:latest", Some("llama"), &[]));
    }

    #[test]
    fn a_server_without_an_embedding_model_picks_nothing() {
        assert_eq!(
            pick_embedding_model(&names(&["qwen3.5:9b", "llama3.2:latest", "gemma3:12b"])),
            None
        );
        assert_eq!(pick_embedding_model(&[]), None);
        assert_eq!(
            pick_embedding_model(&names(&["", "   "])),
            None,
            "a nameless entry is never the model to embed with"
        );
        assert_eq!(
            pick_embedding_model(&names(&["", "bge-m3:latest"])),
            Some("bge-m3:latest".to_string())
        );
    }

    #[test]
    fn a_blocked_base_url_is_refused_before_any_request() {
        let error = EmbedClient::new(&EmbedSettings {
            ollama_base_url: "http://10.0.0.5:11434".to_string(),
            allow_private_network: false,
            embedding_model: None,
        })
        .expect_err("a private address must be refused");
        assert!(matches!(error, SemanticError::Unavailable(_)), "{error:?}");
        assert!(error.to_string().contains("10.0.0.5"), "{error}");

        assert!(EmbedClient::new(&EmbedSettings {
            ollama_base_url: "http://10.0.0.5:11434".to_string(),
            allow_private_network: true,
            embedding_model: None,
        })
        .is_ok());
        let client = EmbedClient::new(&EmbedSettings::default()).expect("loopback is allowed");
        assert_eq!(client.base_url(), "http://127.0.0.1:11434");
        assert_eq!(
            client.endpoint("api/embed"),
            "http://127.0.0.1:11434/api/embed"
        );
    }

    #[test]
    fn http_errors_read_as_sentences() {
        let error = http_error("the Ollama model list", 500, br#"{"error":"boom"}"#);
        assert_eq!(
            error.to_string(),
            "the Ollama model list failed with HTTP 500: boom"
        );
        let empty = http_error("the Ollama embedding request", 502, b"  ");
        assert_eq!(
            empty.to_string(),
            "the Ollama embedding request failed with HTTP 502"
        );
    }
}
