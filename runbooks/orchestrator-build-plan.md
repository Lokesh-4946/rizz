# Orchestrator Build Plan

rizz is the local Project Intelligence Engine for any coding agent. The build plan should keep that
position sharp: understand the repo, expose evidence, review risk, and give other agents a compact
context contract.

ECC-inspired features are useful when they strengthen that contract without joining the default path.

## Canonical Host-Agent Loop

Rizz is the lightweight evidence and verification control plane that makes existing coding agents
faster, grounded, repeatable, economical, and safe to release. AI reasons; Rizz supplies facts,
constrains context, records provenance/state, and verifies outcomes. Host-native permissions remain
authoritative. Rizz has no default model call, autonomy mode, general agent runner, or competing
approval system.

1. The user gives a task to Codex, Claude, Copilot, or another host coding agent.
2. The host requests a bounded, provenance-bearing Rizz evidence packet.
3. The host reasons, proposes semantic risks/scope/non-goals, plans, and implements.
4. Rizz tracks the exact mission and working snapshot and runs deterministic verification.
5. The host receives the exact diff, deterministic risk signals, results, and cited evidence.
6. The host performs semantic review using Rizz's pinned skills and deterministic
   `ReviewEvidencePacket`.
7. Rizz validates citations/recorded relationships, rejects unsupported references, deduplicates,
   and persists host findings with origin/status/confidence.
8. The host repairs current evidence-backed findings; targeted verification and correction repeat
   until clean or explicitly blocked.
9. Rizz verifies the final working snapshot and issues a pre-commit snapshot receipt.
10. The host explicitly commits. Rizz proves the committed tree is byte-equivalent to the verified
    snapshot and reruns required checks if hooks or protected bytes changed.
11. Rizz issues `local_green` for the exact commit SHA plus mission/evidence/config/verification/
    toolchain fingerprints.
12. The host explicitly pushes and submits/opens the PR or MR.
13. Rizz or an optional connector ingests remote CI failures, review threads, base drift, and policy
    changes as provenance-bearing untrusted evidence; validates/deduplicates bounded corrections;
    and returns them to the host.
14. The host repairs, reruns targeted and required full local verification, commits a new exact
    `local_green`, and pushes the new head. Remote checks/reviews repeat; older-head resolution is not
    silently reused without provider-policy semantics.
15. Rizz revalidates the exact remote head, current base/merge-base, CI, reviews, protection,
    signoff, and policy, then issues `merge_ready` only for that eligible head.
16. The host explicitly invokes merge; provider capability negotiation may require update/rebase or
    a merge queue rather than a direct merge operation.

The host owns semantic review and product intent. Rizz emits factual risk signals and validates
cited evidence; citation-valid AI conclusions remain hypotheses until verification, stronger
evidence, human acceptance, or repair outcome confirms/rejects them. Explicit user/spec/issue/
AGENTS/policy constraints are hard gates. AI-proposed paths/non-goals are nonblocking and do not
require a separate Rizz approval. Risky external-skill and destructive/network-operation gates
remain distinct because they protect distinct side effects.

The complete design and staged acceptance model live in
`docs/superpowers/specs/2026-07-14-precision-closed-loop-design.md` and
`docs/superpowers/plans/2026-07-14-precision-closed-loop.md`.

Estimated current loop readiness (planning signal only, never release evidence):

| Stage | Readiness | Remaining | Notes |
| --- | ---: | ---: | --- |
| Human intent | 76/100 | 24 | Intent can enter through CLI/review/explain flows, and review can now warn when dirty local work may distort the requested task scope; capture UX is still lightweight. |
| rizz mission contract, project intelligence, and inspect-first context | 99/100 | 1 | Project intelligence, Mission Control, confidence queues, file-level explain, DBMS schema/model entities including SQLAlchemy/Alembic, security/tool inventory, unified repair packets, UAT artifacts, review-time mission-contract comparison, mission-contract normalization, and lexical unrelated-work hints are strong; explicit mission capture UX can still be sharper. |
| Coding agent implementation | 90/100 | 10 | Exact, approval-gated repair handoffs now execute through bounded Codex, Claude Code, and Copilot adapters in isolated worktrees; general session import/control-pane context and broader task-planning adapters remain future opt-in work. |
| Host semantic review with Rizz evidence | 99/100 | 1 | Review Intelligence supplies blast-radius evidence, affected flows/tests/configs, deterministic review artifacts, and governance checks; the host AI owns semantic conclusions and Rizz validates/persists cited findings. |
| rizz correction packet | 96/100 | 4 | Unified `agent_repair_packets` are now consumed through an exact project/revision/artifact/packet identity with bounded files, verification actions, and stop conditions; richer automatic scope narrowing remains. |
| Coding agent repair | 94/100 | 6 | All three agent-specific bridges now have disposable handoff-to-edit-to-verification proof, strict worktree/project ownership, stale refusal, cancellation, and interrupted-run recovery; real vendor/model validation, retry policy, and automatic post-edit scope enforcement remain. |
| rizz verification | 82/100 estimated | 18 | Existing proof/fingerprint checks are useful, but dependency closures, dirty-snapshot identity, commit-before-green, truthful receipt gaps, and base-drift invalidation remain Milestone C work. |
| Human/repository governance | 78/100 estimated | 22 | Existing expiry/revocation evidence is useful; remote reviews, provider policy, signoff drift, merge queues, and exact-head merge readiness remain Milestone E work. |

