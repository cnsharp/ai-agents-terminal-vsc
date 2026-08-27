// YOLO settings view provider: a docked webview with the per-agent permission table.

import * as vscode from "vscode";
import * as settings from "./settings";
import { resolveAgents } from "../agents/catalog";
import { resolvePath } from "../agents/agentDetector";
import { webviewAssetUri } from "../terminal/panelHtml";

export class YoloSettingsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "yolo.settings";
  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  public reveal(): void {
    vscode.commands.executeCommand("yolo.settings.focus");
  }

  private html(): string {
    const scriptUri = webviewAssetUri(this.view!.webview, this.extensionUri, "settings.js");
    const csp = this.view!.webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; img-src ${csp} https: data:; script-src ${csp};" />
  <title>YOLO — Settings</title>
  <style>
    body { padding: 8px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 12px; }
    .global { display: block; margin-bottom: 10px; }
    .head, .row { display: grid; grid-template-columns: 1.2fr 1fr 2fr 2fr; gap: 6px; align-items: center; padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .head { font-weight: bold; }
    .name { font-weight: 600; }
    .cmd { color: var(--vscode-descriptionForeground); }
    input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 2px 4px; }
    #save { margin-top: 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 3px; }
    #status { margin-left: 8px; color: var(--vscode-charts-green); }
    h2 { font-size: 13px; margin: 14px 0 6px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 3px; }
    .ctools { display: flex; flex-direction: column; gap: 6px; }
    .ctool { display: grid; grid-template-columns: 1.2fr 1.2fr 1.4fr auto; gap: 6px; align-items: center; padding: 4px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
    .ctool input { width: 100%; }
    .badge { font-size: 11px; }
    .badge.ok { color: var(--vscode-charts-green); }
    .badge.missing { color: var(--vscode-errorForeground, #f48771); }
    .delbtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border); border-radius: 3px; cursor: pointer; }
    .addbtn { margin-top: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; border-radius: 3px; cursor: pointer; }
  </style>
</head>
<body>
  <div id="root">Loading…</div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  private sendConfig(): void {
    const agents = resolveAgents().map((a) => ({
      id: a.id,
      displayName: a.displayName,
      command: a.command,
    }));
    const flags: Record<string, string> = {};
    for (const r of settings.getPermissionRules()) {
      flags[r.agentId] = r.flag;
    }
    const state = {
      agents,
      skipEnabled: settings.getSkipEnabled(),
      flags,
      baseArgs: settings.getAgentBaseArgs(),
      customTools: settings.getCustomTools(),
    };
    this.view?.webview.postMessage({ type: "config", state });
  }

  private onMessage(msg: any): void {
    switch (msg?.type) {
      case "ready":
        this.sendConfig();
        break;
      case "save": {
        settings.setSkipEnabled(Boolean(msg.skipEnabled));
        const rules = Object.entries(msg.flags as Record<string, string>).map(
          ([agentId, flag]) => ({ agentId, flag })
        );
        settings.setPermissionRules(rules);
        settings.setAgentBaseArgs(msg.baseArgs ?? {});
        if (Array.isArray(msg.customTools)) {
          settings.setCustomTools(msg.customTools);
        }
        // Re-send so the UI reflects persisted state (and the panel's dropdown refreshes via the
        // yolo.* configuration-change listener).
        this.sendConfig();
        break;
      }
      case "validate": {
        // Resolve each command's absolute path so the UI can flag missing tools inline.
        const commands = Array.isArray(msg.commands) ? (msg.commands as string[]) : [];
        const results: Record<string, string | undefined> = {};
        for (const c of commands) {
          results[c] = resolvePath(c);
        }
        this.view?.webview.postMessage({ type: "validateResult", results });
        break;
      }
    }
  }
}
