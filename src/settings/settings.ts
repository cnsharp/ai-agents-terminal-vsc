// Ported concept from IntelliJ: AgentExtenderSettings (PersistentStateComponent) -> VS Code WorkspaceConfiguration.
// IntelliJ persisted to agentExtender.xml via @State; VS Code persists to settings.json / globalState.

import * as vscode from "vscode";

export interface PermissionRule {
  agentId: string;
  flag: string;
}

/**
 * Shape of an entry in the `yolo.agents` setting — user overrides / additions merged on top of the
 * built-in catalog in agents.json. It is intentionally identical to the built-in `AgentConfig` shape
 * (see src/agents/catalog.ts) so a built-in entry can be copy-pasted into the override and vice-versa,
 * and so users can override `skipFlag` / `resumeFlag` per agent. `command` is required.
 */
export interface UserAgentOverride {
  id?: string;
  displayName?: string;
  command: string;
  baseArgs?: string;
  skipFlag?: string;
  resumeFlag?: string;
  iconFile?: string;
  /** Set false to hide this agent (or a matching built-in) from the panel. Defaults to true. */
  enabled?: boolean;
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("yolo");
}

export function getSkipEnabled(): boolean {
  return cfg().get<boolean>("skipEnabled", false);
}

export function setSkipEnabled(value: boolean): void {
  cfg().update("skipEnabled", value, vscode.ConfigurationTarget.Global);
}

export function getResumeMode(): boolean {
  return cfg().get<boolean>("resumeMode", false);
}

export function setResumeMode(value: boolean): void {
  cfg().update("resumeMode", value, vscode.ConfigurationTarget.Global);
}

export function getPermissionRules(): PermissionRule[] {
  return cfg().get<PermissionRule[]>("permissionRules", []);
}

export function setPermissionRules(rules: PermissionRule[]): void {
  cfg().update("permissionRules", rules, vscode.ConfigurationTarget.Global);
}

export function getCustomTools(): UserAgentOverride[] {
  return cfg().get<UserAgentOverride[]>("agents", []);
}

export function setCustomTools(tools: UserAgentOverride[]): void {
  cfg().update("agents", tools, vscode.ConfigurationTarget.Global);
}

export function getAgentBaseArgs(): Record<string, string> {
  return cfg().get<Record<string, string>>("agentBaseArgs", {});
}

export function setAgentBaseArgs(map: Record<string, string>): void {
  cfg().update("agentBaseArgs", map, vscode.ConfigurationTarget.Global);
}

export function getInstalledCommands(): string[] {
  return cfg().get<string[]>("installedCommands", []);
}

export function setInstalledCommands(commands: string[]): void {
  cfg().update("installedCommands", commands, vscode.ConfigurationTarget.Global);
}

/**
 * Remembers the agent the user launched most recently, so the panel can
 * pre-select it next time. Persisted globally (like the other yolo.* settings).
 */
export function getLastAgentId(): string {
  return cfg().get<string>("lastAgentId", "");
}

export function setLastAgentId(id: string): void {
  cfg().update("lastAgentId", id, vscode.ConfigurationTarget.Global);
}

/**
 * Optional override for the shell used to launch agents (and to probe PATH). On Unix defaults to
 * `$SHELL`; on Windows auto-detects a POSIX shell (Git Bash / WSL) when unset. Accepts an absolute path
 * or a binary name on PATH.
 */
export function getShell(): string {
  return cfg().get<string>("shell", "") ?? "";
}

/** Extra argv inserted before `-lic` / `-NoProfile`, e.g. `["-l", "-i"]`. */
export function getShellArgs(): string[] {
  return cfg().get<string[]>("shellArgs", []);
}

/**
 * On startup, detect installed promoted/custom agents and merge them into the config so the panel
 * reflects the latest install state. Idempotent: never removes existing entries.
 */
export function syncInstalledAgents(
  promoted: { id: string; command: string }[],
  custom: UserAgentOverride[],
  canExecute: (cmd: string) => boolean
): void {
  const installed = new Set([
    ...getInstalledCommands(),
    ...promoted.filter((p) => canExecute(p.command)).map((p) => p.command.toLowerCase()),
    ...custom.filter((c) => canExecute(c.command)).map((c) => c.command.toLowerCase()),
  ]);
  setInstalledCommands(Array.from(installed));
}
