import { describe, expect, it } from 'vitest';
import { type TokenEncoder, approximateTokens, countTextTokens } from './tokenize.js';

const SAMPLE = 'hello world';

describe('countTextTokens', () => {
  it('counts with o200k_base when js-tiktoken loads', async () => {
    const counted = await countTextTokens(SAMPLE);
    expect(counted).toEqual({ count: 2, source: 'tiktoken-o200k' });
    expect(approximateTokens(SAMPLE)).toBe(3);
  });

  it('uses the 4-char approximation when the encoder fails to load', async () => {
    const counted = await countTextTokens(SAMPLE, async () => {
      throw new Error('cannot find package js-tiktoken');
    });
    expect(counted).toEqual({ count: approximateTokens(SAMPLE), source: 'approx' });
  });

  it('uses the approximation when the loaded module has no o200k encoder', async () => {
    const counted = await countTextTokens('abcd', async () => undefined);
    expect(counted).toEqual({ count: 1, source: 'approx' });
  });

  it('uses the approximation when encoding throws', async () => {
    const encoder: TokenEncoder = () => {
      throw new Error('disallowed special token');
    };
    const counted = await countTextTokens(SAMPLE, async () => encoder);
    expect(counted).toEqual({ count: approximateTokens(SAMPLE), source: 'approx' });
  });
});
