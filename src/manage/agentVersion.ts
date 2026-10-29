// Update checking for installed agent CLIs.
//
// Strategy: the *installed* version is read from the agent's own binary via
// `<command> --version`, while the *latest* version is queried from the agent's package source
// (`npm view` / `pip index versions` / `brew info`) and the two are compared as semver.
// `shell` / `url` agents without a `latest` source (and `brew` on native Windows) have no
// queryable package source, so they are reported as MANUAL and the UI's update action opens
// the agent's site instead. Agents that declare a `latest` source (npm / github / pypi / web) in
// agents.json are queried over HTTP from that source instead.
//
// Results live in a transient in-memory cache keyed by lower-cased command; listeners are
// notified after each state change so a page can re-render incrementally. The cache is not
// persisted. Checks never block the caller.

import type { AgentDef, InstallSpec } from "../agents";
import { installAutomatableOnPlatform, hasLatestSource } from "../agents";
import { getLatestVersions, recordLatestVersions, getCurrentVersions, recordCurrentVersions } from "../settings/settings";
import { canExecute } from "../agentDetector";
import { runHeadless } from "./agentInstaller";

/** Per-agent update status. */
export type VersionStatus =
  | "NA"
  | "CHECKING"
  | "UP_TO_DATE"
  | "UPDATE_AVAILABLE"
  | "MANUAL"
  | "ERROR";

/** Result for one agent: status plus the detected installed/latest versions (for display). */
export interface UpdateInfo {
  status: VersionStatus;
  current: string;
  latest: string;
  /** Failure detail for the ERROR row (output tail from the failed probe). */
  error?: string;
}

/** Single probe timeout — a hung `--version` or registry query must not stall the whole scan. */
const PROBE_TIMEOUT_MS = 20_000;
/** Parallel probes per scan wave. High enough to finish 34 agents quickly, low enough not to
 *  hammer package registries or spawn dozens of shells at once. */
const CONCURRENCY = 5;

/** A cached current version older than this is treated as stale and re-probed on open (24h). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const results = new Map<string, UpdateInfo>();
const listeners = new Set<() => void>();
let checking = false;

/** Detections collected during a scan, flushed to settings.json once at the end (one write
 * per scan/refresh, not one per agent). Cleared after each flush. */
const dirtyLatest: Record<string, string> = {};
/** Current (installed) versions collected during a scan, with timestamps, flushed once at the end. */
const dirtyCurrent: Record<string, { v: string; t: number }> = {};

function markLatest(command: string, version: string): void {
  if (version) dirtyLatest[command.trim().toLowerCase()] = version;
}

function markCurrent(command: string, version: string): void {
  if (version) dirtyCurrent[command.trim().toLowerCase()] = { v: version, t: Date.now() };
}

function flushLatest(): void {
  if (Object.keys(dirtyLatest).length) recordLatestVersions(dirtyLatest);
  for (const k of Object.keys(dirtyLatest)) delete dirtyLatest[k];
  if (Object.keys(dirtyCurrent).length) recordCurrentVersions(dirtyCurrent);
  for (const k of Object.keys(dirtyCurrent)) delete dirtyCurrent[k];
}

/** Seed the in-memory cache with last-known latest versions so the panel shows them
 * immediately (cache-first) before the next network probe lands. Live checks overwrite
 * these entries; the seeded status is NA (re-resolved on the next scan). */
const now = Date.now();
for (const [cmd, ver] of Object.entries(getLatestVersions())) {
  if (ver) results.set(cmd, { status: "NA", current: "", latest: ver });
}
for (const [cmd, entry] of Object.entries(getCurrentVersions())) {
  if (entry?.v && now - entry.t < CACHE_TTL_MS) {
    const k = cmd.trim().toLowerCase();
    const existing = results.get(k);
    results.set(k, { status: existing?.status ?? "NA", current: entry.v, latest: existing?.latest ?? "" });
  }
}

function keyOf(command: string): string {
  return (command ?? "").trim().toLowerCase();
}

