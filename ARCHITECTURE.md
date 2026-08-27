# YOLO VS Code — Architecture Draft

This document is the port plan / architecture for bringing the IntelliJ **YOLO: AI Agents Extender**
plugin to VS Code. It maps each IntelliJ component to its VS Code equivalent and calls out the hard parts.

## 1. What the plugin does (recap)

A dedicated **tool window** listing installed AI CLI agents. The user picks an agent, optionally flips a
**Skip permissions (YOLO)** toggle, and launches it inside a **real embedded PTY terminal**. Terminal
output is made clickable: file paths (`src/Foo.kt:42`), stack-trace frames, type names
(`com.foo.Bar`), `Class.member` refs, and URLs all become navigation links.

## 2. Component map (IntelliJ → VS Code)

| IntelliJ (Kotlin) | VS Code equivalent | File |
|---|---|---|
| `ToolWindowFactory` + `YoloPanel` | `WebviewViewProvider` (docked activity-bar view) | `src/terminal/panel.ts` |
| JediTerm / PTY4J embedded terminal | `node-pty` (PTY) + `xterm.js` (render) | `src/terminal/terminalProvider.ts` + `src/webview/panel.ts` |
| `HyperlinkFilter` chain (File/Stack/Type/Member/Url) | one combined xterm `LinkProvider` (de-dup + prioritized) | `src/webview/panel.ts` |
| `YoloLinkPatterns` (regex) | ported regexes (single source of truth) | `src/links/linkPatterns.ts` |
| `YoloNavigation` (`gotoClassContributor`) | `vscode.executeWorkspaceSymbolProvider` (LSP) | `src/navigation/navigation.ts` |
| `AgentDetector` (`ProcessBuilder`) | `child_process` PATH probe + `--version` run | `src/agents/agentDetector.ts` |
| `DefaultSkipFlags` / `DefaultSkipEnvs` | plain data maps | `src/agents/skipFlags.ts` |
| `PromotedAgents` | plain data list | `src/agents/agents.ts` |
| `PersistentStateComponent` / `@State` | `WorkspaceConfiguration` (settings.json) | `src/settings/settings.ts` |
| `Configurable` (Settings \| Tools \| YOLO) | `contributes.configuration` + a **Settings webview** | `package.json` + `src/settings/settingsView.ts` |
| `notificationGroup` | `vscode.window.show*Message` | `panel.ts` |

## 3. Data flow

```
user picks agent + toggles YOLO in the docked webview
   └─ postMessage {type:'launch', agentId, skip}
        └─ extension: resolve command + skip flag/env (skipFlags.ts, settings.ts)
             └─ spawnAgent() → node-pty PTY inside login shell
                  ├─ pty.onData ──► postMessage {type:'data'} ──► term.write()
                  └─ term.onData ─► postMessage {type:'input'} ──► pty.write()
        webview renders with xterm; the combined link provider matches regexes
          └─ click link ─► postMessage {type:'navigate', payload}
               └─ extension: openFileAt / resolveType(resolveMember) / openUrl
```

## 4. What ports cleanly (pure logic, reused as-is)

- **Link regex patterns** (`linkPatterns.ts`) — ported verbatim (with two JS-specific adjustments:
  inline `(?i:…)` → the `i` flag, and possessive quantifiers `*+`/`++` → plain `*`/`+`). They are the
  canonical source; the extension serializes `.source`/`.flags` to the webview so there is one copy.
- **Skip-flag / env data** and **promoted-agent list** — plain data, copied directly.
- **Agent detection** — PATH probe via interactive login shell (`$SHELL -lic command -v`) + `--version`
  fallback, ported with `child_process`; the login-shell trick is kept so rc-defined PATH is honoured.
- **Launch flow** — spawn the agent inside a login shell, identical to the IntelliJ launch path.

## 5. Hard parts and how this draft handles them

### 5.1 Embedded terminal (JediTerm/PTY4J → node-pty + xterm.js) — DONE
A real PTY runs via `node-pty` in the extension host and bytes are piped to an `xterm.js` instance in the
webview. Resize and input are bridged via `postMessage`. **xterm is bundled with esbuild** into
`media/dist/panel.{js,css}` (no CDN), served via `localResourceRoots` with a strict CSP.

