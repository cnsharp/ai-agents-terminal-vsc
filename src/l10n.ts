// Localization for runtime UI strings.
//
// Uses the VS Code l10n API (vscode.l10n.t), the standard mechanism for extensions: messages
// live in l10n/bundle.l10n.json (English source) and l10n/bundle.l10n.<locale>.json
// (translations), resolved from vscode.env.language.
//
// Webviews are a separate JS context with no access to vscode.l10n, so the host resolves the
// keys they need here and ships them in the init message; the webview scripts fall back to the
// English text until that arrives.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// VS Code only applies l10n bundles for *packaged* extensions. When the
// extension runs from source (F5 / dev), vscode.l10n.t returns the key
// unchanged for any locale other than the default, so the UI would render raw
// keys like manage.empty. We therefore resolve against the on-disk bundles
// as a fallback: active language bundle -> base-language bundle -> English source
// bundle -> the key itself (last resort, so a genuinely missing key is visible).
const bundleCache: Record<string, Record<string, string> | null> = {};

function loadBundle(lang: string): Record<string, string> | undefined {
  const file = lang ? "bundle.l10n." + lang + ".json" : "bundle.l10n.json";
  if (file in bundleCache) return bundleCache[file] ?? undefined;
  try {
    const p = path.join(__dirname, "..", "l10n", file);
    bundleCache[file] = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    bundleCache[file] = null;
  }
  return bundleCache[file] ?? undefined;
}

function format(template: string, args: string[]): string {
  if (!args.length) return template;
  return template.replace(/{(d+)}/g, (_, i) => {
    const idx = Number(i);
    return idx < args.length ? args[idx] : "{" + i + "}";
  });
}

/** Translate a key from the l10n bundle, substituting {0}, {1}… in order. */
export function t(key: string, ...args: string[]): string {
  const resolved = vscode.l10n.t(key, ...args);
  if (resolved !== key && resolved !== "") return resolved;
  // Fallback chain for dev/unpackaged runs where vscode.l10n returns the key.
  const lang = (vscode.env.language || "en").toLowerCase();
  const localized =
    loadBundle(lang) ?? loadBundle(lang.split("-")[0]) ?? loadBundle("");
  const text = localized?.[key];
  return text !== undefined ? format(text, args) : key;
}

/** Keys the webview scripts render. Sent to them as a key->text map with init. */
const WEBVIEW_KEYS = [
  "manage.title",
  "manage.heading",
  "manage.checkUpdates",
  "manage.updateAll",
  "manage.updateAllCount",
  "manage.empty",
  "manage.currentVersion",
  "manage.latestVersion",
  "manage.notInstalled",
  "manage.checking",
  "manage.unknown",
  "manage.install",
  "manage.update",
  "manage.openSite",
  "manage.updateAvailable",
] as const;

/** Resolved webview strings for the current UI language. */
export function stringsForWebview(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of WEBVIEW_KEYS) {
    out[k] = t(k);
  }
  return out;
}
