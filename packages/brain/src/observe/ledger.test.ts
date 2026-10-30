import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendTokenRow,
  readTokenRows,
  renderTokenReport,
  rowFromEvent,
  summarizeTokens,
} from './ledger.js';
import type { ObserveEvent } from './model.js';
import { countTextTokens } from './tokenize.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(
  overrides: Partial<ObserveEvent> & Pick<ObserveEvent, 'kind' | 'text' | 'fields'>,
): ObserveEvent {
  return {
    id: 'event-1',
    at: '2026-10-30T00:00:00.000Z',
    tool: 'cursor',
    hook: 'stop',
    threadId: 'cursor-conv-1',
    projectRoot: '/tmp/project',
    files: [],
    ...overrides,
  };
}

describe('rowFromEvent', () => {
  it('keeps host-reported counts and does not call the tokenizer', async () => {
    const row = await rowFromEvent(
      event({
        kind: 'stop',
        text: 'Added the route.',
        fields: { inputTokens: '18', outputTokens: '4', reported: 'yes', cacheRead: '3' },
      }),
      async () => {
        throw new Error('tokenizer should not run when the host reported counts');
      },
    );
    expect(row).toMatchObject({
      input: 18,
      output: 4,
      cacheRead: 3,
      reported: true,
      source: 'host',
    });
  });

  it('fills a missing stop count from the tokenizer and marks the source', async () => {
    const text = 'Added the route.';
    const row = await rowFromEvent(
      event({ kind: 'stop', text, fields: { status: 'completed' } }),
      async (value) => ({ count: value.length, source: 'tiktoken-o200k' }),
    );
    expect(row).toMatchObject({
      input: 0,
      output: text.length,
      reported: false,
      source: 'tiktoken-o200k',
    });
  });

  it('counts missing stop text with o200k_base when the package loads', async () => {
    const text = 'Added the route and ran npm test.';
    const counted = await countTextTokens(text);
    const row = await rowFromEvent(event({ kind: 'stop', text, fields: { status: 'completed' } }));
    expect(counted.source).toBe('tiktoken-o200k');
    expect(row).toMatchObject({ output: counted.count, input: 0, source: 'tiktoken-o200k' });
  });

  it('marks an approximation when the tokenizer cannot load', async () => {
    const text = 'Added the route.';
    const row = await rowFromEvent(event({ kind: 'stop', text, fields: {} }), async () => ({
      count: Math.ceil(text.length / 4),
      source: 'approx',
    }));
    expect(row).toMatchObject({
      output: Math.ceil(text.length / 4),
      source: 'approx',
      reported: false,
    });
  });

  it('skips events that are not usage or stop', async () => {
    const row = await rowFromEvent(
      event({
        kind: 'prompt',
        text: 'Owner decision: Keep it?',
        hook: 'beforeSubmitPrompt',
        fields: {},
      }),
    );
    expect(row).toBeUndefined();
  });
});

describe('token ledger report', () => {
  it('splits host counts from estimated counts', () => {
    const report = renderTokenReport(
      summarizeTokens([
        {
          ts: '2026-10-30T00:00:00.000Z',
          tool: 'codex',
          thread: 'codex-thread-z',
          run: 'token_count',
          input: 18,
          output: 4,
          cacheRead: 3,
          cacheWrite: 0,
          context: 0,
          reported: true,
          source: 'host',
          eventId: 'host-1',
        },
        {
          ts: '2026-10-30T00:00:01.000Z',
          tool: 'cursor',
          thread: 'cursor-conv-1',
          run: 'completed',
          input: 0,
          output: 6,
          cacheRead: 0,
          cacheWrite: 0,
          context: 1800,
          reported: false,
          source: 'tiktoken-o200k',
          eventId: 'est-1',
        },
      ]),
    );
    expect(report).toContain('reported: 18 in / 4 out');
    expect(report).toContain('tiktoken-o200k: 0 in / 6 out');
    expect(report).toContain('approx: 0 in / 0 out');
    expect(report).toContain('context: 1800');
  });

  it('treats a legacy row without a source as host or approx', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rizz-ledger-'));
    roots.push(dir);
    const path = join(dir, 'tokens.jsonl');
    await appendTokenRow(path, {
      ts: '2026-10-30T00:00:00.000Z',
      tool: 'cursor',
      thread: 'cursor-conv-1',
      run: 'completed',
      input: 2,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      context: 0,
      reported: true,
      source: 'host',
      eventId: 'kept',
    });
    const legacy = `${JSON.stringify({
      ts: '2026-10-30T00:00:01.000Z',
      tool: 'cursor',
      thread: 'cursor-conv-1',
      run: 'completed',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      context: 0,
      reported: false,
      eventId: 'legacy',
    })}\n`;
    await writeFile(path, `${await readFile(path, 'utf8')}${legacy}`);
    const rows = await readTokenRows(path);
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    expect(rows.value.map((row) => row.source)).toEqual(['host', 'approx']);
  });
});