## Opt-In Expansion Map

| Feature | rizz Usefulness | Default Path |
| --- | --- | --- |
| Session adapters / control-pane snapshot | Import work history and agent state as inspectable evidence. | Opt-in export/import, not always-on orchestration. |
| MCP/tool inventory | Record available tools and risk posture for repo intelligence and review. | Opt-in scan artifact. |
| Worktree lifecycle service | Run isolated experiments and PR loops from a clean branch. | Shipped repair-specific foundation: linked-worktree proof, exact revision binding, external run state, cancellation, and interrupted-run recovery. General workspace lifecycle remains opt-in/future work. |
| Manifest install/state ownership | Install and repair rizz packs without guessing what is owned. | Opt-in pack command. |
| Security scanner | Add secret/risky-pattern evidence to reviews and confidence gates. | Local deterministic scan, no cloud call. |
| Deterministic harness audit | Score whether a repo is ready for agent work. | Local report under `<project-workspace>/research/`. |
| Audited upstream skill cache | Pin inspected skill content without execution or project enablement. | Shipped foundation: exact revision, digest, license, requirements, explicit approval. |
| Project skill enablement | Select compatible pinned skills without repository installation. | Shipped foundation: project-isolated manifest, cache verification, explicit approval, agent-filtered CLI/MCP briefs, and exact upstream provenance. |
| Skill update/removal lifecycle | Preview changes, retain rollback objects, and remove only owned enablement. | Shipped foundation: file-exact preview, approved apply, ownership guard, isolated history. |
| Skill registry integrity | Preserve concurrent global pins and diagnose cache state without destructive cleanup. | Shipped foundation: serialized atomic registry updates, schema validation, read-only doctor, approval-gated quarantine repair. |
| Approved skill source acquisition | Discover approved upstream collections and acquire exact revisions without executing content. | Shipped foundation: six-source catalog, local search, immutable commit preview, approval-gated global checkout, partial-fetch cleanup. |
| Upstream collection compatibility | Audit every tracked Agent Skill at an acquired exact revision. | Shipped foundation: exact-revision collection scan, per-skill compatibility/audit evidence, quoted YAML scalar support, 463-skill real upstream UAT. |
| Individual upstream skill discovery | Find audited skills inside previously acquired collections with exact source evidence. | Shipped foundation: bounded offline search, deterministic content-addressed global indexes, exact source/revision filters, and stale/missing/tampered checkout rejection. |
| Acquired skill selection and pinning | Preview and pin one exact audited skill without manual filesystem paths. | Shipped foundation: exact source/revision/path selection, explicit approval, immutable cache objects, full provenance, name-conflict rejection, and concurrent-safe registry writes. |
| Agent repair handoff | Give a selected coding agent one bounded, evidence-bound correction contract and consume it only after approval. | Shipped foundation: Codex, Claude Code, and Copilot previews plus opt-in execution; exact project/revision/artifact digests; explicit packet, file, verification, and prompt caps; linked-worktree proof; cancellation and approved interrupted-run recovery; disposable process-level lifecycle UAT. |

## Precision-First Milestones and Release Boundary

| Milestone | Status | Capability and dependency |
| --- | --- | --- |
| A — Context precision | Implemented in current baton | Literal mission relevance, 32 KiB whole-JSON briefs, versioned mission/pinned skills, explicit versus proposed provenance, nonblocking proposed/open paths, citation validation, and equivalent CLI/MCP Task Brief payloads for their shared task/scope/status/skill surface. |
| B — Review/repair precision | Planned after A | `ReviewEvidencePacket`; host-AI findings with revision-independent `finding_key` and revision-bound observation ID; evidence freshness; baseline-debt separation; correction admission; deduplication/convergence. |
| C — Snapshot/local release | Planned after B | Dirty snapshot/base identity; verification-node dependency closures and cost tiers; immutable artifact envelope/manifest; truthful commit-before-`local_green`; attach/resume; explicit commit/push/submit; provider/commit contracts; idempotent journal. |
| D1 — Early context efficiency | May proceed after A | Stable provider-prefix zones, changed-evidence delta packets, hash-addressed expansion, cold/warm overhead telemetry, adaptive bypass. |
| D2 — Protected optimization | Planned after B/C/D1 | Finding/snapshot/verification-bound optimization receipts, exact-original lifecycle, storage/privacy/GC, release-grade invalidation. |
| E — Remote readiness/calibration | Planned after B/C/D2 | Post-submit repair loop; exact-head/base `merge_ready`; provider capabilities/queues; remote TOCTOU; fault/metamorphic/seeded-defect corpus; three-ecosystem calibration and product metrics. |

Release capability names remain provisional pending contract review. Capabilities are separate and
explicit: commit, push, provider-neutral submit/open PR-or-MR, and merge. Candidate spellings such as
`rizz submit --pr` and `rizz merge` do not imply an implemented command in Milestone A. There is no
one-click release bypass and no Rizz autonomy mode.

