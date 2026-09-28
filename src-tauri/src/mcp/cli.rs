//! `mynk-mcp <subcommand>`: the same library for scripts that do not use MCP.
//!
//! Exit codes: `0` answered, `1` ran and failed, `2` bad command line.

use std::io::Write;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

use super::doctor;
use super::engine::{AddRequest, Engine, ListRequest, SearchRequest};
use super::install::{self, Client, CLIENTS};
use super::semantic_link::{self, BuildProgress};

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILURE: i32 = 1;
pub const EXIT_USAGE: i32 = 2;

pub const USAGE: &str = "\
mynk-mcp - the MYNK bookmark library for agents and scripts

USAGE
  mynk-mcp                          speak MCP on stdin/stdout (what an agent starts)
  mynk-mcp <command> [options]

COMMANDS
  search <query>                    search the library
    --mode hybrid|keyword|semantic  default hybrid
    --limit <n>                     1-100, default 20
    --category <id>                 only this category
    --tag <tag>                     only bookmarks with this tag
    --collection <id>               only members of this collection
    --added-after <when>            ISO-8601 or a period like 7d / 24h (alias: --since)
    --added-before <when>           ISO-8601 or a period like 7d / 24h
    --unopened                      only bookmarks never opened in MYNK
    --favorites                     only favorites
  get <id|url>                      one bookmark in full
  recent                            recently added bookmarks
    --days <n>                      how far back, default 7
    --since <when>                  ISO-8601 or a period like 7d / 24h, instead of --days
    --limit <n>                     1-100, default 20
    --unopened                      only bookmarks never opened in MYNK
  unopened                          bookmarks never opened in MYNK
    --days <n>                      how far back, default 7
    --limit <n>                     1-100, default 20
  collections                       collections with member counts
  tags                              tags with counts
  categories                        category ids in use, with counts
  add <url>                         queue a bookmark for MYNK
    --title <title>
    --tag <tag>                     repeatable
    --note <note>
  stats                             library totals
  index                             build or refresh the embedding index
  doctor                            directories, library, inbox, index, Ollama
  install --client <name>           write a client's MCP configuration
    --client claude-code|codex|cursor|windsurf|generic
    --print                         show the configuration instead of writing it

OPTIONS
  --json                            print JSON instead of text
  --version
  --help
";

/// One parsed command line: what came after the subcommand.
#[derive(Debug, Default)]
struct Parsed {
    positional: Vec<String>,
    /// `--name value` pairs in the order given, so `--tag` can repeat.
    values: Vec<(String, String)>,
    switches: Vec<String>,
}

impl Parsed {
    fn value(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn all(&self, name: &str) -> Vec<String> {
        self.values
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
            .collect()
    }

    fn has(&self, name: &str) -> bool {
        self.switches.iter().any(|switch| switch == name)
    }

    /// A flag that must be a number: `--limit lots` is a usage error, not the default.
    fn number(&self, name: &str) -> Result<Option<u32>, String> {
        match self.value(name) {
            None => Ok(None),
            Some(raw) => raw
                .trim()
                .parse::<u32>()
                .map(Some)
                .map_err(|_| format!("--{name} needs a whole number, not \"{raw}\".")),
        }
    }
}

/// Splits `args` into positionals, `--name value` pairs and switches. An unknown `--flag` is an
/// error.
fn parse(args: &[String], value_flags: &[&str], switch_flags: &[&str]) -> Result<Parsed, String> {
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        let Some(flag) = arg.strip_prefix("--") else {
            if arg.starts_with('-') && arg.len() > 1 {
                return Err(format!("Unknown option \"{arg}\"."));
            }
            parsed.positional.push(arg.clone());
            continue;
        };
        let (name, inline) = match flag.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (flag, None),
        };
        if value_flags.contains(&name) {
            let value = match inline {
                Some(value) => value,
                None => {
                    let value = args
                        .get(index)
                        .cloned()
                        .ok_or_else(|| format!("--{name} needs a value."))?;
                    index += 1;
                    value
                }
            };
            parsed.values.push((name.to_string(), value));
            continue;
        }
        if switch_flags.contains(&name) {
            if inline.is_some() {
                return Err(format!("--{name} does not take a value."));
            }
            parsed.switches.push(name.to_string());
            continue;
        }
        return Err(format!("Unknown option \"--{name}\"."));
    }
    Ok(parsed)
}

