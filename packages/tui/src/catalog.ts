// The /model picker's provider catalog (UI/UX spec §4, decision D-029). The full curated catalog is
// shown so the route surface is honest, but only providers with a wired, verified adapter are selectable;
// the rest render dimmed with a "not connected" label (text, not color-only — accessibility §10). At
// M3-finish only the first BYOK adapters are wired (D-002/D-033). This is display-only metadata —
// the selectable models themselves come from the model registry (@valoir/rizz-providers).

/** @internal */
export interface CatalogProvider {
  readonly id: string;
  readonly label: string;
  readonly wired: boolean;
}

// Order matches the spec's panel: subscriptions, then API providers, then local.
/** @internal */
export const PROVIDER_CATALOG: readonly CatalogProvider[] = [
  {
    id: 'anthropic-api',
    label: 'Anthropic',
    wired: true,
  },
  {
    id: 'claude-sub',
    label: 'Claude',
    wired: false,
  },
  { id: 'codex', label: 'Codex', wired: false },
  { id: 'copilot', label: 'Copilot', wired: false },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    wired: true,
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    wired: false,
  },
  { id: 'openai', label: 'OpenAI', wired: false },
  { id: 'google', label: 'Google', wired: false },
  { id: 'ollama', label: 'Ollama', wired: false },
];
