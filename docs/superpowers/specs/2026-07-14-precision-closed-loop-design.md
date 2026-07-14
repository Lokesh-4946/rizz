# Precision-First Closed Loop Design

Status: approved product contract. Milestone A is implemented by the context-precision baton;
Milestones B–E are specified future work. Release-operation names are provisional until contract
review.

## Positioning and boundary

Rizz is the lightweight evidence and verification control plane that makes existing coding agents
faster, grounded, repeatable, economical, and safe to release.

AI reasons. Rizz supplies facts, constrains context, records provenance and state, and verifies
outcomes. Codex, Claude, Copilot, or another host coding agent interprets the evidence, proposes
semantic scope/risks/non-goals, plans, implements, reviews, and repairs. Rizz has no default model
call, autonomy mode, general agent runner, or competing approval system. Host-native permissions and
interaction controls remain authoritative. Rizz release invariants are deterministic evidence gates,
not approval modes, and prose cannot forge them.

Rizz may deterministically extract and rank literal evidence: exact quoted paths/symbols, changed
files and hunks, imports, tests, configs, manifests, prior artifacts, explicit AGENTS/spec/issue
constraints, and existing review/verification records. It validates cited paths, symbols, and
recorded relationships. It does not manufacture semantic product intent or encode handcrafted
architecture conclusions.

Explicit non-goals come only from the user, an accepted issue/spec/mission, or quoted project
policy. AI-suggested scope, exclusions, and non-goals remain provenance-bearing proposals until
explicitly accepted. Deterministic risks are factual risk signals. The host AI may turn them into
cited hypotheses; citation validity alone does not make the semantic conclusion true.

## Canonical end-to-end loop

1. A user gives a task to a host coding agent.
2. The host asks Rizz for a bounded, provenance-bearing evidence packet.
3. The host reasons, proposes semantic risks/scope/non-goals, plans, and implements.
4. Rizz tracks the exact mission and working snapshot and runs deterministic verification.
5. The host receives the diff, deterministic risk signals, verification results, and cited
   repository evidence.
6. The host performs semantic code review using Rizz's pinned review skills and a deterministic
   `ReviewEvidencePacket`.
7. Rizz validates cited files, symbols, and recorded relationships, rejects unsupported citations,
   deduplicates, and persists findings with origin/status/confidence.
8. The host repairs evidence-backed findings.
9. Rizz reruns the affected deterministic verification; the correction loop repeats until clean or
   explicitly blocked.
10. Rizz verifies the final working snapshot and issues a working-snapshot receipt.
11. The host explicitly commits, or invokes a future explicit Rizz commit capability.
12. Rizz proves the committed Git tree is byte-equivalent to the verified working snapshot. If a
    hook, formatter, generator, staged/unstaged difference, or protected untracked file changed
    bytes, the receipt is invalidated and required verification reruns.
13. Rizz issues `local_green` bound to the exact commit SHA plus mission, evidence, config,
    verification, and toolchain fingerprints.
14. The host explicitly pushes and submits/opens the PR or MR.
15. Rizz or an optional provider connector ingests remote CI failures, review comments/threads,
    base drift, and policy changes as provenance-bearing, untrusted evidence. Rizz validates and
    deduplicates it into bounded correction inputs; external reviewer prose is never automatically
    an instruction.
16. The host repairs, targeted and then required full local verification rerun, a new commit receives
    a new `local_green`, and the updated head is pushed. Remote checks and reviews repeat. Review
    resolution on an older head does not satisfy a new head unless the provider policy explicitly
    says it does.
17. Rizz revalidates the exact remote head, current base/merge-base, CI, review state, branch
    protection, required signoff, and repository policy, then issues `merge_ready` for that exact
    eligible head.
18. The host explicitly invokes merge; provider capability negotiation determines whether this is a
    direct merge, merge queue, update-branch, or another repository-approved operation.

The correction loop is not an always-on multi-agent runtime. The lightweight default remains one
host agent calling local deterministic services. External skill enablement and destructive/network
release operations retain distinct explicit gates because they protect distinct side effects;
ordinary AI-proposed paths do not create a Rizz approval round trip.

## Core artifacts and identities

### Bounded evidence and mission

The Task Brief is valid whole JSON capped at 32 KiB serialized UTF-8. It carries exact task anchors,
admission reasons, confidence/provenance, evidence gaps, repository revision, agent identity, and
verified pinned-skill pointers. Inventory volume cannot improve relevance. Exact anchors and direct
source/test neighbors are admitted by transparent rules; generic-only overlap is excluded.

