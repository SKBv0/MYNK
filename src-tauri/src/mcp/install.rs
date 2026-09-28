//! `mynk-mcp install --client <name>`: writes one client's MCP server entry, in its own format.
//!
//! Only the `mynk` key is touched; each write first saves a new `.bak` copy of the file.

use std::fmt;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// The key every client uses for this server.
pub const SERVER_KEY: &str = "mynk";

/// Overrides the home directory client configs live under; `dirs::home_dir()` ignores
/// `%USERPROFILE%` / `$HOME` on Windows, which a test or a relocated profile needs.
pub const HOME_DIR_ENV: &str = "MYNK_HOME_DIR";

/// The home directory to write client configurations under: [`HOME_DIR_ENV`] first, then the
/// platform's own answer.
pub fn home_dir() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os(HOME_DIR_ENV) {
        if !value.to_string_lossy().trim().is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    dirs::home_dir()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Client {
    ClaudeCode,
    Codex,
    Cursor,
    Windsurf,
    Generic,
}

/// Everything `--client` accepts, in the order `--help` lists it.
pub const CLIENTS: [Client; 5] = [
    Client::ClaudeCode,
    Client::Codex,
    Client::Cursor,
    Client::Windsurf,
    Client::Generic,
];

impl Client {
    pub fn as_str(self) -> &'static str {
        match self {
            Client::ClaudeCode => "claude-code",
            Client::Codex => "codex",
            Client::Cursor => "cursor",
            Client::Windsurf => "windsurf",
            Client::Generic => "generic",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        CLIENTS
            .into_iter()
            .find(|client| client.as_str() == value.trim().to_ascii_lowercase())
    }

    /// Relative to the home directory; `None` for a client this binary does not write for.
    fn config_relative(self) -> Option<&'static [&'static str]> {
        match self {
            Client::Codex => Some(&[".codex", "config.toml"]),
            Client::Cursor => Some(&[".cursor", "mcp.json"]),
            Client::Windsurf => Some(&[".codeium", "windsurf", "mcp_config.json"]),
            Client::ClaudeCode | Client::Generic => None,
        }
    }

    /// This client's configuration file under an explicit home directory.
    pub fn config_path_in(self, home: &Path) -> Option<PathBuf> {
        let relative = self.config_relative()?;
        let mut path = home.to_path_buf();
        path.extend(relative);
        Some(path)
    }

    /// The absolute path of this client's configuration file on this machine.
    pub fn config_path(self) -> Option<PathBuf> {
        self.config_path_in(&home_dir()?)
    }
}

impl fmt::Display for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A TOML literal string when possible, so Windows backslashes are not mangled.
fn toml_string(value: &str) -> String {
    if !value.contains('\'') && !value.contains('\n') {
        return format!("'{value}'");
    }
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The `[mcp_servers.mynk]` section Codex expects.
fn codex_section(exe: &str) -> String {
    format!(
        "[mcp_servers.{SERVER_KEY}]\ncommand = {}\n",
        toml_string(exe)
    )
}

/// The `{"mcpServers": {...}}` object Cursor, Windsurf and most other clients expect.
fn json_snippet(exe: &str) -> String {
    let value = serde_json::json!({
        "mcpServers": { SERVER_KEY: { "command": exe } }
    });
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| String::from("{}"))
}

/// What `--print` shows: the exact text to paste, and where it goes.
pub fn instructions(client: Client, exe: &str) -> String {
    match client {
        Client::ClaudeCode => format!(
            "Claude Code registers MCP servers through its own CLI. Run:\n\n\
             claude mcp add {SERVER_KEY} -- \"{exe}\"\n\n\
             Or, to share the server with a project, add this to its .mcp.json:\n\n{}\n",
            json_snippet(exe)
        ),
        Client::Codex => format!(
            "Add this to {}:\n\n{}",
            describe_path(client),
            codex_section(exe)
        ),
        Client::Cursor | Client::Windsurf => format!(
            "Add this to {}:\n\n{}\n",
            describe_path(client),
            json_snippet(exe)
        ),
        Client::Generic => format!(
            "Most MCP clients take this shape; put it wherever yours keeps its servers:\n\n{}\n",
            json_snippet(exe)
        ),
    }
}

