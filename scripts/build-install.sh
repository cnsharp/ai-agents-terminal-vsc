#!/usr/bin/env bash
#
# Build this extension, package it into dist/, then install the .vsix that THIS
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
# node/npm (official installer, Homebrew, nvm) may be missing here.
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
for nvmBin in "$HOME"/.nvm/versions/node/*/bin; do
  if [ -d "$nvmBin" ]; then PATH="$nvmBin:$PATH"; fi
done
command -v npm >/dev/null 2>&1 || { echo "error: npm not found on PATH" >&2; exit 1; }
command -v code >/dev/null 2>&1 || {
  echo "error: 'code' CLI not found. Run 'Shell Command: Install \"code\" command in PATH' first." >&2
  exit 1
}

echo "==> build"
npm run build

echo "==> package"
marker="$(mktemp)"
npx vsce package --allow-missing-repository --out dist/
vsix="$(find "$REPO_ROOT/dist" -maxdepth 1 -name '*.vsix' -newer "$marker" -exec ls -t {} + 2>/dev/null | head -n 1 || true)"
rm -f "$marker"

if [ -z "$vsix" ]; then
  echo "error: packaging produced no .vsix under dist/" >&2
  exit 1
fi

echo "==> install $(basename "$vsix")"
code --install-extension "$vsix" --force
echo "==> done. Reload open VS Code windows to activate the new build."
