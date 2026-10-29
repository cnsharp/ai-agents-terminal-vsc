import * as vscode from "vscode";
import { t } from "../l10n";

/** Render the Agent Manager page HTML. References the esbuild-bundled script from media/dist;
 *  the card grid itself is built dynamically by the script (statuses change per agent). */
export function renderManagerHtml(cspSource: string, scriptUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} https: data:; script-src ${cspSource};" />
  <title>${t("manage.title")}</title>
  <style>
    html, body { margin: 0; padding: 0; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground, #cccccc); font-family: var(--vscode-font-family); }
    #topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 10px; padding: 10px 18px; background: var(--vscode-editor-background, #1e1e1e); border-bottom: 1px solid var(--vscode-panel-border, #333); }
    #topbar h1 { font-size: 14px; font-weight: 600; margin: 0 auto 0 0; }
    #topbar button { background: var(--vscode-button-secondaryBackground, #3a3a3a); color: var(--vscode-button-secondaryForeground, #cccccc); border: 1px solid var(--vscode-panel-border, #555); padding: 4px 12px; border-radius: 3px; cursor: pointer; }
    #topbar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #444); }
    #topbar button:disabled { opacity: 0.5; cursor: default; }
    #upgradeAll { background: var(--vscode-button-background, #0e639c) !important; color: var(--vscode-button-foreground, #ffffff) !important; border-color: transparent !important; }
    #statusline { font-size: 12px; color: var(--vscode-descriptionForeground, #999999); }
    #content { max-width: 1400px; margin: 0 auto; padding: 14px 18px 40px; }
    #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
    .card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--vscode-panel-border, #333); border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(40,40,40,0.6)); }
    .card .head { display: flex; align-items: flex-start; gap: 10px; }
    .card .logo { width: 26px; height: 26px; flex: 0 0 auto; object-fit: contain; border-radius: 5px; }
    .card .logo.fallback { display: inline-flex; align-items: center; justify-content: center; font-size: 18px; opacity: 0.7; }
    .card .names { flex: 1 1 auto; min-width: 0; }
    .card .name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card .badge { flex: 0 0 auto; padding: 2px 8px; font-size: 11px; border-radius: 9px; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
    .card .warn { flex: 0 0 auto; color: var(--vscode-editorWarning-foreground, #cca700); font-size: 14px; }
    .card .rows { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
    .card .row { display: flex; justify-content: space-between; gap: 8px; }
    .card .row .k { color: var(--vscode-descriptionForeground, #999999); }
    .card .row .v { font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; }
    .card .row .v.loading { color: var(--vscode-descriptionForeground, #999999); }
    .card .error { font-size: 11px; color: var(--vscode-errorForeground, #f48771); word-break: break-word; }
    .card .ok { font-size: 11px; color: var(--vscode-descriptionForeground, #999999); word-break: break-word; }
    .card .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: auto; }
    .card .actions button { background: var(--vscode-button-secondaryBackground, #3a3a3a); color: var(--vscode-button-secondaryForeground, #cccccc); border: 1px solid var(--vscode-panel-border, #555); padding: 3px 12px; border-radius: 3px; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; }
    .card .actions button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #444); }
    .card .actions button:disabled { opacity: 0.5; cursor: default; }
    .card .actions button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); border-color: transparent; }
    .card .actions button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #1177bb); }
    .spinner { display: inline-block; width: 11px; height: 11px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #empty { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground, #999999); }
  </style>
</head>
<body>
  <div id="topbar">
    <h1>${t("manage.heading")}</h1>
    <button id="refresh" type="button">${t("manage.checkUpdates")}</button>
    <button id="upgradeAll" type="button" disabled>${t("manage.updateAll")}</button>
    <span id="statusline"></span>
  </div>
  <div id="content">
    <div id="grid"></div>
    <div id="empty" hidden>${t("manage.empty")}</div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
