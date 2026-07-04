#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const cliBin = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const defaultWorkspace = join(repoRoot, '.rizz', 'uat', 'large-repos');
const defaultReportPath = join(defaultWorkspace, 'large-repo-uat-report.json');
const defaultTimeoutMs = 180_000;
const defaultMaxFiles = 5_000;
const outputLimit = 512 * 1024;

const defaultMatrix = [
  {
    id: 'github-docs',
    url: 'https://github.com/github/docs.git',
    ref: 'main',
    note: 'content-heavy docs repository with package manifests, workflows, and tests',
  },
  {
    id: 'next-js',
    url: 'https://github.com/vercel/next.js.git',
    ref: 'canary',
    note: 'large framework monorepo with many packages, manifests, config files, and tests',
  },
];

function usage() {
  return `Usage: pnpm uat:large-repos [options]

Options:
  --repo <id=path-or-url>   Run a local repo path or Git URL instead of the default matrix.
  --only <ids>             Comma-separated default matrix ids to run.
  --workspace <path>       Clone/cache repos under this directory.
  --report <path>          Write JSON report to this path.
  --timeout-ms <ms>        Per-repo brain timeout. Default: ${defaultTimeoutMs}.
  --max-files <count>      RIZZ_BRAIN_MAX_FILES for each repo. Default: ${defaultMaxFiles}.
  --preserve-rizz          Keep existing .rizz artifacts instead of starting each repo fresh.
  --help                   Show this help.
`;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    workspace: defaultWorkspace,
    reportPath: defaultReportPath,
    timeoutMs: defaultTimeoutMs,
    maxFiles: defaultMaxFiles,
    repos: [],
    only: undefined,
    freshRizz: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--repo') {
      const spec = argv[index + 1];
      if (spec === undefined) throw new Error('--repo needs id=path-or-url');
      index += 1;
      const equalsIndex = spec.indexOf('=');
      if (equalsIndex <= 0) throw new Error('--repo needs id=path-or-url');
      const id = spec.slice(0, equalsIndex);
      const source = spec.slice(equalsIndex + 1);
      options.repos.push(repoFromSpec(id, source));
      continue;
    }
    if (arg === '--only') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--only needs a comma-separated id list');
      index += 1;
      options.only = new Set(
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      );
      continue;
    }
    if (arg === '--workspace') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--workspace needs a path');
      index += 1;
      options.workspace = resolve(value);
      if (options.reportPath === defaultReportPath) {
        options.reportPath = join(options.workspace, 'large-repo-uat-report.json');
      }
      continue;
    }
    if (arg === '--report') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--report needs a path');
      index += 1;
      options.reportPath = resolve(value);
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--timeout-ms needs a value');
      index += 1;
      options.timeoutMs = parsePositiveInteger(value, '--timeout-ms');
      continue;
    }
    if (arg === '--max-files') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--max-files needs a value');
      index += 1;
      options.maxFiles = parsePositiveInteger(value, '--max-files');
      continue;
    }
    if (arg === '--preserve-rizz') {
      options.freshRizz = false;
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }

  const matrix = options.repos.length > 0 ? options.repos : defaultMatrix.map(repoFromMatrix);
  const selected =
    options.only === undefined ? matrix : matrix.filter((repo) => options.only?.has(repo.id));
  if (selected.length === 0) throw new Error('no repositories selected');
  return { ...options, repos: selected };
}

function repoFromSpec(id, source) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`invalid repo id ${id}`);
  if (/^(https?:\/\/|git@)/.test(source))
    return { id, url: source, ref: undefined, note: 'custom url' };
  return {
    id,
    path: isAbsolute(source) ? source : resolve(process.cwd(), source),
    note: 'custom local path',
  };
}

function repoFromMatrix(repo) {
  return { ...repo };
}

function appendLimited(current, chunk) {
  const next = `${current}${chunk}`;
  if (next.length <= outputLimit) return next;
  return next.slice(next.length - outputLimit);
}

function tail(text, limit = 4_000) {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}