Commit precedes final local green. A pre-commit result is only a working-snapshot receipt. Hooks,
formatters, generated bytes, staged/unstaged differences, protected untracked content, submodule/LFS
state, config/lockfile/policy/skill changes, or toolchain changes invalidate the appropriate receipt.
`local_green` covers one exact local commit. `merge_ready` separately covers one exact remote PR/MR
head plus CI/reviews/branch protection/signoff/policy. Force-pushes, amended commits, stale CI, and
remote review/policy/signoff changes invalidate merge readiness.

Future release operations require stable operation IDs, phase receipts, partial-success discovery,
single terminal ownership, and exact next-safe-action recovery. A network timeout after successful
remote creation must recover the same PR/MR rather than duplicate external actions.

`local_green` means only that declared required local checks passed for one exact commit; it is not a
correctness claim. Every green/readiness view lists required passes, proposed non-required checks,
skipped/unavailable checks and reasons, unresolved hypotheses/coverage gaps, policy/signoff basis,
and invalidation/expiry. Unknown required remote policy, CI, review, base, or signoff state fails
closed for `merge_ready`.

The default UX is one compact status/why/next-safe-action summary with machine detail and expansion.
Users do not manually copy mission/finding/receipt IDs. Attach/resume must reconstruct an existing
branch, worktree, commit, or PR/MR and mark stale artifacts honestly. An opt-in setup preview/doctor
checks host MCP, CLI/tools, supported adapter/schema ranges, pinned skills, Git/provider capability,
and repository state without silently rewriting host configuration; read-only context/review remains
available without release connectors.

## Precision QA Contract

The QA report must be machine-readable and falsifiable; internal 100/100 scorecards are not release
proof.

- **Metamorphic:** unrelated docs/vendor/generated trees and thousands of unrelated graph edges do
  not alter bounded packets/findings; enumeration/object-key reorder is semantically stable;
  duplicates cannot raise relevance; CLI/MCP/pinned-skill contracts agree; protected originals
  round-trip exactly.
- **Invalidation matrix:** independently mutate source bytes, staged state, protected untracked
  files, lock/config, mission constraints, skill digest, verification command, toolchain/policy,
  local commit, remote head, CI, review state, and signoff; invalidate no more and no less than the
  affected working receipt, local green, or merge readiness.
- **Fault/recovery:** kill during verification/evidence writes and after push; recover timeout after
  successful PR/MR creation; force-push before merge; exercise partial writes, symlink swaps,
  redirected state, corrupt exact originals, cancellation, clock skew, and concurrent ownership;
  never duplicate external actions.
- **Differential/flake:** cover base-fails/head-fails-same, base-pass/head-fail,
  base-fail/head-pass, capped intermittent reruns, and infrastructure/provider outages reported but
  excluded from product metrics. Required flaky checks cannot silently produce green.
- **Seeded defects/negative controls:** measure clean surgical false positives and seeded missed
  defects across behavior, API compatibility, security, migration/schema, dependency/lockfile,
  config/test/generated/type/comment-only changes in FastAPI, Vitest, and a third ecosystem.
- **Untrusted context:** repository prompt injection remains quoted evidence; cover Unicode/control
  filenames, ANSI/log injection, traversal, case-only changes, symlinks, submodules, LFS,
  shallow/detached repos, renames, and bomb-like artifacts. Repository text is never executed.
- **Release TOCTOU:** hook-mutated commit prevents green; post-green local change prevents submit;
  force-push/rule/review/signoff change prevents merge; retry recovers one PR/MR; merge receipt binds
  the merged remote SHA.

Required metrics: evidence-packet precision and required-evidence recall; citation rejection and
valid-finding acceptance/confirmation; missed seeded defects; false blocking; convergence and
no-progress stops; repeated reads and duplicate bytes/tokens; targeted/full verification reuse and
reruns; time, input/output/cache tokens, actual cost, and rereads per accepted verified change;
infrastructure-excluded runs; exact model/tool versions; warm versus cold preparation;
task-to-first-useful-packet p50/p95; local-green/merge-ready false-positive and false-block rates;
evidence staleness; per-check reuse precision; attach/resume success; storage growth/reclaimed bytes;
stable-prefix cache hits; post-submit convergence; base-drift/merge-queue success; and manual ID
copying in the default loop (target zero).

Every verification node declares exact argv/cwd, source/test/config/lock/tool inputs or deterministic
globs, upstream dependencies, environment/toolchain/policy identity, and closure confidence. Reuse
requires a complete unchanged closure and a readable proof; unknown closure reruns. Invalidation is
minimal, uses Git object/Merkle identities plus one hash of changed/protected non-Git inputs, and does
not rescan the entire repository. Cost order is cheap snapshot/scope/security/static checks, host
review, targeted repair checks, one stabilized required full local gate, then remote CI. Base/head
differential is lazy unless failure provenance or explicit policy requires it.

`finding_key` is revision-independent normalized claim + stable canonical citation locators (without
revision/content digest/freshness) + rule/reviewer identity/version. `finding_observation_id` adds
mission/revision/review fingerprint and revision-bound citation digest/freshness. Continuity and
no-progress follow the key while observations/status transitions retain exact revision. Stale/unknown
relationships cannot become direct proof.