fn one_positional(parsed: &Parsed, what: &str) -> Result<String, String> {
    match parsed.positional.len() {
        0 => Err(format!("A {what} is required.")),
        1 => Ok(parsed.positional[0].clone()),
        // Several positionals are usually an unquoted multi-word query.
        _ => Ok(parsed.positional.join(" ")),
    }
}

/// The `--days` and `--limit` flags of the listing commands. A non-number is a usage error.
fn days_and_limit(parsed: &Parsed) -> Result<(Option<u32>, Option<u32>), AppError> {
    parsed
        .number("days")
        .and_then(|days| Ok((days, parsed.number("limit")?)))
        .map_err(AppError::invalid_input)
}

/// `1 bookmark`, `2 bookmarks`.
fn count(n: u64, one: &str, other: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { other })
}

fn text_of(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}

fn describe_record(value: &Value, index: Option<usize>) -> String {
    let mut line = match index {
        Some(index) => format!("{}. {}", index + 1, text_of(value, "title")),
        None => text_of(value, "title"),
    };
    if line.trim().is_empty() || line.ends_with(". ") {
        line.push_str("(untitled)");
    }
    let tags = value["tags"]
        .as_array()
        .map(|tags| {
            tags.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let mut facts = vec![
        text_of(value, "category"),
        format!("added {}", text_of(value, "createdAt")),
    ];
    if !tags.is_empty() {
        facts.push(format!("tags: {tags}"));
    }
    if value["lastOpenedAt"].is_null() {
        facts.push("never opened in MYNK".to_string());
    }
    if value["isFavorite"] == Value::Bool(true) {
        facts.push("favorite".to_string());
    }
    format!(
        "{line}\n   {}\n   {}\n   id: {}",
        text_of(value, "url"),
        facts.join(" · "),
        text_of(value, "id")
    )
}

fn describe_list(value: &Value, key: &str, empty: &str) -> String {
    let items = value[key].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        let mut text = empty.to_string();
        if let Some(note) = value["note"].as_str() {
            text.push('\n');
            text.push_str(note);
        }
        return text;
    }
    let mut lines: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(index, item)| describe_record(item, Some(index)))
        .collect();
    if let Some(note) = value["note"].as_str() {
        lines.push(String::new());
        lines.push(note.to_string());
    }
    lines.join("\n")
}

fn describe_recent(value: &Value) -> String {
    describe_list(value, "bookmarks", "Nothing was added in that period.")
}

/// `describe_list` appends the caveat from the answer's `note`.
fn describe_unopened(value: &Value) -> String {
    describe_list(
        value,
        "bookmarks",
        "Everything added in that period has been opened.",
    )
}

fn describe_index(value: &Value) -> String {
    let total = value["total"].as_u64().unwrap_or_default();
    format!(
        "Embedded {} of {}.",
        value["embedded"],
        count(total, "bookmark", "bookmarks")
    )
}

fn describe_search(value: &Value) -> String {
    let mut text = describe_list(value, "hits", "No bookmark matched.");
    let mode = text_of(value, "modeUsed");
    let total = value["total"].as_u64().unwrap_or_default();
    text.push_str(&format!(
        "\n\n{}, {mode} search",
        count(total, "hit", "hits")
    ));
    text
}

