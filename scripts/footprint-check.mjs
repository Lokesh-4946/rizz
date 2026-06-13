#!/usr/bin/env node
// Footprint / cold-start budget gate (brief §2, §6). Builds the CLI, measures the cold start of
// the exact published binary and the total compiled size, and fails the build if either exceeds
// the budget in .footprint-budget.json. This is what keeps "extremely lightweight" honest.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const budget = JSON.parse(readFileSync(join(root, '.footprint-budget.json'), 'utf8'));

/** Total size (KB) of every package's compiled dist/ output. */
function distKb() {
  const packagesDir = join(root, 'packages');
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else bytes += statSync(full).size;
    }
  };
  for (const pkg of readdirSync(packagesDir)) {
    const dist = join(packagesDir, pkg, 'dist');
    try {
      if (statSync(dist).isDirectory()) walk(dist);
    } catch {
      // package has no dist yet — skip
    }
  }
  return Math.round(bytes / 1024);
}

/** Cold start (ms): best of N runs of `node dist/index.js --version`. Best-of removes scheduler noise. */
function coldStartMs(runs = 7) {
  const cli = join(root, 'packages', 'cli', 'dist', 'index.js');
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (r.status !== 0) throw new Error(`cli exited ${r.status}: ${r.stderr}`);
    best = Math.min(best, ms);
  }
  return Math.round(best);
}

console.log('› building packages for footprint check…');
// String form via execSync so the shell resolves `pnpm` → `pnpm.cmd` on Windows (execFileSync
// can't find it without the extension). Cross-platform.
execSync('pnpm -s build', { cwd: root, stdio: 'inherit' });

const actual = { coldStartMs: coldStartMs(), distKb: distKb() };

const checks = [
  { name: 'cold start', key: 'coldStartMs', unit: 'ms' },
  { name: 'compiled size', key: 'distKb', unit: 'KB' },
];

let failed = false;
console.log('\n  metric         actual   budget');
console.log('  ─────────────────────────────────');
for (const { name, key, unit } of checks) {
  const a = actual[key];
  const b = budget[key];
  const over = a > b;
  failed ||= over;
  const mark = over ? '✗ OVER' : '✓';
  console.log(
    `  ${name.padEnd(13)} ${`${a}${unit}`.padStart(6)}   ${`${b}${unit}`.padStart(6)}  ${mark}`,
  );
}

if (failed) {
  console.error(
    '\n✗ footprint budget exceeded — lightweight constraint regressed. See .footprint-budget.json.',
  );
  process.exit(1);
}
console.log('\n✓ within footprint budget.');
