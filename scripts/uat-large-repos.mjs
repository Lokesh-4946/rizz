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

function parseProgressEvents(stderr) {
  const events = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(
      /\[rizz brain\]\s+([a-z]+)(?:\/([a-z0-9-]+))?:\s+(.+?)(?:\s+\((\d+)ms\))?\s*$/,
    );
    if (match === null) continue;
    events.push({
      phase: match[1],
      ...(match[2] !== undefined ? { detail: match[2] } : {}),
      message: match[3],
      ...(match[4] !== undefined ? { elapsed_ms: Number(match[4]) } : {}),
    });
  }
  return events;
}

function summarizeProgress(events) {
  const phaseDurations = {};
  const detailDurations = {};
  const timedSteps = [];
  let previousElapsed = 0;
  let totalReportedMs = 0;
  for (const event of events) {
    if (typeof event.elapsed_ms !== 'number') continue;
    const delta = Math.max(0, event.elapsed_ms - previousElapsed);
    previousElapsed = event.elapsed_ms;
    totalReportedMs = event.elapsed_ms;
    phaseDurations[event.phase] = (phaseDurations[event.phase] ?? 0) + delta;
    const detailKey = `${event.phase}/${event.detail ?? 'summary'}`;
    detailDurations[detailKey] = (detailDurations[detailKey] ?? 0) + delta;
    timedSteps.push({
      phase: event.phase,
      detail: event.detail ?? 'summary',
      message: event.message,
      duration_ms: delta,
      elapsed_ms: event.elapsed_ms,
    });
  }
  return {
    total_reported_ms: totalReportedMs,
    phase_durations_ms: phaseDurations,
    detail_durations_ms: detailDurations,
    slowest_steps: timedSteps
      .sort((left, right) => right.duration_ms - left.duration_ms)
      .slice(0, 6),
  };
}

