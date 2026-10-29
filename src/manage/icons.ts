// Icon resolution for webviews: map an agent's `icon` filename (e.g. `claude.svg`) onto the
// bundled media/agents assets, preferring `<name>.svg` and falling back to `<name>.png`
// (VSC ships PNGs for some agents). Shared by the sidebar panel and the manage page, which
// each pass in their own webview (URIs are per-webview).

import * as fs from "fs";
import * as vscode from "vscode";

/** Webview URI for the agent's bundled icon, or undefined when the agent has no icon asset
 *  (custom agents) or the lookup fails. */
export function agentIconUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  icon?: string
): string | undefined {
  if (!icon) {
    return undefined;
  }
  const base = icon.split("/").pop() ?? "";
  const name = base.replace(/\.[^.]+$/, "");
  const dir = vscode.Uri.joinPath(extensionUri, "media", "agents");
  for (const ext of ["svg", "png"]) {
    const candidate = vscode.Uri.joinPath(dir, `${name}.${ext}`);
    if (fs.existsSync(candidate.fsPath)) {
      return webview.asWebviewUri(candidate).toString();
    }
  }
  return undefined;
}
