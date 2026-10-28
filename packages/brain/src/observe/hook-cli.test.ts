import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BRAIN_LINE_CAP } from './brain-index.js';
import { runObserveCli } from './cli.js';
import { eventsIn } from './journal.js';

const roots: string[] = [];

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '../../../cli/dist/index.js');

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly home: string;
    readonly hookHome: string;
    readonly stdin?: string;
  },
): Promise<CliResult> {
  if (!existsSync(cliPath)) {
    throw new Error('rizz CLI is not built. Run pnpm typecheck before this test.');
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        RIZZ_HOME: options.home,
        RIZZ_HOOK_HOME: options.hookHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.stdin ?? '');
  });
}

async function serveCli(options: {
  readonly cwd: string;
  readonly home: string;
  readonly hookHome: string;
}): Promise<{ readonly url: string; close(): Promise<void> }> {
  if (!existsSync(cliPath)) {
    throw new Error('rizz CLI is not built. Run pnpm typecheck before this test.');
  }
  const child: ChildProcess = spawn(process.execPath, [cliPath, 'serve', '--no-open'], {
    cwd: options.cwd,
    env: {
      ...process.env,
      RIZZ_HOME: options.home,
      RIZZ_HOOK_HOME: options.hookHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`serve did not print a url\n${stdout}\n${stderr}`));
    }, 8000);
    child.stdout?.on('data', () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/);
      if (match?.[0] !== undefined) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once('close', () => {
      clearTimeout(timer);
      reject(new Error(`serve exited early\n${stdout}\n${stderr}`));
    });
  });
  return {
    url,
    async close() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    },
  };
}

async function observeDir(home: string): Promise<string> {
  const projects = join(home, 'projects');
  const ids = await readdir(projects);
  for (const id of ids) {
    const dir = join(projects, id, 'observe');
    try {
      await readFile(join(dir, 'BRAIN.md'));
      return dir;
    } catch {
      // Another project id may exist; keep looking.
    }
  }
  throw new Error(`no brain under ${projects}`);
}

