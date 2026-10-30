# rizz — decision log

The append-only record of project decisions (D-NNN) and how they bind the build. Every PR that makes
a non-obvious choice logs it here; runbooks, commit messages, and source comments cite these IDs.
Architecture-level choices with trade-offs get a full **ADR** (see [ADRs](#adrs)); a decision here may
point at one.

> **Provenance.** This file was reconstructed (2026-06-15) from commit history, runbook text, and
> `D-NNN`/`ADR-NNN` citations in the source — the original log file was never committed. Entries below
> are the decisions actually referenced in the repo. Unreferenced numbers in the D-NNN sequence
> (D-003, D-004, D-006, D-007, D-009, D-012–D-014, D-017, D-022, D-035, D-037, D-038) and the M3
> deviation **D-027** lived only in planning/handoff notes that are not in the tree, so their text is
> not recoverable here. **The next decision is [D-046](#log).** When a missing note resurfaces, fill
> the gap in place rather than renumbering.

Status legend: **Committed** (decided and in effect) · **Deferred** (decided to postpone) ·
**Superseded** (replaced by a later decision) · **Deviation** (departs from the design brief; flagged
NEEDS ORCHESTRATOR REVIEW).

---

## ADRs

- **ADR-001 — Service-layer split.** Services own the *how* (provider/SDK calls, command execution,
  readiness checks). They take explicit params, return structured `Result<T>`, never make
  orchestration decisions, and **never mutate session/budget state**. Orchestration (the loop in
  `core`, commands in `cli`) owns the *why/when* and classifies service results. See CLAUDE.md §
  "Architecture". Cited throughout `packages/providers` and `packages/core`.
- **ADR-002 — Tiered model layer.** Tier 1 (static curated registry + default-and-ordered-fallback
  routing) ships in M3. Tier 2 (declarative profiles, capability/cost/latency routing, on-disk
  registry) was deferred from M3 and built in M4 under [D-023](#d-023). Routing is never marketed as
  "smart"; latency is an ordinal tie-breaker only.

---

## Log

### Foundations (M0–M2)

#### D-001
**Opt-in power is summoned, not shipped.** — Committed
`/workspace` (multi-agent) and `/mcp` are opt-in packages that must never load on the default cold
path, and **must not be imported by any core package** (that would pull them onto the cold path).
They track their own size and are excluded from the 200KB core footprint budget (see [D-039](#d-039)).
→ `runbooks/footprint.md`, `.footprint-budget.json` (`optInPackages`), CLAUDE.md "one rule".

#### D-002
**Default provider family = Claude.** — Committed
The curated registry's default model is the current Claude family; subscription is the assumed default
billing posture. Display-only metadata until an adapter is wired — at M3-finish only the Anthropic
BYOK adapter exists (see [D-033](#d-033)). → `packages/providers/src/model/registry.ts`.

#### D-005
**Mandatory dev loop per change.** — Committed
Every change after bootstrap: **plan → `git worktree add` per task → build (`pnpm check`) →
code-simplifier pass → PR via `gh` → `check-pr` → `review-loop` → merge to `develop`.** Mechanics
live in `providers`; orchestration in `core`/`cli` (the service-layer split). Local review mechanics
are defined by [D-045](#d-045). → `CONTRIBUTING.md`, `runbooks/review-loop.md`.

#### D-008
**Cross-platform from day one.** — Committed
CI runs an ubuntu/macOS/windows matrix; line endings normalized to LF via `.gitattributes`; the
footprint build is shell-resolved so Windows `pnpm.cmd` works. Also drives the TUI color-depth ladder
(see [D-028](#d-028)). → `.github/workflows/ci.yml`.

#### D-010
**No hardcoded public product name yet.** — Committed
The TUI header uses the internal "rizz · by Valoir" placeholder; published Homebrew/npm/curl
installers stay deferred until `/login` connects and the published name is confirmed (the deferred
half of [D-031](#d-031)). → `packages/tui/src/*`.

#### D-011
**Sessions persist local-first — no cloud.** — Committed
Session state lives on local disk only. → `packages/providers/src/session/*`.

#### D-015
**Zero-dependency TUI.** — Committed
The TUI is hand-rolled ANSI + `readline`, no UI framework — the lightweight constraint applied to the
experience layer. → `packages/tui`.

#### D-016
**External review-bot acceptance rule.** — Superseded by [D-045](#d-045)
The earlier external review-bot gate depended on an unavailable numeric score and external account
quota. It is no longer a release requirement. Existing bot comments are ordinary comments, not a
merge gate. → `runbooks/review-loop.md`.

### Single-agent core (M3)

#### D-018
**Strict four tools by default.** — Committed
The default tool loadout is `read`/`write`/`edit`/`bash` only. `grep`/`find`/`ls` stay opt-in and off
by default (smaller default surface; `bash` covers them under the approval gate).
→ `packages/providers/src/runtime/*`.

#### D-019
**Compaction trigger at 70%, configurable, head/tail protected.** — Committed
Context compaction fires at 0.70 of the model window (configurable). Compaction never silently drops
the head (task intent) or tail (recent work); the dropped-middle summary is surfaced.
→ `packages/core/src/compress.ts`.

#### D-020
**Session store: node:sqlite primary, JSONL fallback.** — Committed
Auto-detected; append-only; resume restores full context and tolerates torn trailing lines. `node:sqlite`
is loaded via `createRequire` so a bundler can't break it. → `packages/providers/src/session/*`.

#### D-021
**Credential precedence — guard the surprise-bill footgun.** — Committed
When both a subscription credential and an API key are present, prompt for which to use rather than
silently metering. Subscription path → cost always shows `$0.00 (sub)`. The seam is preserved through
bootstrap even though subscription OAuth is not implemented (see [D-033](#d-033)).
→ `packages/core/src/auth.ts`, `bootstrap.ts`.

#### D-023
**M4 model layer = ADR-002 Tier 2, opt-in.** — Committed (M4)
Declarative profiles (`default`/`deep`/`fast`/`cheap`/`local`, naming intent not model ids — the churn
hedge), a secrets-free on-disk registry (`~/.rizz/models.json`, rejects any secret-bearing key), and an
**opt-in** capability/cost/latency router (`selectByCapability`) that the default path never enters.
Latency is an ordinal tie-breaker only — no ms claims. Precedence: `modelId > profile > capability >
default`. → `packages/providers/src/model/{profiles,registry-store,capability-route}.ts`.

#### D-024
**Service-layer return-shape deviations (M3).** — Deviation · NEEDS ORCHESTRATOR REVIEW
Two departures from the design brief's service contracts, made for layer purity (ADR-001): (1)
`ModelReply.usage` returns raw token counts — `costUsd` is computed in orchestration, not the service;
(2) `RouteDecision` returns a `ModelInfo` descriptor, not a live `Provider`, so the service does not
construct provider instances. → `packages/providers/src/model/{call,route}.ts`.

#### D-025
**Footprint gate measures installed artifacts only.** — Committed
The budget sums shipped `.js` + `.d.ts`, excluding source maps and compiled test files — a user never
installs those. → `scripts/footprint-check.mjs`.

#### D-026
**Footprint gate ↔ publish-tarball alignment.** — Committed
The npm tarball must drop exactly what the gate excludes (`*.map`, `*.test.*`); the `.npmignore` glob
matches the gate's `/\.test\./` regex so measured size equals installed size. → `runbooks/footprint.md`.

#### D-027
**Fourth M3 build deviation.** — Deviation · NEEDS ORCHESTRATOR REVIEW
Recorded in the M3 build handoff (`notes/m3-build-handoff.md`, logged as part of "Deviations
D-024…D-027"). The handoff is not present in the tree; the specific deviation is not recoverable from
code. Re-document when the note resurfaces.

### Connect + TUI (M3-finish)

#### D-028
**Color-depth ladder with ASCII glyph fallback.** — Committed
Themes degrade truecolor→256→16→none; the glyph set falls back to ASCII on lean rungs so the TUI stays
legible everywhere (pairs with [D-008](#d-008)). → `packages/tui/src/theme.ts`.

#### D-029
**Honest "coming soon" model catalog.** — Committed
`/model` lists selectable Claude models plus the full catalog dimmed "coming soon"; unwired references
(e.g. a `local` provider) resolve only once their adapter exists rather than masquerading as ready.
→ `packages/tui/src/commands.ts`.

#### D-030
**`/plan` and `/workspace` are visible stubs.** — Committed
Both surface an honest coming-soon line rather than silently doing nothing; `/workspace` stays opt-in.

#### D-031
**Local install via PATH shim now; published installers deferred.** — Committed / Deferred (step 3)
Step 2: `scripts/install-local.mjs` writes a `~/.local/bin/rizz` shim for dogfooding (POSIX; global
`pnpm link` documented for all platforms). Step 3 (Homebrew/npm/curl) deferred until `/login` connects
and the published name lands (see [D-010](#d-010)). → `runbooks/install.md`.

#### D-032
**Demo-mode polish.** — Committed
Slash commands route to handlers (not echoed as chat); one quiet demo banner; no per-turn nag.

#### D-033
**Connect path = BYOK.** — Committed
rizz connects to Claude via a user-supplied Anthropic API key (env `ANTHROPIC_API_KEY` or `/login` →
OS keychain). Pro/Max subscription OAuth is intentionally **not** implemented. Bedrock/OpenRouter are
planned later as config. Use "BYOK" in all user-facing copy. → `packages/providers/src/anthropic.ts`,
`runbooks/headless.md`.

#### D-034
**Secrets posture.** — Committed
Secret store backends: macOS `security`, Linux libsecret `secret-tool`, 0600 file fallback. On Windows
NTFS the 0600 bit is a near-no-op (user-profile ACL protects the file); DPAPI is the deferred upgrade.
Keys are held in closure and redacted from any surfaced text. → `runbooks/secrets.md`.

### Interop hub (M4)

#### D-036
**Headless is the bridge surface; bridges stay external.** — Committed
The headless interface is the surface a future Telegram/CI/pipeline bridge drives. The bridge itself
stays an external, opt-in component — it never loads on the default path. → `runbooks/headless.md`.

#### D-039
**Opt-in packages track their own size; core budget stays 200KB.** — Committed
The footprint gate measures core packages only; opt-in packages (`workspace`, `mcp`) are listed in
`.footprint-budget.json` so they're excluded the moment they land, and each tracks its own budget.
→ `scripts/footprint-check.mjs`, `runbooks/footprint.md`.

#### D-040
**Headless interface = one-shot JSON + JSON-RPC over stdio (job #3).** — Committed
Two ways to drive rizz without the TUI, both orchestration over the existing loop (ADR-001/[D-024](#d-024)):
(1) one-shot print/JSON — a turn in, `{ ok, reply, toolCalls, usage, costUsd, stopReason, error }` out,
errors as stable RizzError codes; (2) line-delimited JSON-RPC — `session.start`/`session.resume`/`turn`/
`approve` with streamed events. CLI `--json` / `--rpc` flags compose with `--profile`/`--capability`.
→ `packages/core/src/headless.ts`, `runbooks/headless.md`.

#### D-041
**Approval gate survives headless — as an event, never bypassed.** — Committed
In RPC, a destructive/networked bash command emits an `approval` message the caller must answer with an
`approve` request (the loop parks until then); it is never auto-approved remotely. One-shot JSON has no
channel to ask, so it **denies** destructive/networked commands outright and runs read-only tools.
→ `packages/core/src/headless.ts`.

#### D-042
**Strip comments from shipped `.js`; keep JSDoc in `.d.ts`.** — Committed
`tsconfig` `removeComments` for emitted JavaScript dropped core from 203KB to 147KB (budget stays
200KB); generated `.d.ts` retains JSDoc for consumers. → `tsconfig.base.json`.

#### D-043
**The decision log is a tracked file, reconstructed from the repo.** — Committed
This file was cited across runbooks, commits, and source `D-NNN`/`ADR-NNN` comments but never
committed; it is reconstructed here from those references (see the Provenance note) so the log
resolves and new decisions have a home. New decisions are appended in the PR that makes them, citing
the ID in the commit/runbook/source. → `decision-log.md`, [rizz#11](https://github.com/Lokesh-4946/rizz/pull/11).

#### D-044
**One OpenAI-compatible adapter, selected by `model.provider`, keyed by `<PROVIDER>_API_KEY`.** — Committed (M4)
BYOK over any OpenAI-shaped endpoint (OpenAI, OpenRouter, Ollama, custom) through a single adapter
that differs only by `baseUrl`; a provider-factory in bootstrap picks Anthropic-native vs
OpenAI-compatible by `model.provider`, and the agent loop is unchanged. The adapter mirrors the
Anthropic one (stream + non-stream, tool mapping, status→RizzError, key redaction) and stays pure
(ADR-001/[D-024](#d-024)). Credential resolution is orchestration: the key is read from
`<PROVIDER>_API_KEY` (env override → keychain account = provider id), so **no key is stored in the
registry — only referenced**; a `keyless` model (local Ollama) connects with no key. The built-in
registry carries OpenAI; **OpenRouter / Ollama / custom live in the on-disk registry**
(`~/.rizz/models.json`), which keeps local/free endpoints out of the opt-in capability auto-router by
default. Follow-up: the `local` profile still points at a placeholder id and stays an honest stub;
wiring it to a concrete local model is deferred. → `packages/providers/src/providers/openai.ts`,
`packages/core/src/bootstrap.ts`, `runbooks/install.md`.

#### D-045
**Local PR review loop replaces external review-bot scoring.** — Committed
Release readiness is determined by rizz's local `check-pr` + `review-loop` process: inspect PR state,
changed-file scope, CI, comments, and description; then run up to three local review/fix/verify
iterations. No external score is required. External bot comments, if present, are classified as
actionable, stale, or informational like any other comment. The gate is: scoped diff, actionable
findings handled or orchestrator-deferred, no actionable unresolved threads, MERGEABLE/CLEAN, required
CI green, complete PR body, and lightweight-footprint evidence for code changes. → `CONTRIBUTING.md`,
`runbooks/review-loop.md`, `.claude/skills/check-pr`, `.claude/skills/review-loop`.

---

#### D-046
**The observer brain is project-scoped in the Rizz home.** — Committed
Rizz records the host coding agent. It does not spawn that agent. Continuity lives under the
isolated project store from the user-agent bridges (`<rizz-home>/projects/<id>/observe/`): a
rewritten `BRAIN.md` index (capped at 200 lines), an append-only `journal/YYYY-MM.md`, `vision.md`
(human-owned), append-only `decisions.md`, thread notes, handoffs, an owner inbox, and
`ledger/tokens.jsonl`. The store key is the canonical project path, so calling Rizz in a repo
reopens that project's brain. The git tree stays untouched unless `rizz init --bridge` writes an
opt-in `AGENTS.md` / `.cursor/rules/rizz.mdc` block. `sessionStart` injects the index by default.
`rizz hook` always exits 0 and appends one spool line; `rizz serve` folds the spool and serves a
stateless `127.0.0.1` page. The hook entry is `@valoir/rizz-brain/observe` so it does not load the
Project Intelligence graph. No new runtime dependency. The counted CLI entry grew past 200KB
with the bridges commands plus this dispatch, so the core budget is 201KB. The observer
modules themselves stay in the opt-in brain package. → `packages/brain/src/observe/`,
`packages/cli/src/index.ts`, `.footprint-budget.json`.

---

#### D-047
**A killed append must not glue the next journal record to a torn tail, and a dead spool lock must not drop the next hook.** — Committed
`appendSynced` truncates to the last newline before writing, fsyncs, and reads the new tail back.
A committed record always ends in a newline, so a kill mid-write drops only the unfinished bytes.
`writeAtomic` still renames after fsync, so a kill leaves the previous `BRAIN.md` and a torn
`offset.json` replays from offset 0. Replaying a journal id still fills the ledger, inbox, handoff,
and index if the crash landed between those writes. The spool lock records its holder pid and is
cleared when that pid is dead. A lock with no pid file is cleared after one second. If the lock is
still busy, the hook appends the event anyway and exits 0. Codex `.jsonl.zst` stays refused: Node's
zlib zstd API is experimental, and a decoder dependency is outside the lightweight budget.
→ `packages/brain/src/observe/io.ts`, `packages/brain/src/observe/fold.ts`,
`packages/brain/src/observe/codex-session.ts`.

---

#### D-048
**`rizz init` returns. The local page keeps running in its own process.** — Committed
A host agent that runs `rizz init` cannot wait on the UI server. Init installs hooks, starts
`rizz serve` detached, prints the URL and pid, and exits. `rizz serve` itself stays in the
foreground. `--no-serve` skips the page. `--no-open` is forwarded to the detached page.
→ `packages/brain/src/observe/cli.ts`.

---

#### D-049
**An answered inbox item stays answered, and a busy spool lock never appends unlocked.** — Committed
Replaying a spool event must not recreate an inbox file whose id already has a `dec_<id>` row in
`decisions.md`. Hooks append to the shared log only while holding the spool lock. If that lock
stays busy, the event is written as its own file under `spool/pending/` and folded later. If that
file cannot be written either, a drop record is kept and `rizz summary` counts it. Installed hook
commands name `node` and the absolute script path of the CLI that ran `rizz init`, so a different
`rizz` on `PATH` is not what the host executes. `rizz init --help` prints help and returns.
→ `packages/brain/src/observe/fold.ts`, `packages/brain/src/observe/install.ts`,
`packages/brain/src/observe/cli.ts`.

---

#### D-050
**Session start injects the newest handoff and the brain index. A killed session is recovered from the journal.** — Committed
Owner label D-S1. `sessionStart` / `SessionStart` for Cursor, Codex, and Claude Code injects the
newest handoff note first, then unread relay replies, then `BRAIN.md`, inside the existing
6000-character budget. The handoff section is capped at 2400 characters including its heading.
Unread replies are capped at 1600 characters and stay labeled as information, not instructions.
The index receives every remaining character. A shorter section does not raise its own cap. The newest handoff is the greatest
mtime; equal mtimes use the greater file name. The note includes the latest user prompt, the last
shell command with its exit status and the first failing-test line, touched files, and an
`Open / Next` section. `Done` lists files edited and commands run. `BRAIN.md` has a `Touched files`
section. `parseHandoffBlock` runs when the handoff note is written, and a usable fence supplies
goal, done, files, and owner decisions. A thread with work and no stop hook is recovered by the
next `sessionStart` (every host) or by `rizz fold`: a stable journal stop with status `inactive`
and a recovery handoff. The thread that is starting is left active. The page's one-second fold
does not recover, because it cannot tell a pause from a kill.
→ `packages/brain/src/observe/session-context.ts`, `handoff.ts`, `fold.ts`, `receive.ts`,
`brain-index.ts`.

---

#### D-051
**Owner decisions keep the explicit `Owner decision:` prefix, including mid-line.** — Committed
Owner label D-S2. The prefix matches any casing at line start or later on the same line. The same
words inside quotes, backticks, or a fenced code block are not decisions, so a quoted example in a
prompt does not enter the inbox. An apostrophe inside a word (`Don't`) is not a quote.
→ `packages/brain/src/observe/model.ts`, `README.md`.

---

*Next decision: **D-052**. Append in `feat:`/`fix:` PRs that make a non-obvious call; cite the ID in
the commit, runbook, or source comment that implements it.*