/** Full result for a command, or undefined when never checked. */
export function infoFor(command: string): UpdateInfo | undefined {
  return results.get(keyOf(command));
}

/** Immutable snapshot of all known results, keyed by lower-cased command. */
export function snapshot(): Record<string, UpdateInfo> {
  return Object.fromEntries(results);
}

/** Whether a background scan is currently running (so callers avoid overlapping scans). */
export function isChecking(): boolean {
  return checking;
}

export function addListener(fn: () => void): void {
  listeners.add(fn);
}

export function removeListener(fn: () => void): void {
  listeners.delete(fn);
}

function publish(): void {
  for (const l of Array.from(listeners)) {
    try {
      l();
    } catch {
      // A misbehaving subscriber must not break the scan.
    }
  }
}

function put(key: string, info: UpdateInfo): void {
  results.set(key, info);
  publish();
}

/**
 * Check every agent that declares an install spec this platform can automate. Not-installed
 * agents are recorded as NA without probing (nothing to version). Safe to call repeatedly:
 * a scan is dropped while another one is still running.
 */
export async function checkAll(agents: AgentDef[]): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const targets = agents.filter((a) => a.install && (installAutomatableOnPlatform(a.install) || hasLatestSource(a.install)));
    for (const a of targets) {
      put(keyOf(a.command), { status: "CHECKING", current: results.get(keyOf(a.command))?.current ?? "", latest: results.get(keyOf(a.command))?.latest ?? "" });
    }
    // Wave-based concurrency: slice the target list, run each wave in parallel.
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      await Promise.all(targets.slice(i, i + CONCURRENCY).map((a) => checkAgent(a)));
    }
  } finally {
    checking = false;
    flushLatest();
    publish();
  }
}

/** Re-check a single agent (e.g. right after a successful install/upgrade) and publish. */
export async function refresh(agent: AgentDef): Promise<UpdateInfo> {
  const info = await probeAgent(agent);
  put(keyOf(agent.command), info);
  if (info.latest) markLatest(agent.command, info.latest);
  return info;
}

/** Probe one agent's version pair. Not-installed agents resolve to NA without spawning. */
async function checkAgent(agent: AgentDef): Promise<UpdateInfo> {
  if (!canExecute(agent.command)) {
    const info: UpdateInfo = { status: "NA", current: "", latest: "" };
    put(keyOf(agent.command), info);
    return info;
  }
  const info = await probeAgent(agent);
  put(keyOf(agent.command), info);
  if (info.latest) markLatest(agent.command, info.latest);
  if (info.current) markCurrent(agent.command, info.current);
  flushLatest();
  return info;
}

/** Read the installed version, compare with the package source. */
async function probeAgent(agent: AgentDef): Promise<UpdateInfo> {
  const spec = agent.install!;
  const { version, error } = await readCurrentVersion(agent.command);
  if (!canQueryVersion(spec)) {
    // No queryable package source (shell/url, or brew on Windows): report MANUAL so the UI
    // offers the agent's own update command / site instead of a fake "up to date".
    return version
      ? { status: "MANUAL", current: version, latest: "" }
      : { status: "NA", current: "", latest: "", error };
  }

  const latest = await latestVersion(spec);
  if (latest && version) {
    const cmp = compareSemver(semverOf(version), semverOf(latest));
    // current >= latest (incl. a newer-than-latest local build) => up to date.
    return cmp < 0
      ? { status: "UPDATE_AVAILABLE", current: version, latest }
      : { status: "UP_TO_DATE", current: version, latest };
  }
  if (latest) {
    // Installed version unreadable; fall back to the package manager's outdated probe.
    const outdated = await probeOutdated(spec);
    return { status: outdated ? "UPDATE_AVAILABLE" : "UP_TO_DATE", current: version, latest };
  }
  return { status: "ERROR", current: version, latest: "", error: error ?? "version query failed" };
}

/** Whether this spec's latest version can be queried on the current platform. */
function canQueryVersion(spec: InstallSpec): boolean {
  return (
    installAutomatableOnPlatform(spec) && (spec.type === "npm" || spec.type === "pip" || spec.type === "brew") || hasLatestSource(spec)
  );
}