Artifacts are immutable/content-addressed with one shared identity envelope and a small atomic,
versioned project manifest. One artifact is authoritative per fact; reports are derived. Schema read
compatibility, orphan detection, corruption, and atomic index recovery are explicit without a god
service or database dependency. Per-project/global budgets govern retention, GC, inspect/purge/export,
project isolation, permissions/symlink defense, secret-safe persistence, optional encryption, and no
silent upload or cross-project cache-existence leak.

Stable prompt prefix, task evidence, live evidence, and out-of-prompt control/telemetry have separate
digests. Volatile timestamps/IDs/counters/diffs cannot destroy the stable prefix. Efficiency SLOs
cover cold first-packet, warm delta latency, indexing bytes/time, CPU/memory/disk, provider bytes/
tokens/cost, total overhead percentage, scans/hashes/rereads, and adaptive bypass when preparation
cost exceeds expected value. Product savings use cost/time per accepted verified change, not
compression ratio.

## Resource Governance Tracker

Rizz should provide the useful outcomes of Headroom-style context optimization while preserving its
evidence contract. Resource efficiency is subordinate to correctness: source code, exact diffs,
security evidence, failing assertions, and verification proof are never lossy-compressed by default.

| Capability | Status | Acceptance evidence |
| --- | --- | --- |
| Task-scoped context budgets | Milestone A shipped | `rizz brief` enforces a 32 KiB whole-JSON ceiling with exact emitted bytes, bounded task evidence, skill omissions, revision, and explicit gaps. |
| Content-addressed context cache | Legacy opt-in primitive; precision contract planned for D1/D2 | Existing objects are not the zoned delta-context/cache receipt promised by this roadmap. D1 prototypes savings from A identities; D2 binds release-grade reuse/invalidation to B/C identities. |
| Evidence-preserving tool-output compaction | Legacy opt-in primitive; protected optimization planned for D2 | Existing compaction is not acceptance evidence for protected exact-original, storage lifecycle, or corruption guarantees. |
| Agent dispatch resource leases | Shipped foundation | Opt-in work receives concurrency and expiry limits; capacity is rejected and expired leases are deterministically reclaimed. |
| Shared multi-agent context | Planned after MCP bridges | Agents exchange bounded packets through the isolated project workspace, never by copying whole transcripts or reading another project. |
| Resource-aware scheduling | Planned | Dispatch chooses serial/parallel work from dependency independence, available slots, provider limits, and expected verification cost. |
| Local observability | Existing foundation; overhead accounting planned for D1 | Current metrics exist; the canonical loop still requires cold/warm latency, indexing/bytes, CPU/memory/disk, provider cost, changed evidence, duplicate context, and exact reuse/rerun reasons. |
| Quality fallback | Legacy opt-in primitive; protected originals planned for D2 | Existing fallback does not close the future byte-for-byte protected-original, storage/privacy, corruption, and recovery acceptance matrix. |
| Agent wrappers | Shipped | Codex, Claude Code, and Copilot receive the same five user-level bridge skills; approved repair execution uses bounded agent-specific adapters, linked-worktree identity, byte-verified external run state, and process-level disposable lifecycle UAT without repository-local adapters. |

No resident daemon, mandatory cloud control plane, heavyweight always-on database, formal workflow
engine, or human-facing ceremony explosion is planned. Release journals cover only side-effecting,
idempotency-critical operations; immutable artifacts stay bounded and garbage-collectable. Users may
always use native Git/agent tools, with Rizz simply withholding unattained attestations.

The product target is not maximum compression. It is minimum wasted cognition per accepted,
verified change. A cheaper loop that produces slop, rereads the repository, or weakens evidence is a
resource regression.

## Current Loop

1. Calibrate Architecture Reasoning so capped large-repo UAT scores service-to-flow causality,
   impact maps, cross-component relationship evidence, what-breaks claims, and confidence debt
   separately.
2. Scorecard reporting after each UAT run: planned score, actual repo capability score, and
   remaining distance to 100.
3. Use bounded UAT on complex repos such as `github/docs` and `vercel/next.js` to choose the next
   weakest capability instead of guessing.
4. Full local gate: `pnpm check`, `pnpm pack:check`, `git diff --check`.

The current slice exposes the isolated project OS through a zero-dependency stdio MCP server. Every
supported read has a stable `rizz://` resource or structured tool result; mutations require exact
project, repository revision, and loop sequence matches. Rizz remains the evidence/orchestration
layer and performs no model call.

## Capability Scorecard

These are the orchestrator baseline scores for planned work. UAT reports also include actual
repo-derived scores from `<project-workspace>/research/understanding_score.json`.

