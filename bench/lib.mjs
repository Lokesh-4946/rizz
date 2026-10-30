import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** dev at the merge of PR #198. Measurements run against this product tree. */
export const PRODUCT_COMMIT = 'c1d12483403461ef6795f91d67daf7a3952d7a20';

const EVENT_PREFIX = '%%rizz:event%%';

const benchDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = dirname(benchDir);
export const cliPath = join(repoRoot, 'packages/cli/dist/index.js');
export const killhookSource = join(benchDir, 'killhook.c');
export const killhookSo = join(benchDir, 'killhook.so');

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function assertCliBuilt() {
  if (!existsSync(cliPath)) {
    throw new Error(`rizz CLI is not built at ${cliPath}. Run pnpm build.`);
  }
}

export function assertProductTree() {
  const diff = spawnSync(
    'git',
    ['diff', '--name-only', PRODUCT_COMMIT, '--', 'packages', 'scripts', 'eval'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (diff.status !== 0) {
    throw new Error(diff.stderr || 'git diff failed while checking the product tree');
  }
  if (diff.stdout.trim() !== '') {
    throw new Error(`product tree differs from ${PRODUCT_COMMIT}:\n${diff.stdout}`);
  }
}

export function headCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return PRODUCT_COMMIT;
  return result.stdout.trim();
}

export function machineInfo() {
  const info = readFileSync('/proc/cpuinfo', 'utf8');
  const modelLine = info.split('\n').find((line) => line.startsWith('model name'));
  const fallback = cpus()[0]?.model ?? 'unknown';
  const model = modelLine === undefined ? fallback : modelLine.split(':')[1].trim();
  let filesystem = 'unknown';
  const mounted = spawnSync('findmnt', ['-T', tmpdir(), '-o', 'FSTYPE,SOURCE', '-n'], {
    encoding: 'utf8',
  });
  if (mounted.status === 0) filesystem = mounted.stdout.trim();
  return {
    commit: PRODUCT_COMMIT,
    head: headCommit(),
    node: process.version,
    platform: platform(),
    release: release(),
    arch: process.arch,
    cpu: { model, count: cpus().length },
    filesystem,
  };
}

/** Wilson score interval for a binomial proportion. z=1.96 is a 95% interval. */
export function wilson(successes, total, z = 1.96) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total < 0 || successes < 0) {
    throw new Error('wilson expects non-negative integer counts');
  }
  if (successes > total) throw new Error('wilson successes exceed total');
  if (total === 0) return { successes: 0, total: 0, rate: 0, low: 0, high: 0 };
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return {
    successes,
    total,
    rate: p,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export function formatRate(interval) {
  const pct = (value) => `${(100 * value).toFixed(3)}%`;
  const count = `${interval.successes}/${interval.total}`;
  const ci = `95% Wilson CI ${pct(interval.low)}–${pct(interval.high)}`;
  return `${count} (${pct(interval.rate)}, ${ci})`;
}

/** Nearest-rank percentile. p=50 on five sorted values is the middle one. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

export function compileKillhook() {
  const result = spawnSync(
    'gcc',
    ['-shared', '-fPIC', '-O2', '-pthread', '-o', killhookSo, killhookSource, '-ldl'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || 'gcc failed to build bench/killhook.so');
  }
  return killhookSo;
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spawn the built CLI. LD_PRELOAD is applied only when `preload` is set, so the
 * harness process itself is never intercepted.
 */
export function spawnRizz(args, options) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'LD_PRELOAD' || value === undefined) continue;
    env[key] = value;
  }
  env.RIZZ_HOME = options.home;
  if (options.extraEnv !== undefined) Object.assign(env, options.extraEnv);
  if (options.preload !== undefined) env.LD_PRELOAD = options.preload;
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr, pid: child.pid });
    });
  });
  const stdinError = new Promise((_, reject) => {
    child.stdin.once('error', reject);
  });
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();
  return {
    child,
    done: Promise.race([done, stdinError]),
    output() {
      return { stdout, stderr };
    },
  };
}

export async function runRizz(args, options) {
  const proc = spawnRizz(args, options);
  return proc.done;
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

export async function readCount(path) {
  try {
    const text = await readFile(path, 'utf8');
    const value = Number.parseInt(text.trim(), 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function parseJournal(text) {
  const events = [];
  const torn = [];
  const unterminated = text.length > 0 && !text.endsWith('\n');
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.includes('%%rizz:')) continue;
    const last = unterminated && index === lines.length - 1;
    if (!line.startsWith(EVENT_PREFIX)) {
      torn.push({ line: index + 1, sample: line.slice(0, 180), unterminated: last });
      continue;
    }
    try {
      const parsed = JSON.parse(line.slice(EVENT_PREFIX.length));
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.id === 'string') {
        events.push(parsed);
        if (last) {
          torn.push({
            line: index + 1,
            sample: 'event line has no trailing newline',
            unterminated: true,
          });
        }
      } else {
        torn.push({ line: index + 1, sample: line.slice(0, 180), unterminated: last });
      }
    } catch {
      torn.push({ line: index + 1, sample: line.slice(0, 180), unterminated: last });
    }
  }
  return { events, torn, unterminated };
}

export function seqOf(event) {
  const id = typeof event.id === 'string' ? event.id : '';
  const fromId = /seq-\d+/.exec(id);
  if (fromId !== null) return fromId[0];
  const text = typeof event.text === 'string' ? event.text : '';
  const fromText = /seq-\d+/.exec(text);
  return fromText === null ? id : fromText[0];
}

export async function readObserver(home) {
  const projects = join(home, 'projects');
  let ids = [];
  try {
    ids = await readdir(projects);
  } catch {
    return { events: [], torn: [], brain: null, brainCount: 0 };
  }
  const events = [];
  const torn = [];
  const brains = [];
  for (const id of ids) {
    const observe = join(projects, id, 'observe');
    try {
      brains.push(await readFile(join(observe, 'BRAIN.md'), 'utf8'));
    } catch {
      /* no brain yet */
    }
    let names = [];
    try {
      names = (await readdir(join(observe, 'journal')))
        .filter((name) => name.endsWith('.md'))
        .sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const text = await readFile(join(observe, 'journal', name), 'utf8');
      const parsed = parseJournal(text);
      events.push(...parsed.events);
      torn.push(...parsed.torn.map((item) => ({ ...item, file: name })));
    }
  }
  return {
    events,
    torn,
    brain: brains.length === 0 ? null : brains.join('\n'),
    brainCount: brains.length,
  };
}

export function brainDiff(left, right) {
  const leftLines = (left ?? '<missing BRAIN.md>').split('\n');
  const rightLines = (right ?? '<missing BRAIN.md>').split('\n');
  const lines = [];
  const width = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < width && lines.length < 40; index += 1) {
    const before = leftLines[index];
    const after = rightLines[index];
    if (before === after) continue;
    lines.push(`- ${before ?? ''}`);
    lines.push(`+ ${after ?? ''}`);
  }
  return lines.join('\n');
}

/** Idempotent clean replay: fold the parsed journal events through the real CLI. */
export async function replayBrain(events, project) {
  const home = await mkdtemp(join(tmpdir(), 'rizz-replay-'));
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(home, 'spool'), { recursive: true });
    const body = events.map((event) => JSON.stringify(event)).join('\n');
    await writeFile(join(home, 'spool', 'events.jsonl'), body.length === 0 ? '' : `${body}\n`);
    const folded = await runRizz(['fold'], { cwd: project, home });
    const observed = await readObserver(home);
    return {
      brain: observed.brain,
      code: folded.code,
      stderr: folded.stderr.slice(0, 400),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function freshDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}
