// Head-less agent install / upgrade: builds the command line for an agent's `install` spec and
// runs it without a terminal, then re-probes detection so the UI reflects the new install.
//
// Platform notes:
//   • Windows — commands run through `powershell -NoProfile -Command` (so `irm`, `winget`,
//     npm/pip all work). `shell` specs route through their `cmdWin` variant, which is written
//     for PowerShell.
//   • macOS / Linux — commands run through the user's login shell (`$SHELL -lc`) so PATH
//     injected by nvm / Homebrew / pyenv profiles is respected.
//   • `brew` is never run on Windows (Homebrew has no native Windows port); callers fall back
//     to opening the agent's site — see `installAutomatableOnPlatform`.
//   • pip is invoked as `python -m pip` on Windows: `python3` is typically absent there (only
//     the Store alias stub), while `python` is the working interpreter.

import * as vscode from "vscode";
import { execFile } from "child_process";
import type { InstallSpec } from "../agents";
import { resolveLaunchShell } from "../terminal/shell";
import { boostedPath } from "../agentDetector";

export interface RunResult {
  ok: boolean;
  /** Combined stdout+stderr (truncated to a tail — enough for an error line in the UI). */
  output: string;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}

/** Tail length kept from combined command output — the UI shows this on failure. */
const OUTPUT_TAIL = 4000;
/** Hard stop for a stuck installer (or a pager waiting on a TTY). */
const INSTALL_TIMEOUT_MS = 600_000;

/** Open a URL in the OS-registered handler (the default browser). Best-effort. */
export async function openAgentUrl(url: string): Promise<void> {
  if (!url) return;
  try {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  } catch {
    // Best-effort: a missing handler shouldn't fault the caller.
  }
}

/** Escape a single-quoted shell argument (the `replace("'", "'\\''")` idiom). */
function escapeArg(s: string): string {
  return (s ?? "").replace(/'/g, "'\\''");
}

function pipCommand(): string {
  return process.platform === "win32" ? "python -m pip" : "python3 -m pip";
}

/**
 * The full install command for a spec: the package-manager or shell one-liner. For the `url`
 * type (and unknown types) this returns the URL string, so callers should open it in the
 * browser rather than running it as a command.
 */
export function buildInstallCommand(spec: InstallSpec): string {
  switch (spec.type) {
    case "npm":
      return `npm install -g '${escapeArg(spec.pkg ?? "")}'`;
    case "pip":
      return `${pipCommand()} install '${escapeArg(spec.pkg ?? "")}'`;
    case "brew":
      return `brew install '${escapeArg(spec.pkg ?? "")}'`;
    case "shell":
      return process.platform === "win32" && spec.cmdWin ? spec.cmdWin : (spec.cmd ?? "");
    default:
      return spec.url ?? "";
  }
}

/**
 * Mutating upgrade command. For `shell` agents that declare `updateCmd`, run that (the agent's
 * own self-update subcommand, e.g. `claude update`); otherwise fall back to re-running the
 * installer, which also fetches the latest version. For `url` type this returns the URL
 * (callers open the site instead of running a command).
 */
export function buildUpdateCommand(spec: InstallSpec): string {
  switch (spec.type) {
    case "npm":
      return `npm install -g '${escapeArg(spec.pkg ?? "")}'`;
    case "pip":
      return `${pipCommand()} install --upgrade '${escapeArg(spec.pkg ?? "")}'`;
    case "brew":
      return `brew upgrade '${escapeArg(spec.pkg ?? "")}'`;
    case "shell":
      if (spec.updateCmd) return spec.updateCmd;
      return process.platform === "win32" && spec.cmdWin ? spec.cmdWin : (spec.cmd ?? "");
    default:
      return spec.url ?? "";
  }
}

/**
 * Run a shell command head-less and capture its combined output. `ok` is true only when the
 * process exited 0. The timeout stops a stuck installer (or a pager triggered by `--version`)
 * from hanging the caller; PAGER is forced to `cat` so a pager never blocks waiting on a TTY.
 * PATH comes from `boostedPath()` — a GUI-launched VS Code starts with a minimal PATH, so
 * npm/pip/brew and the agents they install would otherwise not resolve.
 */
export function runHeadless(command: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<RunResult> {
  if (!command || !command.trim()) {
    return Promise.resolve({ ok: false, output: "", error: "empty command" });
  }

  let shell: string;
  let args: string[];
  if (process.platform === "win32") {
    shell = "powershell";
    // PowerShell parses its own -Command string; backtick-escape any literal double quote.
    args = ["-NoProfile", "-Command", command.replace(/"/g, "`\"")];
  } else {
    const spec = resolveLaunchShell(command, false, false);
    shell = spec.shell;
    args = spec.args;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: boostedPath(),
    PAGER: "cat",
    GIT_PAGER: "cat",
  };

  return new Promise<RunResult>((resolve) => {
    execFile(
      shell,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env, windowsHide: true },
      (err, stdout, stderr) => {
        const combined = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        if (err) {
          const killed = "killed" in err && (err as { killed?: boolean }).killed === true;
          resolve({
            ok: false,
            output: combined.slice(-OUTPUT_TAIL),
            error: killed ? "timed out" : err.message,
          });
          return;
        }
        resolve({ ok: true, output: combined.slice(-OUTPUT_TAIL) });
      }
    );
  });
}
