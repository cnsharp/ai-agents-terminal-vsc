# AI Agents Terminal (demo)

A minimal demo extension that contributes two AI CLI coding assistants — **Claude Code** and **Codex** —
as static terminal profiles in the VS Code manifest. VS Code surfaces them in the built-in Terminal;
there is **no status bar**, **no runtime catalog**, and **no custom UI**. The agent list lives entirely
in `package.json`.

## What it does

- Declares `claude` and `codex` under `contributes.terminal.profiles` in `package.json`.
- VS Code shows them in **Terminal: Select Default Profile** and the new-terminal dropdown, so you can
  pick one and open it in a terminal tab.
- Nothing else: no YOLO mode, no Resume mode, no settings page, no install detection.

## Install

### Run from source (trial)

1. `npm install`
2. `npm run compile`
3. Press **F5** to open the Extension Development Host; then open **Terminal: Select Default Profile**
   and you'll see *Claude Code* and *Codex*.

### Package as a VSIX

- `npx @vscode/vsce package` → produces `*.vsix`
- Install via **Extensions: Install from VSIX...**

## Usage

Open the Terminal dropdown / **Terminal: Select Default Profile** and choose **Claude Code** or **Codex**.
The agent launches in a new terminal tab.

## No extension needed (just edit settings.json)

This demo only contributes two static terminal profiles — something VS Code already supports natively.
You don't have to install the extension at all; just add the profiles to your own `settings.json`:

```jsonc
// settings.json (user or workspace scope)
"terminal.integrated.profiles.osx": {
  "Claude Code": { "path": "claude", "args": ["--dangerously-skip-permissions"], "icon": "robot" },
  "Codex":       { "path": "codex",  "args": ["--full-auto"],                    "icon": "robot" }
}
// use terminal.integrated.profiles.linux / .windows for other platforms
// drop `args` (or add a second profile without it) to keep the permission prompts
```

They appear in **Terminal: Select Default Profile** / the new-terminal dropdown exactly as the
contributed profiles do. The extension's only real advantage is one-click distribution (a VSIX) versus
hand-editing JSON — there is no extra behaviour.

**Where is `settings.json`?**

- **macOS**: `~/Library/Application Support/Code/User/settings.json`
- **Windows**: `%APPDATA%\Code\User\settings.json`
- **Linux**: `~/.config/Code/User/settings.json`
- Workspace scope (per project): `<project>/.vscode/settings.json`

Or open it from the Command Palette → **Preferences: Open User Settings (JSON)** (global) or
**Preferences: Open Workspace Settings (JSON)** (project-local).

## Add or change an agent

Because the config is static in `package.json`, edit the `contributes.terminal.profiles` array directly:

```json
"contributes": {
  "terminal": {
    "profiles": [
      { "id": "claude", "title": "Claude Code", "icon": "robot", "shellPath": "claude" },
      { "id": "codex", "title": "Codex", "icon": "robot", "shellPath": "codex" }
    ]
  }
}
```

Then `npm run compile` and reload the window. Each profile supports the usual fields
(`id`, `title`, `icon`, `shellPath`, `shellArgs`, `args`, `env`, `cwd`).

> `shellPath` is resolved against your `PATH`, so a bare command name like `claude` works.

## Project structure

```
ai-agents-vsc/
├── package.json     # manifest: name=ai-agents-terminal
│                    #   contributes.terminal.profiles: claude / codex (static)
├── tsconfig.json    # TS config (outDir=out, rootDir=src)
├── src/
│   └── extension.ts # minimal entry (empty activate)
└── out/             # build output (tsc)
```

## Platform limitations (not a code bug)

Contributed terminal profiles may **not** appear in the Terminal `+` caret dropdown or the title-bar
menu in some VS Code builds — they reliably appear in **Terminal: Select Default Profile**. This is a
VS Code behaviour, not something this demo controls.
