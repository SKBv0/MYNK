# Contributing

Bug reports and small pull requests are welcome. For bigger changes, open an issue first.

## Setup

On Windows:

- Node.js 24+ (CI uses the version in `.nvmrc`)
- Rust via rustup (the version is pinned in `rust-toolchain.toml`)
- Visual Studio Build Tools with the Windows SDK
- Ollama, if you work on the AI side

Run cargo from PowerShell, not Git Bash. Git Bash's `link.exe` shadows the MSVC linker.

On Linux (Ubuntu 22.04 or 24.04), install the Tauri dependencies first:

```bash
sudo apt install build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev \
  libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev xdg-utils
```

Then:

```bash
npm install
npm run build:mcp
npm run tauri:dev
```

`npm run tauri:dev` first runs `npm run prepare:rust`. It creates an empty `dist` folder and an
empty `mynk-mcp` sidecar placeholder when they are missing, because the Tauri build step expects
both. `npm run build:mcp` replaces the placeholder with the real binary, which the **Agents** tab
and anything MCP-related need. Skip it if you don't work on that side, and run it again after you
change the `mynk-mcp` code.

The dev server uses port 7426. If `tauri:dev` says the port is taken, close the old Vite process.

`npm run tauri:e2e` runs the app with separate data folders, so you can test without touching your
own library.

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
```

If you changed Rust code, also run `npm run rust:fmt:check`, `npm run rust:lint` and
`npm run rust:test`. If you changed a dependency, run `npm run licenses`.

Code rules:

- User-facing text goes in `src/translations/`, in both English and Turkish.
- The UI only uses the components in `src/components/ui/` and the tokens in `src/index.css`.
- File paths do not reach the UI. The one exception is the `mynk-mcp` path shown in Settings,
  Agents.
- Command types live in `src/services/ipcTypes.ts`.
- If you change the shape of `library.json`, add a migration and a test in `src/store/migrate.ts` so
  old libraries still load.

## Adding a language

1. Create a new file `src/translations/<code>.ts` (for example `de.ts`), using `en.ts` as the
   template, and translate the text in the new file. The new file is typed against the English
   one, so `npm run typecheck` lists any missing key.
2. Register it in `src/translations.ts` (the `Language` type, `isLanguage` and `translations`) and
   add the code to `UiLanguage` in `src/services/ipcTypes.ts`.
3. Add it to the language switcher in `src/components/Sidebar.tsx`, and add its name to
   `sidebar.languages` in every translation file.
4. Add its locale to `LOCALES` in `src/lib/format.ts`, so dates and numbers use it.
5. Add it to the `Lang` enum in `src-tauri/src/analyze/mod.rs`, so the AI writes summaries in that
   language.

## Release builds

Release builds go through `npm run tauri:build` and `npm run build:mcp`. Don't call cargo directly
for them.