/**
 * Run `<command> --version` (falling back to `-v`) and extract the first semver token.
 * Returns the empty version when the binary runs but its output has no readable version —
 * the caller decides what that means for the status (ERROR vs the outdated fallback).
 */
async function readCurrentVersion(
  command: string
): Promise<{ version: string; error?: string }> {
  let lastError: string | undefined;
  for (const flag of ["--version", "-v"]) {
    const r = await runHeadless(`${command} ${flag}`, PROBE_TIMEOUT_MS);
    if (r.ok) {
      const v = semverOf(r.output);
      if (v) return { version: v.join(".") };
    } else {
      lastError = r.error ?? r.output.split("\n").pop();
    }
  }
  return { version: "", error: lastError };
}

/** Latest published version for a package-manager spec. Empty if it cannot be determined. */
async function latestVersion(spec: InstallSpec): Promise<string> {
  if (spec.latest?.npm) return npmLatestFromApi(spec.latest.npm);
  if (spec.latest?.github) return githubLatest(spec.latest.github);
  if (spec.latest?.pypi) return pypiLatest(spec.latest.pypi);
  if (spec.latest?.brew) return brewLatestFromApi(spec.latest.brew);
  if (spec.latest?.web) return webLatest(spec.latest.web);
  switch (spec.type) {
    case "npm":
      return npmLatest(spec);
    case "pip":
      return pipLatest(spec);
    case "brew":
      return brewLatest(spec);
    default:
      return "";
  }
}

async function npmLatest(spec: InstallSpec): Promise<string> {
  const r = await runHeadless(`npm view '${escapeArg(spec.pkg ?? "")}' version`, PROBE_TIMEOUT_MS);
  if (!r.ok) return "";
  const v = semverOf(r.output);
  return v ? v.join(".") : "";
}

async function brewLatest(spec: InstallSpec): Promise<string> {
  const r = await runHeadless(`brew info '${escapeArg(spec.pkg ?? "")}' --json=v2`, PROBE_TIMEOUT_MS);
  if (!r.ok) return "";
  // JSON: { "versions": { "stable": "1.2.3" } }
  const m = /"stable"\s*:\s*"([^"]+)"/.exec(r.output);
  if (!m) return "";
  const v = semverOf(m[1]);
  return v ? v.join(".") : m[1];
}

/** pip latest: prefer `pip index versions` (newest listed first), fall back to a dry-run's "Would install". */
async function pipLatest(spec: InstallSpec): Promise<string> {
  const pip = process.platform === "win32" ? "python -m pip" : "python3 -m pip";
  const pkg = escapeArg(spec.pkg ?? "");
  const r1 = await runHeadless(`${pip} index versions '${pkg}'`, PROBE_TIMEOUT_MS);
  if (r1.ok) {
    const m = /Available versions:\s*([0-9][^,\s]*)/.exec(r1.output);
    if (m) {
      const v = semverOf(m[1]);
      return v ? v.join(".") : m[1];
    }
  }
  const r2 = await runHeadless(`${pip} install --upgrade '${pkg}' --dry-run`, PROBE_TIMEOUT_MS);
  if (r2.ok) {
    const m2 = new RegExp(`Would install\\s+${escapeRegex(spec.pkg ?? "")}[=\\s-]+([0-9][0-9A-Za-z."-]*)`).exec(
      r2.output
    );
    if (m2) {
      const g = m2[1].replace(/^[-"]+|[-"]+$/g, "");
      const v = semverOf(g);
      return v ? v.join(".") : g;
    }
  }
  return "";
}

/** Legacy read-only "is there a newer version" probe, used as a fallback when the installed
 *  version is unreadable. Returns true when the package manager reports an available upgrade. */
