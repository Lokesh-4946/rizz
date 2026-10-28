import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareProjectStore } from '../project-store.js';
import { BRAIN_LINE_CAP, renderBrain, snapshotFromEvents } from './brain-index.js';
import { detectHosts, runObserveCli } from './cli.js';
import { readCodexRollout } from './codex-session.js';
import { checkDrift } from './drift.js';
import { appendSpoolEvent, countUnrecorded, foldSpool } from './fold.js';
import { parseHandoffBlock } from './handoff.js';
import {
  hookCommand,
  installClaudeHooks,
  installCodexHooks,
  installCursorHooks,
} from './install.js';
import { withLock, writeAtomic } from './io.js';
import { appendJournalEvent, eventsIn } from './journal.js';
import { type ObserveEvent, normalizeHook } from './model.js';
import { ensureObserveVault } from './notes.js';
import { observePaths, spoolDropDir, spoolFile, spoolLock, spoolPendingDir } from './paths.js';
import { receiveHook } from './receive.js';
import { staffOk } from './result.js';
import { startObserveServer } from './serve.js';
import { renderSummary } from './summary.js';

const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(id: string, at: string, text = 'note') {
  return normalizeHook({
    tool: 'cursor',
    hook: 'beforeSubmitPrompt',
    payload: {
      conversation_id: 'conv-1',
      generation_id: id,
      prompt: text,
      hook_event_name: 'beforeSubmitPrompt',
    },
    projectRoot: '/tmp/project',
    at,
  });
}