### 5.2 Type / member navigation (the single hardest piece) — IMPLEMENTED via LSP
IntelliJ resolves `com.foo.Bar` / `Bar.method` through the language-agnostic `gotoClassContributor` /
`gotoSymbolContributor` extension points, backed by each language's PSI index. VS Code has no equivalent,
so this uses `vscode.executeWorkspaceSymbolProvider` (the LSP `workspace/symbol`), which needs **no custom
language server**. Improvements over a naive port:
- Symbols are resolved cross-language via active language servers (Java/Kotlin, Python/Pylance, TS, …).
- Resolution **prefers the active editor's document** for both type and member lookups, so a project
  symbol is chosen over a same-named library/builtin symbol when the file is open.

Trade-offs (same as any LSP approach): a name must be indexed by an active language server, and there is
no IntelliJ-style "navigate to the exact member in the same file" heuristics beyond the active-doc scope.

### 5.3 Tool window vs WebviewView — DONE
The IntelliJ docked, always-available tool window is implemented as a `WebviewViewProvider`
(`yolo.panel`) in an activity-bar container, so it docks and persists while hidden. The
`YOLO: Open Agents Panel` command focuses it. A second view (`yolo.settings`) holds the settings UI.

### 5.4 Link de-duplication / priority — DONE
The original IntelliJ filters form a single pipeline where only the **first match per region** links.
VS Code's xterm link providers each scan the whole line independently, so overlapping matches produced
duplicate/conflicting links. Fixed with a **single combined link provider** that:
1. collects every candidate from all matchers,
2. sorts by length desc, then by kind priority (`member > type > file > url`), then by start,
3. drops any candidate that overlaps an already-accepted one.

Verified: `File "/x/main.py", line 7` → exactly one `file` link (with line 7); a `type` name that also
matches a `file` pattern links as `type` (higher priority). The same de-dup runs in `parseLine`
(`src/links/linkParser.ts`) so hover/peek and the webview stay consistent.

### 5.5 Settings UI — DONE
The IntelliJ `Configurable` is replaced by `contributes.configuration` (settings.json) **plus** a
**Settings webview** (`src/settings/settingsView.ts`) showing a per-agent table: skip flag, base args,
and resume flag per agent, plus the global "skip by default" toggle. Saving writes `permissionRules`,
`agentBaseArgs`, `agentResumeFlags`, and `skipEnabled`. `agentResumeFlags` overrides the catalog's
`resumeFlag` at launch (keyed by lower-cased agent id, mirroring `agentBaseArgs`).

## 6. File layout

```
yolo/
├── package.json            manifest: commands, views, configuration, deps, build scripts
├── tsconfig.json
├── media/icon.svg
├── media/dist/             esbuild output: panel.{js,css}, settings.js (bundled xterm)
├── test/                   node:test unit tests (linkPatterns / linkParser)
├── README.md
├── ARCHITECTURE.md
└── src/
    ├── extension.ts                 activate + command + view-provider registration
    ├── agents/{agents,skipFlags,agentDetector}.ts
    ├── links/{linkPatterns,linkParser}.ts
    ├── settings/settings.ts + settingsView.ts
    ├── navigation/navigation.ts
    ├── terminal/{terminalProvider,panel,panelHtml}.ts
    └── webview/{panel,settings}.ts  (bundled entries)
```

## 7. Build & test

```bash
npm install
npm run build      # tsc (extension + webview entries) + esbuild (bundle webview)
npm test           # node:test unit tests for the link engine
# F5 in VS Code (Run Extension) -> "YOLO: Open Agents Panel"
```

`vscode:prepublish` runs `npm run build`, so the packaged extension includes the bundled webview.

## 8. Remaining open follow-ups

These are the known gaps not yet implemented. The **Hover preview** item that was here is now done
(see "Hover preview (implemented)" at the bottom of this section for the pattern to copy).

| # | Follow-up | Status | Complexity | Files to touch |
|---|---|---|---|---|
| F1 | Agent-dropdown hover tooltips | **done** | low | `src/webview/panel.ts`, `src/terminal/panel.ts`, `src/terminal/panelHtml.ts` |
| F2 | Custom tools CRUD in Settings UI | **done** | medium | `src/settings/settingsView.ts`, `src/webview/settings.ts`, `src/settings/settings.ts` |
| F3 | Cross-file / scoped member resolution | **done** | medium | `src/navigation/navigation.ts` |
| F4 | Windows PTY / shell preference | **done** | medium | `src/terminal/shell.ts`, `src/terminal/terminalProvider.ts`, `src/agents/agentDetector.ts`, `src/settings/settings.ts`, `package.json` |

### F1 — Agent-dropdown hover tooltips (implemented)

