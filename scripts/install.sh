#!/usr/bin/env bash
# One-command install for rizz (M2). Builds the monorepo and puts `rizz` on your PATH.
#
#   curl -fsSL .../install.sh | bash      # (once published)
#   ./scripts/install.sh                  # from a checkout
#
# Lightweight by design: no global npm package yet (repo is private during the build), so this
# builds locally and symlinks the CLI. Re-run any time to update.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "› installing dependencies…"
pnpm install --frozen-lockfile

echo "› building…"
pnpm build

# Link the cli's bin into ~/.local/bin (usually on PATH). If it isn't on PATH, we print a note below.
BIN_SRC="$ROOT/packages/cli/dist/index.js"
chmod +x "$BIN_SRC"

TARGET_DIR="$HOME/.local/bin"
mkdir -p "$TARGET_DIR"
ln -sf "$BIN_SRC" "$TARGET_DIR/rizz"

echo "✓ installed: $TARGET_DIR/rizz -> $BIN_SRC"
if ! command -v rizz >/dev/null 2>&1; then
  echo "  note: add $TARGET_DIR to your PATH, then run: rizz"
else
  echo "  run: rizz"
fi
