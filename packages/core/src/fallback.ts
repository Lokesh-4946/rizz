// Failure classification + visible fallback (orchestration; design §5). When callModel returns a
// retryable failure the loop resolves the next model in the chain (resolveModelRoute service) and
// emits a VISIBLE note — fallback is never silent (the Hermes bug, latent-demands §6). Auth/budget
// are surfaced or stop; a bad tool call is repaired by asking the model to re-emit valid JSON.

import {
  type ModelInfo,
  type ModelRegistry,
  type Provider,
  type Result,
  RizzError,
  type RizzErrorCode,
  type RoutingPolicy,
  err,
  ok,
  resolveModelRoute,
} from '@valoir/rizz-providers';

export type FailureAction = 'fallback' | 'surface' | 'stop' | 'repair';

/** Map a service error code to the loop's reaction (design §5). */
export function classifyFailure(code: RizzErrorCode): FailureAction {
  switch (code) {
    case 'PROVIDER_RATE_LIMIT':
    case 'PROVIDER_UNAVAILABLE':
      return 'fallback';
    case 'BAD_TOOL_CALL':
      return 'repair';
    case 'BUDGET_EXCEEDED':
      return 'stop';
    default:
      // PROVIDER_AUTH and anything unexpected → surface to the user (turn preserved).
      return 'surface';
  }
}

/** A factory the loop holds to turn a resolved model id into a live Provider. */
export type ProviderFor = (model: ModelInfo) => Provider;

export interface RoutingContext {
  readonly registry: ModelRegistry;
  readonly policy: RoutingPolicy;
  readonly providerFor: ProviderFor;
}

export interface FallbackResult {
  readonly provider: Provider;
  readonly model: ModelInfo;
  /** Visible note: "Claude is rate-limited — falling back to <next>". */
  readonly note: string;
}

/**
 * Resolve the next provider after a retryable failure. Returns an error when the chain is exhausted
 * so the loop can surface it. Pure orchestration over the routing service — no I/O here.
 */
export function runFallback(
  routing: RoutingContext,
  failed: { modelId: string; code: RizzErrorCode },
): Result<FallbackResult> {
  const decision = resolveModelRoute({
    registry: routing.registry,
    policy: routing.policy,
    failed,
  });
  if (!decision.ok) return decision;
  if (decision.value.reason !== 'fallback' || decision.value.note === undefined) {
    return err(new RizzError('PROVIDER_UNAVAILABLE', 'no fallback available'));
  }
  return ok({
    provider: routing.providerFor(decision.value.model),
    model: decision.value.model,
    note: decision.value.note,
  });
}
