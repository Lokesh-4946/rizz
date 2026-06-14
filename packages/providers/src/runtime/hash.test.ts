import { describe, expect, it } from 'vitest';
import { contentHash } from './hash.js';

describe('contentHash (FNV-1a anchor)', () => {
  it('is deterministic and 16 hex chars', () => {
    const h = contentHash('hello world');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash('hello world')).toBe(h);
  });

  it('changes when a single byte changes', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
    expect(contentHash('line\n')).not.toBe(contentHash('line\r\n'));
  });

  it('distinguishes empty from non-empty', () => {
    expect(contentHash('')).not.toBe(contentHash(' '));
  });
});
