#!/usr/bin/env node
// install-local — put a `rizz` command on PATH for dogfooding, without publishing (D-031 step 2).
// It writes a tiny shim to ~/.local/bin/rizz (override with --dir <path>) that execs the built CLI.
// No more `node packages/cli/dist/index.js`. Run `pnpm build` first so dist exists.
//
// POSIX only (sh shim). On Windows use the documented `pnpm -C packages/cli link --global` path
// (see runbooks/install.md). This script never installs anything global or networked.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

function parseDir(argv) {
  const i = argv.indexOf('--dir');
  if (i !== -1 && argv[i + 1] !== undefined) return resolve(argv[i + 1]);
  return join(homedir(), '.local', 'bin');
}

function main() {
  if (process.platform === 'win32') {
    console.error(
      'install-local: Windows is not supported by this shim. Use:\n  pnpm build && pnpm -C packages/cli link --global\nSee runbooks/install.md.',
    );
    return 1;
  }
  if (!existsSync(cliEntry)) {
    console.error(`install-local: ${cliEntry} not found — run \`pnpm build\` first.`);
    return 1;
  }

  const binDir = parseDir(process.argv.slice(2));
  const shimPath = join(binDir, 'rizz');
  mkdirSync(binDir, { recursive: true });
  // Single-quote the path so `$`, backticks, and `"` in the repo path can't expand/break the shim;
  // the only char to escape inside single quotes is `'` itself (→ '\'' ). exec so Ctrl+C reaches
  // node directly; "$@" forwards all args.
  const quotedEntry = `'${cliEntry.replace(/'/g, "'\\''")}'`;
  writeFileSync(shimPath, `#!/bin/sh\nexec node ${quotedEntry} "$@"\n`, { mode: 0o755 });
  chmodSync(shimPath, 0o755);

  console.log(`✓ installed: ${shimPath} -> ${cliEntry}`);
  // Best-effort PATH check: normalize segments so a trailing slash / relative form doesn't read as absent.
  const target = resolve(binDir);
  const onPath = (process.env.PATH ?? '')
    .split(':')
    .some((seg) => seg !== '' && resolve(seg) === target);
  if (!onPath) {
    console.log(`\n${binDir} is not on your PATH. Add it (then restart your shell):`);
    console.log(`  export PATH="${binDir}:$PATH"`);
  } else {
    console.log('\nrun:  rizz --help');
  }
  return 0;
}

process.exit(main());
