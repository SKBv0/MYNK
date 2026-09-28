//! Keeps `library.json` parsed between calls, keyed on the file's modification time and size.
//!
//! The app writes atomically (temp file + rename), so any change produces a new key.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use crate::catalog::model::{self, Library};
use crate::catalog::search::{search_fields, SearchFields};
use crate::error::AppResult;
use crate::library::LIBRARY_FILE;

/// `None` for the whole key means the file is not there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Key {
    modified: Option<SystemTime>,
    len: u64,
}

fn key_of(data_dir: &Path) -> Option<Key> {
    let metadata = std::fs::metadata(data_dir.join(LIBRARY_FILE)).ok()?;
    Some(Key {
        modified: metadata.modified().ok(),
        len: metadata.len(),
    })
}

/// One parse of the library, plus the search columns of the records in it.
#[derive(Debug)]
pub struct Loaded {
    library: Arc<Library>,
    fields: OnceLock<Vec<SearchFields>>,
}

impl Loaded {
    pub fn library(&self) -> &Arc<Library> {
        &self.library
    }

    /// Normalized once per version of the file, on the first question that needs them.
    pub fn fields(&self) -> &[SearchFields] {
        self.fields
            .get_or_init(|| self.library.resources.iter().map(search_fields).collect())
    }
}

/// A lazily loaded, re-validating view of the library on disk.
#[derive(Debug)]
pub struct LibraryCache {
    data_dir: PathBuf,
    cached: Mutex<Option<(Option<Key>, Arc<Loaded>)>>,
}

impl LibraryCache {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            cached: Mutex::new(None),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn load(&self) -> AppResult<Arc<Library>> {
        Ok(Arc::clone(self.loaded()?.library()))
    }

    /// Re-read only when the file changed. A parse failure is not cached, so the next call retries.
    pub fn loaded(&self) -> AppResult<Arc<Loaded>> {
        let key = key_of(&self.data_dir);
        let mut cached = crate::util::lock(&self.cached);
        if let Some((cached_key, loaded)) = cached.as_ref() {
            if *cached_key == key {
                return Ok(Arc::clone(loaded));
            }
        }
        let loaded = Arc::new(Loaded {
            library: Arc::new(model::load(&self.data_dir)?),
            fields: OnceLock::new(),
        });
        *cached = Some((key, Arc::clone(&loaded)));
        Ok(loaded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library_json(count: usize) -> String {
        let resources: Vec<serde_json::Value> = (0..count)
            .map(|i| {
                serde_json::json!({
                    "id": format!("r{i}"),
                    "url": format!("https://example.com/{i}"),
                    "title": format!("Record {i}"),
                    "createdAt": 1_757_289_600_000i64,
                })
            })
            .collect();
        serde_json::json!({ "version": 3, "savedAt": 1, "resources": resources, "collections": [] })
            .to_string()
    }

    #[test]
    fn an_unchanged_file_is_parsed_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        crate::library::save(dir.path(), &library_json(2)).expect("seed");
        let cache = LibraryCache::new(dir.path());

        let first = cache.load().expect("load");
        let second = cache.load().expect("load again");
        assert_eq!(first.resources.len(), 2);
        assert!(
            Arc::ptr_eq(&first, &second),
            "the second call must hand back the very same parse"
        );
    }

    #[test]
    fn the_search_columns_are_built_once_per_version_of_the_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        crate::library::save(dir.path(), &library_json(2)).expect("seed");
        let cache = LibraryCache::new(dir.path());

        let first = cache.loaded().expect("load");
        let columns = first.fields().as_ptr();
        assert_eq!(first.fields().len(), 2);
        let second = cache.loaded().expect("load again");
        assert!(
            std::ptr::eq(second.fields().as_ptr(), columns),
            "a second search must reuse the columns the first one normalized"
        );

        crate::library::save(dir.path(), &library_json(5)).expect("rewrite");
        let third = cache.loaded().expect("reload");
        assert_eq!(third.fields().len(), 5);
        assert!(
            !std::ptr::eq(third.fields().as_ptr(), columns),
            "a rewritten file has to be normalized again"
        );
    }

    #[test]
    fn a_rewritten_file_is_re_read() {
        let dir = tempfile::tempdir().expect("temp dir");
        crate::library::save(dir.path(), &library_json(2)).expect("seed");
        let cache = LibraryCache::new(dir.path());
        assert_eq!(cache.load().expect("load").resources.len(), 2);

        crate::library::save(dir.path(), &library_json(5)).expect("rewrite");
        let reloaded = cache.load().expect("reload");
        assert_eq!(reloaded.resources.len(), 5);
    }

    #[test]
    fn a_missing_library_is_cached_as_empty_and_noticed_when_it_appears() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = LibraryCache::new(dir.path());
        assert!(cache.load().expect("empty").resources.is_empty());

        crate::library::save(dir.path(), &library_json(1)).expect("seed");
        assert_eq!(
            cache
                .load()
                .expect("after the app wrote one")
                .resources
                .len(),
            1,
            "a library that appears must invalidate the empty answer"
        );
    }

    #[test]
    fn a_broken_library_is_an_error_and_is_not_cached() {
        let dir = tempfile::tempdir().expect("temp dir");
        crate::library::save(
            dir.path(),
            &serde_json::json!({ "version": 4, "resources": [] }).to_string(),
        )
        .expect("seed");
        let cache = LibraryCache::new(dir.path());
        assert!(cache.load().is_err(), "an unknown schema is refused");
        assert!(
            cache.load().is_err(),
            "and stays refused rather than cached"
        );
    }
}
