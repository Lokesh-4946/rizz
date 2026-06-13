import {
  type CompletionResult,
  type Provider,
  type Result,
  RizzError,
  StubProvider,
  err,
} from '@rizz/providers';
import { describe, expect, it } from 'vitest';
import { runTurn } from './loop.js';
import { createSession } from './session.js';

describe('runTurn (the empty loop)', () => {
  it('appends user + assistant messages and returns the reply', async () => {
    const session = createSession();
    const result = await runTurn({ provider: new StubProvider(), session, input: 'hi there' });
    expect(result.ok).toBe(true);
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    if (result.ok) expect(result.value.content).toContain('hi there');
  });

  it('returns INTERRUPTED when the signal is aborted', async () => {
    const session = createSession();
    const result = await runTurn({
      provider: new StubProvider(),
      session,
      input: 'hi',
      signal: AbortSignal.abort(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERRUPTED');
  });

  it('returns BUDGET_EXCEEDED when the budget is exhausted', async () => {
    const session = createSession();
    const result = await runTurn({
      provider: new StubProvider(),
      session,
      input: 'hi',
      budget: { maxTurns: 0, maxTokens: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BUDGET_EXCEEDED');
  });

  it('propagates a provider failure unchanged', async () => {
    const failing: Provider = {
      id: 'failing',
      label: 'failing',
      async complete(): Promise<Result<CompletionResult>> {
        return err(new RizzError('PROVIDER_UNAVAILABLE', 'down'));
      },
    };
    const session = createSession();
    const result = await runTurn({ provider: failing, session, input: 'hi' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
  });
});
