import { describe, expect, it } from 'vitest';
import { parseArgs, weakestCapability } from './uat-large-repos.mjs';

describe('large-repo UAT harness', () => {
  it('accepts the pnpm argument separator', () => {
    const options = parseArgs(['--', '--max-files', '120', '--timeout-ms', '90000']);

    expect(options.maxFiles).toBe(120);
    expect(options.timeoutMs).toBe(90_000);
  });

  it('handles a missing capability scorecard after a timed-out scan', () => {
    expect(weakestCapability(null)).toBeUndefined();
  });
});
