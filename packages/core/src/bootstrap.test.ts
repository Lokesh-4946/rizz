import {
  type ModelRegistry,
  type Result,
  RizzError,
  type SecretRef,
  type SecretStore,
  err,
  ok,
} from '@rizz/providers';
import { describe, expect, it } from 'vitest';
import { loginWithApiKey, providerFromKey, resolveProvider } from './bootstrap.js';

/** A secret store that records the last set() and can be made to fail the write. */
function recordingStore(opts?: { failSet?: boolean }): {
  store: SecretStore;
  saved: () => string | undefined;
} {
  let savedKey: string | undefined;
  const store: SecretStore = {
    backend: 'file',
    async get() {
      return ok(savedKey ?? null);
    },
    async set(_ref: SecretRef, secret: string): Promise<Result<void>> {
      if (opts?.failSet) return err(new RizzError('TOOL_IO', 'no disk'));
      savedKey = secret;
      return ok(undefined);
    },
    async delete() {
      return ok(undefined);
    },
  };
  return { store, saved: () => savedKey };
}

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

describe('loginWithApiKey (/login)', () => {
  it('persists the entered key and builds the live provider from it', async () => {
    const { store, saved } = recordingStore();
    const { resolved, persisted } = await loginWithApiKey(store, 'sk-ant-fresh');
    expect(persisted).toBe(true);
    expect(saved()).toBe('sk-ant-fresh');
    expect(resolved.auth).toBe('api-key');
    expect(resolved.subscription).toBe(false);
    expect(resolved.provider.id).toBe('anthropic');
  });

  it('still returns a working provider (session-only) when the keychain write fails', async () => {
    const { store } = recordingStore({ failSet: true });
    const { resolved, persisted } = await loginWithApiKey(store, 'sk-ant-fresh');
    expect(persisted).toBe(false);
    expect(resolved.auth).toBe('api-key');
    expect(resolved.notice).toContain('this session only');
  });
});

describe('providerFromKey (model switch without the keychain)', () => {
  it('builds a live provider for the requested model from an in-memory key', () => {
    const resolved = providerFromKey('sk-ant-mem', { modelId: 'claude-haiku-4-5' });
    expect(resolved.auth).toBe('api-key');
    expect(resolved.provider.id).toBe('anthropic');
    expect(resolved.model?.id).toBe('claude-haiku-4-5');
  });
});

describe('resolveProvider — profiles + on-disk registry (D-023)', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-env' };
  const noFile = () => null;

  it('resolves a profile name to its model (built-in registry)', async () => {
    const resolved = await resolveProvider({ env, readRegistryFile: noFile, profile: 'cheap' });
    expect(resolved.model?.id).toBe('claude-haiku-4-5');
  });

  it('an explicit modelId wins over a profile', async () => {
    const resolved = await resolveProvider({
      env,
      readRegistryFile: noFile,
      profile: 'cheap',
      modelId: 'claude-opus-4-8',
    });
    expect(resolved.model?.id).toBe('claude-opus-4-8');
  });

  it('notices (does not crash) when a profile references an unconfigured model', async () => {
    const resolved = await resolveProvider({ env, readRegistryFile: noFile, profile: 'local' });
    expect(resolved.model).toBeDefined(); // fell back to the registry default
    expect(resolved.notice).toContain('ollama');
  });

  it('loads a custom on-disk registry when present', async () => {
    const file = JSON.stringify({
      models: [
        {
          id: 'custom-1',
          provider: 'custom',
          label: 'Custom',
          capabilities: ['code'],
          contextWindow: 1000,
          priceInputPerM: 1,
          priceOutputPerM: 2,
          latencyHint: 'fast',
          toolCapable: true,
        },
      ],
    });
    // A custom-provider model resolves its key from its own env var (CUSTOM_API_KEY), per the
    // `<PROVIDER>_API_KEY` convention (D-044).
    const resolved = await resolveProvider({
      env: { ...env, CUSTOM_API_KEY: 'sk-custom' },
      secrets: fakeStore(),
      readRegistryFile: () => file,
      modelId: 'custom-1',
    });
    expect(resolved.model?.id).toBe('custom-1');
    expect(resolved.model?.provider).toBe('custom');
  });

  it('surfaces the registry notice when the on-disk file is secret-bearing', async () => {
    const file = JSON.stringify({ models: [{ id: 'x', apiKey: 'sk-LEAK' }] });
    const resolved = await resolveProvider({ env, readRegistryFile: () => file });
    expect(resolved.notice).toContain('secret-bearing');
  });
});

