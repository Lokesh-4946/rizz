import {
  DEFAULT_POLICY,
  DEFAULT_REGISTRY,
  type Provider,
  RizzError,
  err,
  getModel,
} from '@rizz/providers';
import { describe, expect, it } from 'vitest';
import { classifyFailure, runFallback } from './fallback.js';

// Not invoked by runFallback (pure routing) — just a placeholder the factory hands back.
const fakeProvider: Provider = {
  id: 'fake',
  label: 'fake',
  async complete() {
    return err(new RizzError('UNKNOWN', 'unused'));
  },
};

describe('classifyFailure (design §5)', () => {
  it('routes rate-limit and unavailable to fallback', () => {
    expect(classifyFailure('PROVIDER_RATE_LIMIT')).toBe('fallback');
    expect(classifyFailure('PROVIDER_UNAVAILABLE')).toBe('fallback');
  });
  it('repairs a bad tool call', () => {
    expect(classifyFailure('BAD_TOOL_CALL')).toBe('repair');
  });
  it('stops on budget exceeded', () => {
    expect(classifyFailure('BUDGET_EXCEEDED')).toBe('stop');
  });
  it('surfaces auth and unexpected errors', () => {
    expect(classifyFailure('PROVIDER_AUTH')).toBe('surface');
    expect(classifyFailure('UNKNOWN')).toBe('surface');
  });
});

describe('runFallback', () => {
  const routing = {
    registry: DEFAULT_REGISTRY,
    policy: DEFAULT_POLICY,
    providerFor: () => fakeProvider,
  };

  it('returns the next model with a visible note', () => {
    const r = runFallback(routing, { modelId: 'claude-opus-4-8', code: 'PROVIDER_RATE_LIMIT' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.model.id).toBe('claude-sonnet-4-6');
      expect(r.value.note).toContain('falling back to');
    }
  });

  it('errors when the chain is exhausted', () => {
    const last = getModel(DEFAULT_REGISTRY, 'claude-haiku-4-5');
    expect(last).toBeDefined();
    const r = runFallback(routing, { modelId: 'claude-haiku-4-5', code: 'PROVIDER_UNAVAILABLE' });
    expect(r.ok).toBe(false);
  });
});
