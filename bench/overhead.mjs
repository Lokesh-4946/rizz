/**
 * Hook latency and fold throughput, measured against product commit c1d1248
 * as the "before" baseline.
 *
 * Hook latency is wall time from process spawn to exit for
 * `rizz hook <host> <event>`, including Node startup of the built CLI.
 * The baseline is a no-op Node process that reads the same stdin and exits.
 * Percentiles are nearest-rank: index = ceil(p/100 * n) - 1 on the sorted
 * sample. Warmup iterations are discarded.
 *
 * Fold throughput writes N already-normalized events into spool/events.jsonl
 * and times one `rizz fold` on a fresh RIZZ_HOME. The reported point is the
 * median of 5 runs. This does not include hook-process startup.
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PRODUCT_COMMIT,
  assertCliBuilt,
  assertProductTree,
  freshDir,
  machineInfo,
  median,
  percentile,
  removeDir,
  repoRoot,
  runRizz,
} from './lib.mjs';

const HOOKS = [
  ['cursor', 'sessionStart'],
  ['cursor', 'beforeSubmitPrompt'],
  ['cursor', 'afterFileEdit'],
  ['cursor', 'afterShellExecution'],
  ['cursor', 'postToolUse'],
  ['cursor', 'subagentStart'],
  ['cursor', 'subagentStop'],
  ['cursor', 'afterAgentResponse'],
  ['cursor', 'preCompact'],
  ['cursor', 'stop'],
  ['cursor', 'sessionEnd'],
  ['codex', 'SessionStart'],
  ['codex', 'UserPromptSubmit'],
  ['codex', 'PostToolUse'],
  ['codex', 'SubagentStop'],
  ['codex', 'Stop'],
  ['codex', 'SessionEnd'],
  ['claude', 'SessionStart'],
  ['claude', 'UserPromptSubmit'],
  ['claude', 'PostToolUse'],
  ['claude', 'Stop'],
];

const FOLD_SIZES = [100, 1000, 10000];
const FOLD_RUNS = 5;

function integerEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const SAMPLES = integerEnv('BENCH_SAMPLES', 100);
const WARMUP = integerEnv('BENCH_WARMUP', 10);

function payload(host, event) {
  return JSON.stringify({
    conversation_id: 'bench-overhead',
    session_id: 'bench-overhead',
    generation_id: `seq-${host}-${event}`,
    hook_event_name: event,
    prompt: 'overhead bench',
    cwd: '/tmp',
  });
}

function timeCommand(command, args, stdin) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    let failed = false;
    child.once('error', (error) => {
      failed = true;
      reject(error);
    });
    child.stdin.once('error', (error) => {
      failed = true;
      reject(error);
    });
    child.stdin.end(stdin);
    child.once('close', (code, signal) => {
      if (failed) return;
      resolve({ ms: performance.now() - started, code, signal });
    });
  });
}

async function timeHook(host, event, home, project) {
  const stdin = payload(host, event);
  const samples = [];
  for (let index = 0; index < WARMUP + SAMPLES; index += 1) {
    const started = performance.now();
    const result = await runRizz(['hook', host, event], { cwd: project, home, stdin });
    if (result.code !== 0) {
      throw new Error(`hook ${host} ${event} exited ${result.code}: ${result.stderr}`);
    }
    if (index >= WARMUP) samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { stdinBytes: Buffer.byteLength(stdin), samples };
}

async function timeNoop(stdin) {
  const source = [
    'let body = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { body += chunk; });',
    'process.stdin.on("end", () => process.exit(0));',
  ].join('');
  const samples = [];
  for (let index = 0; index < WARMUP + SAMPLES; index += 1) {
    const result = await timeCommand(process.execPath, ['-e', source], stdin);
    if (result.code !== 0) throw new Error(`noop exited ${result.code}`);
    if (index >= WARMUP) samples.push(result.ms);
  }
  samples.sort((a, b) => a - b);
  return samples;
}

function summarize(samples) {
  return {
    n: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    min: samples[0] ?? null,
    max: samples.at(-1) ?? null,
  };
}

function spoolEvent(index, projectRoot) {
  const seq = `seq-${String(index + 1).padStart(6, '0')}`;
  return {
    id: `bench:beforeSubmitPrompt:${seq}`,
    at: '2026-10-30T12:00:00.000Z',
    tool: 'cursor',
    hook: 'beforeSubmitPrompt',
    threadId: 'cursor-bench',
    projectRoot,
    kind: 'prompt',
    text: seq,
    files: [],
    fields: {},
  };
}

async function timeFold(size, project) {
  const root = realpathSync(project);
  const line = `${JSON.stringify(spoolEvent(0, root))}\n`;
  const runs = [];
  for (let run = 1; run <= FOLD_RUNS; run += 1) {
    const home = await freshDir('rizz-fold-home-');
    try {
      await mkdir(join(home, 'spool'), { recursive: true });
      const chunks = [];
      for (let index = 0; index < size; index += 1) {
        chunks.push(`${JSON.stringify(spoolEvent(index, root))}\n`);
      }
      await writeFile(join(home, 'spool', 'events.jsonl'), chunks.join(''));
      const started = performance.now();
      const result = await runRizz(['fold'], { cwd: project, home });
      const ms = performance.now() - started;
      if (result.code !== 0) {
        throw new Error(`fold ${size} run ${run} failed: ${result.stderr}`);
      }
      runs.push({ run, ms, stdout: result.stdout.trim() });
      process.stderr.write(`fold ${size} run ${run}: ${ms.toFixed(0)} ms\n`);
    } finally {
      await removeDir(home);
    }
  }
  const times = runs.map((run) => run.ms);
  const mid = median(times);
  return {
    events: size,
    runs,
    medianMs: mid,
    eventsPerSecond: mid === null || mid === 0 ? null : (size / mid) * 1000,
    spoolLineBytes: Buffer.byteLength(line),
  };
}

function renderMarkdown(report) {
  const machine = report.machine;
  const lines = [];
  lines.push('# Overhead baseline (before)');
  lines.push('');
  lines.push(`Product commit: \`${machine.commit}\``);
  lines.push(`HEAD: \`${machine.head}\``);
  lines.push(`Node: ${machine.node}`);
  lines.push(`CPU: ${machine.cpu.model} (${machine.cpu.count} cores)`);
  lines.push(`OS: ${machine.platform} ${machine.release} ${machine.arch}`);
  lines.push(`Filesystem: ${machine.filesystem}`);
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push(
    `Hook samples: ${report.samples} after ${report.warmup} discarded warmup iterations. Percentiles are nearest-rank. The no-op baseline is \`node -e\` reading the same stdin and exiting 0. Hook time is the full \`node <built cli> hook <host> <event>\` wall time, which is what a host pays. The delta is the difference of the two percentiles, not the percentile of paired differences. Each event uses its own fresh RIZZ_HOME.`,
  );
  lines.push('');
  lines.push(
    `Fold: for each of ${report.foldRuns} runs, a fresh RIZZ_HOME receives a spool of N pre-normalized events (one thread, fixed timestamp) and one \`rizz fold\`. Throughput uses the median wall time. Spool lines are about ${report.folds[0]?.spoolLineBytes ?? 0} bytes each.`,
  );
  lines.push('');
  lines.push('## Hook latency');
  lines.push('');
  lines.push('| host | event | p50 ms | p95 ms | noop p50 | noop p95 | p50 − noop | p95 − noop |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of report.hooks) {
    const p50 = row.hook.p50 ?? 0;
    const p95 = row.hook.p95 ?? 0;
    const n50 = row.noop.p50 ?? 0;
    const n95 = row.noop.p95 ?? 0;
    lines.push(
      `| ${row.host} | ${row.event} | ${p50.toFixed(1)} | ${p95.toFixed(1)} | ${n50.toFixed(1)} | ${n95.toFixed(1)} | ${(p50 - n50).toFixed(1)} | ${(p95 - n95).toFixed(1)} |`,
    );
  }
  lines.push('');
  lines.push('## Fold throughput');
  lines.push('');
  lines.push('| events | median ms | events/s | run ms |');
  lines.push('| ---: | ---: | ---: | --- |');
  for (const fold of report.folds) {
    const listed = fold.runs.map((run) => run.ms.toFixed(0)).join(', ');
    const rate = fold.eventsPerSecond === null ? '' : fold.eventsPerSecond.toFixed(1);
    lines.push(`| ${fold.events} | ${fold.medianMs.toFixed(0)} | ${rate} | ${listed} |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function writeReport(report) {
  const outDir = join(repoRoot, 'bench/results');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'overhead.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, 'overhead.md'), renderMarkdown(report));
}

async function main() {
  assertCliBuilt();
  assertProductTree();
  const project = await freshDir('rizz-overhead-proj-');
  const hooks = [];
  const folds = [];
  try {
    for (const [host, event] of HOOKS) {
      process.stderr.write(`overhead hook ${host} ${event}\n`);
      const eventHome = await freshDir('rizz-overhead-event-');
      try {
        const measured = await timeHook(host, event, eventHome, project);
        const noop = summarize(await timeNoop(payload(host, event)));
        hooks.push({
          host,
          event,
          stdinBytes: measured.stdinBytes,
          hook: summarize(measured.samples),
          noop,
        });
      } finally {
        await removeDir(eventHome);
      }
      await writeReport({
        machine: machineInfo(),
        productCommit: PRODUCT_COMMIT,
        label: 'before',
        samples: SAMPLES,
        warmup: WARMUP,
        foldRuns: FOLD_RUNS,
        hooks,
        folds,
      });
    }
    for (const size of FOLD_SIZES) {
      process.stderr.write(`overhead fold ${size}\n`);
      folds.push(await timeFold(size, project));
      await writeReport({
        machine: machineInfo(),
        productCommit: PRODUCT_COMMIT,
        label: 'before',
        samples: SAMPLES,
        warmup: WARMUP,
        foldRuns: FOLD_RUNS,
        hooks,
        folds,
      });
    }
  } finally {
    await removeDir(project);
  }
  process.stderr.write('overhead wrote bench/results/overhead.md\n');
}

await main();
