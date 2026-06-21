// The /model picker's provider catalog (UI/UX spec §4, decision D-029). The full curated catalog is
// shown so the roadmap is honest, but only providers with a wired, verified adapter are selectable;
// the rest render dimmed with a "coming soon" label (text, not color-only — accessibility §10). At
// M3-finish only the first BYOK adapters are wired (D-002/D-033). This is display-only metadata —
// the selectable models themselves come from the model registry (@rizz/providers).

export type ProviderGroup = 'subscription' | 'api' | 'local';

export interface CatalogProvider {
  readonly id: string;
  readonly label: string;
  readonly group: ProviderGroup;
  readonly blurb: string;
  /** True once a verified adapter exists. Only wired providers are selectable. */
  readonly wired: boolean;
}

// Order matches the spec's panel: subscriptions, then API providers, then local.
export const PROVIDER_CATALOG: readonly CatalogProvider[] = [
  {
    id: 'anthropic-api',
    label: 'Anthropic',
    group: 'api',
    blurb: 'Claude — API key (BYOK)',
    wired: true,
  },
  {
    id: 'claude-sub',
    label: 'Claude',
    group: 'subscription',
    blurb: 'Claude Code · Pro · Max',
    wired: false,
  },
  { id: 'codex', label: 'Codex', group: 'subscription', blurb: 'ChatGPT Plus · Pro', wired: false },
  { id: 'copilot', label: 'Copilot', group: 'subscription', blurb: 'GitHub Copilot', wired: false },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'api',
    blurb: 'any model, one key',
    wired: true,
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    group: 'api',
    blurb: 'governed · AWS creds',
    wired: false,
  },
  { id: 'openai', label: 'OpenAI', group: 'api', blurb: 'direct API', wired: false },
  { id: 'google', label: 'Google', group: 'api', blurb: 'Gemini', wired: false },
  { id: 'ollama', label: 'Ollama', group: 'local', blurb: 'offline fallback', wired: false },
];
