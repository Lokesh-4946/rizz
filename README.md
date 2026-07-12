# rizz

> The fastest way to understand a software system. Local-first by default; model-backed chat and
> bigger workspace power stay opt-in.

rizz is a local Project Intelligence Engine for one repository: run it in a repo, generate a
project-scoped relational brain, open Mission Control as a local HTML intelligence portal, and keep
evidence close to the source files.

## Current Product

The current `0.3.1` product surface is:

- `rizz prepare` isolated project intelligence under the platform user-data directory without
  changing repository files or Git status
- `rizz brief <task>` bounded, revision-stamped task context with cited claims, omissions, and
  evidence gaps
- `rizz loop ...` isolated work continuity for starts, checkpoints, verification, review,
  completion, handoffs, and next-action discovery
- `rizz vault inspect/import/reconcile` previewed migration of existing Markdown product knowledge
  into the isolated project workspace
- `rizz mcp` zero-dependency stdio MCP access to the same project, brain, product, sprint, loop,
  review, brief, explain, checkpoint, completion, and handoff contracts
- `rizz agents detect/configure/doctor` explicit user-level bridge skills for Codex, Claude Code,
  GitHub Copilot, and canonical Agent Skills consumers
- local Project Intelligence Engine CLI and opt-in TUI
- `rizz` / `rizz understand` project scan
- `rizz brain` project brain refresh
- `rizz ask` gated Project Intelligence questions answered from the local brain
- `rizz explain` evidence-backed component, file, and flow explanations
- `rizz review` git-diff review using the local project brain
- `<project-workspace>/brain/latest.json` structured current-state summary
- `<project-workspace>/brain/entities/*.json` relational entity stores with stable IDs
- `<project-workspace>/brain/flows/*.json` deterministic journey/flow mirrors for entrypoints, normalized steps, state/data dependencies, evidence, tests, configs, and risks
- `<project-workspace>/brain/graph.json` relationships with evidence and confidence
- `<project-workspace>/research/*.json` deterministic research artifacts for coverage, confidence, evidence quality, security scan, tool inventory, journey-aware Flow Understanding, Architecture Reasoning, and incremental understanding
- confidence inspection queues that point agents to weak evidence, architecture confidence debt, security/tool risk surfaces, and stale understanding before broad reuse
- `<project-workspace>/reports/index.html` Mission Control local architecture intelligence portal
- `<project-workspace>/reports/review.html` local risk/blast-radius review report with journey, state/data impact, and targeted verification planning
- `rizz setup` dependency doctor and provider route picker
- OpenRouter BYOK as the primary fast route
- Codex subscription route as a secondary local Codex CLI route
- OpenAI/Anthropic route placeholders for later setup wiring
- visible `/status`, `/model`, `/theme`, `/workspace`, and `/help`
- no workspace agents, cloud sync, browser extension, mobile app, project-local skills, or
  enterprise providers in the default path

This release is `0.3.1`.

## Requirements

- Node >= 22
- npm
- git
- macOS Keychain or Linux `secret-tool` for keychain storage when available

## Install

```sh
npm install -g @valoir/rizz
```

Then run:

```sh
rizz prepare
```

`rizz prepare` scans the current repository read-only and writes
the registry, project identity, brain, research, and reports outside the repository. Set
`RIZZ_HOME` only when automation needs an explicit external data root.

All intelligence commands use the same isolated project store, including review, ask, explain,
verification, and approval. They do not create `.rizz` or generated state in the repository.
`<project-workspace>` below means the current project directory registered under the platform Rizz
home, never a checked-in path.

If a registered repository is moved or recloned after its old path disappears, Rizz stops with
`PROJECT_RELINK_REQUIRED` instead of creating a second identity. Run `rizz project relink` to
reconnect the existing workspace. Live clones of the same remote remain separate by default.

The commands write:

