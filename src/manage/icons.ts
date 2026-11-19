// Icon resolution for webviews: map an agent's `icon` filename (e.g. `claude.svg`) onto the
// bundled media/agents assets, preferring `<name>.svg` and falling back to `<name>.png`
// (VSC ships PNGs for some agents). Shared by the sidebar panel and the manage page, which
// each pass in their own webview (URIs are per-webview).

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Directory where the startup hot-update caches downloaded agent icons. */
export function globalIconDir(globalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(globalStorageUri, "icons", "agents");
}

/** Resolve an icon filename to a real file (bundled media/agents first, then the
 *  globalStorage hot-update cache), or undefined. Shared by the sidebar panel and
 *  the manage page; the caller converts the returned path to a webview URI. */
export function findIconFile(
  extensionUri: vscode.Uri,
  globalStorageUri: vscode.Uri | undefined,
  icon: string
): vscode.Uri | undefined {
  const base = icon.split("/").pop() ?? "";
  const name = base.replace(/\.[^.]+$/, "");
  const dirs = [
    path.join(extensionUri.fsPath, "media", "agents"),
    ...(globalStorageUri ? [globalIconDir(globalStorageUri).fsPath] : []),
  ];
  for (const dir of dirs) {
    for (const ext of ["svg", "png"]) {
      const candidate = path.join(dir, `${name}.${ext}`);
      if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
    }
  }
  return undefined;
}

/** Webview URI for the agent's icon (bundled or hot-update cached), or undefined
 *  when the agent has no icon asset (custom agents) or the lookup fails. */
export function agentIconUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  icon?: string,
  globalStorageUri?: vscode.Uri
): string | undefined {
  if (!icon) {
    return undefined;
  }
  const file = findIconFile(extensionUri, globalStorageUri, icon);
  return file ? webview.asWebviewUri(file).toString() : undefined;
}
