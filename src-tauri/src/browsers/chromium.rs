//! Chromium-family browsers (Chrome, Edge, Brave, Vivaldi, Opera).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;

use super::registry::{BrowserFamily, ProfileSource, SourceKind};
use super::{is_importable_url, ImportedBookmark};
use crate::error::{AppError, AppResult};

const MAX_BOOKMARKS_BYTES: u64 = 64 * 1024 * 1024;
/// Milliseconds between 1601-01-01 (WebKit/Windows epoch) and 1970-01-01.
const WEBKIT_EPOCH_OFFSET_MS: i64 = 11_644_473_600_000;

/// Converts a Chromium `date_added` (µs since 1601-01-01, as a string) to epoch ms.
pub fn webkit_to_epoch_ms(raw: &str) -> Option<i64> {
    let micros: i64 = raw.trim().parse().ok()?;
    if micros <= 0 {
        return None;
    }
    let ms = micros / 1000 - WEBKIT_EPOCH_OFFSET_MS;
    (ms > 0).then_some(ms)
}

/// (family, user-data dir, whether the dir itself is the profile, as with Opera).
fn user_data_dirs() -> Vec<(BrowserFamily, PathBuf, bool)> {
    let mut dirs_out = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = dirs::data_local_dir() {
            dirs_out.push((
                BrowserFamily::Chrome,
                local.join(r"Google\Chrome\User Data"),
                false,
            ));
            dirs_out.push((
                BrowserFamily::Chrome,
                local.join(r"Chromium\User Data"),
                false,
            ));
            dirs_out.push((
                BrowserFamily::Edge,
                local.join(r"Microsoft\Edge\User Data"),
                false,
            ));
            dirs_out.push((
                BrowserFamily::Brave,
                local.join(r"BraveSoftware\Brave-Browser\User Data"),
                false,
            ));
            dirs_out.push((
                BrowserFamily::Vivaldi,
                local.join(r"Vivaldi\User Data"),
                false,
            ));
        }
        if let Some(roaming) = dirs::data_dir() {
            dirs_out.push((
                BrowserFamily::Opera,
                roaming.join(r"Opera Software\Opera Stable"),
                true,
            ));
            dirs_out.push((
                BrowserFamily::Opera,
                roaming.join(r"Opera Software\Opera GX Stable"),
                true,
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(support) = dirs::data_dir() {
            dirs_out.push((BrowserFamily::Chrome, support.join("Google/Chrome"), false));
            dirs_out.push((BrowserFamily::Chrome, support.join("Chromium"), false));
            dirs_out.push((BrowserFamily::Edge, support.join("Microsoft Edge"), false));
            dirs_out.push((
                BrowserFamily::Brave,
                support.join("BraveSoftware/Brave-Browser"),
                false,
            ));
            dirs_out.push((BrowserFamily::Vivaldi, support.join("Vivaldi"), false));
            dirs_out.push((
                BrowserFamily::Opera,
                support.join("com.operasoftware.Opera"),
                true,
            ));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(config) = dirs::config_dir() {
            dirs_out.push((BrowserFamily::Chrome, config.join("google-chrome"), false));
            dirs_out.push((BrowserFamily::Chrome, config.join("chromium"), false));
            dirs_out.push((BrowserFamily::Edge, config.join("microsoft-edge"), false));
            dirs_out.push((
                BrowserFamily::Brave,
                config.join("BraveSoftware/Brave-Browser"),
                false,
            ));
            dirs_out.push((BrowserFamily::Vivaldi, config.join("vivaldi"), false));
            dirs_out.push((BrowserFamily::Opera, config.join("opera"), true));
        }
    }
    dirs_out
}

/// Profile display names from `Local State` (`profile.info_cache.<dir>.name`).
fn profile_names(user_data: &Path) -> Value {
    fs::read_to_string(user_data.join("Local State"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|mut v| v.pointer_mut("/profile/info_cache").map(Value::take))
        .unwrap_or(Value::Null)
}

pub fn detect() -> Vec<ProfileSource> {
    let mut sources = Vec::new();
    for (browser, user_data, is_profile_dir) in user_data_dirs() {
        if !user_data.is_dir() {
            continue;
        }
        if is_profile_dir {
            let bookmarks = user_data.join("Bookmarks");
            if bookmarks.is_file() {
                let name = user_data
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Default".to_string());
                sources.push(ProfileSource {
                    browser,
                    profile_name: name,
                    kind: SourceKind::ChromiumBookmarks(bookmarks),
                });
            }
            continue;
        }
        let names = profile_names(&user_data);
        let Ok(entries) = fs::read_dir(&user_data) else {
            continue;
        };
        let mut found: Vec<ProfileSource> = entries
            .flatten()
            .filter_map(|entry| {
                let dir_name = entry.file_name().to_string_lossy().into_owned();
                if dir_name != "Default" && !dir_name.starts_with("Profile ") {
                    return None;
                }
                let bookmarks = entry.path().join("Bookmarks");
                if !bookmarks.is_file() {
                    return None;
                }
                let display = names
                    .get(&dir_name)
                    .and_then(|p| p.get("name"))
                    .and_then(Value::as_str)
                    .filter(|n| !n.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or(dir_name);
                Some(ProfileSource {
                    browser,
                    profile_name: display,
                    kind: SourceKind::ChromiumBookmarks(bookmarks),
                })
            })
            .collect();
        found.sort_by(|a, b| a.profile_name.cmp(&b.profile_name));
        sources.extend(found);
    }
    sources
}

#[derive(Debug, Deserialize)]
struct Node {
    #[serde(rename = "type", default)]
    node_type: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    date_added: Option<String>,
    #[serde(default)]
    children: Vec<Node>,
}

/// One entry under `roots`: a bookmark node, or a non-node value (e.g. a sync counter), decoded
/// straight from the JSON text without an intermediate `serde_json::Value`.
struct RootEntry(Option<Node>);

impl<'de> Deserialize<'de> for RootEntry {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EntryVisitor;

        impl<'de> Visitor<'de> for EntryVisitor {
            type Value = RootEntry;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a bookmark node or any other JSON value")
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<RootEntry, A::Error> {
                Node::deserialize(de::value::MapAccessDeserializer::new(map))
                    .map(|node| RootEntry(Some(node)))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<RootEntry, A::Error> {
                while seq.next_element::<de::IgnoredAny>()?.is_some() {}
                Ok(RootEntry(None))
            }

            fn visit_bool<E: de::Error>(self, _: bool) -> Result<RootEntry, E> {
                Ok(RootEntry(None))
            }

            fn visit_i64<E: de::Error>(self, _: i64) -> Result<RootEntry, E> {
                Ok(RootEntry(None))
            }

            fn visit_u64<E: de::Error>(self, _: u64) -> Result<RootEntry, E> {
                Ok(RootEntry(None))
            }

            fn visit_f64<E: de::Error>(self, _: f64) -> Result<RootEntry, E> {
                Ok(RootEntry(None))
            }

            fn visit_str<E: de::Error>(self, _: &str) -> Result<RootEntry, E> {
                Ok(RootEntry(None))
            }

            fn visit_unit<E: de::Error>(self) -> Result<RootEntry, E> {
                Ok(RootEntry(None))
            }
        }

        deserializer.deserialize_any(EntryVisitor)
    }
}

#[derive(Deserialize)]
struct BookmarksFile {
    #[serde(default)]
    roots: BTreeMap<String, RootEntry>,
}

/// Stable root order: bookmark bar, other, synced, then anything else by name.
fn root_rank(key: &str) -> u8 {
    match key {
        "bookmark_bar" => 0,
        "other" => 1,
        "synced" => 2,
        _ => 3,
    }
}

fn parse_file(json: &str) -> AppResult<BookmarksFile> {
    serde_json::from_str(json)
        .map_err(|e| AppError::Parse(format!("The bookmarks file is not valid: {e}")))
}

/// Consumes the tree: titles and URLs move into the output instead of being copied.
fn walk(node: Node, path: &mut Vec<String>, out: &mut Vec<ImportedBookmark>) {
    match node.node_type.as_str() {
        "url" => {
            let Some(url) = node.url.filter(|u| is_importable_url(u)) else {
                return;
            };
            out.push(ImportedBookmark {
                url,
                title: node.name.trim().to_string(),
                folder_path: path.clone(),
                added_at: node.date_added.as_deref().and_then(webkit_to_epoch_ms),
            });
        }
        "folder" => {
            path.push(node.name);
            for child in node.children {
                walk(child, path, out);
            }
            path.pop();
        }
        _ => {}
    }
}

fn count_walk(node: &Node) -> usize {
    match node.node_type.as_str() {
        "url" => usize::from(node.url.as_deref().is_some_and(is_importable_url)),
        "folder" => node.children.iter().map(count_walk).sum(),
        _ => 0,
    }
}

/// Number of importable bookmarks in a `Bookmarks` document, without building them.
pub fn count_bookmarks(json: &str) -> AppResult<usize> {
    let file = parse_file(json)?;
    Ok(file
        .roots
        .values()
        .filter_map(|entry| entry.0.as_ref())
        .filter(|root| root.node_type == "folder")
        .map(count_walk)
        .sum())
}

pub fn parse_bookmarks(json: &str) -> AppResult<Vec<ImportedBookmark>> {
    let file = parse_file(json)?;
    // Non-node entries (e.g. "sync_transaction_version") carry no node and are skipped.
    let mut roots: Vec<(String, Node)> = file
        .roots
        .into_iter()
        .filter_map(|(key, entry)| entry.0.map(|node| (key, node)))
        .filter(|(_, root)| root.node_type == "folder")
        .collect();
    roots.sort_by(|(a, _), (b, _)| root_rank(a).cmp(&root_rank(b)).then_with(|| a.cmp(b)));
    let mut out = Vec::new();
    for (_, root) in roots {
        let mut path = Vec::new();
        walk(root, &mut path, &mut out);
    }
    Ok(out)
}

fn read_file(path: &Path) -> AppResult<String> {
    let len = fs::metadata(path)?.len();
    if len > MAX_BOOKMARKS_BYTES {
        return Err(AppError::storage("The bookmarks file is too large."));
    }
    fs::read_to_string(path).map_err(|error| {
        log::warn!("Reading {} failed: {error}", path.display());
        if super::is_lock_error(&error) {
            return AppError::browser_locked(
                "Could not read the bookmarks file. Close the browser and try again.",
            );
        }
        // The path is in the log only; the message the renderer gets carries none.
        AppError::storage("Could not read the bookmarks file.")
    })
}

pub fn read(path: &Path) -> AppResult<Vec<ImportedBookmark>> {
    parse_bookmarks(&read_file(path)?)
}

/// Bookmark count only: same parse, no `ImportedBookmark` allocations.
pub fn count(path: &Path) -> AppResult<usize> {
    count_bookmarks(&read_file(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_webkit_epoch() {
        // 2021-01-01T00:00:00Z = 1609459200000 ms.
        let micros = (1_609_459_200_000i64 + WEBKIT_EPOCH_OFFSET_MS) * 1000;
        assert_eq!(
            webkit_to_epoch_ms(&micros.to_string()),
            Some(1_609_459_200_000)
        );
        assert_eq!(webkit_to_epoch_ms("0"), None);
        assert_eq!(webkit_to_epoch_ms("garbage"), None);
    }

    #[test]
    fn parses_tree_with_folders() {
        let json = r#"{
          "checksum": "x", "version": 1,
          "roots": {
            "bookmark_bar": { "type": "folder", "name": "Bookmarks bar", "children": [
              { "type": "url", "name": "Rust", "url": "https://www.rust-lang.org/", "date_added": "13253932800000000" },
              { "type": "folder", "name": "Dev", "children": [
                { "type": "url", "name": "Tauri", "url": "https://tauri.app/" },
                { "type": "url", "name": "Local", "url": "chrome://settings" },
                { "type": "url", "name": "Script", "url": "javascript:alert(1)" }
              ]}
            ]},
            "other": { "type": "folder", "name": "Other bookmarks", "children": [] },
            "sync_transaction_version": "1"
          }
        }"#;
        let items = parse_bookmarks(json).expect("parses");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Rust");
        assert_eq!(items[0].folder_path, vec!["Bookmarks bar"]);
        assert_eq!(items[0].added_at, Some(1_609_459_200_000));
        assert_eq!(items[1].folder_path, vec!["Bookmarks bar", "Dev"]);
        assert_eq!(items[1].added_at, None);
        assert_eq!(
            count_bookmarks(json).expect("count"),
            items.len(),
            "the cheap count must agree with the full read"
        );
    }

    #[test]
    fn non_node_roots_of_any_shape_are_skipped() {
        let json = r#"{
          "roots": {
            "zzz_list": [1, {"a": [true, null]}, "x"],
            "sync_transaction_version": "1",
            "number": 42, "negative": -1, "float": 1.5, "flag": false, "nothing": null,
            "not_a_folder": { "type": "url", "name": "Top", "url": "https://top.example/" },
            "custom": { "type": "folder", "name": "Custom", "meta_info": { "k": "v" }, "children": [
              { "type": "url", "name": "C", "url": "https://c.example/", "guid": "g" }
            ]},
            "other": { "type": "folder", "name": "Other", "children": [
              { "type": "url", "name": "O", "url": "https://o.example/" }
            ]},
            "bookmark_bar": { "type": "folder", "name": "Bar", "children": [
              { "type": "url", "name": "B", "url": "https://b.example/" }
            ]}
          }
        }"#;
        let items = parse_bookmarks(json).expect("parses");
        let urls: Vec<&str> = items.iter().map(|item| item.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://b.example/",
                "https://o.example/",
                "https://c.example/"
            ],
            "bar, other, then the remaining folders by name; non-folder roots are ignored"
        );
        assert_eq!(count_bookmarks(json).expect("count"), 3);

        assert!(parse_bookmarks("{}").expect("no roots").is_empty());
        assert_eq!(
            parse_bookmarks("{not json").expect_err("broken").kind(),
            "parse"
        );
    }
}