function extractCapabilityScorecard(repoDir) {
  const score = readJsonIfExists(join(repoDir, '.rizz', 'research', 'understanding_score.json'));
  const scorecard = score?.capability_scorecard;
  if (scorecard === undefined || scorecard === null || typeof scorecard !== 'object') {
    return undefined;
  }
  const capabilities = Array.isArray(scorecard.capabilities) ? scorecard.capabilities : [];
  return {
    target_score: numberOrNull(scorecard.target_score),
    average_score: numberOrNull(scorecard.average_score),
    average_remaining_to_100: numberOrNull(scorecard.average_remaining_to_100),
    foundation_average_score: numberOrNull(scorecard.foundation_average_score),
    capability_count: numberOrNull(scorecard.capability_count),
    capabilities: capabilities
      .filter((capability) => capability !== null && typeof capability === 'object')
      .map((capability) => ({
        key: stringOrNull(capability.key),
        label: stringOrNull(capability.label),
        score: numberOrNull(capability.score),
        remaining_to_100: numberOrNull(capability.remaining_to_100),
        status: stringOrNull(capability.status),
        is_blocked: capability.is_blocked === true,
        next_required_improvements: Array.isArray(capability.next_required_improvements)
          ? capability.next_required_improvements
              .filter((item) => typeof item === 'string')
              .slice(0, 5)
          : [],
      })),
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

function weakestCapability(scorecard) {
  if (scorecard === undefined) return undefined;
  return scorecard.capabilities
    .filter((capability) => capability.score !== null)
    .sort((left, right) => left.score - right.score)[0];
}

function printRunUpdate(repo) {
  const scorecard = repo.capability_scorecard;
  const weakest = weakestCapability(scorecard);
  const score =
    scorecard?.average_score === null || scorecard?.average_score === undefined
      ? 'unknown'
      : `${scorecard.average_score}/100`;
  const remaining =
    scorecard?.average_remaining_to_100 === null ||
    scorecard?.average_remaining_to_100 === undefined
      ? 'unknown'
      : `${scorecard.average_remaining_to_100}`;
  const weakestText =
    weakest === undefined
      ? 'weakest unknown'
      : `weakest ${weakest.label ?? weakest.key}: ${weakest.score}/100`;
  process.stderr.write(
    `[uat] ${repo.id}: score ${score}, remaining ${remaining}, ${weakestText}\n`,
  );
  if (repo.progress_summary.slowest_steps.length > 0) {
    const slowest = repo.progress_summary.slowest_steps[0];
    process.stderr.write(
      `[uat] ${repo.id}: slowest step ${slowest.phase}/${slowest.detail} ${slowest.duration_ms}ms\n`,
    );
  }
}

function plannedScorecard() {
  return [
    plannedItem(
      'flow_understanding',
      'Flow Understanding',
      86,
      'Deepen route, service, and journey reconstruction.',
    ),
    plannedItem(
      'architecture_reasoning',
      'Architecture Reasoning',
      87,
      'Calibrate confidence and what-breaks claims.',
    ),
    plannedItem(
      'evidence_quality_scoring',
      'Evidence Quality scoring',
      88,
      'Make weak, stale, and low-confidence evidence easier to inspect.',
    ),
    plannedItem(
      'mission_control_ux',
      'Mission Control UX',
      88,
      'Expose score, queue, and drilldown movement in the portal.',
    ),
    plannedItem(
      'pi_bench_seed_dataset_task_format',
      'PI-Bench seed/task format',
      86,
      'Broaden deterministic task coverage and UAT fixtures.',
    ),
    plannedItem(
      'incremental_understanding_metrics',
      'Incremental Understanding metrics',
      88,
      'Improve repeated-scan reuse and stale-surface explanations.',
    ),
    plannedItem(
      'review_intelligence_true_blast_radius',
      'Review Intelligence with true blast radius',
      88,
      'Tie changed files to user-visible failures with stronger causality.',
    ),
    plannedItem('rizz_ask', 'rizz ask', 0, 'Remain gated until foundations are stronger.'),
  ];
}

function plannedItem(key, label, score, next) {
  return {
    key,
    label,
    score,
    target_score: 100,
    remaining_to_100: 100 - score,
    next_required_improvement: next,
  };
}

function summarizeMatrixScorecard(repos) {
  const capabilityRows = [];
  for (const repo of repos) {
    const capabilities = repo.capability_scorecard?.capabilities ?? [];
    for (const capability of capabilities) {
      if (capability.key === null || capability.score === null) continue;
      capabilityRows.push({
        repo: repo.id,
        key: capability.key,
        label: capability.label,
        score: capability.score,
        remaining_to_100: capability.remaining_to_100,
        status: capability.status,
        is_blocked: capability.is_blocked,
      });
    }
  }
  const byCapability = {};
  for (const row of capabilityRows) {
    const current = byCapability[row.key] ?? {
      key: row.key,
      label: row.label,
      repos: 0,
      average_score: 0,
      average_remaining_to_100: 0,
      blocked_repos: 0,
    };
    current.repos += 1;
    current.average_score += row.score;
    current.average_remaining_to_100 += row.remaining_to_100 ?? 0;
    if (row.is_blocked) current.blocked_repos += 1;
    byCapability[row.key] = current;
  }
  const capabilities = Object.values(byCapability)
    .map((capability) => ({
      ...capability,
      average_score: Math.round(capability.average_score / capability.repos),
      average_remaining_to_100: Math.round(capability.average_remaining_to_100 / capability.repos),
    }))
    .sort((left, right) => left.average_score - right.average_score);
  return {
    repos_scored: repos.filter((repo) => repo.capability_scorecard !== null).length,
    capabilities,
    weakest_capability: capabilities[0] ?? null,
  };
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
  const progressEvents = parseProgressEvents(result.stderr);
  const progressSummary = summarizeProgress(progressEvents);
  const capabilityScorecard = extractCapabilityScorecard(prepared.repoDir);
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
    capability_scorecard: capabilityScorecard ?? null,
    progress_summary: progressSummary,
    progress_events: progressEvents,
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
    const result = await runRepo(repo, options);
    repos.push(result);
    printRunUpdate(result);
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
    planned_scorecard: plannedScorecard(),
    matrix_scorecard: summarizeMatrixScorecard(repos),
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
