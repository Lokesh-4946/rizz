#!/usr/bin/env node
// install-local — put a `rizz` command on PATH for dogfooding, without publishing (D-031 step 2).
// It writes a tiny shim to ~/.local/bin/rizz (override with --dir <path>) that execs the built CLI.
// No more `node packages/cli/dist/index.js`. Run `pnpm build` first so dist exists.
//
// POSIX only (sh shim). On Windows use the documented `pnpm -C packages/cli link --global` path
// (see runbooks/install.md). This script never installs anything global or networked.

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const USAGE = `Usage:
  node scripts/install-local.mjs [--dir <path>]
  node scripts/install-local.mjs --help`;

function parseArgs(argv) {
  let dir;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
        if (argv.length === 1) return { ok: true, help: true };
        return { ok: false, message: '--help cannot be combined with other arguments' };
      case '--dir': {
        if (dir !== undefined) return { ok: false, message: '--dir can only be provided once' };
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return { ok: false, message: '--dir needs a path' };
        }
        dir = resolve(value);
        i += 1;
        break;
      }
      default:
        if (arg.startsWith('--')) return { ok: false, message: 'unknown option' };
        return { ok: false, message: 'unexpected argument' };
    }
  }
  return { ok: true, help: false, dir: dir ?? join(homedir(), '.local', 'bin') };
}

function usageError(message) {
  console.error(`install-local: ${message}\n${USAGE}`);
  return 2;
}

function failure(message, error) {
  const detail = error instanceof Error ? `: ${error.message}` : '';
  console.error(`install-local: ${message}${detail}`);
  return 1;
}

function readExistingShim(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) return usageError(parsed.message);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }

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

  const binDir = parsed.dir;
  const shimPath = join(binDir, 'rizz');
  try {
    mkdirSync(binDir, { recursive: true });
    const existing = readExistingShim(shimPath);
    if (existing !== undefined) {
      if (existing.isDirectory()) {
        console.error(`install-local: ${shimPath} is a directory; remove it or pass --dir.`);
        return 1;
      }
      // Remove before writing so an old symlink cannot redirect the shim into dist/.
      unlinkSync(shimPath);
    }
    // Single-quote the path so `$`, backticks, and `"` in the repo path can't expand/break the shim;
    // the only char to escape inside single quotes is `'` itself (→ '\'' ). exec so Ctrl+C reaches
    // node directly; "$@" forwards all args.
    const quotedEntry = `'${cliEntry.replace(/'/g, "'\\''")}'`;
    writeFileSync(shimPath, `#!/bin/sh\nexec node ${quotedEntry} "$@"\n`, { mode: 0o755 });
    chmodSync(shimPath, 0o755);
  } catch (error) {
    return failure(`could not install shim at ${shimPath}`, error);
  }

  console.log(`✓ installed: ${shimPath} -> ${cliEntry}`);
  // Best-effort PATH check: normalize segments so a trailing slash / relative form doesn't read as absent.
  const target = resolve(binDir);
  try {
    const onPath = (process.env.PATH ?? '')
      .split(':')
      .some((seg) => seg !== '' && resolve(seg) === target);
    if (!onPath) {
      console.log(`\n${binDir} is not on your PATH. Add it (then restart your shell):`);
      console.log(`  export PATH="${binDir}:$PATH"`);
    } else {
      console.log('\nrun:  rizz --help');
    }
  } catch (error) {
    return failure('could not inspect PATH', error);
  }
  return 0;
}

process.exit(main());
