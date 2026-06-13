# eval/

The rizz eval harness (brief §4.6). Coding-task suite + footprint/latency benchmarks that run in
CI and write baselines to the Labs brain.

- `run.mjs` — the runner. Loads every `tasks/*.task.json`, drives it through the loop (M5), scores
  pass/tokens/cost.
- `tasks/*.task.json` — one task per file: `{ id, prompt, rubric }`.

Status: **M0** — runner skeleton + schema validation only (green in CI). Loop-backed scoring lands
in **M5**, with baselines written to `/My Labs/Valoir/rizz/03_baselines-benchmarks/`.