function runProcess(command, args, options) {
  return new Promise((resolveProcess) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5_000).unref();
    }, options.timeoutMs);

    child.stdout.on('data', (data) => {
      const text = String(data);
      stdout = appendLimited(stdout, text);
      if (options.relay) process.stdout.write(prefixLines(options.prefix, text));
    });
    child.stderr.on('data', (data) => {
      const text = String(data);
      stderr = appendLimited(stderr, text);
      if (options.relay) process.stderr.write(prefixLines(options.prefix, text));
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveProcess({
        status: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: appendLimited(stderr, String(error)),
      });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveProcess({
        status,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
  });
}

function prefixLines(prefix, text) {
  return text
    .split(/(\r?\n)/)
    .map((part) => {
      if (part === '\n' || part === '\r\n' || part === '') return part;
      return `[${prefix}] ${part}`;
    })
    .join('');
}

async function ensureRepo(repo, workspace, timeoutMs) {
  if (repo.path !== undefined) return { repoDir: repo.path, source: repo.path, cloned: false };
  const repoDir = join(workspace, 'repos', repo.id);
  if (existsSync(repoDir)) return { repoDir, source: repo.url, cloned: false };

  mkdirSync(dirname(repoDir), { recursive: true });
  const args = ['clone', '--depth', '1'];
  if (repo.ref !== undefined) args.push('--branch', repo.ref);
  args.push(repo.url, repoDir);
  process.stderr.write(`[uat] ${repo.id}: cloning ${repo.url}\n`);
  const result = await runProcess('git', args, {
    cwd: workspace,
    timeoutMs,
    env: process.env,
    prefix: `${repo.id}:clone`,
    relay: true,
  });
  if (result.status !== 0 || result.timedOut) {
    throw new Error(
      `${repo.id} clone failed${result.timedOut ? ' after timeout' : ''}: ${tail(result.stderr)}`,
    );
  }
  return { repoDir, source: repo.url, cloned: true };
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseCliSummary(stdout) {
  const summary = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(components|flows|commands|tests|changed|stale):\s+(\d+)\s*$/);
    if (match !== null) summary[match[1]] = Number(match[2]);
    const scanned = line.match(/^rizz understood\s+(\d+)\s+file\(s\)$/);
    if (scanned !== null) summary.scannedFiles = Number(scanned[1]);
  }
  return summary;
}

async function runRepo(repo, options) {
  const prepared = await ensureRepo(repo, options.workspace, options.timeoutMs);
  if (options.freshRizz) {
    rmSync(join(prepared.repoDir, '.rizz'), { recursive: true, force: true });
  }
  process.stderr.write(
    `[uat] ${repo.id}: brain scan cap=${options.maxFiles}, timeout=${options.timeoutMs}ms\n`,
  );
  const result = await runProcess(process.execPath, [cliBin, 'brain'], {
    cwd: prepared.repoDir,
    timeoutMs: options.timeoutMs,
    env: {
      ...process.env,
      RIZZ_BRAIN_MAX_FILES: String(options.maxFiles),
    },
    prefix: repo.id,
    relay: true,
  });
  const latest = readJsonIfExists(join(prepared.repoDir, '.rizz', 'brain', 'latest.json'));
  const toolInventory = readJsonIfExists(
    join(prepared.repoDir, '.rizz', 'research', 'tool_inventory.json'),
  );
  const securityScan = readJsonIfExists(
    join(prepared.repoDir, '.rizz', 'research', 'security_scan.json'),
  );
  const summary = parseCliSummary(result.stdout);
  return {
    id: repo.id,
    note: repo.note,
    source: prepared.source,
    path: prepared.repoDir,
    cloned: prepared.cloned,
    status: result.status,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
    max_files: options.maxFiles,
    scanned_files: summary.scannedFiles ?? latest?.scanned_files ?? null,
    components: summary.components ?? null,
    flows: summary.flows ?? null,
    commands: summary.commands ?? null,
    tests: summary.tests ?? null,
    changed: summary.changed ?? null,
    stale: summary.stale ?? null,
    package_scripts: toolInventory?.package_script_count ?? null,
    tool_surfaces: toolInventory?.surface_count ?? null,
    security_findings: securityScan?.finding_count ?? null,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
  };
}

async function main() {
  if (!existsSync(cliBin)) {
    throw new Error(`missing built CLI at ${cliBin}; run pnpm build first`);
  }
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.workspace, { recursive: true });
  mkdirSync(dirname(options.reportPath), { recursive: true });
  const startedAt = Date.now();
  const repos = [];
  for (const repo of options.repos) {
    repos.push(await runRepo(repo, options));
  }
  const report = {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    deterministic: true,
    provider_calls_required: false,
    network_required_for_default_clone: true,
    timeout_ms: options.timeoutMs,
    max_files: options.maxFiles,
    fresh_rizz: options.freshRizz,
    traversal_priority: ['manifests', 'config', 'tests', 'source', 'content-heavy trees'],
    repos,
  };
  writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`[uat] wrote ${options.reportPath}\n`);
  if (repos.some((repo) => repo.status !== 0 || repo.timed_out)) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`uat-large-repos: ${message}\n`);
  process.exitCode = 1;
});
