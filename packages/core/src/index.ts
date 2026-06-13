// @rizz/core — the orchestration layer (the "why/when": the agent loop, budget, compression,
// fallback, interrupt, failure classification). Owns state and user-facing errors; calls the
// service layer (@rizz/providers) for mechanics. See CLAUDE.md §Architecture.

import type { Result } from '@rizz/providers';

export const VERSION = '0.0.0';

export type { Result };
export { type Session, createSession } from './session.js';
export {
  type Budget,
  type BudgetState,
  DEFAULT_BUDGET,
  newBudgetState,
  isExhausted,
} from './budget.js';
export { type RunTurnOptions, type TurnResult, runTurn } from './loop.js';
