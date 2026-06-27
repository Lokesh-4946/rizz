# Release runbook

This runbook keeps public releases boring: `develop` integrates, `main` releases, npm publishes the
same version.

## Release shape

- Package scope: `@valoir`
- Public CLI package: `@valoir/rizz`
- Internal packages: `@valoir/rizz-core`, `@valoir/rizz-providers`, `@valoir/rizz-tui`
- Current release baseline: `0.1.0`

## Pre-release checklist

Run from `develop`:

```sh
git switch develop
git pull --ff-only
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
pnpm pack:public
```

Run the UAT checklist in `runbooks/uat-agent-light.md`.

Confirm:

- no provider keys in logs, docs, PRs, or shell history
- no Workspace, Repo Brain, OS/Jarvis connectors, skills, or enterprise providers in the default
  install path
- version numbers are intentional
- `README.md` and `runbooks/install.md` show the same public install commands

## Release PR

Open a PR from `develop` to `main`.

The PR body must include:

- version
- user-facing changes
- package list
- verification output
- UAT result
- known limits

Merge only after GitHub CI passes on Ubuntu, macOS, and Windows.

## Tag

After the release PR lands on `main`:

```sh
git switch main
git pull --ff-only
git tag v0.1.0
git push origin v0.1.0
```

Use the actual release version in the tag.

## npm publish

Preferred future path: npm Trusted Publishing from GitHub Actions.

Manual fallback:

```sh
npm whoami
npm org ls valoir
npm publish ./dist-pack/valoir-rizz-providers-0.1.0.tgz --access public --otp <OTP>
npm publish ./dist-pack/valoir-rizz-core-0.1.0.tgz --access public --otp <OTP>
npm publish ./dist-pack/valoir-rizz-tui-0.1.0.tgz --access public --otp <OTP>
npm publish ./dist-pack/valoir-rizz-0.1.0.tgz --access public --otp <OTP>
```

Never paste npm tokens or provider keys into chat, docs, handoffs, GitHub, or screenshots.

## Post-release smoke

Use a temporary npm prefix so the smoke does not depend on local global state:

```sh
TMP_PREFIX="$(mktemp -d)"
npm install -g --prefix "$TMP_PREFIX" @valoir/rizz
"$TMP_PREFIX/bin/rizz" --version
"$TMP_PREFIX/bin/rizz" setup --dry-run
rm -rf "$TMP_PREFIX"
```

Then update:

- `README.md` release baseline, if changed
- `runbooks/install.md`
- Valoir website install copy
- Labs product tracker
- Agents handoff

## Do not release when

- CI is failing or missing on a supported OS
- footprint exceeds the budget
- setup dry-run writes config or credentials
- public install needs a provider key during install
- secrets appear in output
- default startup loads Workspace/Jarvis/memory/connectors
