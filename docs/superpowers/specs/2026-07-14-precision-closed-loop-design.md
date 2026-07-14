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
15. Rizz or an optional provider connector revalidates the exact remote head, CI, review state,
    branch protection, required signoff, and repository policy, then issues `merge_ready` for that
    exact remote head.
16. The host explicitly invokes merge.

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
evidence. The host AI produces `ReviewFinding` objects with stable IDs, origin, status, confidence,
and citations. Rizz validates citation existence and recorded relationships, not the semantic truth
of a conclusion.

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

### Local green and merge readiness

`local_green` means one exact local commit passed required local review and verification and may be
pushed/submitted. It is issued only after commit and committed-tree equivalence proof. A changed
commit, tree, mission, evidence, config, verification plan, required signoff, policy, skill digest,
or toolchain invalidates it as defined by the invalidation matrix.

`merge_ready` means one exact remote PR/MR head passed required CI, reviews, branch protection,
signoff, and repository policy. A force-push, amended commit, remote-head change, stale/changed CI,
review-state change, policy change, or required-signoff change invalidates it. Local green and merge
readiness are separate evidence states, never autonomy modes.

### Release operation journal

Future release capabilities are composable and explicit: commit, push, submit/open PR-or-MR, and
merge. Candidate CLI spellings such as `rizz submit --pr` and `rizz merge` are provisional; the
provider-neutral contract must support GitLab MRs and other equivalents.

Each operation has a stable operation ID, phase receipts, exact local/remote SHA checks, partial
success recording, and recovery. Retrying after a timeout must discover prior remote success and
must not duplicate commits, branches, PRs/MRs, comments, or merge attempts. The journal records the
exact next safe action.

## Efficient deterministic verification

### Revision-addressed incremental DAG

Reusable verification evidence is keyed by:

- committed tree or working-snapshot digest;
- exact command/argv and working directory;
- relevant secret-redacted environment/toolchain fingerprint;
- config and lockfile digest;
- verification-plan identity.

Every check records why it was reused, rerun, skipped, or invalidated. Targeted checks run during
repair; the complete required local gate runs once before local green. Rizz may ingest structured
agent evidence but independently reruns the policy-required minimum. It does not blindly rerun every
expensive check after an unrelated change.

### Delta context

After the initial bounded packet, Rizz sends only newly changed evidence, invalidations, and requested
hash-addressed expansions. It does not resend whole brains, transcripts, or Task Briefs each cycle.
Receipts track bytes/tokens delivered, cache hits, expansions, rereads, and duplicate evidence.

### Stable findings and convergence

Finding IDs derive from normalized claim, citations, and revision context. Equivalent findings are
deduplicated. No progress is detected from an equivalent diff, the same unresolved finding, and no
new evidence. The loop stops/escalates instead of burning agent calls. Repair cost/time ceilings are
hard but are not substitutes for reporting the exact convergence reason.

### Baseline versus head

Verification classifies failures as introduced regression, pre-existing baseline debt,
infrastructure failure, or suspected flake. Existing unrelated debt cannot silently become active
repair. Suspected flakes use capped, fully recorded reruns. A required flaky check never silently
produces green. Infrastructure/provider outages remain in the report but are excluded from product
quality metrics.

## Trust and security

Repository comments, docs, filenames, and tool output are untrusted quoted evidence, never
instructions. Instruction provenance and precedence are explicit. Rizz does not execute repository
text. Inputs must cover malicious Unicode/control filenames, ANSI/log injection, traversal,
case-only changes, symlinks, submodules, LFS pointers, shallow/detached repositories, renames, and
large or decompression-bomb-like artifacts. Protected exact originals round-trip byte-for-byte.

## Staged milestones and dependencies

- **Milestone A — Context precision (implemented now):** mission-scoped literal relevance, 32 KiB
  whole-JSON Task Brief budget, versioned mission identity, verified pinned-skill preview, explicit
  versus proposed provenance, citation validation, nonblocking proposed/open scope, CLI/MCP parity,
  and large-inventory fixtures. No release machinery, context compression, cache, retrieval, image
  encoding, model dependency, or extra default model call.
- **Milestone B — Review and repair precision:** `ReviewEvidencePacket`, host-AI finding/citation
  contract, stable finding IDs, mission-scoped correction admission, baseline-debt separation, and
  convergence/no-progress behavior.
- **Milestone C — Local verification and release journal:** working-snapshot receipts, incremental
  verification DAG, commit-before-local-green, `local_green`, explicit commit/push/submit
  capabilities, and idempotent crash-safe release journal.
- **Milestone D — Delta context and protected optimization:** delta packets, cache/optimization
  receipts, exact-original protection, and native lossless handling for protected evidence.
- **Milestone E — Remote readiness and calibration:** `merge_ready`, remote TOCTOU/release
  calibration, metamorphic/fault-injection/seeded-defect corpus, three-repository provider
  calibration, and falsifiable product metrics.

Dependencies run A → B → C, while D depends on A–C identities and E depends on B–D plus optional
provider connectors. Every milestone preserves the single-agent lightweight default and adds no new
always-on production dependency.

## Non-goals

- No semantic reasoning engine inside deterministic relevance.
- No Rizz-owned default model call or host-agent replacement.
- No inferred accepted non-goals or handcrafted semantic architecture decisions.
- No Rizz autonomy modes or reinterpretation of host approval behavior.
- No single state that conflates local verification with remote merge readiness.
- No pre-commit final green.
- No magic one-step release umbrella.
- No provider availability requirement in deterministic unit gates.
