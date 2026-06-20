# Contributing to rizz

rizz dogfoods the discipline it ships. Every change after bootstrap follows the dev loop.

## Dev loop (mandatory per change)

**plan → `git worktree add` per task → build → code-simplifier pass → PR via `gh` → `check-pr` → `review-loop` → merge to `develop`**

1. **Plan.** Write a short plan + task list before editing; keep it with the feature branch.
2. **Isolate.** One git worktree per task: `git worktree add ../rizz-<task> -b feature/<task>`.
   Parallel tasks never collide in one checkout.
3. **Build.** Implement within the worktree's scope only. `pnpm check` must pass locally.
4. **Simplify.** Run the `code-simplifier` pass on the recently-changed code (clarity, not
   behavior — see `.claude/skills/code-simplifier`).
5. **PR.** Open via `gh pr create` targeting `develop`.
6. **Local review gate.** Run `check-pr` then `review-loop` (`.claude/skills/check-pr`,
   `.claude/skills/review-loop`). No external review-bot score is required; bot comments, if any
   already exist, are ordinary comments and must be classified as actionable, stale, or informational.
7. **Merge** to `develop`. `main` stays protected + always releasable.

## Branches

`feature/*`, `fix/*`, `release/*` off `develop` · `develop` integrates · `main` is protected.

## Conventions

- **Conventional commits** (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`).
- House style (TypeScript, ESM, imports, errors, the **service-layer split**) is in
  [CLAUDE.md](./CLAUDE.md). The Biome lint + type-check enforce the mechanical parts.
- **New dependency in `core`/`providers` must be justified in the PR** — the lightweight constraint
  and the footprint budget are gates, not suggestions.

## Local checks

```bash
pnpm install
pnpm lint        # biome
pnpm typecheck   # tsc -b --noEmit
pnpm test        # vitest
pnpm eval        # eval/run.mjs
pnpm footprint   # cold-start + size budget
# or all at once:
pnpm check
```
