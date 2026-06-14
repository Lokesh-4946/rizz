// resolveModelRoute — the routing/fallback service (design §3.4, ADR-002 Tier 1). Pure resolution
// from policy + registry + the failure that triggered it. It does NOT score by capability/cost/
// latency — that is Tier 2 (deferred, NEEDS ORCHESTRATOR REVIEW per ADR-002). M3 routing surface:
// a default model plus an ordered fallback chain tried on a retryable provider failure.
//
// DEVIATION (see handoff D-024): the design's RouteDecision returns a live `Provider`; this returns
// the selected `ModelInfo` instead, so routing stays pure (no provider construction inside the
// service — ADR-001 "no ambient state"). The loop maps model→Provider via a factory it holds.

import { type Result, RizzError, type RizzErrorCode, err, ok } from '../result.js';
import { type ModelInfo, type ModelRegistry, getModel } from './registry.js';

export interface RoutingPolicy {
  readonly defaultModel: string;
  /** Ordered model ids to try on a retryable failure, after the default. */
  readonly fallbackChain: readonly string[];
  /**
   * Opt-in per-task override (D-023): taskTag → model id. Off by default (absent). Consumed only by
   * the capability router (`selectByCapability`), never on the default cold path.
   */
  readonly perTask?: Readonly<Record<string, string>>;
}

export interface RouteRequest {
  // Accepted for forward-compatibility but NOT used for scoring in M3 (Tier 2 deferred).
  readonly capability?: string;
  readonly taskTag?: string;
}

export interface RouteParams {
  readonly registry: ModelRegistry;
  readonly policy: RoutingPolicy;
  readonly request?: RouteRequest;
  /** Present on a fallback call: which model just failed, and why. */
  readonly failed?: { readonly modelId: string; readonly code: RizzErrorCode };
}

export interface RouteDecision {
  readonly model: ModelInfo;
  readonly reason: 'default' | 'fallback';
  /** Human-facing note for the TUI when falling back — fallback is never silent (design §5). */
  readonly note?: string;
}

/** The full ordered sequence the router walks: the default model, then the fallback chain. */
function routeSequence(policy: RoutingPolicy): readonly string[] {
  return [policy.defaultModel, ...policy.fallbackChain];
}

export function resolveModelRoute(params: RouteParams): Result<RouteDecision> {
  const { registry, policy, failed } = params;
  const sequence = routeSequence(policy);

  if (failed === undefined) {
    const model = getModel(registry, policy.defaultModel);
    if (model === undefined) {
      return err(
        new RizzError('UNKNOWN', `default model "${policy.defaultModel}" is not in the registry`),
      );
    }
    return ok({ model, reason: 'default' });
  }

  const failedIndex = sequence.indexOf(failed.modelId);
  const nextId = failedIndex === -1 ? undefined : sequence[failedIndex + 1];
  if (nextId === undefined) {
    return err(
      new RizzError('PROVIDER_UNAVAILABLE', 'fallback chain exhausted — no model left to try'),
    );
  }

  const next = getModel(registry, nextId);
  if (next === undefined) {
    return err(new RizzError('UNKNOWN', `fallback model "${nextId}" is not in the registry`));
  }

  const failedModel = getModel(registry, failed.modelId);
  const failedLabel = failedModel?.label ?? failed.modelId;
  return ok({
    model: next,
    reason: 'fallback',
    note: `${failedLabel} ${failed.code} — falling back to ${next.label}`,
  });
}

export const DEFAULT_POLICY: RoutingPolicy = {
  defaultModel: 'claude-opus-4-8',
  fallbackChain: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
};
