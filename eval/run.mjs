#!/usr/bin/env node
// rizz eval harness (brief §4.6, M5). Runs the coding-task suite against the loop and reports
// pass/score/tokens/cost. M0 ships the runner skeleton + schema so CI has a real, green eval
// step to build on; the loop-backed tasks land in M5.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(evalDir);
const tasksDir = join(evalDir, 'tasks');
const cliBin = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const installLocalScript = join(repoRoot, 'scripts', 'install-local.mjs');

/** Load every *.task.json under eval/tasks. */
function loadTasks() {
  return readdirSync(tasksDir)
    .filter((f) => f.endsWith('.task.json'))
    .map((f) => JSON.parse(readFileSync(join(tasksDir, f), 'utf8')));
}

const tasks = loadTasks();
console.log(`rizz eval — ${tasks.length} task(s) loaded`);

let passed = 0;
for (const task of tasks) {
  // M5: drive the loop here and score the result. For now we validate the task schema so the
  // suite is real and the harness is wired into CI.
  const valid = typeof task.id === 'string' && typeof task.prompt === 'string';
  if (valid) passed++;
  console.log(`  ${valid ? '✓' : '✗'} ${task.id ?? '(missing id)'}`);
}

console.log(`\n${passed}/${tasks.length} task(s) valid`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isolatedEnv(home) {
  // Avoid accidental live-provider/keychain use: the smoke must stay local, deterministic, and free.
  const env = {
    CI: '1',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    PATH: '',
  };

  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  return env;
}

function isolatedEnvWithGit(home) {
  return {
    ...isolatedEnv(home),
    PATH: process.env.PATH ?? '',
  };
}

function redactOutput(output, secret) {
  return output.split(secret).join('[redacted secret]');
}

function withTempHomeSync(run) {
  const home = mkdtempSync(join(tmpdir(), 'rizz-headless-smoke-'));
  try {
    return run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function withTempHomeAsync(run) {
  const home = mkdtempSync(join(tmpdir(), 'rizz-headless-smoke-'));
  try {
    return await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function withTempDirSync(prefix, run) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseJsonLines(stdout) {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  assert(lines.length > 0, 'expected at least one stdout line');
  return lines.map((line) => JSON.parse(line));
}

function runCliSync(args, input) {
  return withTempHomeSync((home) =>
    spawnSync(process.execPath, [cliBin, ...args], {
      cwd: repoRoot,
      input,
      encoding: 'utf8',
      env: isolatedEnv(home),
      timeout: 5_000,
    }),
  );
}

function runCliInCwdSync(cwd, args, input) {
  return withTempHomeSync((home) =>
    spawnSync(process.execPath, [cliBin, ...args], {
      cwd,
      input,
      encoding: 'utf8',
      env: isolatedEnv(home),
      timeout: 5_000,
    }),
  );
}

function runCliInCwdWithGitSync(cwd, args, input) {
  return withTempHomeSync((home) =>
    spawnSync(process.execPath, [cliBin, ...args], {
      cwd,
      input,
      encoding: 'utf8',
      env: isolatedEnvWithGit(home),
      timeout: 5_000,
    }),
  );
}

function gitInCwd(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert(result.status === 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

function setupSmokeEnv(home, secret) {
  return {
    ...isolatedEnv(home),
    ANTHROPIC_API_KEY: secret,
    OPENROUTER_API_KEY: secret,
  };
}

function runSetupCliSync(args, secret) {
  return withTempHomeSync((home) => {
    const result = spawnSync(process.execPath, [cliBin, 'setup', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: setupSmokeEnv(home, secret),
      timeout: 5_000,
    });
    return {
      result,
      rizzHomeExists: existsSync(join(home, '.rizz')),
    };
  });
}

function runInstallLocalSync(args) {
  return spawnSync(process.execPath, [installLocalScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function runInstalledShim(shimPath, args) {
  const nodeDir = dirname(process.execPath);
  return spawnSync(shimPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${nodeDir}:${process.env.PATH ?? ''}`,
    },
    timeout: 5_000,
  });
}

async function runRpcSmoke() {
  return withTempHomeAsync(
    (home) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cliBin, '--rpc'], {
          cwd: repoRoot,
          env: isolatedEnv(home),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const messages = [];
        let stdout = '';
        let stderr = '';
        let bufferedStdout = '';
        let turnSent = false;
        let stdinClosed = false;

        const closeStdin = () => {
          if (!stdinClosed) {
            stdinClosed = true;
            child.stdin.end();
          }
        };

        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('rizz --rpc smoke timed out'));
        }, 5_000);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          bufferedStdout += chunk;
          const lines = bufferedStdout.split('\n');
          bufferedStdout = lines.pop() ?? '';

          for (const line of lines) {
            if (line.trim() === '') continue;
            const message = JSON.parse(line);
            messages.push(message);

            if (!turnSent && message.id === 1 && message.result !== undefined) {
              turnSent = true;
              child.stdin.write(
                `${JSON.stringify({
                  id: 2,
                  method: 'turn',
                  params: { input: 'hello from rpc smoke' },
                })}\n`,
              );
            }

            if (message.id === 2 && message.result !== undefined) closeStdin();
          }
        });

        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });

        child.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        child.on('close', (code, signal) => {
          clearTimeout(timeout);
          try {
            assert(signal === null, `rizz --rpc exited by signal ${signal}`);
            assert(code === 0, `rizz --rpc exited ${code}: ${stderr}`);
            assert(bufferedStdout.trim() === '', 'rizz --rpc left a partial stdout JSON line');
            assert(
              messages.some((message) => message.id === 1),
              'missing session.start response',
            );
            assert(
              messages.some((message) => message.id === 2),
              'missing turn response',
            );
            assert(
              messages.some(
                (message) =>
                  message.method === 'event' &&
                  message.params !== undefined &&
                  message.params.type === 'assistant',
              ),
              'missing assistant event',
            );
            resolve({ stdout, stderr, messages });
          } catch (error) {
            reject(error);
          }
        });

        child.stdin.write(`${JSON.stringify({ id: 1, method: 'session.start' })}\n`);
      }),
  );
}

async function runHeadlessSmoke() {
  console.log('\nrizz CLI process smoke — headless/setup gates');
  let smokePassed = 0;
  const checks = [
    {
      name: 'rizz --json empty input exits 2 with BAD_REQUEST JSON',
      run() {
        const result = runCliSync(['--json'], '');
        assert(result.error === undefined, String(result.error));
        assert(result.status === 2, `expected exit 2, got ${result.status}`);
        assert(result.stderr === '', `expected empty stderr, got ${JSON.stringify(result.stderr)}`);
        const [message] = parseJsonLines(result.stdout);
        assert(message.ok === false, 'expected ok:false');
        assert(message.error?.code === 'BAD_REQUEST', 'expected BAD_REQUEST');
      },
    },
    {
      name: 'rizz --json emits one parseable stdout JSON result',
      run() {
        const result = runCliSync(['--json'], 'hello from json smoke\n');
        assert(result.error === undefined, String(result.error));
        assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
        const messages = parseJsonLines(result.stdout);
        assert(messages.length === 1, `expected one stdout line, got ${messages.length}`);
        const [message] = messages;
        assert(message.ok === true, 'expected ok:true');
        assert(typeof message.reply === 'string', 'expected string reply');
        assert(message.usage?.tokens > 0, 'expected positive token usage');
        assert(message.costUsd === 0, 'expected demo/subscription costUsd 0');
      },
    },
    {
      name: 'rizz --rpc handles session.start -> turn as line-delimited JSON',
      async run() {
        const { messages } = await runRpcSmoke();
        const start = messages.find((message) => message.id === 1);
        const turn = messages.find((message) => message.id === 2);
        assert(start?.result !== undefined, 'expected session.start result');
        assert(turn?.result?.reply !== undefined, 'expected turn reply');
        assert(turn.result.usage?.tokens > 0, 'expected turn usage');
      },
    },
    {
      name: 'rizz setup --dry-run exits 0 without leaking provider env or creating ~/.rizz',
      run() {
        const secret = 'sk-ant-eval-setup-smoke-secret';
        const { result, rizzHomeExists } = runSetupCliSync(['--dry-run'], secret);
        const combinedOutput = `${result.stdout}\n${result.stderr}`;

        assert(result.error === undefined, String(result.error));
        assert(
          result.status === 0,
          `expected exit 0, got ${result.status}: ${redactOutput(result.stderr, secret)}`,
        );
        assert(
          result.stderr === '',
          `expected empty stderr, got ${JSON.stringify(redactOutput(result.stderr, secret))}`,
        );
        assert(result.stdout.includes('dependency doctor'), 'expected dependency doctor output');
        assert(!combinedOutput.includes(secret), 'fake provider key was echoed');
        assert(!rizzHomeExists, 'dry-run created temp HOME/.rizz');
      },
    },
    {
      name: 'rizz setup unsupported secret-like arg exits 2 without echoing the secret',
      run() {
        const secret = 'sk-ant-eval-unsupported-setup-secret';
        const { result, rizzHomeExists } = runSetupCliSync(['--provider-key', secret], secret);
        const combinedOutput = `${result.stdout}\n${result.stderr}`;

        assert(result.error === undefined, String(result.error));
        assert(result.status === 2, `expected exit 2, got ${result.status}`);
        assert(
          result.stdout === '',
          `expected empty stdout, got ${JSON.stringify(redactOutput(result.stdout, secret))}`,
        );
        assert(result.stderr.includes('unsupported setup option'), 'expected setup usage error');
        assert(!combinedOutput.includes(secret), 'unsupported setup arg secret was echoed');
        assert(!rizzHomeExists, 'unsupported setup arg created temp HOME/.rizz');
      },
    },
    {
      name: 'rizz setup shows route picker without provider credentials or config writes',
      run() {
        const secret = 'sk-ant-eval-interactive-setup-secret';
        const { configExists, envUser, result } = withTempHomeSync((home) => {
          const env = setupSmokeEnv(home, secret);
          const child = spawnSync(process.execPath, [cliBin, 'setup'], {
            cwd: repoRoot,
            input: '',
            encoding: 'utf8',
            env,
            timeout: 5_000,
          });
          return {
            configExists: existsSync(join(home, '.rizz', 'config.json')),
            envUser: env.USER,
            result: child,
          };
        });
        const combinedOutput = `${result.stdout}\n${result.stderr}`;

        assert(result.error === undefined, String(result.error));
        assert(
          result.status === 0,
          `expected exit 0, got ${result.status}: ${redactOutput(result.stderr, secret)}`,
        );
        assert(result.stdout.includes('rizz setup'), 'expected setup output');
        assert(
          result.stdout.includes('Choose how rizz should talk to a model'),
          'expected setup route picker',
        );
        assert(
          result.stdout.includes('Skipped model connection.'),
          'expected setup to skip model route in isolated env',
        );
        assert(!result.stdout.includes('Name this launch?'), 'old launch-name prompt remained');
        assert(
          !result.stdout.includes("Hey. How're you doing?"),
          'non-interactive setup printed the first-run greeting',
        );
        assert(
          !result.stdout.includes('What should I call you?'),
          'non-interactive setup printed the nickname prompt',
        );
        if (envUser) {
          assert(!result.stdout.includes(envUser), 'non-interactive setup echoed the system user');
        }
        assert(!result.stdout.includes('[pi]'), 'old pi default remained');
        assert(!result.stdout.includes('local demo mode'), 'old local demo copy remained');
        assert(!result.stdout.includes('Demo / Harness'), 'old demo harness copy remained');
        assert(!combinedOutput.includes(secret), 'fake provider key was echoed');
        assert(!configExists, 'interactive setup wrote temp HOME/.rizz/config.json');
      },
    },
    {
      name: 'rizz brain writes local project brain without provider credentials',
      run() {
        withTempDirSync('rizz-brain-smoke-', (dir) => {
          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ name: 'brain-smoke', scripts: { test: 'vitest run' } }),
          );
          writeFileSync(join(dir, 'index.ts'), 'export const ok = true;\n');

          const result = runCliInCwdSync(dir, ['brain'], '');
          assert(result.error === undefined, String(result.error));
          assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
          assert(result.stdout.includes('rizz understood 2 file(s)'), 'expected brain summary');
          assert(existsSync(join(dir, '.rizz', 'brain', 'latest.json')), 'missing latest.json');
          assert(existsSync(join(dir, '.rizz', 'brain', 'graph.json')), 'missing graph.json');
          assert(
            existsSync(join(dir, '.rizz', 'brain', 'entities', 'files.json')),
            'missing files entity store',
          );
          const reportPath = join(dir, '.rizz', 'reports', 'index.html');
          assert(existsSync(reportPath), 'missing HTML report');
          const report = readFileSync(reportPath, 'utf8');
          assert(report.includes('Mission Control ·'), 'missing Mission Control title');
          assert(report.includes('local project intelligence'), 'missing portal positioning');
          assert(report.includes('<h2>Start Here</h2>'), 'missing Start Here section');
          assert(report.includes('<h2>Risk Areas</h2>'), 'missing risk section');
          assert(report.includes('<h2>Unknowns</h2>'), 'missing unknowns section');
          assert(report.includes('<h2>Evidence</h2>'), 'missing evidence section');
          assert(
            report.includes('placeholder="Search components, files, risks, commands, evidence..."'),
            'missing global portal search',
          );
          assert(report.includes('href="#evidence-file-package-json"'), 'missing evidence link');
          assert(report.includes('id="evidence-file-package-json"'), 'missing evidence anchor');
          assert(!report.includes('<script src='), 'portal references external script');
          assert(
            !report.includes('<link rel="stylesheet"'),
            'portal references external stylesheet',
          );
          assert(!report.includes('fetch('), 'portal uses fetch');
          assert(!report.includes('http://'), 'portal references http URL');
          assert(!report.includes('https://'), 'portal references https URL');
        });
      },
    },
    {
      name: 'rizz review writes brain-backed review artifacts for current git diff',
      run() {
        withTempDirSync('rizz-review-smoke-', (dir) => {
          gitInCwd(dir, ['init', '-b', 'develop']);
          gitInCwd(dir, ['config', 'user.email', 'rizz@example.com']);
          gitInCwd(dir, ['config', 'user.name', 'rizz eval']);
          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ name: 'review-smoke', scripts: { test: 'vitest run' } }),
          );
          mkdirSync(join(dir, 'src'), { recursive: true });
          writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = true;\n');
          const brain = runCliInCwdSync(dir, ['brain'], '');
          assert(brain.status === 0, `expected brain exit 0, got ${brain.status}: ${brain.stderr}`);
          gitInCwd(dir, ['add', '.']);
          gitInCwd(dir, ['commit', '-m', 'initial']);
          writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = false;\n');

          const result = runCliInCwdWithGitSync(dir, ['review', '--json'], '');
          assert(result.error === undefined, String(result.error));
          assert(
            result.status === 0,
            `expected review exit 0, got ${result.status}: ${result.stderr}`,
          );
          assert(!result.stdout.includes('sk-or-v1-'), 'review output leaked secret-like text');
          const review = JSON.parse(result.stdout);
          assert(
            review.changed_files.includes('src/index.ts'),
            'review missed changed source file',
          );
          assert(review.findings.length > 0, 'review produced no findings');
          assert(
            review.required_tests.some((command) => command.includes('vitest')),
            'review missed test command',
          );
          assert(
            existsSync(join(dir, '.rizz', 'brain', 'entities', 'reviews.json')),
            'missing reviews entity store',
          );
          assert(existsSync(join(dir, '.rizz', 'reports', 'review.html')), 'missing review report');
        });
      },
    },
    {
      name: 'rizz explain explains a component from the local project brain',
      run() {
        withTempDirSync('rizz-explain-smoke-', (dir) => {
          mkdirSync(join(dir, 'packages', 'brain', 'src'), { recursive: true });
          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ name: 'explain-smoke', scripts: { test: 'vitest run' } }),
          );
          writeFileSync(
            join(dir, 'packages', 'brain', 'package.json'),
            JSON.stringify({
              name: '@smoke/brain',
              scripts: { test: 'vitest run packages/brain' },
              dependencies: { zod: '^3.0.0' },
            }),
          );
          writeFileSync(
            join(dir, 'packages', 'brain', 'src', 'index.ts'),
            'export const ok = 1;\n',
          );
          writeFileSync(
            join(dir, 'packages', 'brain', 'src', 'index.test.ts'),
            'import { it } from "vitest"; it("works", () => {});\n',
          );

          const brain = runCliInCwdSync(dir, ['brain'], '');
          assert(brain.status === 0, `expected brain exit 0, got ${brain.status}: ${brain.stderr}`);

          const result = runCliInCwdSync(dir, ['explain', 'packages/brain', '--json'], '');
          assert(
            result.status === 0,
            `expected explain exit 0, got ${result.status}: ${result.stderr}`,
          );
          assert(!result.stdout.includes('sk-or-v1-'), 'explain output leaked secret-like text');
          const explanation = JSON.parse(result.stdout);
          assert(
            explanation.resolved_entity_id === 'component:packages--brain',
            'explain resolved the wrong entity',
          );
          assert(explanation.entity_type === 'component', 'explain returned the wrong entity type');
          assert(
            explanation.dependencies.includes('zod'),
            'explain missed component dependency evidence',
          );
          assert(
            explanation.read_first.includes('packages/brain/src/index.ts'),
            'explain missed read-first file',
          );
          assert(
            existsSync(join(dir, '.rizz', 'reports', 'explain.html')),
            'missing explain report',
          );

          const missingTarget = runCliInCwdSync(dir, ['explain', '--json'], '');
          assert(missingTarget.status === 2, 'expected missing explain target to exit 2');
          assert(missingTarget.stderr === '', 'expected JSON explain error to keep stderr empty');
          const missingTargetError = JSON.parse(missingTarget.stdout);
          assert(
            missingTargetError.error.code === 'EXPLAIN_TARGET_REQUIRED',
            'missing target JSON error code mismatch',
          );

          const ambiguous = runCliInCwdSync(dir, ['explain', 'index', '--json'], '');
          assert(ambiguous.status === 1, 'expected ambiguous explain target to exit 1');
          assert(ambiguous.stderr === '', 'expected ambiguous JSON explain error stderr empty');
          const ambiguousError = JSON.parse(ambiguous.stdout);
          assert(
            ambiguousError.error.code === 'EXPLAIN_TARGET_AMBIGUOUS',
            'ambiguous target JSON error code mismatch',
          );
        });
      },
    },
  ];

  for (const check of checks) {
    try {
      await check.run();
      smokePassed += 1;
      console.log(`  ✓ ${check.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ ${check.name}`);
      console.log(`    ${message}`);
    }
  }

  console.log(`\n${smokePassed}/${checks.length} CLI process smoke check(s) passed`);
  return smokePassed === checks.length;
}

function runInstallShimSmoke() {
  console.log('\nrizz install-local smoke - shim safety gates');
  let smokePassed = 0;
  const checks = [
    {
      name: 'install-local writes a regular executable shim and forwards args',
      run() {
        withTempDirSync('rizz-install-smoke-', (dir) => {
          const binDir = join(dir, 'bin');
          const result = runInstallLocalSync(['--dir', binDir]);
          if (process.platform === 'win32') {
            assert(result.status === 1, `expected Windows exit 1, got ${result.status}`);
            assert(
              result.stderr.includes('pnpm build && pnpm -C packages/cli link --global'),
              'expected Windows pnpm link guidance',
            );
            return;
          }

          assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
          const shimPath = join(binDir, 'rizz');
          const shimStat = lstatSync(shimPath);
          assert(shimStat.isFile(), 'expected shim to be a regular file');
          assert(!shimStat.isSymbolicLink(), 'expected shim not to be a symlink');
          assert((shimStat.mode & 0o111) !== 0, 'expected executable bit on shim');

          const version = runInstalledShim(shimPath, ['--version']);
          assert(
            version.status === 0,
            `expected installed shim --version exit 0, got ${version.status}: ${version.stderr}`,
          );
          assert(version.stdout.trim() === '0.1.0', 'expected shim to forward --version 0.1.0');
        });
      },
    },
    {
      name: 'install-local replaces a symlink without touching its target',
      run() {
        if (process.platform === 'win32') return;
        withTempDirSync('rizz-install-symlink-smoke-', (dir) => {
          const binDir = join(dir, 'bin');
          mkdirSync(binDir, { recursive: true });
          const targetPath = join(dir, 'symlink-target');
          const shimPath = join(binDir, 'rizz');
          writeFileSync(targetPath, 'target sentinel');
          symlinkSync(targetPath, shimPath);

          const result = runInstallLocalSync(['--dir', binDir]);
          assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
          assert(readFileSync(targetPath, 'utf8') === 'target sentinel', 'symlink target changed');
          const shimStat = lstatSync(shimPath);
          assert(shimStat.isFile(), 'expected replacement shim to be a regular file');
          assert(!shimStat.isSymbolicLink(), 'expected replacement shim not to be a symlink');
        });
      },
    },
    {
      name: 'install-local replaces a dangling symlink without creating its target',
      run() {
        if (process.platform === 'win32') return;
        withTempDirSync('rizz-install-dangling-symlink-smoke-', (dir) => {
          const binDir = join(dir, 'bin');
          mkdirSync(binDir, { recursive: true });
          const targetPath = join(dir, 'missing-target');
          const shimPath = join(binDir, 'rizz');
          symlinkSync(targetPath, shimPath);

          const result = runInstallLocalSync(['--dir', binDir]);
          assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
          assert(!existsSync(targetPath), 'dangling symlink target was created');
          const shimStat = lstatSync(shimPath);
          assert(shimStat.isFile(), 'expected replacement shim to be a regular file');
          assert(!shimStat.isSymbolicLink(), 'expected replacement shim not to be a symlink');
        });
      },
    },
    {
      name: 'install-local refuses to replace an existing rizz directory',
      run() {
        if (process.platform === 'win32') return;
        withTempDirSync('rizz-install-directory-smoke-', (dir) => {
          const binDir = join(dir, 'bin');
          const shimPath = join(binDir, 'rizz');
          mkdirSync(shimPath, { recursive: true });

          const result = runInstallLocalSync(['--dir', binDir]);
          assert(result.status === 1, `expected exit 1, got ${result.status}`);
          assert(result.stderr.includes('is a directory'), 'expected directory collision message');
          assert(
            lstatSync(shimPath).isDirectory(),
            'directory collision did not remain a directory',
          );
        });
      },
    },
    {
      name: 'install-local rejects missing --dir value and unknown flags',
      run() {
        const missingDir = runInstallLocalSync(['--dir']);
        assert(missingDir.status === 2, `expected exit 2, got ${missingDir.status}`);
        assert(missingDir.stderr.includes('--dir needs a path'), 'expected missing --dir message');

        const unknown = runInstallLocalSync(['--unknown']);
        assert(unknown.status === 2, `expected exit 2, got ${unknown.status}`);
        assert(unknown.stderr.includes('unknown option'), 'expected unknown flag message');
      },
    },
  ];

  for (const check of checks) {
    try {
      check.run();
      smokePassed += 1;
      console.log(`  ✓ ${check.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ ${check.name}`);
      console.log(`    ${message}`);
    }
  }

  console.log(`\n${smokePassed}/${checks.length} install-local smoke check(s) passed`);
  return smokePassed === checks.length;
}

const smokeOk = await runHeadlessSmoke();
const installSmokeOk = runInstallShimSmoke();
process.exit(passed === tasks.length && smokeOk && installSmokeOk ? 0 : 1);
