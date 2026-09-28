//! The single seam between this binary and the embedding index owned by
//! [`crate::catalog::semantic`]: a missing or unready index degrades to a reason, not a panic.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use crate::catalog::model::Library;
use crate::catalog::semantic::{self, BuildOptions, SemanticError};

pub use crate::catalog::semantic::{BuildProgress, BuildReport, IndexStatus, Ranked};

/// Budget for `mynk-mcp index`, more generous than the lazy build inside a search.
pub const CLI_BUILD_BUDGET: Duration = Duration::from_secs(30 * 60);

/// Ranks `query` against the embedding index, among `only` when set. `Err` is a normal answer:
/// the caller falls back to keyword search and passes the reason on.
pub async fn rank(
    lib: &Library,
    data_dir: &Path,
    cache_dir: &Path,
    query: &str,
    limit: usize,
    only: Option<&HashSet<&str>>,
) -> Result<Ranked, SemanticError> {
    semantic::rank_among(lib, data_dir, cache_dir, query, limit, only).await
}

/// Builds or refreshes the index, reporting progress after every batch.
pub async fn build(
    lib: &Library,
    data_dir: &Path,
    cache_dir: &Path,
    on_progress: Option<Box<dyn Fn(BuildProgress) + Send + Sync>>,
) -> Result<BuildReport, SemanticError> {
    semantic::build(
        lib,
        data_dir,
        cache_dir,
        BuildOptions {
            time_budget: Some(CLI_BUILD_BUDGET),
            on_progress,
        },
    )
    .await
}

/// What the index currently holds. Never fails: an unreadable index reads as an empty one.
pub fn status(cache_dir: &Path) -> IndexStatus {
    semantic::status(cache_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ranking_an_empty_library_answers_instead_of_failing_open() {
        let dir = tempfile::tempdir().expect("temp dir");
        let lib = Library::empty();
        match rank(&lib, dir.path(), dir.path(), "anything", 10, None).await {
            Ok(ranked) => assert!(ranked.hits.is_empty(), "nothing was indexed: {ranked:?}"),
            Err(error) => assert!(!error.to_string().is_empty(), "{error:?}"),
        }
    }

    #[tokio::test]
    async fn an_empty_query_is_refused_with_a_reason() {
        let dir = tempfile::tempdir().expect("temp dir");
        let error = rank(&Library::empty(), dir.path(), dir.path(), "   ", 10, None)
            .await
            .expect_err("nothing to embed");
        assert!(matches!(error, SemanticError::Unavailable(_)), "{error:?}");
    }

    #[test]
    fn an_absent_index_reports_as_empty() {
        let status = status(Path::new("/nonexistent/mynk-cache"));
        assert_eq!(status, IndexStatus::default());
        assert_eq!(status.indexed, 0);
        assert_eq!(status.model, None);
    }

    #[test]
    fn the_build_budget_is_generous_enough_to_finish_a_real_library() {
        assert!(CLI_BUILD_BUDGET >= Duration::from_secs(60));
    }
}
