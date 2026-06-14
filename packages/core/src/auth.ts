// Credential precedence (D-021, latent-demands §2 — the surprise-bill footgun). When BOTH a
// subscription and a metered API key are available, rizz must NOT silently spend on the key — it
// prompts the user. With only one available, it uses that one. The decision is a pure function so it
// is testable; the actual prompting is injected (the TUI/CLI supplies it).

export interface CredentialAvailability {
  readonly hasSubscription: boolean;
  /** A metered API key is present (e.g. ANTHROPIC_API_KEY in the environment). */
  readonly hasApiKey: boolean;
}

export type CredentialChoice = 'subscription' | 'api-key' | 'none';

export type CredentialPlan =
  | { readonly kind: 'use'; readonly choice: 'subscription' | 'api-key' }
  | { readonly kind: 'prompt'; readonly options: readonly ['subscription', 'api-key'] }
  | { readonly kind: 'none' };

/** Decide what to do given what is available. Pure — no I/O, no prompting. */
export function planCredential(available: CredentialAvailability): CredentialPlan {
  if (available.hasSubscription && available.hasApiKey) {
    // Anti-surprise-bill: never silently prefer the metered key — ask.
    return { kind: 'prompt', options: ['subscription', 'api-key'] };
  }
  if (available.hasSubscription) return { kind: 'use', choice: 'subscription' };
  if (available.hasApiKey) return { kind: 'use', choice: 'api-key' };
  return { kind: 'none' };
}

/**
 * Resolve the credential to use, prompting only when both are present. `prompt` is injected by the
 * caller (TUI/CLI); a headless caller can pass a prompt that defaults to 'subscription'.
 */
export async function resolveCredential(
  available: CredentialAvailability,
  prompt: (options: readonly ['subscription', 'api-key']) => Promise<'subscription' | 'api-key'>,
): Promise<CredentialChoice> {
  const plan = planCredential(available);
  switch (plan.kind) {
    case 'use':
      return plan.choice;
    case 'prompt':
      return prompt(plan.options);
    case 'none':
      return 'none';
  }
}
