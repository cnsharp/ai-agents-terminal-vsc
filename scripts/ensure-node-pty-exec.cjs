// Some npm/tar extractions on macOS extract node-pty's prebuilt `spawn-helper` without the
// executable bit. node-pty launches the agent by `posix_spawnp`-ing that helper with
// POSIX_SPAWN_SETEXEC, so a non-executable helper makes the OS reject the spawn with
// "posix_spawnp failed" at runtime — which forces the extension to fall back to a real VS Code
// integrated terminal (the embedded webview terminal never starts). Re-apply +x so the embedded
// terminal works. No-op on Windows (no exec-bit concept) and when the file is absent.
const fs = require("fs");
const path = require("path");

if (process.platform === "win32") {
  process.exit(0);
}

const candidate = path.join(
  __dirname,
  "..",
  "node_modules",
  "node-pty",
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper"
);

if (fs.existsSync(candidate)) {
  try {
    fs.chmodSync(candidate, 0o755);
  } catch {
    // best effort — a permission error here shouldn't break `npm install`
  }
}
