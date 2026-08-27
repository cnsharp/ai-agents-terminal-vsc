import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Whether `command` is installed: just try to actually run it.
 *
 * Mirrors the IntelliJ YOLO plugin's `AgentDetector.canExecute` version probe —
 * execute `<command> --version` and treat only an exit code of 0 as available.
 * We run it through the user's login shell (`-lc`, not `-i`: an interactive
 * shell hangs when spawned without a tty) so PATH entries injected by rc files
 * (nvm/fnm/brew/npm-global/...) are honoured. A short timeout keeps a slow or
 * network-touching CLI from stalling detection.
 */
export async function isInstalled(command: string): Promise<boolean> {
  const safe = command.replace(/'/g, "'\\''");

  if (process.platform === "win32") {
    try {
      await execAsync(`where ${safe}`, { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  const shell = process.env.SHELL || "/bin/sh";
  try {
    await execAsync(`${shell} -lc "${safe} --version"`, {
      windowsHide: true,
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}
