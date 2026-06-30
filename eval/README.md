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

Coverage targets are explicit for component, flow, evidence, and unknown surfaces:
`{ minimum_total, minimum_covered, minimum_ratio }`. Evidence `minimum_total` is checked against
`coverage.evidence.records`; evidence `minimum_covered` is checked against
`coverage.evidence.claims_with_evidence`.

Artifact assertions check that required files exist, parse as JSON when requested, contain the
expected top-level or dotted fields, include required substrings, and omit forbidden substrings.
Use required substrings for benchmark-critical object signals and evidence trails, and forbidden
substrings for placeholder IDs, fake flow examples, or sensitive path/token leakage. The benchmark
summary reports readiness score plus component, flow, evidence, and unknown coverage for each task.

The Next.js route-intelligence seed uses a deterministic app-router fixture with local-only
`src/app/page.tsx`, dynamic docs page, layout, health API route, sitemap, robots, `@/*` and `~/*`
alias imports, content loader, component import, and package-script evidence. It intentionally does
not install fixture dependencies or contact a provider; it asserts that local research artifacts and
Mission Control preserve route/API/render flows, alias-resolved route evidence, mapped
files/components/configs, contracts, confidence gaps, known unknowns, object labels, and expandable
report details while rejecting placeholder flow IDs and sensitive path leaks.

Review benchmark tasks use category `review-blast-radius` and add a `review` block instead of
`coverage_targets`. The runner initializes a git fixture, runs `rizz brain`, commits the baseline,
applies `review.diff.files`, runs `rizz review --json`, and validates semantic review output:
changed files, direct/dependent components, affected relationships, affected flows, linked tests and
configs, blast-radius reasons, required tests, findings, and forbidden secret-like substrings in the
JSON/report output. Review tasks intentionally validate review JSON directly rather than writing a
separate `.rizz/research/review_eval.json`; the measured product surface is the user-facing
`rizz review --json` contract plus the existing local review report artifact.

The Next.js route blast-radius seed validates the review side of route intelligence: a local
content-loader change must map back to concrete app-router page flows through alias-resolved
evidence, preserve linked test/config readiness, and avoid placeholder flow IDs in JSON and HTML
review artifacts.
