// YOLO webview view provider: owns the embedded PTY and bridges I/O + navigation messages to/from the
// webview. Implements vscode.WebviewViewProvider so the panel docks in the activity bar (the IntelliJ
// "tool window" equivalent) and persists while hidden.

import * as vscode from "vscode";
import { spawnAgent, defaultCwd, type YoloPty, type SpawnBackend } from "./terminalProvider";
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

interface AgentOption {
  id: string;
  displayName: string;
  command: string;
  /** Absolute path the agent resolves to (or undefined if not found on PATH). */
  resolvedPath?: string;
  /** Webview-resolved icon URI (or undefined if the view isn't ready yet). */
  iconUri?: string;
}

export class YoloViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "yolo.panel";
  private pty: YoloPty | undefined;
  private view: vscode.WebviewView | undefined;

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
    view.onDidDispose(() => this.disposePty());
    // Push the initial state immediately (do not wait for the webview's `ready` round-trip — that
    // handshake can be lost on fast reloads, leaving the agent list empty). The webview also re-requests
    // via `ready`, which re-sends this, so a double delivery is harmless.
    this.sendInit();
  }

  public reveal(): void {
    // Focus the docked view (creates it on first use).
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
      cwd: defaultCwd(),
    });
  }

  private onMessage(msg: any): void {
    switch (msg?.type) {
      case "ready":
        this.sendInit();
        break;
      case "input":
        this.pty?.write(msg.data);
        break;
      case "resize":
        this.pty?.resize(msg.cols, msg.rows);
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
      case "navigate":
        void this.navigate(msg.payload as LinkPayload);
        break;
      case "hover":
        void this.hover(msg as { reqId: number; payload: LinkPayload });
        break;
    }
  }

  /** Resolve a link to hover-preview text and send it back to the webview. */
  private async hover(msg: { reqId: number; payload: LinkPayload }): Promise<void> {
    const text = await describeLink(msg.payload);
    this.view?.webview.postMessage({ type: "hoverResult", reqId: msg.reqId, text });
  }

  private launch(msg: { agentId: string; skip: boolean; resume?: boolean; baseArgs?: string }): void {
    this.disposePty();
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
    const args: string[] = [...(def.baseArgs ?? [])];
    const env: Record<string, string> = {};
    const extraBase = settings.getAgentBaseArgs()[def.id.toLowerCase()] ?? msg.baseArgs ?? "";
    if (extraBase.trim().length > 0) {
      args.push(...extraBase.trim().split(/\s+/));
    }
    // YOLO (skip-permissions) flag: a manual `yolo.permissionRules` entry (by command or id) overrides
    // the catalog's `yoloArgs`. Whether the flag is POSIX-style decides if we prefer a POSIX shell on
    // Windows (so the flag isn't handed to cmd.exe).
    let posixIndicator = "";
    if (msg.skip) {
      const rule = settings
        .getPermissionRules()
        .find((r) => r.agentId === def.command || r.agentId === def.id);
      const flag = rule?.flag ?? (def.yoloArgs ? def.yoloArgs.join(" ") : "");
      if (flag) {
        args.push(...flag.trim().split(/\s+/));
        posixIndicator = flag;
      }
    }
    // Resume flag: continue the most recent session for this agent. Appended last so it sits on top
    // of base + YOLO args.
    if (msg.resume && def.resumeFlag) {
      args.push(...def.resumeFlag.split(/\s+/).filter(Boolean));
    }
    const preferPosix = process.platform === "win32" && posixIndicator.trim().startsWith("-");

    let backend: SpawnBackend;
    try {
      const result = spawnAgent({ command: def.command, args, cwd: defaultCwd(), env, preferPosix });
      this.pty = result.pty;
      backend = result.backend;
    } catch (e) {
      vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    this.pty.onData((data) => {
      this.view?.webview.postMessage({ type: "data", data });
    });
    this.view?.webview.postMessage({ type: "spawned", command: def.command, backend });
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

  private disposePty(): void {
    this.pty?.kill();
    this.pty = undefined;
  }
}
