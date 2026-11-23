import * as vscode from "vscode";
import { resolveAgents, getAgentConfigWarnings, initBuiltInAgents, type AgentDef } from "./agents";
import { loadCachedBuiltIns, refreshOnStartup, resolveIconFilename } from "./agentCatalog";
import { AgentManagerPanel } from "./manage/managerPanel";
import { isInstalled, findExecutablePath, boostedPath } from "./agentDetector";

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

function agentIcon(
  ctx: vscode.ExtensionContext,
  agent: AgentDef
): vscode.Uri | vscode.ThemeIcon {
  const icon = agent.icon;
  if (!icon) {
    return new vscode.ThemeIcon("terminal");
  }
  // The registry stores only the icon filename. Prefer the bundled media/agents
  // asset; the hot-update cache (globalStorage/icons/agents) is checked next so
  // newly added agents can show an icon without a re-release.
  const cached = resolveIconFilename(ctx, icon);
  if (cached) return cached;
  return new vscode.ThemeIcon("terminal");
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

// The installed-agent set computed at activation (and on config change), shared
// with the Quick Pick so it reflects the latest agents.json / PATH state instead
// of re-reading a persisted cache that can lag behind an agents.json update.
let currentInstalledSet: Set<string> = new Set();

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
          name: agent.displayName,
          shellPath: findExecutablePath(agent.command) ?? agent.command,
          shellArgs,
          env: { PATH: boostedPath() },
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

// Cache of installed agent commands, kept in globalState (INTERNAL — not a
// user setting). It used to live in the `aiAgentsTerminal.installedAgents`
// setting, whose "Add Item" button in Settings UI misled users into thinking
// that was how you add an agent. Real agents are defined in `agents`; this is
// an auto-maintained cache, so it must be invisible/uneditable in Settings.
const INSTALLED_CACHE_KEY = "installedAgents";
// Legacy setting key, read once to migrate existing caches, then ignored.
const LEGACY_INSTALLED_SETTING = "installedAgents";
// Cross-instance mutex so only the first VS Code window refreshes the cache.
const REFRESH_LOCK_KEY = "installedAgentsRefreshLock";
const REFRESH_LOCK_TTL = 15_000; // ms — a lock older than this is treated as stale

/** Read the cached set of installed agent commands from globalState. */
function readInstalledCache(ctx: vscode.ExtensionContext): Set<string> {
  const stored = ctx.globalState.get<string[]>(INSTALLED_CACHE_KEY);
  if (stored) return new Set(stored);
  // One-time migration from the old (misleading) setting, then stop using it.
  return new Set(
    vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string[]>(LEGACY_INSTALLED_SETTING, [])
  );
}

/** Persist the installed command set to globalState (never back to Settings). */
async function writeInstalledCache(
  ctx: vscode.ExtensionContext,
  commands: string[]
): Promise<void> {
  await ctx.globalState.update(INSTALLED_CACHE_KEY, [...new Set(commands)]);
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
 *  probes, so N open windows don't each scan PATH on startup; every other
 *  window reuses the persisted cache for an instant result. Returns the final
 *  installed set. */
async function refreshInstalledCache(
  ctx: vscode.ExtensionContext,
  agents: AgentDef[],
  force = false
): Promise<Set<string>> {
  const cached = readInstalledCache(ctx);
  // A forced refresh (after a catalog hot-update) must not be suppressed by the
  // cross-instance lock: the hot-update may have introduced newly-installed
  // agents that the persisted cache doesn't know about yet.
  if (!force && !acquireFirstInstanceLock(ctx)) {
    return cached; // another window already owns the refresh this session
  }

  // On a forced refresh, resolve the catalog live so agents just introduced by
  // a hot-update (which may still be in flight) are included in the scan.
  const catalog = force ? resolveAgents() : agents;
  // Probe the FULL agent list, not just commands not yet known-installed. If we
  // only ever added to the cache, an agent uninstalled between runs would stay
  // listed as installed (and a later launch would fail with "not recognized").
  // Re-probing everything keeps the cache honest; PATH resolution of ~tens of
  // agents is cheap and only the first window pays for it per session.
  const installed = await detectInstalled(catalog);
  const next = installed.map((a) => a.command);
  await writeInstalledCache(ctx, next);
  return new Set(next);
}

/** Re-register terminal profiles from a freshly computed installed set. */
function applyInstalledSet(ctx: vscode.ExtensionContext, next: Set<string>): void {
  currentInstalledSet = next;
  const updated = resolveAgents().filter((a) => next.has(a.command));
  registerInstalledTerminalProfiles(ctx, updated);
}

async function pickAndLaunch(ctx: vscode.ExtensionContext) {
  // Dynamic list: only agents actually detected on PATH.
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const yolo = cfg.get<boolean>("yoloMode", false);
  const resume = cfg.get<boolean>("resumeMode", false);

  type AgentItem = { label: string; iconPath: vscode.Uri | vscode.ThemeIcon; agent: AgentDef };
  type SettingsItem = { label: string; description: string; iconPath: vscode.ThemeIcon; openSettings: true };
  type ManageItem = { label: string; description: string; iconPath: vscode.ThemeIcon; openManager: true };
  const agents = resolveAgents();
  // Render from the cached installed set (refreshed once whenever the agent
  // config changes — see the onDidChangeConfiguration handler). No live probe
  // here: opening the picker must stay instant.
  const installed = agents.filter((a) => currentInstalledSet.has(a.command));
  let items: (AgentItem | SettingsItem | ManageItem)[] = installed.map((agent) => ({
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

  // Manage Agents entry (second-to-last): opens the Agent Manager webview page.
  items.push({
    label: "Manage Agents",
    description: "Install / upgrade agents",
    iconPath: new vscode.ThemeIcon("robot"),
    openManager: true,
  });

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
  const qp = vscode.window.createQuickPick<AgentItem | SettingsItem | ManageItem>();
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
        `@ext:${ctx.extension.id}`
      );
      qp.dispose();
      return;
    }

    // Manage Agents item: open the Agent Manager webview page.
    if ("openManager" in picked) {
      AgentManagerPanel.show(ctx);
      qp.dispose();
      return;
    }

    // YOLO / Resume mode: append the agent's auto-approve and resume args.
    const shellArgs = buildShellArgs(picked.agent, yolo, resume);

    // Remember this agent so the next Quick Pick pre-selects it.
    void ctx.globalState.update(LAST_AGENT_KEY, picked.agent.command);

    vscode.window
      .createTerminal({
        name: picked.agent.displayName,
        shellPath: findExecutablePath(picked.agent.command) ?? picked.agent.command,
        shellArgs,
        env: { PATH: boostedPath() },
        iconPath: agentIcon(ctx, picked.agent),
      })
      .show();
    qp.dispose();
  });
  qp.show();
}

export async function activate(ctx: vscode.ExtensionContext) {
  // Load the built-in agent catalog from agents.json once (program/data separation),
  // then overlay the last-good hot-update cache so the previous catalog shows
  // instantly before the network refresh completes.
  initBuiltInAgents(ctx);
  loadCachedBuiltIns(ctx);

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

  // Seed the installed set from the persisted cache immediately, so the launcher
  // renders instantly without waiting on a (possibly slow) PATH probe. The probe
  // runs in the background below and updates currentInstalledSet + terminal
  // profiles once it lands.
  const cachedSet = readInstalledCache(ctx);
  currentInstalledSet = new Set(cachedSet);
  const installedCount = cachedSet.size;
  const detectedCommands = [...cachedSet];

  // Register Terminal menu profiles for installed agents only (filters out the
  // ones not on PATH, which a static package.json contribution can't do).
  const installedAgents = agents.filter((a) => cachedSet.has(a.command));
  registerInstalledTerminalProfiles(ctx, installedAgents);

  // Startup sequence — order matters:
  //   1. seed the installed set from the persisted cache (above) for instant UI
  //   2. fetch/merge the remote catalog (refreshOnStartup)
  //   3. ONLY THEN re-scan PATH and write the installed cache, using the final
  //      merged catalog. Scanning before the catalog settles filters against a
  //      stale agent set and makes the Quick Pick list inconsistent.
  // The forced scan bypasses the cross-instance lock so a stale cache is corrected.
  void refreshOnStartup(ctx, () => {
    void refreshInstalledCache(ctx, resolveAgents(), /* force */ true).then((next) => {
      applyInstalledSet(ctx, next);
      AgentManagerPanel.refreshIfOpen();
    });
  });

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

  // Structural config problems (duplicate command / name / id) — logged to the
  // console only (no popup), consistent with the availability check below. Runs
  // on any change to the extension's settings.
  const warnAgentConfig = () => {
    const warnings = getAgentConfigWarnings();
    if (warnings.length > 0) {
      console.warn(`AI Agents Terminal: ${warnings.join(" ")}`);
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
      // Agents edited in Settings (custom tools added/removed or a built-in
      // overridden): force a fresh PATH scan — the cross-instance lock must not
      // skip it, or a newly added custom tool would never enter the installed
      // set and the dropdown would stay stale. Then rebuild the dropdown so the
      // add/remove is reflected immediately, and refresh the manager page.
      if (e.affectsConfiguration(`${CONFIG_SECTION}.agents`)) {
        void warnAgentAvailability();
        void refreshInstalledCache(ctx, resolveAgents(), /* force */ true).then((next) => {
          applyInstalledSet(ctx, next);
          AgentManagerPanel.refreshIfOpen();
        });
      }
    })
  );

  console.log(
    `[${EXTENSION_ID}] activated; ${installedCount}/${resolveAgents().length} agents detected on PATH: ${detectedCommands.join(", ") || "(none)"}`
  );
}

export function deactivate() {}
