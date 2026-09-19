import * as vscode from "vscode";
import { resolveAgents, getAgentConfigWarnings, initBuiltInAgents, type AgentDef } from "./agents";
import { isInstalled } from "./agentDetector";

// Single source of truth for the extension identity.
// Keep this in sync with the `name` / `contributes.commands` in package.json.
const EXTENSION_ID = "ai-agents-terminal";
const OPEN_MENU_COMMAND = `${EXTENSION_ID}.openMenu`;
const TOGGLE_YOLO_COMMAND = `${EXTENSION_ID}.toggleYoloMode`;
const TOGGLE_RESUME_COMMAND = `${EXTENSION_ID}.toggleResumeMode`;
// Remembers the agent the user launched most recently, so the next Quick Pick pre-selects it.
const LAST_AGENT_KEY = "lastAgentCommand";

// Settings namespace (package.json `contributes.configuration`).
const CONFIG_SECTION = "aiAgentsTerminal";
// Full extension id (<publisher>.<name>) for opening scoped Settings.
const EXTENSION_FULL_ID = "cnsharpstudio.ai-agents-terminal";

function agentIcon(
  ctx: vscode.ExtensionContext,
  agent: AgentDef
): vscode.Uri | vscode.ThemeIcon {
  if (!agent.iconFile) {
    return new vscode.ThemeIcon("terminal");
  }
  return vscode.Uri.joinPath(
    ctx.extensionUri,
    "media",
    "agents",
    agent.iconFile
  );
}

/** Agents from the config whose `command` is actually installed. Runs all
 *  checks in parallel so the QuickPick appears immediately. */
async function detectInstalled(agents: AgentDef[]): Promise<AgentDef[]> {
  const results = await Promise.all(
    agents.map(async (a) => ((await isInstalled(a.command)) ? a : null))
  );
  return results.filter((a): a is AgentDef => a !== null);
}

/** Split a space-separated args string into tokens (mirrors how IDEA parses
 *  its skipFlag / baseArgs / resumeFlag). Empty string => no tokens. */
function splitArgs(s: string | undefined): string[] {
  return (s ?? "").split(/\s+/).filter(Boolean);
}

/** Build the shell args for launching an agent, honouring YOLO and Resume mode.
 *  Resume flag is appended last so it applies on top of base + skip args. */
function buildShellArgs(agent: AgentDef, yolo: boolean, resume: boolean): string[] {
  const args = splitArgs(agent.baseArgs);
  if (yolo && agent.skipFlag) {
    args.push(...splitArgs(agent.skipFlag));
  }
  if (resume && agent.resumeFlag) {
    args.push(...splitArgs(agent.resumeFlag));
  }
  return args;
}

// Terminal-profile providers registered from code. Because `contributes.terminal`
// in package.json is static, it can't filter by what's installed — so we register
// a provider per installed agent here, and only those show up in the Terminal
// menu / "Select Default Profile" picker. Re-created whenever the installed set
// changes, so we track the disposables to clear the previous round.
let terminalProfileDisposables: vscode.Disposable[] = [];

/** Register one TerminalProfileProvider for each installed agent. The provider's
 *  `id` doubles as the menu label (built-ins like "Git Bash" use display names
 *  too), and the profile is built live so YOLO mode is honoured at launch time. */
function registerInstalledTerminalProfiles(ctx: vscode.ExtensionContext, installed: AgentDef[]) {
  // Clear the previous round before re-registering.
  terminalProfileDisposables.forEach((d) => d.dispose());
  terminalProfileDisposables = installed.map((agent) => {
    const provider: vscode.TerminalProfileProvider = {
      provideTerminalProfile: () => {
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const yolo = cfg.get<boolean>("yoloMode", false);
        const resume = cfg.get<boolean>("resumeMode", false);
        const shellArgs = buildShellArgs(agent, yolo, resume);
        // Remember this agent so the status-bar Quick Pick pre-selects it next time.
        void ctx.globalState.update(LAST_AGENT_KEY, agent.command);
        return new vscode.TerminalProfile({
          name: `AI: ${agent.displayName}`,
          shellPath: agent.command,
          shellArgs,
          iconPath: agentIcon(ctx, agent),
        });
      },
    };
    // id = label shown in the Terminal menu. Stable per agent command.
    return vscode.window.registerTerminalProfileProvider(
      `ai-agents-terminal.${agent.command}`,
      provider
    );
  });
}