async function probeOutdated(spec: InstallSpec): Promise<boolean> {
  const pkg = escapeArg(spec.pkg ?? "");
  const pip = process.platform === "win32" ? "python -m pip" : "python3 -m pip";
  let command: string;
  switch (spec.type) {
    case "npm":
      command = `npm outdated -g '${pkg}' --json`;
      break;
    case "pip":
      command = `${pip} install --upgrade --dry-run '${pkg}'`;
      break;
    case "brew":
      command = `brew outdated '${pkg}'`;
      break;
    default:
      return false;
  }
  const r = await runHeadless(command, PROBE_TIMEOUT_MS);
  if (!r.ok) return false;
  const out = r.output.trim();
  switch (spec.type) {
    case "npm":
      return out.length > 0 && out !== "{}";
    case "pip":
      return new RegExp(`Would install\\s+${escapeRegex(spec.pkg ?? "")}[=\\s-]`).test(r.output);
    case "brew":
      return out.length > 0;
    default:
      return false;
  }
}

/** Extract the first `major.minor[.patch]` token from arbitrary text (ignoring any pre-release suffix). */
function semverOf(text: string): number[] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? "");
  if (!m) return null;
  return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0];
}

/** Compare two semver arrays lexicographically; 0 if equal, <0 if a<b, >0 if a>b. */
function compareSemver(a: number[] | null, b: number[] | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function escapeArg(s: string): string {
  return (s ?? "").replace(/'/g, "'\\''");
}

function escapeRegex(s: string): string {
  return (s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Re-exported so the panel can decide Install vs Upgrade vs site-open without importing the
// raw predicate helpers from two modules.
export { canQueryVersion };

/** Fetch JSON with a bounded timeout. Returns null on any failure so the caller can show
 *  "—" instead of hanging the card on a blocked/slow registry (mirrors cc-switch's
 *  LATEST_PROBE_TIMEOUT; the global proxy client's 600s timeout is not used here). */
async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "agentyolo", ...headers },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Latest version from the npm dist-tags endpoint (small payload, unlike the full packument). */
async function npmLatestFromApi(pkg: string): Promise<string> {
  const url = `https://registry.npmjs.org/-/package/${pkg.replace("/", "%2f")}/dist-tags`;
  const json = (await fetchJson(url, {})) as { latest?: string } | null;
  return json?.latest ?? "";
}

/** Latest version from a GitHub repo's latest release (release name's semver preferred over tag_name). */
async function githubLatest(repo: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const json = (await fetchJson(url, { Accept: "application/vnd.github+json" })) as {
    name?: string;
    tag_name?: string;
  } | null;
  if (!json) return "";
  for (const raw of [json.name, json.tag_name]) {
    if (!raw) continue;
    const v = semverOf(raw.replace(/^v/, ""));
    if (v && v[0] < 1000) return v.join("."); // reject calendar-style tags (e.g. v2026.8.31)
  }
  return "";
}

/** Latest version from PyPI's JSON API. */
async function pypiLatest(pkg: string): Promise<string> {
  const url = `https://pypi.org/pypi/${pkg}/json`;
  const json = (await fetchJson(url, {})) as { info?: { version?: string } } | null;
  return json?.info?.version ?? "";
}

/** Latest version from the Homebrew formula API (no auth, unlike the GitHub API rate limit). */
async function brewLatestFromApi(formula: string): Promise<string> {
  const url = `https://formulae.brew.sh/api/formula/${formula}.json`;
  const json = (await fetchJson(url, {})) as { versions?: { stable?: string } } | null;
  return json?.versions?.stable ?? "";
}

async function fetchText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "agentyolo" } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Latest version scraped from a web page that has no structured API. Applies `pattern` and
 *  returns the first capture group (or the whole match). Used for date-versioned tools like
 *  Cursor whose install page is server-rendered with the current version. */
async function webLatest(src: { url: string; pattern: string }): Promise<string> {
  const html = await fetchText(src.url);
  if (!html) return "";
  try {
    const m = new RegExp(src.pattern, "m").exec(html);
    if (m) return m[1] ?? m[0];
  } catch {
    /* invalid pattern in agents.json */
  }
  return "";
}

