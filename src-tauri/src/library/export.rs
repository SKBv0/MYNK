//! Library export to the user's Downloads folder and "reveal in folder".

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf, Prefix};

use serde::Deserialize;

use super::MAX_LIBRARY_BYTES;
use crate::error::{AppError, AppResult};
use crate::util::is_windows_device_name;

/// `ExportFormat` in ipcTypes.ts.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Json,
    Html,
}

impl ExportFormat {
    fn extension(self) -> &'static str {
        match self {
            ExportFormat::Json => "json",
            ExportFormat::Html => "html",
        }
    }
}

/// User-facing message when an export cannot be written. The OS error goes to the log only.
pub const WRITE_FAILED_MESSAGE: &str = "The export file cannot be written.";

fn write_failure(error: std::io::Error) -> AppError {
    log::warn!("export: could not write the file: {error}");
    AppError::storage(WRITE_FAILED_MESSAGE)
}

const DEFAULT_STEM: &str = "mynk-export";
const MAX_STEM_CHARS: usize = 80;

/// Makes a safe file stem: strips any known extension, replaces path separators, reserved
/// and control characters, trims dots/spaces, avoids Windows device names.
pub fn sanitize_stem(suggested: &str) -> String {
    let base = suggested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim();
    let base = [".json", ".html", ".htm"]
        .iter()
        .find_map(|ext| {
            base.len()
                .checked_sub(ext.len())
                .filter(|&cut| base.is_char_boundary(cut) && base[cut..].eq_ignore_ascii_case(ext))
                .map(|cut| &base[..cut])
        })
        .unwrap_or(base);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .take(MAX_STEM_CHARS)
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() || is_windows_device_name(cleaned) {
        DEFAULT_STEM.to_string()
    } else {
        cleaned.to_string()
    }
}

/// Writes `content` to `dir/<stem>.<ext>`, adding " (n)" when the name is taken.
/// `create_new` makes the uniqueness check race-free.
pub fn write_unique(
    dir: &Path,
    stem: &str,
    format: ExportFormat,
    content: &str,
) -> AppResult<PathBuf> {
    if content.len() as u64 > MAX_LIBRARY_BYTES {
        return Err(AppError::storage("The export is too large."));
    }
    std::fs::create_dir_all(dir).map_err(write_failure)?;
    let ext = format.extension();
    for attempt in 0..1000u32 {
        let name = if attempt == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem} ({attempt}).{ext}")
        };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let written = file
                    .write_all(content.as_bytes())
                    .and_then(|()| file.sync_all());
                if let Err(error) = written {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(write_failure(error));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(write_failure(e)),
        }
    }
    Err(AppError::storage(
        "Could not find a free file name for the export.",
    ))
}

/// Removes the `\\?\` verbatim prefix that `canonicalize` adds on Windows (explorer rejects it).
pub fn display_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// True for UNC and device paths (`\\host\share`, `//host/share`, `\\?\`, `\\.\`).
fn is_network_or_device(path: &Path) -> bool {
    let text = path.as_os_str().to_string_lossy();
    let mut lead = text.chars();
    let slashes = matches!(
        (lead.next(), lead.next()),
        (Some('\\' | '/'), Some('\\' | '/'))
    );
    slashes
        || matches!(
            path.components().next(),
            Some(Component::Prefix(prefix)) if !matches!(prefix.kind(), Prefix::Disk(_))
        )
}

/// Resolves `path` and checks that it is a file inside `export_dir`.
pub fn resolve_revealable(export_dir: &Path, path: &str) -> AppResult<PathBuf> {
    let requested = Path::new(path);
    let export_root = display_path(export_dir);
    // Checked before any filesystem call: canonicalizing a UNC path opens an SMB connection.
    let outside = (is_network_or_device(requested) && !is_network_or_device(&export_root))
        || !requested.starts_with(&export_root)
        || requested
            .components()
            .any(|part| part == Component::ParentDir);
    if outside {
        return Err(AppError::invalid_input(
            "Only exported files can be revealed.",
        ));
    }
    let root = std::fs::canonicalize(export_dir)
        .map_err(|_| AppError::NotFound("The export folder does not exist.".to_string()))?;
    let target = std::fs::canonicalize(path)
        .map_err(|_| AppError::NotFound("The file no longer exists.".to_string()))?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err(AppError::invalid_input(
            "Only exported files can be revealed.",
        ));
    }
    Ok(target)
}

/// Absolute path of Explorer, so one earlier on PATH cannot be run instead.
#[cfg(target_os = "windows")]
fn windows_explorer() -> PathBuf {
    match std::env::var_os("SystemRoot") {
        Some(root) => PathBuf::from(root).join("explorer.exe"),
        None => PathBuf::from("explorer"),
    }
}

