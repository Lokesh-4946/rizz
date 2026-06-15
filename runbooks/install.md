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

### OpenAI-compatible providers (OpenAI / OpenRouter / Ollama / custom)

One OpenAI-compatible adapter covers any endpoint that speaks the Chat Completions wire — they differ
only by **base URL** and which key they need (D-044). rizz picks the adapter by the model's `provider`
(the provider-factory); the agent loop is unchanged.

**The key comes from `<PROVIDER>_API_KEY`** (the same env-or-keychain path as Anthropic): the keychain
account is the provider id, so no key is ever stored in the registry — only referenced.

| Provider     | Model `provider` | Base URL                          | Key env var          |
| ------------ | ---------------- | --------------------------------- | -------------------- |
| OpenAI       | `openai`         | `https://api.openai.com/v1` (def) | `OPENAI_API_KEY`     |
| OpenRouter   | `openrouter`     | `https://openrouter.ai/api/v1`    | `OPENROUTER_API_KEY` |
| Ollama       | `ollama`         | `http://localhost:11434/v1`       | _(keyless — local)_  |
| Custom       | any id, e.g. `mycorp` | your endpoint's `…/v1`       | `MYCORP_API_KEY`     |

OpenAI ships in the built-in registry, so a key is all you need:

```sh
export OPENAI_API_KEY=sk-...
rizz                          # then: /model → pick "GPT-4o" / "GPT-4o mini"
```

**OpenRouter, Ollama, and custom endpoints** are added to the **on-disk registry** at
`~/.rizz/models.json` (it merges over the built-ins). Keep keys out of this file — reference the
provider only; the key is read from the env var or keychain at launch:

```jsonc
{
  "models": [
    {
      "id": "meta-llama/llama-3.1-8b-instruct",   // sent verbatim as the model name
      "provider": "openrouter",
      "label": "Llama 3.1 8B (OpenRouter)",
      "capabilities": ["code"],
      "contextWindow": 131072,
      "priceInputPerM": 0.05, "priceOutputPerM": 0.05,
      "latencyHint": "fast", "toolCapable": true,
      "baseUrl": "https://openrouter.ai/api/v1"
    },
    {
      "id": "llama3.1",
      "provider": "ollama",
      "label": "Llama 3.1 (Ollama, local)",
      "capabilities": ["code"],
      "contextWindow": 131072,
      "priceInputPerM": 0, "priceOutputPerM": 0,
      "latencyHint": "medium", "toolCapable": true,
      "baseUrl": "http://localhost:11434/v1",
      "keyless": true
    }
  ]
}
```

```sh
export OPENROUTER_API_KEY=sk-or-...   # not needed for the keyless Ollama entry
rizz                                  # then: /model → pick the OpenRouter or Ollama entry
# or pin it for one launch:  rizz --model llama3.1
```

A **custom** OpenAI-compatible endpoint is the same recipe: invent a `provider` id (e.g. `mycorp`),
set its `baseUrl`, and rizz reads `MYCORP_API_KEY`. The on-disk registry is validated and must stay
**secrets-free** — a file containing a key-like field is rejected with a notice (D-023).
