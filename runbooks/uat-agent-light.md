# Agent Light UAT

Agent Light is the default rizz product surface: one user, one project, local CLI/TUI, visible
provider route, approvals, cost/status, and no default Workspace/Jarvis weight.

## Scope

In scope:

- public npm install
- local development install
- local Project Intelligence Engine scan, explain, review, and generated `.rizz` artifacts
- first-run setup
- OpenRouter BYOK live path
- Codex subscription route smoke
- `/status`, `/model`, `/theme`, `/workspace`, `/help`
- setup dry-run safety
- install shim safety

Out of scope:

- Workspace Mode
- memory indexing outside the local project-scoped `.rizz` artifacts
- OS/Jarvis connectors
- custom skills
- enterprise Bedrock/Azure routes
- public cloud control plane

## Automated gate

```sh
pnpm check
git diff --check
```

Expected coverage:

- Biome lint
- TypeScript build
- Vitest
- CLI process eval smoke
- install-local smoke
- footprint and cold-start budget

## Local repo intelligence smoke

Run this from the release checkout after `pnpm link:local`:

```sh
rizz
rizz explain README.md
rizz review --json
test -f .rizz/brain/latest.json
test -d .rizz/research
test -f .rizz/reports/index.html
test -f .rizz/reports/review.html
```

Pass criteria:

- `rizz` writes only local `.rizz/brain`, `.rizz/research`, and `.rizz/reports` artifacts
- `rizz explain README.md` succeeds after the brain exists
- `rizz review --json` emits parseable JSON and writes review entities plus `.rizz/reports/review.html`
- generated `.rizz` output contains no provider keys, tokens, or user secrets

## Large-repo intelligence UAT

Run this from a development checkout when a milestone touches Project Intelligence scanning,
research artifacts, Mission Control, or review evidence:

```sh
pnpm uat:large-repos -- --max-files 120 --timeout-ms 90000
```

By default the harness uses a repo matrix for `github/docs` and `vercel/next.js`, clones or reuses
them under `.rizz/uat/large-repos`, removes generated `.rizz` output before each repo run, streams
per-repo progress, and writes `.rizz/uat/large-repos/large-repo-uat-report.json`.

To reuse existing local clones:

```sh
pnpm uat:large-repos -- \
  --repo github-docs=/path/to/github-docs \
  --repo next-js=/path/to/next.js \
  --max-files 120 \
  --timeout-ms 90000 \
  --report .rizz/uat/combined-120-priority-uat-report.json
```

Pass criteria:

- every selected repo exits `0` without timing out
- progress shows `prepare`, `scan`, `analyze`, `write`, and `done` phases
- capped scans report nonzero commands and tests for repos with manifests/tests
- generated report records `fresh_rizz: true`, `timeout_ms`, `max_files`, traversal priority,
  `planned_scorecard`, `matrix_scorecard`, and per-repo scanned file, command, test, tool, and
  security counts
- every repo report includes `progress_summary.phase_durations_ms`, slowest progress steps, and
  the actual out-of-100 `capability_scorecard` from `.rizz/research/understanding_score.json`
- reruns start from fresh generated artifacts unless `--preserve-rizz` is intentionally used

## Public install smoke

```sh
TMP_PREFIX="$(mktemp -d)"
npm install -g --prefix "$TMP_PREFIX" @valoir/rizz
"$TMP_PREFIX/bin/rizz" --version
"$TMP_PREFIX/bin/rizz" --help
"$TMP_PREFIX/bin/rizz" setup --dry-run
rm -rf "$TMP_PREFIX"
```

Pass criteria:

- install succeeds without provider credentials
- `rizz --version` prints the expected version
- `rizz setup --dry-run` does not write `~/.rizz`
- output contains no secret-like strings

## First-run setup smoke

Use a temporary home for non-live checks:

```sh
TMP_HOME="$(mktemp -d)"
HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" node packages/cli/dist/index.js setup --dry-run
rm -rf "$TMP_HOME"
```

Pass criteria:

- dependency doctor runs
- non-interactive output does not greet the system user as if chosen
- no config, profile, model, or credential file is written
- no provider key is required during install or dry-run setup

## OpenRouter live UAT

Prerequisite: an OpenRouter key stored locally through `rizz setup`.

```sh
rizz setup
rizz
```

Inside TUI:

```text
/status
/model
hi
```

Pass criteria:

- OpenRouter is selectable and starts a live session
- `/status` shows provider, auth, billing, model, context, tokens, branch, and permissions
- `/model` shows selectable BYOK models without exposing keys
- a simple turn returns a real assistant response quickly enough for UAT
- progress output does not leak provider keys or raw auth details

## Codex route smoke

Prerequisite: Codex is installed and signed in locally.

```sh
rizz setup
```

Choose Codex subscription.

Pass criteria:

- setup explains Codex auth without asking for a Codex token
- TUI starts when local Codex auth is available
- status shows `Codex · GPT-5` and `$0.00 (sub)` unless Codex reports a different model
- model switching clearly says Codex switching is not available in this release when unavailable

## Website smoke

Check the Valoir website install copy before release:

- macOS/Linux command uses public npm or the stable hosted installer
- Windows command uses npm global install
- no command exposes `Lokesh-4946` in user-facing website copy unless intentionally linking GitHub
- provider keys are entered only in `rizz setup`, not during install

## UAT blocker rules

Block public UAT when:

- install fails on a supported platform
- setup dry-run writes files or credentials
- output leaks keys, tokens, or npm secrets
- `/status` misreports billing/auth/model route
- OpenRouter live path cannot complete a basic turn
- footprint budget fails
- default install loads Workspace/Jarvis/memory/connectors

Known limitations are acceptable when they are clearly documented and do not compromise safety.