fn describe_path(client: Client) -> String {
    client
        .config_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "your client's MCP configuration".to_string())
}

/// What `install` did (or would do). `changed` is false when the file already said the same thing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub client: Client,
    pub path: Option<PathBuf>,
    pub backup: Option<PathBuf>,
    pub changed: bool,
    /// The sentence printed to the user before anything was written.
    pub plan: String,
}

/// Whether a TOML header line names the `mynk` table, however it is spaced, quoted or commented:
/// `[ mcp_servers."mynk" ] # MYNK` counts, `[mcp_servers.mynk.env]` does not.
fn is_our_codex_header(line: &str) -> bool {
    let Some(inner) = line
        .strip_prefix('[')
        .filter(|rest| !rest.starts_with('['))
        .and_then(|rest| rest.split_once(']'))
        .map(|(inner, _)| inner)
    else {
        return false;
    };
    let unquote = |key: &str| {
        let key = key.trim();
        ['"', '\'']
            .iter()
            .find_map(|q| key.strip_prefix(*q).and_then(|k| k.strip_suffix(*q)))
            .unwrap_or(key)
            .to_string()
    };
    let keys: Vec<String> = inner.split('.').map(unquote).collect();
    keys == ["mcp_servers", SERVER_KEY]
}

/// Replaces (or appends) the `[mcp_servers.mynk]` section in a Codex `config.toml`, leaving every
/// other section byte for byte as it was.
pub fn merge_codex_toml(existing: &str, exe: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut inside_ours = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        // Any section header ends the `mynk` section; only its own header starts the part to drop.
        if trimmed.starts_with('[') {
            inside_ours = is_our_codex_header(trimmed);
        }
        if !inside_ours {
            kept.push(line);
        }
    }
    let mut text = kept.join("\n").trim_end().to_string();
    // Exactly one blank line before the `mynk` section.
    if !text.is_empty() {
        text.push_str("\n\n");
    }
    text.push_str(&codex_section(exe));
    text
}

/// Sets `mcpServers.mynk.command` in a client's JSON file, keeping every other server and every
/// other top-level key. Unparseable content is refused, never overwritten.
pub fn merge_client_json(existing: &str, exe: &str) -> AppResult<String> {
    let mut root: serde_json::Value = if existing.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(existing).map_err(|error| {
            AppError::Parse(format!(
                "The existing configuration is not valid JSON and was left alone: {error}"
            ))
        })?
    };
    if !root.is_object() {
        return Err(AppError::Parse(
            "The existing configuration is not a JSON object and was left alone.".to_string(),
        ));
    }
    let servers = root
        .as_object_mut()
        .and_then(|map| {
            map.entry("mcpServers")
                .or_insert_with(|| serde_json::json!({}));
            map.get_mut("mcpServers")
        })
        .ok_or_else(|| AppError::internal("The configuration could not be updated."))?;
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    if let Some(map) = servers.as_object_mut() {
        map.insert(
            SERVER_KEY.to_string(),
            serde_json::json!({ "command": exe }),
        );
    }
    serde_json::to_string_pretty(&root)
        .map(|mut text| {
            text.push('\n');
            text
        })
        .map_err(AppError::from)
}

/// What [`apply`] is about to do, worked out without touching anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub client: Client,
    pub path: Option<PathBuf>,
    /// The file's new content; `None` for a client this binary does not write for.
    content: Option<String>,
    /// True when the file already says exactly this.
    pub unchanged: bool,
    /// The sentence to show the user.
    pub summary: String,
}

pub fn plan(client: Client, exe: &str) -> AppResult<Plan> {
    match home_dir() {
        Some(home) => plan_in(client, exe, &home),
        None => Ok(Plan {
            client,
            path: None,
            content: None,
            unchanged: true,
            summary: instructions(client, exe),
        }),
    }
}

