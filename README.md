# rizz

> The fastest way to understand a software system. Local-first by default; model-backed chat and
> bigger workspace power stay opt-in.

rizz is a tiny repo-understanding CLI for one project: run it in a repository, generate a
project-scoped relational brain, open a local HTML intelligence portal, and keep evidence close to
the source files.

## Public Preview Status

Agent Light is the current public preview surface:

- local CLI and TUI
- `rizz` / `rizz understand` project scan
- `rizz review` git-diff review using the local project brain
- `.rizz/brain/latest.json` structured current-state summary
- `.rizz/brain/entities/*.json` relational entity stores with stable IDs
- `.rizz/brain/flows/*.json` deterministic flow mirrors for entrypoints, steps, evidence, tests, and risks
- `.rizz/brain/graph.json` relationships with evidence and confidence
- `.rizz/research/*.json` deterministic research artifacts for coverage, confidence, evidence quality, Flow Understanding, Architecture Reasoning, and incremental understanding
- `.rizz/reports/index.html` local architecture intelligence portal
- `.rizz/reports/review.html` local risk/blast-radius review report
- `rizz setup` dependency doctor and provider route picker
- OpenRouter BYOK as the primary fast route
- Codex subscription route as a secondary local Codex CLI route
- OpenAI/Anthropic route placeholders for later setup wiring
- visible `/status`, `/model`, `/theme`, `/workspace`, and `/help`
- no workspace agents, cloud sync, custom skills, or enterprise providers in the default install

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
rizz
```

`rizz` scans the current repository and writes:

```text
.rizz/brain/latest.json
.rizz/brain/entities/
.rizz/brain/flows/
.rizz/brain/graph.json
.rizz/research/
.rizz/reports/index.html
```

For local development from this checkout:

```sh
pnpm install
pnpm link:local
```

## Understand A Repo

```sh
cd path/to/your/repo
rizz
```

Power-user aliases:

```sh
rizz understand
rizz brain
rizz report
```

Open `.rizz/reports/index.html` in your browser for the local intelligence portal. Agents and tools
should read `.rizz/brain/latest.json` first, then relevant entity files, graph relationships, and
evidence before rereading source files.

The brain is meant to be a local interoperability contract: other agents can read stable entity IDs,
relationships, evidence, sessions, handoffs, findings, and status without scraping a chat log.

By default, the scanner skips generated output, local agent operating folders, package archives,
binary media, private env files, key material, and TypeScript build-info. Add a root `.rizzignore`
when a project needs more exclusions:

```text
tmp/
*.generated.ts
```

## Explain A Target

Use explain when you need a focused, evidence-backed read path before changing code:

```sh
rizz explain packages/cli
rizz explain packages/cli/src/index.ts
rizz explain flow packages--cli--check
```

`rizz explain flow <flow-id>` reads canonical flow entities from `.rizz/brain/entities/flows.json`
and reports entrypoints, ordered steps, mapped components/files, tests, configs, risks, confidence,
unknowns, and evidence. Flow explanations are deterministic static reconstructions, not runtime
traces.

## Review A Change

Run this before asking an agent to edit more code or before merging a branch:

```sh
rizz review
```

`rizz review` reads the local brain, graph, relevant entity files, and the current git diff. If the
brain does not exist yet, it creates a lightweight brain first. The review writes:

```text
.rizz/brain/entities/reviews.json
.rizz/brain/entities/findings.json
.rizz/brain/latest.json
.rizz/reports/review.html
```

For automation:

```sh
rizz review --json
```

The review is intentionally skeptical. It reports overall risk, surgicality, blast radius, affected
flows, required tests, reviewer focus areas, and findings across correctness, regression risk,
architecture drift, hidden coupling, missing tests, security, performance, maintainability, backward
compatibility, and overengineering.

## Model Setup

Run the read-only readiness check first:

```sh
rizz doctor
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

## Start Model Chat

After setup:

```sh
rizz chat
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

This runs lint, type-check, tests, eval smoke, install smoke, and the footprint budget. Release
checks also run `pnpm pack:check` to verify public package contents.

Current merged-develop verification:

- Biome: 95 files
- Vitest: 29 files / 279 tests
- eval: 6/6 CLI process smokes
- install-local: 5/5 shim smokes
- footprint: 53ms cold start / 200KB core

## Known Limits

- Homebrew is not available yet
- no Workspace Mode in default install
- no team portal, cloud sync, browser extension, mobile app, or marketplace yet
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
