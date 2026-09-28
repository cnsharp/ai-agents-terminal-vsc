// Agent detection: can the command actually be executed?
//
// Detection resolves commands via the FILESYSTEM (not by spawning a login
// shell per agent). The old approach ran `execSync("$SHELL -lc 'command -v …'")`
// once per agent — serially, on the extension-host thread — which on a slow
// machine (and on Windows) meant dozens of blocking shell spawns and a
// multi-second freeze.
//
// The filesystem scan below looks in well-known install dirs
// (nvm/fnm/Homebrew/volta/.local/.codebuddy) plus the current process PATH
// using `fs.statSync`. That is near-instant, shell/profile-independent (so a
// GUI-launched VS Code — which starts with a minimal PATH — still finds agents
// installed under nvm/fnm/brew), and never blocks the host.
//
// This file is shared verbatim between the two product branches; keep it
// identical on both sides. There is no product-specific logic here.

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

/**
 * Candidate bin directories where AI-agent CLIs are commonly installed,
 * resolved via the filesystem (not the shell) so detection does NOT depend on
 * the user's shell having loaded them onto PATH. A GUI-launched VS Code
 * (Dock/Spotlight) starts the extension host with a minimal environment, and
 * its spawned login shell often does NOT read the rc files that inject
 * nvm/fnm/brew/npm-global — which is why shell-based probing missed agents.
 */
/** Best-effort resolution of the npm global bin directory (`npm prefix -g`/bin).
 *  Agents installed via `npm i -g …` (e.g. codebuddy, pi, opencode) land here.
 *  Many users add this dir to PATH only inside their shell rc, which a GUI-
 *  launched VS Code login-shell probe does NOT source — so resolve it directly.
 *  Cached + best-effort: if `npm` is unavailable we simply don't add it. */