/// Opens the OS file manager with the file selected (Linux: opens the containing folder).
pub fn reveal(path: &Path) -> AppResult<()> {
    let path = display_path(path);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // explorer needs `/select,"<path>"` as one raw argument; `"` cannot occur in paths.
        std::process::Command::new(windows_explorer())
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map_err(|e| AppError::internal(format!("Could not open Explorer: {e}")))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::internal(format!("Could not open Finder: {e}")))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = path.parent().unwrap_or(&path);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| AppError::internal(format!("Could not open the file manager: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_stems_drop_paths_reserved_chars_and_device_names() {
        assert_eq!(sanitize_stem("My Library.json"), "My Library");
        assert_eq!(sanitize_stem("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_stem("C:\\Users\\x\\evil.html"), "evil");
        assert_eq!(sanitize_stem("a<b>c:d|e?f*g"), "a_b_c_d_e_f_g");
        assert_eq!(sanitize_stem("  ...  "), DEFAULT_STEM);
        assert_eq!(sanitize_stem("CON"), DEFAULT_STEM);
        assert_eq!(sanitize_stem("nul.txt"), DEFAULT_STEM);
        assert_eq!(sanitize_stem("Yer imlerim şubat"), "Yer imlerim şubat");
        assert_eq!(
            sanitize_stem(&"x".repeat(200)).chars().count(),
            MAX_STEM_CHARS
        );
    }

    #[test]
    fn writes_unique_files_and_guards_reveal() {
        let dir = std::env::temp_dir().join(format!("mynk-export-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let first = write_unique(&dir, "lib", ExportFormat::Json, "{}").expect("first");
        let second = write_unique(&dir, "lib", ExportFormat::Json, "{}").expect("second");
        assert!(first.ends_with("lib.json"));
        assert!(second.ends_with("lib (1).json"));

        assert!(resolve_revealable(&dir, &first.to_string_lossy()).is_ok());
        let outside = std::env::temp_dir();
        assert!(resolve_revealable(&dir, &outside.to_string_lossy()).is_err());
        let traversal = dir.join("..").join("..");
        assert!(resolve_revealable(&dir, &traversal.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_export_reports_a_fixed_message() {
        let base = std::env::temp_dir().join(format!("mynk-export-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("base");
        // A file where the export directory belongs: the directory cannot be created.
        let blocked = base.join("not-a-dir");
        std::fs::write(&blocked, "x").expect("file in the way");

        let error = write_unique(&blocked.join("sub"), "lib", ExportFormat::Json, "{}")
            .expect_err("must fail");
        assert_eq!(error.kind(), "storage", "{error}");
        assert_eq!(error.to_string(), WRITE_FAILED_MESSAGE);
        assert!(!error.to_string().contains("os error"), "{error}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn reveal_outside_the_export_dir_is_invalid_input() {
        let dir = std::env::temp_dir().join(format!("mynk-reveal-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let error =
            resolve_revealable(&dir, &std::env::temp_dir().to_string_lossy()).expect_err("outside");
        assert_eq!(error.kind(), "invalidInput");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn network_and_device_paths_are_refused_before_touching_the_filesystem() {
        let dir = std::env::temp_dir().join(format!("mynk-reveal-unc-{}", std::process::id()));
        for path in [
            r"\\attacker.invalid\share\x.json",
            "//attacker.invalid/share/x.json",
            r"\\?\C:\Windows\win.ini",
            r"\\.\pipe\x",
            r"\\?\UNC\attacker.invalid\share\x.json",
        ] {
            let error = resolve_revealable(&dir, path).expect_err(path);
            assert_eq!(error.kind(), "invalidInput", "{path}: {error}");
        }
        assert!(is_network_or_device(Path::new(r"\\host\share")));
        assert!(is_network_or_device(Path::new("//host/share")));
        assert!(!is_network_or_device(Path::new(r"C:\Users\a\b.json")));
        assert!(!is_network_or_device(Path::new("relative/b.json")));
    }

    #[test]
    fn display_path_strips_the_verbatim_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\Users\a\b.json")),
            PathBuf::from(r"C:\Users\a\b.json")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn explorer_is_run_from_the_system_directory() {
        let resolved = windows_explorer();
        assert!(resolved.is_absolute(), "{}", resolved.display());
        assert!(resolved.is_file(), "{}", resolved.display());
        assert_eq!(
            resolved.file_name().and_then(|n| n.to_str()),
            Some("explorer.exe")
        );
    }
}
