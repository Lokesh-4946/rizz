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

Project brain/report generation, the TUI/chat surface, `/workspace` (multi-agent), and `/mcp` are
**summoned, not shipped on the default counted core path** (D-001). Their packages (`optInPackages`
in `.footprint-budget.json`, currently `["brain", "tui", "workspace", "mcp"]`) are **excluded from
the core `distKb` budget** — the lightweight constraint is about the default counted harness core.
They still appear in the per-package breakdown, marked `opt-in`.

**Rules:**
- A capability that must load on the default path belongs in a core package and **counts** — keep it lean.
- A genuinely opt-in capability (lazy-loaded, summoned by a command) goes in its own package listed in
  `optInPackages`. It must NOT be imported by any core package (that would pull it onto the cold path —
  and it would then need to count). If an opt-in package grows large, give it its own budget here.
- Cold start already reflects only the default CLI path (`--version`), so opt-in packages never affect it.

## The drift rule (must stay in sync)

When a package is published, **the npm tarball must exclude exactly the same set the gate excludes**,
or the measured footprint and the real install size diverge.

**For each public package:**

1. Keep package `"files"` entries limited to `dist/**/*.js`, `dist/**/*.d.ts`, and `package.json`.
2. Keep compiled tests and maps out of `"files"`.
3. Verify with `pnpm pack:check` that the tarball contains **no** `*.map`, **no** `*.test.*`, and no
   source files, matching `isShipped()` in `scripts/footprint-check.mjs`.

If `scripts/footprint-check.mjs`'s `isShipped()` filter changes, update this list and every package's
ignore in the same PR — they are a matched pair and must not drift.

## Current status

- Public packages are publish-configured under the `@valoir` scope.
- `pnpm pack:check` is the release gate that prevents tarball/footprint drift.
