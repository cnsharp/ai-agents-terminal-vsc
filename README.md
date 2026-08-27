# YOLO — AI Agents Extender (VS Code)

A VS Code port of the IntelliJ *YOLO: AI Agents Extender* plugin. It opens an embedded terminal
panel that launches AI CLI agents (Claude Code, Codex, CodeBuddy, Goose, …) with a one-click
**Skip permissions (YOLO)** toggle, and makes terminal output clickable: file paths, stack-trace
frames, type/member names, and URLs all become navigation links.

> Status: **scaffold / architecture draft**. Pure logic is ported and functional; the terminal UI is a
> working skeleton. See `ARCHITECTURE.md`.

## Features (mirrors the IntelliJ plugin)

- Agent dropdown populated from a promoted list + user custom tools, filtered by what is actually installed.
- **YOLO toggle** injects the per-agent skip-permission flag (e.g. `--dangerously-skip-permissions`,
  `-y`, `--yolo`) or environment variable (`GOOSE_MODE=auto`).
- Embedded interactive PTY terminal (node-pty + xterm.js) launched inside a login shell so rc-defined
  PATH (nvm/fnm/npm global bin) is honoured.
- Clickable terminal links: `path:line:col`, quoted paths, stack-trace frames, bare file names,
  Python tracebacks, type names (`com.foo.Bar`), `Class.member` refs, and `http(s)://` URLs.

## Build & run (development)

```bash
npm install
npm run build      # tsc (extension + webview entries) + esbuild (bundle xterm into media/dist)
npm test           # unit tests for the link engine
# Press F5 in VS Code with this folder open -> "Run Extension" launches a new Extension Development Host.
# Run the command: YOLO: Open Agents Panel   (also: YOLO: Open Settings)
```

## Features

- Agent dropdown (promoted + custom tools, filtered by what is installed) in a docked activity-bar view.
- **YOLO toggle** injects the per-agent skip-permission flag/env.
- Embedded interactive PTY (`node-pty` + bundled `xterm.js`) launched in a login shell.
- Clickable terminal links with de-duplication/priority: `path:line:col`, quoted paths, stack-trace
  frames, bare file names, Python tracebacks, type names (`com.foo.Bar`), `Class.member` refs, URLs.
- A **Settings** view to edit per-agent skip flags / base args / resume flags and the global skip default.

## Layout

```
src/
  extension.ts                 activation + command + view-provider registration
  agents/                      promoted agents, skip-flag/env data, install detection (ported)
  links/                       link regex patterns (ported) + line parser
  settings/                    settings.json-backed config + settings webview view
  navigation/                  file open + workspace-symbol lookup (gotoClassContributor equivalent)
  terminal/
    terminalProvider.ts        node-pty spawn (ported launch path)
    panel.ts                   WebviewViewProvider owning the PTY + message bridge
    panelHtml.ts               CSP-safe HTML renderer for the bundled webview
  webview/
    panel.ts                   bundled webview entry: xterm + combined link provider
    settings.ts                bundled settings webview entry
media/dist/                    esbuild output (bundled xterm) — referenced by the webview
test/                          node:test unit tests (linkPatterns / linkParser)
```

The webview is bundled with esbuild (no CDN) and served from `localResourceRoots` with a strict CSP.
See `ARCHITECTURE.md` for the full component map and design rationale.
