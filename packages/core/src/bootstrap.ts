// Provider bootstrap (orchestration). Decides which credential to use and builds the active Provider
// before the loop runs. BYOK today: an Anthropic API key from the environment (explicit, ephemeral)
// or the OS keychain (persisted via `/login`). With no key it falls back to the demo StubProvider so
// the TUI still runs. It calls services (the keychain, the adapter factory) and returns data — it
// never mutates session/budget state (ADR-001).
//
// D-021 seam: when a subscription credential also exists, `planCredential` would prompt instead of
// silently spending on the metered key. The Pro/Max subscription path is not wired yet (BYOK only),
// so `hasSubscription` is false and there is nothing to disambiguate; the prompt branch activates
// automatically once subscription auth lands.

import {
  ANTHROPIC_ACCOUNT,
  CAPABILITIES,
  type Capability,
  DEFAULT_REGISTRY,
  type ModelInfo,
  type ModelRegistry,
  type Profile,
  type Provider,
  RIZZ_SERVICE,
  type SecretStore,
  StubProvider,
  createAnthropicProvider,
  getModel,
  loadRegistry,
  openSecretStore,
  resolveProfile,
  selectByCapability,
} from '@rizz/providers';

const isCapability = (value: string): value is Capability =>
  (CAPABILITIES as readonly string[]).includes(value);

export type AuthKind = 'api-key' | 'demo';

export interface ResolvedProvider {
  readonly provider: Provider;
  /** The active model (cost accounting / status bar). Undefined in demo mode. */
  readonly model?: ModelInfo;
  /** Subscription path → cost is always $0 (D-021). Demo mode reports as a subscription ($0). */
  readonly subscription: boolean;
  readonly auth: AuthKind;
  /** Surfaced to the user when something is worth saying (e.g. a keychain read failure). */
  readonly notice?: string;
}

export interface ResolveProviderOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Injected secret store (tests); defaults to the OS keychain with a file fallback. */
  readonly secrets?: SecretStore;
  /** Inject the registry directly (tests); otherwise it is loaded from ~/.rizz/models.json + built-ins. */
  readonly registry?: ModelRegistry;
  /** Inject the on-disk registry reader (tests). */
  readonly readRegistryFile?: (path: string) => string | null;
  /** Preferred model id (wins over `profile`); defaults to the registry's first entry. */
  readonly modelId?: string;
  /** Named profile (D-023) — resolved to a model id when no explicit modelId is given. */
  readonly profile?: string;
  /**
   * Opt-in capability route (D-023) — pick the best model for a capability when no modelId/profile is
   * given. Off by default; never the marketed default. One of: code | plan | cheap | long-context.
   */
  readonly capability?: string;
  /** Bias the capability route toward the cheapest capable model (D-021). */
  readonly preferCheap?: boolean;
  /** Pass-through to the adapter for tests. */
  readonly fetchImpl?: typeof fetch;
}

const ENV_KEY = 'ANTHROPIC_API_KEY';

function readEnvKey(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[ENV_KEY]?.trim();
  return raw !== undefined && raw !== '' ? raw : undefined;
}

