# Precision-First Closed Loop Implementation Plan

This plan implements the approved design in dependency order. It describes capabilities first;
release CLI names are provisional contracts. Internal readiness scorecards are planning aids, not
release proof.

## Milestone A — Context precision (current baton)

### Implemented scope

1. Mission-scoped relevance uses literal quoted paths/symbols, filename/symbol anchors, and direct
   source/test evidence. Generic-only overlap and inventory-only aggregates are excluded. Adding or
   duplicating unrelated inventory cannot improve rank.
2. Task Briefs serialize as whole valid JSON under an enforced 32 KiB UTF-8 ceiling, with exact
   emitted-byte accounting, bounded claims/files/evidence IDs/summary text, explicit truncation, and
   Result-shaped envelope failure.
3. Mission preview binds project, Git revision, host agent, proposed/explicit scope status,
   constraints, non-goals, risk provenance, and verified pinned-skill digests. Explicit constraints
   and accepted non-goals remain separate from AI proposals. Unsupported AI citations fail.
4. Open or proposed host scope is persisted without a separate Rizz path-approval gate. A risky
   external skill remains a distinct explicit blocker. CLI/MCP previews and Task Brief identity are
   semantically equivalent.
5. The default path stays single-agent, local-first, deterministic, and model-free with no new
   production dependency.

### Milestone-A acceptance

- Former multi-megabyte Vitest inventory produces valid JSON at ≤32 KiB with exact byte accounting.
- FastAPI content-heavy inventory excludes translated docs and unrelated graph/inventory evidence.
- Inflating source/evidence inventory cannot improve relevance.
- Generic-only overlap is excluded; exact anchors and direct source/test neighbors are admitted.
- CLI and MCP Task Brief payloads are semantically identical.
- Explicit constraints/non-goals and AI proposals stay separate; unsupported AI citations fail.
- Proposed/open paths are nonblocking; explicit constraints and risky-skill gates retain provenance.
- Focused Task 1–3 suites, strict typecheck, targeted formatting/lint, whitespace, full check,
  packaging, and footprint pass from fresh output.
- `pnpm test:precision` is the stable local/CI regression for the multi-megabyte Vitest inventory,
  FastAPI exclusion, rank invariance, CLI/MCP parity, mission provenance/citation validation, and
  footprint-preserving context behavior. Milestone E expands this corpus; it does not create it.

## Milestone B — Review and repair precision

### Deliverables

- Deterministic `ReviewEvidencePacket`: exact diff/hunks, explicit constraints, direct
  tests/consumers, factual risk signals, verification state, and bounded causal evidence.
- Host-AI `ReviewFinding` contract with origin, status, confidence, and citations.
- Revision-independent `finding_key` from normalized semantic claim, canonical citations, and
  rule/reviewer identity/version; revision-bound `finding_observation_id` from the key plus exact
  mission/revision/review fingerprint. Lifecycle continuity follows the key, while every observation
  and status transition retains its revision.
- Citation and recorded-relationship validation bound to source revision/content digest and
  freshness. Stale/unknown relationships are labelled and never promoted to direct proof.
- Deduplication, current-finding correction admission, baseline-debt separation, and exact
  no-progress/convergence reasons.
- Correction packets only from citation-valid current AI findings, failed required checks, explicit
  scope violations, or new deterministic changed-code security failures.

### Acceptance

- Adding thousands of unrelated graph edges or duplicate evidence does not change task findings or
  repair priority.
- The same issue across repair revisions retains `finding_key` and receives a new observation ID;
  changed claim/citations create a new key; equivalent input order does not.
- Citation-valid hypotheses remain hypotheses until verification, stronger evidence, human
  acceptance, or repair outcome changes status.
- Base/head differential cases distinguish introduced regression, fixed baseline debt, unchanged
  baseline debt, infrastructure failure, and capped suspected flake.
- Equivalent diff + unresolved finding + no new evidence stops with an explicit no-progress reason.

## Milestone C — Working snapshots and local release

### Deliverables

- Working-snapshot identity covering HEAD/base, staged/unstaged diffs, protected untracked files,
  submodule/LFS state, and protected config/lockfile/policy/mission/skill digests.
