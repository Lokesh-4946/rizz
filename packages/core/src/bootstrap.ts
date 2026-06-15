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
  createOpenAiProvider,
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

const ANTHROPIC_PROVIDER = 'anthropic';

/**
 * The env var holding a provider's BYOK key, by convention `<PROVIDER>_API_KEY` — so the same rule
 * covers ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, and any custom provider id (D-044).
 * The env var is the explicit, ephemeral override; the keychain (account = provider id) is the
 * persisted fallback.
 */
function envVarFor(provider: string): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

function readEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw !== undefined && raw !== '' ? raw : undefined;
}

/** Pick the active model: an explicit id (with a notice if it is unknown) else the registry default. */
function selectModel(
  registry: ModelRegistry,
  modelId: string | undefined,
): { model?: ModelInfo; notice?: string } {
  const requested = modelId !== undefined ? getModel(registry, modelId) : undefined;
  const fallback = registry.models[0];
  // A requested-but-unknown model must not be silently swapped — say so (latent-demands §6).
  if (modelId !== undefined && requested === undefined) {
    return {
      ...(fallback ? { model: fallback } : {}),
      notice: `model "${modelId}" is not in the registry — using the default`,
    };
  }
  const model = requested ?? fallback;
  return model ? { model } : {};
}

/**
 * The provider-factory (D-044): select the adapter by `model.provider`. Anthropic is native; every
 * other provider (openai / openrouter / ollama / a custom base URL) speaks the OpenAI-compatible wire,
 * differing only by `baseUrl`. The loop is unchanged — it drives whichever Provider this returns.
 */
function createProviderFor(model: ModelInfo, apiKey: string, fetchImpl?: typeof fetch): Provider {
  if (model.provider === ANTHROPIC_PROVIDER) {
    return createAnthropicProvider({
      apiKey,
      model: model.id,
      label: model.label,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  return createOpenAiProvider({
    apiKey,
    model: model.id,
    label: model.label,
    ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

interface Credential {
  /** The resolved key, `''` for a keyless local endpoint, or undefined when none is available. */
  readonly apiKey?: string;
  readonly notice?: string;
}

/** Resolve the BYOK key for a model's provider: keyless → none needed; else env override → keychain. */
async function resolveCredential(
  model: ModelInfo,
  env: NodeJS.ProcessEnv,
  injected?: SecretStore,
): Promise<Credential> {
  if (model.keyless === true) return { apiKey: '' };
  const envKey = readEnvKey(env, envVarFor(model.provider));
  if (envKey !== undefined) return { apiKey: envKey };
  // Only touch the keychain when the env var is absent — avoids a keychain prompt on every launch.
  const secrets = injected ?? (await openSecretStore());
  const got = await secrets.get({ service: RIZZ_SERVICE, account: model.provider });
  if (!got.ok) {
    return {
      notice: `could not read the keychain (${got.error.code}) — continuing without a saved key`,
    };
  }
  return got.value !== null ? { apiKey: got.value } : {};
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

  // Select the active model BEFORE resolving a credential — the model's provider decides which key
  // to read (D-044). An empty registry is a programmer error, but never crash the launch.
  const selected = selectModel(registry, modelId);
  if (selected.notice !== undefined) notice = joinNotices(notice, selected.notice);
  const model = selected.model;
  if (model === undefined) {
    return {
      provider: new StubProvider(),
      subscription: true,
      auth: 'demo',
      notice: joinNotices(notice, 'no models are registered — running in demo mode'),
    };
  }

  // Resolve the BYOK credential for this model's provider (keyless local endpoints need none).
  const credential = await resolveCredential(model, env, options.secrets);
  if (credential.notice !== undefined) notice = joinNotices(notice, credential.notice);
  if (credential.apiKey === undefined) {
    return {
      provider: new StubProvider(),
      subscription: true,
      auth: 'demo',
      ...(notice ? { notice } : {}),
    };
  }

  const provider = createProviderFor(model, credential.apiKey, options.fetchImpl);
  return { provider, model, subscription: false, auth: 'api-key', ...(notice ? { notice } : {}) };
}

interface BuildOptions {
  readonly registry: ModelRegistry;
  readonly modelId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly priorNotice?: string;
}

/**
 * Build a live provider from an in-memory key — shared by resolveProvider's siblings and loginWithApiKey.
 * Selects the adapter by the resolved model's provider (D-044), so a `/model` switch to an OpenAI-
 * compatible model builds that adapter rather than always Anthropic.
 */
function buildFromKey(apiKey: string, opts: BuildOptions): ResolvedProvider {
  const selected = selectModel(opts.registry, opts.modelId);
  const notice =
    selected.notice !== undefined
      ? joinNotices(opts.priorNotice, selected.notice)
      : opts.priorNotice;
  const model = selected.model;
  if (model === undefined) {
    // An empty registry is a programmer error, but never crash the launch — degrade to demo.
    return {
      provider: new StubProvider(),
      subscription: true,
      auth: 'demo',
      notice: joinNotices(notice, 'no models are registered — running in demo mode'),
    };
  }
  const provider = createProviderFor(model, apiKey, opts.fetchImpl);
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
