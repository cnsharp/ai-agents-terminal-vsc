// Ported concept from IntelliJ: AgentExtenderSettings (PersistentStateComponent) -> VS Code WorkspaceConfiguration.
// Persists the Manage Agents page's version cache (latest + current) and the optional shell
// overrides used when launching / installing agents. All of this product's settings live under
// aiAgentsTerminal.* (see AGENTS.md — the settings namespace is the ONLY line that differs from
// the yolo branch).

import * as vscode from "vscode";

const CONFIG_SECTION = "aiAgentsTerminal";

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/** Shape of a user agent override (mirrors AgentConfig in agents.ts). */
export interface CustomTool {
  id?: string;
  displayName?: string;
  command: string;
  baseArgs?: string;
  skipFlag?: string;
  resumeFlag?: string;
  icon?: string;
  iconFile?: string;
  enabled?: boolean;
}

/**
 * Last-known "latest version" for each agent command, persisted across sessions so the
 * manager panel can show the most recent detected version immediately (cache-first) before
 * the next network probe finishes. Keyed by lower-cased command. Only successful, non-empty
 * detections are written, so a transient probe failure never overwrites a good last-known value.
 */
let latestVersionsCache: Record<string, string> | null = null;

export function getLatestVersions(): Record<string, string> {
  if (latestVersionsCache) {
    return latestVersionsCache;
  }
  latestVersionsCache = cfg().get<Record<string, string>>("latestVersions", {});
  return latestVersionsCache;
}

export function getLatestVersion(command: string): string | undefined {
  return getLatestVersions()[command.trim().toLowerCase()];
}

/** Merge the given command->version pairs into the persisted map (one batched settings write). */
export function recordLatestVersions(updates: Record<string, string>): void {
  const merged = { ...getLatestVersions() };
  for (const [cmd, ver] of Object.entries(updates)) {
    if (!ver) continue; // never clobber a good last-known value with an empty detection
    merged[cmd.trim().toLowerCase()] = ver;
  }
  latestVersionsCache = merged;
  cfg().update("latestVersions", merged, vscode.ConfigurationTarget.Global);
}

/** Record a single agent's latest version (no-op when empty). */
export function recordLatestVersion(command: string, version: string): void {
  if (!version) return;
  recordLatestVersions({ [command]: version });
}

/**
 * Last-known *current* (installed) version for each agent command, persisted across sessions so
 * the manager panel can show it immediately (cache-first) before the next local probe. Like the
 * latest-version cache it has no TTL: a remembered version is kept until the next successful
 * probe refreshes it. Keyed by lower-cased command.
 */
let currentVersionsCache: Record<string, string> | null = null;

export function getCurrentVersions(): Record<string, string> {
  if (currentVersionsCache) return currentVersionsCache;
  const raw = cfg().get<Record<string, string | { v: string }>>("currentVersions", {});
  const normalized: Record<string, string> = {};
  for (const [cmd, val] of Object.entries(raw)) {
    // Tolerate the old {v, t} shape written before the TTL was removed.
    const v = typeof val === "string" ? val : val?.v;
    if (v) normalized[cmd.trim().toLowerCase()] = v;
  }
  currentVersionsCache = normalized;
  return currentVersionsCache;
}

export function recordCurrentVersions(updates: Record<string, string>): void {
  const merged = { ...getCurrentVersions() };
  for (const [cmd, ver] of Object.entries(updates)) {
    if (!ver) continue; // never clobber a good last-known value with an empty detection
    merged[cmd.trim().toLowerCase()] = ver;
  }
  currentVersionsCache = merged;
  cfg().update("currentVersions", merged, vscode.ConfigurationTarget.Global);
}

/** User agent overrides / additions (the aiAgentsTerminal.agents setting). */
export function getCustomTools(): CustomTool[] {
  return cfg().get<CustomTool[]>("agents", []);
}

/**
 * Recompute the installed agent set from a live PATH probe and persist it, so the panel reflects
 * the latest install state. Deferred so activation isn't blocked; the manager re-renders once this
 * completes (via the version listener it subscribes to).
 */
export async function syncInstalledAgents(
  promoted: { id: string; command: string }[],
  custom: CustomTool[],
  canExecute: (cmd: string) => boolean
): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const installed = new Set<string>([
    ...promoted.filter((p) => canExecute(p.command)).map((p) => p.command.toLowerCase()),
    ...custom.filter((c) => canExecute(c.command)).map((c) => c.command.toLowerCase()),
  ]);
  cfg().update("installedCommands", Array.from(installed), vscode.ConfigurationTarget.Global);
}

/** Optional override for the shell used to launch / install agents (defaults to $SHELL / cmd). */
export function getShell(): string {
  return cfg().get<string>("shell", "") ?? "";
}

/** Extra argv inserted before -lic / -NoProfile, e.g. ["-l", "-i"]. */
export function getShellArgs(): string[] {
  return cfg().get<string[]>("shellArgs", []);
}