| Planned item | Current | Remaining | Next improvement |
| --- | ---: | ---: | --- |
| Flow Understanding | 95/100 | 5 | Broaden real Flask/FastAPI UAT seeds and verify more multi-file Python route/service journeys. |
| Architecture Reasoning | 95/100 | 5 | Reduce weak component boundary assumptions and calibrate causality on more large Python services. |
| Evidence Quality scoring | 100/100 | 0 | Preserve actionability while keeping packet output compact. |
| Mission Control UX | 100/100 | 0 | Keep unified packet drilldowns visible without clutter. |
| PI-Bench seed/task format | 99/100 | 1 | Broaden deterministic task coverage and UAT fixtures. |
| Incremental Understanding metrics | 100/100 | 0 | Preserve exact reuse and relationship-delta accounting across broader real-repo scans. |
| Review Intelligence with true blast radius | 100/100 | 0 | Preserve authored/generated separation and credential precision across broader real-repo reviews. |
| Verification Plan + Evidence Ingest | 100/100 | 0 | Preserve fingerprint-bound evidence and signoff reuse while keeping ingestion deterministic and local. |
| `rizz ask` | 95/100 | 5 | Narrow broad component evidence and improve confidence calibration for exact file questions. |

## Latest Baton Result

Run: `feature/precision-context-milestone-a`, Precision-First Closed Loop Milestone A: context
precision.

| Check | Result |
| --- | ---: |
| Focused Task 1–3 + adversarial inventory suites | 53/53 passed |
| 3,097,813-byte Vitest inventory | Valid JSON; 3,016 emitted/accounted bytes; 19,992 source and 19,992 evidence entries truncated |
| FastAPI/Vitest 20,000-item metamorphic fixtures | 2/2 passed; admitted evidence invariant; translated docs excluded |
| Shared CLI/MCP mission + Task Brief parity | Passed for task/scope/status/skill inputs; same complete brief, mission ID, agent, revision, and selected skill digests |
| Explicit/proposed and citation QA | Passed; proposed/open paths nonblocking; unsupported AI inference rejected |
| Full unit suite | 518/518 passed |
| PI-Bench | 25/25 passed |
| PI-Bench average research readiness | 76/100 |
| CLI process smoke | 20/20 passed |
| Install-local smoke | 5/5 passed |
| Simplifier/review-loop | Context-precision findings repaired: mission-anchored changed/test neighbors, skill enablement verification, shared-surface CLI/MCP parity, canonical mission binding, claim-first budgeting, and current runbook evidence; local follow-up fixed aggregate/stopword false positives. |
| Public package contents | Passed: brain 85, providers 65, core 19, TUI 13, CLI 6 files |
| Targeted formatting/lint + strict typecheck | Passed |
| Diff whitespace check | Passed |
| Footprint | Passed: 49ms cold start, 200KB counted core (brain remains opt-in) |
| Full `pnpm check` | Passed |

Stable named local/CI precision command:

```bash
pnpm test:precision
pnpm typecheck
pnpm biome check <Task-1-to-3 implementation/test/fixture files>
git diff --check
```

Current verdict: Rizz now prepares a bounded evidence packet instead of acting as a reasoning
engine. Exact anchors and direct changed-file/test-neighbor evidence stay stable as irrelevant
inventory grows. Generic-only overlap remains excluded. Briefs are valid whole JSON under the
approved 32 KiB serialized ceiling with honest gaps and exact byte/truncation accounting.

Mission preview binds project/revision/agent and verified immutable skill identities. Explicit
constraints and accepted non-goals remain distinct from cited AI proposals. Risk provenance is
preserved as explicit, deterministic signal, or AI-inferred hypothesis. Rizz validates path/symbol/
evidence citations and rejects unsupported references. Open or proposed host paths can be recorded
without a redundant Rizz approval; risky external skills retain their separate explicit gate.
Persisted mission content is rehashed during verification, so changed repository revision, skill
pin/cache, or contract bytes invalidate identity. CLI and MCP carry the same mission pointer inside
the byte-bounded brief.

No default model call, production dependency, compression, cache, reversible retrieval, image
encoding, release attestation, or remote release operation was added. The counted default core
remains at the 200KB ceiling; brain functionality remains opt-in.

`pnpm test:precision` is now the stable named Milestone-A regression and a Linux CI step. It runs the
focused Task 1–3/adversarial fixture suites plus the default-core footprint guard. Milestone E expands
the multi-repository corpus and product calibration; it is not the first owner of this regression.

### Next Weakest-Capability Track

Execute Milestone B: deterministic `ReviewEvidencePacket`, host-AI finding/citation contract,
revision-independent `finding_key`, revision-bound observations, freshness-aware evidence,
mission-scoped correction admission, baseline-debt separation, and convergence/no-progress behavior.
Milestone D1 context-efficiency prototypes may proceed independently from A identities. Do not begin
local-green or release machinery until the B review identities are stable.

## Previous Agent Repair Execution Result

Run: `feature/agent-repair-execution`, opt-in agent repair handoff track milestone 2:
approval-gated bridge consumption in an isolated worktree.

| Check | Result |
| --- | ---: |
| Focused repair/project/bridge tests | 31/31 passed |
| Full unit suite | 481/481 passed |
| PI-Bench | 25/25 passed |
| PI-Bench average research readiness | 76/100 |
| CLI process smoke | 20/20 passed |
| Install-local smoke | 5/5 passed |
| Code-simplifier focused suite | 63/63 passed |
| Diff whitespace check | Passed |
| Footprint | Passed: 52ms cold start, 200KB counted core |
| Full `pnpm check` | Passed with deterministic temp state rooted at `/tmp` |

