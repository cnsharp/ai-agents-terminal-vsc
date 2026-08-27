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

## Add or change an agent

Because the config is static in `package.json`, edit the `contributes.terminal.profiles` array directly:

```json
"contributes": {
  "terminal": {
    "profiles": [
      { "id": "claude", "title": "Claude Code", "icon": "$(sparkle)", "shellPath": "claude" },
      { "id": "codex", "title": "Codex", "icon": "$(sparkle)", "shellPath": "codex" }
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
