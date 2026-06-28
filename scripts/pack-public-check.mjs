#!/usr/bin/env node
// Verify public npm tarballs match the lightweight footprint contract.

import { spawnSync } from 'node:child_process';

const packages = [
  '@valoir/rizz-brain',
  '@valoir/rizz-providers',
  '@valoir/rizz-core',
  '@valoir/rizz-tui',
  '@valoir/rizz',
];

const allowedFile =
  /^(package\/)?(package\.json|README\.md|LICENSE|LICENCE|dist\/.+\.(js|d\.ts))$/i;
const forbiddenFile = /(\.map$|\.test\.|^package\/src\/|^src\/)/;

function runPnpm(args) {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed\n${result.stdout}${result.stderr}`);
  }

  return result.stdout;
}

function parsePackJson(output, packageName) {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) {
    throw new Error(`could not parse pack dry-run JSON for ${packageName}: ${error.message}`);
  }

  throw new Error(`empty pack dry-run JSON for ${packageName}`);
}

let failures = 0;

for (const packageName of packages) {
  const output = runPnpm(['--filter', packageName, 'pack', '--dry-run', '--json']);
  const packed = parsePackJson(output, packageName);
  const files = Array.isArray(packed.files) ? packed.files.map((file) => file.path) : [];

  if (files.length === 0) {
    console.error(`${packageName}: no files reported by pack dry-run`);
    failures += 1;
    continue;
  }

  const badFiles = files.filter((file) => forbiddenFile.test(file) || !allowedFile.test(file));

  if (badFiles.length > 0) {
    console.error(`${packageName}: unexpected files in publish tarball`);
    for (const file of badFiles) console.error(`  - ${file}`);
    failures += 1;
    continue;
  }

  console.log(`${packageName}: ${files.length} publish file(s) ok`);
}

if (failures > 0) process.exit(1);
