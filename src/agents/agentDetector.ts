// Agent detection: can the command actually be executed?
//
// Ported to mirror ai-agents-vsc's proven `isInstalled`: run `<command> --version` (falling back to
// `command -v`) through the user's LOGIN shell with `-lc` — login so rc-defined PATH is honoured
// (nvm/fnm/brew/npm-global/… that a GUI editor doesn't inherit), but NON-interactive: an interactive
// `-i` shell hangs when spawned without a tty, which makes PATH probes silently fail. A short timeout
// keeps a slow or network-touching CLI from stalling detection.

import { execSync } from "child_process";
import * as settings from "../settings/settings";

const PROBE_TIMEOUT_MS = 5000;
const VERSION_PROBE_ARGS = ["--version", "-v", "--help", "-h"];

/** The probe shell + argv prefix. Mirrors ai-agents-vsc: `${SHELL} -lc`. */
function probeShell(): { shell: string; prefix: string } {
  const configured = settings.getShell();
  if (process.platform === "win32") {
    return { shell: configured || "cmd.exe", prefix: "" };
  }
  const shell = configured || process.env.SHELL || "/bin/bash";
  // `-lc`: login (honours rc PATH) but non-interactive (never hangs without a tty).
  return { shell, prefix: `${shell} -lc` };
}

/** Resolve the command's absolute path (for display). Returns undefined if not found. */
export function resolvePath(command: string): string | undefined {
  const cmd = command.trim();
  if (cmd.length === 0) {
    return undefined;
  }
  try {
    if (process.platform === "win32") {
      const out = execSync(`where ${cmd.replace(/"/g, "")}`, {
        encoding: "utf-8",
        timeout: PROBE_TIMEOUT_MS,
      })
        .trim()
        .split(/\r?\n/)[0]
        ?.trim();
      return out && out.length > 0 ? out : undefined;
    }
    const { prefix } = probeShell();
    const out = execSync(`${prefix} "command -v '${cmd.replace(/'/g, "'\\''")}'"`, {
      encoding: "utf-8",
      timeout: PROBE_TIMEOUT_MS,
    })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    return out && out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the command can actually be executed — PATH check first, version-probe fallback. */
export function canExecute(command: string): boolean {
  const cmd = command.trim();
  if (cmd.length === 0) {
    return false;
  }
  if (resolvePath(cmd) !== undefined) {
    return true;
  }
  return runVersionProbe(cmd);
}

function runVersionProbe(command: string): boolean {
  const safe = command.replace(/'/g, "'\\''");
  try {
    if (process.platform === "win32") {
      execSync(`where ${command.replace(/"/g, "")}`, {
        encoding: "utf-8",
        timeout: PROBE_TIMEOUT_MS,
      });
      return true;
    }
    const { prefix } = probeShell();
    for (const arg of VERSION_PROBE_ARGS) {
      try {
        execSync(`${prefix} "${safe} ${arg}"`, {
          encoding: "utf-8",
          timeout: PROBE_TIMEOUT_MS,
        });
        return true;
      } catch {
        // Try the next probe argument.
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Detect which promoted/custom agents are installed; returns their command binaries. */
export function detectInstalled(commands: string[]): string[] {
  return commands.filter((c) => canExecute(c));
}
