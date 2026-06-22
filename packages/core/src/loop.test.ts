import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CompletionRequest,
  type CompletionResult,
  DEFAULT_POLICY,
  DEFAULT_REGISTRY,
  type Provider,
  type Result,
  RizzError,
  StubProvider,
  err,
  getModel,
  ok,
  openSessionStore,
} from '@rizz/providers';
import { describe, expect, it } from 'vitest';
import { type TurnEvent, runTurn } from './loop.js';
import { createSession } from './session.js';

/** A provider that replays a scripted list of results, one per `complete` call. */
function scripted(replies: readonly Result<CompletionResult>[], id = 'scripted'): Provider {
  let i = 0;
  return {
    id,
    label: id,
    async complete(_request: CompletionRequest): Promise<Result<CompletionResult>> {
      const reply = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return reply ?? err(new RizzError('UNKNOWN', 'no scripted reply'));
    },
  };
}

const final = (content: string): Result<CompletionResult> =>
  ok({ content, inputTokens: 5, outputTokens: 5 });

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rizz-loop-'));
}

describe('runTurn — agentic loop', () => {
  it('returns a final answer with no tools (stopReason final)', async () => {
    const session = createSession();
    const result = await runTurn({
      provider: scripted([final('all done')]),
      session,
      input: 'hi',
      cwd: process.cwd(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('all done');
      expect(result.value.stopReason).toBe('final');
    }
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('dispatches a tool call, feeds the result back, then finishes', async () => {
    const cwd = await tmpDir();
    const provider = scripted([
      ok({
        content: 'writing the file',
        inputTokens: 5,
        outputTokens: 5,
        toolCalls: [{ id: 't1', name: 'write', args: { path: 'out.txt', content: 'hello' } }],
      }),
      final('wrote it'),
    ]);
    const events: TurnEvent[] = [];
    const result = await runTurn({
      provider,
      session: createSession(),
      input: 'write a file',
      cwd,
      onEvent: (e) => events.push(e),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe('wrote it');
    expect(await readFile(join(cwd, 'out.txt'), 'utf8')).toBe('hello');
    expect(events.some((e) => e.type === 'tool' && e.ok)).toBe(true);
  });

  it('records the assistant tool-use turn (with toolCalls) before the tool result', async () => {
    // Pure tool-use turn: empty content but a tool call. The assistant message must still be
    // recorded with its toolCalls, or the following tool result is an orphan for real providers.
    const provider = scripted([
      ok({
        content: '',
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [{ id: 't1', name: 'bash', args: { command: 'echo hi' } }],
      }),
      final('done'),
    ]);
    const session = createSession();
    await runTurn({ provider, session, input: 'run it', cwd: process.cwd() });
    const assistantToolUse = session.messages.find(
      (m) => m.role === 'assistant' && m.toolCalls !== undefined,
    );
    expect(assistantToolUse?.toolCalls?.[0]?.name).toBe('bash');
    // The tool result comes after the assistant tool-use, never before it.
    const assistantIdx = session.messages.indexOf(assistantToolUse as never);
    const toolIdx = session.messages.findIndex((m) => m.role === 'tool');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThan(assistantIdx);
  });

  it('feeds a tool failure back to the model rather than crashing', async () => {
    const provider = scripted([
      ok({
        content: '',
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [
          { id: 't1', name: 'edit', args: { path: '/no/such/file', oldText: 'a', newText: 'b' } },
        ],
      }),
      final('recovered'),
    ]);
    const session = createSession();
    const result = await runTurn({ provider, session, input: 'edit', cwd: process.cwd() });
    expect(result.ok).toBe(true);
    const toolMessage = session.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('failed');
  });

  it('preserves the M2 invariant: aborted before start → INTERRUPTED, no mutation', async () => {
    const session = createSession();
    const result = await runTurn({
      provider: new StubProvider(),
      session,
      input: 'hi',
      cwd: process.cwd(),
      signal: AbortSignal.abort(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERRUPTED');
    expect(session.messages).toHaveLength(0);
  });

  it('returns BUDGET_EXCEEDED when the budget is exhausted', async () => {
    const result = await runTurn({
      provider: scripted([final('x')]),
      session: createSession(),
      input: 'hi',
      cwd: process.cwd(),
      budget: { maxTurns: 0, maxTokens: 0, maxCostUsd: Number.POSITIVE_INFINITY },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BUDGET_EXCEEDED');
  });

  it('falls back to the next model on a rate-limit, visibly', async () => {
    const rateLimited = scripted([err(new RizzError('PROVIDER_RATE_LIMIT', '429'))], 'opus');
    const healthy = scripted([final('answer from fallback')], 'sonnet');
    const opus = getModel(DEFAULT_REGISTRY, 'claude-opus-4-8');
    if (opus === undefined) throw new Error('fixture: opus missing from registry');
    const events: TurnEvent[] = [];
    const result = await runTurn({
      provider: rateLimited,
      session: createSession(),
      input: 'hi',
      cwd: process.cwd(),
      model: opus,
      routing: {
        registry: DEFAULT_REGISTRY,
        policy: DEFAULT_POLICY,
        providerFor: () => healthy,
      },
      onEvent: (e) => events.push(e),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe('answer from fallback');
    expect(events.some((e) => e.type === 'fallback')).toBe(true);
  });

  it('surfaces PROVIDER_AUTH (turn preserved, not lost)', async () => {
    const session = createSession();
    const result = await runTurn({
      provider: scripted([err(new RizzError('PROVIDER_AUTH', 'expired'))]),
      session,
      input: 'hi',
      cwd: process.cwd(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROVIDER_AUTH');
    // The user message stays in the session — /login then retry, never silently dropped.
    expect(session.messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('stops at the iteration backstop on a runaway tool loop', async () => {
    // Always asks for a (read-only) tool → never terminates on its own.
    const provider = scripted([
      ok({
        content: 'again',
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [{ id: 't', name: 'bash', args: { command: 'echo loop' } }],
      }),
    ]);
    const result = await runTurn({
      provider,
      session: createSession(),
      input: 'go',
      cwd: process.cwd(),
      iterationBackstop: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stopReason).toBe('backstop');
  });

  it('persists each message to the session store so a later load resumes the full turn', async () => {
    const dir = await tmpDir();
    const store = await openSessionStore({ dir });
    const created = await store.create({ model: 'm', branch: 'dev' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.value;

    const result = await runTurn({
      provider: scripted([final('persisted answer')]),
      session: createSession(),
      input: 'remember this',
      cwd: process.cwd(),
      store,
      sessionId,
    });
    expect(result.ok).toBe(true);

    const loaded = await store.load(sessionId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.messages.map((m) => m.content)).toEqual([
        'remember this',
        'persisted answer',
      ]);
    }
  });

  it('denies a destructive command when approval is refused', async () => {
    const provider = scripted([
      ok({
        content: '',
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [{ id: 't', name: 'bash', args: { command: 'rm -rf /tmp/nope' } }],
      }),
      final('ok, skipped'),
    ]);
    const events: TurnEvent[] = [];
    const result = await runTurn({
      provider,
      session: createSession(),
      input: 'delete things',
      cwd: process.cwd(),
      onApprovalNeeded: async () => ({ approved: false }),
      onEvent: (e) => events.push(e),
    });
    expect(result.ok).toBe(true);
    expect(events.some((e) => e.type === 'approval-denied')).toBe(true);
  });

  it('emits a compacting event before the compacted note', async () => {
    const session = createSession();
    session.messages.push({ role: 'user', content: 'a'.repeat(2000) });
    const events: TurnEvent[] = [];
    const result = await runTurn({
      provider: scripted([final('summary'), final('done')]),
      session,
      input: 'continue',
      cwd: process.cwd(),
      compress: { contextWindow: 100, triggerRatio: 0.01, keepHead: 1, keepTail: 1 },
      onEvent: (e) => events.push(e),
    });

    expect(result.ok).toBe(true);
    const compactingIndex = events.findIndex((e) => e.type === 'compacting');
    const compactedIndex = events.findIndex((e) => e.type === 'compacted');
    expect(compactingIndex).toBeGreaterThanOrEqual(0);
    expect(compactedIndex).toBeGreaterThan(compactingIndex);
    expect(events.some((e) => e.type === 'compacted')).toBe(true);
  });
});
