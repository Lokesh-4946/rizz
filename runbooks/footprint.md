# Footprint gate + publish-tarball alignment (D-026)

The footprint gate (`scripts/footprint-check.mjs`, run in CI via `pnpm footprint`) keeps the
"extremely lightweight" constraint honest. Budgets live in `.footprint-budget.json`.

## What the gate measures

- **Core size** = the **installed** artifacts of the **default/core** packages only: shipped `.js` +
  `.d.ts` across `packages/*/dist`, **excluding**:
  - source maps — `*.map`
  - compiled test files — anything matching `*.test.*`
  - **opt-in packages** — any package named in `optInPackages` (see below)
- **Cold start** = best of 7 runs of `node packages/cli/dist/index.js --version`.

The maps/tests exclusions exist because a user never installs them (D-026): the gate measures install
size, not the dev build. The gate also prints a **per-package breakdown** so a regression points at the
package that grew.

## Opt-in packages don't count toward the core budget (D-001)

`/workspace` (multi-agent) and `/mcp` are **summoned, not shipped on the default path** (D-001). Their
packages (`optInPackages` in `.footprint-budget.json`, currently `["workspace", "mcp"]`) are **excluded
from the core `distKb` budget** — the lightweight constraint is about the default single-agent cold
path, which never imports them. They still appear in the per-package breakdown, marked `opt-in`.

**Rules:**
- A capability that must load on the default path belongs in a core package and **counts** — keep it lean.
- A genuinely opt-in capability (lazy-loaded, summoned by a command) goes in its own package listed in
  `optInPackages`. It must NOT be imported by any core package (that would pull it onto the cold path —
  and it would then need to count). If an opt-in package grows large, give it its own budget here.
- Cold start already reflects only the default CLI path (`--version`), so opt-in packages never affect it.

## The drift rule (must stay in sync)

When a package is published (today all are `private: true`; publishing is deferred per D-031 step 3),
**the npm tarball must exclude exactly the same set the gate excludes**, or the measured footprint and
the real install size diverge.

**At publish time, for each package that flips `private: false`:**

1. Set `"files": ["dist"]` (ship only the build output — not `src`).
2. Add a package `.npmignore` (or rely on `files` + an ignore) that drops the gate-excluded patterns.
   Use the `*.test.*` glob so it matches the gate's `/\.test\./` regex exactly (incl. `.test.cjs` /
   `.test.mjs`, not just `.test.js` / `.test.d.ts`):
   ```
   *.map
   *.test.*
   ```
3. Verify with `npm pack --dry-run` that the tarball contains **no** `*.map` and **no** `*.test.*`,
   matching `isShipped()` in `scripts/footprint-check.mjs` (the single source of truth for the
   exclusion list).

If `scripts/footprint-check.mjs`'s `isShipped()` filter changes, update this list and every package's
ignore in the same PR — they are a matched pair and must not drift.

## Current status

- All packages are `private: true`; no tarball is produced yet, so there is nothing to diverge **today**.
- The exclusion contract above is the gate that prevents drift the moment publishing starts (M4+).
