# Install rizz (dev / dogfooding)

Until the published installers land (Homebrew / npm / curl — deferred to after `/login` connects,
D-031 step 3), use one of these to get a `rizz` command on your PATH. **Stop running**
`node packages/cli/dist/index.js` — that was a placeholder.

> rizz needs **Node ≥ 22** (CI pins Node 24) and **pnpm 11**. Build once before linking so `dist/`
> exists.

## Option A — local shim (recommended, macOS / Linux)

```sh
pnpm install
pnpm link:local        # = pnpm build && node scripts/install-local.mjs
```

This writes a tiny shim to `~/.local/bin/rizz` that execs the built CLI. If the script reports that
`~/.local/bin` isn't on your PATH, add it (then restart your shell):

```sh
export PATH="$HOME/.local/bin:$PATH"   # put this in ~/.zshrc or ~/.bashrc
```

Pick a different directory with `node scripts/install-local.mjs --dir /somewhere/on/PATH`.

The shim points at this checkout's `dist/`, so re-run `pnpm build` (or `pnpm link:local`) after you
change CLI/TUI/core code. To remove it: `rm ~/.local/bin/rizz`.

## Option B — global pnpm link (all platforms, incl. Windows)

```sh
pnpm install
pnpm build
pnpm -C packages/cli link --global
```

This registers the `@rizz/cli` package's `rizz` bin in pnpm's global bin directory. Make sure that
directory is on your PATH — `pnpm bin --global` prints it. Undo with:

```sh
pnpm -C packages/cli unlink --global
```

> Windows note: the shim in Option A is POSIX `sh`; use Option B (or run under WSL).

## Verify

```sh
rizz --version          # 0.0.0
rizz --help
echo "hello" | rizz     # print mode (demo reply until a key is connected)
rizz                    # interactive TUI (needs a real terminal/TTY)
```

## Connect a model

rizz starts in **demo mode** (no model connected). Connect a Claude model via a BYOK Anthropic API
key — either set the environment variable or use `/login` in the TUI:

```sh
export ANTHROPIC_API_KEY=sk-ant-...     # explicit, ephemeral override
# or, inside `rizz`:  /login            # paste the key once; stored in the OS keychain
```

The key is stored in the OS keychain (macOS Keychain / libsecret), falling back to a `0600` file
under `~/.rizz` where no keychain helper exists. It is never written to the repo or logs (§3.6).

> The Pro/Max **subscription** sign-in is intentionally not wired (it would route around the
> subscription's intended access path); BYOK is the supported path. See decision D-033.
