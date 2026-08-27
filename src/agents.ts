import * as fs from "fs";
import * as vscode from "vscode";

export interface AgentDef {
  readonly id: string;
  /** Binary launched in the terminal (also used for PATH detection). */
  readonly command: string;
  readonly displayName: string;
  readonly baseArgs: string[];
  /** Args appended when "YOLO mode" (auto-approve) is enabled in settings. */
  readonly yoloArgs?: string[];
  /** Flag appended when "Resume mode" is on, to continue the most recent session. */
  readonly resumeFlag?: string;
  /** Icon filename under media/agents. Optional — falls back to a default terminal icon. */
  readonly iconFile?: string;
}

/**
 * Shape of an entry in `agents.json` (the built-in catalog) and in the
 * `aiAgentsTerminal.agents` setting (user overrides / additions). Only
 * `command` is required; everything else overrides the built-in agent with the
 * same `command`, or defines a brand-new custom agent.
 */
export interface AgentConfig {
  command: string;
  displayName?: string;
  baseArgs?: string[];
  yoloArgs?: string[];
  iconFile?: string;
  /** Flag appended when "Resume mode" is on (e.g. `-r`, `--resume`). */
  resumeFlag?: string;
  /** Set false to hide a built-in agent without deleting it. Defaults to true. */
  enabled?: boolean;
  id?: string;
}

// Built-in catalog, loaded once from agents.json at activate() time. This is the
// single source of truth for built-ins — the code carries no agent data.
let builtInAgents: AgentConfig[] = [];

/**
 * Load the built-in agent catalog from `agents.json` (program/data separation:
 * the catalog lives in data, not in code). Must be called once from activate()
 * with the extension context. On failure the built-in list is empty and a
 * console error is emitted — the extension still works with user configuration.
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
    console.error("[ai-agents-terminal] failed to load agents.json:", e);
    builtInAgents = [];
  }
}

export function resolveAgents(): AgentDef[] {
  return buildAgents().agents;
}

/** Human-readable warnings about the merged config (e.g. duplicate command /
 *  name / id). Empty when the config is clean. */
export function getAgentConfigWarnings(): string[] {
  return buildAgents().warnings;
}

/**
 * Final agent list = built-ins from agents.json, merged with the user's
 * `aiAgentsTerminal.agents` setting. The setting is a list of overrides /
 * additions:
 *   - an entry whose `command` (or `id`) matches a built-in overrides that
 *     built-in — only the fields you set replace the built-in's; `enabled:false`
 *     hides it;
 *   - an entry whose `command` isn't a built-in is added as a custom agent.
 * `command`, `displayName`, and `id` must each stay unique.
 */
function buildAgents(): { agents: AgentDef[]; warnings: string[] } {
  const overrides =
    vscode.workspace
      .getConfiguration("aiAgentsTerminal")
      .get<AgentConfig[]>("agents") ?? [];

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
      baseArgs: cfg.baseArgs ?? [],
      yoloArgs: cfg.yoloArgs,
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

  return { agents, warnings };
}