/** Resolve the BYOK key + build the matching Provider, or fall back to the demo stub. */
export async function resolveProvider(
  options: ResolveProviderOptions = {},
): Promise<ResolvedProvider> {
  const env = options.env ?? process.env;

  // Registry: injected (tests) or loaded from ~/.rizz/models.json with a built-in fallback (D-023).
  let registry: ModelRegistry;
  let profiles: Readonly<Record<string, Profile>>;
  let notice: string | undefined;
  if (options.registry !== undefined) {
    registry = options.registry;
    profiles = {};
  } else {
    const loaded = loadRegistry(
      options.readRegistryFile ? { readFile: options.readRegistryFile } : {},
    );
    registry = loaded.registry;
    profiles = loaded.profiles;
    notice = loaded.notice;
  }

  // Resolve a profile name to a model id when no explicit modelId was given (modelId wins, D-023).
  let modelId = options.modelId;
  if (modelId === undefined && options.profile !== undefined) {
    const resolved = resolveProfile(registry, profiles, options.profile);
    if (resolved.ok) {
      modelId = resolved.value.model.id;
      // Anti-overclaim (§3.6): a profile's thinking/temperature knobs are recorded but NOT yet applied
      // to the model call (adapter support pending) — say so rather than let `deep` silently equal `default`.
      const { thinkingLevel, temperature } = resolved.value.profile;
      if (thinkingLevel !== undefined || temperature !== undefined) {
        notice = joinNotices(
          notice,
          `profile "${options.profile}" → ${resolved.value.model.label}; its thinking/temperature tuning isn't applied yet (adapter support pending)`,
        );
      }
    } else {
      notice = joinNotices(notice, resolved.error.message);
    }
  }

  // Opt-in capability route (D-023): only when neither modelId nor profile fixed a model. Off the
  // default path — a plain launch never enters this branch.
  if (modelId === undefined && options.capability !== undefined) {
    if (!isCapability(options.capability)) {
      notice = joinNotices(
        notice,
        `unknown capability "${options.capability}" — one of: ${CAPABILITIES.join(', ')}`,
      );
    } else {
      const route = selectByCapability({
        registry,
        request: {
          capability: options.capability,
          ...(options.preferCheap !== undefined ? { preferCheap: options.preferCheap } : {}),
        },
      });
      if (route.ok) {
        modelId = route.value.model.id;
        notice = joinNotices(
          notice,
          `capability "${options.capability}" → ${route.value.model.label}`,
        );
      } else {
        notice = joinNotices(notice, route.error.message);
      }
    }
  }

  const envKey = readEnvKey(env);
  let storedKey: string | undefined;

  // Only touch the keychain when the env var is absent — env is the explicit override and avoids a
  // keychain prompt on every launch.
  if (envKey === undefined) {
    const secrets = options.secrets ?? (await openSecretStore());
    const got = await secrets.get({ service: RIZZ_SERVICE, account: ANTHROPIC_ACCOUNT });
    if (got.ok) {
      storedKey = got.value ?? undefined;
    } else {
      notice = joinNotices(
        notice,
        `could not read the keychain (${got.error.code}) — continuing without a saved key`,
      );
    }
  }

  const apiKey = envKey ?? storedKey;
  if (apiKey === undefined) {
    return {
      provider: new StubProvider(),
      subscription: true,
      auth: 'demo',
      ...(notice ? { notice } : {}),
    };
  }
  return buildFromKey(apiKey, {
    registry,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(notice !== undefined ? { priorNotice: notice } : {}),
  });
}

interface BuildOptions {
  readonly registry: ModelRegistry;
  readonly modelId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly priorNotice?: string;
}

/** Build the live Anthropic provider from a key — shared by resolveProvider and loginWithApiKey. */
function buildFromKey(apiKey: string, opts: BuildOptions): ResolvedProvider {
  const { registry } = opts;
  const requested = opts.modelId ? getModel(registry, opts.modelId) : undefined;
  // A requested-but-unknown model must not be silently swapped — say so (latent-demands §6).
  let notice = opts.priorNotice;
  if (opts.modelId !== undefined && requested === undefined) {
    notice = joinNotices(
      notice,
      `model "${opts.modelId}" is not in the registry — using the default`,
    );
  }
  const model = requested ?? registry.models[0];
  if (model === undefined) {
    // An empty registry is a programmer error, but never crash the launch — degrade to demo.
    return {
      provider: new StubProvider(),
      subscription: true,
      auth: 'demo',
      notice: joinNotices(notice, 'no models are registered — running in demo mode'),
    };
  }
  const provider = createAnthropicProvider({
    apiKey,
    model: model.id,
    label: model.label,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return { provider, model, subscription: false, auth: 'api-key', ...(notice ? { notice } : {}) };
}

/**
 * Build a live provider directly from an in-memory key, without touching the keychain. Used to switch
 * models when the key is only held for the session (a failed `/login` persist), so a model switch never
 * silently downgrades a working session to demo.
 */
export function providerFromKey(apiKey: string, options: LoginOptions = {}): ResolvedProvider {
  return buildFromKey(apiKey, {
    registry: options.registry ?? DEFAULT_REGISTRY,
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

export interface LoginResult {
  readonly resolved: ResolvedProvider;
  /** False → the keychain write failed; the key works this session only. */
  readonly persisted: boolean;
}

export interface LoginOptions {
  readonly registry?: ModelRegistry;
  readonly modelId?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The `/login` flow: persist a freshly entered Anthropic key to the keychain, then build the live
 * provider FROM that key (not re-reading env). A failed persist still returns a working provider for
 * the session, with a notice — never a silent drop.
 */
export async function loginWithApiKey(
  secrets: SecretStore,
  apiKey: string,
  options: LoginOptions = {},
): Promise<LoginResult> {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const stored = await secrets.set({ service: RIZZ_SERVICE, account: ANTHROPIC_ACCOUNT }, apiKey);
  const persistNotice = stored.ok
    ? undefined
    : `key not saved to the keychain (${stored.error.code}) — it will work this session only`;
  const resolved = buildFromKey(apiKey, {
    registry,
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(persistNotice !== undefined ? { priorNotice: persistNotice } : {}),
  });
  return { resolved, persisted: stored.ok };
}

/** Combine two optional notices into one line so a single surface shows both. */
function joinNotices(a: string | undefined, b: string): string {
  return a !== undefined ? `${a}; ${b}` : b;
}
