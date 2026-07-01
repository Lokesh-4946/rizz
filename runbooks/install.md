# Install rizz

This runbook covers public npm install and local development installs from the repo checkout.

## Requirements

- Node >= 22
- npm for public install
- pnpm 11+ and git for local development
- a real terminal for interactive setup
- OpenRouter API key for the recommended free route

## Public Install

```sh
npm install -g @valoir/rizz
rizz setup
rizz
```

The npm installer installs the public package and exposes the `rizz` command. It does not ask for
provider keys; keys are entered only in `rizz setup`.

## Local Development Install

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

1. Dependency doctor checks Node, npm, git, `~/.rizz`, terminal, and keychain helper.
2. rizz asks what it should call you.
3. rizz shows model routes.
4. Choose `OpenRouter direct` for the public preview route.
5. Paste the OpenRouter API key only into the hidden prompt.
6. rizz starts the TUI with OpenRouter North Mini Code (free).

Do not paste provider keys into chat, GitHub, screenshots, shell history, or logs.

## Start After Setup

```sh
rizz
```

`rizz` scans the current repository and writes local Project Intelligence Engine artifacts under
`.rizz/brain`, `.rizz/research`, and Mission Control at `.rizz/reports/index.html`.

Useful TUI commands:

```text
/status
/model
/theme
/workspace
/help
```

`/workspace` is visible but not connected in the public preview.

## Codex Route

Codex is a secondary route. It uses the local signed-in Codex CLI/app when available; rizz does not
read Codex tokens directly.

If setup says Codex is installed but not signed in:

1. Open Codex.
2. Sign in.
3. Rerun `rizz setup`.

Codex manages its own model for this route. Use OpenRouter direct when you need the free BYOK route
and selectable BYOK models.

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

Release-facing changes should also run:

```sh
pnpm pack:check
```

Latest merged-develop public preview gate:

- `pnpm check` passed
- Vitest: 31 files / 320 tests
- PI-Bench: 10/10 tasks
- CLI process smoke: 9/9 checks
- install-local: 5/5
- footprint: 49ms cold start / 188KB core, under the 200KB budget

## Known Limits

- Homebrew is not available yet
- OpenAI direct and Anthropic direct setup entries are not full first-run credential flows yet
- OpenRouter setup validates key shape; first real model turn proves live provider access
- Codex route depends on local Codex auth and is not the fast persistent Codex bridge
- no Workspace Mode, OS/Jarvis connectors, cloud sync, browser/mobile/IDE integrations, custom
  skills, or enterprise providers in the default install
- TUI branch display currently uses a simple `dev` label

## Remove The Local Shim

```sh
rm ~/.local/bin/rizz
```
