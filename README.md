# Agent YOLO — AI Agents Extender (VS Code)

A VS Code port of the IntelliJ *Agent YOLO* plugin. It opens an embedded terminal
panel that launches AI CLI agents (Claude Code, Codex, Cursor CLI, …) with a one-click
**Skip permissions (YOLO)** toggle, and makes terminal output clickable: file paths, stack-trace
frames, type/member names, and URLs all become navigation links.

> Extension ID: `cnsharp.agentyolo` — display name **Agent YOLO**.
> See `ARCHITECTURE.md` for the full component map and design rationale.

![Agent YOLO panel — embedded multi-tab agent terminal with clickable links](media/screenshots/vsc-yolo-panel.png)

## Features

- Agent dropdown populated from a promoted list + user custom tools, filtered by what is actually installed, in a docked activity-bar view.
- **YOLO toggle** injects the per-agent skip-permission flag (e.g. `--dangerously-skip-permissions`,
  `-y`, `--yolo`) or environment variable (`GOOSE_MODE=auto`).
- **Resume toggle** continues the agent's most recent session via its `resumeFlag`.
- Embedded interactive PTY terminal (node-pty + bundled xterm.js) launched inside a login shell so rc-defined
  PATH (nvm/fnm/npm global bin) is honoured.
- Clickable terminal links with de-duplication/priority: `path:line:col`, quoted paths, stack-trace
  frames, bare file names, Python tracebacks, type names (`com.foo.Bar`), `Class.member` refs, and `http(s)://` URLs.
  (**Type/member links need a language server** — see [Language support](#language-support-install-a-language-server-to-navigate-typemember-links).)
- Multiple agent terminals as **tabs**: each Launch opens a new tab, so several agents run side by side
  and you switch between them like IDEA's Terminal. Each tab keeps its own scrollback and its own
  input-tracking, so what you type in one tab is never linkified.
- Agent configuration (skip flags / base args / resume flags, global YOLO & Resume defaults) lives in **VS Code Settings** — edit `yolo.agents` and the other `yolo.*` settings in `settings.json`; there is no in-panel Settings UI. (Internal extension IDs/settings keep the `yolo.` prefix — e.g. the view is `yolo.panel`, settings are `yolo.*` — while the product is branded **Agent YOLO**.)

## Language support (install a language server to navigate type/member links)

File-path links work out of the box (they are resolved on the filesystem). **Type and member links
(`com.foo.Bar`, `Class.member`) are different**: they are resolved through
`vscode.executeWorkspaceSymbolProvider`, i.e. the LSP `workspace/symbol` — so a **language server must
be running and must have indexed the symbol** for the link to open. Without one you get
"no symbol found".

Install the language server for the languages you actually work in:

| Language | Extension | Extension ID |
|---|---|---|
| Java | Language Support for Java (Red Hat) | `redhat.java` |
| TypeScript / JavaScript | *built in — nothing to install* | — |
| Python | Python **+ Pylance** (Pylance provides the symbols) | `ms-python.python`, `ms-python.vscode-pylance` |
| Go | Go (gopls) | `golang.go` |
| Rust | rust-analyzer | `rust-lang.rust-analyzer` |
| C / C++ | C/C++ | `ms-vscode.cpptools` |
| C# | C# | `ms-dotnettools.csharp` |
| Kotlin | Kotlin | `fwcd.kotlin` |
| PHP | Intelephense | `bmewburn.vscode-intelephense-client` |
| Ruby | Ruby LSP | `shopify.ruby-lsp` |
| Scala | Metals | `scalameta.metals` |
| Swift | Swift | `sswg.swift-lang` |
| Lua | Lua | `sumneko.lua` |
| Dart / Flutter | Dart | `Dart-Code.dart-code` |
| Shell | Bash IDE | `mads-hartmann.bash-ide-vscode` |

Notes:

- **Open the code as a workspace folder** and let the language server finish indexing (large
  Java/Python projects can take a while on first open) — unindexed symbols cannot be resolved.
- A plain syntax-highlighter or formatter is **not** enough; it must be a real language server.
- Install only what you need: each one is a resident process with its own memory, which adds up
  alongside several open agent terminals.
- For Java, prefer **Red Hat** (`redhat.java`); the Oracle Java extension's `workspace/symbol`
  support is unreliable.

## Build & run (development)

```bash
npm install
npm run build      # tsc (extension + webview entries) + esbuild (bundle xterm into media/dist)
npm test           # unit tests for the link engine
# Press F5 in VS Code with this folder open -> "Run Extension" launches a new Extension Development Host.
# Run the command: Agent YOLO: Open Agents Panel
```

## Layout

```
src/
  extension.ts                 activation + command + view-provider registration
  agents/                      promoted agents, skip-flag/env data, install detection (ported)
  links/                       link regex patterns (ported) + line parser
  settings/                    settings.json-backed config (schema in package.json contributes.configuration)
  navigation/                  file open + workspace-symbol lookup (gotoClassContributor equivalent)
  terminal/
    terminalProvider.ts        node-pty spawn (ported launch path)
    panel.ts                   WebviewViewProvider owning the PTY + message bridge
    panelHtml.ts               CSP-safe HTML renderer for the bundled webview
  webview/
    panel.ts                   bundled webview entry: xterm + combined link provider
media/dist/                    esbuild output (bundled xterm) — referenced by the webview
test/                          node:test unit tests (linkPatterns / linkParser)
```

The webview is bundled with esbuild (no CDN) and served from `localResourceRoots` with a strict CSP.
See `ARCHITECTURE.md` for the full component map and design rationale.
