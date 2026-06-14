// Cost/usage guardrail (brief §3.6 — "no surprise bills"). The orchestration layer checks the
// budget before each model call (pre-flight) and accounts after each call. M3 adds a COST dimension
// alongside turns/tokens: on a subscription cost stays 0 (status bar shows "$0.00 (sub)"); a metered
// (BYOK) run accrues real USD and the hard cap is honored — the kill-switch incumbents lack.

export interface Budget {
  readonly maxTurns: number;
  readonly maxTokens: number;
  /** Hard USD cap. Defaults to Infinity (no cap) — relevant only on the metered/BYOK path. */
  readonly maxCostUsd: number;
}

export interface BudgetState {
  turns: number;
  tokens: number;
  costUsd: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxTurns: 50,
  maxTokens: 200_000,
  maxCostUsd: Number.POSITIVE_INFINITY,
};

export const newBudgetState = (): BudgetState => ({ turns: 0, tokens: 0, costUsd: 0 });

export const isExhausted = (state: BudgetState, budget: Budget): boolean =>
  state.turns >= budget.maxTurns ||
  state.tokens >= budget.maxTokens ||
  state.costUsd >= budget.maxCostUsd;

/** Mutate the running state with one call's usage. The loop owns the state; this is its accountant. */
export function recordUsage(
  state: BudgetState,
  usage: { inputTokens: number; outputTokens: number; costUsd: number },
): void {
  state.turns += 1;
  state.tokens += usage.inputTokens + usage.outputTokens;
  state.costUsd += usage.costUsd;
}

/** A short, always-visible budget summary for the status bar / `/cost`. */
export function describeBudget(state: BudgetState, subscription: boolean): string {
  const cost = subscription ? '$0.00 (sub)' : `$${state.costUsd.toFixed(2)}`;
  return `${state.tokens} tok · ${cost}`;
}