describe('append-only brain', () => {
  it('appends journal bytes without rewriting earlier events', async () => {
    const dir = await tempDir('rizz-journal-');
    const first = event('gen-1', '2026-10-28T08:00:00.000Z', 'first prompt');
    const second = event('gen-2', '2026-10-28T08:05:00.000Z', 'second prompt');
    expect((await appendJournalEvent(dir, first)).ok).toBe(true);
    const path = join(dir, '2026-10.md');
    const before = await readFile(path, 'utf8');
    expect((await appendJournalEvent(dir, second)).ok).toBe(true);
    const after = await readFile(path, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(eventsIn(after).map((item) => item.id)).toEqual([first.id, second.id]);
    const duplicate = await appendJournalEvent(dir, first);
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    expect(duplicate.value).toBe('duplicate');
    expect(await readFile(path, 'utf8')).toBe(after);
  });

  it('keeps the rewritten index under 200 lines', () => {
    const events = Array.from({ length: 80 }, (_, index) =>
      event(
        `gen-${index}`,
        `2026-10-28T08:${String(index % 60).padStart(2, '0')}:00.000Z`,
        `prompt ${index}`,
      ),
    );
    const rendered = renderBrain(
      snapshotFromEvents(events, {
        updated: '2026-10-28T09:00:00.000Z',
        projectRoot: '/tmp/project',
        decisions: [],
        inbox: [],
        visionQuote: ['stay local'],
      }),
    );
    expect(rendered.split('\n').length).toBeLessThanOrEqual(BRAIN_LINE_CAP);
    expect(rendered).toContain('## Decisions awaiting you');
  });

  it('flags a Never constraint without treating a similar decision as a block', () => {
    const findings = checkDrift({
      visionText: '## Never\n- commit secrets or credentials\n',
      decisions: [
        {
          id: 'dec-1',
          text: 'Workers each get a git worktree',
          source: 'owner',
          createdAt: '2026-10-28T00:00:00.000Z',
        },
      ],
      text: 'Please commit the API credentials into the repo and document the secrets',
      proposedDecisions: [{ text: 'Workers each get a git worktree for isolation' }],
    });
    expect(
      findings.some((item) => item.kind === 'never_constraint' && item.severity === 'block'),
    ).toBe(true);
    expect(findings.some((item) => item.kind === 'decision_overlap')).toBe(true);
  });

  it('parses a rizz-handoff fence from an agent reply', () => {
    const parsed = parseHandoffBlock(
      'done\n```rizz-handoff\n{"goal":"health","done":["route"],"open":[],"decisions":[],"files":["src/health.ts"],"ownerDecisions":["Should health require auth?"]}\n```\n',
    );
    expect(parsed.incomplete).toBe(false);
    expect(parsed.body.ownerDecisions).toEqual(['Should health require auth?']);
  });
});

describe('host hooks', () => {
  it('merges Cursor hooks without dropping an existing command', async () => {
    const home = await tempDir('rizz-hooks-');
    const path = join(home, '.cursor', 'hooks.json');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ version: 1, hooks: { stop: [{ command: 'echo keep' }] } }, null, 2)}\n`,
    );
    expect((await installCursorHooks(home)).ok).toBe(true);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      hooks: { stop: { command: string }[] };
    };
    expect(parsed.hooks.stop.map((entry) => entry.command)).toContain('echo keep');
    expect(parsed.hooks.stop.map((entry) => entry.command)).toContain(
      hookCommand('cursor', 'stop'),
    );
    expect(hookCommand('cursor', 'stop').startsWith('rizz ')).toBe(false);
    expect(hookCommand('cursor', 'stop')).toContain(process.execPath);
    expect(hookCommand('cursor', 'stop')).toContain('hook cursor stop');
  });

  it('merges Codex hooks without dropping an existing command', async () => {
    const home = await tempDir('rizz-codex-hooks-');
    const path = join(home, '.codex', 'hooks.json');
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } }, null, 2)}\n`,
    );
    expect((await installCodexHooks(home)).ok).toBe(true);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      hooks: {
        Stop: { hooks: { command: string }[] }[];
        SessionStart: { hooks: { command: string }[] }[];
      };
    };
    const stopCommands = parsed.hooks.Stop.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(stopCommands).toContain('echo keep');
    expect(stopCommands).toContain(hookCommand('codex', 'Stop'));
    expect(parsed.hooks.SessionStart[0]?.hooks[0]?.command).toBe(
      hookCommand('codex', 'SessionStart'),
    );
  });

  it('merges Claude Code hooks without dropping existing settings', async () => {
    const home = await tempDir('rizz-claude-hooks-');
    const path = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ model: 'keep-me', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } }, null, 2)}\n`,
    );
    expect((await installClaudeHooks(home)).ok).toBe(true);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      model: string;
      hooks: {
        Stop: { hooks: { command: string }[] }[];
        SessionStart: { hooks: { command: string }[] }[];
      };
    };
    expect(parsed.model).toBe('keep-me');
    const stopCommands = parsed.hooks.Stop.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(stopCommands).toContain('echo keep');
    expect(stopCommands).toContain(hookCommand('claude', 'Stop'));
    expect(parsed.hooks.SessionStart[0]?.hooks[0]?.command).toBe(
      hookCommand('claude', 'SessionStart'),
    );
  });

  it('fails open when the payload is not JSON', async () => {
    const home = await tempDir('rizz-hook-home-');
    const project = await tempDir('rizz-hook-project-');
    const response = await receiveHook({
      tool: 'cursor',
      hook: 'stop',
      stdin: 'not-json',
      projectRoot: project,
      rizzHome: home,
    });
    expect(response.exitCode).toBe(0);
    expect(response.stdout).toBe('{}\n');
  });

  it('detects the running host and otherwise assumes Cursor', () => {
    expect(
      detectHosts({ env: { CLAUDECODE: '1' }, cursor: true, codex: true, claude: true }).hosts,
    ).toEqual(['claude']);
    expect(detectHosts({ env: {}, cursor: false, codex: false, claude: false })).toEqual({
      hosts: ['cursor'],
      assumed: true,
    });
  });
});

describe('fake Cursor session', () => {
  it('records hooks into the brain, ledger, handoff, and local page', async () => {
    const home = await tempDir('rizz-e2e-home-');
    const project = await tempDir('rizz-e2e-project-');
    const at = '2026-10-28T08:00:00.000Z';
    const send = async (hook: string, payload: Record<string, unknown>) => {
      const response = await receiveHook({
        tool: 'cursor',
        hook,
        stdin: JSON.stringify(payload),
        projectRoot: project,
        rizzHome: home,
        at,
      });
      expect(response.exitCode).toBe(0);
      return response;
    };
    const start = await send('sessionStart', {
      conversation_id: 'conv-1',
      session_id: 'conv-1',
      hook_event_name: 'sessionStart',
      workspace_roots: [project],
    });
    expect(start.stdout).toContain('additional_context');
    await send('beforeSubmitPrompt', {
      conversation_id: 'conv-1',
      generation_id: 'gen-1',
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'Add a health route.\nOwner decision: Should health require auth?',
      workspace_roots: [project],
    });
    await send('postToolUse', {
      conversation_id: 'conv-1',
      generation_id: 'tool-1',
      tool_use_id: 'tool-1',
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'npm test' },
      workspace_roots: [project],
    });
    await send('afterFileEdit', {
      conversation_id: 'conv-1',
      generation_id: 'edit-1',
      hook_event_name: 'afterFileEdit',
      file_path: 'src/health.ts',
      workspace_roots: [project],
    });
    await send('preCompact', {
      conversation_id: 'conv-1',
      generation_id: 'compact-1',
      hook_event_name: 'preCompact',
      context_tokens: 1200,
      workspace_roots: [project],
    });
    await send('subagentStop', {
      conversation_id: 'conv-1',
      generation_id: 'sub-1',
      hook_event_name: 'subagentStop',
      status: 'completed',
      summary: 'Added the route.',
      modified_files: ['src/health.ts'],
      workspace_roots: [project],
    });
    await send('beforeSubmitPrompt', {
      conversation_id: 'conv-1',
      generation_id: 'gen-1',
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'Add a health route.\nOwner decision: Should health require auth?',
      workspace_roots: [project],
    });
    const folded = await foldSpool(home);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(folded.value.duplicates).toBe(1);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    const brain = await readFile(paths.brain, 'utf8');
    expect(brain).toContain('cursor-conv-1');
    expect(brain.split('\n').length).toBeLessThanOrEqual(BRAIN_LINE_CAP);
    expect(brain).toContain('Should health require auth?');
    const journal = await readFile(join(paths.journalDir, '2026-10.md'), 'utf8');
    expect(eventsIn(journal).filter((item) => item.id.includes('gen-1'))).toHaveLength(1);
    const handoffEvent = eventsIn(journal).find((item) => item.hook === 'subagentStop');
    const handoffName = `${(handoffEvent?.id ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80)}.md`;
    const handoffs = await readFile(join(paths.handoffsDir, handoffName), 'utf8');
    expect(handoffs).toContain('src/health.ts');
    const ledger = await readFile(paths.ledger, 'utf8');
    expect(ledger).toContain('"context":1200');
    expect(ledger).toContain('"reported":false');
    const server = await startObserveServer({
      projectRoot: project,
      rizzHome: home,
      token: 'test-token',
    });
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('cursor-conv-1');
      expect(html).toContain('Rizz brain');
      const summary = await fetch(
        `http://127.0.0.1:${server.port}/api/query?token=test-token&q=summary`,
      );
      const body = (await summary.json()) as { summary: string };
      expect(body.summary).toContain('Should health require auth?');
      expect(body.summary).not.toContain('npm test');
      const denied = await fetch(`http://127.0.0.1:${server.port}/api/brain`);
      expect(denied.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('reads Codex rollout JSONL and refuses zstd files', async () => {
    const dir = await tempDir('rizz-codex-');
    const file = join(dir, 'rollout.jsonl');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-9', cwd: dir } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 18, output_tokens: 4, cached_input_tokens: 3 } } } })}\n`,
    );
    const events = await readCodexRollout({
      path: file,
      projectRoot: dir,
      at: '2026-10-28T08:00:00.000Z',
    });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value[0]?.hook).toBe('SessionStart');
    expect(events.value[1]?.fields.inputTokens).toBe('18');
    expect(events.value[1]?.fields.reported).toBe('yes');
    const compressed = await readCodexRollout({
      path: join(dir, 'rollout.jsonl.zst'),
      projectRoot: dir,
      at: '2026-10-28T08:00:00.000Z',
    });
    expect(compressed.ok).toBe(false);
    if (compressed.ok) return;
    expect(compressed.error.code).toBe('CODEX_ROLLUP_COMPRESSED');
  });
});

