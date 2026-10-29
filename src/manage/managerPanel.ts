// Agent Manager page: a full editor-area tab (the VS Code "welcome page" shape) listing every
// configured agent as a card with its installed/latest version and Install / Upgrade actions.
// The page owns no state of its own — version results come from agentVersion, installs run
// through agentInstaller, and every change is pushed to the webview as a message.

import * as vscode from "vscode";
import { resolveAgents, installAutomatableOnPlatform, installTarget, type AgentDef } from "../agents";
import { canExecute, invalidateExecutableCache } from "../agentDetector";
import * as settings from "../settings/settings";
import { agentIconUri } from "./icons";
import { renderManagerHtml } from "./managerHtml";
import { webviewAssetUri } from "../terminal/panelHtml";
import {
  buildInstallCommand,
  buildUpdateCommand,
  openAgentUrl,
  runHeadless,
} from "./agentInstaller";
import * as agentVersion from "./agentVersion";
import { stringsForWebview, t } from "../l10n";

/** Everything the webview needs to render one card. */
interface AgentCard {
  id: string;
  displayName: string;
  command: string;
  iconUri?: string;
  installed: boolean;
  url?: string;
  status: string;
  current: string;
  latest: string;
  error?: string;
  canInstall: boolean;
  canUpgrade: boolean;
}

export class AgentManagerPanel {
  public static readonly viewType = "aiAgentsTerminal.manage";
  private static current: AgentManagerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  /** Agents with an install/upgrade running — guards re-entry and Upgrade All selection. */
  private readonly busy = new Map<string, string>();
  private checking = false;
  /** Bound so it can be removed again on dispose (a fresh arrow would not match). */
  private readonly onVersionsChanged = (): void => this.pushVersionDeltas();

  private constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    this.panel = vscode.window.createWebviewPanel(
      AgentManagerPanel.viewType,
      t("manage.title"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
        retainContextWhenHidden: true,
      }
    );
    this.panel.webview.html = this.html();

    // Progressive UI: agentVersion publishes after every per-agent result; diff it against the
    // webview's card list and push only what changed.
    agentVersion.addListener(this.onVersionsChanged);

    this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    this.panel.onDidDispose(() => {
      for (const d of this.disposables.splice(0)) d.dispose();
      agentVersion.removeListener(this.onVersionsChanged);
      AgentManagerPanel.current = undefined;
    });

