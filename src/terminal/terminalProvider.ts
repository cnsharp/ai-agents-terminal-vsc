// Ported concept from IntelliJ: YoloToolWindowFactory (PtyProcessBuilder launch) + YoloJediTermWidget.
// The IntelliJ plugin embedded a JediTerm/PTY4J terminal; the VS Code port runs the agent in a real
// PTY. Two backends are supported:
//   - "embedded":       a node-pty process whose I/O is piped into the webview's xterm.js (the original
//                       design). Works whenever node-pty can spawn a PTY on the host OS.
//   - "vscode-terminal": a fallback used only when node-pty can't spawn a PTY (e.g. its prebuilt
//                       spawn-helper was extracted without the executable bit, so the OS rejects the
//                       posix_spawnp with "posix_spawnp failed"). When that happens the agent is launched
//                       in a real VS Code integrated terminal — which has a working PTY — and revealed so
//                       the user interacts there directly. (Output can't be mirrored back into the webview
//                       without a proposed/blocked API, so the embedded terminal is unused in this mode.)

import * as pty from "node-pty";
import * as os from "os";
import * as vscode from "vscode";
import { resolveLaunchShell } from "./shell";

export type SpawnBackend = "embedded" | "vscode-terminal";

export interface SpawnOptions {
  /** The agent binary, e.g. "claude". */
  command: string;
  /** Base args + injected skip-permission flag. */
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /**
   * On Windows, force a POSIX shell (Git Bash / WSL) for agents whose launch flag is POSIX-style
   * (e.g. `--dangerously-skip-permissions`). Ignored on Unix.
   */
  preferPosix?: boolean;
}

export interface YoloPty {
  onData(cb: (data: string) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface SpawnResult {
  pty: YoloPty;
  backend: SpawnBackend;
}

/**
 * Spawn the agent inside a shell so rc-defined PATH (nvm, fnm, npm global bin, …) — which a GUI editor
 * does not inherit — is honoured, exactly like the original IntelliJ launch path. The shell choice is
 * centralised in `resolveLaunchShell` (configurable via `yolo.shell`, with Windows auto-detection).
 */
export function spawnAgent(opts: SpawnOptions): SpawnResult {
  const fullCommand = [opts.command, ...opts.args].join(" ");
  const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
  // Tell the child it has 24-bit truecolor so TUIs (e.g. Claude Code's coral banner) render in their
  // real colors instead of collapsing to the nearest 8-color basic (red). `name` sets TERM inside the
  // PTY; xterm.js itself renders truecolor fine, so this only affects what the agent detects.
  if (!env.COLORTERM) {
    env.COLORTERM = "truecolor";
  }
  const { shell, args } = resolveLaunchShell(fullCommand, Boolean(opts.preferPosix), true);

  try {
    const ptyProcess = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 30,
      cwd: opts.cwd,
      env,
    });

    return {
      backend: "embedded",
      pty: {
        onData: (cb) => ptyProcess.onData(cb),
        write: (d) => ptyProcess.write(d),
        resize: (c, r) => {
          try {
            ptyProcess.resize(c, r);
          } catch {
            /* terminal may not be ready */
          }
        },
        kill: () => {
          try {
            ptyProcess.kill();
          } catch {
            /* already gone */
          }
        },
      },
    };
  } catch {
    // node-pty couldn't spawn a PTY here (typically `posix_spawnp failed` because its prebuilt
    // spawn-helper lacks the executable bit — see scripts/ensure-node-pty-exec.cjs). Delegate to
    // VS Code's own terminal, which has a working PTY, and reveal it so the user interacts there
    // directly. The login+interactive (`-lic`) path is kept so rc-defined PATH (nvm/fnm/npm global
    // bin) is honoured, exactly like the node-pty route.
    const fb = resolveLaunchShell(fullCommand, Boolean(opts.preferPosix), true);
    let terminal: vscode.Terminal;
    try {
      terminal = vscode.window.createTerminal({
        name: `YOLO: ${opts.command}`,
        shellPath: fb.shell,
        shellArgs: fb.args,
        cwd: opts.cwd,
        env,
      });
    } catch (e) {
      throw new Error(
        `YOLO: could not start a terminal to run '${opts.command}' (${e instanceof Error ? e.message : e}).`
      );
    }
    terminal.show();
    return {
      backend: "vscode-terminal",
      pty: {
        // VS Code terminal output isn't mirrored into the webview in this VS Code build, so there's no
        // data to forward. The embedded terminal shows a notice instead.
        onData: () => {
          /* no-op in vscode-terminal backend */
        },
        // Raw keystrokes are forwarded verbatim if the webview ever sends them; the user normally types
        // directly in the revealed VS Code terminal.
        write: (d) => {
          try {
            terminal.sendText(d);
          } catch {
            /* terminal gone */
          }
        },
        // The revealed VS Code terminal sizes itself to its panel; Terminal.resize is unavailable in
        // this VS Code build, so there's nothing to forward here.
        resize: () => {
          /* no-op: the VS Code terminal manages its own dimensions */
        },
        kill: () => {
          try {
            terminal.dispose();
          } catch {
            /* already gone */
          }
        },
      },
    };
  }
}

export function defaultCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}
