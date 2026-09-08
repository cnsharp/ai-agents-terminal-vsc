// YOLO webview view provider: owns the embedded PTY and bridges I/O + navigation messages to/from the
// webview. Implements vscode.WebviewViewProvider so the panel docks in the activity bar (the IntelliJ
// "tool window" equivalent) and persists while hidden.

import * as vscode from "vscode";
import { spawnAgent, defaultCwd, type YoloPty, type SpawnBackend, type SpawnResult } from "./terminalProvider";
import { toSerializable } from "../links/linkPatterns";
import { resolveAgents, type AgentDef } from "../agents/catalog";
import { canExecute, resolvePath } from "../agents/agentDetector";
import * as settings from "../settings/settings";
import {
  openFileAt,
  resolveType,
  resolveMember,
  openSymbol,
  openUrl,
  describeLink,
} from "../navigation/navigation";
import type { LinkPayload } from "../links/linkParser";
import { renderPanelHtml, webviewAssetUri } from "./panelHtml";
import { Regexes } from "../constants/regexes";

interface AgentOption {
  id: string;
  displayName: string;
  command: string;
  /** Absolute path the agent resolves to (or undefined if not found on PATH). */
  resolvedPath?: string;
  /** Webview-resolved icon URI (or undefined if the view isn't ready yet). */
  iconUri?: string;
}

/**
 * One open terminal tab. Mirrors IDEA's `Session` (widget + process + agent row + tab component +
 * card key): everything a session needs lives here, so nothing is shared between tabs.
 */
export interface YoloSession {
  /** Stable id ("session-1"), the VS Code equivalent of IDEA's CardLayout `cardKey`. */
  id: string;
  pty: YoloPty;
  backend: SpawnBackend;
  agentId: string;
  displayName: string;
  iconUri?: string;
  command: string;
  /** Rolling replay buffer for this session only (IDEA keeps every widget alive too). */
  out: string;
  /** Set while a close confirmation is in flight, so a double-click can't open a second dialog. */
  closing?: boolean;
}

