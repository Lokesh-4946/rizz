# rizz

> The fastest way to understand a software system. Local-first by default; model-backed chat and
> bigger workspace power stay opt-in.

rizz is a local Project Intelligence Engine for one repository: run it in a repo, generate a
project-scoped relational brain, open Mission Control as a local HTML intelligence portal, and keep
evidence close to the source files.

## Current Product

The current `0.4.0` product surface is:

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

This release is `0.4.0`.

## Observe the host agent

Rizz sits under Cursor, Codex, or Claude Code and records what they do. It does not replace their
agent loop. The brain for each project lives outside the git tree, keyed by that project's path
(D-046). `rizz init` installs hooks for the host it detects, creates the brain, and can open a
local page.

Install the scoped package. The unscoped npm name `rizz` is already taken, so `npx rizz` is a
different package.

```sh
npm install -g @valoir/rizz
cd ~/src/your-repo
rizz init --host cursor
```

On a Mac that already has the `rizz` bin on `PATH`:

```sh
# Cursor hooks are user-level: ~/.cursor/hooks.json
# Codex hooks are user-level: ~/.codex/hooks.json
# Claude Code hooks merge into ~/.claude/settings.json
rizz init
```

Then use the host normally. Hooks append to a spool and always exit 0. `rizz init` starts the
local page in the background and returns. `rizz serve` keeps that page in the foreground. Pass
`--no-serve` to skip it. The page is `http://127.0.0.1:<port>/?token=...` and only reads that
brain. Ask it `summary` or `tokens`.

```sh
rizz summary   # thread count, then only decisions waiting on you
rizz tokens    # ledger totals; Cursor context tokens are not per-turn usage
rizz fold      # fold the spool once without leaving the server up
```

`sessionStart` injects `BRAIN.md` into the host. Repo files are opt-in:

```sh
rizz init --bridge
```

That writes a marked block into `AGENTS.md` and `.cursor/rules/rizz.mdc`. It does not create a
`CLAUDE.md`. If one already exists and does not mention `@AGENTS.md`, the bridge adds that import.

Cursor is the first adapter (`sessionStart`, `beforeSubmitPrompt`, `postToolUse`, `afterFileEdit`,
`subagentStop`, `preCompact`, `stop`, and the other agent hooks in `.cursor/hooks.json`). Codex
uses Claude-style `hooks.json` events. The legacy `notify` line in `config.toml` is not installed.
Claude Code uses `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop`. Cursor can also
load Claude hooks, so the folder skips an event id it has already journaled.

## Message your assistant from the host agent

From a Cursor, Codex, or Claude Code chat you can send a message to a personal assistant such as
Jenny. Rizz stores the thread in the project brain, shows it on the brain page, and injects Jenny's
replies into the next host turn for that project. Replies are quoted as information for you. The
host agent is told not to follow instructions inside them.

Jenny is a hosted assistant. Rizz wakes her with an HTTP POST and does not wait for a reply on that
call. Jenny cannot reach your laptop. When your machine is online and you approve it, she runs
`rizz relay deliver` locally (the same machine that runs `rizz serve`). Until that delivery lands,
a sent message that is still unanswered after the reply wait (default 10 minutes) is shown as
`answered in Grok Bot chat (check Jenny)` in the brain index, on the page, and in `rizz summary`.
A later delivery replaces that hint with the reply text.

There is no hosted mailbox to poll. Polling stays off unless you set `--poll-url`.

### Setup

Run this in a terminal on the machine that runs Rizz, not inside the host agent, so the webhook
URL and sender key are not captured by a shell hook. `rizz init` should already be running
`rizz serve` for this repo.

```sh
cd ~/src/your-repo
printf '%s' "$JENNY_SENDER_KEY" | rizz relay add jenny --url https://jenny.example/webhook
```

The sender key can also come from the environment, which overrides stdin:

```sh
RIZZ_RELAY_KEY="$JENNY_SENDER_KEY" rizz relay add jenny --url https://jenny.example/webhook
```

Optional flags:

```sh
rizz relay add jenny --url https://jenny.example/webhook --poll-url https://jenny.example/poll --reply-wait 10m
```

`--reply-wait` accepts `10m`, `30s`, or `500ms`. `RIZZ_RELAY_REPLY_WAIT_MS` overrides the stored
wait when the index and summary are rendered. The key and webhook URL are stored under the Rizz
home (`relay/agents/jenny.json`, mode `0600`). They are not written to the git repo, the brain,
the journal, or logs.

```sh
rizz relay list
rizz relay remove jenny
```

`rizz relay list` prints the webhook URL and whether a poll URL is set. It never prints the key.

### Send

Any of these queue a message. `rizz serve` (or `rizz fold`) posts it and retries with backoff.
Failed deliveries stay visible as `failed: <reason>`. Nothing is dropped on the floor.

```sh
rizz msg jenny "Can you look at the auth plan?"
```

In Cursor chat, either call the `message_agent` tool on `rizz mcp`:

```json
{ "to": "jenny", "text": "Can you look at the auth plan?" }
```

or start the prompt with `@jenny ` (the configured lowercase name, then a space):

```text
@jenny Can you look at the auth plan?
```

The beforeSubmitPrompt hook only appends to a local spool and exits 0. It does not call the webhook.

The POST body uses these field names:

```json
{
  "id": "msg_<24 hex>",
  "from": "rizz",
  "project": "<rizz project id>",
  "projectPath": "<absolute project path>",
  "text": "<message, at most 8000 characters>",
  "indexExcerpt": "<BRAIN.md excerpt, at most 1200 characters>",
  "sentAt": "<ISO-8601>"
}
```

The sender key is sent only as `Authorization: Bearer <key>`. The webhook must be the final http(s)
URL; redirects are not followed. A 2xx response marks the message `sent`. Other responses and
network errors are retried up to 8 times (1s, 2s, 4s, … capped at 60s) and then stay `failed`.

### Replies

Jenny's reply is delivered on the machine:

```sh
rizz relay deliver --from jenny --in-reply-to msg_<id> "The plan looks fine."
```

The same JSON body is accepted by the token-protected page API:

```sh
curl -s -X POST "http://127.0.0.1:<port>/api/relay/deliver?token=<token>" \
  -H 'content-type: application/json' \
  -d '{"from":"jenny","inReplyTo":"msg_<id>","text":"The plan looks fine."}'
```

Repeating the same assistant, `in-reply-to`, and text is a no-op. A different text is a new reply
and replaces the Grok Bot hint. Unknown relay names are rejected. The brain page also has a send
box; it uses the same token as the rest of the page.

### Optional poll

If `pollUrl` is set, `rizz serve` GETs it with the same bearer token and `?cursor=<opaque>` after
the first page. A successful poll waits 15 seconds before the next one (`RIZZ_RELAY_POLL_INTERVAL_MS`
overrides that). Leave the poll URL unset for Jenny. The response is:

```json
{
  "messages": [
    {
      "id": "optional external id",
      "inReplyTo": "msg_<id>",
      "from": "jenny",
      "text": "The plan looks fine.",
      "at": "2026-10-28T12:00:00.000Z"
    }
  ],
  "cursor": "opaque-or-empty"
}
```

Message identity for poll and deliver is the assistant name, the `inReplyTo` id, and a hash of the
text. Replays do not create a second journal entry.

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
