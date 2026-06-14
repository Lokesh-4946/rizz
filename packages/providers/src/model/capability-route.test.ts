import { describe, expect, it } from 'vitest';
import { selectByCapability } from './capability-route.js';
import type { ModelInfo, ModelRegistry } from './registry.js';

const model = (over: Partial<ModelInfo> & { id: string }): ModelInfo => ({
  provider: 'anthropic',
  label: over.id,
  capabilities: ['code'],
  contextWindow: 200_000,
  priceInputPerM: 3,
  priceOutputPerM: 15,
  latencyHint: 'medium',
  toolCapable: true,
  ...over,
});

const registry: ModelRegistry = {
  models: [
    model({
      id: 'opus',
      capabilities: ['code', 'plan', 'long-context'],
      priceInputPerM: 15,
      priceOutputPerM: 75,
      latencyHint: 'medium',
    }),
    model({
      id: 'sonnet',
      capabilities: ['code', 'plan'],
      priceInputPerM: 3,
      priceOutputPerM: 15,
      latencyHint: 'fast',
    }),
    model({
      id: 'haiku',
      capabilities: ['code', 'cheap'],
      priceInputPerM: 0.8,
      priceOutputPerM: 4,
      latencyHint: 'fast',
    }),
    model({ id: 'planner-no-tools', capabilities: ['plan'], toolCapable: false }),
  ],
};

describe('selectByCapability', () => {
  it('filters to tool-capable models that have the capability', () => {
    const r = selectByCapability({ registry, request: { capability: 'long-context' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.model.id).toBe('opus'); // the only long-context model
  });

  it('excludes non-tool-capable models even if they match the capability', () => {
    const r = selectByCapability({ registry, request: { capability: 'plan' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.model.id).not.toBe('planner-no-tools');
    expect([r.value.model, ...r.value.chain].some((m) => m.id === 'planner-no-tools')).toBe(false);
  });

  it('prefers the richer model by default, cheapest with preferCheap', () => {
    const rich = selectByCapability({ registry, request: { capability: 'code' } });
    const cheap = selectByCapability({
      registry,
      request: { capability: 'code', preferCheap: true },
    });
    expect(rich.ok && rich.value.model.id).toBe('opus'); // most capabilities
    expect(cheap.ok && cheap.value.model.id).toBe('haiku'); // lowest cost
  });

  it('returns the rest as an ordered fallback chain', () => {
    const r = selectByCapability({ registry, request: { capability: 'code', preferCheap: true } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.chain.map((m) => m.id)).toEqual(['sonnet', 'opus']); // after haiku, by cost
  });

  it('errors when no tool-capable model has the capability', () => {
    const r = selectByCapability({ registry, request: { capability: 'cheap' } });
    // haiku has 'cheap' → ok; use a registry without it to force the error.
    expect(r.ok).toBe(true);
    const empty = selectByCapability({
      registry: { models: [model({ id: 'x', capabilities: ['code'] })] },
      request: { capability: 'long-context' },
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.message).toContain('long-context');
  });

  it('honors a per-task override outright when configured + resolvable', () => {
    const r = selectByCapability({
      registry,
      request: { capability: 'code', taskTag: 'review' },
      policy: { defaultModel: 'opus', fallbackChain: [], perTask: { review: 'sonnet' } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reason).toBe('per-task');
    expect(r.value.model.id).toBe('sonnet');
  });

  it('falls through to capability scoring when a per-task override is not in the registry', () => {
    const r = selectByCapability({
      registry,
      request: { capability: 'code', taskTag: 'review' },
      policy: { defaultModel: 'opus', fallbackChain: [], perTask: { review: 'ghost' } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reason).toBe('capability');
  });

  it('uses a pluggable ScoreFn when provided (M5 eval hook)', () => {
    const r = selectByCapability({
      registry,
      request: { capability: 'code' },
      scoreFn: (m) => (m.id === 'haiku' ? 100 : 0), // force haiku to win
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.model.id).toBe('haiku');
  });
});
