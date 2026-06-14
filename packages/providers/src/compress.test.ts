import { describe, expect, it } from 'vitest';
import { compressContext } from './compress.js';
import type { Message } from './provider.js';
import { ok } from './result.js';

function convo(n: number): Message[] {
  const messages: Message[] = [{ role: 'system', content: 'you are rizz' }];
  for (let i = 0; i < n; i += 1) {
    messages.push({ role: 'user', content: `user message ${i} with some length to it` });
    messages.push({ role: 'assistant', content: `assistant reply ${i} with some length to it` });
  }
  return messages;
}

describe('compressContext (protect head & tail)', () => {
  it('keeps head + tail verbatim and replaces the middle with one summary', async () => {
    const messages = convo(10); // 21 messages
    const result = await compressContext({
      messages,
      keepHead: 2,
      keepTail: 4,
      targetTokens: 100,
      summarize: async () => ok('middle summary'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.value.messages;
      // head (2) + 1 summary + tail (4) = 7
      expect(out).toHaveLength(7);
      expect(out.slice(0, 2)).toEqual(messages.slice(0, 2));
      expect(out.slice(-4)).toEqual(messages.slice(-4));
      expect(out[2]?.content).toContain('middle summary');
      expect(result.value.droppedSummary).toBe('middle summary');
      expect(result.value.tokensSaved).toBeGreaterThan(0);
    }
  });

  it('is a no-op when head + tail already cover everything', async () => {
    const messages = convo(1); // 3 messages
    let called = false;
    const result = await compressContext({
      messages,
      keepHead: 2,
      keepTail: 4,
      targetTokens: 100,
      summarize: async () => {
        called = true;
        return ok('should not run');
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages).toBe(messages);
      expect(result.value.tokensSaved).toBe(0);
    }
    expect(called).toBe(false);
  });

  it('propagates a summarizer failure as the service result', async () => {
    const { err, RizzError } = await import('./result.js');
    const result = await compressContext({
      messages: convo(10),
      keepHead: 1,
      keepTail: 1,
      targetTokens: 100,
      summarize: async () => err(new RizzError('PROVIDER_UNAVAILABLE', 'down')),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
  });
});
