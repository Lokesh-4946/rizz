#!/bin/sh
set -eu

PACKAGE="${RIZZ_PACKAGE:-@valoir/rizz@0.1.0}"
EXTRA_PACKAGES="${RIZZ_EXTRA_PACKAGES:-}"
NPM_PREFIX="${RIZZ_NPM_PREFIX:-}"

say() {
  printf '%s\n' "$*"
}

fail() {
  say "rizz install: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

need node
need npm

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node >= 22 is required; found $(node --version)"
fi

set -- install -g
if [ -n "$NPM_PREFIX" ]; then
  set -- "$@" --prefix "$NPM_PREFIX"
fi

say "rizz install"
say "package: $PACKAGE"

if [ -n "$EXTRA_PACKAGES" ]; then
  # Space-separated package list for local smoke tests; normal public installs do not need this.
  # shellcheck disable=SC2086
  npm "$@" $EXTRA_PACKAGES "$PACKAGE"
else
  npm "$@" "$PACKAGE"
fi

if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/rizz" ]; then
  say ""
  "$NPM_PREFIX/bin/rizz" --version
  say "run: $NPM_PREFIX/bin/rizz setup"
  exit 0
fi

if command -v rizz >/dev/null 2>&1; then
  say ""
  rizz --version
  say "run: rizz setup"
  exit 0
fi

GLOBAL_BIN="$(npm bin -g 2>/dev/null || true)"
say ""
say "installed, but rizz is not on PATH yet."
if [ -n "$GLOBAL_BIN" ]; then
  say "Add this to PATH:"
  say "  export PATH=\"$GLOBAL_BIN:\$PATH\""
else
  say "Check your npm global bin path:"
  say "  npm bin -g"
fi
