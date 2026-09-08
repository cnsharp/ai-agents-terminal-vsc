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
  <title>Agent YOLO</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; display: flex; flex-direction: column; overflow: hidden; background: var(--vscode-sideBar-background, #1e1e1e); color: var(--vscode-foreground, #cccccc); font-family: var(--vscode-font-family); }
    #bar { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; padding: 6px 8px; background: var(--vscode-sideBar-background, #1e1e1e); border-bottom: 1px solid var(--vscode-panel-border, #333); }
    #bar button { background: var(--vscode-button-secondaryBackground, #3a3a3a); color: var(--vscode-button-secondaryForeground, #cccccc); border: 1px solid var(--vscode-panel-border, #555); padding: 3px 6px; border-radius: 3px; }
    #bar .yolo-toggle { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 24px; padding: 0; cursor: pointer; background: transparent; color: var(--vscode-button-secondaryForeground, #cccccc); }
    #bar .yolo-toggle:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }
    #bar .yolo-toggle.active { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
    #bar .yolo-toggle .ic { width: 16px; height: 16px; display: none; }
    #bar .yolo-toggle:not(.active) .ic-off { display: inline-block; }
    #bar .yolo-toggle.active .ic-on { display: inline-block; }
    #bar button:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }
    #bar #settings { width: 28px; height: 24px; padding: 0; font-size: 14px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
    .agent-pick { position: relative; display: inline-block; }
    .agent-btn { min-width: 140px; text-align: left; }
    .agent-menu { position: absolute; z-index: 50; top: 100%; left: 0; margin-top: 2px; min-width: 260px; max-height: 320px; overflow-y: auto; background: var(--vscode-dropdown-background, var(--vscode-editor-background)); color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.4); padding: 4px; }
    .agent-opt { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 3px; cursor: pointer; }
    .agent-opt:hover, .agent-opt.active { background: var(--vscode-list-hoverBackground, #094771); }
    .agent-opt .logo { width: 18px; height: 18px; flex: 0 0 auto; object-fit: contain; border-radius: 4px; }
    .agent-opt .logo.lightning { display: inline-flex; align-items: center; justify-content: center; font-size: 14px; line-height: 1; opacity: 0.75; }
    /* The "switch terminal" chevron sits at the RIGHT edge of the tab strip, so its menu must open
       leftwards (right-aligned to the button) — .agent-menu's default left:0 would push it past the
       panel edge and get it clipped. */
    #tabMenu { left: auto; right: 0; min-width: 200px; }
    .agent-opt .meta { display: flex; flex-direction: column; min-width: 0; }
    .agent-opt .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .agent-empty { padding: 8px 10px; font-size: 12px; line-height: 1.4; opacity: 0.85; }
    /* --- Multi-tab: strip on top, one absolutely-stacked terminal card below (IDEA's CardLayout) --- */
    #tabbar { flex: 0 0 auto; display: flex; align-items: stretch; gap: 4px; padding: 0 6px; background: var(--vscode-sideBar-background, #1e1e1e); border-bottom: 1px solid var(--vscode-panel-border, #333); }
    #tabs { flex: 1 1 auto; display: flex; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
    .tab { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; min-width: 160px; max-width: 220px; padding: 3px 4px 3px 8px; cursor: pointer; border-right: 1px solid var(--vscode-panel-border, #333); color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground, #cccccc)); background: transparent; }
    .tab:hover { background: var(--vscode-tab-hoverBackground, rgba(128,128,128,0.15)); }
    .tab.active { background: var(--vscode-tab-activeBackground, #1e1e1e); color: var(--vscode-tab-activeForeground, var(--vscode-foreground, #cccccc)); }
    .tab .tname { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
    .tab .logo { width: 14px; height: 14px; flex: 0 0 auto; object-fit: contain; border-radius: 3px; }
    .tab .tclose { flex: 0 0 auto; width: 16px; height: 16px; padding: 0; border: 0; background: transparent; color: inherit; opacity: 0.6; font-size: 12px; line-height: 1; cursor: pointer; }
    .tab .tclose:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    .tab-pick { position: relative; display: flex; align-items: center; flex: 0 0 auto; }
    #tabChevron { width: 20px; height: 100%; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 12px; }
    .tab-opt.cur { opacity: 0.45; }
    #content { flex: 1 1 auto; position: relative; min-height: 0; }
    /* Hidden cards keep their layout box: a display:none xterm measures 0 cells, so output written
       while hidden would wrap at a stale width and the PTY would never learn the real size. */
    .term-card { position: absolute; inset: 0; padding: 4px; }
    .term-card.hidden { visibility: hidden; pointer-events: none; }
    #empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 24px; opacity: 0.8; font-size: 12px; line-height: 1.5; }
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
  <div id="tabbar" hidden>
    <div id="tabs"></div>
    <div class="tab-pick">
      <button id="tabChevron" type="button" title="Switch terminal" hidden>&#9662;</button>
      <div id="tabMenu" class="agent-menu" hidden></div>
    </div>
  </div>
  <div id="content">
    <div id="empty">Select an agent above, then click Launch to start its terminal.</div>
  </div>
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