- Environment receipt with bounded OS/arch, runtime/package-manager/tool versions, relevant
  secret-redacted environment identity, and configuration digests.
- Revision-addressed incremental verification DAG keyed by snapshot/tree, exact argv/cwd,
  environment/toolchain, config/lockfile, and verification-plan identity.
- Every node declares exact source/test/config/lockfile/tool inputs or deterministic globs, upstream
  dependencies, environment/toolchain/policy identity, and closure confidence/completeness. Reuse
  requires a complete unchanged closure and emits a readable proof; unknown closure reruns.
- Cost tiers: cheap snapshot/scope/secret/static/diff checks; host semantic review; repair with
  targeted checks; one full policy-required local gate after stabilization; remote CI after submit.
  Base comparison is lazy unless head failure is ambiguous or policy explicitly requires it.
- Base and merge-base identity, target drift/conflicts/update policy, and generated/test assumptions.
  Reuse Git object identities and hash changed/protected non-Git inputs, not the entire repository.
- Pre-commit working-snapshot receipt, explicit commit capability, byte-equivalence proof after
  commit, and `local_green` bound to exact commit plus mission/evidence/config/verification/toolchain
  fingerprints.
- Truthful green views list required passes, proposed non-required checks, skipped/unavailable checks,
  hypotheses/gaps, policy/signoff basis, and invalidation/expiry. Green never claims correctness.
- Immutable content-addressed artifacts with a shared identity envelope and one small versioned,
  atomically updated project manifest; schema read compatibility, orphan/corruption behavior, and
  one authoritative artifact per fact.
- Attach/resume foundation for existing branches/worktrees/commits/PRs, with stale-state marking and
  no manual ID-copy workflow.
- Explicit push and provider-neutral submit/open-PR-or-MR capability with stable operation IDs,
  phase receipts, partial success, discovery, and retry recovery.
- Commit/provider capability contracts for identity/templates/hooks/signing, protected branches,
  shallow/detached repositories, LFS/submodules, drafts, remote-only CI, and native provider policy.

### Acceptance

- One source byte, staged state, protected untracked file, lockfile/config, explicit mission
  constraint, skill digest, verification command, toolchain/policy digest, or commit change
  invalidates exactly the affected working receipt/local green.
- Commit-hook/formatter/generated changes prevent green until verification reruns.
- A changed local commit after green causes push/submit refusal.
- Killing verification/evidence writes yields one recoverable terminal owner/receipt.
- Timeout after remote PR/MR creation recovers the same review object without duplication.
- Retrying commit/push/submit never duplicates commits, branches, PRs/MRs, or comments and reports
  the exact next safe action.
- Unrelated docs preserve a backend-node reuse proof; shared config/toolchain input invalidates it;
  unknown closure reruns. Known-corpus unsafe reuse is zero.
- Required base advancement/conflict invalidates affected verification. Hooks/signing/policy are not
  bypassed, and tree equivalence never substitutes for parent/base/metadata policy checks.
- Attach/resume reconstructs an external branch/worktree/commit/PR without false-current artifacts.

## Milestone D1 — Early context efficiency (may follow A)

### Deliverables

- Stable provider prefix for project policy, tool schemas, compatible pinned skills, and stable facts;
  separate bounded task evidence, live diff/findings/results, and out-of-prompt control/telemetry.
- After the initial packet, emit only changed evidence, invalidations, and requested hash-addressed
  expansions using A's mission/brief identity.
- Track each zone digest plus bytes/tokens, cache hits, expansions, rereads, duplicate evidence,
  indexing time/bytes, CPU/memory/disk, and cold/warm latency.
- Adaptive bypass reduces deep indexing/optimization when measured preparation cost exceeds expected
  savings or quality value.

### Acceptance

- No correction cycle resends a full brain/transcript/Task Brief without an explicit expansion.
- Reordering inputs and object keys leaves semantic output unchanged.
- Volatile timestamps/receipt IDs/counters/telemetry/diffs do not perturb the stable-prefix digest;
  equivalent tasks retain canonical prefix bytes and protected exact strings remain native.
