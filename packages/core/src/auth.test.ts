import { describe, expect, it } from 'vitest';
import { planCredential, resolveCredential } from './auth.js';

describe('planCredential (D-021 anti-surprise-bill)', () => {
  it('prompts when BOTH a subscription and an API key are present', () => {
    expect(planCredential({ hasSubscription: true, hasApiKey: true })).toEqual({
      kind: 'prompt',
      options: ['subscription', 'api-key'],
    });
  });
  it('uses the subscription when only it is present', () => {
    expect(planCredential({ hasSubscription: true, hasApiKey: false })).toEqual({
      kind: 'use',
      choice: 'subscription',
    });
  });
  it('uses the api key when only it is present', () => {
    expect(planCredential({ hasSubscription: false, hasApiKey: true })).toEqual({
      kind: 'use',
      choice: 'api-key',
    });
  });
  it('reports none when neither is present', () => {
    expect(planCredential({ hasSubscription: false, hasApiKey: false })).toEqual({ kind: 'none' });
  });
});

describe('resolveCredential', () => {
  it('never prompts when only one credential exists', async () => {
    let prompted = false;
    const choice = await resolveCredential(
      { hasSubscription: true, hasApiKey: false },
      async () => {
        prompted = true;
        return 'api-key';
      },
    );
    expect(choice).toBe('subscription');
    expect(prompted).toBe(false);
  });

  it('prompts and honors the user choice when both exist', async () => {
    const choice = await resolveCredential(
      { hasSubscription: true, hasApiKey: true },
      async () => 'subscription',
    );
    expect(choice).toBe('subscription');
  });
});
