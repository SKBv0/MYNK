# MYNK

English | [Türkçe](README.tr.md)

MYNK turns saved pages into a searchable library with summaries, categories, tags and previews.
Find a page by its content, or ask your library a question and follow the cited sources.

Use a local model through Ollama or a cloud model through OpenRouter. The MCP bridge also lets
agents search, read and add bookmarks.

## Preview

The images below use a sample library. Click an image to see it at full size.

<table>
  <tr>
    <td align="center"><a href="docs/media/library.png"><img src="docs/media/library.png" alt="MYNK sample library in grid view" width="380"></a><br><sub>Library</sub></td>
    <td align="center"><a href="docs/media/mynk-usage.mp4"><img src="docs/media/mynk-usage-preview.png" alt="Play the 47-second MYNK preview video" width="380"></a><br><sub>Video · 47 seconds · English</sub></td>
  </tr>
  <tr>
    <td align="center"><a href="docs/media/details.png"><img src="docs/media/details.png" alt="Bookmark details with summary, tags and key points" width="380"></a><br><sub>Bookmark details</sub></td>
    <td align="center"><a href="docs/media/chat.png"><img src="docs/media/chat.png" alt="Ask your library with cited answers" width="380"></a><br><sub>Ask your library · cited answers</sub></td>
  </tr>
</table>

<details>
<summary>More views: summaries, graph, reports and link health</summary>

<table>
  <tr>
    <td align="center"><a href="docs/media/summaries.png"><img src="docs/media/summaries.png" alt="Summaries view" width="360"></a><br><sub>Summaries</sub></td>
    <td align="center"><a href="docs/media/graph.png"><img src="docs/media/graph.png" alt="Graph view" width="360"></a><br><sub>Graph</sub></td>
  </tr>
  <tr>
    <td align="center"><a href="docs/media/report.png"><img src="docs/media/report.png" alt="Combined report" width="360"></a><br><sub>Combined report</sub></td>
    <td align="center"><a href="docs/media/health.png"><img src="docs/media/health.png" alt="Link health" width="360"></a><br><sub>Link health</sub></td>
  </tr>
</table>
</details>

## Features

- Import from Chrome, Edge, Brave, Vivaldi, Opera and Firefox, from an HTML bookmark file, or from a
  Chrome/Chromium `Bookmarks` file
- Page summaries, categories and tags, which you can edit
- Search by title, summary, tag or URL
- Collections and favorites
- Grid, summaries, timeline and graph views
- Ask your library, and a combined report from selected bookmarks
- Broken link checks
- Page previews
- Full backup and restore
- MCP server

## How search and chat work

The search box matches text in the title, description, address, tags and summary. No AI model is
involved.

Ask your library picks up to 15 bookmarks whose words match your question and sends their summaries
to the chat model, always with the three newest and the date each was added. When no word matches,
it sends the 15 newest. The model answers and cites them as `[#n]`. A combined report does the same
with the bookmarks you selected. Both need only a chat model.

The agent bridge (`mynk-mcp`) can also search by meaning. That needs an Ollama embedding model:
pick one under Settings, AI provider, or leave it on Automatic. Without one, the agent searches by
keywords. This setting is optional and is not used by the app's search or chat.

## Languages

The interface is in English and Turkish. To add a language, follow the steps in
[CONTRIBUTING.md](CONTRIBUTING.md#adding-a-language).

## Install

The Windows 10/11 installer is on the [Releases](https://github.com/SKBv0/mynk/releases/latest)
page. No administrator rights needed.

The installer isn't signed yet, so SmartScreen will warn you. Click **More info → Run anyway**.
Later updates install from inside the app.

No installer for Linux or macOS yet; [build from source](#building-from-source). macOS is untested.

After installing, pick a model in the **AI provider** tab of Settings and import your bookmarks in
the **Data** tab.

## MCP

`mynk-mcp` is installed with the app. The **Agents** tab in Settings has ready-made configs for
Claude Code, Codex, Cursor and Windsurf. For any other client, copy the JSON shown there.

The main tools are `search_bookmarks`, `get_bookmark`, `list_recent` and `add_bookmark`. The full
list is in [docs/mcp.md](docs/mcp.md).

Links your agent adds go to an inbox folder first. While MYNK is open, it picks them up within about
ten seconds and analyzes them; the analysis can take a few minutes. If MYNK is closed, this happens
on the next launch.

## Privacy

Your library stays on your computer, in `%APPDATA%\com.mynk.desktop\library.json`. There's no
account and no usage data is collected.

This is what leaves your computer, and where it goes:

- **The sites you saved.** Analysis, link checks and previews request each bookmark's page from its
  site.
- **Other hosts a page points to.** Favicons and preview images are downloaded from the address the
  page gives, often a CDN.
- **Your AI provider.** Analysis sends the page text and its address. Ask your library and combined
  reports send the titles, addresses, tags, summaries and key points of the bookmarks involved,
  together with your questions. With Ollama this goes to the Ollama address in Settings, usually
  your own computer. With OpenRouter it goes to OpenRouter, which passes it to the model's provider.
- **example.com.** Link health scans look up `example.com` in DNS, to tell "you are offline" apart
  from "the site is down".
- **GitHub.** Once a day MYNK checks this repository's Releases page for a new version.

For previews, and for pages that a plain download cannot read during analysis, MYNK opens the page
in the background with the Chrome or Edge installed on your computer. The page's scripts run there
and the page loads whatever else it asks for, as in a normal visit. The browser uses a temporary
profile that is deleted afterwards.

## Building from source

Requires Node.js 24+, Rust (rustup) and the build tools for your system (Visual Studio Build Tools
on Windows, the Tauri libraries on Linux). The details are in [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm install
npm run build:mcp
npm run tauri:dev
```

`npm run build:mcp` builds the `mynk-mcp` binary the agent bridge uses. You can skip it if you don't
need MCP; the app still runs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