    // Agent catalog edits (yolo.agents setting) rebuild the grid; a version re-check follows
    // so statuses match the new list.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("yolo.agents")) {
          this.sendInit();
          void this.runCheckAll();
        }
      })
    );
  }

  /** Open the page (or reveal the already-open one). */
  public static show(extensionUri: vscode.Uri): void {
    if (AgentManagerPanel.current) {
      AgentManagerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    AgentManagerPanel.current = new AgentManagerPanel(extensionUri);
  }

  private html(): string {
    const scriptUri = webviewAssetUri(this.panel.webview, this.extensionUri, "manage.js");
    return renderManagerHtml(this.panel.webview.cspSource, scriptUri);
  }

  private agentCards(): AgentCard[] {
    const cards: AgentCard[] = [];
    const seen = new Set<string>();
    for (const def of resolveAgents()) {
      if (seen.has(def.id)) continue;
      seen.add(def.id);
      const spec = def.install;
      const info = agentVersion.infoFor(def.command);
      cards.push({
        id: def.id,
        displayName: def.displayName,
        command: def.command,
        iconUri: agentIconUri(this.panel.webview, this.extensionUri, def.icon),
        installed: canExecute(def.command),
        url: def.url,
        status: info?.status ?? "NA",
        current: info?.current ?? "",
        latest: info?.latest ?? "",
        error: info?.error,
        canInstall: installAutomatableOnPlatform(spec),
        canUpgrade: installAutomatableOnPlatform(spec),
      });
    }
    return cards;
  }

  private sendInit(): void {
    this.panel.webview.postMessage({
      type: "init",
      agents: this.agentCards(),
      strings: stringsForWebview(),
    });
  }

  /** Send every agent whose in-memory result differs from what the webview last saw. */
  private pushVersionDeltas(): void {
    this.panel.webview.postMessage({ type: "checking", checking: agentVersion.isChecking() });
    for (const def of resolveAgents()) {
      const info = agentVersion.infoFor(def.command);
      if (!info) continue;
      this.panel.webview.postMessage({
        type: "agentUpdate",
        agentId: def.id,
        status: info.status,
        current: info.current,
        latest: info.latest,
        error: info.error,
      });
    }
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "ready":
        this.sendInit();
        // First open (and every re-open after a webview recreation): refresh versions so the
        // grid never shows a stale snapshot from a previous session.
        void this.runCheckAll();
        break;
      case "refresh":
        void this.runCheckAll();
        break;
      case "install":
        await this.runAction(String(msg.agentId), false);
        break;
      case "upgrade":
        await this.runAction(String(msg.agentId), true);
        break;
      case "upgradeAll":
        await this.runUpgradeAll();
        break;
      case "openUrl":
        await openAgentUrl(String(msg.url ?? ""));
        break;
    }
  }

  private setBusy(agentId: string, label?: string): void {
    if (label) {
      this.busy.set(agentId, label);
      this.panel.webview.postMessage({ type: "busy", agentId, busy: true, label });
    } else {
      this.busy.delete(agentId);
      this.panel.webview.postMessage({ type: "busy", agentId, busy: false });
    }
  }

  private postResult(agentId: string, ok: boolean, message: string): void {
    this.panel.webview.postMessage({ type: "result", agentId, ok, message });
  }

  private async runCheckAll(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.panel.webview.postMessage({ type: "checking", checking: true });
    try {
      await agentVersion.checkAll(resolveAgents());
      const available = Object.values(agentVersion.snapshot()).filter(
        (i) => i.status === "UPDATE_AVAILABLE"
      ).length;
      this.panel.webview.postMessage({
        type: "status",
        message: available > 0 ? t("status.updatesAvailable", String(available)) : "",
      });
    } finally {
      this.checking = false;
      this.panel.webview.postMessage({ type: "checking", checking: false });
    }
  }

  /** Install (or upgrade) one agent head-less, then re-probe detection + versions. */
  private async runAction(agentId: string, upgrade: boolean): Promise<void> {
    const def = resolveAgents().find((a) => a.id === agentId);
    if (!def?.install || this.busy.has(agentId)) {
      return;
    }
    const label = t("status.installing", def.displayName, installTarget(def.install));
    this.setBusy(agentId, label);
    try {
      const command = upgrade ? buildUpdateCommand(def.install) : buildInstallCommand(def.install);
      if (!command || !installAutomatableOnPlatform(def.install)) {
        // `url` (or unknown / non-runnable) spec: nothing to run — open the download page instead.
        const site = def.url ?? def.install.url ?? "";
        if (!site) {
          this.postResult(agentId, false, t("status.noInstallUrl", def.displayName));
          return;
        }
        await openAgentUrl(site);
        this.postResult(agentId, true, t("status.install.opened", def.displayName));
        return;
      }
      const result = await runHeadless(command);
      if (!result.ok) {
        const detail = result.error ?? lastLine(result.output) ?? "unknown error";
        this.postResult(agentId, false, t("status.install.failed", def.displayName, detail));
        return;
      }
      // The installer exited 0, but a `curl | bash` / `npm install -g` can finish cleanly while
      // placing the binary somewhere not yet on PATH — verify the command is actually runnable
      // before claiming success.
      invalidateExecutableCache();
      await settings.syncInstalledAgents(
        resolveAgents().map((a) => ({ id: a.id, command: a.command })),
        settings.getCustomTools(),
        canExecute
      );
      if (!canExecute(def.command)) {
        this.postResult(
          agentId,
          false,
          t("status.install.unverified", def.displayName, def.command)
        );
      } else {
        this.postResult(agentId, true, t("status.installed", def.displayName));
      }
      // Refresh this agent's version pair so the card no longer shows a stale "Update available"
      // (clicking Update again would otherwise be a no-op).
      await agentVersion.refresh(def);
    } finally {
      this.setBusy(agentId, undefined);
    }
  }

  /** Upgrade every currently-outdated agent, one at a time (npm/pip hold global locks). */
  private async runUpgradeAll(): Promise<void> {
    const targets = this.agentCards().filter(
      (c) => c.status === "UPDATE_AVAILABLE" && c.canUpgrade && !this.busy.has(c.id)
    );
    for (const t of targets) {
      await this.runAction(t.id, true);
    }
  }
}


/** Last non-empty line of a command's output — the readable tail of a failed installer. */
function lastLine(output: string): string {
  const lines = (output ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}
