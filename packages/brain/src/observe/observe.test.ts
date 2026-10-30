import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareProjectStore } from '../project-store.js';
import { BRAIN_LINE_CAP, renderBrain, snapshotFromEvents } from './brain-index.js';
import { detectHosts, runObserveCli } from './cli.js';
import { readCodexRollout } from './codex-session.js';
import { checkDrift } from './drift.js';
import { appendSpoolEvent, countUnrecorded, foldSpool } from './fold.js';
import { parseHandoffBlock, renderHandoffNote } from './handoff.js';
import {
  hookCommand,
  installClaudeHooks,
  installCodexHooks,
  installCursorHooks,
} from './install.js';
import { withLock, writeAtomic } from './io.js';
import { appendJournalEvent, eventsIn } from './journal.js';
import {
  type ObserveEvent,
  STORE_TEXT_CAP,
  VIEW_TEXT_CAP,
  hasSharedTurnIdentity,
  normalizeHook,
  observeEventId,
  ownerDecisionLines,
  storeText,
} from './model.js';
import { ensureObserveVault, readLatestHandoff } from './notes.js';
import { observePaths, spoolDropDir, spoolFile, spoolLock, spoolPendingDir } from './paths.js';
import { receiveHook } from './receive.js';
import { staffOk } from './result.js';
import { startObserveServer } from './serve.js';
import {
  HANDOFF_CONTEXT_CAP,
  RELAY_CONTEXT_CAP,
  SESSION_CONTEXT_BUDGET,
  composeSessionContext,
} from './session-context.js';
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
    expect(rendered).toContain('## Touched files');
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

  it('reads Owner decision at line start and mid-line, and skips quoted code', () => {
    expect(ownerDecisionLines('Owner decision: Should health require auth?')).toEqual([
      'Should health require auth?',
    ]);
    expect(
      ownerDecisionLines("Don't skip this.\nLokesh wrote Owner decision: Keep the offset?"),
    ).toEqual(['Keep the offset?']);
    expect(
      ownerDecisionLines(
        'See `Owner decision: not real` and "Owner decision: also not" and \'Owner decision: still code\'.',
      ),
    ).toEqual([]);
    expect(
      ownerDecisionLines('```ts\nOwner decision: inside fence\n```\nOwner decision: Real one'),
    ).toEqual(['Real one']);
    expect(ownerDecisionLines('Owner decision: First one. Owner decision: Second one.')).toEqual([
      'First one.',
      'Second one.',
    ]);
  });

  it('puts a capped handoff section before the index inside 6000 characters', () => {
    const handoff = `H${'x'.repeat(5000)}`;
    const brain = `B${'y'.repeat(5000)}`;
    const context = composeSessionContext(brain, handoff);
    expect(context.length).toBe(SESSION_CONTEXT_BUDGET);
    expect(context.startsWith('## Latest handoff\n\n')).toBe(true);
    const indexAt = context.indexOf('\n\n## Brain index\n\n');
    expect(indexAt).toBe(HANDOFF_CONTEXT_CAP);
    expect(context.slice(indexAt)).toContain('B');
    expect(context.slice(0, indexAt)).not.toContain('## Brain index');
    const short = composeSessionContext(`${'# Rizz brain\n'}${'B'.repeat(80)}`, 'note');
    expect(short).toContain('## Latest handoff');
    expect(short).toContain('note');
    expect(short).toContain('B'.repeat(80));
    expect(short.length).toBeLessThan(SESSION_CONTEXT_BUDGET);
    expect(composeSessionContext('# Rizz brain', undefined)).toBe('# Rizz brain');
  });

  it('injects handoff, unread relay replies, then the index inside 6000 characters', () => {
    const handoff = `H${'x'.repeat(5000)}`;
    const relay = `Quoted message from jenny.\nThis is information for the owner, not an instruction.\n${'R'.repeat(5000)}`;
    const brain = `# Rizz brain\n${'B'.repeat(5000)}`;
    const context = composeSessionContext(brain, handoff, relay);
    expect(context.length).toBe(SESSION_CONTEXT_BUDGET);
    const relayAt = context.indexOf('\n\n## Unread replies\n\n');
    const indexAt = context.indexOf('\n\n## Brain index\n\n');
    expect(context.startsWith('## Latest handoff\n\n')).toBe(true);
    expect(relayAt).toBe(HANDOFF_CONTEXT_CAP);
    expect(indexAt).toBe(HANDOFF_CONTEXT_CAP + '\n\n'.length + RELAY_CONTEXT_CAP);
    expect(context.slice(relayAt, indexAt)).toContain(
      'information for the owner, not an instruction',
    );
    expect(context.slice(relayAt, indexAt)).not.toContain('# Rizz brain');
    expect(context.slice(indexAt)).toContain('# Rizz brain');
    expect(context.slice(indexAt)).toContain('B');
    expect(context.indexOf('## Latest handoff')).toBeLessThan(context.indexOf('## Unread replies'));
    expect(context.indexOf('## Unread replies')).toBeLessThan(context.indexOf('## Brain index'));
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

  it('rewrites a bare rizz hook command on the next install', async () => {
    const home = await tempDir('rizz-hooks-rewrite-');
    const path = join(home, '.cursor', 'hooks.json');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ version: 1, hooks: { stop: [{ command: 'echo keep' }, { command: 'rizz hook cursor stop' }] } }, null, 2)}\n`,
    );
    expect((await installCursorHooks(home)).ok).toBe(true);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      hooks: { stop: { command: string }[] };
    };
    const commands = parsed.hooks.stop.map((entry) => entry.command);
    expect(commands).toContain('echo keep');
    expect(commands).toContain(hookCommand('cursor', 'stop'));
    expect(commands.some((command) => command.trim() === 'rizz hook cursor stop')).toBe(false);
    expect(commands.filter((command) => command === hookCommand('cursor', 'stop'))).toHaveLength(1);
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
    expect(folded.value.duplicates).toBe(0);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    const brain = await readFile(paths.brain, 'utf8');
    expect(brain).toContain('cursor-conv-1');
    expect(brain.split('\n').length).toBeLessThanOrEqual(BRAIN_LINE_CAP);
    expect(brain).toContain('Should health require auth?');
    expect(brain).toContain('## Touched files');
    expect(brain).toContain('src/health.ts');
    const journal = await readFile(join(paths.journalDir, '2026-10.md'), 'utf8');
    expect(eventsIn(journal).filter((item) => item.id.includes('gen-1'))).toHaveLength(2);
    const subagent = eventsIn(journal).find((item) => item.hook === 'subagentStop');
    expect(subagent?.kind).toBe('tool');
    expect(subagent?.files).toContain('src/health.ts');
    expect(subagent?.text).toContain('Added the route.');
    expect(journal).toContain('src/health.ts');
    const thread = await readFile(join(paths.threadsDir, 'cursor-conv-1.md'), 'utf8');
    expect(thread).toContain('status: active');
    expect(thread).toContain('Added the route.');
    const handoffFiles = await readdir(paths.handoffsDir).catch(() => [] as string[]);
    expect(handoffFiles.filter((name) => name.endsWith('.md'))).toEqual([]);
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

  it('keeps the next spool record after a fold instead of skipping its first byte', async () => {
    const home = await tempDir('rizz-offset-byte-');
    const project = await tempDir('rizz-offset-byte-project-');
    const at = '2026-10-28T08:00:00.000Z';
    await receiveHook({
      tool: 'cursor',
      hook: 'sessionStart',
      stdin: JSON.stringify({
        conversation_id: 'conv-byte',
        hook_event_name: 'sessionStart',
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at,
    });
    await receiveHook({
      tool: 'cursor',
      hook: 'beforeSubmitPrompt',
      stdin: JSON.stringify({
        conversation_id: 'conv-byte',
        generation_id: 'gen-byte',
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'Keep the byte after the fold.',
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at,
    });
    expect((await foldSpool(home)).ok).toBe(true);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const journal = await readFile(
      join(observePaths(prepared.value.projectDir).journalDir, '2026-10.md'),
      'utf8',
    );
    expect(journal).toContain('Keep the byte after the fold.');
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

describe('session start handoff', () => {
  it('describes the command, the failing test, and the next step', () => {
    const prompt = normalizeHook({
      tool: 'cursor',
      hook: 'beforeSubmitPrompt',
      payload: {
        conversation_id: 'conv-note',
        generation_id: 'prompt-note',
        prompt: 'Add a health route.\n- [ ] wire auth',
      },
      projectRoot: '/tmp/project',
      at: '2026-10-28T08:00:00.000Z',
    });
    const shell = normalizeHook({
      tool: 'cursor',
      hook: 'postToolUse',
      payload: {
        conversation_id: 'conv-note',
        generation_id: 'tool-note',
        tool_name: 'Shell',
        tool_input: { command: 'npm test' },
        exit_code: 1,
        output: ' FAIL  src/health.test.ts > auth required\nAssertionError: expected 200\n',
      },
      projectRoot: '/tmp/project',
      at: '2026-10-28T08:01:00.000Z',
    });
    const note = renderHandoffNote(
      { ...shell, kind: 'stop', fields: { ...shell.fields, status: 'completed' } },
      [prompt, shell],
      [],
    );
    expect(note).toContain('## Latest prompt');
    expect(note).toContain('Add a health route.');
    expect(note).toContain('ran `npm test` (exit 1)');
    expect(note).toContain('`npm test` exited 1');
    expect(note).toContain('FAIL  src/health.test.ts > auth required');
    expect(note).toContain('wire auth');
    expect(note).toContain('## Open / Next');
    expect(note).toContain(
      'Finish "Add a health route." by fixing FAIL  src/health.test.ts > auth required',
    );
    expect(note).not.toMatch(/^- (postToolUse|Shell)$/m);
  });

  it('picks the greater handoff name when mtimes tie', async () => {
    const home = await tempDir('rizz-handoff-tie-');
    const project = await tempDir('rizz-handoff-tie-project-');
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    await mkdir(paths.handoffsDir, { recursive: true });
    await writeFile(join(paths.handoffsDir, 'a-note.md'), 'alpha-only handoff\n');
    await writeFile(join(paths.handoffsDir, 'm-note.md'), 'zeta-only handoff\n');
    const stamp = new Date('2026-10-28T08:00:00.000Z');
    await utimes(join(paths.handoffsDir, 'a-note.md'), stamp, stamp);
    await utimes(join(paths.handoffsDir, 'm-note.md'), stamp, stamp);
    const latest = await readLatestHandoff(paths.handoffsDir);
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value).toContain('zeta-only handoff');
    expect(latest.value).not.toContain('alpha-only');
    const older = new Date('2026-10-27T08:00:00.000Z');
    await utimes(join(paths.handoffsDir, 'm-note.md'), older, older);
    const fresh = await readLatestHandoff(paths.handoffsDir);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value).toContain('alpha-only handoff');
  });

  it.each([
    {
      tool: 'cursor' as const,
      start: 'sessionStart',
      prompt: 'beforeSubmitPrompt',
      shell: 'postToolUse',
      edit: 'afterFileEdit',
      stop: 'stop',
    },
    {
      tool: 'codex' as const,
      start: 'SessionStart',
      prompt: 'UserPromptSubmit',
      shell: 'PostToolUse',
      edit: 'PostToolUse',
      stop: 'Stop',
    },
    {
      tool: 'claude' as const,
      start: 'SessionStart',
      prompt: 'UserPromptSubmit',
      shell: 'PostToolUse',
      edit: 'PostToolUse',
      stop: 'Stop',
    },
  ])('injects the handoff and the brain index for $tool', async (host) => {
    const home = await tempDir(`rizz-inject-${host.tool}-`);
    const project = await tempDir(`rizz-inject-${host.tool}-project-`);
    const at = '2026-10-28T08:00:00.000Z';
    const send = async (hook: string, payload: Record<string, unknown>) =>
      receiveHook({
        tool: host.tool,
        hook,
        stdin: JSON.stringify(payload),
        projectRoot: project,
        rizzHome: home,
        at,
      });
    const common = {
      conversation_id: 'conv-inject',
      session_id: 'conv-inject',
      cwd: project,
      workspace_roots: [project],
    };
    await send(host.start, { ...common, hook_event_name: host.start });
    await send(host.prompt, {
      ...common,
      generation_id: 'prompt-inject',
      'turn-id': 'prompt-inject',
      hook_event_name: host.prompt,
      prompt:
        'Add a health route.\nOwner decision: Should health require auth?\n- [ ] confirm the route',
    });
    await send(host.shell, {
      ...common,
      generation_id: 'shell-inject',
      'turn-id': 'shell-inject',
      tool_use_id: 'shell-inject',
      hook_event_name: host.shell,
      tool_name: 'Shell',
      tool_input: { command: 'npm test' },
      exit_code: 0,
    });
    await send(host.edit, {
      ...common,
      generation_id: 'edit-inject',
      'turn-id': 'edit-inject',
      tool_use_id: 'edit-inject',
      hook_event_name: host.edit,
      tool_name: 'Edit',
      file_path: 'src/health.ts',
      tool_input: { file_path: 'src/health.ts' },
    });
    await send(host.stop, {
      ...common,
      generation_id: 'stop-inject',
      'turn-id': 'stop-inject',
      hook_event_name: host.stop,
      status: 'completed',
      summary: 'Added the route.',
    });
    const next = await send(host.start, {
      ...common,
      conversation_id: 'conv-next',
      session_id: 'conv-next',
      hook_event_name: host.start,
    });
    expect(next.exitCode).toBe(0);
    const context = contextFrom(host.tool, next.stdout);
    expect(context.length).toBeLessThanOrEqual(SESSION_CONTEXT_BUDGET);
    expect(context).toContain('## Latest handoff');
    expect(context).toContain('## Brain index');
    expect(context).toContain('# Rizz brain');
    expect(context).toContain('src/health.ts');
    expect(context).toContain('Add a health route.');
    expect(context).toContain('## Open / Next');
    expect(context).toContain('## Touched files');
  });

  it('recovers a killed session on fold and on the next sessionStart', async () => {
    const home = await tempDir('rizz-recover-');
    const project = await tempDir('rizz-recover-project-');
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
    const common = { conversation_id: 'conv-killed', workspace_roots: [project] };
    await send('sessionStart', { ...common, hook_event_name: 'sessionStart' });
    await send('beforeSubmitPrompt', {
      ...common,
      generation_id: 'prompt-killed',
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'Add a health route.\n- [ ] wire auth',
    });
    await send('postToolUse', {
      ...common,
      generation_id: 'shell-killed',
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'npm test' },
      exit_code: 1,
      output: ' FAIL  src/health.test.ts > auth required\n',
    });
    await send('afterFileEdit', {
      ...common,
      generation_id: 'edit-killed',
      hook_event_name: 'afterFileEdit',
      file_path: 'src/health.ts',
    });
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    const quiet = await foldSpool(home);
    expect(quiet.ok).toBe(true);
    if (!quiet.ok) return;
    expect(quiet.value.recovered).toBe(0);
    await expect(readdir(paths.handoffsDir)).rejects.toThrow();
    const folded = await foldSpool(home, { recoverKilled: true, at });
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(folded.value.recovered).toBe(1);
    const names = await readdir(paths.handoffsDir);
    expect(names).toHaveLength(1);
    const handoff = await readFile(join(paths.handoffsDir, names[0] ?? ''), 'utf8');
    expect(handoff).toContain('recovery: session ended without a stop hook');
    expect(handoff).toContain('## Latest prompt');
    expect(handoff).toContain('Add a health route.');
    expect(handoff).toContain('ran `npm test` (exit 1)');
    expect(handoff).toContain('FAIL  src/health.test.ts > auth required');
    expect(handoff).toContain('edited src/health.ts');
    expect(handoff).toContain('## Touched files');
    expect(handoff).toContain('wire auth');
    expect(handoff).toContain('## Open / Next');
    expect(handoff).toContain(
      'Finish "Add a health route." by fixing FAIL  src/health.test.ts > auth required',
    );
    expect(handoff).not.toMatch(/^- (postToolUse|afterFileEdit|sessionStart)$/m);
    const thread = await readFile(join(paths.threadsDir, 'cursor-conv-killed.md'), 'utf8');
    expect(thread).toContain('status: inactive');
    const brain = await readFile(paths.brain, 'utf8');
    expect(brain).toContain('inactive');
    expect(brain).toContain('## Touched files');
    expect(brain).toContain('src/health.ts');
    const again = await foldSpool(home, { recoverKilled: true, at });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.recovered).toBe(0);

    const other = await tempDir('rizz-recover-next-');
    const otherProject = await tempDir('rizz-recover-next-project-');
    await receiveHook({
      tool: 'cursor',
      hook: 'beforeSubmitPrompt',
      stdin: JSON.stringify({
        conversation_id: 'conv-stale',
        generation_id: 'prompt-stale',
        prompt: 'Leave the router unfinished.',
        workspace_roots: [otherProject],
      }),
      projectRoot: otherProject,
      rizzHome: other,
      at,
    });
    const started = await receiveHook({
      tool: 'cursor',
      hook: 'sessionStart',
      stdin: JSON.stringify({
        conversation_id: 'conv-fresh',
        session_id: 'conv-fresh',
        hook_event_name: 'sessionStart',
        workspace_roots: [otherProject],
      }),
      projectRoot: otherProject,
      rizzHome: other,
      at,
    });
    const body = JSON.parse(started.stdout) as { additional_context: string };
    expect(body.additional_context).toContain('## Latest handoff');
    expect(body.additional_context).toContain('## Brain index');
    expect(body.additional_context).toContain('Leave the router unfinished.');
    expect(body.additional_context).toContain('recovery: session ended without a stop hook');
    expect(body.additional_context.length).toBeLessThanOrEqual(SESSION_CONTEXT_BUDGET);
    const stored = await prepareProjectStore({ rootDir: otherProject, rizzHome: other });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const staleThread = await readFile(
      join(observePaths(stored.value.projectDir).threadsDir, 'cursor-conv-stale.md'),
      'utf8',
    );
    expect(staleThread).toContain('status: inactive');
    const freshThread = await readFile(
      join(observePaths(stored.value.projectDir).threadsDir, 'cursor-conv-fresh.md'),
      'utf8',
    );
    expect(freshThread).toContain('status: active');
  });

  it('uses a rizz-handoff fence on the fold path and queues its owner decision', async () => {
    const home = await tempDir('rizz-fence-');
    const project = await tempDir('rizz-fence-project-');
    const at = '2026-10-28T08:00:00.000Z';
    const fence = [
      '```rizz-handoff',
      JSON.stringify({
        goal: 'ship the public health route',
        done: ['added the route file'],
        open: ['confirm auth'],
        decisions: [],
        files: ['src/from-fence.ts'],
        ownerDecisions: ['Should the fence decision be queued?'],
      }),
      '```',
    ].join('\n');
    await receiveHook({
      tool: 'cursor',
      hook: 'beforeSubmitPrompt',
      stdin: JSON.stringify({
        conversation_id: 'conv-fence',
        generation_id: 'prompt-fence',
        prompt: 'Start the route work.',
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at,
    });
    await receiveHook({
      tool: 'cursor',
      hook: 'stop',
      stdin: JSON.stringify({
        conversation_id: 'conv-fence',
        generation_id: 'stop-fence',
        hook_event_name: 'stop',
        status: 'completed',
        summary: fence,
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at,
    });
    expect((await foldSpool(home)).ok).toBe(true);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    const handoff = await readFile(
      join(paths.handoffsDir, (await readdir(paths.handoffsDir))[0] ?? ''),
      'utf8',
    );
    expect(handoff).toMatch(/## Goal\n\nship the public health route/);
    expect(handoff).toContain('Start the route work.');
    expect(handoff).toContain('added the route file');
    expect(handoff).toContain('src/from-fence.ts');
    expect(handoff).toContain('confirm auth');
    expect(handoff).toContain('Should the fence decision be queued?');
    const inbox = (await readdir(paths.inboxDir)).map((name) => name);
    const bodies = await Promise.all(
      inbox.map((name) => readFile(join(paths.inboxDir, name), 'utf8')),
    );
    expect(bodies.some((body) => body.includes('Should the fence decision be queued?'))).toBe(true);
  });

  it('queues a mid-line owner decision and ignores the quoted example', async () => {
    const home = await tempDir('rizz-owner-inline-');
    const project = await tempDir('rizz-owner-inline-project-');
    await receiveHook({
      tool: 'cursor',
      hook: 'beforeSubmitPrompt',
      stdin: JSON.stringify({
        conversation_id: 'conv-inline',
        generation_id: 'prompt-inline',
        prompt:
          'Please record this. Owner decision: Ship on Friday?\nThe example is "Owner decision: Do not queue this".',
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at: '2026-10-28T08:00:00.000Z',
    });
    expect((await foldSpool(home)).ok).toBe(true);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    const inbox = await readdir(paths.inboxDir);
    expect(inbox).toHaveLength(1);
    const body = await readFile(join(paths.inboxDir, inbox[0] ?? ''), 'utf8');
    expect(body).toContain('Ship on Friday?');
    expect(body).not.toContain('Do not queue this');
    const brain = await readFile(paths.brain, 'utf8');
    const awaiting = brain.split('## Current decisions')[0] ?? '';
    expect(awaiting).toContain('Ship on Friday?');
    expect(awaiting).not.toContain('Do not queue this');
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
      expect(found.some((eventId) => eventId.includes(`:${id}:`))).toBe(true);
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

describe('one turn sharing a generation id', () => {
  const at = '2026-10-28T10:00:00.000Z';

  async function send(
    home: string,
    project: string,
    tool: 'cursor' | 'codex' | 'claude',
    hook: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const response = await receiveHook({
      tool,
      hook,
      stdin: JSON.stringify(payload),
      projectRoot: project,
      rizzHome: home,
      at,
    });
    expect(response.exitCode).toBe(0);
    expect(response.stderr).toBe('');
  }

  async function foldedJournal(home: string, project: string): Promise<ObserveEvent[]> {
    const folded = await foldSpool(home);
    expect(folded.ok).toBe(true);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return [];
    const journal = await readFile(
      join(observePaths(prepared.value.projectDir).journalDir, '2026-10.md'),
      'utf8',
    );
    return eventsIn(journal);
  }

  it('keeps every file edit, shell, tool use, and reply in one Cursor turn', async () => {
    const home = await tempDir('rizz-turn-');
    const project = await tempDir('rizz-turn-project-');
    const shared = {
      conversation_id: 'conv-turn',
      generation_id: 'gen-turn',
      workspace_roots: [project],
    };
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    for (const filePath of files) {
      await send(home, project, 'cursor', 'afterFileEdit', {
        ...shared,
        hook_event_name: 'afterFileEdit',
        file_path: filePath,
      });
    }
    const commands = ['npm test', 'npm run build', 'npm test'];
    for (const command of commands) {
      await send(home, project, 'cursor', 'afterShellExecution', {
        ...shared,
        hook_event_name: 'afterShellExecution',
        command,
      });
    }
    const tools = [
      { tool_name: 'Shell', tool_input: { command: 'pnpm lint' } },
      { tool_name: 'Shell', tool_input: { command: 'pnpm test' } },
      { tool_name: 'Read', tool_input: { path: 'README.md' } },
    ];
    for (const tool of tools) {
      await send(home, project, 'cursor', 'postToolUse', {
        ...shared,
        hook_event_name: 'postToolUse',
        ...tool,
      });
    }
    const replies = ['Edited the health route.', 'Ran the tests.'];
    for (const text of replies) {
      await send(home, project, 'cursor', 'afterAgentResponse', {
        ...shared,
        hook_event_name: 'afterAgentResponse',
        text,
      });
    }
    const events = await foldedJournal(home, project);
    expect(
      events.filter((item) => item.hook === 'afterFileEdit').map((item) => item.files[0]),
    ).toEqual(files);
    expect(
      events.filter((item) => item.hook === 'afterShellExecution').map((item) => item.text),
    ).toEqual(commands);
    expect(events.filter((item) => item.hook === 'postToolUse')).toHaveLength(tools.length);
    expect(
      events.filter((item) => item.hook === 'afterAgentResponse').map((item) => item.text),
    ).toEqual(replies);
    expect(events).toHaveLength(files.length + commands.length + tools.length + replies.length);
  });

  it('does not duplicate a Cursor turn when the same spool is folded twice', async () => {
    const home = await tempDir('rizz-turn-replay-');
    const project = await tempDir('rizz-turn-replay-project-');
    const shared = {
      conversation_id: 'conv-replay-turn',
      generation_id: 'gen-replay-turn',
      workspace_roots: [project],
    };
    await send(home, project, 'cursor', 'afterFileEdit', {
      ...shared,
      hook_event_name: 'afterFileEdit',
      file_path: 'src/a.ts',
    });
    await send(home, project, 'cursor', 'afterFileEdit', {
      ...shared,
      hook_event_name: 'afterFileEdit',
      file_path: 'src/b.ts',
    });
    await send(home, project, 'cursor', 'afterShellExecution', {
      ...shared,
      hook_event_name: 'afterShellExecution',
      command: 'npm test',
    });
    await send(home, project, 'cursor', 'postToolUse', {
      ...shared,
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'pnpm lint' },
    });
    const first = await foldedJournal(home, project);
    await writeFile(join(home, 'spool', 'offset.json'), '{');
    const again = await foldSpool(home);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.applied).toBe(0);
    expect(again.value.duplicates).toBe(first.length);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const journal = await readFile(
      join(observePaths(prepared.value.projectDir).journalDir, '2026-10.md'),
      'utf8',
    );
    expect(eventsIn(journal)).toHaveLength(first.length);
    expect(eventsIn(journal).map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('keeps Codex tool calls that share one turn id', async () => {
    const home = await tempDir('rizz-codex-turn-');
    const project = await tempDir('rizz-codex-turn-project-');
    const commands = ['npm test', 'npm run build', 'git status'];
    for (const command of commands) {
      await send(home, project, 'codex', 'PostToolUse', {
        session_id: 'thread-turn',
        cwd: project,
        'turn-id': 'turn-shared',
        hook_event_name: 'PostToolUse',
        tool_name: 'shell',
        tool_input: { command },
      });
    }
    const events = await foldedJournal(home, project);
    const tools = events.filter((item) => item.hook === 'PostToolUse');
    expect(tools).toHaveLength(commands.length);
    expect(new Set(tools.map((item) => item.id)).size).toBe(commands.length);
  });

  it('keeps Claude tool calls that share one turn id', async () => {
    const home = await tempDir('rizz-claude-turn-');
    const project = await tempDir('rizz-claude-turn-project-');
    const commands = ['pnpm test', 'pnpm lint', 'pnpm build'];
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index] ?? '';
      await send(home, project, 'claude', 'PostToolUse', {
        session_id: 'claude-turn',
        cwd: project,
        'turn-id': 'turn-shared',
        tool_use_id: `tool-${index}`,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      });
    }
    const events = await foldedJournal(home, project);
    const tools = events.filter((item) => item.hook === 'PostToolUse');
    expect(tools).toHaveLength(commands.length);
    expect(new Set(tools.map((item) => item.id)).size).toBe(commands.length);
  });

  it('keeps Claude tool calls that are distinguished only by tool_use_id', async () => {
    const home = await tempDir('rizz-claude-tool-');
    const project = await tempDir('rizz-claude-tool-project-');
    const commands = ['pnpm test', 'pnpm lint'];
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index] ?? '';
      await send(home, project, 'claude', 'PostToolUse', {
        session_id: 'claude-tools',
        cwd: project,
        tool_use_id: `tool-${index}`,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      });
    }
    const events = await foldedJournal(home, project);
    expect(events.filter((item) => item.hook === 'PostToolUse')).toHaveLength(commands.length);
  });
});

describe('journal commits and index caps', () => {
  it('marks a body that exceeds the journal safety cap and keeps its length', () => {
    const text = `${'y'.repeat(STORE_TEXT_CAP)}TAIL`;
    const stored = storeText(text);
    expect(stored.length).toBeLessThanOrEqual(STORE_TEXT_CAP);
    expect(stored).toContain(`[truncated ${text.length} chars]`);
    expect(stored).not.toContain('TAIL');
  });

  it('keeps a late owner decision that sits past the index cap', async () => {
    const home = await tempDir('rizz-long-prompt-');
    const project = await tempDir('rizz-long-prompt-project-');
    const marker = 'LATE-SPEC-MARKER';
    const prompt = `${'spec '.repeat(400)}${marker}\nOwner decision: keep the late requirement`;
    expect(prompt.length).toBeGreaterThan(VIEW_TEXT_CAP);
    expect(prompt.indexOf(marker)).toBeGreaterThan(VIEW_TEXT_CAP);
    const response = await receiveHook({
      tool: 'cursor',
      hook: 'beforeSubmitPrompt',
      stdin: JSON.stringify({
        conversation_id: 'conv-long',
        generation_id: 'gen-long',
        hook_event_name: 'beforeSubmitPrompt',
        prompt,
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at: '2026-10-28T11:00:00.000Z',
    });
    expect(response.exitCode).toBe(0);
    expect((await foldSpool(home)).ok).toBe(true);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    const journal = await readFile(join(paths.journalDir, '2026-10.md'), 'utf8');
    const stored = eventsIn(journal).find((item) => item.hook === 'beforeSubmitPrompt');
    expect(stored?.text.length).toBeGreaterThan(VIEW_TEXT_CAP);
    expect(stored?.text).toContain(marker);
    expect(stored?.text).toContain('keep the late requirement');
    expect(stored?.fields.ownerDecisions).toContain('keep the late requirement');
    const brain = await readFile(paths.brain, 'utf8');
    expect(brain).toContain('keep the late requirement');
    expect(brain).not.toContain(marker);
    const inbox = await readFile(
      join(paths.inboxDir, (await readdir(paths.inboxDir))[0] ?? ''),
      'utf8',
    );
    expect(inbox).toContain('keep the late requirement');
  });

  it('does not inbox an owner decision from an event the journal did not keep', async () => {
    const home = await tempDir('rizz-dropped-decision-');
    const project = await tempDir('rizz-dropped-decision-project-');
    const response = await receiveHook({
      tool: 'cursor',
      hook: 'afterAgentResponse',
      stdin: JSON.stringify({
        conversation_id: 'conv-drop-reply',
        generation_id: 'gen-drop-reply',
        hook_event_name: 'afterAgentResponse',
        text: 'Edited five files.',
        workspace_roots: [project],
      }),
      projectRoot: project,
      rizzHome: home,
      at: '2026-10-28T11:30:00.000Z',
    });
    expect(response.exitCode).toBe(0);
    const raw = (await readFile(spoolFile(home), 'utf8')).trim();
    const first = JSON.parse(raw) as ObserveEvent;
    const dropped: ObserveEvent = {
      ...first,
      text: 'Owner decision: Ship the dropped reply?',
      fields: {
        ...first.fields,
        ownerDecision: 'Ship the dropped reply?',
        ownerDecisions: JSON.stringify(['Ship the dropped reply?']),
      },
    };
    await writeFile(spoolFile(home), `${raw}\n${JSON.stringify(dropped)}\n`);
    const folded = await foldSpool(home);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(folded.value.applied).toBe(1);
    expect(folded.value.duplicates).toBe(1);
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const paths = observePaths(prepared.value.projectDir);
    const journal = await readFile(join(paths.journalDir, '2026-10.md'), 'utf8');
    expect(journal).toContain('Edited five files.');
    expect(journal).not.toContain('Ship the dropped reply?');
    const names = await readdir(paths.inboxDir).catch(() => [] as string[]);
    expect(names.filter((name) => name.endsWith('.md'))).toEqual([]);
  });
});

describe('observer regression fixtures', () => {
  const at = '2026-10-28T12:00:00.000Z';

  interface FixtureRow {
    readonly hook: string;
    readonly host: 'cursor' | 'codex' | 'claude';
    readonly payload: Record<string, unknown>;
  }

  function fixtureFile(name: string): string {
    return fileURLToPath(new URL(`./fixtures/${name}/events.jsonl`, import.meta.url));
  }

  async function readFixture(name: string): Promise<FixtureRow[]> {
    const raw = await readFile(fixtureFile(name), 'utf8');
    const rows: FixtureRow[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      const row = parsed as { hook?: unknown; host?: unknown; payload?: unknown };
      if (row.host !== 'cursor' && row.host !== 'codex' && row.host !== 'claude') continue;
      if (typeof row.hook !== 'string') continue;
      if (typeof row.payload !== 'object' || row.payload === null || Array.isArray(row.payload)) {
        continue;
      }
      rows.push({
        hook: row.hook,
        host: row.host,
        payload: row.payload as Record<string, unknown>,
      });
    }
    return rows;
  }

  async function play(home: string, project: string, rows: readonly FixtureRow[]): Promise<void> {
    for (const row of rows) {
      const response = await receiveHook({
        tool: row.host,
        hook: row.hook,
        stdin: JSON.stringify({ ...row.payload, workspace_roots: [project], cwd: project }),
        projectRoot: project,
        rizzHome: home,
        at,
      });
      expect(response.exitCode).toBe(0);
      expect(response.stderr).toBe('');
    }
  }

  async function observeOf(home: string, project: string) {
    const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    return observePaths(prepared.value.projectDir);
  }

  it('keeps the second subagent result and leaves the thread open', async () => {
    const home = await tempDir('rizz-s15-');
    const project = await tempDir('rizz-s15-project-');
    const rows = await readFixture('s15-subagents');
    await play(home, project, rows.slice(0, 5));
    expect((await foldSpool(home)).ok).toBe(true);
    const paths = await observeOf(home, project);
    const journal = await readFile(join(paths.journalDir, '2026-10.md'), 'utf8');
    const midway = eventsIn(journal);
    expect(midway).toHaveLength(5);
    const second = midway.find((item) => item.text.includes('Plan()'));
    expect(second?.kind).not.toBe('stop');
    expect(second?.files).toEqual(['cmd/clean.go', 'internal/walk/walk.go']);
    expect(second?.text).toContain('TODO: dry-run output is not sorted');
    expect(second?.text).toContain('exit 3 when it would delete something');
    const thread = await readFile(join(paths.threadsDir, 'cursor-s15-a.md'), 'utf8');
    expect(thread).toContain('status: active');
    const earlyHandoffs = await readdir(paths.handoffsDir).catch(() => [] as string[]);
    expect(earlyHandoffs.filter((name) => name.endsWith('.md'))).toEqual([]);
    const inbox = await readdir(paths.inboxDir);
    const inboxBody = await readFile(join(paths.inboxDir, inbox[0] ?? ''), 'utf8');
    expect(inboxBody).toContain('exit 3 when it would delete something');

    await play(home, project, rows.slice(5));
    expect((await foldSpool(home)).ok).toBe(true);
    const done = eventsIn(await readFile(join(paths.journalDir, '2026-10.md'), 'utf8'));
    expect(done).toHaveLength(rows.length);
    const handoffs = (await readdir(paths.handoffsDir)).filter((name) => name.endsWith('.md'));
    expect(handoffs).toHaveLength(1);
    const handoff = await readFile(join(paths.handoffsDir, handoffs[0] ?? ''), 'utf8');
    expect(handoff).toContain('cmd/clean.go');
    expect(handoff).toContain('internal/walk/walk.go');
    expect(handoff).toContain('README.md');
    const stopped = await readFile(join(paths.threadsDir, 'cursor-s15-a.md'), 'utf8');
    expect(stopped).toContain('status: completed');
  });

  it('keeps the later owner decision from s18 in the journal and the inbox', async () => {
    const home = await tempDir('rizz-s18-');
    const project = await tempDir('rizz-s18-project-');
    const rows = await readFixture('s18-owner-in-prompt');
    await play(home, project, rows);
    expect((await foldSpool(home)).ok).toBe(true);
    const paths = await observeOf(home, project);
    const journal = await readFile(join(paths.journalDir, '2026-10.md'), 'utf8');
    expect(eventsIn(journal)).toHaveLength(rows.length);
    expect(journal).toContain('use a local SQLite file for the cache');
    expect(journal).toContain('switch the cache to Redis instead of SQLite');
    const names = (await readdir(paths.inboxDir)).filter((name) => name.endsWith('.md'));
    const bodies = await Promise.all(
      names.map((name) => readFile(join(paths.inboxDir, name), 'utf8')),
    );
    const inbox = bodies.join('\n');
    expect(inbox).toContain('use a local SQLite file for the cache');
    expect(inbox).toContain('switch the cache to Redis instead of SQLite');
    expect(inbox).toContain('Key TTL 30 days');
  });

  it('keeps the tail of the long s19 spec in the journal', async () => {
    const home = await tempDir('rizz-s19-');
    const project = await tempDir('rizz-s19-project-');
    const rows = await readFixture('s19-multi-compaction');
    await play(home, project, rows);
    expect((await foldSpool(home)).ok).toBe(true);
    const paths = await observeOf(home, project);
    const events = eventsIn(await readFile(join(paths.journalDir, '2026-10.md'), 'utf8'));
    expect(events).toHaveLength(rows.length);
    const spec = events.find((item) => item.text.includes('harborlog'));
    expect(spec?.text.length).toBeGreaterThan(VIEW_TEXT_CAP);
    expect(spec?.text).toContain('buffer_retention_days');
    expect(spec?.text).toContain('refuse to start if the buffer directory is on a tmpfs');
  });

  it('keeps a unique id for every event in the 1k trace', async () => {
    const rows = await readFixture('s11-trace-1k');
    expect(rows).toHaveLength(996);
    let sequence = 0;
    const ids = rows.map((row) => {
      const id = observeEventId(row.hook, row.payload, at);
      if (!hasSharedTurnIdentity(row.payload)) return id;
      const stamped = `${id}:s${sequence}`;
      sequence += 1;
      return stamped;
    });
    expect(new Set(ids).size).toBe(rows.length);
    const home = await tempDir('rizz-s11-');
    const project = await tempDir('rizz-s11-project-');
    const sample = rows.slice(0, 40);
    await play(home, project, sample);
    const folded = await foldSpool(home);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(folded.value.duplicates).toBe(0);
    const paths = await observeOf(home, project);
    const journal = eventsIn(await readFile(join(paths.journalDir, '2026-10.md'), 'utf8'));
    expect(journal).toHaveLength(sample.length);
  });

  it.skipIf(process.env.RIZZ_FOLD_BENCH !== '1')(
    'folds the full 1k trace when RIZZ_FOLD_BENCH=1',
    async () => {
      const home = await tempDir('rizz-s11-bench-');
      const project = await tempDir('rizz-s11-bench-project-');
      const rows = await readFixture('s11-trace-1k');
      await play(home, project, rows);
      const started = Date.now();
      const folded = await foldSpool(home);
      const elapsed = Date.now() - started;
      expect(folded.ok).toBe(true);
      if (!folded.ok) return;
      expect(folded.value.duplicates).toBe(0);
      const paths = await observeOf(home, project);
      const journal = eventsIn(await readFile(join(paths.journalDir, '2026-10.md'), 'utf8'));
      expect(journal).toHaveLength(rows.length);
      expect(elapsed).toBeGreaterThan(0);
    },
    600_000,
  );
});

function contextFrom(tool: 'cursor' | 'codex' | 'claude', stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    additional_context?: string;
    additionalContext?: string;
    hookSpecificOutput?: { additionalContext?: string };
  };
  if (tool === 'cursor') return parsed.additional_context ?? '';
  if (tool === 'codex') return parsed.additionalContext ?? '';
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - started > 4000) throw new Error('timed out waiting for the killed writer');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
