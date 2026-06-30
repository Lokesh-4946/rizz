# eval/

The rizz eval harness runs local deterministic checks for the PI-Bench seed plus CLI/install smoke
gates. It does not require live providers, credentials, package installation inside fixtures, or
network access.

- `run.mjs` loads every `tasks/*.task.json`, validates the task schema, materializes each fixture
  into a temp repo, runs `rizz brain`, checks expected research artifacts, scores
  `.rizz/research/benchmark_ready.json`, and prints a concise benchmark summary.
- `tasks/*.task.json` describes one local deterministic PI-Bench seed task:
  `{ schema_version, id, suite, mode, category, title, prompt, fixture, expected_artifacts, coverage_targets, artifact_assertions, rubric }`.

Coverage targets are explicit for component, flow, evidence, and unknown surfaces:
`{ minimum_total, minimum_covered, minimum_ratio }`. Evidence `minimum_total` is checked against
`coverage.evidence.records`; evidence `minimum_covered` is checked against
`coverage.evidence.claims_with_evidence`.

Artifact assertions check that required files exist, parse as JSON when requested, and contain the
expected top-level or dotted fields. The benchmark summary reports readiness score plus component,
flow, evidence, and unknown coverage for each task.
