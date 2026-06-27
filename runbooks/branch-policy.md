# Branch policy

rizz uses `develop` for integration and `main` for public releases.

## Branch roles

- `develop`: default base for feature and fix PRs.
- `main`: production/public release branch. Keep it releasable at all times.
- `codex/*`, `feature/*`, `fix/*`, `release/*`: working branches.

Feature and fix PRs target `develop`. Release PRs target `main` from `develop` only.

## Required local gate

Before opening a PR:

```sh
pnpm check
git diff --check
```

For release-facing work, also run the relevant UAT steps from `runbooks/uat-agent-light.md`.

## Required PR gate

Every PR to `develop` or `main` needs:

- scope summary
- user-facing risk
- out-of-scope notes
- verification evidence
- green GitHub CI on Ubuntu, macOS, and Windows
- local `check-pr` + `review-loop` evidence

Do not use external review-bot trigger comments as a release gate.

## GitHub protection target

Configure branch rules or rulesets for both `develop` and `main`:

- require pull requests before merge
- require the `CI` workflow to pass
- require all matrix checks: Ubuntu, macOS, and Windows
- require branches to be up to date before merge
- block force pushes
- block deletions
- require conversation resolution

For `main`, additionally restrict direct pushes to release/admin maintainers.

Keep the policy simple: `develop` accepts reviewed integration work; `main` receives release PRs
only.