Current verdict: `rizz repair execute --agent <codex|claude|copilot> --handoff <id>
--approve` regenerates and compares the exact handoff identity before execution. It refuses a
missing approval, malformed handoff, changed project/revision/artifact/packet selection, the primary
checkout, and any unprepared or non-linked worktree. The prompt cap is 16KiB so Copilot's required
programmatic prompt argument remains inside Windows process limits.

The opt-in bridge service uses fixed argument vectors without a shell: Codex runs ephemeral in a
workspace-write sandbox; Claude Code runs non-interactively in `acceptEdits`; Copilot receives only
write-tool permission with shell and URL tools explicitly denied. Output is secret-redacted and
capped before it is returned. SIGINT is converted to a structured cancellation.

Every started run writes a byte-verified `running` record and a byte-verified terminal
`completed`/`failed`/`cancelled` record under the isolated project store. Records contain digests and
byte counts rather than prompts or transcripts. Symlinked state directories are rejected, the
repository receives no `.rizz` state, and the execution contract disallows repository push. No real
third-party agent was invoked in tests; deterministic injected runners proved all three adapters.
No dependency or always-on core-path change was added.

## Previous Agent Repair Handoff Result

Run: `feature/agent-repair-handoff`, opt-in agent repair handoff track milestone 1: bounded,
agent-specific preview contracts.

| Check | Result |
| --- | ---: |
| Focused repair/project/context tests | 25/25 passed |
| Full unit suite | 475/475 passed |
| PI-Bench | 25/25 passed |
| PI-Bench average research readiness | 76/100 |
| CLI process smoke | 20/20 passed |
| Install-local smoke | 5/5 passed |
| Diff whitespace check | Passed |
| Footprint | Passed: 52ms cold start, 200KB counted core |
| Full `pnpm check` | Passed with deterministic temp state rooted at `/tmp` |

Current verdict: `rizz repair handoff --agent <codex|claude|copilot> --preview` now turns an
existing isolated `agent_repair_packets` artifact into a deterministic, agent-specific preview. The
contract binds the selected project ID, current repository revision, source artifact digest, packet
IDs, permitted files, verification actions, and stop conditions. It caps the request at eight
packets, sixteen files, twelve verification actions, a 1MiB source artifact, and a 16KiB rendered
prompt.

Preview is deliberately non-executing: it requires approval for any future consumption and reports
that it performs no agent execution, repository write, project-state write, provider call, or
network access. External packet artifacts are treated as hostile input; malformed enums, duplicate
IDs, inconsistent counts, absolute paths, traversal paths, Windows drive paths, UNC paths, and NUL
bytes are rejected with structured errors. No dependency or always-on core path changed.

### Next Milestone

Add opt-in bridge consumption for Codex, Claude Code, and Copilot. Consumption must revalidate the
exact handoff identity and repository revision, require explicit approval, run only in an identified
isolated worktree, return structured results, support cancellation, and remain outside the default
core path.

## Previous Agent Skill Context Result

Run: `feature/agent-skill-context-uat`, upstream skill-manager track milestone 3: isolated,
agent-compatible project context and live upstream UAT.

| Check | Result |
| --- | ---: |
| Focused context/enablement/discovery/MCP tests | 34/34 passed |
| Focused formatting check | Passed |
| Typecheck | Passed |
| Lint | Passed |
| Full unit suite | 472/472 passed |
| PI-Bench | 25/25 passed |
| PI-Bench average research readiness | 76/100 |
| CLI process smoke | 20/20 passed |
| Install-local smoke | 5/5 passed |
| Pack/public check | Passed |
| Diff whitespace check | Passed |
| Footprint | Passed: 49ms cold start, 200KB counted core |
| Full `pnpm check` | Passed with deterministic temp state rooted at `/tmp` |

Current verdict: project enablement now carries the pinned skill's exact source ID, repository,
revision/path, whole-skill and `SKILL.md` digests, license, attribution, audit status/findings,
requirements, and approved agent set into the external project manifest. `rizz brief --agent` returns
only skills enabled for that agent; the MCP `get_task_brief` tool accepts the same agent selector and
returns the same structured evidence. Existing no-agent brief calls retain their prior all-enabled
behavior.

The CLI now preserves an explicitly supplied Rizz home through project enablement and brief
compilation, so disposable projects cannot accidentally consult the user's default registry. State
remains in the isolated external project store. No repository manifest, instructions, ignore file,
agent configuration, or bundled upstream content is written or executed.

Disposable live UAT used a fresh external Rizz home and four fresh Git projects. For every case it
performed approved-source fetch, indexed search, exact selection preview, approved pin, approved
project enablement, prepare, CLI brief, and equivalent MCP brief. A mismatched agent returned zero
skills. All repositories remained clean and had no repository-local `.rizz` state.

