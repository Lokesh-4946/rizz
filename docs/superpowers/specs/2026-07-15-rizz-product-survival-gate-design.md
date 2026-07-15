# Rizz Product Survival Gate Design

Status: approved product decision on 2026-07-15. This contract governs delivery order and the
continue/pivot/kill decision for the Precision-First Closed Loop. It does not authorize a new agent
runtime, semantic reasoning engine, or autonomy mode.

## Decision

Rizz continues under a gated, foundation-first investment. New brain analysis, semantic review-loop
automation, repair-agent behavior, UI, and broad skill expansion pause until the deterministic proof
plane demonstrates the product's seven differentiators.

The target buyer is an engineering or platform team using more than one coding agent and needing
portable, inspectable change control. Solo-developer usefulness remains important, but it is not the
primary basis for the survival decision because native agent and Git-provider workflows already
cover much of the visible implement-review-fix-merge loop.

Rizz competes on:

1. exact-revision green status;
2. evidence-grounded agent handoffs;
3. validated findings and citations;
4. minimal dependency-aware re-verification;
5. cross-agent and cross-SCM portability;
6. auditable cost savings without lowering verification quality; and
7. local-first lightweight operation.

Generic code review, a larger repository brain, another coding agent, generic context compression,
and one-command PR automation are not independent product moats.

## Current kill-test result

The current product does not yet pass the complete survival gate. Milestone A proves enough of the
foundation to continue, but not enough to scale scope.

| Differentiator | Current result | Evidence or gap |
| --- | --- | --- |
| Exact-revision green | Fail | Working-snapshot receipts, commit-tree equivalence, and `local_green` are not implemented. |
| Evidence-grounded handoffs | Pass | A 3,097,813-byte adversarial inventory emits a valid 3,016-byte Task Brief; mission and pinned-skill identity are verified. |
| Validated findings and citations | Partial | Mission citations are checked; finding continuity, revision observations, and freshness remain B0 work. |
| Dependency-aware re-verification | Fail | Existing fingerprints do not provide complete declared input closures or safe minimal invalidation. |
| Cross-agent and cross-SCM portability | Partial | Codex, Claude, and Copilot contracts exist; provider-neutral GitHub/GitLab readiness contracts do not. |
| Auditable cost savings without quality loss | Fail | Byte bounding exists, but provider cost/time per accepted verified change and quality non-inferiority are unproved. |
| Local-first lightweight operation | Pass | Fresh baseline: 49 ms cold start, 200 KB counted core, no new production dependency. |

The evaluated project-skill pilot is supporting evidence, not released product proof. It improved
unsupported-claim rate from 5.9% to 0.7% and exact-evidence coverage from 72.6% to 87.0%, while its
output context increased by 92.2%. That quality/cost tension is precisely why savings must be judged
per accepted verified change rather than by compression ratio or evidence volume.

## Foundation-first delivery order

```text
A  — bounded evidence and mission identity                         implemented
  -> B0 — finding/citation identity protocol                       next
    -> C0 — working-snapshot and artifact identity
      -> C1 — verification DAG, proof reuse, commit-equivalence,
               and exact local_green
A  -> D1 — delta context, stable prefix, and actual cost telemetry
C1 -> P1 — agent-neutral contract parity
P1 -> P2 — GitHub and GitLab capability adapters
B0 + C1 + D1 + P2 -> B1 — host semantic review/repair convergence loop
B0 + C1 + D1 -> D2 — protected originals and optimization lifecycle
B1 + D2 + P2 -> E — exact-head merge_ready and remote repair loop
```

### B0: finding and citation identity protocol

B0 is deterministic contract work, not a semantic review loop. It delivers:

- `ReviewEvidencePacket` serialization and byte budget;
- revision-independent `finding_key`;
- revision-bound `finding_observation_id`;
- citation existence, canonical locator, content digest, relationship provenance, and freshness;
- baseline-debt and changed-code classification inputs; and
- stable equivalent-input and no-progress identities.

B0 accepts structured host output for validation fixtures, but it does not invoke, schedule, or
repair through a host agent.

### C0 and C1: revision proof kernel

C0 defines dirty-working-snapshot and immutable artifact identity. C1 builds dependency-declared
verification, safe reuse, commit-tree equivalence, and `local_green`. These are the primary proof
moat and must pass mutation, fault, and stale-state tests before review-loop expansion resumes.

### D1: measured context economics

D1 implements stable/task/live/control zones, changed-evidence deltas, hash-addressed expansion,
provider-usage receipts where integrations expose them, and adaptive bypass. Protected code, exact
diffs, failing assertions, security evidence, and verification proof remain native and lossless.

### P1 and P2: portability before automation