function holdProcess(
  script: string,
  env: Record<string, string>,
): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('holder did not start')), 2000);
    child.once('spawn', () => {
      clearTimeout(timer);
      resolve(child);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function sigkill(child: ReturnType<typeof spawn>): Promise<void> {
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));
}

const TORN_APPEND = `
import { openSync, writeSync, fsyncSync } from 'node:fs';
const fd = openSync(process.env.KILL_PATH, process.env.KILL_FLAGS || 'a');
writeSync(fd, process.env.KILL_BYTES);
fsyncSync(fd);
setInterval(() => {}, 1000);
`;

const HOLD_LOCK = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync(process.env.KILL_PATH, { recursive: true });
writeFileSync(join(process.env.KILL_PATH, 'pid'), String(process.pid) + String.fromCharCode(10));
setInterval(() => {}, 1000);
`;

describe('crash-safe brain writes', () => {
  it('drops a torn journal tail after the writer is killed and keeps committed events', async () => {
    const dir = await tempDir('rizz-kill-journal-');
    const first = event('gen-a', '2026-10-28T08:00:00.000Z', 'first committed');
    const second = event('gen-b', '2026-10-28T08:01:00.000Z', 'second committed');
    const third = event('gen-c', '2026-10-28T08:02:00.000Z', 'third after kill');
    expect((await appendJournalEvent(dir, first)).ok).toBe(true);
    expect((await appendJournalEvent(dir, second)).ok).toBe(true);
    const path = join(dir, '2026-10.md');
    const committed = await readFile(path, 'utf8');
    const child = await holdProcess(TORN_APPEND, {
      KILL_PATH: path,
      KILL_BYTES: '%%rizz:event%%{"id":"torn","text":"partial',
    });
    const grew = await waitFor(async () => {
      const text = await readFile(path, 'utf8');
      return text.includes('"id":"torn"') ? text : undefined;
    });
    expect(grew?.startsWith(committed)).toBe(true);
    await sigkill(child);
    expect((await appendJournalEvent(dir, third)).ok).toBe(true);
    const recovered = await readFile(path, 'utf8');
    expect(recovered.startsWith(committed)).toBe(true);
    expect(recovered).not.toContain('"id":"torn"');
    expect(eventsIn(recovered).map((item) => item.id)).toEqual([first.id, second.id, third.id]);
  });

  it('keeps the previous index when a replacement write is killed before rename', async () => {
    const dir = await tempDir('rizz-kill-index-');
    const path = join(dir, 'BRAIN.md');
    expect((await writeAtomic(path, 'complete-v1\n')).ok).toBe(true);
    const tmp = join(dir, 'BRAIN.md.killed.tmp');
    const child = await holdProcess(TORN_APPEND, {
      KILL_PATH: tmp,
      KILL_BYTES: 'PARTIAL-INDEX',
      KILL_FLAGS: 'w',
    });
    await waitFor(async () => {
      const text = await readFile(tmp, 'utf8').catch(() => '');
      return text.includes('PARTIAL') ? text : undefined;
    });
    await sigkill(child);
    expect(await readFile(path, 'utf8')).toBe('complete-v1\n');
    expect((await writeAtomic(path, 'complete-v2\n')).ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('complete-v2\n');
  });

  it('takes a lock after its holder is killed', async () => {
    const dir = await tempDir('rizz-lock-kill-');
    const lock = join(dir, 'lock');
    const child = await holdProcess(HOLD_LOCK, { KILL_PATH: lock });
    await waitFor(async () => {
      const text = await readFile(join(lock, 'pid'), 'utf8').catch(() => '');
      return text.trim() === '' ? undefined : text;
    });
    await sigkill(child);
    const result = await withLock(lock, async () => staffOk('in'));
    expect(result).toEqual({ ok: true, value: 'in' });
  });

  it('clears a lock directory that has no live holder', async () => {
    const dir = await tempDir('rizz-lock-stale-');
    const lock = join(dir, 'lock');
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 11_000);
    await utimes(lock, old, old);
    const result = await withLock(lock, async () => staffOk('in'));
    expect(result).toEqual({ ok: true, value: 'in' });
  });

  it('replays the spool when the offset file was torn', async () => {
    const home = await tempDir('rizz-offset-');
    const project = await tempDir('rizz-offset-project-');
    await receiveHook({
      tool: 'cursor',
      hook: 'beforeSubmitPrompt',
      stdin: JSON.stringify({
        conversation_id: 'conv-offset',
        generation_id: 'gen-offset',
        prompt: 'Owner decision: Keep the offset?',
        hook_event_name: 'beforeSubmitPrompt',
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at: '2026-10-28T08:00:00.000Z',
    });
    await writeFile(join(home, 'spool', 'offset.json'), '{');
    const folded = await foldSpool(home);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(folded.value.applied).toBe(1);
    await writeFile(join(home, 'spool', 'offset.json'), '{');
    const again = await foldSpool(home);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.applied).toBe(0);
    expect(again.value.duplicates).toBe(1);
  });

  it('keeps concurrent spool lines as whole JSON records', async () => {
    const home = await tempDir('rizz-spool-race-');
    const events = Array.from({ length: 12 }, (_, index) =>
      event(`gen-p-${index}`, '2026-10-28T08:00:00.000Z', `prompt ${index}`),
    );
    const results = await Promise.all(events.map((item) => appendSpoolEvent(home, item)));
    expect(results.every((result) => result.ok)).toBe(true);
    const lines = (await readFile(spoolFile(home), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(12);
    const texts = lines.map((line) => JSON.parse(line).text).sort();
    expect(texts).toEqual(events.map((item) => item.text).sort());
  });

  it('records a hook after a fold dies holding the spool lock', async () => {
    const home = await tempDir('rizz-dead-lock-');
    const project = await tempDir('rizz-dead-lock-project-');
    const lock = spoolLock(home);
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 5_000);
    await utimes(lock, old, old);
    const started = Date.now();
    const response = await receiveHook({
      tool: 'cursor',
      hook: 'beforeSubmitPrompt',
      stdin: JSON.stringify({
        conversation_id: 'conv-lock',
        generation_id: 'gen-lock',
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'Owner decision: Keep recording after a crash?',
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at: '2026-10-28T08:10:00.000Z',
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(response.exitCode).toBe(0);
    expect(response.stderr).toBe('');
    expect(await readFile(spoolFile(home), 'utf8')).toContain('Keep recording after a crash?');
  });

  it('still records a hook when a live fold holds the lock', async () => {
    const home = await tempDir('rizz-live-lock-');
    const project = await tempDir('rizz-live-lock-project-');
    const lock = spoolLock(home);
    const child = await holdProcess(HOLD_LOCK, { KILL_PATH: lock });
    await waitFor(async () => {
      const text = await readFile(join(lock, 'pid'), 'utf8').catch(() => '');
      return text.trim() === '' ? undefined : text;
    });
    try {
      const started = Date.now();
      const response = await receiveHook({
        tool: 'cursor',
        hook: 'beforeSubmitPrompt',
        stdin: JSON.stringify({
          conversation_id: 'conv-live',
          generation_id: 'gen-live',
          hook_event_name: 'beforeSubmitPrompt',
          prompt: 'still recorded while the lock is held',
          workspace_roots: [project],
        }),
        projectRoot: project,
        rizzHome: home,
        at: '2026-10-28T08:11:00.000Z',
      });
      const elapsed = Date.now() - started;
      expect(response.exitCode).toBe(0);
      expect(response.stderr).toBe('');
      expect(elapsed).toBeGreaterThan(1500);
      expect(elapsed).toBeLessThan(5000);
      const shared = await readFile(spoolFile(home), 'utf8').catch(() => '');
      expect(shared).not.toContain('still recorded while the lock is held');
      const queued = await readdir(spoolPendingDir(home));
      expect(queued.filter((name) => name.endsWith('.json'))).toHaveLength(1);
      const body = await readFile(join(spoolPendingDir(home), queued[0] ?? ''), 'utf8');
      expect(JSON.parse(body).text).toContain('still recorded while the lock is held');
    } finally {
      await sigkill(child);
    }
  }, 8_000);

  it('finishes ledger, inbox, handoff, and index when the journal line already exists', async () => {
    const home = await tempDir('rizz-replay-');
    const project = await tempDir('rizz-replay-project-');
    const response = await receiveHook({
      tool: 'cursor',
      hook: 'stop',
      stdin: JSON.stringify({
        conversation_id: 'conv-replay',
        generation_id: 'stop-replay',
        hook_event_name: 'stop',
        status: 'completed',
        summary: 'Owner decision: Ship the public route?',
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at: '2026-10-28T08:12:00.000Z',
    });
    expect(response.exitCode).toBe(0);
    const event = JSON.parse((await readFile(spoolFile(home), 'utf8')).trim()) as ObserveEvent;
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    expect((await ensureObserveVault(paths)).ok).toBe(true);
    expect((await appendJournalEvent(paths.journalDir, event)).ok).toBe(true);
    const folded = await foldSpool(home);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(folded.value.duplicates).toBe(1);
    expect(folded.value.applied).toBe(0);
    expect(await readFile(paths.ledger, 'utf8')).toContain(event.id);
    expect((await readdir(paths.inboxDir)).length).toBeGreaterThan(0);
    expect((await readdir(paths.handoffsDir)).length).toBe(1);
    expect(await readFile(paths.brain, 'utf8')).toContain('Ship the public route?');
    const threadPath = join(paths.threadsDir, `${event.threadId}.md`);
    const thread = await readFile(threadPath, 'utf8');
    expect(thread.split(event.id).length - 1).toBe(1);
    await writeFile(join(home, 'spool', 'offset.json'), '{');
    const again = await foldSpool(home);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.duplicates).toBe(1);
    expect(await readFile(threadPath, 'utf8')).toBe(thread);
  });
});

describe('owner answers', () => {
  it('stores the answer and does not treat the question as the decision', async () => {
    const home = await tempDir('rizz-decide-');
    const project = await tempDir('rizz-decide-project-');
    await receiveHook({
      tool: 'cursor',
      hook: 'beforeSubmitPrompt',
      stdin: JSON.stringify({
        conversation_id: 'conv-decide',
        generation_id: 'gen-decide',
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'Owner decision: Should health require auth?',
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at: '2026-10-28T08:20:00.000Z',
    });
    const folded = await foldSpool(home);
    expect(folded.ok).toBe(true);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    const inboxName = (await readdir(paths.inboxDir))[0];
    expect(inboxName).toBeDefined();
    const id = (inboxName ?? '').replace(/\.md$/, '');
    const server = await startObserveServer({
      projectRoot: project,
      rizzHome: home,
      token: 'decide-token',
    });
    try {
      const missing = await fetch(`http://127.0.0.1:${server.port}/api/decide?token=decide-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      expect(missing.status).toBe(400);
      expect(await readdir(paths.inboxDir)).toEqual([inboxName]);
      expect(await readFile(paths.decisions, 'utf8')).not.toContain(
        '"text":"Should health require auth?"',
      );
      const answered = await fetch(
        `http://127.0.0.1:${server.port}/api/decide?token=decide-token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, answer: 'Yes, require auth' }),
        },
      );
      expect(answered.status).toBe(200);
      const decisions = await readFile(paths.decisions, 'utf8');
      expect(decisions).toContain('Yes, require auth');
      expect(decisions).not.toContain('"text":"Should health require auth?"');
      expect(await readdir(paths.inboxDir)).toEqual([]);
      const brain = await readFile(paths.brain, 'utf8');
      const awaiting = brain.split('## Current decisions')[0] ?? '';
      expect(awaiting).not.toContain('Should health require auth?');
      expect(brain).toContain('Yes, require auth');
    } finally {
      await server.close();
    }
  });

  it('does not list an answered decision again after the spool is replayed', async () => {
    const home = await tempDir('rizz-replay-answer-');
    const project = await tempDir('rizz-replay-answer-project-');
    const hookHome = await tempDir('rizz-replay-answer-hooks-');
    await receiveHook({
      tool: 'cursor',
      hook: 'beforeSubmitPrompt',
      stdin: JSON.stringify({
        conversation_id: 'conv-friday',
        generation_id: 'gen-friday',
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'Owner decision: Ship on Friday?',
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at: '2026-10-28T08:30:00.000Z',
    });
    expect((await foldSpool(home)).ok).toBe(true);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    const inboxName = (await readdir(paths.inboxDir))[0];
    const id = (inboxName ?? '').replace(/\.md$/, '');
    const server = await startObserveServer({
      projectRoot: project,
      rizzHome: home,
      token: 'replay-token',
    });
    try {
      const answered = await fetch(
        `http://127.0.0.1:${server.port}/api/decide?token=replay-token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, answer: 'Ship on Monday instead' }),
        },
      );
      expect(answered.status).toBe(200);
    } finally {
      await server.close();
    }
    await writeFile(join(home, 'spool', 'offset.json'), '{');
    expect((await foldSpool(home)).ok).toBe(true);
    const inboxAfter = await readdir(paths.inboxDir).catch(() => [] as string[]);
    expect(inboxAfter).toEqual([]);
    let summary = '';
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      summary += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runObserveCli(['summary'], {
        cwd: project,
        rizzHome: home,
        homeDir: hookHome,
      });
      expect(code).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(summary).not.toContain('Ship on Friday?');
    expect(summary).toContain('No decisions need the owner.');
    const brain = await readFile(paths.brain, 'utf8');
    const awaiting = brain.split('## Current decisions')[0] ?? '';
    expect(awaiting).not.toContain('Ship on Friday?');
  });
});

