# CLAUDE.md — rizz house style

> rizz is the lightest, most connectable coding agent harness. **Single-agent, single-core,
> lightweight by default** (Pi identity); the `/workspace` multi-agent mode is opt-in and must
> never load in the default path. Every decision is judged against the **lightweight constraint**
> (§2 of the brief): minimal dependencies, fast cold start, small footprint. The CI footprint
> budget enforces this — if a change regresses install size or cold start past threshold, the
> build fails. That is a feature, not an obstacle.

## The one rule that overrides convenience

**When adding a capability, ask: does this belong in the always-on minimal core, or is it opt-in
power?** Default answer is **opt-in**. The core stays Pi-small; complexity is summoned, not
shipped. A new dependency in `core` or `providers` must be justified in the PR description.

## Language & module system

- **TypeScript, `strict` everywhere.** No `any` without a `// reason:` comment. Prefer `unknown` +
  narrowing.
- **ESM only**, `module: NodeNext`. Relative imports carry the explicit `.js` extension
  (`import { loop } from './loop.js'`) because we emit real ESM.
- **Node ≥ 22.** CI pins Node 24 LTS. Use only stable, non-experimental Node APIs.
- Target `ES2022`. No transpiler-only syntax that needs heavy polyfills.

## Imports & package boundaries

- Workspace packages import each other **only through the package entrypoint** (`@valoir/rizz-core`,
  `@valoir/rizz-providers`, …) — never deep-import another package's `src/`.
- **Named exports only.** `noDefaultExport` is enforced by Biome. One concept per file where it
  reads better; do not pre-split files that belong together.
- Dependency direction is **one-way**: `cli → tui → core → providers`. Lower layers never import
  upward. `providers` depends on nothing in the workspace.

## Architecture — Service-Layer split (binding, §6.5A)

This maps one-to-one onto a harness. Keep the two layers separate:

| Layer | Owns (the…) | Where | Examples |
|---|---|---|---|
| **Orchestration** | *why / when* — business rules, state transitions, failure classification, retries, budget, user-facing errors | `packages/core` (the loop), `packages/cli` (commands) | the agent loop, budget enforcement, fallback policy, interrupt handling |
| **Service** | *how* — provider/SDK calls, command execution, readiness checks; returns **structured results** | `packages/providers`, tool/runtime services | `callModel`, `dispatchTool`, `compressContext`, `resolveModelRoute` |

Enforced:

- Services are **composable capability blocks**, not one god-method. **Explicit params in,
  structured results out.**
- **Services never reach into session state or the DB directly** and never mutate orchestration
  state — they take inputs and return values.
- **Extract to a service only when logic repeats across 2+ callers.** Write it in the action
  first; extract one chunk, replace one caller, verify, then migrate the rest. No premature
  abstraction.
- Rejected in review: god service, leaky service (service mutating caller state), inconsistent
  service API, premature abstraction.

## Error handling

- **Service layer returns results, it does not throw for expected failures.** Use the `Result`
  type:

  ```ts
  type Result<T, E = RizzError> = { ok: true; value: T } | { ok: false; error: E };
  ```

  Network errors, provider 4xx/5xx, bad tool calls, failed patches → returned as `{ ok: false }`,
  not thrown. The **orchestration layer** classifies them (retry? fall back? surface to user?).
- **Throw only for programmer error** (invariant violations) — and only in orchestration.
- User-facing failures are a `RizzError` with a stable `code` (e.g. `PROVIDER_AUTH`,
  `BUDGET_EXCEEDED`, `EDIT_VERIFY_FAILED`). Never surface a raw stack to the user.
- **Never swallow an error silently.** If you catch and continue, log the reason at the
  appropriate level.

## Reliability rules that are non-negotiable (§3.6)

- **Edits verify after every write.** The edit/apply path re-reads and confirms the change landed
  byte-for-byte before reporting success. A write that can't be verified is a failure, not a
  warning. (This is the #1 real-world harness failure — treat it as such.)
- **Secrets never leak** into logs, sessions, transcripts, or the vault. Redact provider keys and
  tokens at the boundary.
- **`bash` safety:** destructive or networked commands go through approve/deny; read-only runs are
  friction-free.
- **Compression protects head & tail** — never silently drop critical context.
- **Budget is visible.** Show `$0.00 (sub)` on subscriptions; honor hard caps.

## Naming & clarity (what code-simplifier enforces)

- Clarity over brevity. **No nested ternaries** — use `switch` / `if`-`else`. No dense one-liners
  that hide control flow.
- Names say intent: `resolveModelRoute`, not `getMR`. Booleans read as predicates (`isInterrupted`).
- Don't "simplify" by deleting a helpful abstraction or merging distinct concerns —
  over-simplification is a rejected outcome here.

## Tests

- **Vitest.** Co-locate as `*.test.ts` next to the unit. Test the service contract (params →
  structured result) and the orchestration decisions (given result X, loop does Y).
- The eval suite in `eval/` covers the loop end-to-end; the footprint check guards weight. Both run
  in CI.

## Commits & PRs

- **Conventional commits** (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`).
- Branches: `feature/*`, `fix/*`, `release/*` off `develop`; `develop` integrates; `main` is
  protected + always releasable.
- Dev loop for every change after bootstrap: **plan → `git worktree add` per task → build →
  code-simplifier pass → PR via `gh` → `check-pr` → `review-loop` → merge to `develop`.**
