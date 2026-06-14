import { type Result, RizzError, type SecretRef, type SecretStore, err, ok } from '@rizz/providers';
import { describe, expect, it } from 'vitest';
import { resolveProvider } from './bootstrap.js';

/** An in-memory secret store for tests. */
function fakeStore(stored?: string, opts?: { failGet?: boolean }): SecretStore {
  return {
    backend: 'file',
    async get(_ref: SecretRef): Promise<Result<string | null>> {
      if (opts?.failGet) return err(new RizzError('TOOL_IO', 'boom'));
      return ok(stored ?? null);
    },
    async set() {
      return ok(undefined);
    },
    async delete() {
      return ok(undefined);
    },
  };
}

describe('resolveProvider (BYOK)', () => {
  it('falls back to the demo stub when no key is present', async () => {
    const resolved = await resolveProvider({ env: {}, secrets: fakeStore() });
    expect(resolved.auth).toBe('demo');
    expect(resolved.subscription).toBe(true);
    expect(resolved.provider.id).toBe('stub');
    expect(resolved.model).toBeUndefined();
  });

  it('uses the env key and builds the Anthropic provider (metered)', async () => {
    const resolved = await resolveProvider({
      env: { ANTHROPIC_API_KEY: 'sk-ant-env' },
      secrets: fakeStore('sk-ant-stored'),
    });
    expect(resolved.auth).toBe('api-key');
    expect(resolved.subscription).toBe(false);
    expect(resolved.provider.id).toBe('anthropic');
    expect(resolved.model?.provider).toBe('anthropic');
  });

  it('uses a stored keychain key when no env var is set', async () => {
    const resolved = await resolveProvider({ env: {}, secrets: fakeStore('sk-ant-stored') });
    expect(resolved.auth).toBe('api-key');
    expect(resolved.provider.id).toBe('anthropic');
  });

  it('does not read the keychain when an env key is present', async () => {
    let touched = false;
    const store: SecretStore = {
      backend: 'file',
      async get() {
        touched = true;
        return ok(null);
      },
      async set() {
        return ok(undefined);
      },
      async delete() {
        return ok(undefined);
      },
    };
    await resolveProvider({ env: { ANTHROPIC_API_KEY: 'sk-ant-env' }, secrets: store });
    expect(touched).toBe(false);
  });

  it('surfaces a notice when the keychain read fails, and stays in demo mode', async () => {
    const resolved = await resolveProvider({
      env: {},
      secrets: fakeStore(undefined, { failGet: true }),
    });
    expect(resolved.auth).toBe('demo');
    expect(resolved.notice).toBeDefined();
  });

  it('honors a preferred modelId', async () => {
    const resolved = await resolveProvider({
      env: { ANTHROPIC_API_KEY: 'sk-ant-env' },
      secrets: fakeStore(),
      modelId: 'claude-haiku-4-5',
    });
    expect(resolved.model?.id).toBe('claude-haiku-4-5');
  });

  it('notices (does not silently swap) when a requested modelId is unknown', async () => {
    const resolved = await resolveProvider({
      env: { ANTHROPIC_API_KEY: 'sk-ant-env' },
      secrets: fakeStore(),
      modelId: 'nope-9000',
    });
    expect(resolved.model).toBeDefined();
    expect(resolved.notice).toContain('nope-9000');
  });
});
