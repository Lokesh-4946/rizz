// @rizz/core — the orchestration layer (the "why/when": the agent loop, budget, compression,
// fallback, interrupt, failure classification). Owns state and user-facing errors; calls the
// service layer (@rizz/providers) for mechanics. See CLAUDE.md §Architecture.

import type { Result } from '@rizz/providers';

export const VERSION = '0.0.0';

export type { Result };
export { type Session, createSession } from './session.js';
export {
  type AuthKind,
  type LoginOptions,
  type LoginResult,
  type ResolveProviderOptions,
  type ResolvedProvider,
  loginWithApiKey,
  providerFromKey,
  resolveProvider,
} from './bootstrap.js';
export {
  type Budget,
  type BudgetState,
  DEFAULT_BUDGET,
  newBudgetState,
  isExhausted,
  recordUsage,
  describeBudget,
} from './budget.js';
export {
  type CompressConfig,
  type MaybeCompressResult,
  DEFAULT_COMPRESS,
  maybeCompress,
  shouldCompress,
} from './compress.js';
export {
  type FailureAction,
  type FallbackResult,
  type ProviderFor,
  type RoutingContext,
  classifyFailure,
  runFallback,
} from './fallback.js';
export {
  type CredentialAvailability,
  type CredentialChoice,
  type CredentialPlan,
  planCredential,
  resolveCredential,
} from './auth.js';
export {
  type RunTurnOptions,
  type StopReason,
  type TurnEvent,
  type TurnResult,
  runTurn,
} from './loop.js';