- Report p50/p95 first-useful-packet and warm-delta latency, scans/hashes/rereads, Rizz-added
  bytes/tokens/provider cost, and overhead percentage per accepted verified change.

## Milestone D2 — Protected optimization and lifecycle (after B/C)

### Deliverables

- Cache/optimization receipts bound to finding, snapshot, verification, and zone identities with
  explicit reuse/invalidation proofs.
- Protected exact originals remain native/lossless and round-trip byte-for-byte.
- Per-project/global storage budgets, retention/expiry, garbage collection, orphan cleanup, and
  inspect/purge/export operations.
- Local-by-default project isolation, allowed secret redaction before persistence, no silent upload,
  no cross-project cache-existence leakage, permissions/symlink defense, backup/export semantics,
  and optional encryption-at-rest policy.

### Acceptance

- Corrupted exact-original objects, partial writes, symlink swaps, redirected state, cancellation,
  clock skew, and concurrent ownership fail safely and recover deterministically.
- Optimization never changes protected content or weakens required evidence recall.
- Missing/tampered/purged objects invalidate dependent receipts; storage growth and reclaimed bytes
  are measured, and garbage collection cannot leave reusable-looking dangling receipts.

## Milestone E — Remote merge readiness and product calibration

### Deliverables

- `merge_ready` bound to exact remote PR/MR head, CI, review state, branch protection, required
  signoff, and repository policy.
- Post-submit loop ingests remote CI failures, review threads, base drift, and policy changes as
  untrusted provenance-bearing evidence; validates/deduplicates bounded correction inputs; and
  repeats host repair, local verification/new green, push, and remote review for the new head.
- Explicit merge capability with immediate remote-head/policy revalidation and a receipt bound to
  the merged remote SHA.
- Provider capability negotiation preserves native GitHub/GitLab/etc rules, threads, required
  checks, queues, draft/signing state, and policy. Hidden/unsupported required state is unknown and
  fails closed. Merge may require update/rebase or a provider queue rather than a direct API call.
- Opt-in setup preview/doctor validates host MCP, tools, adapter/schema supported ranges, pinned-skill
  compatibility, Git/provider capability, and repository state without rewriting host config.
- Read-only context/review remains usable without release connectors; optional dependencies stay
  lazy and isolated.
- Machine-readable QA corpus and falsifiable product metrics.

### Attestation invalidation matrix

Independently mutate one source byte, staged state, protected untracked file, lockfile/config,
explicit mission constraint, skill digest, verification command, toolchain/policy digest, local
commit, remote head, CI result, review state, and signoff. Assert that the correct working receipt,
`local_green`, or `merge_ready` artifact is invalidated—no more and no less.

### Fault injection and release TOCTOU

- Kill during verification/evidence writes and after push but before the submit record.
- Simulate timeout after PR/MR creation succeeded and recover the same object.
- Simulate force-push or stale remote head before merge.
- Advance the base/merge-base, require update/rebase, create conflicts, and exercise provider merge
  queues and queue-generated merge SHAs.
- Exercise partial writes, symlink swaps, redirected state, corrupt exact originals, cancellation,
  clock skew, and concurrent operation ownership.
- Change commit tree through hooks; change after local green; change remote rules, reviews, or
  signoff; and assert refusal at the correct boundary.
- Treat remote reviewer text as untrusted evidence and prove older-head resolution cannot satisfy a
  new head without explicit provider-policy semantics.
- Bind the merge receipt to the merged remote SHA.

### Metamorphic and security corpus

- Adding unrelated docs/vendor/generated trees does not alter bounded task packets or projections.
- Adding thousands of unrelated graph edges does not alter task findings/repair.
- Enumeration/object-key/equivalent-input reorder does not alter semantic output.
- Duplicated evidence cannot increase relevance or priority.
- CLI, MCP, and pinned-skill surfaces produce semantically equivalent contracts and receipts.
- Prompt injection in comments/docs/tool output stays quoted untrusted evidence.
- Cover Unicode/control filenames, ANSI/log injection, traversal, case-only changes, symlinks,
  submodules, LFS, shallow/detached repos, renames, and decompression-bomb-like artifacts.

