# eval/

The rizz eval harness (brief §4.6). Coding-task suite + footprint/latency benchmarks that run in
CI and write baselines to the Labs brain.

- `run.mjs` — the runner. Loads every `tasks/*.task.json`, validates the PI-Bench seed schema,
  then drives tasks through the loop when M5 scoring lands.
- `tasks/*.task.json` — one local deterministic task per file:
  `{ schema_version, id, suite, mode, title, prompt, fixture, expected_artifacts, coverage_targets, rubric }`.

Status: **M0** — runner skeleton + PI-Bench seed schema validation only (green in CI).
Loop-backed scoring lands in **M5**, with baselines written to
`/My Labs/Valoir/rizz/03_baselines-benchmarks/`.
