// The provider service contract (the "how" of talking to a model). Adapters implement this and
// return structured results; they never touch session or orchestration state. The loop calls the
// `callModel` service (see model/call.ts), which wraps the active Provider so streaming, abort, and
// usage normalization live in one place.

import type { Result } from './result.js';
import type { ToolCall } from './runtime/dispatch.js';
import type { ToolSpec } from './runtime/tools/spec.js';

// `tool` carries a tool result back to the model (real provider APIs model this as a distinct role).
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  readonly role: Role;
  readonly content: string;
  /** For a `tool` message: the id of the tool call this is the result of (correlation). */
  readonly toolCallId?: string;
}

export interface CompletionRequest {
  readonly messages: readonly Message[];
  /** The tool schemas the model may call (the four-tool loadout). */
  readonly tools?: readonly ToolSpec[];
  /** Cooperative cancellation — the loop passes the turn's signal so a provider can abort in flight. */
  readonly signal?: AbortSignal;
  /** Streaming hook — adapters that stream call this with each text delta. */
  readonly onChunk?: (delta: string) => void;
}

export interface CompletionResult {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tool calls the loop will dispatch. Empty/absent → the content is the final answer. */
  readonly toolCalls?: readonly ToolCall[];
}

export interface Provider {
  readonly id: string;
  /** Human-readable label for the status bar / model picker. */
  readonly label: string;
  complete(request: CompletionRequest): Promise<Result<CompletionResult>>;
}
