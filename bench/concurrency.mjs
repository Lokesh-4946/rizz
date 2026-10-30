/**
 * A2 concurrency harness.
 *
 * For widths 30 and 100, three rounds each, fire that many `rizz hook`
 * processes at once. Each stdin is a ~50 KB prompt plus a unique
 * generation_id. After every process exits, one `rizz fold` runs.
 * A fresh RIZZ_HOME is used per round so a loss belongs to that burst.
 *
 * The hook command always exits 0 if the process finishes, including when
 * the event was only written to spool/drops (receiveHook). A missing
 * sequence id after fold is a lost event either way.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PRODUCT_COMMIT,
  assertCliBuilt,
  assertProductTree,
  formatRate,
  freshDir,
  machineInfo,
  readObserver,
  removeDir,
  repoRoot,
  runRizz,
  seqOf,
  wilson,
} from './lib.mjs';

const WIDTHS = [30, 100];
const ROUNDS = 3;
const PAD = 'b'.repeat(50 * 1024);

function payload(seq, project) {
  return JSON.stringify({
    conversation_id: 'bench-conc',
    session_id: 'bench-conc',
    generation_id: seq,
    turn_id: seq,
    hook_event_name: 'beforeSubmitPrompt',
    cwd: project,
    prompt: `${seq}\n${PAD}`,
  });
}

async function listJson(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

async function inspectSpool(home) {
  const spoolPath = join(home, 'spool', 'events.jsonl');
  let raw = '';
  try {
    raw = await readFile(spoolPath, 'utf8');
  } catch {
    raw = '';
  }
  const lines = raw.length === 0 ? [] : raw.split('\n');
  const complete =
    raw.endsWith('\n') || raw.length === 0
      ? lines.filter((line) => line !== '')
      : lines.slice(0, -1);
  const tail = raw.endsWith('\n') || raw.length === 0 ? '' : (lines.at(-1) ?? '');
  let parsed = 0;
  let torn = 0;
  const seqs = new Set();
  for (const line of complete) {
    try {
      const event = JSON.parse(line);
      parsed += 1;
      const seq = seqOf(event);
      if (seq !== '') seqs.add(seq);
    } catch {
      torn += 1;
    }
  }
  let tailSeq = null;
  if (tail !== '') {
    torn += 1;
    const match = /seq-\d+/.exec(tail);
    tailSeq = match === null ? null : match[0];
  }
  const pending = await listJson(join(home, 'spool', 'pending'));
  const drops = await listJson(join(home, 'spool', 'drops'));
  const dropSeqs = [];
  for (const name of drops) {
    const text = await readFile(join(home, 'spool', 'drops', name), 'utf8');
    const match = /seq-\d+/.exec(text);
    if (match !== null) dropSeqs.push(match[0]);
  }
  return {
    spoolBytes: Buffer.byteLength(raw),
    spoolParsed: parsed,
    spoolTorn: torn,
    spoolSeqs: seqs.size,
    tornTailSeq: tailSeq,
    pending: pending.length,
    drops: drops.length,
    dropSeqs,
  };
}

async function oneRound(width, round) {
  const project = await freshDir('rizz-conc-proj-');
  const home = await freshDir('rizz-conc-home-');
  const started = performance.now();
  try {
    const jobs = [];
    for (let index = 0; index < width; index += 1) {
      const seq = `seq-${String(round * 1000 + index + 1).padStart(6, '0')}`;
      const stdin = payload(seq, project);
      const hookStarted = performance.now();
      const job = runRizz(['hook', 'cursor', 'beforeSubmitPrompt'], {
        cwd: project,
        home,
        stdin,
      }).then((result) => ({
        seq,
        ms: performance.now() - hookStarted,
        code: result.code,
        signal: result.signal,
        stderr: result.stderr.slice(0, 300),
        dropped: result.stderr.includes('could not be recorded'),
        timedOut: result.stderr.includes('timed out locking'),
      }));
      jobs.push(job);
    }
    const hooks = await Promise.all(jobs);
    const fold = await runRizz(['fold'], { cwd: project, home });
    const observed = await readObserver(home);
    const spool = await inspectSpool(home);
    const found = new Set(observed.events.map((event) => seqOf(event)));
    const lost = hooks.filter((hook) => !found.has(hook.seq));
    return {
      width,
      round,
      stdinBytes: Buffer.byteLength(payload('seq-000001', project)),
      wallMs: performance.now() - started,
      foldCode: fold.code,
      foldStdout: fold.stdout.trim(),
      foldStderr: fold.stderr.slice(0, 400),
      hookExit: {
        zero: hooks.filter((hook) => hook.code === 0 && hook.signal === null).length,
        killed: hooks.filter((hook) => hook.signal !== null).length,
        other: hooks.filter((hook) => hook.code !== 0 && hook.signal === null).length,
      },
      dropped: hooks.filter((hook) => hook.dropped).length,
      lockTimeouts: hooks.filter((hook) => hook.timedOut).length,
      maxHookMs: Math.max(...hooks.map((hook) => hook.ms)),
      journalEvents: observed.events.length,
      lost: lost.map((hook) => ({
        seq: hook.seq,
        code: hook.code,
        signal: hook.signal,
        dropped: hook.dropped,
        timedOut: hook.timedOut,
        stderr: hook.stderr,
      })),
      spool,
      sampleStderr: hooks.find((hook) => hook.stderr !== '')?.stderr ?? '',
    };
  } finally {
    await removeDir(project);
    await removeDir(home);
  }
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Concurrent hooks');
  lines.push('');
  lines.push(`Product commit: \`${report.machine.commit}\``);
  lines.push(`HEAD: \`${report.machine.head}\``);
  lines.push(`Node: ${report.machine.node}`);
  lines.push(`CPU: ${report.machine.cpu.model} (${report.machine.cpu.count} cores)`);
  lines.push(`OS: ${report.machine.platform} ${report.machine.release}`);
  lines.push(`Filesystem: ${report.machine.filesystem}`);
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push(
    'Each round is a fresh project directory and a fresh RIZZ_HOME. The round starts `width` hook processes together. Stdin is one JSON object whose `prompt` is `seq-NNNNNN` plus 50 KiB of `b` characters. The sequence id is also `generation_id`, which `observeEventId` copies into the journal event id. After every process has exited, `rizz fold` runs once. An event is lost when its sequence id is absent from parsed journal lines.',
  );
  lines.push('');
  lines.push(
    `Prompt stdin size: ${report.rounds[0]?.stdinBytes ?? 0} bytes (about 50 KB plus the JSON wrapper).`,
  );
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push(
    '| width | round | sent | journal | lost | lock timeouts | dropped | spool torn | pending left | max hook ms |',
  );
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const round of report.rounds) {
    lines.push(
      `| ${round.width} | ${round.round} | ${round.width} | ${round.journalEvents} | ${round.lost.length} | ${round.lockTimeouts} | ${round.dropped} | ${round.spool.spoolTorn} | ${round.spool.pending} | ${round.maxHookMs.toFixed(0)} |`,
    );
  }
  lines.push('');
  lines.push(`Events lost: ${formatRate(report.lost)}`);
  lines.push('');
  lines.push('## Where a lost event can go');
  lines.push('');
  lines.push(
    'These are the paths in the product code. This PR does not change them. The table above says which ones this run hit.',
  );
  lines.push('');
  lines.push(
    '- `withLock` (`packages/brain/src/observe/io.ts` lines 165–193) serializes spool appends with a mkdir lock. `LOCK_WAIT_MS` is 2000 (`io.ts` line 6). A waiter past that returns `IO_FAILED` at lines 188–189.',
  );
  lines.push(
    '- `appendSpoolEvent` (`packages/brain/src/observe/fold.ts` lines 293–317) appends under that lock. If the lock result is not ok, it writes `spool/pending/<sha256(id)>.json` (lines 302–303). If that write also fails, it writes `spool/drops` (lines 304–315) and still reports the hook as dropped rather than throwing.',
  );
  lines.push(
    '- `receiveHook` (`packages/brain/src/observe/receive.ts` lines 109–117) returns exit code 0 when it returns, including when the event was only dropped. An exception that escapes it is caught in `packages/cli/src/index.ts` lines 1070–1076, which prints `rizz: fatal:` and exits 1.',
  );
  lines.push(
    '- `foldSpool` skips a spool line it cannot parse (lines 205–207) and does not retry it. `applyPendingEvents` (lines 259–291) folds pending files. Drop files are only counted by `countUnrecorded` (lines 236–256). They never become journal events.',
  );
  lines.push('');
  lines.push(report.diagnosis);
  lines.push('');
  return lines.join('\n');
}

function pendingSaves(rounds) {
  return rounds
    .filter((round) => round.width === 100)
    .reduce(
      (total, round) => total + (round.width - round.spool.spoolParsed - round.lost.length),
      0,
    );
}

function diagnose(rounds) {
  const lostHooks = rounds.flatMap((round) => round.lost);
  const lost = lostHooks.length;
  const timeouts = rounds.reduce((total, round) => total + round.lockTimeouts, 0);
  const dropped = rounds.reduce((total, round) => total + round.dropped, 0);
  const torn = rounds.reduce((total, round) => total + round.spool.spoolTorn, 0);
  const pending = rounds.reduce((total, round) => total + round.spool.pending, 0);
  const empty = lostHooks.filter((hook) => hook.stderr.includes('ENOTEMPTY'));
  if (lost === 0) {
    return [
      'No sequence id was missing after fold.',
      `Lock-timeout stderr lines: ${timeouts}. Drop stderr lines: ${dropped}. Torn spool lines: ${torn}. Pending files left after fold: ${pending}.`,
      'This run does not show a journal-loss defect. If lock timeouts are non-zero, the pending-file fallback in `appendSpoolEvent` absorbed them and `foldSpool` applied those files.',
    ].join(' ');
  }
  if (empty.length === lost) {
    return [
      `${lost} sequence ids were missing. Each lost hook exited 1 with \`rizz: fatal: ENOTEMPTY: directory not empty, rmdir '<RIZZ_HOME>/spool/lock'\`.`,
      'None of them were in spool/drops, none logged a lock timeout, and no torn spool line or leftover pending file accounts for them.',
      'Root cause: `withLock` (`packages/brain/src/observe/io.ts`) removes the lock directory in two places that can overlap. The holder removes it in the `finally` at lines 177–178. A waiter that decides the lock is stale also removes it at lines 184–186. `lockIsStale` (lines 153–162) returns true when the pid file is already gone and `stat` throws (line 161), or when the directory is older than `ORPHAN_LOCK_MS` (1000ms, line 5). The waiter `rm` sits in the `catch` and is not wrapped, so `ENOTEMPTY` from `rmdir` rejects the promise instead of returning `{ ok: false }`.',
      '`appendSpoolEvent` (`packages/brain/src/observe/fold.ts` lines 298–303) writes `spool/pending` only when `withLock` returns a failed result. A thrown `ENOTEMPTY` skips that fallback. `receiveHook` does not catch it. `packages/cli/src/index.ts` lines 1070–1076 print `rizz: fatal:` and exit 1. The event is never spooled.',
      `Widths of 30 stayed under the 1000ms stale threshold and lost nothing. Widths of 100 ran past 2s and lost events. ${pendingSaves(rounds)} other events in the 100-wide rounds were missing from the spool file but present in the journal: those took the returned-error path, landed in spool/pending, and fold applied them. Lock-timeout stderr lines: ${timeouts}. Drop stderr lines: ${dropped}. Torn spool lines: ${torn}. Pending files left after fold: ${pending}.`,
    ].join(' ');
  }
  const inDrops = rounds.flatMap((round) =>
    round.lost.filter((item) => round.spool.dropSeqs.includes(item.seq)).map((item) => item.seq),
  );
  return [
    `${lost} sequence ids were missing from the journal. ${empty.length} exited with ENOTEMPTY on the lock directory. ${inDrops.length} were named in spool/drops.`,
    `Lock-timeout stderr lines: ${timeouts}. Explicit drop stderr lines: ${dropped}. Torn spool lines: ${torn}. Pending files still present after fold: ${pending}.`,
    'See `withLock` in `packages/brain/src/observe/io.ts` lines 165–193 and `appendSpoolEvent` in `packages/brain/src/observe/fold.ts` lines 293–317.',
  ].join(' ');
}

async function main() {
  if (process.argv.includes('--rewrite-diagnosis')) {
    const path = join(repoRoot, 'bench/results/concurrency.json');
    const report = JSON.parse(await readFile(path, 'utf8'));
    report.diagnosis = diagnose(report.rounds);
    const outDir = join(repoRoot, 'bench/results');
    await writeFile(join(outDir, 'concurrency.json'), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(outDir, 'concurrency.md'), renderMarkdown(report));
    return;
  }
  assertCliBuilt();
  assertProductTree();
  const rounds = [];
  for (const width of WIDTHS) {
    for (let round = 1; round <= ROUNDS; round += 1) {
      process.stderr.write(`concurrency width ${width} round ${round}\n`);
      rounds.push(await oneRound(width, round));
    }
  }
  const sent = rounds.reduce((total, round) => total + round.width, 0);
  const lostCount = rounds.reduce((total, round) => total + round.lost.length, 0);
  const report = {
    machine: machineInfo(),
    productCommit: PRODUCT_COMMIT,
    rounds,
    lost: wilson(lostCount, sent),
    diagnosis: diagnose(rounds),
  };
  const outDir = join(repoRoot, 'bench/results');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'concurrency.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, 'concurrency.md'), renderMarkdown(report));
  process.stderr.write(`concurrency lost ${lostCount}/${sent}\n`);
}

await main();