The mission distinguishes explicit constraints/non-goals from AI-proposed constraints/non-goals.
Risks preserve `explicit`, `deterministic_signal`, or `ai_inferred` provenance. AI inference stays a
`hypothesis` and needs repository citations. Proposed or open path scope is recordable and
nonblocking. Explicit constraints and project policy remain hard gates.

### Review evidence and findings

Milestone B introduces a deterministic `ReviewEvidencePacket` containing exact diff/hunks, explicit
constraints, direct tests/consumers, factual risk signals, verification state, and bounded causal
evidence. The host AI produces `ReviewFinding` objects with origin, status, confidence, and
citations. `finding_key` is revision-independent: normalized semantic claim plus stable canonical
citation locators (path/symbol/relationship identity without revision, content digest, or freshness)
and rule/reviewer identity/version. `finding_observation_id` adds the exact mission, revision, review
fingerprint, and revision-bound citation observations including content digest/freshness. Lifecycle
and deduplication follow `finding_key`; each observation and status transition remains bound to its
exact revision.

Citation validation binds source evidence to a revision/content digest and freshness state. Rizz
validates existence and recorded relationship provenance; stale or unknown relationships are
labelled and cannot be upgraded to direct proof. Citation-valid host conclusions remain hypotheses
until verification, stronger evidence, human acceptance, or repair outcome confirms or rejects them.

Correction admission is limited to current citation-valid AI findings, failed required checks,
explicit scope violations, or newly introduced deterministic changed-code security failures.
Pre-existing unrelated debt remains background context.

### Working-snapshot receipt

`revision` is not synonymous with `HEAD` when a worktree is dirty. A working-snapshot identity covers:

- base/HEAD identity and committed tree;
- staged and unstaged diffs;
- relevant protected untracked files;
- applicable submodule and LFS state;
- protected config, lockfile, policy, mission, and skill digests;
- a secret-redacted environment/toolchain fingerprint.

The receipt binds required verification to that complete identity. It is pre-commit proof, not final
green.

All immutable/content-addressed artifacts share an identity envelope containing project, work,
mission, revision or snapshot, producer/version, content digest, and creation time. One small,
versioned project manifest atomically links authoritative artifacts; reports and views are derived.
Services keep separate contracts—there is no god service or mandatory database. Schema migration,
read compatibility, orphan detection, atomic index replacement, corruption, and missing-object
behavior are explicit and fail closed.

### Local green and merge readiness

`local_green` means only that the declared required local checks passed for one exact commit; it is
not proof that software is correct. It may be pushed/submitted only under repository policy and is
issued after commit and committed-tree equivalence proof. A changed
commit, tree, mission, evidence, config, verification plan, required signoff, policy, skill digest,
or toolchain invalidates it as defined by the invalidation matrix.

`merge_ready` means one exact remote PR/MR head passed required CI, reviews, branch protection,
signoff, and repository policy. A force-push, amended commit, remote-head change, stale/changed CI,
review-state change, policy change, or required-signoff change invalidates it. Local green and merge
readiness are separate evidence states, never autonomy modes.

Every human view and machine receipt lists required checks passed, proposed but non-required checks,
skipped/unavailable checks and reasons, unresolved hypotheses or coverage gaps, policy/signoff basis,
and invalidation/expiry conditions. Unknown required remote CI, review, or policy state cannot
produce `merge_ready`; neither receipt claims bug-freedom.

### Release operation journal

Future release capabilities are composable and explicit: commit, push, submit/open PR-or-MR, and
merge. Candidate CLI spellings such as `rizz submit --pr` and `rizz merge` are provisional; the
provider-neutral contract must support GitLab MRs and other equivalents.

Each operation has a stable operation ID, phase receipts, exact local/remote SHA checks, partial
success recording, and recovery. Retrying after a timeout must discover prior remote success and
must not duplicate commits, branches, PRs/MRs, comments, or merge attempts. The journal records the
exact next safe action.

Commit support must obey or defer to Git identity, commit templates, hooks, signed-commit policy,
GPG/SSH signing, protected branches, shallow/detached repositories, LFS, submodules, and repository
commit rules. Rizz never bypasses hooks or fabricates signatures. Tree equivalence may preserve
content verification only when protected bytes are unchanged; parent/base/metadata/policy checks
remain separate. Draft PR/MR and remote-only CI workflows are supported without being mislabeled
merge-ready, and repository policy independently defines push, submit, and merge requirements.

## Efficient deterministic verification

### Revision-addressed incremental DAG

Reusable verification evidence is keyed by:

