# Release Notes

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
