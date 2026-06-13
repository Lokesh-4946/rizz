// Cost/usage guardrail (brief §3.6 — "no surprise bills"). The orchestration layer checks the
// budget before each model call and surfaces BUDGET_EXCEEDED. Values are stubs at M2; real
// per-provider token+cost accounting arrives with the provider adapters (M3).

export interface Budget {
  readonly maxTurns: number;
  readonly maxTokens: number;
}

export interface BudgetState {
  turns: number;
  tokens: number;
}

export const DEFAULT_BUDGET: Budget = { maxTurns: 50, maxTokens: 200_000 };

export const newBudgetState = (): BudgetState => ({ turns: 0, tokens: 0 });

export const isExhausted = (state: BudgetState, budget: Budget): boolean =>
  state.turns >= budget.maxTurns || state.tokens >= budget.maxTokens;