fn describe_detail(value: &Value) -> String {
    let mut lines = vec![describe_record(value, None)];
    let summary = value["summary"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|line| format!("   - {line}"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !summary.is_empty() {
        lines.push("   summary:".to_string());
        lines.extend(summary);
    }
    let description = text_of(value, "description");
    if !description.is_empty() {
        lines.push(format!("   {description}"));
    }
    lines.push(format!(
        "   analysis: {} · link: {}",
        text_of(&value["analysis"], "status"),
        text_of(&value["link"], "status")
    ));
    lines.join("\n")
}

fn describe_counts(value: &Value, key: &str, empty: &str) -> String {
    let items = value[key].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return empty.to_string();
    }
    items
        .iter()
        .map(|item| {
            // serde_json's Display ignores `{:>5}`, so pad the number itself.
            format!(
                "{:>5}  {}",
                item["count"].as_u64().unwrap_or_default(),
                item["name"].as_str().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Collections as `<count>  <name>` with the id below, since `search --collection` takes the id.
fn describe_collections(value: &Value, empty: &str) -> String {
    let items = value["collections"].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return empty.to_string();
    }
    items
        .iter()
        .map(|item| {
            let mut line = format!(
                "{:>5}  {}",
                item["count"].as_u64().unwrap_or_default(),
                item["name"].as_str().unwrap_or_default()
            );
            line.push_str(&format!("\n       id: {}", text_of(item, "id")));
            let description = text_of(item, "description");
            if !description.is_empty() {
                line.push_str(&format!("\n       {description}"));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn describe_stats(value: &Value) -> String {
    let mut lines = vec![
        format!("bookmarks    {}", value["total"]),
        format!(
            "analyzed     {} ({} still to do)",
            value["analyzed"], value["unanalyzed"]
        ),
        format!("broken links {}", value["brokenLinks"]),
        format!("favorites    {}", value["favorites"]),
        format!("collections  {}", value["collections"]),
        format!(
            "newest       {}",
            value["newestAddedAt"].as_str().unwrap_or("none yet")
        ),
        format!("inbox        {} waiting", value["pendingInbox"]),
        format!(
            "app open     {}",
            if value["appRunning"] == Value::Bool(true) {
                "yes"
            } else {
                "no"
            }
        ),
    ];
    let unreadable = value["unreadableRecords"].as_u64().unwrap_or_default();
    if unreadable > 0 {
        lines.push(format!(
            "note         {} could not be read and {} left out",
            count(unreadable, "record", "records"),
            if unreadable == 1 { "was" } else { "were" }
        ));
    }
    let categories = describe_counts(value, "byCategory", "");
    if !categories.is_empty() {
        lines.push(String::new());
        lines.push("by category".to_string());
        lines.push(categories);
    }
    lines.join("\n")
}

/// Prints `value` as JSON or `text` as is.
fn emit(out: &mut dyn Write, as_json: bool, value: &Value, text: String) -> std::io::Result<()> {
    if as_json {
        let rendered = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
        writeln!(out, "{rendered}")
    } else {
        writeln!(out, "{text}")
    }
}

async fn run_search(engine: &Engine, parsed: &Parsed) -> Result<Value, AppError> {
    let query = one_positional(parsed, "query").map_err(AppError::invalid_input)?;
    let request = SearchRequest {
        query,
        mode: parsed.value("mode").map(str::to_string),
        limit: parsed.number("limit").map_err(AppError::invalid_input)?,
        category: parsed.value("category").map(str::to_string),
        tag: parsed.value("tag").map(str::to_string),
        collection_id: parsed.value("collection").map(str::to_string),
        // `--since` is an alias of `--added-after`; the MCP tool calls it `added_after`.
        added_after: parsed
            .value("added-after")
            .or_else(|| parsed.value("since"))
            .map(str::to_string),
        added_before: parsed.value("added-before").map(str::to_string),
        unopened_only: parsed.has("unopened"),
        favorites_only: parsed.has("favorites"),
    };
    engine.search(&request).await
}

fn run_add(engine: &Engine, parsed: &Parsed) -> Result<Value, AppError> {
    // Unlike a query, two URLs never mean one; joined they would queue a single broken address.
    if parsed.positional.len() > 1 {
        return Err(AppError::invalid_input(
            "Give one URL per add command; a title goes after --title, in quotes.",
        ));
    }
    let url = one_positional(parsed, "URL").map_err(AppError::invalid_input)?;
    engine.add(&AddRequest {
        url,
        title: parsed.value("title").map(str::to_string),
        tags: parsed.all("tag"),
        note: parsed.value("note").map(str::to_string),
        source: "cli".to_string(),
    })
}

/// `index`: builds the embedding index. Progress goes to stderr so `--json` output stays clean.
async fn run_index(engine: &Engine, err: &mut dyn Write) -> AppResult<Value> {
    let library = engine.library()?;
    let _ = writeln!(err, "Building the embedding index...");
    // The callback outlives this borrow of `err`, so it writes to stderr directly.
    let progress = Box::new(|progress: BuildProgress| {
        let mut stderr = std::io::stderr();
        let _ = writeln!(stderr, "embedding {}/{}", progress.embedded, progress.total);
    });
    let report = semantic_link::build(
        &library,
        engine.data_dir(),
        engine.cache_dir(),
        Some(progress),
    )
    .await
    .map_err(|error| AppError::Config(error.to_string()))?;
    Ok(json!({
        "embedded": report.embedded,
        "total": report.total,
        "complete": report.complete,
        "model": report.model,
    }))
}

/// The `--client` values, for the messages that list them.
fn client_names() -> String {
    CLIENTS
        .iter()
        .map(|client| client.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn run_install(parsed: &Parsed, err: &mut dyn Write) -> Result<(Value, String), AppError> {
    let Some(name) = parsed.value("client") else {
        return Err(AppError::invalid_input(format!(
            "--client is required: {}.",
            client_names()
        )));
    };
    let client = Client::parse(name).ok_or_else(|| {
        AppError::invalid_input(format!(
            "Unknown client \"{name}\". Choose one of: {}.",
            client_names()
        ))
    })?;
    let exe = std::env::current_exe()
        .map_err(|error| {
            AppError::internal(format!(
                "This program's own path could not be read: {error}"
            ))
        })?
        .display()
        .to_string();

    if parsed.has("print") {
        let text = install::instructions(client, &exe);
        return Ok((
            json!({ "client": client.as_str(), "command": exe, "configuration": text, "written": false }),
            text,
        ));
    }
    let planned = install::plan(client, &exe)?;
    // On failure, print the plan too: the error does not name the file.
    let summary = planned.summary.clone();
    let outcome = install::apply(planned).inspect_err(|_| {
        let _ = writeln!(err, "{summary}");
    })?;
    let mut text = outcome.plan.clone();
    if outcome.changed {
        if let Some(backup) = &outcome.backup {
            text.push_str(&format!(
                "\nThe previous file was copied to {}.",
                backup.display()
            ));
        }
        text.push_str("\nDone. Restart the client to pick it up.");
    }
    Ok((
        json!({
            "client": client.as_str(),
            "command": exe,
            "path": outcome.path.as_ref().map(|path| path.display().to_string()),
            "backup": outcome.backup.as_ref().map(|path| path.display().to_string()),
            "written": outcome.changed,
            "plan": outcome.plan,
        }),
        text,
    ))
}

/// Every subcommand. [`Command::options`] lists its flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    Search,
    Get,
    Recent,
    Unopened,
    Add,
    Collections,
    Tags,
    Categories,
    Stats,
    Index,
    Doctor,
    Install,
}

impl Command {
    const ALL: [Command; 12] = [
        Command::Search,
        Command::Get,
        Command::Recent,
        Command::Unopened,
        Command::Add,
        Command::Collections,
        Command::Tags,
        Command::Categories,
        Command::Stats,
        Command::Index,
        Command::Doctor,
        Command::Install,
    ];

    fn name(self) -> &'static str {
        match self {
            Command::Search => "search",
            Command::Get => "get",
            Command::Recent => "recent",
            Command::Unopened => "unopened",
            Command::Add => "add",
            Command::Collections => "collections",
            Command::Tags => "tags",
            Command::Categories => "categories",
            Command::Stats => "stats",
            Command::Index => "index",
            Command::Doctor => "doctor",
            Command::Install => "install",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|command| command.name() == name)
    }

    /// The `--name value` options and the bare switches this command accepts.
    fn options(self) -> (&'static [&'static str], &'static [&'static str]) {
        match self {
            Command::Search => (
                &[
                    "mode",
                    "limit",
                    "category",
                    "tag",
                    "collection",
                    "since",
                    "added-after",
                    "added-before",
                ],
                &["json", "unopened", "favorites"],
            ),
            Command::Recent => (&["days", "limit", "since"], &["json", "unopened"]),
            Command::Unopened => (&["days", "limit"], &["json"]),
            Command::Add => (&["title", "tag", "note"], &["json"]),
            Command::Install => (&["client"], &["json", "print"]),
            Command::Get
            | Command::Collections
            | Command::Tags
            | Command::Categories
            | Command::Stats
            | Command::Index
            | Command::Doctor => (&[], &["json"]),
        }
    }
}

/// An answer paired with its text rendering.
fn with_text(value: Value, describe: impl FnOnce(&Value) -> String) -> (Value, String) {
    let text = describe(&value);
    (value, text)
}

/// Runs one command line. `args` is everything after the program name.
pub async fn execute(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    let Some(command) = args.first().map(String::as_str) else {
        // No subcommand means the MCP server, which `run_binary` starts.
        let _ = writeln!(err, "{USAGE}");
        return EXIT_USAGE;
    };
    match command {
        "--help" | "-h" | "help" => {
            let _ = writeln!(out, "{USAGE}");
            return EXIT_OK;
        }
        "--version" | "-V" | "version" => {
            let _ = writeln!(out, "mynk-mcp {}", env!("CARGO_PKG_VERSION"));
            return EXIT_OK;
        }
        _ => {}
    }

    let spec = Command::parse(command)
        .ok_or_else(|| format!("Unknown command \"{command}\"."))
        .and_then(|command| {
            let (values, switches) = command.options();
            parse(&args[1..], values, switches).map(|parsed| (command, parsed))
        });
    let (command, parsed) = match spec {
        Ok(parsed) => parsed,
        Err(message) => {
            let _ = writeln!(err, "{message}\n\n{USAGE}");
            return EXIT_USAGE;
        }
    };
    let as_json = parsed.has("json");

    // `install` does not read the library, so it runs without a data directory.
    if command == Command::Install {
        let rendered = run_install(&parsed, err);
        return finish(out, err, as_json, rendered);
    }

    let engine = match Engine::from_env() {
        Ok(engine) => Arc::new(engine),
        Err(error) => {
            let _ = writeln!(err, "{error}");
            return EXIT_FAILURE;
        }
    };

    let rendered: Result<(Value, String), AppError> = match command {
        Command::Search => run_search(&engine, &parsed)
            .await
            .map(|value| with_text(value, describe_search)),
        Command::Get => one_positional(&parsed, "bookmark id or URL")
            .map_err(AppError::invalid_input)
            .and_then(|needle| engine.get(&needle))
            .map(|value| with_text(value, describe_detail)),
        Command::Recent => days_and_limit(&parsed)
            .and_then(|(days, limit)| {
                engine.recent(&ListRequest {
                    days,
                    since: parsed.value("since").map(str::to_string),
                    limit,
                    unopened_only: parsed.has("unopened"),
                })
            })
            .map(|value| with_text(value, describe_recent)),
        Command::Unopened => days_and_limit(&parsed)
            .and_then(|(days, limit)| {
                engine.unopened(&ListRequest {
                    days,
                    since: None,
                    limit,
                    unopened_only: true,
                })
            })
            .map(|value| with_text(value, describe_unopened)),
        Command::Add => run_add(&engine, &parsed).map(|value| {
            let text = match value["appearsIn"].as_str() {
                Some("seconds") => format!(
                    "Queued {}. MYNK is open, so it appears in a few seconds.",
                    text_of(&value, "url")
                ),
                _ => format!(
                    "Queued {}. MYNK is closed, so it appears at its next launch.",
                    text_of(&value, "url")
                ),
            };
            (value, text)
        }),
        Command::Collections => engine.collections().map(|value| {
            with_text(value, |value| {
                describe_collections(value, "No collections yet.")
            })
        }),
        Command::Tags => engine.tags().map(|value| {
            with_text(value, |value| {
                describe_counts(value, "tags", "No tags yet.")
            })
        }),
        Command::Categories => engine.categories().map(|value| {
            with_text(value, |value| {
                describe_counts(value, "categories", "No categories yet.")
            })
        }),
        Command::Stats => engine.stats().map(|value| with_text(value, describe_stats)),
        Command::Index => run_index(&engine, err)
            .await
            .map(|value| with_text(value, describe_index)),
        Command::Doctor => {
            let report = doctor::report(&engine).await;
            let healthy = doctor::is_healthy(&report);
            let code = finish(out, err, as_json, Ok(with_text(report, doctor::render)));
            return if healthy { code } else { EXIT_FAILURE };
        }
        Command::Install => unreachable!("install returned above"),
    };

    finish(out, err, as_json, rendered)
}

/// Prints one command's answer and returns its exit code.
fn finish(
    out: &mut dyn Write,
    err: &mut dyn Write,
    as_json: bool,
    rendered: Result<(Value, String), AppError>,
) -> i32 {
    match rendered {
        Ok((value, text)) => {
            let _ = emit(out, as_json, &value, text);
            EXIT_OK
        }
        Err(error) if error.kind() == "invalidInput" => {
            let _ = writeln!(err, "{error}");
            EXIT_USAGE
        }
        Err(error) => {
            if as_json {
                let _ = writeln!(
                    err,
                    "{}",
                    json!({ "error": { "kind": error.kind(), "message": error.to_string() } })
                );
            } else {
                let _ = writeln!(err, "{error}");
            }
            EXIT_FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::output;

    fn args(line: &[&str]) -> Vec<String> {
        line.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn the_usage_text_lists_every_command_and_option_the_parser_accepts() {
        for command in Command::ALL {
            assert_eq!(Command::parse(command.name()), Some(command));
            assert!(
                USAGE.contains(&format!("\n  {} ", command.name())),
                "{} is missing from USAGE",
                command.name()
            );
            let (values, switches) = command.options();
            for option in values.iter().chain(switches.iter()) {
                assert!(
                    USAGE.contains(&format!("--{option}")),
                    "--{option} of {} is missing from USAGE",
                    command.name()
                );
            }
        }
        assert_eq!(Command::parse("frobnicate"), None);
    }

    #[test]
    fn flags_values_and_positionals_are_separated() {
        let parsed = parse(
            &args(&[
                "ownership",
                "rust",
                "--mode",
                "keyword",
                "--limit=5",
                "--json",
            ]),
            &["mode", "limit"],
            &["json"],
        )
        .expect("parse");
        assert_eq!(parsed.positional, vec!["ownership", "rust"]);
        assert_eq!(parsed.value("mode"), Some("keyword"));
        assert_eq!(parsed.value("limit"), Some("5"));
        assert!(parsed.has("json"));
        assert!(!parsed.has("unopened"));
        assert_eq!(
            one_positional(&parsed, "query").expect("query"),
            "ownership rust",
            "an unquoted multi-word query is put back together"
        );
    }

    #[test]
    fn a_repeated_value_flag_collects_every_occurrence() {
        let parsed = parse(
            &args(&["https://x.test", "--tag", "rust", "--tag", "memory"]),
            &["tag"],
            &[],
        )
        .expect("parse");
        assert_eq!(parsed.all("tag"), vec!["rust", "memory"]);
        assert_eq!(parsed.value("tag"), Some("rust"), "the first one wins");
    }

    #[test]
    fn a_typo_is_refused_rather_than_ignored() {
        for line in [
            vec!["--unopend"],
            vec!["--mode"],
            vec!["--json=yes"],
            vec!["-x"],
        ] {
            let error = parse(&args(&line), &["mode"], &["json"]).expect_err(&format!("{line:?}"));
            assert!(!error.is_empty(), "{line:?}");
        }
        assert!(parse(&args(&["--mode", "keyword"]), &["mode"], &["json"]).is_ok());
    }

    #[test]
    fn a_flag_that_needs_a_number_says_so() {
        let parsed = parse(&args(&["--limit", "lots"]), &["limit"], &[]).expect("parse");
        let error = parsed.number("limit").expect_err("not a number");
        assert!(error.contains("whole number"), "{error}");
        let parsed = parse(&args(&["--limit", "7"]), &["limit"], &[]).expect("parse");
        assert_eq!(parsed.number("limit").expect("number"), Some(7));
        assert_eq!(Parsed::default().number("limit").expect("absent"), None);
    }

    #[test]
    fn a_missing_positional_is_a_usage_error() {
        let parsed = Parsed::default();
        let error = one_positional(&parsed, "URL").expect_err("nothing given");
        assert_eq!(error, "A URL is required.");
    }

    #[test]
    fn the_usage_text_lists_every_command_and_client() {
        for command in [
            "search",
            "get",
            "recent",
            "unopened",
            "collections",
            "tags",
            "categories",
            "add",
            "stats",
            "index",
            "doctor",
            "install",
        ] {
            assert!(USAGE.contains(command), "{command} is undocumented");
        }
        for client in CLIENTS {
            assert!(USAGE.contains(client.as_str()), "{client} is undocumented");
        }
        for flag in [
            "--category",
            "--tag",
            "--collection",
            "--added-after",
            "--added-before",
            "--since",
            "--unopened",
            "--favorites",
        ] {
            assert!(USAGE.contains(flag), "{flag} is undocumented");
        }
    }

    #[test]
    fn every_tool_has_a_subcommand() {
        for (tool, command) in [
            ("search_bookmarks", "search"),
            ("get_bookmark", "get"),
            ("list_recent", "recent"),
            ("list_unopened", "unopened"),
            ("list_collections", "collections"),
            ("list_tags", "tags"),
            ("list_categories", "categories"),
            ("library_stats", "stats"),
            ("add_bookmark", "add"),
        ] {
            assert!(
                USAGE.contains(&format!("\n  {command}")),
                "{tool} has no {command} subcommand"
            );
        }
    }

    #[test]
    fn the_search_filter_flags_reach_the_request() {
        let parsed = parse(
            &args(&[
                "rust",
                "--collection",
                "c1",
                "--added-after",
                "7d",
                "--added-before",
                "2026-01-01",
                "--category",
                "development",
                "--tag",
                "memory",
                "--favorites",
            ]),
            &[
                "mode",
                "limit",
                "category",
                "tag",
                "collection",
                "since",
                "added-after",
                "added-before",
            ],
            &["json", "unopened", "favorites"],
        )
        .expect("parse");
        assert_eq!(parsed.value("collection"), Some("c1"));
        assert_eq!(parsed.value("added-after"), Some("7d"));
        assert_eq!(parsed.value("added-before"), Some("2026-01-01"));
        assert_eq!(parsed.value("category"), Some("development"));
        assert_eq!(parsed.value("tag"), Some("memory"));
        assert!(parsed.has("favorites"));
    }

    #[test]
    fn records_render_with_the_facts_that_matter() {
        let value = json!({
            "id": "r1",
            "url": "https://doc.rust-lang.org/book/",
            "title": "Ownership in Rust",
            "description": "Borrowing and lifetimes.",
            "tags": ["rust", "memory"],
            "category": "development",
            "summary": ["One owner per value."],
            "createdAt": "2025-09-08T00:00:00Z",
            "lastOpenedAt": null,
            "isFavorite": true,
            "analysis": { "status": "ok" },
            "link": { "status": "alive" }
        });
        let line = describe_record(&value, Some(0));
        assert!(line.starts_with("1. Ownership in Rust"), "{line}");
        assert!(line.contains("https://doc.rust-lang.org/book/"), "{line}");
        assert!(line.contains("development"), "{line}");
        assert!(line.contains("tags: rust, memory"), "{line}");
        assert!(line.contains("never opened in MYNK"), "{line}");
        assert!(line.contains("favorite"), "{line}");
        assert!(line.contains("id: r1"), "{line}");

        let detail = describe_detail(&value);
        assert!(detail.contains("- One owner per value."), "{detail}");
        assert!(detail.contains("Borrowing and lifetimes."), "{detail}");
        assert!(detail.contains("analysis: ok · link: alive"), "{detail}");
    }

    #[test]
    fn an_empty_answer_still_says_something_useful() {
        let empty = json!({ "hits": [], "total": 0, "modeUsed": "keyword", "note": null });
        let text = describe_search(&empty);
        assert!(text.contains("No bookmark matched."), "{text}");
        assert!(text.contains("0 hits, keyword search"), "{text}");

        let with_note = json!({
            "bookmarks": [],
            "total": 0,
            "note": output::VISIT_CAVEAT
        });
        let text = describe_list(&with_note, "bookmarks", "Nothing here.");
        assert!(text.contains("Nothing here."), "{text}");
        // The caveat comes only from the note, so it appears once.
        assert_eq!(text.matches(output::VISIT_CAVEAT).count(), 1, "{text}");
    }

    #[test]
    fn counts_and_stats_render_as_columns() {
        let counts = json!({ "tags": [{ "name": "rust", "count": 3 }], "total": 1 });
        assert_eq!(describe_counts(&counts, "tags", "No tags."), "    3  rust");
        assert_eq!(
            describe_counts(&json!({ "tags": [] }), "tags", "No tags."),
            "No tags."
        );

        let stats = json!({
            "total": 42,
            "byCategory": [{ "name": "development", "count": 40 }],
            "analyzed": 40,
            "unanalyzed": 2,
            "brokenLinks": 1,
            "favorites": 3,
            "collections": 2,
            "newestAddedAt": "2025-09-08T00:00:00Z",
            "unreadableRecords": 1,
            "pendingInbox": 0,
            "appRunning": true
        });
        let text = describe_stats(&stats);
        assert!(text.contains("bookmarks    42"), "{text}");
        assert!(text.contains("analyzed     40 (2 still to do)"), "{text}");
        assert!(text.contains("app open     yes"), "{text}");
        assert!(
            text.contains("1 record could not be read and was left out"),
            "{text}"
        );
        let several = describe_stats(&json!({ "unreadableRecords": 3 }));
        assert!(
            several.contains("3 records could not be read and were left out"),
            "{several}"
        );
        assert!(!describe_stats(&json!({ "unreadableRecords": 0 })).contains("could not be read"));
        assert!(
            text.contains("\nby category\n   40  development"),
            "the counts need a heading that says what they count: {text}"
        );
    }

    #[test]
    fn empty_lists_and_the_index_summary_say_what_happened() {
        let empty = json!({ "bookmarks": [], "total": 0, "note": null });
        assert_eq!(describe_recent(&empty), "Nothing was added in that period.");
        let caveat = json!({ "bookmarks": [], "total": 0, "note": output::VISIT_CAVEAT });
        assert_eq!(
            describe_unopened(&caveat),
            format!(
                "Everything added in that period has been opened.\n{}",
                output::VISIT_CAVEAT
            )
        );
        assert_eq!(
            describe_index(&json!({ "embedded": 3, "total": 5 })),
            "Embedded 3 of 5 bookmarks."
        );
        assert_eq!(
            describe_index(&json!({ "embedded": 1, "total": 1 })),
            "Embedded 1 of 1 bookmark."
        );
    }

    #[test]
    fn collections_render_with_the_id_the_search_filter_takes() {
        let value = json!({
            "collections": [
                { "id": "c1", "name": "Rust", "description": "Rust reading list", "count": 3 }
            ],
            "total": 1
        });
        let text = describe_collections(&value, "No collections yet.");
        assert!(text.contains("    3  Rust"), "{text}");
        assert!(text.contains("id: c1"), "{text}");
        assert!(text.contains("Rust reading list"), "{text}");
        assert_eq!(
            describe_collections(&json!({ "collections": [] }), "No collections yet."),
            "No collections yet."
        );
    }

    #[test]
    fn json_mode_prints_the_value_and_text_mode_the_text() {
        let value = json!({ "total": 1 });
        let mut out = Vec::new();
        emit(&mut out, true, &value, "ignored".into()).expect("write");
        let printed = String::from_utf8(out).expect("utf8");
        assert!(printed.contains("\"total\": 1"), "{printed}");
        assert!(!printed.contains("ignored"), "{printed}");

        let mut out = Vec::new();
        emit(&mut out, false, &value, "the answer".into()).expect("write");
        assert_eq!(String::from_utf8(out).expect("utf8"), "the answer\n");
    }

    #[tokio::test]
    async fn help_and_version_answer_without_touching_the_library() {
        for (line, needle) in [
            (vec!["--help"], "USAGE"),
            (vec!["help"], "COMMANDS"),
            (vec!["--version"], "mynk-mcp "),
            (vec!["-V"], env!("CARGO_PKG_VERSION")),
        ] {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = execute(&args(&line), &mut out, &mut err).await;
            assert_eq!(code, EXIT_OK, "{line:?}");
            let printed = String::from_utf8(out).expect("utf8");
            assert!(printed.contains(needle), "{line:?}: {printed}");
        }
    }

    #[tokio::test]
    async fn a_wrong_command_line_exits_with_two() {
        for line in [
            vec![],
            vec!["frobnicate"],
            vec!["search", "--mode"],
            vec!["search", "--nope"],
            vec!["get"],
        ] {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = execute(&args(&line), &mut out, &mut err).await;
            assert_eq!(code, EXIT_USAGE, "{line:?}");
            assert!(
                !String::from_utf8_lossy(&err).is_empty(),
                "{line:?} must explain itself"
            );
        }
    }

    #[tokio::test]
    async fn install_print_shows_a_configuration_without_writing_anything() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = execute(
            &args(&["install", "--client", "generic", "--print"]),
            &mut out,
            &mut err,
        )
        .await;
        assert_eq!(code, EXIT_OK, "{}", String::from_utf8_lossy(&err));
        let printed = String::from_utf8(out).expect("utf8");
        assert!(printed.contains("\"mcpServers\""), "{printed}");
        assert!(printed.contains("mynk"), "{printed}");
    }

    #[tokio::test]
    async fn install_refuses_a_client_it_does_not_know() {
        for line in [
            vec!["install", "--print"],
            vec!["install", "--client", "emacs", "--print"],
        ] {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = execute(&args(&line), &mut out, &mut err).await;
            assert_eq!(code, EXIT_USAGE, "{line:?}");
            let message = String::from_utf8_lossy(&err).to_string();
            assert!(message.contains("claude-code"), "{message}");
        }
    }
}
