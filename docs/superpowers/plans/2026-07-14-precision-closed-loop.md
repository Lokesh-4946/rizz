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

Stable named inefficiency target is deferred to Milestone E; until then the runbook records exact
commands for the focused precision suites and large-inventory fixture test.

## Milestone B — Review and repair precision

### Deliverables

- Deterministic `ReviewEvidencePacket`: exact diff/hunks, explicit constraints, direct
  tests/consumers, factual risk signals, verification state, and bounded causal evidence.
- Host-AI `ReviewFinding` contract with origin, status, confidence, citations, and stable finding ID
  derived from normalized claim+citation+revision context.
- Citation and recorded-relationship validation without claiming semantic truth.
- Deduplication, current-finding correction admission, baseline-debt separation, and exact
  no-progress/convergence reasons.
- Correction packets only from citation-valid current AI findings, failed required checks, explicit
  scope violations, or new deterministic changed-code security failures.

### Acceptance

- Adding thousands of unrelated graph edges or duplicate evidence does not change task findings or
  repair priority.
- Equivalent findings deduplicate to stable IDs under input/enumeration reorder.
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
- Targeted repair checks plus one complete policy-required local gate before local green; explicit
  reuse/rerun/skip/invalidation reasons.
- Pre-commit working-snapshot receipt, explicit commit capability, byte-equivalence proof after
  commit, and `local_green` bound to exact commit plus mission/evidence/config/verification/toolchain
  fingerprints.
- Explicit push and provider-neutral submit/open-PR-or-MR capability with stable operation IDs,
  phase receipts, partial success, discovery, and retry recovery.

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

## Milestone D — Delta context and protected optimization

### Deliverables

- After the initial packet, emit only changed evidence, invalidations, and requested hash-addressed
  expansions.
- Track bytes/tokens delivered, cache hits, expansions, rereads, and duplicate evidence.
- Cache/optimization receipts bind exact identity and explain reuse/invalidation.
- Protected exact originals stay native and lossless and round-trip byte-for-byte.

### Acceptance

- No correction cycle resends a full brain/transcript/Task Brief without an explicit expansion.
- Reordering inputs and object keys leaves semantic output unchanged.
- Corrupted exact-original objects, partial writes, symlink swaps, redirected state, cancellation,
  clock skew, and concurrent ownership fail safely and recover deterministically.
- Optimization never changes protected content or weakens required evidence recall.

## Milestone E — Remote merge readiness and product calibration

### Deliverables

- `merge_ready` bound to exact remote PR/MR head, CI, review state, branch protection, required
  signoff, and repository policy.
- Explicit merge capability with immediate remote-head/policy revalidation and a receipt bound to
  the merged remote SHA.
- Optional provider connectors without making provider availability a deterministic unit gate.
- Stable named precision/inefficiency regression target.
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
- Exercise partial writes, symlink swaps, redirected state, corrupt exact originals, cancellation,
  clock skew, and concurrent operation ownership.
- Change commit tree through hooks; change after local green; change remote rules, reviews, or
  signoff; and assert refusal at the correct boundary.
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
warm versus cold preparation. Internal 100/100 scorecards are never release proof.

## Dependency graph

```text
Milestone A: bounded evidence + mission identity
  -> Milestone B: review evidence + cited host findings + convergence
    -> Milestone C: snapshot receipts + verification DAG + local_green + release journal
      -> Milestone D: delta context + protected optimization
        -> Milestone E: merge_ready + remote TOCTOU + calibrated QA/metrics
```

Milestone D depends on the identities defined by A–C. Milestone E depends on B–D and optional remote
connectors. Every stage preserves the single-agent lightweight default and adds no always-on model
or production dependency.
