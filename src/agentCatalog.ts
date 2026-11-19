// Startup catalog hot-update: fetch the official v2 catalog, merge it with the
// bundled catalog, and cache the result in globalStorage so the editor works
// offline. The source URL is locked to the official repo — no user-configurable
// endpoint (a malicious catalog could carry install commands that get executed).

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AgentConfig, parseCatalog, setBuiltInAgents } from "./agents";
import { canExecute } from "./agentDetector";

const CATALOG_URL =
  "https://raw.githubusercontent.com/cnsharp/Agent-YOLO/main/meta/agents.json";
const ICON_BASE_URL =
  "https://raw.githubusercontent.com/cnsharp/Agent-YOLO/main/resources/icons/agents/";
const ETAG_KEY = "catalog.etag";
const CACHE_FILE = "agents.remote.json";
const ICON_DIR = path.join("icons", "agents");
const PROBE_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_AGENTS = 500;

/** Statuses considered "outdated" by the merge filter. */
const OUTDATED = new Set(["stale", "maintaining", "closed"]);
const KNOWN_STATUS = new Set(["active", "maintaining", "stale", "closed", "unknown"]);

function canonStatus(s: string | undefined): string {
  return s && KNOWN_STATUS.has(s) ? s : "unknown";
}

function idOf(a: AgentConfig): string {
  return a.id ?? a.command;
}

function isOutdatedAndUninstalled(a: AgentConfig, installed: Set<string>): boolean {
  return !installed.has(a.command.toLowerCase()) && OUTDATED.has(canonStatus(a.status));
}

/**
 * Canonical merge, stage A (see Meta/meta/CATALOG_MERGE.md — keep the three ports aligned):
 *   - base = bundled catalog (all entries; remote omissions never delete a built-in)
 *   - overlay each remote entry by id:
 *       * outdated+uninstalled -> remove from result entirely (incl. built-in copy)
 *       * otherwise -> override base / add new
 *   - empty result -> fall back to the full bundled list
 * User-added agents are local-only (settings layer, stage B) and never enter here.
 */
export function mergeCatalogs(
  builtin: AgentConfig[],
  remote: AgentConfig[],
  installed: Set<string>
): AgentConfig[] {
  const result = new Map<string, AgentConfig>();
  for (const b of builtin) result.set(idOf(b), b);
  for (const e of remote) {
    const id = idOf(e);
    if (isOutdatedAndUninstalled(e, installed)) {
      result.delete(id);
      continue;
    }
    result.set(id, e);
  }
  return result.size === 0 ? builtin.slice() : [...result.values()];
}

/** Validate/normalise a parsed remote list; drops malformed entries and caps size. */
function validateAgents(list: AgentConfig[]): AgentConfig[] {
  const idRe = /^[a-z][a-z0-9-]*$/;
  const iconRe = /^[A-Za-z0-9._-]+\.(svg|png)$/;
  const out: AgentConfig[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    if (typeof a.id !== "string" || !idRe.test(a.id)) continue;
    if (typeof a.command !== "string" || !a.command) continue;
    if (typeof a.displayName !== "string" || !a.displayName) continue;
    if (a.icon !== undefined && (typeof a.icon !== "string" || !iconRe.test(a.icon))) continue;
    out.push(a);
    if (out.length >= MAX_AGENTS) break;
  }
  return out;
}

type FetchOutcome =
  | { kind: "notmodified" }
  | { kind: "updated"; text: string; etag?: string }
  | { kind: "failed" };

async function fetchCatalog(etag: string | undefined): Promise<FetchOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "User-Agent": "agentyolo" };
    if (etag) headers["If-None-Match"] = etag;
    const r = await fetch(CATALOG_URL, { signal: ctrl.signal, headers });
    if (r.status === 304) return { kind: "notmodified" };
    if (!r.ok) return { kind: "failed" };
    const text = await r.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return { kind: "failed" };
    return { kind: "updated", text, etag: r.headers.get("etag") ?? undefined };
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

function cachePath(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, CACHE_FILE);
}

function iconDir(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, ICON_DIR);
}

/** Load the last-good merged catalog from globalStorage (instant offline display). */
export function loadCachedBuiltIns(ctx: vscode.ExtensionContext): void {
  try {
    const raw = fs.readFileSync(cachePath(ctx), "utf8");
    setBuiltInAgents(validateAgents(parseCatalog(raw)));
  } catch {
    // No cache yet — keep the bundled catalog loaded by initBuiltInAgents().
  }
}