export class YoloViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "yolo.panel";
  private view: vscode.WebviewView | undefined;
  /**
   * Open terminal sessions in tab order — the VS Code equivalent of IDEA's
   * `sessions: MutableList<Session>` + `selectedIndex` in `YoloToolWindowFactory`. Every Launch adds a
   * new session (it never kills an existing one), so several agents run side by side.
   */
  private sessions: YoloSession[] = [];
  /** Id of the selected tab, or undefined when none is open (IDEA: `selectedIndex = -1`). */
  private selectedId: string | undefined;
  /** Monotonic id source for session ids — stable across closes, unlike array indices. */
  private sessionSeq = 0;
  /** Rolling buffer of PTY output per session, replayed into a re-created webview. */
  private static readonly PTY_OUT_CAP = 256 * 1024;

  constructor(private readonly extensionUri: vscode.Uri) {
    // When any yolo.* setting changes (e.g. custom tools edited in Settings), re-scan installs and
    // re-send init so the agent dropdown reflects the latest state without a restart.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("yolo")) {
        // Only re-probe installed agents when the agent list itself changed; toggling YOLO/Resume
        // merely re-sends init so the panel reflects the persisted setting.
        if (e.affectsConfiguration("yolo.agents")) {
          settings.syncInstalledAgents(
            resolveAgents().map((a) => ({ id: a.id, command: a.command })),
            settings.getCustomTools(),
            canExecute
          );
        }
        this.sendInit();
      }
    });
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    // Detach only — keep the running PTY alive across view hide/dispose so the session survives. The
    // new webview re-attaches to the existing PTY in the `ready` handler. (We dispose the PTY only on a
    // fresh launch or extension deactivation.)
    view.onDidDispose(() => {
      this.view = undefined;
    });
    // Push the initial state immediately (do not wait for the webview's `ready` round-trip — that
    // handshake can be lost on fast reloads, leaving the agent list empty). The webview also re-requests
    // via `ready`, which re-sends this, so a double delivery is harmless.
    this.sendInit();
  }

  /** Kill every running PTY (called on extension deactivation to avoid orphaned agent processes). */
  public dispose(): void {
    for (const s of this.sessions.splice(0)) {
      try {
        s.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.selectedId = undefined;
  }

  public reveal(): void {
    // The view lives in the Secondary Side Bar (right), which is hidden by default — reveal it first,
    // then focus the docked view (the latter creates it on first use).
    vscode.commands.executeCommand("workbench.action.focusSecondarySideBar");
    vscode.commands.executeCommand("yolo.panel.focus");
  }

  private agentOptions(): AgentOption[] {
    const seen = new Set<string>();
    const out: AgentOption[] = [];
    // All agents (built-ins from agents.json + user `yolo.agents` overrides) are data-driven; the
    // code holds no agent list of its own.
    for (const def of resolveAgents()) {
      if (seen.has(def.id)) {
        continue;
      }
      seen.add(def.id);
      out.push({
        id: def.id,
        displayName: def.displayName,
        command: def.command,
        resolvedPath: resolvePath(def.command),
        iconUri: this.iconUriFor(def),
      });
    }
    return out;
  }

  /** Resolve an agent icon to a webview URI. Built-ins carry an `iconFile` (under media/agents);
   *  icon-less / custom agents have no logo. Returns undefined until the view is ready. */
  private iconUriFor(def: AgentDef): string | undefined {
    const wv = this.view?.webview;
    if (!wv || !def.iconFile) {
      return undefined;
    }
    return wv
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "agents", def.iconFile))
      .toString();
  }

  /** Webview URIs for the YOLO (skip-permissions) toggle, taken from the IDEA edition. Returns
   *  undefined until the view is ready. */
  private skipIconUris():
    | { off: string; offDark: string; on: string; onDark: string }
    | undefined {
    const wv = this.view?.webview;
    if (!wv) {
      return undefined;
    }
    const u = (rel: string) =>
      wv.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "icons", rel)).toString();
    return {
      off: u("skipY.svg"),
      offDark: u("skipY_dark.svg"),
      on: u("skipYOn.svg"),
      onDark: u("skipYOn_dark.svg"),
    };
  }

  /** Webview URIs for the Resume toggle, also taken from the IDEA edition (resume.svg / resumeOn.svg
   *  and their *_dark variants). Returns undefined until the view is ready. */
  private resumeIconUris():
    | { off: string; offDark: string; on: string; onDark: string }
    | undefined {
    const wv = this.view?.webview;
    if (!wv) {
      return undefined;
    }
    const u = (rel: string) =>
      wv.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "icons", rel)).toString();
    return {
      off: u("resume.svg"),
      offDark: u("resume_dark.svg"),
      on: u("resumeOn.svg"),
      onDark: u("resumeOn_dark.svg"),
    };
  }

  private html(): string {
    const scriptUri = webviewAssetUri(this.view!.webview, this.extensionUri, "panel.js");
    const styleUri = webviewAssetUri(this.view!.webview, this.extensionUri, "panel.css");
    const csp = this.view!.webview.cspSource;
    return renderPanelHtml(csp, scriptUri, styleUri);
  }

  private sendInit(): void {
    const agents = this.agentOptions();
    this.view?.webview.postMessage({
      type: "init",
      matchers: toSerializable(),
      agents,
      skipEnabled: settings.getSkipEnabled(),
      resumeMode: settings.getResumeMode(),
      lastAgentId: settings.getLastAgentId(),
      skipIcons: this.skipIconUris(),
      resumeIcons: this.resumeIconUris(),
      cwd: defaultCwd(),
    });
  }

  private onMessage(msg: any): void {
    switch (msg?.type) {
      case "ready":
        this.sendInit();
        // Re-attach the new webview to EVERY running session (the view may have been hidden / moved /
        // re-created). Each gets its own `replay` so all tabs restore, not just one. postMessage is
        // ordered, so `init` (matchers) always lands before the `spawned` messages that need it.
        for (const s of this.sessions) {
          this.view?.webview.postMessage({
            type: "spawned",
            sessionId: s.id,
            agentId: s.agentId,
            displayName: s.displayName,
            iconUri: s.iconUri,
            command: s.command,
            backend: s.backend,
            replay: s.out,
          });
        }
        if (this.selectedId) {
          this.view?.webview.postMessage({ type: "selected", sessionId: this.selectedId });
        }
        break;
      case "input":
        this.byId(msg.sessionId)?.pty.write(msg.data);
        break;
      case "resize":
        try {
          if (msg.cols > 0 && msg.rows > 0) {
            this.byId(msg.sessionId)?.pty.resize(msg.cols, msg.rows);
          }
        } catch {
          /* terminal may not be ready for an intermediate size */
        }
        break;
      case "selectSession":
        if (this.byId(msg.sessionId)) {
          this.selectedId = msg.sessionId;
        }
        break;
      case "closeSession":
        void this.confirmAndClose(msg.sessionId);
        break;
      case "launch":
        this.launch(msg);
        break;
      case "setSkip":
        settings.setSkipEnabled(Boolean(msg.skip));
        break;
      case "setResume":
        settings.setResumeMode(Boolean(msg.resume));
        break;
      case "setLastAgent":
        if (typeof msg.agentId === "string" && msg.agentId.length > 0) {
          settings.setLastAgentId(msg.agentId);
        }
        break;
      case "openSettings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "yolo");
        break;
      case "navigate":
        void this.navigate(msg.payload as LinkPayload);
        break;
      case "hover":
        void this.hover(msg as { reqId: number; payload: LinkPayload });
        break;
      case "agentListMissing":
        // Watchdog fired: the host never delivered the agent list. Surface it as a real notification
        // (the panel has no status bar).
        vscode.window.showErrorMessage("YOLO: the agent list failed to load.");
        break;
    }
  }

  /** Resolve a link to hover-preview text and send it back to the webview. */
  private async hover(msg: { reqId: number; payload: LinkPayload }): Promise<void> {
    const text = await describeLink(msg.payload);
    this.view?.webview.postMessage({ type: "hoverResult", reqId: msg.reqId, text });
  }

  private launch(msg: { agentId: string; skip: boolean; resume?: boolean; baseArgs?: string; cols?: number; rows?: number }): void {
    // NOTE: deliberately no teardown of any existing session — every Launch opens a NEW tab, so
    // several agents can run side by side (IDEA's addTerminalSession). The old single-session code
    // killed the running PTY here.
    const def = resolveAgents().find((a) => a.id === msg.agentId);
    if (!def) {
      return;
    }
    if (!canExecute(def.command)) {
      vscode.window.showErrorMessage(`YOLO: '${def.command}' is not installed / not on PATH.`);
      return;
    }

    // Remember this agent so the panel pre-selects it next time.
    settings.setLastAgentId(def.id);

    // Base args: the catalog's `baseArgs` first, then any per-agent override from settings.
    const args: string[] = (def.baseArgs ?? "").split(Regexes.WHITESPACE_RUN).filter(Boolean);
    const env: Record<string, string> = {};
    const extraBase = settings.getAgentBaseArgs()[def.id.toLowerCase()] ?? msg.baseArgs ?? "";
    if (extraBase.trim().length > 0) {
      args.push(...extraBase.trim().split(Regexes.WHITESPACE_RUN));
    }
    // YOLO (skip-permissions) flag: a manual `yolo.permissionRules` entry (by command or id) overrides
    // the catalog's `skipFlag`. Whether the flag is POSIX-style decides if we prefer a POSIX shell on
    // Windows (so the flag isn't handed to cmd.exe).
    let posixIndicator = "";
    if (msg.skip) {
      const rule = settings
        .getPermissionRules()
        .find((r) => r.agentId === def.command || r.agentId === def.id);
      const flag = rule?.flag ?? (def.skipFlag ?? "");
      if (flag) {
        args.push(...flag.trim().split(Regexes.WHITESPACE_RUN));
        posixIndicator = flag;
      }
    }
    // Resume flag: continue the most recent session for this agent. Appended last so it sits on top
    // of base + YOLO args.
    if (msg.resume && def.resumeFlag) {
      args.push(...def.resumeFlag.split(Regexes.WHITESPACE_RUN).filter(Boolean));
    }
    const preferPosix = process.platform === "win32" && posixIndicator.trim().startsWith("-");

    let result: SpawnResult;
    try {
      result = spawnAgent({ command: def.command, args, cwd: defaultCwd(), env, preferPosix, cols: msg.cols, rows: msg.rows });
    } catch (e) {
      vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    const session: YoloSession = {
      id: `session-${++this.sessionSeq}`,
      pty: result.pty,
      backend: result.backend,
      agentId: def.id,
      displayName: def.displayName,
      iconUri: this.iconUriFor(def),
      command: def.command,
      out: "",
    };
    this.sessions.push(session);
    // IDEA: `selectedIndex = sessions.lastIndex` — a new tab becomes the active one.
    this.selectedId = session.id;

    // Capture `session`, never a shared field: routing through `this.*` here would send every
    // session's output through whichever session was spawned last.
    session.pty.onData((data) => {
      session.out += data;
      if (session.out.length > YoloViewProvider.PTY_OUT_CAP) {
        session.out = session.out.slice(-YoloViewProvider.PTY_OUT_CAP);
      }
      this.view?.webview.postMessage({ type: "data", sessionId: session.id, data });
    });
    this.view?.webview.postMessage({
      type: "spawned",
      sessionId: session.id,
      agentId: session.agentId,
      displayName: session.displayName,
      iconUri: session.iconUri,
      command: session.command,
      backend: session.backend,
    });
  }

  /** Look up a session by id. */
  private byId(id?: string): YoloSession | undefined {
    return id ? this.sessions.find((s) => s.id === id) : undefined;
  }

  /** Ask before tearing down a terminal, since closing kills the running PTY (IDEA: confirmCloseTab). */
  private async confirmAndClose(id: string): Promise<void> {
    const session = this.byId(id);
    if (!session || session.closing) {
      return;
    }
    session.closing = true;
    const answer = await vscode.window.showWarningMessage(
      "Close this terminal? The running process will be terminated.",
      { modal: true },
      "Close terminal"
    );
    // Re-check: the session may have been closed while the dialog was open.
    if (!this.sessions.includes(session)) {
      return;
    }
    session.closing = false;
    if (answer !== "Close terminal") {
      return;
    }
    this.closeSession(id);
  }

  /** Tear down a session: kill its PTY, drop it, and select a neighbour (IDEA: closeSession). */
  private closeSession(id: string): void {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx < 0) {
      return;
    }
    const [session] = this.sessions.splice(idx, 1);
    try {
      session.pty.kill();
    } catch {
      /* already gone */
    }
    this.view?.webview.postMessage({ type: "sessionClosed", sessionId: id });
    if (this.sessions.length === 0) {
      // IDEA: show the CARD_EMPTY placeholder again.
      this.selectedId = undefined;
    } else {
      // Clamp to a neighbour — indices shifted when an earlier tab was closed.
      this.selectedId = this.sessions[Math.min(idx, this.sessions.length - 1)].id;
      this.view?.webview.postMessage({ type: "selected", sessionId: this.selectedId });
    }
  }

  private async navigate(payload: LinkPayload): Promise<void> {
    try {
      switch (payload.kind) {
        case "url":
          await openUrl(payload.url!);
          break;
        case "file":
          await openFileAt(payload.path!, payload.line, payload.column);
          break;
        case "type": {
          const sym = await resolveType(payload.name!);
          if (sym) {
            await openSymbol(sym);
          } else {
            vscode.window.showInformationMessage(`YOLO: no symbol found for '${payload.name}'.`);
          }
          break;
        }
        case "member": {
          const sym = await resolveMember(payload.className!, payload.member!);
          if (sym) {
            await openSymbol(sym);
          } else {
            vscode.window.showInformationMessage(
              `YOLO: no member '${payload.member}' found for '${payload.className}'.`
            );
          }
          break;
        }
      }
    } catch (e) {
      vscode.window.showErrorMessage(`YOLO navigation failed: ${String(e)}`);
    }
  }

}