P1 proves identical semantic contracts across Codex, Claude, and Copilot without copying entire
transcripts or introducing a Rizz-owned model. P2 proves capability negotiation and exact-state
mapping for GitHub and GitLab. Provider-native rules, reviews, queues, and unknown/hidden policy are
preserved rather than flattened.

### B1 and E: loops only after proof

B1 connects the host semantic reviewer and repair agent to B0/C1/D1/P2 contracts. E adds the remote
repair loop and `merge_ready`. Neither may invent a shortcut around snapshot, citation,
verification, cost, or provider evidence.

## Scope freeze

Until C1 and D1 pass their survival gates, product work is limited to required maintenance and the
foundation sequence above. Do not expand:

- repository-brain feature breadth or internal score categories;
- semantic review heuristics or additional model calls;
- repair-agent orchestration beyond contract fixtures;
- user-facing dashboards or artifact ceremony;
- broad SCM support beyond GitHub and GitLab contracts;
- skill catalogs beyond skills required to exercise the proof protocol; or
- lossy/image context encoding.

General-purpose personal/project skills remain a separate agent-tooling concern. They may be
evaluated and installed outside Rizz core, but they do not count as product differentiation or
survival-gate evidence.

## Benchmark design

The survival evaluation uses three controlled arms:

1. the same host agent without Rizz;
2. the closest assembled competing workflow when accessible; and
3. the same host agent with Rizz.

Each comparison pins repository revision, task wording, model/version, agent version, available
tools, provider settings, and repetition count. Authentication, infrastructure outages, and
provider throttling are recorded and excluded from product-quality denominators without being
deleted from reports.

The initial corpus contains at least twelve surgical tasks:

- four TypeScript/Vitest tasks in Rizz or an equivalent service repository;
- four Python/FastAPI tasks; and
- four Go service tasks.

Each ecosystem includes clean negative controls and seeded behavior, API compatibility, security,
dependency/lockfile, configuration, test-only, generated-only, and documentation-only changes.
GitHub and GitLab provider fixtures cover remote-head drift, review state, required checks, hidden
policy, timeout-after-create, and queue/update behavior.

All raw inputs, exact revisions, commands, outputs, receipts, exclusions, and scorer decisions are
retained in a machine-readable report. Expected seeded defects are hidden from the host agent and
made available only to the evaluator.

## Survival gates

### 1. Exact-revision green

- Zero false `local_green` results in the known mutation and fault corpus.
- Every relevant source, staged-state, protected-untracked, lock/config, mission, skill, command,
  toolchain, policy, or commit mutation invalidates the correct proof and no unrelated proof.
- Hook, formatter, or generator changes prevent green until affected verification reruns.

### 2. Evidence quality

- Required-evidence recall is at least 95%.
- Evidence-packet precision is at least 85%.
- Unsupported evaluator claims remain below 1%.
- Inventory inflation, duplication, and equivalent-input reorder do not improve admission or rank.

### 3. Citation integrity

- Known missing, tampered, content-stale, and relationship-stale direct citations are rejected.
- Citation validity never upgrades an AI hypothesis into a verified fact.
- Finding continuity is stable across repair revisions while every observation remains revision-bound.

### 4. Verification economics

- Known-corpus unsafe verification reuse is zero.
- Localized changes reduce verification command-seconds by at least 40% against the required
  always-rerun baseline.
- Unknown or incomplete dependency closure reruns.
- Required flaky checks never silently yield green.

### 5. Portability

- Codex, Claude, and Copilot receive semantically identical evidence/finding/readiness contracts.
- GitHub and GitLab map to the same provider-neutral states without losing native policy evidence.
- Unsupported or permission-hidden required remote state is `unknown` and blocks readiness.

### 6. Cost and time

- Repeated repair cycles reduce provider input cost by at least 30%.
- Total time or cost per accepted verified change improves by at least 20%.
- Seeded-defect recall does not decline by more than two percentage points.
- Any optimization whose preparation cost exceeds expected savings is bypassed and reported.

### 7. Lightweight operation

- Default cold start remains at or below 250 ms.
- Counted default core remains at or below 200 KB.
- No resident daemon, mandatory database/cloud control plane, default model call, or always-on heavy
  dependency enters the default path.

## Decision rule

- **Continue to full product:** all safety-critical gates pass and at least six of seven product
  gates pass on the complete corpus.
- **Pivot to verification/evidence control plane:** revision proof passes but context economics or
  broad portability does not meet its threshold.
- **Kill the product direction:** Rizz cannot prevent stale green, produces any known unsafe
  verification reuse after repair, materially lowers defect recall for savings, or fails to improve
  accepted verified changes over the assembled alternative.

Gate thresholds may only change through a dated product decision that preserves the old result and
explains why the measurement was invalid. They may not be relaxed because a milestone missed them.