### Seeded defects and differential QA

Use clean surgical negative controls and seeded defects across behavior, API compatibility, security
boundaries, migration/schema, dependency/lockfile, config-only, test-only, generated-only, and
type/comment-only changes. Include FastAPI, Vitest, and at least one different ecosystem. Exercise:

- base fails + head fails identically;
- base passes + head fails;
- base fails + head passes;
- intermittent results under capped reruns;
- infrastructure/provider outage preserved in reports but excluded from product metrics.

### Ground-truth metrics

Machine-readable reports include evidence-packet precision and required-evidence recall; citation
rejection and citation-valid finding acceptance/confirmation; missed seeded defects; false blocking;
repair convergence/no-progress stops; repeated reads and duplicate context bytes/tokens;
targeted/full verification reuse versus rerun; time, input/output/cache tokens, actual cost, and
rereads per accepted verified change; infrastructure-excluded runs; exact model/tool versions; and
warm versus cold preparation. They also include task-to-first-useful-packet p50/p95; local-green and
merge-ready false-positive/false-block rates; evidence freshness/staleness; per-check reuse precision
(zero unsafe reuse in the known corpus); attach/resume success; storage growth/reclaimed bytes;
stable-prefix cache hit rate; post-submit convergence; base-drift/merge-queue success; and default
manual ID copying (target zero). Internal 100/100 scorecards and compression ratios are never release
proof; cost/time per accepted verified change is the product measure.

## Cross-cutting independently testable work

- **Thin UX:** one bounded status/why/next-safe-action summary plus machine detail/expansion; no
  normal-loop manual IDs or human-facing artifact ceremony.
- **Doctor and compatibility:** opt-in setup preview, supported adapter/schema/host ranges, explicit
  incompatibility, and no silent host-config writes.
- **Artifact schema:** shared identity envelope, atomic versioned manifest, migration/read
  compatibility, authoritative-source rules, orphan detection, and corruption handling without a
  god service or database dependency.
- **Storage/privacy:** explicit budgets, lifecycle, project isolation, inspect/purge/export,
  permissions/symlink controls, and optional encryption policy.
- **Lightweight escape hatch:** users may use native Git/agent tools; Rizz withholds unattained
  attestations rather than becoming a mandatory workflow engine.

### Cross-cutting acceptance

- Status tests expose one summary plus machine expansion and complete a normal attach/resume loop
  with zero manual identity copying; stale external state is visible and never silently trusted.
- Doctor contract tests cover compatible and incompatible host/adapter/schema/skill combinations,
  unavailable release connectors with working read-only context, and a no-host-config-write assertion.
- Artifact migration tests read each supported schema, atomically recover interrupted index updates,
  identify orphans, reject corruption, and prove every derived view names one authoritative source.
- Storage tests enforce project/global caps, expiry/GC/reclaimed-byte accounting, project namespace
  isolation, symlink/permission defenses, inspect/purge/export behavior, and receipt invalidation for
  missing/tampered/purged objects.
- Provider tests negotiate capabilities instead of flattening native evidence; hidden required policy
  yields unknown and blocks merge readiness, while optional adapters add no always-on core burden.

## Dependency graph

```text
Milestone A: bounded evidence + mission identity
  -> Milestone B: review evidence + cited host findings + convergence
    -> Milestone C: snapshot receipts + verification DAG + local_green + release journal
Milestone A -> Milestone D1: stable prefix + delta packets + early telemetry
Milestones B + C + D1 -> Milestone D2: protected optimization + lifecycle
Milestones B + C + D2 -> Milestone E: post-submit loop + merge_ready + calibration
```

Thin UX, doctor/version compatibility, schema migration, and storage-budget work have explicit tests
across their owning milestones. Every stage preserves the single-agent lightweight default and adds
no resident daemon, mandatory cloud control plane, heavyweight always-on database, default model
call, or ceremony-heavy workflow. Release journaling is limited to side-effecting/idempotency-critical
operations, and internal immutable artifacts remain bounded and garbage-collectable.
