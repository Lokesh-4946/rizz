/**
 * Time a full spool fold. Not part of CI.
 *
 *   node scripts/observe-fold-bench.mjs <events.jsonl> [limit ...]
 *
 * Build first (`pnpm exec tsc -b`). Each limit uses a fresh home and project.
 * Prints fold wall time only; spooling is reported separately.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
const limits = process.argv.slice(3).map((value) => Number(value));
if (
  file === undefined ||
  file === '' ||
  limits.some((value) => !Number.isInteger(value) || value <= 0)
) {
  process.stderr.write('usage: node scripts/observe-fold-bench.mjs <events.jsonl> [limit ...]\n');
  process.exit(2);
}

const dist = pathToFileURL(`${process.cwd()}/packages/brain/dist/observe/`).href;
const { receiveHook } = await import(new URL('receive.js', dist).href);
const { foldSpool } = await import(new URL('fold.js', dist).href);

const rows = readFileSync(file, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));
const sizes = limits.length === 0 ? [rows.length] : limits;
const at = '2026-10-28T12:00:00.000Z';

for (const size of sizes) {
  const sample = rows.slice(0, size);
  const home = await mkdtemp(join(tmpdir(), 'rizz-fold-bench-'));
  const project = await mkdtemp(join(tmpdir(), 'rizz-fold-bench-project-'));
  const spoolStarted = Date.now();
  for (const row of sample) {
    const response = await receiveHook({
      tool: row.host,
      hook: row.hook,
      stdin: JSON.stringify({ ...row.payload, workspace_roots: [project], cwd: project }),
      projectRoot: project,
      rizzHome: home,
      at,
    });
    if (response.exitCode !== 0 || response.stderr !== '') {
      process.stderr.write(`spool failed: ${response.stderr}\n`);
      process.exit(1);
    }
  }
  const spoolMs = Date.now() - spoolStarted;
  const foldStarted = Date.now();
  const folded = await foldSpool(home);
  const foldMs = Date.now() - foldStarted;
  if (!folded.ok) {
    process.stderr.write(`fold failed: ${folded.error.message}\n`);
    process.exit(1);
  }
  const perSecond = foldMs === 0 ? sample.length : Math.round((sample.length / foldMs) * 1000);
  process.stdout.write(
    `${JSON.stringify({
      file,
      events: sample.length,
      applied: folded.value.applied,
      duplicates: folded.value.duplicates,
      spoolMs,
      foldMs,
      foldPerSecond: perSecond,
    })}\n`,
  );
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
}
