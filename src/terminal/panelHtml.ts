import * as vscode from "vscode";

/**
 * Webview asset URI for a file under media/dist. CRITICAL: must be a vscode-webview:// URI
 * (matching CSP 'self'), NOT a raw file:// URI — a file:// script is blocked by the CSP and
 * never runs.
 */
export function webviewAssetUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  relative: string
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "dist", relative));
}
