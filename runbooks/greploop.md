# greploop — the PR review gate

Every PR to `develop`/`main` loops Greptile review → fix → resolve → re-review until the gate is met
(D-005). The skill lives at `.claude/skills/greploop`; this runbook codifies the **acceptance rule**
for this repo's Greptile install.

## Acceptance rule (D-016)

The Greptile install on `Lokesh-4946/rizz` posts **inline review comments only** — it emits **no
numeric `X/5` confidence score**, so the skill's literal "5/5" cannot be read programmatically. The
gate is therefore satisfied when **all** of the following hold:

1. **Every actionable Greptile finding is addressed** — fixed in code, or (for a false positive /
   informational note) consciously dismissed with a reply.
2. **All review threads are resolved** (or marked outdated).
3. **Zero active (unresolved) comments** remain on the latest commit.
4. **PR is `MERGEABLE` / `mergeStateStatus: CLEAN`.**
5. **CI is green on all three OSes** (ubuntu, macOS, windows).

Only then squash-merge to `develop`. No merge before the gate is met, **or** a human signs off on a
listed, justified remainder.

## Iteration cap

The skill caps at **5 iterations** to avoid runaway loops. If genuine, distinct findings keep arriving
each round, continuing past 5 is acceptable **only** with explicit justification (each round fixed a
real bug, not churn) — otherwise stop and surface the remaining items. Never resolve a thread you did
not actually address.

## Operating notes (this install)

- **Re-review trigger:** post `@greptile review` as a PR comment after pushing fixes. Greptile may add
  new inline comments **without** incrementing its "reviews" count — poll for **new/unresolved inline
  threads and CI state**, not just a review-count bump.
- **Stale comments:** a re-review can post comments against an older commit's line numbers that are
  already fixed in HEAD. Verify against the current diff before re-fixing; resolve the thread if HEAD
  already addresses it.
- **Resolve threads** via the GraphQL `resolveReviewThread` mutation (see
  `.claude/skills/greploop/references/graphql-queries.md`).

## Quick commands

```sh
PR=<n>
gh pr comment $PR --body "@greptile review"
# unresolved threads:
gh api graphql -f query='query{repository(owner:"Lokesh-4946",name:"rizz"){pullRequest(number:'$PR'){reviewThreads(first:60){nodes{id isResolved comments(first:1){nodes{path line body}}}}}}}'
# CI + mergeability:
gh pr view $PR --json mergeable,mergeStateStatus,statusCheckRollup
```
