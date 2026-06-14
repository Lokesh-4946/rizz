import { type Message, ok } from '@rizz/providers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPRESS, maybeCompress, shouldCompress } from './compress.js';

function bigConvo(approxTokens: number): Message[] {
  // ~4 chars/token; build a single long message to cross the threshold deterministically.
  return [{ role: 'user', content: 'x'.repeat(approxTokens * 4) }];
}

describe('shouldCompress (70% trigger, configurable — D-019)', () => {
  it('is false below the trigger ratio', () => {
    const cfg = { ...DEFAULT_COMPRESS, contextWindow: 1000, triggerRatio: 0.7 };
    expect(shouldCompress(bigConvo(100), cfg)).toBe(false);
  });
  it('is true at/above the trigger ratio', () => {
    const cfg = { ...DEFAULT_COMPRESS, contextWindow: 1000, triggerRatio: 0.7 };
    expect(shouldCompress(bigConvo(800), cfg)).toBe(true);
  });
  it('honors a custom (lower) configured ratio', () => {
    const cfg = { ...DEFAULT_COMPRESS, contextWindow: 1000, triggerRatio: 0.3 };
    expect(shouldCompress(bigConvo(400), cfg)).toBe(true);
  });
});

describe('maybeCompress', () => {
  it('is a no-op below threshold (does not call the summarizer)', async () => {
    let called = false;
    const cfg = { ...DEFAULT_COMPRESS, contextWindow: 1000 };
    const result = await maybeCompress(bigConvo(10), cfg, async () => {
      called = true;
      return ok('nope');
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.note).toBeUndefined();
    expect(called).toBe(false);
  });

  it('compacts and returns a visible note when over threshold', async () => {
    const cfg = {
      contextWindow: 1000,
      triggerRatio: 0.3,
      keepHead: 0,
      keepTail: 0,
    };
    const messages: Message[] = [
      { role: 'user', content: 'a'.repeat(2000) },
      { role: 'assistant', content: 'b'.repeat(2000) },
    ];
    const result = await maybeCompress(messages, cfg, async () => ok('summary'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.note).toContain('compacted context');
      expect(result.value.messages.some((m) => m.content.includes('summary'))).toBe(true);
    }
  });
});
