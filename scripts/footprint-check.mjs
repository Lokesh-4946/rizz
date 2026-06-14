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

const isShipped = (name) => !name.endsWith('.map') && !/\.test\./.test(name);

/** Bytes of shipped `.js` + `.d.ts` under one package's dist (excludes maps + tests, D-026). */
function packageDistBytes(pkg) {
  const dist = join(root, 'packages', pkg, 'dist');
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (isShipped(entry.name)) bytes += statSync(full).size;
    }
  };
  try {
    if (statSync(dist).isDirectory()) walk(dist);
  } catch {
    // package has no dist yet — skip
  }
  return bytes;
}

/**
 * Installed CORE footprint (KB): shipped `.js` + `.d.ts` across the default/core packages only.
 * `optInPackages` (D-001) are summoned, not on the default path, so they do NOT count toward the core
 * budget (they may carry their own budget later). Source maps + compiled tests are excluded as
 * dev-only (D-026). Returns a per-package breakdown so a regression points at the package that grew.
 */
function distKb() {
  const optIn = new Set(budget.optInPackages ?? []);
  const perPackage = [];
  let bytes = 0;
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const pkgBytes = packageDistBytes(pkg);
    if (pkgBytes === 0) continue;
    const counted = !optIn.has(pkg);
    perPackage.push({ pkg, kb: Math.round(pkgBytes / 1024), counted });
    if (counted) bytes += pkgBytes;
  }
  return { total: Math.round(bytes / 1024), perPackage };
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

const dist = distKb();
const actual = { coldStartMs: coldStartMs(), distKb: dist.total };

const checks = [
  { name: 'cold start', key: 'coldStartMs', unit: 'ms' },
  { name: 'core size', key: 'distKb', unit: 'KB' },
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

// Per-package breakdown — opt-in packages are shown but marked as not counted (D-001).
console.log('\n  package          size   counted');
console.log('  ─────────────────────────────────');
for (const { pkg, kb, counted } of dist.perPackage) {
  console.log(`  ${pkg.padEnd(14)} ${`${kb}KB`.padStart(6)}   ${counted ? 'yes' : 'opt-in'}`);
}

if (failed) {
  console.error(
    '\n✗ footprint budget exceeded — lightweight constraint regressed. See .footprint-budget.json.',
  );
  process.exit(1);
}
console.log('\n✓ within footprint budget.');