/// [`plan`] against an explicit home directory, which is what makes the write testable.
pub fn plan_in(client: Client, exe: &str, home: &Path) -> AppResult<Plan> {
    let Some(path) = client.config_path_in(home) else {
        return Ok(Plan {
            client,
            path: None,
            content: None,
            unchanged: true,
            summary: instructions(client, exe),
        });
    };
    // Only a missing file starts empty; one that cannot be read is never overwritten.
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
            return Err(AppError::Parse(format!(
                "The existing configuration at {} is not UTF-8 text and was left alone.",
                path.display()
            )));
        }
        Err(error) => {
            return Err(AppError::storage(format!(
                "The existing configuration at {} could not be read and was left alone: {error}",
                path.display()
            )));
        }
    };
    let updated = match client {
        Client::Codex => merge_codex_toml(&existing, exe),
        _ => merge_client_json(&existing, exe)?,
    };
    if existing == updated {
        return Ok(Plan {
            client,
            path: Some(path),
            content: None,
            unchanged: true,
            summary: format!(
                "{} already points at this executable.",
                describe_path(client)
            ),
        });
    }
    let summary = format!(
        "{} {} ({} the \"{SERVER_KEY}\" entry; other entries are left alone)",
        if path.exists() {
            "Updating"
        } else {
            "Creating"
        },
        path.display(),
        if existing.contains(SERVER_KEY) {
            "replacing"
        } else {
            "adding"
        },
    );
    Ok(Plan {
        client,
        path: Some(path),
        content: Some(updated),
        unchanged: false,
        summary,
    })
}

