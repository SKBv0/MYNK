# Use MYNK with an agent

MYNK includes a separate `mynk-mcp` program. It lets an MCP client that supports stdio search
your saved bookmarks, inspect a bookmark, and queue new links. MYNK does not have to be open for
the agent to search. Links added while it is closed are imported when you next launch the app.

The server uses MCP over standard input and output (stdio); it does not open a listening port.

## Let your coding agent set it up

If your coding agent can read this project and edit its own local MCP configuration, ask it to
set up the connection first. Saying only "use MYNK" may not be enough: an unconfigured client
does not automatically discover this project's MCP server. For example:

> Read this project's `docs/mcp.md` and set up MYNK's MCP server for this client. Find the
> installed `mynk-mcp` executable, preserve my other MCP settings, and check whether MYNK's
> tools appear. If the client needs a restart, tell me; do not claim the connection works until
> you can call a MYNK tool. If you cannot access the executable or configuration, tell me what
> you need instead of guessing a path.

The agent needs access to the installed `mynk-mcp` executable and its own configuration, not just
the source code. A successful configuration edit is not proof that the client has connected; a
tool call after any required restart is the check. If your agent cannot do the setup itself, use
the steps below.

## Connect a client manually

1. Install MYNK, then open **Settings → Agents**. The page shows whether `mynk-mcp` is available
   and displays its actual executable path. If it is missing, install a build that includes the
   agent program.
2. Select your client and copy the configuration shown there. For Claude Code, run the displayed
   `claude mcp add` command. For Codex, Cursor, or Windsurf, add the snippet to that client's MCP
   configuration. For another client, use the JSON as a starting point and follow its stdio MCP
   configuration format.
3. Restart the client after changing its configuration. Ask it to find a bookmark you know is in
   MYNK to check the connection.

You can also configure a client from PowerShell. Copy the executable path from **Settings →
Agents** into `$mynk` below; it may differ between installations. The `&` is needed to run a path
stored in a PowerShell variable.

```powershell
$mynk = 'C:\path\shown\in\MYNK\mynk-mcp.exe'
& $mynk --version
& $mynk install --client codex
```

Replace `codex` with `cursor` or `windsurf` to configure either of those clients. The command
updates that client's `mynk` server entry; if the configuration file already exists, it copies
the previous file to a new `.bak` backup before writing. Other JSON entries are normally retained,
but formatting and key order can change. If an existing JSON file has a non-object `mcpServers`
value, that value is replaced; inspect the backup if you need it. Invalid JSON is refused rather
than overwritten.

Use `--print` to see instructions without writing a client configuration:

```powershell
& $mynk install --client codex --print
& $mynk install --client claude-code --print
& $mynk install --client generic --print
```

Claude Code and `generic` are print-only; the command does not register them automatically.

## What the agent can do

| Tool | Purpose |
| --- | --- |
| `search_bookmarks` | Search by words, meaning, or both; filter by category, tag, collection, date, unopened state, or favorite state. |
| `get_bookmark` | Get one bookmark by ID or URL, including its analysis and link-check status. |
| `list_recent` | Browse recently added bookmarks; defaults to the last 7 days. |
| `list_unopened` | List bookmarks not opened **inside MYNK**; defaults to the last 7 days. Browser visits are not tracked. |
| `list_collections`, `list_tags`, `list_categories` | List available filters and their counts. |
| `library_stats` | Show library totals, analysis progress, broken-link count, and whether MYNK is open. |
| `add_bookmark` | Queue an HTTP(S) URL with optional title, tags, and note. |

`search_bookmarks` defaults to hybrid search. Semantic search uses an Ollama embedding model; it
is optional and separate from the app's normal search and chat. Select an embedding model in
**Settings → AI provider**, or leave **Automatic** selected. If semantic search is unavailable,
the tool falls back to keyword matching and explains this in `note`. An empty query needs at least
one filter; use `list_recent` to browse without a query.

Search results have a `rank` (1 is best) and a `score` that is meaningful only within that answer.
If a long query has no exact match, keyword matching can relax the query; check `note` to see when
that happened. Date filters accept UTC times such as `2026-09-13T08:30:00Z`, dates such as
`2026-09-13` (midnight UTC), or relative periods such as `30m`, `24h`, `7d`, and `2w`. UTC times
without `Z` are also accepted; timezone offsets such as `+03:00` are not.

The server also offers `mynk://bookmark/{id}` and `mynk://collection/{id}` resources. The latter
includes up to 100 bookmarks. The `find_bookmark` prompt accepts an optional `description` of a
page you only partly remember.

## Adding links and privacy

`add_bookmark` writes to MYNK's inbox, not directly to the library. MYNK imports queued links
within seconds while open, or on its next launch. It deduplicates imported links and queues new
ones for analysis. Links imported through the app's browser/file import follow a different flow
and wait for **Analyze**.

The MCP program reads your local library. Its bookmark tools return bookmark fields, not local
media paths or chat history. Your MCP client can still pass tool results to its own model or
service; check that client's privacy settings. For semantic indexing and search, `mynk-mcp` can
contact the Ollama address configured in MYNK, which may be another machine. `index` uses that
address too, and `doctor` probes it. Keyword-only search does not need an embedding model.

## Command line

The same executable also works without an MCP client. In PowerShell, either run `doctor` with the
full executable path shown in **Settings → Agents**:

```powershell
& 'C:\path\shown\in\MYNK\mynk-mcp.exe' doctor
```

Or set `$mynk` to that path once per PowerShell session, then use it for any command below:

```powershell
$mynk = 'C:\path\shown\in\MYNK\mynk-mcp.exe'
& $mynk doctor
```

These examples use that `$mynk` variable:

```powershell
& $mynk search 'ownership in rust'
& $mynk search rust --mode keyword --limit 5
& $mynk search '' --tag rust --unopened
& $mynk get 'https://doc.rust-lang.org/book/'
& $mynk recent --days 3
& $mynk unopened --days 30
& $mynk collections
& $mynk tags
& $mynk categories
& $mynk stats
& $mynk add 'https://example.com/x' --title X --tag rust --note 'read later'
& $mynk index
& $mynk doctor
```

Add `--json` to a command for machine-readable output. `search` supports `--added-after` and
`--added-before`; `--since` is an alias for `--added-after`. Run `& $mynk --help` for every option.
`index` builds or refreshes the embedding index ahead of a semantic search. `doctor` reports the
data folders, library, inbox, index, and Ollama connection; read its report, because the command
can exit successfully even when a check says unavailable.

Exit codes are `0` for a completed command, `1` for a runtime failure, and `2` for an invalid
command or input. `MYNK_DATA_DIR` and `MYNK_CACHE_DIR` override the data folders;
`MYNK_HOME_DIR` changes where `install` looks for client configs; `MYNK_EMBED_MODEL` overrides the
embedding-model choice; and `MYNK_MCP_LOG` controls stderr logging (`error`, `warn`, `info`,
`debug`, `trace`, or `off`). MCP messages use stdout.
