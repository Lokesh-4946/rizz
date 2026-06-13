import { describe, expect, it } from 'vitest';
import { type Result, RizzError, err, ok } from './index.js';

describe('Result helpers', () => {
  it('ok() wraps a value', () => {
    const r: Result<number> = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err() wraps a RizzError with a stable code', () => {
    const r: Result<number> = err(new RizzError('PROVIDER_AUTH', 'not logged in'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('PROVIDER_AUTH');
      expect(r.error).toBeInstanceOf(RizzError);
    }
  });
});
