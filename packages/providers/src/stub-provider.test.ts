import { describe, expect, it } from 'vitest';
import { StubProvider } from './stub-provider.js';

describe('StubProvider', () => {
  it('returns an ok result echoing the last user message', async () => {
    const provider = new StubProvider();
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hello rizz' }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toContain('hello rizz');
      expect(result.value.outputTokens).toBeGreaterThan(0);
    }
  });

  it('returns INTERRUPTED when the signal is already aborted', async () => {
    const provider = new StubProvider();
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      signal: AbortSignal.abort(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERRUPTED');
  });
});