| Project agent | Enabled upstream skill | Exact revision | Skill digest | `SKILL.md` digest | Context result |
| --- | --- | --- | --- | --- | --- |
| Codex | `openai-skills:skills/.curated/aspnet-core` | `49f948faa9258a0c61caceaf225e179651397431` | `975d7ccac5a9f84b858786a8c4e0a10c00dadcfc871e71f85520e54f6d3347a4` | `1f487ef3565e5ac1ee6c93cbeb9ac666292b30285877c82ddb0a77c9777fe92f` | CLI=MCP; incompatible filtered; repo clean |
| Claude Code | `anthropic-skills:skills/algorithmic-art` | `9d2f1ae187231d8199c64b5b762e1bdf2244733d` | `8c15717769d76330df4387b85402a3754d858b97749ae259d3365ea9ea394f89` | `3bc4092c09804853186524c826bc0621b940bb6122c05b84496dff95388e6eef` | CLI=MCP; incompatible filtered; repo clean |
| Copilot | `github-awesome-copilot:skills/acquire-codebase-knowledge` | `0aaced533251f5b86c69dfbc5e55db74c4b4d1af` | `7515f7241bef5b3d44e481e9a59427ecb45bd64fa786d2e798c4fae3c9dbb63b` | `7ca01711e1615171b26ce9e2729bedf041348d7fd0f24bc04e0d400dc93e41b9` | CLI=MCP; incompatible filtered; repo clean |
| Agent Skills | `superpowers:skills/brainstorming` | `d884ae04edebef577e82ff7c4e143debd0bbec99` | `a1202a6a5e8d86659745e69030c06bfb033f265d8a276f29b24b8a57c4809399` | `e14914605f640e0841758e45d0ab2a53243b59b921f929e47921c99668f2e61d` | CLI=MCP; incompatible filtered; repo clean |

### Next Weakest-Capability Track

The next three-milestone track is **opt-in agent repair handoff**. It targets Coding agent
implementation (73/100, 27 remaining) first and Coding agent repair (78/100, 22 remaining) second,
the two weakest stages in the current human-agent loop:

1. Build a bounded, agent-specific repair handoff that selects exact correction-packet evidence and
   previews every proposed scope/verification constraint without executing an agent.
2. Add opt-in Codex, Claude Code, and Copilot bridge consumption with explicit approval, isolated
   worktree identity, structured results, cancellation, and no always-on core dependency.
3. Prove disposable handoff-to-repair-to-verification UAT across all three bridges, including stale
   revision refusal, project isolation, interrupted-run recovery, and repository ownership checks.

## Latest Alembic Real-Repo UAT

Run: fresh scans from `feature/alembic-real-repo-uat`, no provider calls.

| Target | Result | DBMS evidence |
| --- | --- | --- |
| `miguelgrinberg/microblog` | 72 files in 3.1s; 3 components, 23 flows; capability average 87/100, Architecture Reasoning 61/100. | 16 table entities, including 11 Alembic and 5 SQLAlchemy entities; 7 foreign-key relationships, 0 unknown targets. |
| `fastapi/full-stack-fastapi-template` | 217 files in 14.7s; 6 components, 49 flows, 11 commands, 29 tests; capability average 87/100, Architecture Reasoning 61/100. | 7 Alembic table entities; 3 foreign-key relationships, 0 unknown targets. |
| `hotosm/tasking-manager` migrations | All 102 migration files in 1.03s; migration-only capability average 59/100 because the slice intentionally has no routes or tests. | 102 Alembic entities; 77 foreign-key relationships, 0 unknown targets; canonical dependency edges reduced from 675 to 66. |
| `hotosm/tasking-manager` full repo | All 1,515 files completed in 112.2s; 8 components, 417 flows, 16 commands, 496 tests; capability average 89/100, Architecture Reasoning 66/100. | Full migration and application analysis now completes inside the 180s UAT cap; redaction safety remains 100 with zero unsafe sensitive references. |

## Latest DBMS-Like UAT Agent Results

Run: QA sidecar on public DBMS-style repos, using fresh rizz `develop` and temp target clones.

| Repo | rizz result | Usefulness | Speedup | Main misses |
| --- | --- | ---: | ---: | --- |
| `iampranavdhar/Library-Management-System-MERN` | 66 files, 2 components, 26 flows, 5 commands, 0 tests; backend/frontend split was useful. | 7/10 | 3-4x orientation speedup | Addressed this baton: nested package manager, Mongoose model entities, route review breadth, unusable test suggestions. Remaining: backend/frontend test ownership precision. |
| `manascb1344/Online-Auction-System` | 69 files, 3 components, 32 flows, 7 commands, 0 tests; client/server/database split and read-first paths were useful. | 6/10 | 2.5-3.5x orientation speedup | Addressed this baton: nested package manager, SQL table entities, controller review breadth, unusable test suggestions. Remaining: generic component wording and deeper SQL relationship parsing. |
| `Yogndrr/MERN-School-Management-System` | 101 scanned files, 2 components, 61 flows, 7 commands, 0 tests; nested npm and 7 Mongoose models detected. | 7/10 | 2-3x orientation speedup | Addressed this baton: frontend test leakage on backend diffs, controller service linking, noisy Mongoose option keys, parallel explain race. Remaining: exact controller-to-route handler semantics. |
| `sreyas-b-anand/dbms-mini-project` | 108 scanned files, 2 components, 15 flows, 4 commands, 0 tests; nested npm worked and wallet route review was narrow. | 6/10 | 2x orientation speedup | Addressed this baton: SQLAlchemy/Alembic entities, MySQL vs SQLite labeling, parallel explain race, Flask route-to-service/model causality. Remaining: deeper Python package edge cases and SQLAlchemy relationship parsing. |

