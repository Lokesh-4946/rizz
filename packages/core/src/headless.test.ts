import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type Result,
  RizzError,
  err,
  ok,
} from '@valoir/rizz-providers';
import { describe, expect, it } from 'vitest';
import { createRpcServer, runJsonTurn } from './headless.js';

/** A provider that returns scripted completions in order (then a trailing empty final answer). */
function scripted(replies: readonly CompletionResult[]): Provider {
  let i = 0;
  return {
    id: 'scripted',
    label: 'scripted',
    async complete(req: CompletionRequest): Promise<Result<CompletionResult>> {
      if (req.signal?.aborted) return err(new RizzError('INTERRUPTED', 'aborted'));
      const reply = replies[i] ?? { content: '', inputTokens: 0, outputTokens: 0 };
      i += 1;
      if (req.onChunk !== undefined && reply.content !== '') req.onChunk(reply.content);
      return ok(reply);
    },
  };
}

/** A provider that always fails with a given code (drives the error contract). */
function failing(code: RizzError['code']): Provider {
  return {
    id: 'failing',
    label: 'failing',
    async complete(): Promise<Result<CompletionResult>> {
      return err(new RizzError(code, `boom ${code}`));
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('runJsonTurn (one-shot JSON contract)', () => {
  it('returns reply + usage + costUsd on success', async () => {
    const provider = scripted([{ content: 'hello there', inputTokens: 10, outputTokens: 4 }]);
    const result = await runJsonTurn({
      resolved: { provider, subscription: true },
      input: 'hi',
      cwd: process.cwd(),
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('hello there');
    expect(result.usage?.tokens).toBe(14);
    expect(result.costUsd).toBe(0); // subscription/demo path
    expect(result.stopReason).toBe('final');
  });

  it('reports a failure as a stable RizzError code, never throwing', async () => {
    const result = await runJsonTurn({
      resolved: { provider: failing('PROVIDER_AUTH'), subscription: false },
      input: 'hi',
      cwd: process.cwd(),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PROVIDER_AUTH');
  });

  it('denies a destructive bash (no approval channel) and records the tool call', async () => {
    const provider = scripted([
      {
        content: '',
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [{ id: 't1', name: 'bash', args: { command: 'rm -rf build' } }],
      },
      { content: 'done', inputTokens: 1, outputTokens: 1 },
    ]);
    const result = await runJsonTurn({
      resolved: { provider, subscription: true },
      input: 'clean',
      cwd: process.cwd(),
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('done');
    expect(result.toolCalls?.some((t) => t.display.includes('denied'))).toBe(true);
  });
});

/** Collect emitted RPC lines (parsed) into an array. */
function capture(): { write: (line: string) => void; messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = [];
  return {
    write: (line) => {
      for (const part of line.split('\n')) {
        if (part.trim() !== '') messages.push(JSON.parse(part));
      }
    },
    messages,
  };
}

describe('createRpcServer (stdio JSON protocol)', () => {
  it('starts a session, runs a turn, streams events, and responds', async () => {
    const provider = scripted([{ content: 'hi back', inputTokens: 3, outputTokens: 2 }]);
    const { write, messages } = capture();
    const server = createRpcServer({
      resolved: { provider, subscription: true },
      cwd: process.cwd(),
      write,
    });

    await server.handle(JSON.stringify({ id: 1, method: 'session.start' }));
    await server.handle(JSON.stringify({ id: 2, method: 'turn', params: { input: 'hi' } }));
    await tick();

    const startResp = messages.find((m) => m.id === 1);
    expect(startResp?.result).toBeDefined();
    const events = messages.filter((m) => m.method === 'event');
    expect(events.some((e) => (e.params as { type?: string }).type === 'assistant')).toBe(true);
    const turnResp = messages.find((m) => m.id === 2) as
      | { result?: { reply?: string } }
      | undefined;
    expect(turnResp?.result?.reply).toBe('hi back');
  });

  it('processes requests in arrival order even when fired without awaiting', async () => {
    const provider = scripted([{ content: 'ok', inputTokens: 1, outputTokens: 1 }]);
    const { write, messages } = capture();
    const server = createRpcServer({
      resolved: { provider, subscription: true },
      cwd: process.cwd(),
      write,
    });
    // Fire start + turn back-to-back without awaiting start (the readline 'line' pattern).
    void server.handle(JSON.stringify({ id: 1, method: 'session.start' }));
    await server.handle(JSON.stringify({ id: 2, method: 'turn', params: { input: 'hi' } }));
    await tick();
    const turnResp = messages.find((m) => m.id === 2) as
      | { result?: { reply?: string }; error?: unknown }
      | undefined;
    expect(turnResp?.error).toBeUndefined();
    expect(turnResp?.result?.reply).toBe('ok');
  });

  it('rejects a turn before a session is started', async () => {
    const { write, messages } = capture();
    const server = createRpcServer({
      resolved: { provider: scripted([]), subscription: true },
      cwd: process.cwd(),
      write,
    });
    await server.handle(JSON.stringify({ id: 9, method: 'turn', params: { input: 'hi' } }));
    const resp = messages.find((m) => m.id === 9) as { error?: { code?: string } } | undefined;
    expect(resp?.error?.code).toBe('BAD_REQUEST');
  });

  it('surfaces the bash approval as an event the caller answers (deny path — nothing runs)', async () => {
    const provider = scripted([
      {
        content: '',
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [{ id: 't1', name: 'bash', args: { command: 'rm -rf build' } }],
      },
      { content: 'ok, skipped it', inputTokens: 1, outputTokens: 1 },
    ]);
    const { write, messages } = capture();
    const server = createRpcServer({
      resolved: { provider, subscription: true },
      cwd: process.cwd(),
      write,
    });

    await server.handle(JSON.stringify({ id: 1, method: 'session.start' }));
    await server.handle(JSON.stringify({ id: 2, method: 'turn', params: { input: 'clean' } }));
    await tick();

    const approval = messages.find((m) => m.method === 'approval') as
      | { params?: { requestId?: string; command?: string; kind?: string } }
      | undefined;
    expect(approval?.params?.kind).toBe('destructive');
    expect(approval?.params?.command).toBe('rm -rf build');
    const requestId = approval?.params?.requestId;
    expect(typeof requestId).toBe('string');

    // Deny it — the command must never execute.
    await server.handle(
      JSON.stringify({ id: 3, method: 'approve', params: { requestId, approved: false } }),
    );
    await tick();

    const turnResp = messages.find((m) => m.id === 2) as
      | { result?: { reply?: string } }
      | undefined;
    expect(turnResp?.result?.reply).toBe('ok, skipped it');
    const denied = messages.find(
      (m) => m.method === 'event' && (m.params as { type?: string }).type === 'approval-denied',
    );
    expect(denied).toBeDefined();
  });

  it('errors on malformed JSON and unknown methods', async () => {
    const { write, messages } = capture();
    const server = createRpcServer({
      resolved: { provider: scripted([]), subscription: true },
      cwd: process.cwd(),
      write,
    });
    await server.handle('{ not json');
    await server.handle(JSON.stringify({ id: 5, method: 'frobnicate' }));
    expect(
      messages.some((m) => (m.error as { code?: string } | undefined)?.code === 'BAD_REQUEST'),
    ).toBe(true);
    expect(messages.find((m) => m.id === 5)).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });
});