- committed tree or working-snapshot digest;
- exact command/argv and working directory;
- relevant secret-redacted environment/toolchain fingerprint;
- config and lockfile digest;
- verification-plan identity.

Every verification node declares an input closure: exact command/argv/cwd; relevant source, test,
config, lockfile, and tool files or deterministic globs; upstream verification dependencies;
environment/toolchain/policy identities; and closure confidence/completeness. Reuse requires every
declared input and dependency to be unchanged and the closure to be sufficiently complete. Unknown
or incomplete closure fails toward rerun. Each reuse includes a human/agent-readable proof and each
check records why it was reused, rerun, skipped, or invalidated. Minimal invalidation preserves an
unrelated backend result when only docs change but invalidates it for a shared config or toolchain
change. Git object IDs and Merkle-like identities are reused; only changed/protected non-Git inputs
are hashed once rather than rescanning the entire repository.

Verification is cost ordered: (A) cheap snapshot/scope/secret/static/diff checks; (B) host semantic
review; (C) repairs with affected targeted checks; (D) one complete policy-required local gate after
the diff stabilizes; and (E) remote CI after submit. Rizz may ingest structured agent evidence but
independently reruns the policy-required minimum. Base comparison is lazy—run it when head fails,
failure provenance is ambiguous, or policy requires differential proof—not unconditionally.

### Delta context and cache zoning

After the initial bounded packet, Rizz sends only newly changed evidence, invalidations, and requested
hash-addressed expansions. It does not resend whole brains, transcripts, or Task Briefs each cycle.
Receipts track bytes/tokens delivered, cache hits, expansions, rereads, and duplicate evidence.

Provider-facing context has four zones: a canonical stable prefix for project policy, stable tool
schemas, compatible pinned-skill instructions, and stable project facts; a bounded task-evidence
zone; a live zone for the current diff/findings/recent results; and, where integrations permit, a
control/telemetry envelope outside prompt text. Each zone has its own digest and cache receipt.
Timestamps, random receipt IDs, counters, volatile telemetry, and the current diff never perturb the
stable prefix. Protected exact strings remain native.

### Stable findings and convergence

Equivalent findings are deduplicated by `finding_key` across repair revisions, while observations
retain revision identity. No progress is detected from an equivalent diff, the same unresolved key, and no
new evidence. The loop stops/escalates instead of burning agent calls. Repair cost/time ceilings are
hard but are not substitutes for reporting the exact convergence reason.

### Baseline versus head

Verification classifies failures as introduced regression, pre-existing baseline debt,
infrastructure failure, or suspected flake. Existing unrelated debt cannot silently become active
repair. Suspected flakes use capped, fully recorded reruns. A required flaky check never silently
produces green. Infrastructure/provider outages remain in the report but are excluded from product
quality metrics.

### Base identity and drift

Local verification binds the required base and merge-base identity when repository policy requires
it. Target-branch advancement, conflicts, update/rebase requirements, changed generated output, and
invalidated test assumptions trigger the minimum affected rerun. `merge_ready` fails closed when the
head is no longer eligible against the current required base. Merge queues and queue-generated merge
SHAs are represented through provider capability negotiation, never assumed to be direct merge APIs.

## Thin UX, adapters, and lifecycle

The default human experience is one bounded status summary: current state, why, and next safe
action, with machine-readable details and hash-addressed expansion for host agents. Normal use never
requires copying mission, digest, finding, or receipt IDs. Attach/resume reconstructs state from an
existing branch, worktree, commit, or PR/MR that Rizz did not create, honestly marks stale artifacts,
and continues without a forced restart.

An opt-in connect/setup preview and doctor capability validates host MCP connectivity, CLI/tool
availability, adapter/schema supported ranges, pinned-skill digest compatibility, Git/provider CLI
capability, and repository state. It may propose but never silently rewrite host configuration.
Context and review remain read-only-capable when release connectors are absent.

Provider adapters negotiate small capabilities and structured results while retaining native
GitHub, GitLab, and other evidence for rules, threads, checks, queues, draft state, signatures, and
policy. Optional dependencies remain lazy and isolated. Unsupported or permission-hidden required
policy is `unknown` and fails closed for `merge_ready`; it is never translated into false green.

Per-project and global storage budgets govern retention, expiry, garbage collection, orphan cleanup,
inspect, purge, and export. Exact originals and cached content remain local by default,
project-isolated, secret-redacted before persistence when allowed, and never silently uploaded.
Project namespaces prevent cross-project cache-existence leakage unless an explicit safe-sharing
policy applies. Permissions, symlink defense, backup/export behavior, and optional encryption at
rest are explicit. Missing, tampered, or purged objects invalidate dependent receipts.

