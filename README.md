# rizz

> The lightest, most connectable coding agent harness. Single-agent and local-first by default;
> bigger workspace power stays opt-in.

rizz is a tiny coding-agent CLI for one user and one project: choose a model route, launch the TUI,
approve risky actions, see status/cost, and keep the default path lightweight.

## Private Alpha Status

Agent Light is the current private alpha surface:

- local CLI and TUI
- `rizz setup` dependency doctor and provider route picker
- OpenRouter BYOK as the primary fast route
- Codex subscription route as a secondary local Codex CLI route
- OpenAI/Anthropic route placeholders for later setup wiring
- visible `/status`, `/model`, `/theme`, `/workspace`, and `/help`
- no Workspace Mode, Repo Brain, OS connectors, custom skills, enterprise providers, or public npm release in the default install

The latest merged alpha baseline is `develop` at `ece8b48`.

## Requirements

- Node >= 22
- pnpm 11+
- git
- macOS Keychain or Linux `secret-tool` for keychain storage when available

CI currently runs on Node 24.

## Install From This Checkout

```sh
cd /Users/lokesh/Downloads/rizz
pnpm install
pnpm link:local
rizz --help
```

`pnpm link:local` builds the workspace and installs a tiny local shim at `~/.local/bin/rizz` that
points at this checkout.

If `~/.local/bin` is not on your PATH:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## Setup

Run the read-only readiness check first:

```sh
rizz setup --dry-run
```

Then choose a model route:

```sh
rizz setup
```

Recommended private alpha route:

1. Choose `OpenRouter direct` or press Enter when it is the default.
2. Paste an OpenRouter API key only into the hidden prompt.
3. rizz stores the key under the provider account `openrouter`.
4. rizz launches the TUI with OpenRouter GPT-4o mini.

Never paste provider keys into chat, GitHub issues, screenshots, shell history, or logs.

## Start rizz

After setup:

```sh
rizz
```

Useful commands inside the TUI:

```text
/status
/model
/theme
/workspace
/help
```

`/workspace` is visible but not connected in Agent Light. Workspace Mode is an opt-in future track,
not part of the default alpha path.

## Codex Route

The Codex subscription route uses the local signed-in Codex CLI/app when available. rizz does not
read Codex tokens directly.

If setup says Codex is installed but not signed in, open Codex, sign in, and rerun:

```sh
rizz setup
```

Codex manages its own model for this route. Use OpenRouter direct when you need selectable BYOK
models in this alpha.

## Verification

Run the full local gate:

```sh
pnpm check
```

This runs lint, type-check, tests, eval smoke, install smoke, and the footprint budget.

Current merged-develop verification:

- Biome: 94 files
- Vitest: 29 files / 272 tests
- eval: 6/6 CLI process smokes
- install-local: 5/5 shim smokes
- footprint: 50ms cold start / 200KB core

## Known Limits

- private checkout install only; no public npm/Homebrew release yet
- no Workspace Mode in default install
- no Repo Brain, Company Brain, memory indexing, OS/Jarvis connectors, or custom skills yet
- OpenAI direct and Anthropic direct setup entries are listed but do not collect first-run credentials yet
- OpenRouter setup validates key shape before launch; the first real model turn is the live provider proof
- Codex route depends on local Codex CLI/app auth and is not the fast persistent Codex bridge
- `/plan` is not a full planning mode yet
- TUI branch display currently uses a simple `dev` label

## Project Layout

```text
packages/
  core/        loop, budget, compression, fallback
  providers/   provider adapters, model registry, secrets, tool runtime
  tui/         terminal UI
  cli/         rizz entrypoint and setup
eval/          CLI/eval smoke suite
runbooks/      operational docs
scripts/       install and footprint scripts
```

## Development

```sh
pnpm install
pnpm check
```

House style and architecture rules live in `AGENTS.md`.
