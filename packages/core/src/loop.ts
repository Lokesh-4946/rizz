// One turn of the agent loop (orchestration): check interrupt + budget, call the model, record the
// reply. It classifies failures and owns user-facing errors; the model call itself is a service
// (@rizz/providers). At M2 there are no tools, so a turn is a single model pass. M3 turns this into
// the real loop — model-call → tool-dispatch → tool-result → repeat — bounded by budget + a backstop.

import {
  type CompletionRequest,
  type Provider,
  type Result,
  RizzError,
  err,
  ok,
} from '@rizz/providers';
import {
  type Budget,
  type BudgetState,
  DEFAULT_BUDGET,
  isExhausted,
  newBudgetState,
} from './budget.js';
import type { Session } from './session.js';

export interface RunTurnOptions {
  readonly provider: Provider;
  readonly session: Session;
  readonly input: string;
  readonly signal?: AbortSignal;
  readonly budget?: Budget;
  readonly budgetState?: BudgetState;
  /** Streaming hook — the TUI renders chunks as they arrive (faked at M2; real streaming in M3). */
  readonly onChunk?: (text: string) => void;
}

export interface TurnResult {
  readonly content: string;
  readonly budgetState: BudgetState;
}

export async function runTurn(options: RunTurnOptions): Promise<Result<TurnResult>> {
  const { provider, session, input, signal, onChunk } = options;
  const budget = options.budget ?? DEFAULT_BUDGET;
  const budgetState = options.budgetState ?? newBudgetState();

  // Guard before mutating the session: if the turn can't run (interrupted / over budget), the user
  // message must NOT land in history, or a retry would duplicate it and corrupt model context.
  if (signal?.aborted) {
    return err(new RizzError('INTERRUPTED', 'turn interrupted'));
  }
  if (isExhausted(budgetState, budget)) {
    const reached = `${budgetState.turns} turns, ${budgetState.tokens} tokens`;
    return err(new RizzError('BUDGET_EXCEEDED', `budget reached (${reached})`));
  }

  session.messages.push({ role: 'user', content: input });

  const request: CompletionRequest =
    signal === undefined ? { messages: session.messages } : { messages: session.messages, signal };
  const completion = await provider.complete(request);
  if (!completion.ok) {
    return completion;
  }

  const { content, inputTokens, outputTokens } = completion.value;
  session.messages.push({ role: 'assistant', content });
  budgetState.turns += 1;
  budgetState.tokens += inputTokens + outputTokens;
  onChunk?.(content);

  return ok({ content, budgetState });
}