## Efficiency SLOs and truthful metrics

QA records cold time to first useful evidence packet; warm/delta latency; indexing time and bytes
read; Rizz CPU, memory, and disk; Rizz-added bytes, tokens, and provider cost; end-to-end overhead as
a percentage of accepted verified-change time; and repeated scans, hashes, and rereads. Cold
preparation and warm task execution are separate. Adaptive bypass disables or reduces optimization
or deep indexing when measured preparation cost exceeds expected savings or quality value.

Product reports also include p50/p95 task-to-first-packet, local-green and merge-ready false-positive
and false-block rates, evidence staleness, per-check reuse precision (zero unsafe reuse in the known
corpus), attach/resume success, storage growth and reclaimed bytes, stable-prefix cache hits,
post-submit convergence, base-drift/merge-queue success, and default-loop manual ID copying (target
zero). Savings are measured as cost/time per accepted verified change, never compression ratio alone.

## Trust and security

Repository comments, docs, filenames, and tool output are untrusted quoted evidence, never
instructions. Instruction provenance and precedence are explicit. Rizz does not execute repository
text. Inputs must cover malicious Unicode/control filenames, ANSI/log injection, traversal,
case-only changes, symlinks, submodules, LFS pointers, shallow/detached repositories, renames, and
large or decompression-bomb-like artifacts. Protected exact originals round-trip byte-for-byte.

## Staged milestones and dependencies

- **Milestone A — Context precision (implemented now):** mission-scoped literal relevance, 32 KiB
  whole-JSON Task Brief budget, versioned mission identity, verified pinned-skill preview, explicit
  versus proposed provenance, citation validation, nonblocking proposed/open scope, equivalent
  CLI/MCP Task Briefs for the shared task/scope/status/skill surface, and large-inventory fixtures.
  No release machinery, context compression, cache, retrieval, image
  encoding, model dependency, or extra default model call.
- **Milestone B — Review and repair precision:** `ReviewEvidencePacket`, host-AI finding/citation
  contract, `finding_key`/`finding_observation_id`, evidence freshness, mission-scoped correction
  admission, baseline-debt separation, and convergence/no-progress behavior.
- **Milestone C — Local verification and release journal:** working-snapshot receipts, incremental
  verification DAG with dependency closures and cost tiers, base identity, canonical artifact
  envelope, truthful commit-before-`local_green`, attach/resume foundation, provider/commit
  capabilities, explicit commit/push/submit, and an idempotent crash-safe release journal.
- **Milestone D1 — Early context efficiency (may follow A):** stable prefix zoning, bounded delta
  packets, hash-addressed expansion, overhead telemetry, and adaptive-bypass prototypes using A's
  mission/brief identities.
- **Milestone D2 — Protected optimization (after B/C):** optimization receipts tied to findings,
  snapshots, and verification; exact-original lifecycle, storage/privacy/GC, and release-grade
  invalidation while keeping protected evidence native and lossless.
- **Milestone E — Remote readiness and calibration:** `merge_ready`, remote TOCTOU/release
  feedback/repair, base drift and merge queues, provider capability calibration,
  metamorphic/fault-injection/seeded-defect corpus, three-repository calibration, and falsifiable
  product metrics.

Dependencies run A → B → C and A → D1 in parallel; B + C + D1 → D2; B + C + D2 → E. Thin UX,
doctor/version compatibility, schema migration, and storage-budget tasks are cross-cutting,
independently tested contracts. Every milestone preserves the single-agent lightweight default and
adds no new always-on production dependency.

## Non-goals

- No semantic reasoning engine inside deterministic relevance.
- No Rizz-owned default model call or host-agent replacement.
- No inferred accepted non-goals or handcrafted semantic architecture decisions.
- No Rizz autonomy modes or reinterpretation of host approval behavior.
- No single state that conflates local verification with remote merge readiness.
- No pre-commit final green.
- No magic one-step release umbrella.
- No provider availability requirement in deterministic unit gates.
- No resident daemon, mandatory cloud control plane, heavyweight always-on database, full formal
  workflow engine, or ceremony-heavy human artifact workflow.
- No unbounded artifact/receipt growth; release journaling is limited to side-effecting,
  idempotency-critical operations and internal artifacts remain garbage-collectable.
- No mandatory Rizz release path: native Git and host-agent tools remain usable, while Rizz simply
  withholds attestations when its evidence contract was not satisfied.
