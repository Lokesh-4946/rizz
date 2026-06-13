// The provider service contract (the "how" of talking to a model). Adapters implement this and
// return structured results; they never touch session or orchestration state. The real Claude
// subscription adapter lands in M3; `StubProvider` stands in for the M2 walking skeleton.

import type { Result } from './result.js';

export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  readonly role: Role;
  readonly content: string;
}

export interface CompletionRequest {
  readonly messages: readonly Message[];
  /** Cooperative cancellation — the loop passes the turn's signal so a provider can abort in flight. */
  readonly signal?: AbortSignal;
}

export interface CompletionResult {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  // M3: optional tool calls the loop will dispatch. Absent at M2 → the loop runs a single pass.
}

export interface Provider {
  readonly id: string;
  /** Human-readable label for the status bar / model picker. */
  readonly label: string;
  complete(request: CompletionRequest): Promise<Result<CompletionResult>>;
}
