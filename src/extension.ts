import * as vscode from "vscode";

// Demo build: the agent profiles (Claude Code, Codex) are declared statically in package.json under
// `contributes.terminal.profiles` and surfaced by VS Code in the built-in Terminal. There is no status
// bar launcher, no runtime agent catalog (agents.json), and no dynamic TerminalProfileProvider — the
// config lives entirely in the VS Code manifest (package.json).
export function activate(_context: vscode.ExtensionContext): void {
  // intentionally empty for the demo: all behavior comes from the static terminal profiles
}

export function deactivate(): void {
  // nothing to clean up
}