describe('resolveProvider — opt-in capability route (D-023)', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-env' };
  const noFile = () => null;

  it('routes a capability to the best model + surfaces the choice', async () => {
    const resolved = await resolveProvider({
      env,
      readRegistryFile: noFile,
      capability: 'long-context',
    });
    expect(resolved.model?.id).toBe('claude-opus-4-8'); // only long-context model
    expect(resolved.notice).toContain('capability "long-context"');
  });

  it('preferCheap biases toward the cheapest capable model', async () => {
    // With the OpenAI models in the built-in registry, gpt-4o-mini is the cheapest 'code' model
    // (it undercuts Haiku) — the ranker follows price, not provider (D-044).
    const resolved = await resolveProvider({
      env: { ...env, OPENAI_API_KEY: 'sk-oai' },
      readRegistryFile: noFile,
      capability: 'code',
      preferCheap: true,
    });
    expect(resolved.model?.id).toBe('gpt-4o-mini');
  });

  it('modelId and profile both win over capability', async () => {
    const byModel = await resolveProvider({
      env,
      readRegistryFile: noFile,
      capability: 'cheap',
      modelId: 'claude-opus-4-8',
    });
    expect(byModel.model?.id).toBe('claude-opus-4-8');
    const byProfile = await resolveProvider({
      env,
      readRegistryFile: noFile,
      capability: 'cheap',
      profile: 'fast',
    });
    expect(byProfile.model?.id).toBe('claude-sonnet-4-6');
  });

  it('notices an unknown capability instead of routing', async () => {
    const resolved = await resolveProvider({
      env,
      readRegistryFile: noFile,
      capability: 'telepathy',
    });
    expect(resolved.notice).toContain('unknown capability');
  });
});

describe('resolveProvider — provider-factory selection by model.provider (D-044)', () => {
  /** A fetch stub recording the request URL + Authorization header; returns a minimal OK body. */
  function recordingFetch(): {
    fetchImpl: typeof fetch;
    url: () => string;
    auth: () => string | undefined;
  } {
    let url = '';
    let auth: string | undefined;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      url = String(input);
      auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, url: () => url, auth: () => auth };
  }

  const registryWith = (model: ModelRegistry['models'][number]): ModelRegistry => ({
    models: [model],
  });
  const base = {
    label: 'm',
    capabilities: ['code'] as const,
    contextWindow: 8000,
    priceInputPerM: 1,
    priceOutputPerM: 1,
    latencyHint: 'fast' as const,
    toolCapable: true,
  };

  it('builds the OpenAI adapter for an openai model + OPENAI_API_KEY (hits /chat/completions)', async () => {
    const rec = recordingFetch();
    const resolved = await resolveProvider({
      env: { OPENAI_API_KEY: 'sk-oai' },
      secrets: fakeStore(),
      registry: registryWith({ id: 'gpt-4o', provider: 'openai', ...base }),
      fetchImpl: rec.fetchImpl,
    });
    expect(resolved.auth).toBe('api-key');
    expect(resolved.provider.id).toBe('openai');
    await resolved.provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(rec.url()).toBe('https://api.openai.com/v1/chat/completions');
    expect(rec.auth()).toBe('Bearer sk-oai');
  });

  it('reads the provider-specific env var and base URL for an openrouter model', async () => {
    const rec = recordingFetch();
    const resolved = await resolveProvider({
      env: { OPENROUTER_API_KEY: 'sk-or' },
      secrets: fakeStore(),
      registry: registryWith({
        id: 'meta-llama/llama-3.1-8b-instruct',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        ...base,
      }),
      fetchImpl: rec.fetchImpl,
    });
    await resolved.provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(rec.url()).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(rec.auth()).toBe('Bearer sk-or');
  });

  it('connects a keyless local endpoint (Ollama) with no key and no Authorization header', async () => {
    const rec = recordingFetch();
    const resolved = await resolveProvider({
      env: {}, // no key anywhere
      secrets: fakeStore(),
      registry: registryWith({
        id: 'llama3.1',
        provider: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        keyless: true,
        ...base,
      }),
      fetchImpl: rec.fetchImpl,
    });
    expect(resolved.auth).toBe('api-key'); // a live connection, not demo
    expect(resolved.provider.id).toBe('openai'); // the OpenAI-compatible adapter serves Ollama
    await resolved.provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(rec.url()).toBe('http://localhost:11434/v1/chat/completions');
    expect(rec.auth()).toBeUndefined();
  });

  it('still selects the Anthropic adapter for an anthropic model', async () => {
    const rec = recordingFetch();
    const resolved = await resolveProvider({
      env: { ANTHROPIC_API_KEY: 'sk-ant' },
      secrets: fakeStore(),
      registry: registryWith({ id: 'claude-opus-4-8', provider: 'anthropic', ...base }),
      fetchImpl: rec.fetchImpl,
    });
    expect(resolved.provider.id).toBe('anthropic');
    await resolved.provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(rec.url()).toContain('/v1/messages');
  });
});
