// Shell resolution for agent launch + agent detection. Centralises the "which shell do we run the
// agent in" decision so `spawnAgent` (terminalProvider) and `resolvePath`/`canExecute` (agentDetector)
// agree, including on Windows where the default `cmd.exe` breaks POSIX-shell agents.
//
// On Unix we keep the login-shell trick (`$SHELL -lc`) that honours rc-defined PATH (nvm, fnm, npm
// global bin, …) which a GUI editor doesn't inherit. On Windows the default is `cmd /c`, but we
// auto-detect a POSIX shell (Git Bash / WSL) and prefer it when an agent uses POSIX-style flags.

import * as fs from "fs";
import * as os from "os";
import * as settings from "../settings/settings";

export interface ShellSpec {
  shell: string;
  args: string[];
}

/** Best-effort POSIX shell on Windows before falling back to `cmd.exe`. */
export function detectWindowsShell(): string {
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    `${os.homedir()}\\scoop\\apps\\git\\current\\bin\\bash.exe`,
    "wsl.exe",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        return c;
      }
    } catch {
      /* ignore */
    }
  }
  return "cmd.exe";
}

/** Whether a shell path is a POSIX shell (vs. cmd / PowerShell). */
function isPosixShell(shell: string): boolean {
  const base = shell.toLowerCase();
  return /(bash|zsh|sh|wsl|fish)$/.test(base);
}

/** Whether a shell path is PowerShell (vs. cmd / POSIX). */
function isPowerShell(shell: string): boolean {
  return /(pwsh|powershell)/i.test(shell);
}

/**
 * Choose the shell + argv prefix to run a full agent command line.
 * @param fullCommand the already-joined `command args` string
 * @param preferPosix force a POSIX shell when true (used on Windows for agents with `--flag` style args)
 * @param interactive when true (PTY path) use `-i` so rc-defined PATH + interactive behaviour applies;
 *   when false (piped fallback) omit `-i` to avoid interactive-rc noise on a pipe.
 */
export function resolveLaunchShell(
  fullCommand: string,
  preferPosix: boolean,
  interactive = true
): ShellSpec {
  const configured = settings.getShell();
  const extraArgs = settings.getShellArgs();
  if (process.platform === "win32") {
    const s = configured || (preferPosix ? detectWindowsShell() : "cmd.exe");
    if (isPosixShell(s)) {
      return { shell: s, args: ["-lic", fullCommand] };
    }
    if (isPowerShell(s)) {
      return { shell: s, args: ["-NoProfile", "-Command", fullCommand] };
    }
    return { shell: s, args: ["/c", fullCommand] };
  }
  const s = configured || process.env.SHELL || "/bin/bash";
  return { shell: s, args: [...extraArgs, interactive ? "-lic" : "-lc", fullCommand] };
}

/**
 * Choose the shell + argv prefix for a PATH probe (`command -v` / `where`). Reuses the configured
 * shell so a custom POSIX shell on Windows is honoured in detection too.
 */
export function resolveProbeShell(): ShellSpec {
  const configured = settings.getShell();
  if (process.platform === "win32") {
    const s = configured || detectWindowsShell();
    if (isPosixShell(s)) {
      return { shell: s, args: ["-lic"] };
    }
    return { shell: s, args: ["/c"] };
  }
  const s = configured || process.env.SHELL || "/bin/bash";
  // `-lc` (login, non-interactive): honours rc PATH without hanging when spawned without a tty.
  return { shell: s, args: ["-lc"] };
}