function npmGlobalBinDir(): string | undefined {
  try {
    const prefix = execFileSync("npm", ["prefix", "-g"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(/\r?\n.*$/, ""); // keep only the first line
    if (!prefix) return undefined;
    return path.join(prefix, "bin");
  } catch {
    return undefined;
  }
}

function candidateBinDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [
    "/opt/homebrew/bin", // Apple-Silicon Homebrew
    "/usr/local/bin", // Intel Homebrew / manual installs
    path.join(home, ".local", "bin"),
    path.join(home, ".codebuddy", "bin"),
    path.join(home, ".npm-global", "bin"), // default npm global prefix
    path.join(home, ".volta", "bin"),
  ];

  // Resolve the actual npm global bin dir (covers custom `npm prefix -g`).
  const npmBin = npmGlobalBinDir();
  if (npmBin) dirs.push(npmBin);

  // nvm: pick the latest installed node version's bin.
  const nvmBase = path.join(home, ".nvm", "versions", "node");
  try {
    const vers = fs
      .readdirSync(nvmBase)
      .filter((n) => /^v?\d/.test(n))
      .sort()
      .reverse();
    if (vers.length) dirs.push(path.join(nvmBase, vers[0], "bin"));
  } catch {
    /* no nvm */
  }

  // fnm: each version lives under <root>/<version>/installation/bin.
  const fnmBase = path.join(home, ".fnm", "node-versions");
  try {
    for (const v of fs.readdirSync(fnmBase).filter((n) => /^v?\d/.test(n))) {
      dirs.push(path.join(fnmBase, v, "installation", "bin"));
    }
  } catch {
    /* no fnm */
  }

  // Keep only directories that actually exist (avoids polluting the search).
  return dirs.filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

/** The single source of truth for where agents may live: the well-known
 *  install dirs (nvm/fnm/Homebrew/volta/…), the standard system bindirs, the
 *  login-shell PATH, and the current process PATH. Both detection
 *  (`findExecutablePath`) and the launched terminal's PATH (`boostedPath`) derive
 *  from this list, so they can never drift apart. De-duplicated,
 *  order-preserving.
 *
 *  Memoized: PATH does not change within an extension-host session, and this
 *  list is read once per `findExecutablePath` call. Computing it once avoids
 *  repeating the `readdirSync` probes on nvm/fnm on every agent, and — crucially
 *  — avoids re-running the login-shell spawn on every agent. */
let searchDirsCache: string[] | undefined;
export function searchDirs(): string[] {
  if (searchDirsCache) {
    return searchDirsCache;
  }
  const raw = [
    ...candidateBinDirs(),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...loginShellPathDirs(),
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of raw) {
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  searchDirsCache = out;
  return out;
}

/**
 * Capture the login shell's PATH ONCE (cached, best-effort, timeout-bounded).
 *
 * A GUI-launched VS Code (Dock/Spotlight) starts the extension host with a
 * minimal environment: `process.env.PATH` lacks the dirs your shell rc injects
 * (e.g. `~/.qoder/entry`, nvm/fnm versions, custom tool bins). The fixed
 * candidate dirs above cover the common managers, but not arbitrary rc-added
 * entries — so agents installed there were missed ("No agents detected").
 *
 * We ask the user's LOGIN shell for its PATH a SINGLE time and fold those dirs
 * into the search. This is one spawn at startup (cached for the session), NOT
 * a per-agent shell spawn, so it does not reintroduce a slow startup. On
 * Windows this is a no-op (PATH comes from the process env), and any failure is
 * swallowed — detection still works via the candidate dirs + process PATH.
 */
let loginPathCache: string[] | undefined;

function loginShellPathDirs(): string[] {
  if (loginPathCache) {
    return loginPathCache;
  }
  loginPathCache = [];
  if (process.platform === "win32") {
    return loginPathCache;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = execFileSync(shell, ["-lc", 'printf "%s" "$PATH"'], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    loginPathCache = out
      .split(path.delimiter)
      .map((d) => d.trim())
      .filter(Boolean);
  } catch {
    // Swallow: detection still works via the candidate dirs + process PATH.
  }
  return loginPathCache;
}

/** Find the absolute path of an installed agent command, or undefined. */
export function findExecutablePath(command: string): string | undefined {
  const cmd = command.trim();
  if (cmd.length === 0) {
    return undefined;
  }
  const exts =
    process.platform === "win32"
      ? [".exe", ".cmd", ".bat", ".ps1", ""]
      : [""];

  for (const dir of searchDirs()) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        // On POSIX the file must be executable.
        if (process.platform !== "win32" && (st.mode & 0o111) === 0) continue;
        return full;
      } catch {
        /* not in this dir */
      }
    }
  }
  return undefined;
}

/**
 * The `PATH` string for the launched terminal, derived from `searchDirs()` so it
 * is exactly the dirs we detect against. This ensures (a) the agent's own
 * `#!/usr/bin/env node` shebang resolves node, and (b) the agent's tooling is on
 * PATH. Without it, a GUI-launched VS Code terminal has a minimal PATH and the
 * launched agent can't find node / its dependencies.
 */
export function boostedPath(): string {
  return searchDirs().join(path.delimiter);
}

// Detection results are cached for the lifetime of the extension host. The same
// command is probed repeatedly across agent-list renders and picker/settings
// filters, so caching keeps repeated loads near-instant and stops a slow machine
// from re-scanning on every request.
const cache = new Map<string, string | undefined>();

function cachedResolve(command: string): string | undefined {
  if (cache.has(command)) {
    return cache.get(command);
  }
  const result = findExecutablePath(command);
  cache.set(command, result);
  return result;
}

/** Resolve the command's absolute path (for display). Returns undefined if not found. */
export function resolvePath(command: string): string | undefined {
  return cachedResolve(command);
}

/** Whether the command can actually be executed — resolvable to an executable file. */
export function canExecute(command: string): boolean {
  return cachedResolve(command) !== undefined;
}

/** Alias of `canExecute`, kept so both product branches can use their preferred name. */
export function isInstalled(command: string): boolean {
  return canExecute(command);
}
