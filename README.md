# rizz

> The lightest, most connectable coding agent harness. Single-agent and local-first by default;
> bigger workspace power stays opt-in.

rizz is a tiny coding-agent CLI for one user and one project: choose a model route, launch the TUI,
approve risky actions, see status/cost, and keep the default path lightweight.

## Public Preview Status

Agent Light is the current public preview surface:

- local CLI and TUI
- `rizz setup` dependency doctor and provider route picker
- OpenRouter BYOK as the primary fast route
- Codex subscription route as a secondary local Codex CLI route
- OpenAI/Anthropic route placeholders for later setup wiring
- visible `/status`, `/model`, `/theme`, `/workspace`, and `/help`
- no Workspace Mode, Repo Brain, OS connectors, custom skills, or enterprise providers in the default install

The current release baseline is `0.1.0`.

## Requirements

- Node >= 22
- npm
- git
- macOS Keychain or Linux `secret-tool` for keychain storage when available

Development from source also needs pnpm 11+. CI currently runs on Node 24.

## Install

```sh
npm install -g @valoir/rizz
```

Then run:

```sh
rizz setup
rizz
```

For local development from this checkout:

```sh
pnpm install
pnpm link:local
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

Recommended public preview route:

1. Choose `OpenRouter direct` or press Enter when it is the default.
2. Paste an OpenRouter API key only into the hidden prompt.
3. rizz stores the key under the provider account `openrouter`.
4. rizz launches the TUI with OpenRouter North Mini Code (free).

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
not part of the default path.

## Codex Route

The Codex subscription route uses the local signed-in Codex CLI/app when available. rizz does not
read Codex tokens directly.

If setup says Codex is installed but not signed in, open Codex, sign in, and rerun:

```sh
rizz setup
```

Codex manages its own model for this route. Use OpenRouter direct when you need the free BYOK route
or selectable BYOK models.

## Verification

Run the full local gate:

```sh
pnpm check
```

This runs lint, type-check, tests, eval smoke, install smoke, and the footprint budget.

Current merged-develop verification:

- Biome: 94 files
- Vitest: 29 files / 273 tests
- eval: 6/6 CLI process smokes
- install-local: 5/5 shim smokes
- footprint: 53ms cold start / 200KB core

## Known Limits

- Homebrew is not available yet
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
