# eval/

The rizz eval harness runs local deterministic checks for the PI-Bench seed plus CLI/install smoke
gates. It does not require live providers, credentials, package installation inside fixtures, or
network access.

- `run.mjs` first checks the local package `dist/index.js` outputs that eval executes. If required
  dist output is missing or older than source/config inputs, eval runs a forced local TypeScript
  build through `pnpm exec tsc -b --force` before scoring any task; if that refresh fails, eval
  exits with a build-required diagnostic instead of using stale CLI output.
- `run.mjs` loads every `tasks/*.task.json`, validates the task schema, materializes each fixture
  into a temp repo, runs `rizz brain`, checks expected research artifacts, scores
  `.rizz/research/benchmark_ready.json`, and prints a concise benchmark summary.
- `tasks/*.task.json` describes one local deterministic PI-Bench seed task:
  `{ schema_version, id, suite, mode, category, title, prompt, fixture, expected_artifacts, coverage_targets, artifact_assertions, rubric }`.
  Research tasks may also include an `explain` block to run `rizz explain <target>` after brain
  generation and assert the deterministic output plus any generated explain report artifact.
  Incremental-understanding tasks may include an `incremental` block with deterministic file
  changes; the runner scans once, applies the changes, scans again, and validates
  `.rizz/research/incremental_update.json` changed/stable entity counts, reused/recomputed
  understanding counts, file reuse, scan efficiency, fingerprint continuity, and secret-safe
  changed-path output.
  Understanding-task seeds may include an `understanding_tasks` block. Each item asks one narrow
  benchmark-ready repo-understanding prompt and validates the answer from an existing JSON artifact
  slice or deterministic `rizz explain --json` output. Supported source types are
  `artifact_json` (`path`, optional `json_path`) and `explain_json` (`target`, optional
  `json_path`). Assertions can require fields, substrings, forbidden substrings, array item counts,
  and minimum numeric values. This is intentionally artifact-based; it does not add provider calls,
  network access, or a broad ask surface.

Coverage targets are explicit for component, flow, evidence, and unknown surfaces:
`{ minimum_total, minimum_covered, minimum_ratio }`. Evidence `minimum_total` is checked against
`coverage.evidence.records`; evidence `minimum_covered` is checked against
`coverage.evidence.claims_with_evidence`.

Artifact assertions check that required files exist, parse as JSON when requested, contain the
expected top-level or dotted fields, include required substrings, and omit forbidden substrings.
The benchmark summary reports readiness score plus component, flow, evidence, and unknown coverage
for each task.

The Next.js route-intelligence seed uses a deterministic app-router fixture with local-only
`src/app/page.tsx`, dynamic docs page, layout, health API route, sitemap, robots, content loader,
component import, and package-script evidence. It intentionally does not install fixture
dependencies or contact a provider; it asserts that local research artifacts and Mission Control
preserve route/API/render flows, mapped files/components/configs, contracts, confidence gaps, known
unknowns, object labels, and expandable report details.

The incremental-understanding seed applies a public source change and a sensitive-path change after
the first scan. It asserts that users can trust what changed between scans without leaking the
sensitive path or secret-like changed contents into research artifacts or reports.

Review benchmark tasks use category `review-blast-radius` and add a `review` block instead of
`coverage_targets`. The runner initializes a git fixture, runs `rizz brain`, commits the baseline,
applies `review.diff.files`, runs `rizz review --json`, and validates semantic review output:
changed files, direct/dependent components, affected relationships, affected flows, linked tests and
configs, blast-radius reasons, required tests, findings, and forbidden secret-like substrings in the
JSON/report output. Review tasks intentionally validate review JSON directly rather than writing a
separate `.rizz/research/review_eval.json`; the measured product surface is the user-facing
`rizz review --json` contract plus the existing local review report artifact.
Route-aware review tasks can additionally assert affected flow metadata with
`route_flows_include`: flow id, framework, route path, route type, entrypoints, changed files,
linked tests, and linked configs. The Next.js route review seed uses this to prove alias-resolved
component, content, and config imports support review blast-radius reasoning without exposing
secret-like fixture paths.

The understanding-task seed uses `understanding_tasks` to score answers a user would ask while
orienting in a repo: what to read first, which component has review-impact evidence, which evidence
gap should limit confidence, whether benchmark review readiness is strong, and whether
`rizz explain --json` returns the cross-component dependency and read-first files. The runner checks
these answers directly against `.rizz/research/understanding_score.json`,
`.rizz/research/architecture_reasoning.json`, `.rizz/research/evidence_quality.json`,
`.rizz/research/benchmark_ready.json`, and explain JSON output.