// Cache of installed agent commands, persisted in Global settings so every
// window and every restart can render instantly without re-probing PATH.
const INSTALLED_CACHE_KEY = "installedAgents";
// Cross-instance mutex so only the first VS Code window refreshes the cache.
const REFRESH_LOCK_KEY = "installedAgentsRefreshLock";
const REFRESH_LOCK_TTL = 15_000; // ms — a lock older than this is treated as stale

/** Read the cached set of installed agent commands from settings. */
function readInstalledCache(): Set<string> {
  return new Set(
    vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string[]>(INSTALLED_CACHE_KEY, [])
  );
}

/** Persist the installed command set back to Global settings. */
async function writeInstalledCache(commands: string[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await cfg.update(
    INSTALLED_CACHE_KEY,
    [...new Set(commands)],
    vscode.ConfigurationTarget.Global
  );
}

/** Cross-instance mutex: only the first VS Code window within the TTL may
 *  refresh the cache, so N open windows don't each probe PATH on startup. */
function acquireFirstInstanceLock(ctx: vscode.ExtensionContext): boolean {
  const now = Date.now();
  const held = ctx.globalState.get<{ ts: number }>(REFRESH_LOCK_KEY);
  if (held && now - held.ts < REFRESH_LOCK_TTL) {
    return false; // owned by another (live) instance
  }
  // Claim the lock. The in-memory write takes effect for this instance
  // immediately; a stale/expired lock is simply overwritten.
  void ctx.globalState.update(REFRESH_LOCK_KEY, { ts: now });
  return true;
}

/** Refresh the installed cache. Only the first instance within the lock TTL
 *  probes, so N open windows don't each scan PATH on startup. Returns the final
 *  installed set. */
async function refreshInstalledCache(
  ctx: vscode.ExtensionContext,
  agents: AgentDef[]
): Promise<Set<string>> {
  const cached = readInstalledCache();
  if (!acquireFirstInstanceLock(ctx)) {
    return cached; // another window already owns the refresh this session
  }

  // Probe the FULL agent list, not just commands not yet known-installed. If we
  // only ever added to the cache, an agent uninstalled between runs would stay
  // listed as installed (and a later launch would fail with "not recognized").
  // Re-probing everything keeps the cache honest; PATH resolution of ~tens of
  // agents is cheap and only the first window pays for it per session.
  const installed = await detectInstalled(agents);
  const next = installed.map((a) => a.command);
  await writeInstalledCache(next);
  return new Set(next);
}

async function pickAndLaunch(ctx: vscode.ExtensionContext) {
  // Dynamic list: only agents actually detected on PATH.
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const yolo = cfg.get<boolean>("yoloMode", false);
  const resume = cfg.get<boolean>("resumeMode", false);

  type AgentItem = { label: string; iconPath: vscode.Uri | vscode.ThemeIcon; agent: AgentDef };
  type SettingsItem = { label: string; description: string; iconPath: vscode.ThemeIcon; openSettings: true };
  const agents = resolveAgents();
  // Render instantly from the cached installed set. Fall back to a live probe
  // only when the cache is empty (e.g. first-ever run before the background
  // refresh has finished).
  const cache = readInstalledCache();
  const installed =
    cache.size > 0
      ? agents.filter((a) => cache.has(a.command))
      : await detectInstalled(agents);
  let items: (AgentItem | SettingsItem)[] = installed.map((agent) => ({
    label: agent.displayName,
    iconPath: agentIcon(ctx, agent),
    agent,
  }));

  if (items.length === 0) {
    vscode.window.showInformationMessage(
      "No AI agents detected on PATH (looked for: " +
        agents.map((a) => a.command).join(", ") +
        ")."
    );
  }

  // Settings entry pinned to the bottom of the list.
  items.push({
    label: "Settings",
    description: "Configure AI Agents Terminal",
    iconPath: new vscode.ThemeIcon("gear"),
    openSettings: true,
  });

  // Pre-select the agent the user launched most recently (if still installed).
  const lastCommand = ctx.globalState.get<string>(LAST_AGENT_KEY);
  const activeItem = lastCommand
    ? items.find((i): i is AgentItem => "agent" in i && (i as AgentItem).agent.command === lastCommand)
    : undefined;

  // createQuickPick (not showQuickPick) is used so we can pre-select via activeItems.
  const qp = vscode.window.createQuickPick<AgentItem | SettingsItem>();
  qp.items = items;
  qp.matchOnDescription = true;
  qp.placeholder = yolo
    ? "Launch an AI agent — YOLO mode (auto-approve) in a new terminal"
    : "Launch an AI agent in a new terminal";
  if (activeItem) {
    qp.activeItems = [activeItem];
  }
  qp.onDidAccept(() => {
    const picked = qp.selectedItems[0];
    qp.hide();
    if (!picked) {
      qp.dispose();
      return;
    }
    // Settings item: open the extension's scoped Settings UI.
    if ("openSettings" in picked) {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${EXTENSION_FULL_ID}`
      );
      qp.dispose();
      return;
    }

    // YOLO / Resume mode: append the agent's auto-approve and resume args.
    const shellArgs = buildShellArgs(picked.agent, yolo, resume);

    // Remember this agent so the next Quick Pick pre-selects it.
    void ctx.globalState.update(LAST_AGENT_KEY, picked.agent.command);

    vscode.window
      .createTerminal({
        name: `AI: ${picked.agent.displayName}`,
        shellPath: picked.agent.command,
        shellArgs,
        iconPath: agentIcon(ctx, picked.agent),
      })
      .show();
    qp.dispose();
  });
  qp.show();
}

export async function activate(ctx: vscode.ExtensionContext) {
  // Load the built-in agent catalog from agents.json once (program/data separation).
  initBuiltInAgents(ctx);

  // "AI Agents" command -> QuickPick of detected agents.
  ctx.subscriptions.push(
    vscode.commands.registerCommand(OPEN_MENU_COMMAND, () =>
      pickAndLaunch(ctx)
    )
  );

  // "Toggle YOLO mode" command -> flips the aiAgentsTerminal.yoloMode setting.
  ctx.subscriptions.push(
    vscode.commands.registerCommand(TOGGLE_YOLO_COMMAND, async () => {
      const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const current = cfg.get<boolean>("yoloMode", false);
      await cfg.update("yoloMode", !current, vscode.ConfigurationTarget.Global);
    })
  );

  // "Toggle Resume mode" command -> flips the aiAgentsTerminal.resumeMode setting.
  ctx.subscriptions.push(
    vscode.commands.registerCommand(TOGGLE_RESUME_COMMAND, async () => {
      const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const current = cfg.get<boolean>("resumeMode", false);
      await cfg.update("resumeMode", !current, vscode.ConfigurationTarget.Global);
    })
  );

  const agents = resolveAgents();

  // First VS Code instance (per restart) incrementally refreshes the installed
  // cache; every other window reuses it so PATH is probed only once.
  const installedSet = await refreshInstalledCache(ctx, agents);
  const installedCount = installedSet.size;
  const detectedCommands = [...installedSet];

  // Register Terminal menu profiles for installed agents only (filters out the
  // ones not on PATH, which a static package.json contribution can't do).
  const installedAgents = agents.filter((a) => installedSet.has(a.command));
  registerInstalledTerminalProfiles(ctx, installedAgents);

  // Reliable, always-visible launcher: a status-bar button.
  // (The Terminal `+` caret and `terminal/title` menus do NOT surface
  // third-party contributions in this VS Code build — verified: only
  // "Terminal: Select Default Profile" lists the contributed profiles.)
  const launcherSb = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  launcherSb.command = OPEN_MENU_COMMAND;
  ctx.subscriptions.push(launcherSb);

  // YOLO toggle button (letter "Y" mark); highlighted when on.
  const yoloSb = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  yoloSb.command = TOGGLE_YOLO_COMMAND;
  ctx.subscriptions.push(yoloSb);

  // Resume toggle button (replay mark); highlighted when on.
  const resumeSb = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98
  );
  resumeSb.command = TOGGLE_RESUME_COMMAND;
  ctx.subscriptions.push(resumeSb);

  const refresh = () => {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const yolo = cfg.get<boolean>("yoloMode", false);
    const resume = cfg.get<boolean>("resumeMode", false);
    launcherSb.tooltip = yolo
      ? "Launch an AI agent (YOLO / auto-approve) in a new terminal"
      : "Launch an AI agent in a new terminal";
    launcherSb.text = `$(robot) AI Agents`;
    yoloSb.text = "Y";
    yoloSb.tooltip = yolo
      ? "YOLO mode ON — agents launch auto-approved. Click to turn off."
      : "YOLO mode OFF. Click to auto-approve agent launches.";
    // Enabled: highlighted background. Disabled: greyed out.
    yoloSb.backgroundColor = yolo
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    yoloSb.color = yolo
      ? undefined
      : new vscode.ThemeColor("statusBarItem.offForeground");
    resumeSb.text = "R";
    resumeSb.tooltip = resume
      ? "Resume mode ON — agents relaunch with their resume flag to continue the last session. Click to turn off."
      : "Resume mode OFF. Click to continue the last agent session.";
    resumeSb.backgroundColor = resume
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    resumeSb.color = resume
      ? undefined
      : new vscode.ThemeColor("statusBarItem.offForeground");
    launcherSb.show();
    yoloSb.show();
    resumeSb.show();
  };

  refresh();

  // Structural config problems (duplicate command / name / id) — instant, runs
  // on any change to the extension's settings.
  const warnAgentConfig = () => {
    const warnings = getAgentConfigWarnings();
    if (warnings.length > 0) {
      vscode.window.showWarningMessage(
        `AI Agents Terminal: ${warnings.join(" ")}`
      );
    }
  };

  // Availability check: probe each agent's `command` on PATH. The JSON schema
  // only validates shape, not whether the command actually runs. Not finding a
  // command is the normal/expected state (most users install only a few agents),
  // so this is logged to the console for debugging rather than popped up as a
  // warning. Runs at startup and whenever the agent list is edited.
  const warnAgentAvailability = async () => {
    const agents = resolveAgents();
    const results = await Promise.all(
      agents.map(async (a) => ({ cmd: a.command, ok: await isInstalled(a.command) }))
    );
    const missing = results.filter((r) => !r.ok).map((r) => r.cmd);
    if (missing.length > 0) {
      console.log(
        `[${EXTENSION_ID}] command(s) not on PATH (expected if not installed): ${missing.join(", ")}`
      );
    }
  };
  warnAgentConfig();
  await warnAgentAvailability();

  // Keep both buttons in sync if the setting is changed from Settings UI.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        refresh();
        warnAgentConfig();
      }
      // Newly added agents: re-check command availability and refresh the
      // installed cache; existing cache entries are reused. Re-register the
      // Terminal menu profiles so the list matches what's now installed.
      if (e.affectsConfiguration(`${CONFIG_SECTION}.agents`)) {
        void warnAgentAvailability();
        void refreshInstalledCache(ctx, resolveAgents()).then((next) => {
          const nextAgents = resolveAgents().filter((a) => next.has(a.command));
          registerInstalledTerminalProfiles(ctx, nextAgents);
        });
      }
    })
  );

  console.log(
    `[${EXTENSION_ID}] activated; ${installedCount}/${resolveAgents().length} agents detected on PATH: ${detectedCommands.join(", ") || "(none)"}`
  );
}

export function deactivate() {}
