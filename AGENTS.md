# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Two branches = two separate products

This repo is intentionally split into two branches that are **independent products released separately**.
They share a common data format (`agents.json`) but have different UX, code architecture, and settings
namespaces. Do **not** merge the branches or unify their namespaces — the divergence below is by design.

| Branch | Product | UX | Settings namespace | Notes |
|--------|---------|-----|--------------------|-------|
| `main` | **AI Agents Terminal** (`ai-agents-terminal`) | Status-bar `✨ AI Agents` button → Quick Pick launcher; dynamic `TerminalProfileProvider` registration | `aiAgentsTerminal.*` | Native terminal profiles; commands `toggleYoloMode` / `toggleResumeMode`. |
| `yolo` | **YOLO** | Docked webview panel (`yolo.panel`) + in-panel Settings view (`yolo.settings`) | `yolo.*` | Frontend in `src/webview/` (bundled by esbuild → `media/dist/`); embedded xterm terminal. |

### Intentional differences (NOT bugs to "fix")
- **Different settings namespaces**: `aiAgentsTerminal.*` vs `yolo.*`. Keep them separate.
- **yolo-only settings**: `yolo.shell`, `yolo.shellArgs`, `yolo.permissionRules`, `yolo.agentBaseArgs`
  exist because the docked panel needs shell control / per-agent permission flags that the status-bar
  launcher does not. They have no `main` equivalent by design.
- The status-bar product has no in-panel webview settings UI; it relies solely on VS Code Settings
  (`contributes.configuration`).

### Where they SHOULD stay consistent
The **overlapping concepts** — the agents override list, Resume mode, YOLO/skip mode, and the installed
cache — should use the **same schema structure** in both products so users get one mental model:
- The user-override setting (`aiAgentsTerminal.agents` / `yolo.agents`) uses the **same strict item
  shape**: `required: ["command"]`, `additionalProperties: false`, fields `command`, `displayName`,
  `baseArgs` (array), `yoloArgs` (array), `resumeFlag`, `iconFile`, `enabled`, `id`.
- Both also expose `resumeMode` and a skip/auto-approve toggle (`yoloMode` / `skipEnabled`).

## `agents.json` is the shared catalog (single source of truth)

`agents.json` at the repo root is the built-in agent catalog for **both** branches. It is loaded at
runtime (NOT hardcoded). Both branches must keep an identical copy:

- `AgentDef` / `AgentConfig` field sets are identical on both branches.
- The merge logic (`buildAgents` on `main`, `resolveAgents` on `yolo`) is equivalent.

**Convention: `main` is the source of truth for the data layer.** When you change the catalog or the
`AgentConfig` shape, make the change on `main` first, then sync it to `yolo`:

```sh
git show main:agents.json > agents.json   # while on the yolo branch
```

Re-sync whenever `main`'s `agents.json` or `src/agents.ts` (`AgentDef`/`AgentConfig`) changes.

## Build notes
- Host code is type-checked with `tsc` via `tsconfig.json`. The webview bundles (`src/webview/`) are
  **excluded** from the host `tsc` build (they are bundled separately by esbuild with the DOM lib).
- `node-pty` is a native dependency used by the yolo panel's PTY; it must be installed/natively built
  in the environment or the host `tsc` will report it as unresolved.