describe('concurrent hooks', () => {
  it('keeps every large hook when thirty arrive together, three times', async () => {
    const home = await tempDir('rizz-stress-');
    const project = await tempDir('rizz-stress-project-');
    const ids: string[] = [];
    const bulk = 'payload '.repeat(600);
    for (let round = 0; round < 3; round += 1) {
      const batch = Array.from({ length: 30 }, (_, index) => {
        const id = `gen-${round}-${index}`;
        ids.push(id);
        return receiveHook({
          tool: 'cursor',
          hook: 'beforeSubmitPrompt',
          stdin: JSON.stringify({
            conversation_id: 'conv-stress',
            generation_id: id,
            hook_event_name: 'beforeSubmitPrompt',
            prompt: `${bulk}\nmarker ${id}`,
            workspace_roots: [project],
          }),
          projectRoot: project,
          rizzHome: home,
          at: '2026-10-28T09:00:00.000Z',
        });
      });
      const responses = await Promise.all(batch);
      expect(responses.every((response) => response.exitCode === 0 && response.stderr === '')).toBe(
        true,
      );
    }
    const raw = await readFile(spoolFile(home), 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) JSON.parse(line);
    const pendingNames = await readdir(spoolPendingDir(home)).catch(() => [] as string[]);
    for (const name of pendingNames.filter((item) => item.endsWith('.json'))) {
      JSON.parse(await readFile(join(spoolPendingDir(home), name), 'utf8'));
    }
    expect((await foldSpool(home)).ok).toBe(true);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const journal = await readFile(
      join(observePaths(prepared.value.projectDir).journalDir, '2026-10.md'),
      'utf8',
    );
    const found = eventsIn(journal).map((item) => item.id);
    expect(new Set(found).size).toBe(90);
    for (const id of ids) {
      expect(found.some((eventId) => eventId.endsWith(`:${id}`))).toBe(true);
    }
    const drops = await readdir(spoolDropDir(home)).catch(() => [] as string[]);
    expect(drops.filter((name) => name.endsWith('.json'))).toEqual([]);
  }, 60_000);

  it('counts a hook that cannot be written instead of dropping it quietly', async () => {
    const home = await tempDir('rizz-drop-');
    const project = await tempDir('rizz-drop-project-');
    const lock = spoolLock(home);
    const child = await holdProcess(HOLD_LOCK, { KILL_PATH: lock });
    await waitFor(async () => {
      const text = await readFile(join(lock, 'pid'), 'utf8').catch(() => '');
      return text.trim() === '' ? undefined : text;
    });
    await mkdir(join(home, 'spool'), { recursive: true });
    await writeFile(join(home, 'spool', 'pending'), 'not-a-directory\n');
    try {
      const response = await receiveHook({
        tool: 'cursor',
        hook: 'beforeSubmitPrompt',
        stdin: JSON.stringify({
          conversation_id: 'conv-drop',
          generation_id: 'gen-drop',
          hook_event_name: 'beforeSubmitPrompt',
          prompt: 'Owner decision: Did this get lost?',
          workspace_roots: [project],
        }),
        projectRoot: project,
        rizzHome: home,
        at: '2026-10-28T09:30:00.000Z',
      });
      expect(response.exitCode).toBe(0);
      expect(response.stderr).toContain('could not be recorded');
    } finally {
      await sigkill(child);
    }
    expect(await countUnrecorded(home, project)).toBe(1);
    const text = renderSummary({
      threads: 0,
      inbox: [],
      dropped: await countUnrecorded(home, project),
    });
    expect(text).toContain('1 hook event(s) could not be recorded.');
  }, 8_000);
});

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - started > 4000) throw new Error('timed out waiting for the killed writer');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
