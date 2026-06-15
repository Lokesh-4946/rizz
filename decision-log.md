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
> not recoverable here. **The next decision is [D-043](#log).** When a missing note resurfaces, fill
> the gap in place rather than renumbering.

Status legend: **Committed** (decided and in effect) · **Deferred** (decided to postpone) ·
**Deviation** (departs from the design brief; flagged NEEDS ORCHESTRATOR REVIEW).

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
code-simplifier pass → PR via `gh` → greploop to 5/5 → merge to `develop`.** Mechanics live in
`providers`; orchestration in `core`/`cli` (the service-layer split). → `CONTRIBUTING.md`,
`runbooks/greploop.md`.

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
**greploop acceptance rule for a no-numeric-score Greptile install.** — Committed
This Greptile install returns no readable confidence score (review bodies are empty across PRs).
Accept a PR when: all actionable findings addressed + all threads resolved + 0 active comments +
MERGEABLE/CLEAN + CI green on all three OSes. Capped at 5 iterations. If a numeric score ever appears,
5/5 becomes a sixth criterion. → `runbooks/greploop.md`.

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

---

*Next decision: **D-045**. Append in `feat:`/`fix:` PRs that make a non-obvious call; cite the ID in
the commit, runbook, or source comment that implements it.*
