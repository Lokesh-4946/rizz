// Local-first model registry (ADR-002 Tier 1). A small, curated, static list of tool-capable models
// with the metadata the budget cost dimension and the `/model` picker need. M3 ships it static —
// NO network dependency (lightweight constraint); generation from models.dev/OpenRouter is a Tier-2
// deferral (ADR-002 §9). Tier-2 capability/cost/latency routing is NOT built here (deferred).
//
// Prices are a curated USD-per-1M-token snapshot and WILL drift — they exist to power the cost
// dimension for BYOK/metered use. On the Claude subscription path the cost is always $0 (D-021,
// status bar shows "$0.00 (sub)"), so registry prices are not consulted there.

// Single source of truth: the runtime list and the `Capability` type derive from one array, so a new
// capability is added in exactly one place (no hand-maintained copies to drift).
export const CAPABILITIES = ['code', 'plan', 'cheap', 'long-context'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface ModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly capabilities: readonly Capability[];
  readonly contextWindow: number;
  /** USD per 1,000,000 input tokens (curated snapshot; subject to drift). */
  readonly priceInputPerM: number;
  /** USD per 1,000,000 output tokens (curated snapshot; subject to drift). */
  readonly priceOutputPerM: number;
  readonly latencyHint: 'fast' | 'medium' | 'slow';
  readonly toolCapable: boolean;
  /**
   * OpenAI-compatible base URL for non-default endpoints (OpenRouter / Ollama / custom). Omitted →
   * the provider's default (Anthropic, or OpenAI's api.openai.com). Carried so a single OpenAI-shaped
   * adapter can serve many endpoints by config (D-002 provider-agnostic).
   */
  readonly baseUrl?: string;
  /**
   * A local/keyless endpoint (e.g. Ollama) needs no BYOK key — bootstrap connects it without reading
   * env/keychain (D-044). Omitted → keyed (the default for hosted providers).
   */
  readonly keyless?: boolean;
}

export interface ModelRegistry {
  readonly models: readonly ModelInfo[];
}

// Curated snapshot — the current Claude family (D-002: default provider = Claude subscription).
// Order is the natural default → fallback order, but the active routing order is set by RoutingPolicy.
export const DEFAULT_REGISTRY: ModelRegistry = {
  models: [
    {
      id: 'claude-opus-4-8',
      provider: 'anthropic',
      label: 'Claude Opus 4.8',
      capabilities: ['code', 'plan', 'long-context'],
      contextWindow: 200_000,
      priceInputPerM: 15,
      priceOutputPerM: 75,
      latencyHint: 'medium',
      toolCapable: true,
    },
    {
      id: 'claude-sonnet-4-6',
      provider: 'anthropic',
      label: 'Claude Sonnet 4.6',
      capabilities: ['code', 'plan'],
      contextWindow: 200_000,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      latencyHint: 'fast',
      toolCapable: true,
    },
    {
      id: 'claude-haiku-4-5',
      provider: 'anthropic',
      label: 'Claude Haiku 4.5',
      capabilities: ['code', 'cheap'],
      contextWindow: 200_000,
      priceInputPerM: 0.8,
      priceOutputPerM: 4,
      latencyHint: 'fast',
      toolCapable: true,
    },
    // OpenAI (BYOK over the OpenAI-compatible adapter). Default endpoint; prices are a curated snapshot.
    {
      id: 'gpt-4o',
      provider: 'openai',
      label: 'GPT-4o',
      capabilities: ['code', 'plan'],
      contextWindow: 128_000,
      priceInputPerM: 2.5,
      priceOutputPerM: 10,
      latencyHint: 'fast',
      toolCapable: true,
    },
    {
      id: 'gpt-4o-mini',
      provider: 'openai',
      label: 'GPT-4o mini',
      capabilities: ['code', 'cheap'],
      contextWindow: 128_000,
      priceInputPerM: 0.15,
      priceOutputPerM: 0.6,
      latencyHint: 'fast',
      toolCapable: true,
    },
  ],
};

export function getModel(registry: ModelRegistry, id: string): ModelInfo | undefined {
  return registry.models.find((m) => m.id === id);
}

export function listToolCapable(registry: ModelRegistry): readonly ModelInfo[] {
  return registry.models.filter((m) => m.toolCapable);
}

/**
 * Cost in USD of a single call. `subscription` short-circuits to 0 (the subscription path never
 * bills per token — D-021). Pure: callers pass the model + usage in; nothing reads ambient state.
 */
export function estimateCostUsd(
  model: ModelInfo,
  usage: { inputTokens: number; outputTokens: number },
  options: { subscription: boolean },
): number {
  if (options.subscription) return 0;
  const input = (usage.inputTokens / 1_000_000) * model.priceInputPerM;
  const output = (usage.outputTokens / 1_000_000) * model.priceOutputPerM;
  return input + output;
}
