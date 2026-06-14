# Footprint gate + publish-tarball alignment (D-026)

The footprint gate (`scripts/footprint-check.mjs`, run in CI via `pnpm footprint`) keeps the
"extremely lightweight" constraint honest. Budgets live in `.footprint-budget.json`.

## What the gate measures

- **Compiled size** = the **installed** artifacts only: shipped `.js` + `.d.ts` across every
  `packages/*/dist`. It **excludes**:
  - source maps — `*.map`
  - compiled test files — anything matching `*.test.*`
- **Cold start** = best of 7 runs of `node packages/cli/dist/index.js --version`.

These exclusions exist because a user never installs maps or tests (D-026): the gate measures install
size, not the dev build.

## The drift rule (must stay in sync)

When a package is published (today all are `private: true`; publishing is deferred per D-031 step 3),
**the npm tarball must exclude exactly the same set the gate excludes**, or the measured footprint and
the real install size diverge.

**At publish time, for each package that flips `private: false`:**

1. Set `"files": ["dist"]` (ship only the build output — not `src`).
2. Add a package `.npmignore` (or rely on `files` + an ignore) that drops the gate-excluded patterns:
   ```
   *.map
   *.test.js
   *.test.d.ts
   ```
3. Verify with `npm pack --dry-run` that the tarball contains **no** `*.map` and **no** `*.test.*`,
   matching `isShipped()` in `scripts/footprint-check.mjs` (the single source of truth for the
   exclusion list).

If `scripts/footprint-check.mjs`'s `isShipped()` filter changes, update this list and every package's
ignore in the same PR — they are a matched pair and must not drift.

## Current status

- All packages are `private: true`; no tarball is produced yet, so there is nothing to diverge **today**.
- The exclusion contract above is the gate that prevents drift the moment publishing starts (M4+).
