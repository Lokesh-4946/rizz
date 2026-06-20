# Local review loop — the PR review gate

Every PR to `develop`/`main` uses a local, evidence-backed review gate:

1. `check-pr` gathers PR state, changed-file scope, CI, description quality, comments, and unresolved
   review threads without posting any external bot trigger comments.
2. `review-loop` inspects the diff, fixes scoped issues when authorized, reruns verification, and
   reports local merge readiness.

External bot comments are not release gates. If they already exist on a PR, classify them like any
other comment: actionable, stale, or informational. Do not require an external score, and do not post
trigger comments for external review bots.

## Acceptance rule (D-045)

The gate is satisfied when all of the following hold:

1. Every actionable human, bot, CI, or local-review finding in the approved PR scope is addressed, or
   explicitly deferred by the orchestrator.
2. No unresolved review thread remains actionable against the latest commit.
3. PR scope matches the current baton and excludes unrelated local work.
4. PR is mergeable with `mergeStateStatus: CLEAN`.
5. Required CI is green on all configured operating systems.
6. The PR body includes summary, risk, scope, out-of-scope notes, and verification evidence.
7. For code changes, the lightweight constraint is checked: no accidental default-path dependency
   growth, core/provider bloat, or opt-in power loaded by default.

Only then merge to `develop`. If a remaining issue needs product, architecture, provider, install,
docs, or release-scope judgment, baton back to Master Orchestrator instead of widening the PR.

## Iteration cap

`review-loop` runs up to three iterations by default. Continue only when each extra round fixes a
real, scoped issue and the PR owner records why the extra loop was needed.

## Quick GitHub checks

```sh
PR=<n>
gh pr view "$PR" --json number,title,body,state,headRefName,headRefOid,mergeStateStatus,statusCheckRollup
gh pr checks "$PR"
gh api "repos/{owner}/{repo}/pulls/$PR/files" --paginate
gh api graphql -f query='query{repository(owner:"Lokesh-4946",name:"rizz"){pullRequest(number:'$PR'){reviewThreads(first:60){nodes{id isResolved comments(first:3){nodes{path line body author{login}}}}}}}}'
```
