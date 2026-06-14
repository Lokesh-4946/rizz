import { describe, expect, it } from 'vitest';
import { BUILTIN_PROFILES, PROFILE_NAMES, resolveProfile } from './profiles.js';
import { DEFAULT_REGISTRY } from './registry.js';

describe('built-in profiles', () => {
  it('ships the five D-023 names', () => {
    expect(PROFILE_NAMES).toEqual(['default', 'deep', 'fast', 'cheap', 'local']);
  });

  it('maps the wired profiles to registry model ids', () => {
    expect(resolveProfile(DEFAULT_REGISTRY, BUILTIN_PROFILES, 'cheap')).toMatchObject({
      ok: true,
      value: { model: { id: 'claude-haiku-4-5' } },
    });
    expect(resolveProfile(DEFAULT_REGISTRY, BUILTIN_PROFILES, 'deep')).toMatchObject({
      ok: true,
      value: { profile: { thinkingLevel: 'high' }, model: { id: 'claude-opus-4-8' } },
    });
  });

  it('errors clearly for an unknown profile', () => {
    const r = resolveProfile(DEFAULT_REGISTRY, BUILTIN_PROFILES, 'nope');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('no profile "nope"');
  });

  it('errors when a profile references a model absent from the registry (e.g. local/ollama)', () => {
    const r = resolveProfile(DEFAULT_REGISTRY, BUILTIN_PROFILES, 'local');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('ollama');
  });
});
