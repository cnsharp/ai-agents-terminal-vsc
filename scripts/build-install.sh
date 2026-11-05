#!/usr/bin/env bash
#
# Compile this extension, package it into dist/, then install the .vsix that THIS
# run produced into VS Code. Lives inside the project so it travels with the repo.
#
# The project root is derived from the script's own location (not from $PWD), so it
# works no matter which directory the terminal was opened in. The .vsix name is
# never hardcoded: a timestamp marker is taken before packaging and the newest
# .vsix newer than it is installed, so version bumps and repeated runs both work.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
echo "==> project: $REPO_ROOT"

# A terminal launched from VS Code does not inherit the login shell's PATH, so
# seed the common install locations first. When nvm is available, explicitly
# select Node 22 (nvm is a shell function, so it must be sourced here). This is
# important: prepending every nvm version used to let an old Node (e.g. v8) win
# over v22 and break the build with a cryptic tsc SyntaxError. If nvm is not
# installed, fall back to whatever node/npm is already on PATH.
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
if [ -s "$NVM_SH" ]; then
  # shellcheck disable=SC1090
  . "$NVM_SH"
  nvm use 22 >/dev/null || { echo "error: nvm has no Node 22 installed. Run: nvm install 22" >&2; exit 1; }
fi
command -v npm >/dev/null 2>&1 || { echo "error: npm not found on PATH" >&2; exit 1; }
echo "==> node $(node -v), npm $(npm -v)"
command -v code >/dev/null 2>&1 || {
  echo "error: 'code' CLI not found. Run 'Shell Command: Install \"code\" command in PATH' first." >&2
  exit 1
}

echo "==> compile"
npm run compile

echo "==> package"
marker="$(mktemp)"
npx @vscode/vsce package --allow-missing-repository --out dist/
vsix="$(find "$REPO_ROOT/dist" -maxdepth 1 -name '*.vsix' -newer "$marker" -exec ls -t {} + 2>/dev/null | head -n 1 || true)"
rm -f "$marker"

if [ -z "$vsix" ]; then
  echo "error: packaging produced no .vsix under dist/" >&2
  exit 1
fi

echo "==> install $(basename "$vsix")"
code --install-extension "$vsix" --force
echo "==> done. Reload open VS Code windows to activate the new build."
