import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareProjectStore } from '../project-store.js';
import { BRAIN_LINE_CAP, renderBrain, snapshotFromEvents } from './brain-index.js';
import { detectHosts } from './cli.js';
import { readCodexRollout } from './codex-session.js';
import { checkDrift } from './drift.js';
import { foldSpool } from './fold.js';
import { parseHandoffBlock } from './handoff.js';
import { installCursorHooks } from './install.js';
import { appendJournalEvent, eventsIn } from './journal.js';
import { normalizeHook } from './model.js';
import { observePaths } from './paths.js';
import { receiveHook } from './receive.js';
import { startObserveServer } from './serve.js';

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
    expect(parsed.hooks.stop.map((entry) => entry.command)).toContain('rizz hook cursor stop');
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
