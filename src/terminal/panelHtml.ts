import * as vscode from "vscode";

/** Render the YOLO panel HTML. References the esbuild-bundled webview script + css from media/dist. */
export function renderPanelHtml(
  cspSource: string,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} https: data:; script-src ${cspSource};" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>YOLO — AI Agents</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    #bar { display: flex; gap: 8px; align-items: center; padding: 6px 8px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
    #bar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border); padding: 3px 6px; border-radius: 3px; }
    #bar .yolo-toggle { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 24px; padding: 0; cursor: pointer; background: transparent; }
    #bar .yolo-toggle:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #bar .yolo-toggle .ic { width: 16px; height: 16px; display: none; }
    #bar .yolo-toggle:not(.active) .ic-off { display: inline-block; }
    #bar .yolo-toggle.active .ic-on { display: inline-block; }
    body.vscode-dark .yolo-toggle:not(.active) .ic-off,
    body.vscode-high-contrast .yolo-toggle:not(.active) .ic-off { display: none; }
    body.vscode-dark .yolo-toggle:not(.active) .ic-off-dark,
    body.vscode-high-contrast .yolo-toggle:not(.active) .ic-off-dark { display: inline-block; }
    body.vscode-dark .yolo-toggle.active .ic-on,
    body.vscode-high-contrast .yolo-toggle.active .ic-on { display: none; }
    body.vscode-dark .yolo-toggle.active .ic-on-dark,
    body.vscode-high-contrast .yolo-toggle.active .ic-on-dark { display: inline-block; }
    #bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #bar #settings { width: 28px; height: 24px; padding: 0; font-size: 14px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
    .agent-pick { position: relative; display: inline-block; }
    .agent-btn { min-width: 140px; text-align: left; }
    .agent-menu { position: absolute; z-index: 50; top: 100%; left: 0; margin-top: 2px; min-width: 260px; max-height: 320px; overflow-y: auto; background: var(--vscode-dropdown-background, var(--vscode-editor-background)); color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.4); padding: 4px; }
    .agent-opt { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 3px; cursor: pointer; }
    .agent-opt:hover, .agent-opt.active { background: var(--vscode-list-hoverBackground, #094771); }
    .agent-opt .logo { width: 18px; height: 18px; flex: 0 0 auto; object-fit: contain; border-radius: 4px; }
    .agent-opt .logo.lightning { display: inline-flex; align-items: center; justify-content: center; font-size: 14px; line-height: 1; opacity: 0.75; }
    .agent-opt .meta { display: flex; flex-direction: column; min-width: 0; }
    .agent-opt .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #terminal { position: absolute; top: 38px; left: 0; right: 0; bottom: 0; padding: 4px; }
    .xterm { height: 100%; }
    .xterm-hover {
      position: absolute;
      z-index: 1000;
      pointer-events: none;
      max-width: 480px;
      padding: 4px 8px;
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
    }
  </style>
</head>
<body>
  <div id="bar">
    <div class="agent-pick" id="agentPick">
      <button id="agentBtn" class="agent-btn" type="button">Select agent…</button>
      <div id="agentMenu" class="agent-menu" hidden></div>
    </div>
    <button id="skipToggle" class="yolo-toggle" type="button" aria-pressed="false" title="Skip permissions (YOLO)"></button>
    <button id="resumeToggle" class="yolo-toggle" type="button" aria-pressed="false" title="Resume last session"></button>
    <button id="launch">Launch</button>
    <button id="settings" style="margin-left:auto" type="button" title="Open YOLO settings" aria-label="Open YOLO settings">⚙</button>
  </div>
  <div id="terminal"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

export function webviewAssetUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  relative: string
): vscode.Uri {
  // CRITICAL: must be a `vscode-webview://` URI (matching CSP `'self'`), NOT a raw `file://` URI.
  // `cspSource` is `'self' https://*.vscode-cdn.net`, so a `file://` script is blocked and never runs.
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "dist", relative));
}
