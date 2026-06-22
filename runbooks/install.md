# Install rizz for Private Alpha

This runbook is for local dogfooding from the repo checkout. Public npm/Homebrew installers are not
part of the private alpha.

## Requirements

- Node >= 22
- pnpm 11+
- git
- a real terminal for interactive setup
- OpenRouter API key for the recommended fast route

## Local Install

```sh
cd /Users/lokesh/Downloads/rizz
pnpm install
pnpm link:local
```

`pnpm link:local` runs:

```sh
pnpm build
node scripts/install-local.mjs
```

The installer writes a small shim:

```text
~/.local/bin/rizz -> /Users/lokesh/Downloads/rizz/packages/cli/dist/index.js
```

If needed, add `~/.local/bin` to your PATH:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## Verify The Install

```sh
rizz --version
rizz --help
rizz setup --dry-run
```

`rizz setup --dry-run` is read-only. It does not connect providers, install packages, mutate shell
profiles, or write credentials.

## First Setup

```sh
rizz setup
```

Expected flow:

1. Dependency doctor checks Node, pnpm/corepack, git, `~/.rizz`, terminal, and keychain helper.
2. rizz asks what it should call you.
3. rizz shows model routes.
4. Choose `OpenRouter direct` for the private alpha fast path.
5. Paste the OpenRouter API key only into the hidden prompt.
6. rizz starts the TUI with OpenRouter GPT-4o mini.

Do not paste provider keys into chat, GitHub, screenshots, shell history, or logs.

## Start After Setup

```sh
rizz
```

Useful TUI commands:

```text
/status
/model
/theme
/workspace
/help
```

`/workspace` is visible but not connected in Agent Light.

## Codex Route

Codex is a secondary route. It uses the local signed-in Codex CLI/app when available; rizz does not
read Codex tokens directly.

If setup says Codex is installed but not signed in:

1. Open Codex.
2. Sign in.
3. Rerun `rizz setup`.

Codex manages its own model for this route. Use OpenRouter direct when you need the private alpha
fast route and selectable BYOK models.

## Secret Storage

OpenRouter setup stores the key under provider account `openrouter` in the OS keychain where
available. If no keychain helper exists, rizz falls back to a local `0600` file under `~/.rizz`.

Secrets must never be committed, logged, pasted into chat, or written into `~/.rizz/models.json`.

## Full Local Gate

```sh
pnpm check
```

This runs:

- Biome lint
- TypeScript build
- Vitest
- CLI eval smoke
- install-local smoke
- footprint check

Latest merged-develop private alpha gate:

- `pnpm check` passed
- Vitest: 29 files / 272 tests
- eval: 6/6
- install-local: 5/5
- footprint: 50ms cold start / 200KB core

## Known Limits

- private checkout install only; no public package release yet
- OpenAI direct and Anthropic direct setup entries are not full first-run credential flows yet
- OpenRouter setup validates key shape; first real model turn proves live provider access
- Codex route depends on local Codex auth and is not the fast persistent Codex bridge
- no Workspace Mode, Repo Brain, OS/Jarvis connectors, custom skills, enterprise providers, or public npm release in Agent Light
- TUI branch display currently uses a simple `dev` label

## Remove The Local Shim

```sh
rm ~/.local/bin/rizz
```