describe('installed CLI hook sessions', () => {
  it('records a Cursor session into the brain, ledger, handoff, and local page', async () => {
    const home = await tempDir('rizz-cli-home-');
    const hookHome = await tempDir('rizz-cli-hooks-');
    const project = await tempDir('rizz-cli-project-');
    const opts = { cwd: project, home, hookHome };
    const init = await runCli(['init', '--host', 'cursor', '--no-serve', '--no-open'], opts);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('rizz brain ready');
    const hooks = JSON.parse(await readFile(join(hookHome, '.cursor', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { command: string }[]>;
    };
    const invocation = realpathSync(cliPath);
    expect(hooks.hooks.sessionStart?.[0]?.command).toContain(invocation);
    expect(hooks.hooks.sessionStart?.[0]?.command).toContain('hook cursor sessionStart');
    expect(hooks.hooks.sessionStart?.[0]?.command?.startsWith('rizz ')).toBe(false);
    expect(hooks.hooks.preCompact?.[0]?.command).toContain('hook cursor preCompact');
    expect(hooks.hooks.stop?.[0]?.command).toContain('hook cursor stop');

    const common = { conversation_id: 'conv-1', workspace_roots: [project] };
    const start = await runCli(['hook', 'cursor', 'sessionStart'], {
      ...opts,
      stdin: JSON.stringify({ ...common, session_id: 'conv-1', hook_event_name: 'sessionStart' }),
    });
    expect(start.code).toBe(0);
    expect(start.stdout).toContain('additional_context');

    await runCli(['hook', 'cursor', 'beforeSubmitPrompt'], {
      ...opts,
      stdin: JSON.stringify({
        ...common,
        generation_id: 'gen-1',
        hook_event_name: 'beforeSubmitPrompt',
        prompt:
          'Add a health route.\nOwner decision: Should health require auth?\nAgent plan: run npm test and rewrite the router.',
      }),
    });
    await runCli(['hook', 'cursor', 'postToolUse'], {
      ...opts,
      stdin: JSON.stringify({
        ...common,
        generation_id: 'tool-1',
        tool_use_id: 'tool-1',
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'npm test' },
      }),
    });
    await runCli(['hook', 'cursor', 'afterFileEdit'], {
      ...opts,
      stdin: JSON.stringify({
        ...common,
        generation_id: 'edit-1',
        hook_event_name: 'afterFileEdit',
        file_path: 'src/health.ts',
      }),
    });
    await runCli(['hook', 'cursor', 'preCompact'], {
      ...opts,
      stdin: JSON.stringify({
        ...common,
        generation_id: 'compact-1',
        hook_event_name: 'preCompact',
        context_tokens: 1800,
      }),
    });
    await runCli(['hook', 'cursor', 'stop'], {
      ...opts,
      stdin: JSON.stringify({
        ...common,
        generation_id: 'stop-1',
        hook_event_name: 'stop',
        status: 'completed',
        summary: 'Added the route and ran npm test.',
      }),
    });
    await runCli(['hook', 'cursor', 'beforeSubmitPrompt'], {
      ...opts,
      stdin: JSON.stringify({
        ...common,
        generation_id: 'gen-1',
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'Add a health route.\nOwner decision: Should health require auth?',
      }),
    });

    const folded = await runCli(['fold'], opts);
    expect(folded.code).toBe(0);
    expect(folded.stdout).toContain('event(s)');
    const observe = await observeDir(home);
    const month = new Date().toISOString().slice(0, 7);
    const journalPath = join(observe, 'journal', `${month}.md`);
    const journalBefore = await readFile(journalPath, 'utf8');
    const journalEvents = eventsIn(journalBefore);
    expect(journalEvents.filter((item) => item.id.includes('gen-1'))).toHaveLength(1);
    expect(journalBefore).toContain('%%rizz:event%%');
    const foldedAgain = await runCli(['fold'], opts);
    expect(foldedAgain.stdout).toContain('folded 0 event(s)');
    expect(await readFile(journalPath, 'utf8')).toBe(journalBefore);

    const brain = await readFile(join(observe, 'BRAIN.md'), 'utf8');
    expect(brain.split('\n').length).toBeLessThanOrEqual(BRAIN_LINE_CAP);
    expect(brain).toContain('cursor-conv-1');
    expect(brain).toContain('Should health require auth?');
    expect(brain).not.toContain('%%rizz:event%%');

    const handoffName = (await readdir(join(observe, 'handoffs')))[0];
    expect(handoffName).toBeDefined();
    const handoff = await readFile(join(observe, 'handoffs', handoffName ?? ''), 'utf8');
    expect(handoff).toContain('src/health.ts');
    expect(handoff).toContain('Should health require auth?');

    const ledgerRows = (await readFile(join(observe, 'ledger', 'tokens.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { input: number; output: number; context: number; reported: boolean },
      );
    expect(ledgerRows.some((row) => row.context === 1800 && row.reported === false)).toBe(true);
    expect(ledgerRows.every((row) => row.input === 0 && row.output === 0)).toBe(true);

    const summary = await runCli(['summary'], opts);
    expect(summary.stdout).toContain('Should health require auth?');
    expect(summary.stdout).not.toContain('npm test');
    expect(summary.stdout).not.toContain('Added the route');
    const tokens = await runCli(['tokens'], opts);
    expect(tokens.stdout).toContain('context: 1800');
    expect(tokens.stdout).toContain('unreported runs:');

    const server = await serveCli(opts);
    const pageUrl = new URL(server.url);
    try {
      expect(Number(pageUrl.port)).toBeGreaterThan(0);
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Rizz brain');
      expect(html).toContain('Should health require auth?');
      const token = pageUrl.searchParams.get('token');
      const api = await fetch(`http://127.0.0.1:${pageUrl.port}/api/brain?token=${token}`);
      const body = (await api.json()) as { markdown: string };
      expect(body.markdown).toContain('Should health require auth?');
      const queried = await fetch(
        `http://127.0.0.1:${pageUrl.port}/api/query?token=${token}&q=summary`,
      );
      const answer = (await queried.json()) as { summary: string };
      expect(answer.summary).toContain('Should health require auth?');
      expect(answer.summary).not.toContain('npm test');
      const denied = await fetch(`http://127.0.0.1:${pageUrl.port}/api/brain`);
      expect(denied.status).toBe(401);
    } finally {
      await server.close();
    }

    const second = await serveCli(opts);
    try {
      expect(new URL(second.url).port).not.toBe(pageUrl.port);
    } finally {
      await second.close();
    }

    const reinject = await runCli(['hook', 'cursor', 'sessionStart'], {
      ...opts,
      stdin: JSON.stringify({
        conversation_id: 'conv-2',
        session_id: 'conv-2',
        hook_event_name: 'sessionStart',
        workspace_roots: [project],
      }),
    });
    expect(reinject.stdout).toContain('Should health require auth?');
    expect(reinject.stdout).not.toContain('%%rizz:event%%');
  }, 20_000);

  it('records a Codex session and still refuses a zstd rollout', async () => {
    const home = await tempDir('rizz-codex-home-');
    const hookHome = await tempDir('rizz-codex-hooks-');
    const project = await tempDir('rizz-codex-project-');
    const opts = { cwd: project, home, hookHome };
    const init = await runCli(['init', '--host', 'codex', '--no-serve', '--no-open'], opts);
    expect(init.code).toBe(0);
    const hooks = await readFile(join(hookHome, '.codex', 'hooks.json'), 'utf8');
    expect(hooks).toContain('SessionStart');
    expect(hooks).toContain('UserPromptSubmit');
    expect(hooks).toContain(realpathSync(cliPath));
    expect(hooks).toContain('hook codex Stop');
    expect(hooks).not.toContain('"rizz" hook');
    await expect(readFile(join(hookHome, '.codex', 'config.toml'), 'utf8')).rejects.toThrow();

    const common = { session_id: 'thread-9', cwd: project };
    const start = await runCli(['hook', 'codex', 'SessionStart'], {
      ...opts,
      stdin: JSON.stringify({ ...common, hook_event_name: 'SessionStart' }),
    });
    expect(start.stdout).toContain('additionalContext');
    await runCli(['hook', 'codex', 'UserPromptSubmit'], {
      ...opts,
      stdin: JSON.stringify({
        ...common,
        'turn-id': 'turn-1',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Ship the health route.\nOwner decision: Should health require auth?',
      }),
    });
    await runCli(['hook', 'codex', 'PostToolUse'], {
      ...opts,
      stdin: JSON.stringify({
        ...common,
        'turn-id': 'tool-9',
        hook_event_name: 'PostToolUse',
        tool_name: 'shell',
        tool_input: { command: 'npm test' },
      }),
    });
    await runCli(['hook', 'codex', 'Stop'], {
      ...opts,
      stdin: JSON.stringify({
        ...common,
        'turn-id': 'stop-9',
        hook_event_name: 'Stop',
        status: 'completed',
        last_assistant_message: 'I ran npm test.',
      }),
    });
    expect((await runCli(['fold'], opts)).code).toBe(0);
    const summary = await runCli(['summary'], opts);
    expect(summary.stdout).toContain('Should health require auth?');
    expect(summary.stdout).not.toContain('npm test');
    const observe = await observeDir(home);
    const handoffs = await readdir(join(observe, 'handoffs'));
    expect(handoffs.length).toBeGreaterThan(0);

    const rollout = join(project, 'rollout.jsonl');
    await writeFile(
      rollout,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-z', cwd: project } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 18, output_tokens: 4, cached_input_tokens: 3 } } } })}\n`,
    );
    const plain = await runCli(['codex-session', rollout], opts);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('2 codex session event(s)');
    expect((await runCli(['fold'], opts)).code).toBe(0);
    const tokens = await runCli(['tokens'], opts);
    expect(tokens.stdout).toContain('18 in / 4 out');

    const compressed = await runCli(['codex-session', join(project, 'rollout.jsonl.zst')], opts);
    expect(compressed.code).toBe(1);
    expect(compressed.stderr).toContain('CODEX_ROLLUP_COMPRESSED');
  }, 20_000);

  it('records a Claude Code session and summarizes only the owner decision', async () => {
    const home = await tempDir('rizz-claude-home-');
    const hookHome = await tempDir('rizz-claude-hooks-');
    const project = await tempDir('rizz-claude-project-');
    const opts = { cwd: project, home, hookHome };
    const init = await runCli(['init', '--host', 'claude', '--no-serve', '--no-open'], opts);
    expect(init.code).toBe(0);
    const settings = await readFile(join(hookHome, '.claude', 'settings.json'), 'utf8');
    expect(settings).toContain('SessionStart');
    expect(settings).toContain('UserPromptSubmit');
    expect(settings).toContain('PostToolUse');
    expect(settings).toContain(realpathSync(cliPath));
    expect(settings).toContain('hook claude Stop');

    const start = await runCli(['hook', 'claude', 'SessionStart'], {
      ...opts,
      stdin: JSON.stringify({
        session_id: 'claude-1',
        cwd: project,
        hook_event_name: 'SessionStart',
      }),
    });
    expect(start.stdout).toContain('hookSpecificOutput');
    expect(start.stdout).toContain('additionalContext');
    await runCli(['hook', 'claude', 'UserPromptSubmit'], {
      ...opts,
      stdin: JSON.stringify({
        session_id: 'claude-1',
        cwd: project,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Wire health.\nOwner decision: Should Lokesh approve the public route?',
      }),
    });
    await runCli(['hook', 'claude', 'PostToolUse'], {
      ...opts,
      stdin: JSON.stringify({
        session_id: 'claude-1',
        cwd: project,
        tool_use_id: 'tool-c',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
      }),
    });
    await runCli(['hook', 'claude', 'Stop'], {
      ...opts,
      stdin: JSON.stringify({
        session_id: 'claude-1',
        cwd: project,
        hook_event_name: 'Stop',
        status: 'completed',
        last_assistant_message: 'Tests passed.',
      }),
    });
    expect((await runCli(['fold'], opts)).code).toBe(0);
    const summary = await runCli(['summary'], opts);
    expect(summary.stdout).toContain('Should Lokesh approve the public route?');
    expect(summary.stdout).not.toContain('pnpm test');
    expect(summary.stdout).not.toContain('Tests passed');
    const observe = await observeDir(home);
    const month = new Date().toISOString().slice(0, 7);
    const journal = await readFile(join(observe, 'journal', `${month}.md`), 'utf8');
    expect(journal).toContain('%%rizz:event%%');
    expect(eventsIn(journal).some((item) => item.threadId === 'claude-claude-1')).toBe(true);
  }, 20_000);

  it('opens the local page unless --no-open is set', async () => {
    const home = await tempDir('rizz-open-home-');
    const hookHome = await tempDir('rizz-open-hooks-');
    const project = await tempDir('rizz-open-project-');
    const opened: string[] = [];
    const controller = new AbortController();
    const code = await runObserveCli(['serve'], {
      cwd: project,
      rizzHome: home,
      homeDir: hookHome,
      signal: controller.signal,
      open(url) {
        opened.push(url);
        controller.abort();
      },
    });
    expect(code).toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    const port = Number(new URL(opened[0] ?? 'http://127.0.0.1').port);
    expect(port).toBeGreaterThan(0);

    const quiet = new AbortController();
    quiet.abort();
    let calls = 0;
    const quietCode = await runObserveCli(['serve', '--no-open'], {
      cwd: project,
      rizzHome: home,
      homeDir: hookHome,
      signal: quiet.signal,
      open() {
        calls += 1;
      },
    });
    expect(quietCode).toBe(0);
    expect(calls).toBe(0);
  }, 20_000);

  it('prints help for init --help and does not install hooks or start a page', async () => {
    const home = await tempDir('rizz-help-home-');
    const hookHome = await tempDir('rizz-help-hooks-');
    const project = await tempDir('rizz-help-project-');
    const started = Date.now();
    const help = await runCli(['init', '--help'], { cwd: project, home, hookHome });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('rizz init');
    expect(help.stdout).not.toContain('rizz serve pid');
    await expect(readFile(join(hookHome, '.cursor', 'hooks.json'), 'utf8')).rejects.toThrow();
  });

  it('returns from init while the local page stays up', async () => {
    const home = await tempDir('rizz-init-home-');
    const hookHome = await tempDir('rizz-init-hooks-');
    const project = await tempDir('rizz-init-project-');
    const started = Date.now();
    const init = await runCli(['init', '--host', 'cursor', '--no-open'], {
      cwd: project,
      home,
      hookHome,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(init.code).toBe(0);
    const url = init.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
    const pid = Number(init.stdout.match(/rizz serve pid (\d+)/)?.[1]);
    expect(url).toBeDefined();
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    try {
      const page = await fetch(url ?? '');
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Rizz brain');
    } finally {
      await stopDetachedPage(pid);
    }
  }, 20_000);
});

async function stopDetachedPage(pid: number): Promise<void> {
  try {
    process.kill(pid);
  } catch {
    return;
  }
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
