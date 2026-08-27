// Central agent catalog. Ported from ai-agents-vsc: the built-in list lives in `agents.json` (data,
// not code) so it can be maintained — or copied verbatim — without touching source. The code carries
// NO agent data; everything (names, commands, base args, YOLO/skip flags, icons) comes from
// `agents.json` and the user's `yolo.agents` setting.
//
// Final agent list = built-ins from agents.json, merged with the user's `yolo.agents` setting:
//   - an entry whose `command` (or `id`) matches a built-in overrides that built-in — only the fields
//     you set replace the built-in's; `enabled:false` hides it;
//   - an entry whose `command` isn't a built-in is added as a custom agent.
// `command`, `displayName`, and `id` must each stay unique.

import * as fs from "fs";
import * as vscode from "vscode";
import * as settings from "../settings/settings";

export interface AgentDef {
  id: string;
  /** Binary launched in the terminal (also used for PATH detection). */
  command: string;
  displayName: string;
  /** Base args prepended to every launch (space-separated string, split at runtime). */
  baseArgs: string;
  /** Flag appended when "YOLO mode" (auto-approve) is enabled. */
  skipFlag?: string;
  /** Flag appended when "Resume mode" is on, to continue the most recent session (e.g. "--resume"). */
  resumeFlag?: string;
  /** Icon filename under media/agents. Optional — falls back to the default terminal icon. */
  iconFile?: string;
}

/** Shape of an entry in `agents.json` and in the `yolo.agents` setting (user overrides / additions). */
export interface AgentConfig {
  id?: string;
  command: string;
  displayName?: string;
  baseArgs?: string;
  skipFlag?: string;
  /** Flag appended when "Resume mode" is on (e.g. "-r", "--resume"). */
  resumeFlag?: string;
  iconFile?: string;
  /** Set false to hide a built-in agent without deleting it. Defaults to true. */
  enabled?: boolean;
}

// Built-in catalog, loaded once from agents.json at activate() time. Single source of truth.
let builtInAgents: AgentConfig[] = [];

/**
 * Load the built-in agent catalog from `agents.json` (program/data separation). Must be called once
 * from activate() with the extension context. On failure the built-in list is empty and a console
 * error is emitted — the extension still works with user configuration.
 */
export function initBuiltInAgents(ctx: vscode.ExtensionContext): void {
  try {
    const fileUri = vscode.Uri.joinPath(ctx.extensionUri, "agents.json");
    const raw = fs.readFileSync(fileUri.fsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("agents.json root must be an array of agent objects");
    }
    builtInAgents = parsed as AgentConfig[];
  } catch (e) {
    console.error("[yolo] failed to load agents.json:", e);
    builtInAgents = [];
  }
}

/** Resolve the final, merged agent list (built-ins + user `yolo.agents` setting). */
export function resolveAgents(): AgentDef[] {
  const overrides = normalizeCustomTools(settings.getCustomTools());
  const warnings: string[] = [];
  const agents: AgentDef[] = [];
  const seen = { command: new Set<string>(), name: new Set<string>(), id: new Set<string>() };

  const isHidden = (c: AgentConfig) => c.enabled === false;
  const nameOf = (c: AgentConfig) => c.displayName ?? c.command;
  const idOf = (c: AgentConfig) => c.id ?? c.command;

  // Index built-ins by command and id so user overrides can match either.
  const builtInByKey = new Map<string, AgentConfig>();
  for (const b of builtInAgents) {
    builtInByKey.set(b.command, b);
    builtInByKey.set(b.id ?? b.command, b);
  }

  const pushAgent = (cfg: AgentConfig) => {
    const id = idOf(cfg);
    const name = nameOf(cfg);
    const dups: string[] = [];
    if (seen.command.has(cfg.command)) dups.push(`command "${cfg.command}"`);
    if (seen.name.has(name)) dups.push(`name "${name}"`);
    if (seen.id.has(id)) dups.push(`id "${id}"`);
    if (dups.length > 0) {
      warnings.push(`Agent ignored (duplicate ${dups.join(", ")}).`);
      return;
    }
    seen.command.add(cfg.command);
    seen.name.add(name);
    seen.id.add(id);
    agents.push({
      id,
      command: cfg.command,
      displayName: name,
      baseArgs: cfg.baseArgs ?? "",
      skipFlag: cfg.skipFlag,
      resumeFlag: cfg.resumeFlag,
      iconFile: cfg.iconFile,
    });
  };

  // 1) Built-ins first, applying any matching user override (and skipping hidden ones).
  for (const b of builtInAgents) {
    if (seen.command.has(b.command)) {
      continue; // already emitted (e.g. via an earlier override)
    }
    const ov = overrides.find(
      (o) => o.command === b.command || (o.id !== undefined && o.id === (b.id ?? b.command))
    );
    if (ov && isHidden(ov)) {
      seen.command.add(b.command); // keep it hidden; block a later custom re-add
      continue;
    }
    pushAgent(ov ? { ...b, ...ov } : b);
  }

  // 2) Custom agents: overrides whose command (or id) isn't a built-in.
  for (const ov of overrides) {
    if (builtInByKey.has(ov.command) || (ov.id !== undefined && builtInByKey.has(ov.id))) {
      continue; // already handled as a built-in override
    }
    if (!ov.command) {
      warnings.push("Custom agent ignored (missing required `command`).");
      continue;
    }
    pushAgent(ov);
  }

  if (warnings.length > 0) {
    console.warn("[yolo] agent config warnings:\n - " + warnings.join("\n - "));
  }
  return agents;
}

/**
 * The `yolo.agents` setting uses the same shape as the built-in `AgentConfig` (`baseArgs` and
 * `skipFlag` as space-separated strings, `iconFile`, plus overridable `skipFlag` / `resumeFlag`).
 * This just normalises it to the shared `AgentConfig` type so the merge below treats built-ins and
 * user overrides identically.
 */
function normalizeCustomTools(custom: settings.UserAgentOverride[]): AgentConfig[] {
  return custom.map((c) => ({
    id: c.id,
    command: c.command,
    displayName: c.displayName,
    baseArgs: c.baseArgs ?? "",
    skipFlag: c.skipFlag,
    resumeFlag: c.resumeFlag,
    iconFile: c.iconFile,
    enabled: c.enabled,
  }));
}
