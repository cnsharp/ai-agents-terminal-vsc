// YOLO VS Code extension entry point. Ported from the IntelliJ plugin's activation / tool-window wiring.

import * as vscode from "vscode";
import { YoloViewProvider } from "./terminal/panel";
import { YoloSettingsViewProvider } from "./settings/settingsView";
import { initBuiltInAgents, resolveAgents } from "./agents/catalog";
import { canExecute } from "./agents/agentDetector";
import * as settings from "./settings/settings";

export function activate(context: vscode.ExtensionContext): void {
  // Load the built-in agent catalog from agents.json (data, not code).
  initBuiltInAgents(context);

  // Mirror the IntelliJ behaviour: on startup, re-scan installed agents so the dropdown reflects
  // anything installed after first run.
  settings.syncInstalledAgents(
    resolveAgents().map((a) => ({ id: a.id, command: a.command })),
    settings.getCustomTools(),
    canExecute
  );

  const panel = new YoloViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(YoloViewProvider.viewType, panel)
  );

  const settingsView = new YoloSettingsViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(YoloSettingsViewProvider.viewType, settingsView)
  );

  // Open Agents Panel: focus the docked view (creates it on first use).
  context.subscriptions.push(
    vscode.commands.registerCommand("yolo.openPanel", () => panel.reveal())
  );
  // Open Settings: reveal the settings view.
  context.subscriptions.push(
    vscode.commands.registerCommand("yolo.openSettings", () => settingsView.reveal())
  );
}

export function deactivate(): void {
  // Views dispose themselves; nothing persistent to tear down here.
}