UAT verdict: rizz is now a useful agent cold-start accelerator on DBMS-style repos, mostly for
boundary mapping, read-first orientation, route inventory, command ownership, and schema/entity
inspection. The next DBMS usefulness baton is SQLAlchemy relationship precision: relationship(),
ForeignKey, back_populates/backref, and cross-table blast radius for route/service flows.

## Latest DBMS UAT Actuals

Run: fresh DBMS brain scan on `/Users/lokesh/Downloads/projects/DBMS`, branch `dev`, using
`feature/file-explain-intelligence`.

| Metric | Result |
| --- | ---: |
| Files scanned | 491 |
| Components | 21 |
| Flows | 178 |
| Commands | 107 |
| Tests | 43 |
| Capability scorecard average | 93/100 |
| Raw understanding score | 89/100 |

Capability detail from `<project-workspace>/research/understanding_score.json`:

| Capability | Actual | Remaining | Notes |
| --- | ---: | ---: | --- |
| Flow Understanding | 95/100 | 5 | 178 high-signal flows; 170 with linked tests. |
| Architecture Reasoning | 79/100 | 21 | Exact consumers, local test gaps, and one service causality path remain weak. |
| Evidence Quality scoring | 98/100 | 2 | Strong evidence coverage with remaining entity/field-specific gaps. |
| Mission Control UX | 100/100 | 0 | Component, flow, architecture, and read-first surfaces are visible. |
| PI-Bench seed/task format | 98/100 | 2 | Needs more real-repo task seeds and deeper ground truth. |
| Incremental Understanding metrics | 88/100 | 12 | First scan baseline; repeated-scan reuse still needs proof. |
| Review Intelligence with true blast radius | 92/100 | 8 | Needs stronger user-visible failure causality. |
| `rizz ask` | 93/100 | 7 | Still blocked until foundations are consistently strong. |

DBMS verdict: the original app-boundary failure is fixed, and file explanations now include
content-derived purpose. The remaining DBMS weakness is not speed; it is precision around
architecture causality, component-local proof, and compact agent entry summaries.

## Latest 120-File UAT Actuals

Run: `scripts/uat-large-repos.mjs --max-files 120 --timeout-ms 90000`
Historical report: `<historical-uat-workspace>/repair-packet-precision-120-report.json`

| Capability | Matrix score | Remaining | Previous matrix score | Movement |
| --- | ---: | ---: | ---: | ---: |
| Flow Understanding | 91/100 | 10 | 91/100 | 0 |
| Architecture Reasoning | 84/100 | 16 | 84/100 | 0 |
| Evidence Quality scoring | 100/100 | 0 | 100/100 | 0 |
| Mission Control UX | 100/100 | 0 | 100/100 | 0 |
| PI-Bench seed/task format | 97/100 | 3 | 97/100 | 0 |
| Incremental Understanding metrics | 88/100 | 12 | 88/100 | 0 |
| Review Intelligence with true blast radius | 91/100 | 9 | 91/100 | 0 |
| `rizz ask` | 92/100 | 8 | 92/100 | 0 |

Repo detail:

| Repo | Architecture score | Remaining | Local evidence gap flows | Static runtime verification flows | Weakest capability |
| --- | ---: | ---: | ---: | ---: | --- |
| `github/docs` | 79/100 | 21 | 0 | 113 | Architecture Reasoning, 79/100 |
| `vercel/next.js` | 89/100 | 11 | 0 | 100 | Incremental Understanding metrics, 88/100 |

Precision notes:

- `github/docs` no longer reports `113 flow(s) need local evidence`; it reports 113 weak flows as
  static runtime-verification debt with 0 local-evidence gap flows. `component:src` is verified from
  15 direct entrypoints, 44 local tests, 8 local configs, and 8 read-first files; `component:config`
  remains inferred with 8 read-first files and now gets a priority-1 correction packet for missing
  component-local config/test/entrypoint/flow evidence.
- `vercel/next.js` no longer reports `101 flow(s) need local evidence`; it reports 101 weak flows as
  static runtime-verification debt with 0 local-evidence gap flows. `component:scripts` is verified
  from 52 direct entrypoints, 2 local configs, and 8 read-first files, while now getting a priority-1
  correction packet for 0 local tests; `component:test` is verified from 3 direct entrypoints, 32
  local tests, 4 local configs, and 8 read-first files.
- Runtime verification remains explicit in `flow_evidence_precision`; local static evidence does not
  upgrade script-derived flows to verified architecture confidence, and correction packets do not
  claim repairs were performed.
- Unified repair packets preserve provenance instead of collapsing all guidance into one opaque
  instruction: `github/docs` produced 10 packets with 1 architecture packet, 2 evidence-quality, 6
  security, and 1 tool packet; its P1 `component:config` correction packet folded
  `assumption:component:config:boundary` and the component low-confidence area into
  `related_packet_ids`. `vercel/next.js` produced 12 packets with 1 architecture, 9
  evidence-quality, 1 security, and 1 tool packet; `component:scripts` remains P1. Review-time
  packets add `review_blast_radius` and `verification` sources after `rizz review`.
