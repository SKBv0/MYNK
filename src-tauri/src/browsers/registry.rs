//! Opaque profile id → filesystem source. The renderer only ever sees the id.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

use crate::snapshot::cleanup::short_hash;

/// `BrowserFamily` in ipcTypes.ts.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum BrowserFamily {
    Chrome,
    Edge,
    Brave,
    Vivaldi,
    Opera,
    Firefox,
}

impl BrowserFamily {
    pub fn key(self) -> &'static str {
        match self {
            BrowserFamily::Chrome => "chrome",
            BrowserFamily::Edge => "edge",
            BrowserFamily::Brave => "brave",
            BrowserFamily::Vivaldi => "vivaldi",
            BrowserFamily::Opera => "opera",
            BrowserFamily::Firefox => "firefox",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceKind {
    /// Chromium `Bookmarks` JSON file.
    ChromiumBookmarks(PathBuf),
    /// Firefox `places.sqlite`.
    FirefoxPlaces(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileSource {
    pub browser: BrowserFamily,
    pub profile_name: String,
    pub kind: SourceKind,
}

impl ProfileSource {
    fn path(&self) -> &PathBuf {
        match &self.kind {
            SourceKind::ChromiumBookmarks(p) | SourceKind::FirefoxPlaces(p) => p,
        }
    }

    /// Stable opaque id: `<browser>-<sha256(path) prefix>`.
    pub fn id(&self) -> String {
        format!(
            "{}-{}",
            self.browser.key(),
            short_hash(self.path().to_string_lossy().as_bytes(), 8)
        )
    }
}

#[derive(Debug, Default)]
pub struct ProfileRegistry {
    profiles: Mutex<HashMap<String, ProfileSource>>,
}

impl ProfileRegistry {
    /// Replaces the registry content with the latest detection result.
    pub fn replace(&self, sources: &[ProfileSource]) {
        let mut map = crate::util::lock(&self.profiles);
        map.clear();
        for source in sources {
            map.insert(source.id(), source.clone());
        }
    }

    pub fn get(&self, id: &str) -> Option<ProfileSource> {
        crate::util::lock(&self.profiles).get(id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_opaque_and_stable() {
        let source = ProfileSource {
            browser: BrowserFamily::Chrome,
            profile_name: "Default".into(),
            kind: SourceKind::ChromiumBookmarks(PathBuf::from(r"C:\Users\a\Bookmarks")),
        };
        let id = source.id();
        assert!(id.starts_with("chrome-"));
        assert!(!id.contains("Users"));
        assert_eq!(id, source.id());

        let registry = ProfileRegistry::default();
        registry.replace(std::slice::from_ref(&source));
        assert_eq!(registry.get(&id), Some(source));
        assert_eq!(registry.get("chrome-unknown"), None);
    }
}
