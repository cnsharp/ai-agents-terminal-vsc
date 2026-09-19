import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Whether `command` is installed: confirm it resolves on PATH.
 *
 * We resolve the binary through the user's login shell (`-lc`, not `-i`: an
 * interactive shell hangs when spawned without a tty) so PATH entries injected
 * by rc files (nvm/fnm/brew/npm-global/...) are honoured. The probe uses
 * `command -v` (PATH resolution) rather than executing `<command> --version`:
 * some agents don't implement `--version` and would otherwise be wrongly
 * reported as missing, and PATH resolution is exactly what the launcher relies
 * on anyway. Every probe is capped at 3s so a slow or network-touching CLI (or a
 * `where` that hangs on a mapped PATH entry on Windows) can't stall detection.
 */
export async function isInstalled(command: string): Promise<boolean> {
  const safe = command.replace(/'/g, "'\\''");
  const opts = { windowsHide: true, timeout: 3000 };

  if (process.platform === "win32") {
    try {
      await execAsync(`where ${safe}`, opts);
      return true;
    } catch {
      return false;
    }
  }

  const shell = process.env.SHELL || "/bin/sh";
  try {
    await execAsync(`${shell} -lc "command -v '${safe}' >/dev/null 2>&1"`, opts);
    return true;
  } catch {
    return false;
  }
}
