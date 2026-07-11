# Release Notes

## 0.3.1

Rizz `0.3.1` is a backward-compatible precision and approval-lifecycle patch.

- Review governance separates Rizz-generated `.rizz/**` files from authored untracked work, so
  generated intelligence does not inflate dirty-tree severity.
- Secret detection distinguishes credential-shaped values from design-token documentation while
  preserving redaction for real keys, credentials, and sensitive files.
- File explain and `rizz ask` surface evidence-backed Next.js route consumers without contradictory
  generic fallback text.
- Human signoff supports exact ISO-8601 expiry and auditable revocation; expired or revoked decisions
  cannot make a review merge/release-ready.
- The default path remains dependency-minimal and single-agent; workspace/multi-agent behavior stays
  opt-in.

## 0.3.0

Rizz `0.3.0` expands the local Project Intelligence Engine with deeper architecture causality,
review governance, verification evidence, and database-aware understanding while preserving the
lightweight default path.

### Highlights

- Added evidence-backed service, route, state/data, dependency, and database causality across
  Project Intelligence, explanations, and review blast radius.
- Added SQLAlchemy, Alembic, raw SQL, and Mongoose schema relationship intelligence, including
  foreign keys and cross-table impact.
- Added deterministic verification plans, evidence scoring and ingestion, human approval packets,
  CLI signoff, and fingerprint-bound signoff history reuse.
- Added mission-contract governance, mixed-diff-basis reporting, unified repair packets, and
  inspect-first confidence queues for coding agents.
- Added incremental-understanding reuse metrics, large-repository UAT, PI-Bench depth, and scaling
  fixes that keep sensitive-text handling deterministic.

### Scope

- No new runtime dependencies.
- Workspace/multi-agent power remains opt-in and outside the default startup path.
- The counted core remains under the 200KB footprint budget.

### Verification

- Biome: 145 files
- Vitest: 38 files / 383 tests
- PI-Bench: 25/25 tasks, 76/100 average research readiness
- CLI process smoke: 10/10 checks
- install-local smoke: 5/5 checks
- footprint: 53ms cold start, 198KB counted core under the 200KB budget

## 0.2.1

Rizz `0.2.1` is a patch release for the first-run Project Intelligence command contract.

### Fixes

- Bare `rizz` now generates the local Project Intelligence Layer in headless/non-interactive
  runners with empty stdin.
- `rizz`, `rizz understand`, and `rizz brain` now agree for Codex, CI, and agent workflows.
- Added an eval smoke proving bare `rizz` writes `.rizz/brain`, `.rizz/research`, and
  `.rizz/reports/index.html` without provider credentials.

### Verification

- Biome: 110 files
- Vitest: 31 files / 320 tests
- PI-Bench: 10/10 tasks
- CLI process smoke: 10/10 checks
- install-local smoke: 5/5 checks
- footprint: 53ms cold start, 188KB core under the 200KB budget

## 0.2.0

Rizz `0.2.0` is the first Project Intelligence Engineering release centered on understanding a
repository before changing it.

### Product Surface

- Generate a local Project Intelligence Layer with `rizz`, `rizz understand`, or `rizz brain`.
- Persist structured facts, relationships, evidence, flows, and research artifacts under `.rizz/`.
- Open Mission Control at `.rizz/reports/index.html`.
- Explain files, components, and flows with `rizz explain`.
- Review local diffs with `rizz review` and `rizz review --json`.
- Ask narrow, gated Project Intelligence questions with `rizz ask`.
- Use model chat only through explicit setup; the repo-understanding path is local-first.

### Research Artifacts

Rizz emits deterministic research data under `.rizz/research/`, including coverage, confidence,
evidence quality, flow understanding, architecture reasoning, benchmark readiness, understanding
score, review evaluation, incremental update, and PIE acceptance readiness.

### Verification

- Biome: 110 files
- Vitest: 31 files / 320 tests
- PI-Bench: 10/10 tasks
- CLI process smoke: 9/9 checks
- install-local smoke: 5/5 checks
- footprint: 49ms cold start, 188KB core under the 200KB budget

### Scope Boundaries

Rizz is not a generic chatbot, autonomous developer, IDE replacement, cloud sync product, mobile app,
browser extension, agent marketplace, or personal/global brain. Those remain outside the default
product path.
