import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY, estimateCostUsd, getModel } from './registry.js';
import { DEFAULT_POLICY, resolveModelRoute } from './route.js';

describe('resolveModelRoute (Tier 1: default + ordered fallback)', () => {
  it('returns the default model when nothing failed', () => {
    const r = resolveModelRoute({ registry: DEFAULT_REGISTRY, policy: DEFAULT_POLICY });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.model.id).toBe('claude-opus-4-8');
      expect(r.value.reason).toBe('default');
      expect(r.value.note).toBeUndefined();
    }
  });

  it('falls back to the next model with a visible note on a retryable failure', () => {
    const r = resolveModelRoute({
      registry: DEFAULT_REGISTRY,
      policy: DEFAULT_POLICY,
      failed: { modelId: 'claude-opus-4-8', code: 'PROVIDER_RATE_LIMIT' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.model.id).toBe('claude-sonnet-4-6');
      expect(r.value.reason).toBe('fallback');
      expect(r.value.note).toContain('falling back to');
      expect(r.value.note).toContain('PROVIDER_RATE_LIMIT');
    }
  });

  it('walks the chain in order on successive failures', () => {
    const r = resolveModelRoute({
      registry: DEFAULT_REGISTRY,
      policy: DEFAULT_POLICY,
      failed: { modelId: 'claude-sonnet-4-6', code: 'PROVIDER_UNAVAILABLE' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model.id).toBe('claude-haiku-4-5');
  });

  it('errors PROVIDER_UNAVAILABLE when the chain is exhausted', () => {
    const r = resolveModelRoute({
      registry: DEFAULT_REGISTRY,
      policy: DEFAULT_POLICY,
      failed: { modelId: 'claude-haiku-4-5', code: 'PROVIDER_UNAVAILABLE' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('errors when the default model is not in the registry', () => {
    const r = resolveModelRoute({
      registry: DEFAULT_REGISTRY,
      policy: { defaultModel: 'ghost-model', fallbackChain: [] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN');
  });
});

describe('estimateCostUsd', () => {
  it('is always 0 on the subscription path', () => {
    const opus = getModel(DEFAULT_REGISTRY, 'claude-opus-4-8');
    expect(opus).toBeDefined();
    if (opus) {
      const cost = estimateCostUsd(
        opus,
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        {
          subscription: true,
        },
      );
      expect(cost).toBe(0);
    }
  });

  it('prices metered (BYOK) usage from the registry', () => {
    const opus = getModel(DEFAULT_REGISTRY, 'claude-opus-4-8');
    if (opus) {
      const cost = estimateCostUsd(
        opus,
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        {
          subscription: false,
        },
      );
      expect(cost).toBe(opus.priceInputPerM + opus.priceOutputPerM);
    }
  });
});