```text
<project-workspace>/brain/latest.json
<project-workspace>/brain/entities/
<project-workspace>/brain/flows/
<project-workspace>/brain/graph.json
<project-workspace>/research/
<project-workspace>/reports/index.html
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

The CLI prints the external workspace path after a scan. Open
`<project-workspace>/reports/index.html` for Mission Control. Agents and tools should read
`<project-workspace>/brain/latest.json` first, then relevant entity files, graph relationships, and
evidence before rereading source files.

The brain is meant to be a local interoperability contract: other agents can read stable entity IDs,
relationships, evidence, sessions, handoffs, findings, and status without scraping a chat log.

## Brief And Engineering Loop

Compile the same deterministic task packet for any shell-capable agent:

```sh
rizz brief "Update the homepage Hero"
rizz brief "Update the homepage Hero" --json
```

Packets include the isolated project ID, current Git revision, brain timestamp, bounded relevant
claims, exact source/evidence references, omissions, and stale-evidence warnings. Uncited or
unsupported claims are not silently promoted to verified facts.

Record durable work continuity outside the repository:

```sh
rizz loop start --task "Update Hero" --agent codex --scope src/components/Hero.tsx
rizz loop checkpoint --summary "Inspected direct page importer" --sequence 1
rizz loop verify --summary "Focused tests passed" --sequence 2
rizz loop review --summary "No actionable findings" --sequence 3
rizz loop handoff --summary "Ready" --next-baton "Browser UAT" --sequence 4
rizz loop complete --summary "Merged" --sequence 5
rizz loop status --json
rizz loop next --json
```

Sequence checks reject stale writers. State and handoffs are atomic, byte-verified files under
`<project-workspace>/loop/` and `<project-workspace>/handoffs/`; Git status remains unchanged.

## Import An Existing Product Vault

Inspect and preview before copying anything:

```sh
rizz vault inspect "/path/to/vault" --json
rizz vault import "/path/to/vault" --preview --json
rizz vault import "/path/to/vault" --apply --json
rizz vault reconcile --json
```

Rizz reads the source vault without modifying it, classifies bounded Markdown documents, and reports
duplicate claims, conflicting names, stale absolute paths, and redacted secret-like findings. Apply
copies only into the isolated project workspace and creates product principles plus sprint, backlog,
and evidence-oriented work-board documents. Secret-bearing previews are blocked from apply.

The governing product principle is explicit in the generated local tracker: Rizz prevents agent
slop by requiring scoped intent, evidence-backed context, verification, review, and durable handoff
so developers can ship substantial, inspectable work.

## Govern Loop Resources

Inspect or explicitly change the isolated project policy, then acquire bounded work leases:

```sh
rizz resources status --json
rizz resources configure --max-agents 1 --context-bytes 262144 --lease-ms 1800000
rizz resources lease --work-id baton-1 --agent codex --json
rizz resources release --lease-id <lease-id> --json
```

The default remains single-agent with zero provider spend. Leases enforce concurrency and expire so
abandoned work can be reclaimed. Rizz can cache sanitized exact context by SHA-256, use compacted
tool output only while evidence remains complete, and fall back to the exact cached original when
an evidence gap appears. Per-work usage records capture bytes, estimated tokens, cache hits,
rereads, elapsed time, provider cost, and verification time outside the repository.

## Audit And Pin An Upstream Skill

Rizz never executes skill content during inspection, audit, or installation:

```sh
rizz skills inspect /path/to/checkout/skills/example --json
rizz skills audit /path/to/checkout/skills/example --json
rizz skills add /path/to/checkout/skills/example --pin <git-sha> --approve --json
```

The source must be a clean directory inside a Git checkout. Rizz inventories every file, rejects
symlinks, parses the skill manifest, records the exact revision and content digest, detects license,
scripts, shell/network/credential requirements, and requires explicit approval before copying
byte-verified content into the global Rizz cache. Nothing is enabled for a project during this step.

Enable a pinned skill only for the current isolated project:

```sh
rizz skills enable review-evidence --agent codex --agent claude --approve --json
rizz skills list --json
```

Enablement re-verifies the cached digest, validates agent compatibility, and records Rizz ownership,
revision, audit posture, requirements, and selected agents under `<project-workspace>/skills/`.
Enabled skills are projected into `rizz brief` packets so connected agents can select relevant
capabilities without reading another project or installing anything into the repository.

Preview every upstream change before applying it, and remove only Rizz-owned project selection:

```sh
rizz skills update /path/to/skill --pin <git-sha> --preview --json
rizz skills update /path/to/skill --pin <git-sha> --apply --approve --json
rizz skills remove review-evidence --approve --json
```

Preview reports added, changed, and removed files without writing. Apply retains the old immutable
cache object for rollback, updates the global pin, and refreshes current-project enablement while
preserving selected agents. Removal deletes only the Rizz-owned project manifest entry, records an
isolated history event, preserves the global cache, and refuses user-owned state.

## Connect Any MCP Agent

Run the model-independent local server from the project checkout:

```sh
rizz mcp
```

It speaks newline-delimited JSON-RPC over stdio and exposes `rizz://` project resources plus task
brief, file/flow explanation, review, checkpoint, completion, and handoff tools. Read operations use
the current isolated project workspace. Mutations require an exact project ID, Git revision, and
loop sequence; stale or cross-project writes are rejected. The server performs no model call and
writes no adapter or state into the repository.

## Connect Codex, Claude Code, And Copilot

Install the five minimal Rizz bridge skills at user scope:

```sh
rizz agents detect --json
rizz agents configure --user --dry-run --json
rizz agents configure --user
rizz agents doctor --json
```

Configuration writes the same project-independent skills to `~/.agents/skills`,
`~/.codex/skills`, `~/.claude/skills`, and `~/.copilot/skills`. Existing identical files are left
unchanged; different user-owned skills cause a conflict error and are never overwritten. Every
write is reread and verified. The skills discover the current repository at use time and query Rizz
through CLI JSON or MCP, so no project adapter or private project state is copied into a tool config.

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

`rizz explain flow <flow-id>` reads canonical flow entities from `<project-workspace>/brain/entities/flows.json`
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
<project-workspace>/brain/entities/reviews.json
<project-workspace>/brain/entities/findings.json
<project-workspace>/brain/latest.json
<project-workspace>/reports/review.html
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

Recommended model route:

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

`/workspace` is visible but not connected in this release. Workspace Mode is an opt-in future track,
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
checks also run `pnpm pack:check` to verify public package contents. Publishing to npm is a deliberate
release step after CI and package checks pass; pushes to GitHub do not publish packages.

`0.3.1` release verification:

- Biome: 145 files
- Vitest: 38 files / 383 tests
- PI-Bench: 25/25 tasks, 76/100 average research readiness
- CLI process smoke: 10/10 checks
- install-local: 5/5 shim smokes
- footprint: 53ms cold start / 198KB core, under the 200KB budget

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
  brain/       local Project Intelligence Engine and Mission Control artifacts
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

Development from source also needs pnpm 11+. CI currently runs on Node 24.

House style and architecture rules live in `AGENTS.md`.