The native `<select id="agent">` was replaced with a custom listbox (`#agentPick` / `#agentMenu` in
`panelHtml.ts`, driven by `renderAgentMenu`/`selectAgent`/`toggleAgentMenu` in `src/webview/panel.ts`).
The host now enriches each `AgentOption` with `resolvedPath` (from `resolvePath()`) and
`resolvedCommand` (agent + default skip flag + configured base args). Each menu item shows the display
name plus a secondary line of the resolved command, and carries a `title` tooltip with the absolute
path + full command. Missing tools (`resolvedPath` undefined) are flagged with a "missing" style.

### F2 — Custom tools CRUD in the Settings UI (implemented)

`src/webview/settings.ts` now renders a **Custom tools** section: add/edit/remove cards with
`displayName` / `command` / `iconFile`, a per-row delete button, and an inline "✓ installed / ⚠ not
found on PATH" badge. On every command edit the webview posts `{type:"validate", commands}`; the host
(`settingsView.ts`) resolves each via `resolvePath()` and replies `{type:"validateResult", results}`,
and the webview patches only the badges (input focus preserved). Save posts `customTools` (persisted via
the new `settings.setCustomTools()` → `yolo.agents`). Because the panel subscribes to
`yolo.*` configuration changes, the launch dropdown refreshes automatically when a custom tool is added
or removed — no restart needed. Skip flag + base args for custom tools are still edited in the
per-agent permission table (keyed by the tool's id).

### F3 — Cross-file / scoped member resolution (implemented)

`resolveMember` (`src/navigation/navigation.ts`) now:
1. resolves the class symbol first (reusing `resolveType`, which already prefers the active document for
   ambiguous class names),
2. runs `vscode.executeDocumentSymbolProvider` on the class's file and finds the member *nested inside*
   the class node (`findEnclosing` + descendant walk) — precise, and avoids picking a wrong same-named
   member in another class/file,
3. falls back to the previous workspace-symbol lookup, still preferring the class's file.
Inheritance/partial-class cross-file members remain a known limitation (language servers rarely expose
supertype relations via `documentSymbol`), but same-file precision is now correct.

### F4 — Windows PTY / shell preference (implemented)

New `src/terminal/shell.ts` centralises shell selection:
- `resolveLaunchShell(fullCommand, preferPosix)` — on Windows auto-detects a POSIX shell (Git Bash /
  WSL) and uses `-lic`, else `pwsh -NoProfile -Command`, else `cmd /c`; on Unix keeps `$SHELL -lic`
  (honouring rc-defined PATH) with optional extra `shellArgs`; a configured `yolo.shell` overrides.
- `resolveProbeShell()` — same choice for PATH probes, so `agentDetector.resolvePath`/`canExecute` use
  the same shell (incl. `where` vs `command -v`).
`spawnAgent` takes a new `preferPosix` flag; the panel sets it on Windows when an agent's default skip
flag is POSIX-style (`--…`). Settings added: `yolo.shell` (string) and `yolo.shellArgs` (string[]).

### Minor / discovered limitations (polish, not blockers)

- **Hover preview re-resolves every hover**: `describeLink` re-runs LSP on each `hover` event with no
  per-line cache; harmless but could cache by `payload` key for snappier repeated hovers.
- **No `allowNonHttpProtocols` needed**: URLs are opened by the host via `vscode.env.openExternal`, not
  by the webview, so non-http(s) links (e.g. `file://`, `vscode://`) are safe; worth a comment so a
  future edit doesn't accidentally add a webview-side `open`.

### Hover preview (implemented — reference pattern)

On link hover, xterm shows a DOM tooltip (`src/webview/panel.ts`, element `#terminal .xterm-hover`)
that previews where a click would navigate, before the user commits. The webview's `provideLinks`
attaches a `hover`/`leave` pair to each `ILink`; `hover` posts `{type:"hover", reqId, payload}` to the
host and shows a "…" placeholder. The host (`YoloViewProvider.hover` → `describeLink` in
`src/navigation/navigation.ts`) resolves the payload via the existing `resolveType`/`resolveMember`
LSP path (file links resolve directly; type/member links resolve to `file:line:col`), then replies
`{type:"hoverResult", reqId, text}`. The webview fills the tooltip with that text. `reqId` guards
against stale replies when the cursor moves between links. Format examples:

- URL: `Open URL: https://example.com`
- File: `Open src/foo/bar.ts:42:10`
- Type: `Go to class Foo.Bar → src/foo/bar.ts:12`
- Member: `Go to method Foo.bar → src/foo/bar.ts:88`