/// Where a write to `path` lands: a symlink's target, so the rename keeps the link in place.
fn write_target(path: &Path) -> PathBuf {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::canonicalize(path)
            .or_else(|_| std::fs::read_link(path).map(|link| link_destination(path, link)))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

/// A dangling link's destination: a relative `link` counts from the link's own directory.
fn link_destination(path: &Path, link: PathBuf) -> PathBuf {
    match path.parent() {
        Some(parent) => parent.join(link),
        None => link,
    }
}

/// Writes via a sibling `.tmp` file, then renames over `path`, so a crash can't corrupt it.
fn write_atomically(path: &Path, content: &str) -> std::io::Result<()> {
    let path = &write_target(path);
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let temporary = path.with_file_name(name);
    crate::util::write_atomically(path, &temporary, content.as_bytes())
}

/// `<name>.<ext>.bak`, or `<name>.<ext>.<n>.bak` when that is taken: an existing backup may be
/// the only copy of the user's own configuration, so it is never overwritten.
fn free_backup_path(path: &Path) -> PathBuf {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    let first = path.with_extension(format!("{ext}.bak"));
    if !first.exists() {
        return first;
    }
    (1u32..)
        .map(|n| path.with_extension(format!("{ext}.{n}.bak")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(first)
}

/// Carries out a [`plan`]. Clients this binary does not write for (Claude Code, generic) come back
/// with `changed: false` and instructions to follow by hand.
pub fn apply(plan: Plan) -> AppResult<Outcome> {
    let client = plan.client;
    let (Some(path), Some(updated)) = (plan.path.clone(), plan.content) else {
        return Ok(Outcome {
            client,
            path: plan.path,
            backup: None,
            changed: false,
            plan: plan.summary,
        });
    };
    let exists = path.exists();

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            AppError::storage(format!(
                "The configuration directory could not be created: {error}"
            ))
        })?;
    }
    let backup = if exists {
        let backup = free_backup_path(&path);
        std::fs::copy(&path, &backup).map_err(|error| {
            AppError::storage(format!(
                "The existing configuration could not be backed up: {error}"
            ))
        })?;
        Some(backup)
    } else {
        None
    };
    write_atomically(&path, &updated).map_err(|error| {
        AppError::storage(format!("The configuration could not be written: {error}"))
    })?;
    Ok(Outcome {
        client,
        path: Some(path),
        backup,
        changed: true,
        plan: plan.summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\me\AppData\Local\MYNK\mynk-mcp.exe";

    #[test]
    fn a_symlinked_config_is_written_through_to_its_target() {
        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("real.json");
        let link = dir.path().join("link.json");
        std::fs::write(&target, "{}").expect("target");
        assert_eq!(
            write_target(&target),
            target,
            "a plain file is its own target"
        );

        let config = dir.path().join("home").join(".claude.json");
        assert_eq!(
            link_destination(&config, PathBuf::from("dotfiles").join("claude.json")),
            dir.path().join("home").join("dotfiles").join("claude.json")
        );
        assert_eq!(
            link_destination(&config, target.clone()),
            target,
            "an absolute link is used as it is"
        );

        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link);
        if let Err(error) = made {
            // Windows needs developer mode or elevation to create a symlink.
            eprintln!("skipping the symlink half: {error}");
            return;
        }
        write_atomically(&link, "{\"a\":1}").expect("write");
        let meta = std::fs::symlink_metadata(&link).expect("link metadata");
        assert!(meta.file_type().is_symlink(), "the link is still a link");
        assert_eq!(
            std::fs::read_to_string(&target).expect("target"),
            "{\"a\":1}"
        );
    }

    #[test]
    fn client_names_round_trip() {
        for client in CLIENTS {
            assert_eq!(Client::parse(client.as_str()), Some(client));
            assert_eq!(client.to_string(), client.as_str());
        }
        assert_eq!(Client::parse(" Claude-Code "), Some(Client::ClaudeCode));
        assert_eq!(Client::parse("emacs"), None);
    }

    #[test]
    fn only_the_file_writing_clients_have_a_path() {
        assert!(Client::Codex
            .config_path()
            .is_some_and(|p| p.ends_with("config.toml")));
        assert!(Client::Cursor
            .config_path()
            .is_some_and(|p| p.ends_with("mcp.json")));
        assert!(Client::Windsurf
            .config_path()
            .is_some_and(|p| p.ends_with("mcp_config.json")));
        assert_eq!(Client::ClaudeCode.config_path(), None);
        assert_eq!(Client::Generic.config_path(), None);
    }

    #[test]
    fn claude_code_is_told_to_use_its_own_cli() {
        let text = instructions(Client::ClaudeCode, EXE);
        assert!(
            text.contains(&format!("claude mcp add {SERVER_KEY} -- \"{EXE}\"")),
            "{text}"
        );
        assert!(text.contains(".mcp.json"), "{text}");
        assert!(text.contains("\"mcpServers\""), "{text}");
    }

    #[test]
    fn a_windows_path_survives_both_formats() {
        let toml = codex_section(EXE);
        assert_eq!(
            toml,
            format!("[mcp_servers.{SERVER_KEY}]\ncommand = '{EXE}'\n"),
            "a literal string keeps the backslashes as typed"
        );
        let json = json_snippet(EXE);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid json");
        assert_eq!(parsed["mcpServers"][SERVER_KEY]["command"], EXE);
    }

    #[test]
    fn a_path_with_a_quote_falls_back_to_an_escaped_string() {
        let awkward = r"C:\it's here\mynk-mcp.exe";
        let toml = toml_string(awkward);
        assert!(toml.starts_with('"'), "{toml}");
        assert!(toml.contains(r"C:\\it's here\\mynk-mcp.exe"), "{toml}");
    }

    #[test]
    fn the_codex_merge_keeps_every_other_section() {
        let existing = "\
model = \"gpt-5\"

[mcp_servers.other]
command = 'other.exe'
args = ['--flag']

[mcp_servers.mynk]
command = 'C:\\old\\mynk-mcp.exe'

[tui]
theme = 'dark'
";
        let merged = merge_codex_toml(existing, EXE);
        assert!(merged.contains("model = \"gpt-5\""), "{merged}");
        assert!(merged.contains("[mcp_servers.other]"), "{merged}");
        assert!(merged.contains("args = ['--flag']"), "{merged}");
        assert!(merged.contains("[tui]"), "{merged}");
        assert!(merged.contains("theme = 'dark'"), "{merged}");
        assert!(!merged.contains(r"C:\old\mynk-mcp.exe"), "{merged}");
        assert_eq!(
            merged.matches("[mcp_servers.mynk]").count(),
            1,
            "the section is replaced, not duplicated: {merged}"
        );
        assert!(
            merged.trim_end().ends_with(&format!("command = '{EXE}'")),
            "{merged}"
        );
    }

    #[test]
    fn the_codex_merge_recognizes_a_respaced_quoted_or_commented_header() {
        for header in [
            "[mcp_servers.mynk] # MYNK",
            "[ mcp_servers.mynk ]",
            "[mcp_servers.\"mynk\"]",
            "[\"mcp_servers\" . 'mynk']",
        ] {
            let existing = format!("{header}\ncommand = 'C:\\old\\mynk-mcp.exe'\n\n[tui]\nx = 1\n");
            let merged = merge_codex_toml(&existing, EXE);
            assert!(!merged.contains(r"C:\old\mynk-mcp.exe"), "{merged}");
            assert!(!merged.contains(header), "{merged}");
            assert!(merged.contains("[tui]\nx = 1"), "{merged}");
            assert_eq!(merged.matches("command = ").count(), 1, "{merged}");
        }
        for other in [
            "[mcp_servers.mynk.env]",
            "[[mcp_servers.mynk]]",
            "[mcp_servers.mynkx]",
            "[\"mcp_servers.mynk\"]",
        ] {
            assert!(!is_our_codex_header(other), "{other}");
        }
    }

    #[test]
    fn the_codex_merge_creates_the_section_in_an_empty_or_missing_file() {
        assert_eq!(merge_codex_toml("", EXE), codex_section(EXE));
        let merged = merge_codex_toml("model = \"gpt-5\"\n", EXE);
        assert_eq!(
            merged,
            format!("model = \"gpt-5\"\n\n{}", codex_section(EXE))
        );
    }

    #[test]
    fn the_json_merge_keeps_every_other_server_and_key() {
        let existing = serde_json::json!({
            "mcpServers": {
                "other": { "command": "other.exe", "args": ["--flag"] },
                "mynk": { "command": "C:/old/mynk-mcp.exe" }
            },
            "editor": { "fontSize": 14 }
        })
        .to_string();
        let merged = merge_client_json(&existing, EXE).expect("merge");
        let parsed: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
        assert_eq!(parsed["mcpServers"]["other"]["command"], "other.exe");
        assert_eq!(parsed["mcpServers"]["other"]["args"][0], "--flag");
        assert_eq!(parsed["mcpServers"][SERVER_KEY]["command"], EXE);
        assert_eq!(parsed["editor"]["fontSize"], 14);
        assert!(merged.ends_with('\n'), "the file ends with a newline");
    }

    #[test]
    fn the_json_merge_builds_the_file_from_nothing() {
        for empty in ["", "   ", "{}"] {
            let merged = merge_client_json(empty, EXE).expect(empty);
            let parsed: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
            assert_eq!(parsed["mcpServers"][SERVER_KEY]["command"], EXE);
        }
        // A `mcpServers` of the wrong type is replaced; anything else about the file is not.
        let merged = merge_client_json(r#"{"mcpServers": 7, "keep": true}"#, EXE).expect("merge");
        let parsed: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
        assert_eq!(parsed["mcpServers"][SERVER_KEY]["command"], EXE);
        assert_eq!(parsed["keep"], true);
    }

    #[test]
    fn a_configuration_that_cannot_be_parsed_is_left_alone() {
        let error = merge_client_json("{ half written", EXE).expect_err("broken json");
        assert_eq!(error.kind(), "parse");
        assert!(error.to_string().contains("left alone"), "{error}");
        let error = merge_client_json("[1, 2, 3]", EXE).expect_err("not an object");
        assert_eq!(error.kind(), "parse");
    }

    #[test]
    fn clients_without_a_file_report_instructions_instead_of_writing() {
        for client in [Client::ClaudeCode, Client::Generic] {
            let planned = plan(client, EXE).expect("plan");
            assert!(planned.unchanged, "there is nothing this binary can write");
            assert_eq!(planned.path, None);
            assert_eq!(planned.summary, instructions(client, EXE));

            let outcome = apply(planned).expect("apply");
            assert!(!outcome.changed);
            assert_eq!(outcome.path, None);
            assert_eq!(outcome.backup, None);
            assert_eq!(outcome.plan, instructions(client, EXE));
        }
    }

    #[test]
    fn planning_a_write_says_what_it_would_do_without_doing_it() {
        let home = tempfile::tempdir().expect("temp home");
        for client in [Client::Codex, Client::Cursor, Client::Windsurf] {
            let path = client
                .config_path_in(home.path())
                .expect("a file-writing client");
            let planned = plan_in(client, EXE, home.path()).expect("plan");
            assert_eq!(planned.path.as_ref(), Some(&path));
            assert!(
                planned.summary.contains(&path.display().to_string()),
                "{client}: {}",
                planned.summary
            );
            assert!(
                planned.summary.starts_with("Creating"),
                "{client}: {}",
                planned.summary
            );
            assert!(
                planned.summary.contains("other entries are left alone"),
                "{client}: {}",
                planned.summary
            );
            assert!(!path.exists(), "{client}: planning must not write anything");
        }
    }

    #[test]
    fn applying_creates_the_file_when_the_client_has_never_been_configured() {
        let home = tempfile::tempdir().expect("temp home");
        for client in [Client::Cursor, Client::Windsurf] {
            let outcome = apply(plan_in(client, EXE, home.path()).expect("plan")).expect("apply");
            assert!(outcome.changed, "{client}");
            assert_eq!(outcome.backup, None, "{client}: nothing existed to back up");
            let path = outcome.path.expect("a written path");
            let written = std::fs::read_to_string(&path).expect("the file exists now");
            let parsed: serde_json::Value = serde_json::from_str(&written).expect("valid json");
            assert_eq!(parsed["mcpServers"][SERVER_KEY]["command"], EXE, "{client}");
            assert!(
                !path
                    .with_file_name(format!(
                        "{}.tmp",
                        path.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or_default()
                    ))
                    .exists(),
                "{client}: the temporary file is renamed, not left behind"
            );
        }

        let path = apply(plan_in(Client::Codex, EXE, home.path()).expect("plan"))
            .expect("apply")
            .path
            .expect("a written path");
        assert_eq!(
            std::fs::read_to_string(&path).expect("the file exists now"),
            codex_section(EXE)
        );
    }

    #[test]
    fn applying_keeps_every_other_server_and_copies_the_previous_file_aside() {
        let home = tempfile::tempdir().expect("temp home");
        let path = Client::Cursor
            .config_path_in(home.path())
            .expect("a file-writing client");
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        let existing = serde_json::json!({
            "mcpServers": { "other": { "command": "other.exe", "args": ["--flag"] } },
            "editor": { "fontSize": 14 }
        })
        .to_string();
        std::fs::write(&path, &existing).expect("seed");

        let outcome =
            apply(plan_in(Client::Cursor, EXE, home.path()).expect("plan")).expect("apply");
        assert!(outcome.changed);
        let backup = outcome.backup.expect("the previous file was copied aside");
        assert_eq!(backup, path.with_extension("json.bak"));
        assert_eq!(
            std::fs::read_to_string(&backup).expect("backup"),
            existing,
            "the backup is the file as it was"
        );

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(parsed["mcpServers"]["other"]["command"], "other.exe");
        assert_eq!(parsed["mcpServers"]["other"]["args"][0], "--flag");
        assert_eq!(parsed["mcpServers"][SERVER_KEY]["command"], EXE);
        assert_eq!(parsed["editor"]["fontSize"], 14);

        let again = apply(plan_in(Client::Cursor, EXE, home.path()).expect("plan")).expect("apply");
        assert!(!again.changed, "{}", again.plan);
        assert!(again.plan.contains("already points at"), "{}", again.plan);
    }

    #[test]
    fn applying_to_codex_leaves_every_other_toml_section_alone() {
        let home = tempfile::tempdir().expect("temp home");
        let path = Client::Codex
            .config_path_in(home.path())
            .expect("a file-writing client");
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        std::fs::write(
            &path,
            "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = 'other.exe'\n\n[tui]\ntheme = 'dark'\n",
        )
        .expect("seed");

        let outcome =
            apply(plan_in(Client::Codex, EXE, home.path()).expect("plan")).expect("apply");
        assert_eq!(
            outcome.backup,
            Some(path.with_extension("toml.bak")),
            "{outcome:?}"
        );
        let written = std::fs::read_to_string(&path).expect("read");
        assert!(written.contains("model = \"gpt-5\""), "{written}");
        assert!(written.contains("[mcp_servers.other]"), "{written}");
        assert!(written.contains("[tui]"), "{written}");
        assert!(
            written.contains(&format!("[mcp_servers.{SERVER_KEY}]\ncommand = '{EXE}'")),
            "the CLI writes a literal string, which is what keeps the backslashes: {written}"
        );
        assert_eq!(
            written.matches("[mcp_servers.mynk]").count(),
            1,
            "the section is replaced, not duplicated: {written}"
        );
    }

    #[test]
    fn a_broken_json_configuration_is_refused_before_anything_is_written() {
        let home = tempfile::tempdir().expect("temp home");
        let path = Client::Windsurf
            .config_path_in(home.path())
            .expect("a file-writing client");
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        std::fs::write(&path, "{ half written").expect("seed");

        let error = plan_in(Client::Windsurf, EXE, home.path()).expect_err("broken json");
        assert_eq!(error.kind(), "parse");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "{ half written"
        );
        assert!(!path.with_extension("json.bak").exists());
    }

    #[test]
    fn a_configuration_that_is_not_utf8_is_refused_before_anything_is_written() {
        let home = tempfile::tempdir().expect("temp home");
        let path = Client::Cursor
            .config_path_in(home.path())
            .expect("a file-writing client");
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        // What PowerShell 5.1's `>` writes: UTF-16 LE with a byte-order mark.
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(
                r#"{"mcpServers":{"other":{"command":"other.exe"}}}"#
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes),
            )
            .collect();
        std::fs::write(&path, &utf16).expect("seed");

        let error = plan_in(Client::Cursor, EXE, home.path()).expect_err("not UTF-8");
        assert_eq!(error.kind(), "parse");
        assert_eq!(std::fs::read(&path).expect("read"), utf16);
        assert!(!path.with_extension("json.bak").exists());
    }

    #[test]
    fn an_earlier_backup_is_never_overwritten() {
        let home = tempfile::tempdir().expect("temp home");
        let path = Client::Cursor
            .config_path_in(home.path())
            .expect("a file-writing client");
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        std::fs::write(&path, r#"{"original":true}"#).expect("seed");
        apply(plan_in(Client::Cursor, EXE, home.path()).expect("plan")).expect("apply");

        let moved = apply(
            plan_in(Client::Cursor, r"D:\elsewhere\mynk-mcp.exe", home.path()).expect("plan"),
        )
        .expect("apply");
        assert_eq!(moved.backup, Some(path.with_extension("json.1.bak")));
        assert_eq!(
            std::fs::read_to_string(path.with_extension("json.bak")).expect("first backup"),
            r#"{"original":true}"#,
            "the first backup still holds the user's own file"
        );
    }

    #[test]
    fn the_home_directory_override_wins_over_the_platform_answer() {
        // Setting the env var here would race other tests; only the resolution rules are checked.
        assert_eq!(HOME_DIR_ENV, "MYNK_HOME_DIR");
        let home = Path::new("/tmp/mynk-home");
        assert_eq!(
            Client::Cursor.config_path_in(home),
            Some(home.join(".cursor").join("mcp.json"))
        );
        assert_eq!(
            Client::Codex.config_path_in(home),
            Some(home.join(".codex").join("config.toml"))
        );
        assert_eq!(
            Client::Windsurf.config_path_in(home),
            Some(
                home.join(".codeium")
                    .join("windsurf")
                    .join("mcp_config.json")
            )
        );
        assert_eq!(Client::ClaudeCode.config_path_in(home), None);
        assert_eq!(Client::Generic.config_path_in(home), None);
    }
}
