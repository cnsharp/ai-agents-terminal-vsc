import * as fs from "fs";
import * as vscode from "vscode";

// Settings namespace for this product's agent overrides. This is the ONLY line
// that differs between the two product branches' copy of this file — see
// AGENTS.md ("Different settings namespaces … Keep them separate"). Everything
// else (AgentDef/AgentConfig shape, the agents.json loader, and the merge logic)
// is shared verbatim between the branches.
const CONFIG_SECTION = "aiAgentsTerminal";

export interface AgentDef {
  readonly id: string;
  /** Binary launched in the terminal (also used for PATH detection). */
  readonly command: string;
  readonly displayName: string;
  /** Base args prepended to every launch (space-separated string, split at runtime). */
  readonly baseArgs: string;
  /** Flag appended when "YOLO mode" (auto-approve) is enabled in settings. */
  readonly skipFlag?: string;
  /** Flag appended when "Resume mode" is on, to continue the most recent session. */
  readonly resumeFlag?: string;
  /** Bundled icon filename (e.g. claude.svg); the registry stores just the filename because each
   *  end keeps its icons under a different directory. Optional — falls back to a default terminal
   *  icon. The loader maps it onto the bundled media/agents assets (svg→png fallback). */
  readonly icon?: string;
  /** Agent home page, opened by the "Open site" action on the manage page. */
  readonly url?: string;
  /** How the agent is installed / upgraded — drives the manage page's Install / Upgrade buttons. */
  readonly install?: InstallSpec;
}

/** Package manager (or bare shell / web download) an agent's install spec is expressed against. */
export type InstallType = "npm" | "pip" | "brew" | "shell" | "url";

/**
 * How to install / upgrade an agent. Mirrors the install object in agents.json:
 *   - npm / pip / brew install pkg through that package manager;
 *   - shell runs cmd (or cmdWin on Windows) — curl|bash style installers;
 *   - url cannot be automated: the UI opens the download page instead.
 * updateCmd, when present, is the preferred upgrade command for any type.
 */
export interface InstallSpec {
  readonly type: InstallType;
  readonly pkg?: string;
  readonly cmd?: string;
  readonly cmdWin?: string;
  readonly url?: string;
  readonly updateCmd?: string;
  /** Structured source for the "latest version" query for shell/url installers (npm/github/pypi). */
  readonly latest?: { npm?: string; github?: string; pypi?: string; brew?: string; web?: { url: string; pattern: string } };
}

/** Whether an install command can be built and run head-less at all (everything but url). */
export function installAutomatable(spec?: InstallSpec): boolean {
  return spec?.type === "npm" || spec?.type === "pip" || spec?.type === "brew" || spec?.type === "shell";
}

/**
 * Whether the install can be automated ON THIS PLATFORM. Homebrew only exists on macOS/Linux
 * (Windows has it only inside WSL), so a brew spec there must fall back to opening the site
 * instead of running a brew command that can never succeed.
 */
export function installAutomatableOnPlatform(spec?: InstallSpec): boolean {
  if (!spec) return false;
  if (spec.type === "brew" && process.platform === "win32") return false;
  return installAutomatable(spec);
}

/** Whether an upgrade command can be built: any package manager, or an explicit updateCmd. */
export function hasUpdateCommand(spec?: InstallSpec): boolean {
  return installAutomatable(spec) || !!spec?.updateCmd;
}

/** Human-readable install target shown in the status line, e.g. the package or command. */
export function installTarget(spec?: InstallSpec): string {
  if (!spec) return "";
  switch (spec.type) {
    case "npm":
    case "pip":
    case "brew":
      return spec.pkg ?? "";
    case "shell":
      return process.platform === "win32" && spec.cmdWin ? spec.cmdWin : (spec.cmd ?? "");
    default:
      return spec.url ?? "";
  }
}

/**
 * Shape of an entry in agents.json (the built-in catalog) and in the
 * aiAgentsTerminal.agents setting (user overrides / additions). Only
 * command is required; everything else overrides the built-in agent with the
 * same command, or defines a brand-new custom agent.
 */
export interface AgentConfig {
  command: string;
  displayName?: string;
  baseArgs?: string;
  skipFlag?: string;
  icon?: string;
  /** @deprecated use icon (filename); kept for backward-compatible user overrides that pass a full path. */
  iconFile?: string;
  /** Flag appended when "Resume mode" is on (e.g. -r, --resume). */
  resumeFlag?: string;
  /** Agent home page (see AgentDef.url). */
  url?: string;
  /** Install/upgrade recipe (see InstallSpec). */
  install?: InstallSpec;
  /** Set false to hide a built-in agent without deleting it. Defaults to true. */
  enabled?: boolean;
  id?: string;
}

// Built-in catalog, loaded once from agents.json at activate() time. This is the
// single source of truth for built-ins — the code carries no agent data.
let builtInAgents: AgentConfig[] = [];

/**
 * Load the built-in agent catalog from agents.json (program/data separation:
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
    console.error("[" + CONFIG_SECTION + "] the agent list failed to load: could not read agents.json.", e);
    builtInAgents = [];
  }
}

export function resolveAgents(): AgentDef[] {
  return buildAgents().agents;
}

/** Human-readable warnings about the merged config (e.g. duplicate command / name / id). Empty when the config is clean. */
export function getAgentConfigWarnings(): string[] {
  return buildAgents().warnings;
}

/**
 * Final agent list = built-ins from agents.json, merged with the user's
 * aiAgentsTerminal.agents setting. The setting is a list of overrides / additions:
 *   - an entry whose command (or id) matches a built-in overrides that built-in — only the
 *     fields you set replace the built-in's; enabled:false hides it;
 *   - an entry whose command isn't a built-in is added as a custom agent.
 * command, displayName, and id must each stay unique.
 */
function buildAgents(): { agents: AgentDef[]; warnings: string[] } {
  const overrides =
    vscode.workspace
      .getConfiguration(CONFIG_SECTION)
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
    if (seen.command.has(cfg.command)) dups.push('command "' + cfg.command + '"');
    if (seen.name.has(name)) dups.push('name "' + name + '"');
    if (seen.id.has(id)) dups.push('id "' + id + '"');
    if (dups.length > 0) {
      warnings.push(
        "Agent ignored (duplicate " + dups.join(", ") + "). " +
          'To customize a built-in instead of adding a duplicate, set the same "id" as the built-in (e.g. "cursor"); ' +
          'to add a separate agent, use a unique "command" and "displayName".'
      );
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
      icon: cfg.icon ?? cfg.iconFile,
      url: cfg.url,
      install: cfg.install,
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
      warnings.push("Custom agent ignored (missing required command).");
      continue;
    }
    pushAgent(ov);
  }

  return { agents, warnings };
}

/** Whether the spec declares a structured "latest version" source (npm/github/pypi). */
export function hasLatestSource(spec?: InstallSpec): boolean {
  return !!(spec?.latest && (spec.latest.npm || spec.latest.github || spec.latest.pypi || spec.latest.brew || spec.latest.web));
}
