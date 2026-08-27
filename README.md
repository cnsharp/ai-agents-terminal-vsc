# AI Agents Terminal

Launch the AI CLI coding assistants installed on your machine (Claude Code / Codex / Cursor / …) from the VS Code status bar with one click, opening each in a logo'd terminal tab. Supports a YOLO (auto-approve) mode, filters by what's installed, and lets you freely add / remove / configure agents — no code changes required.

## Features

- **Status-bar launcher**: a `✨ AI Agents` button at bottom-right → opens a Quick Pick listing only the agents **installed** on PATH (with logos); pick one to open it in a new terminal tab.
- **YOLO mode**: toggle via the `Y` status-bar button or the `Ctrl/Cmd+Alt+Y` shortcut; when on, each agent launches with its own auto-approve args (e.g. Claude's `--dangerously-skip-permissions`).
- **Resume mode**: toggle via the history `$(history)` status-bar button or the `Ctrl/Cmd+Alt+R` shortcut; when on, each agent launches with its own `resumeFlag` (e.g. Claude's `-r`) to continue the most recent session.
- **Data-driven**: 18 built-in agents (defined in the root `agents.json`) ship by default; override params, hide, or add custom agents from Settings — no code changes needed.
- **Terminal profiles**: installed agents are registered as Terminal profiles, surfacing in `Terminal: Select Default Profile` (filtered by install status, can be set as the default terminal).

## Install

### Run from source (development / trial)

1. Install dependencies: `npm install`
2. Compile: `npm run compile` (or `npm run watch` to rebuild on change)
3. Press **F5** to open the Extension Development Host window; the new window's status bar shows `✨ AI Agents`.

### Package / install as VSIX

- Package: `npx @vscode/vsce package` (produces a `*.vsix`)
- Install: in VS Code run `Extensions: Install from VSIX...` and pick the generated file.

## Usage

### Launch an agent

- Click `✨ AI Agents` at bottom-right, choose from the Quick Pick (only installed agents are listed), and it opens in a new terminal tab.
- Or run `AI Agents` from the Command Palette (command id `ai-agents-terminal.openMenu`).
- A `Settings` item is pinned at the bottom of the Quick Pick to open this extension's settings page directly.

### YOLO mode (auto-approve)

- Click the `Y` status-bar button, or use `Ctrl+Alt+Y` (`Cmd+Alt+Y` on macOS).
- When on, the button highlights; launching an agent automatically appends that agent's `yoloArgs`.

### Resume mode (continue session)

- Click the history `$(history)` status-bar button, or use `Ctrl+Alt+R` (`Cmd+Alt+R` on macOS).
- When on, the button highlights; launching an agent automatically appends that agent's `resumeFlag` from `agents.json` (e.g. Claude `-r`, Codex `--resume`, Cursor `--resume`), continuing the previous session. Agents without a `resumeFlag` (e.g. Continue, Kimi, Qoder) append nothing even when on.
- YOLO and Resume can be on together; args are ordered `baseArgs` → `yoloArgs` → `resumeFlag`.

### Configure agents (no code required)

The **`aiAgentsTerminal.agents`** setting is a list of overrides / additions **merged** with the built-in catalog in `agents.json`: match a built-in by `command` to override it (only the fields you set are replaced); set `enabled` to `false` to hide a built-in; use a `command` not present in `agents.json` to add a custom agent.

- **Edit**: the built-ins live in the root `agents.json`; to tweak a built-in, append an override entry with the same `command` (only the fields you want to change).
- **Override params**: change only the fields you want, e.g. set `claude`'s `yoloArgs` to `["--new-flag"]`.
- **Hide**: delete the entry, or keep it and set `enabled` to `false`.
- **Add a custom agent**: append an entry whose `command` isn't built-in, e.g.:

  ```json
  { "command": "myagent", "displayName": "My Agent", "baseArgs": ["run"], "iconFile": "myagent.png" }
  ```

  (omit `iconFile` to use the default terminal icon.)
- **When it takes effect**: changes apply the next time the picker opens (read live at runtime, no window reload needed).

Fields: `command` (required) / `displayName` / `baseArgs` / `yoloArgs` / `resumeFlag` / `iconFile` / `enabled` / `id`.

> Uniqueness: `command`, `displayName`, and `id` must each be unique. On duplicates the extension warns and drops the duplicate (keeping the first occurrence).

### Built-in agent list (18)

| id | display name | command (PATH detection) | logo |
|---|---|---|---|
| claude | Claude Code | `claude` | claude.png |
| codex | Codex | `codex` | codex.png |
| cline | Cline | `cline` | cline.png |
| codebuddy | CodeBuddy | `codebuddy` | codebuddy.png |
| continue | Continue | `cn` | continue.png |
| copilot | Copilot | `copilot` | copilot.png |
| cursor | Cursor | `cursor-agent` | cursor.png |
| gemini | Gemini | `gemini` | gemini.png |
| goose | Goose | `goose` | goose.png |
| hermes | Hermes | `hermes` | hermes.png |
| kilo | Kilo Code | `kilo` | kilo.png |
| kimi | Kimi | `kimi` | kimi.png |
| openclaw | OpenClaw | `openclaw` | openclaw.png |
| opencode | OpenCode | `opencode` | opencode.png |
| pi | Pi | `pi` | pi.png |
| qoder | Qoder | `qoder` | qoder.png |
| trae | TraeCode | `traecli` | trae.png |
| zcode | ZCode | `zcode` | zcode.png |

> Logos live in `media/agents/` (PNG). The picker shows only the display name, not the command / id.

### Terminal profiles (Terminal: Select Default Profile)

Each **installed** agent is registered at runtime as a Terminal profile via `registerTerminalProfileProvider`, appearing in the Command Palette's `Terminal: Select Default Profile` where it can be set as the default terminal; the terminal icon is the agent logo.

> Platform limitation: in this VS Code build, extension profiles do **not** appear in the Terminal `+` caret dropdown or the title-bar menu — only in `Select Default Profile` (see "Platform limitations" below).

## Settings reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `aiAgentsTerminal.yoloMode` | boolean | `false` | Master switch for YOLO mode; when on, agents launch with their respective `yoloArgs` |
| `aiAgentsTerminal.resumeMode` | boolean | `false` | Master switch for Resume mode; when on, agents launch with their respective `resumeFlag` |
| `aiAgentsTerminal.agents` | array | `[]` | Overrides / additions merged with agents.json (see above) |
| `aiAgentsTerminal.installedAgents` | array (hidden) | `[]` | Cache of detected agent commands, maintained automatically — **do not edit by hand** |

Commands:

| Command id | Title | Trigger |
|---|---|---|
| `ai-agents-terminal.openMenu` | AI Agents | status-bar button / Command Palette |
| `ai-agents-terminal.toggleYoloMode` | AI Agents: Toggle YOLO Mode | `Y` button / `Ctrl+Alt+Y` (`Cmd+Alt+Y` on macOS) |
| `ai-agents-terminal.toggleResumeMode` | AI Agents: Toggle Resume Mode | `$(history)` button / `Ctrl+Alt+R` (`Cmd+Alt+R` on macOS) |

## Contributing / secondary development

### Environment

- Node.js + npm
- VS Code `^1.85.0`
- TypeScript `^5.4.0`

### Build & debug

- `npm install` to install devDependencies (`typescript` / `@types/node` / `@types/vscode`).
- `npm run compile` compiles `src/*.ts` → `out/` (plain `tsc`, no bundling step).
- `npm run watch` rebuilds on change.
- Press **F5** to launch the Extension Development Host and set breakpoints in `src/extension.ts`.

### Project structure

```
ai-agents-vsc/
├── package.json          # manifest: name=ai-agents-terminal, publisher=cnsharpstudio
│                         #   contributes.configuration: yoloMode / agents / installedAgents
│                         #   contributes.commands + keybindings
├── tsconfig.json         # TS config (outDir=out, rootDir=src)
├── src/
│   ├── extension.ts      # entry: registers commands + status-bar buttons; QuickPick lists
│   │                     #   installed agents; dynamically registers Terminal profiles
│   │                     #   (registerTerminalProfileProvider)
│   ├── agents.ts         # loads the built-in catalog from agents.json + resolveAgents()/getAgentConfigWarnings()
│   │                     #   (merges built-ins with the aiAgentsTerminal.agents setting, dedupes)
│   └── agentDetector.ts  # isInstalled(): runs `<command> --version` to probe PATH
│                         #   (login shell -lc, honours nvm/fnm/brew/npm-global; where on win32)
├── media/agents/         # agent logos (PNG)
├── .vscode/              # launch.json (Run Extension) + tasks.json (npm compile)
└── out/                  # build output (tsc)
```

### Architecture notes

1. **Launcher (status bar)**: `activate()` first refreshes the installed cache (`refreshInstalledCache`, probing PATH only once across windows), the `✨ AI Agents` button opens a Quick Pick listing only cached installed agents, and selection launches via `vscode.window.createTerminal` using the agent's `command` + `baseArgs` (plus `yoloArgs` in YOLO mode), with the logo icon.
2. **Install detection**: `isInstalled(command)` runs `<command> --version` in a login-interactive shell, treating exit code 0 as installed; results are cached in the global `installedAgents` setting so PATH isn't re-probed per window. `agentDetector.ts` uses `$SHELL -lc` on macOS/Linux and `where` on Windows, so it honours PATH injected by rc files (nvm / fnm / brew / npm-global, etc.).
3. **Terminal profiles (install-filtered)**: `registerInstalledTerminalProfiles()` registers a `TerminalProfileProvider` per **installed** agent, so `Terminal: Select Default Profile` lists only what's installed; uninstalled agents never appear. This improves on the static `contributes.terminal.profiles` declaration, which can't filter by install status.
4. **Settings-driven**: `resolveAgents()` merges the `agents.json` built-in catalog with the `aiAgentsTerminal.agents` setting by `command`, and validates `command` / `displayName` / `id` uniqueness (`getAgentConfigWarnings` emits the warnings).

### How to add an agent

Two paths, depending on whether you want to ship code:

**Path A: settings only (recommended, user-side, no rebuild)**

Append an entry to `aiAgentsTerminal.agents` in your `settings.json`:

```json
{ "command": "myagent", "displayName": "My Agent", "baseArgs": [], "yoloArgs": ["--auto"], "iconFile": "myagent.png" }
```

Drop the logo into `media/agents/myagent.png` — no recompile needed.

**Path B: add as a built-in (code-side)**

1. Edit the root `agents.json` and append an entry (`id` / `command` / `displayName` / `baseArgs` / `yoloArgs` / `iconFile`).
2. Put the corresponding PNG into `media/agents/`.
3. `npm run compile`, then reload the window.

> Note: the runtime setting is authoritative. If a user has overridden `aiAgentsTerminal.agents`, a newly added built-in only appears once they also add it to their setting (or remove the override to restore the default 18).

### Platform limitations (not a code bug)

- Extension Terminal profiles do **not** appear in the Terminal `+` caret dropdown or the title-bar menu — only in `Terminal: Select Default Profile` (verified behaviour of this VS Code build).
- For day-to-day one-click launching, use the `✨ AI Agents` status-bar button — it's the most reliable entry point.
