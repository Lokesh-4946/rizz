import { describe, expect, it } from 'vitest';
import { loadRegistry } from './registry-store.js';
import type { ModelInfo } from './registry.js';

const VALID_MODEL: ModelInfo = {
  id: 'custom-1',
  provider: 'custom',
  label: 'Custom One',
  capabilities: ['code'],
  contextWindow: 128_000,
  priceInputPerM: 1,
  priceOutputPerM: 2,
  latencyHint: 'fast',
  toolCapable: true,
};

const reader = (content: string | null) => () => content;

describe('loadRegistry', () => {
  it('falls back to the built-in registry when the file is absent', () => {
    const loaded = loadRegistry({ readFile: reader(null) });
    expect(loaded.source).toBe('builtin');
    expect(loaded.registry.models.length).toBeGreaterThan(0);
    expect(loaded.profiles.default).toBeDefined();
    expect(loaded.notice).toBeUndefined();
  });

  it('loads a valid file registry and merges file profiles over the built-ins', () => {
    const file = JSON.stringify({
      version: 1,
      models: [VALID_MODEL],
      profiles: { mine: { name: 'mine', model: 'custom-1', description: 'my pick' } },
    });
    const loaded = loadRegistry({ readFile: reader(file) });
    expect(loaded.source).toBe('file');
    expect(loaded.registry.models).toEqual([VALID_MODEL]);
    expect(loaded.profiles.mine?.model).toBe('custom-1');
    expect(loaded.profiles.default).toBeDefined(); // built-ins still present
  });

  it('rejects a secret-bearing file (secrets-free invariant) with a notice', () => {
    const file = JSON.stringify({ models: [{ ...VALID_MODEL, apiKey: 'sk-ant-LEAK' }] });
    const loaded = loadRegistry({ readFile: reader(file) });
    expect(loaded.source).toBe('builtin');
    expect(loaded.notice).toContain('secret-bearing');
  });

  it('rejects invalid JSON with a notice', () => {
    const loaded = loadRegistry({ readFile: reader('{ not json') });
    expect(loaded.source).toBe('builtin');
    expect(loaded.notice).toContain('not valid JSON');
  });

  it('rejects a file whose models are malformed', () => {
    const file = JSON.stringify({ models: [{ id: 'x' }] }); // missing required fields
    const loaded = loadRegistry({ readFile: reader(file) });
    expect(loaded.source).toBe('builtin');
    expect(loaded.notice).toContain('no valid "models"');
  });
});
