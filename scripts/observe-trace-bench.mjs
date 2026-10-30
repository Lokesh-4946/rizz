/**
 * Replay a host trace and count how many spool ids survive.
 * s12-trace-10k is too large to commit; point this at a local events.jsonl.
 *
 *   node scripts/observe-trace-bench.mjs /path/to/events.jsonl
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
if (file === undefined || file === '') {
  process.stderr.write('usage: node scripts/observe-trace-bench.mjs <events.jsonl>\n');
  process.exit(2);
}

const modelUrl = pathToFileURL(`${process.cwd()}/packages/brain/dist/observe/model.js`).href;
const model = await import(modelUrl);
const rows = readFileSync(file, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));
const at = '2026-10-28T12:00:00.000Z';
let sequence = 0;
const ids = [];
for (const row of rows) {
  const payload = row.payload ?? {};
  let id = model.observeEventId(row.hook, payload, at);
  if (model.hasSharedTurnIdentity(payload)) {
    id = `${id}:s${sequence}`;
    sequence += 1;
  }
  ids.push(id);
}
const unique = new Set(ids).size;
process.stdout.write(
  `${JSON.stringify({
    file,
    events: rows.length,
    uniqueIds: unique,
    dropped: rows.length - unique,
  })}\n`,
);