/** Resolve an icon filename to a bundled or cached local Uri, else undefined. */
export function resolveIconFilename(ctx: vscode.ExtensionContext, icon: string): vscode.Uri | undefined {
  const base = icon.split("/").pop() ?? "";
  for (const dir of [
    path.join(ctx.extensionUri.fsPath, "media", "agents"),
    iconDir(ctx),
  ]) {
    for (const ext of ["svg", "png"]) {
      const candidate = path.join(dir, base.replace(/\.[^.]+$/, "") + "." + ext);
      if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
    }
  }
  return undefined;
}

const ICON_RE = /^[A-Za-z0-9._-]+\.(svg|png)$/;

async function downloadMissingIcons(ctx: vscode.ExtensionContext, agents: AgentConfig[]): Promise<void> {
  const dir = iconDir(ctx);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  for (const a of agents) {
    const icon = a.icon;
    if (!icon || !ICON_RE.test(icon)) continue;
    if (fs.existsSync(path.join(dir, icon))) continue;
    if (fs.existsSync(path.join(ctx.extensionUri.fsPath, "media", "agents", icon))) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const r = await fetch(ICON_BASE_URL + icon, { signal: ctrl.signal, headers: { "User-Agent": "agentyolo" } });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength > 512 * 1024) continue;
      const ok = icon.endsWith(".png")
        ? buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : /<svg\b/i.test(buf.toString("utf8", 0, Math.min(buf.length, 512)));
      if (ok) fs.writeFileSync(path.join(dir, icon), buf);
    } catch {
      // Icon is optional — an agent still works with the default terminal icon.
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Startup hot-update. Reads the bundled catalog as the base, fetches the remote
 * v2 catalog, merges+filters, replaces the in-memory built-ins, persists the
 * result, and downloads missing icons. Never throws; failures keep whatever is
 * already loaded.
 *
 * `onSettled` ALWAYS runs once when the catalog step is done — whether the
 * fetch returned 200 (applied), 304 (unchanged) or failed. Callers must do the
 * installed-agent scan here so it always runs AFTER the catalog is final;
 * scanning before the catalog settles would filter the list against a stale
 * agent set and leave the Quick Pick inconsistent.
 */
export async function refreshOnStartup(
  ctx: vscode.ExtensionContext,
  onSettled?: () => void
): Promise<void> {
  try {
    const outcome = await fetchCatalog(ctx.globalState.get<string>(ETAG_KEY));
    if (outcome.kind !== "updated") return;

    let remote: AgentConfig[];
    try {
      remote = validateAgents(parseCatalog(outcome.text));
    } catch {
      return;
    }
    if (remote.length === 0) return;

    // Base is the pristine bundled catalog (bundled v1 entries have no status =>
    // treated as active). Re-read from disk so a cached earlier merge can't act as
    // the base.
    let builtin: AgentConfig[] = [];
    try {
      builtin = validateAgents(
        parseCatalog(fs.readFileSync(path.join(ctx.extensionUri.fsPath, "agents.json"), "utf8"))
      );
    } catch {
      builtin = [];
    }
    if (builtin.length === 0) return;

    // Installed set: live cache-backed probe (canExecute) over all commands,
    // lower-cased. The bundled+remote union covers every possible id.
    const installed = new Set<string>();
    const seen = new Set<string>();
    for (const a of [...builtin, ...remote]) {
      const cmd = a.command.toLowerCase();
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      if (canExecute(a.command)) installed.add(cmd);
    }

    const merged = mergeCatalogs(builtin, remote, installed);

    try {
      fs.mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
      fs.writeFileSync(cachePath(ctx), JSON.stringify(merged), "utf8");
      if (outcome.etag) void ctx.globalState.update(ETAG_KEY, outcome.etag);
    } catch {
      // Cache write is best-effort; the in-memory replacement still applies.
    }

    setBuiltInAgents(merged);
    void downloadMissingIcons(ctx, merged);
  } finally {
    // Always signal completion so the caller can run the installed-agent scan
    // after the catalog is final (see the onSettled doc above).
    onSettled?.();
  }
}
