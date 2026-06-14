// selectByCapability — the OPT-IN capability/cost/latency router (ADR-002 §6, D-023). This is the
// "smart" branch that resolveModelRoute deliberately omits: it is NEVER on the default cold path (the
// default stays the opinionated single-default + visible fallback of resolveModelRoute). A caller
// reaches it explicitly (e.g. `rizz --capability code`). Pure: registry + request + policy in, a model
// + ordered alternates out — no state, no I/O (ADR-001).
//
// Honesty constraints (D-023): latency is an ORDINAL tie-breaker only (no millisecond claims until the
// S1 data spike); cost-awareness ties to D-021; this is NOT marketed as "smart routing". A pluggable
// ScoreFn leaves the M5 eval-driven hook without shipping eval logic now.

import { type Result, RizzError, err, ok } from '../result.js';
import { type Capability, type ModelInfo, type ModelRegistry, getModel } from './registry.js';
import type { RoutingPolicy } from './route.js';

export interface CapabilityRequest {
  readonly capability: Capability;
  /** Bias toward the cheapest capable model (D-021 cost-awareness). Default false. */
  readonly preferCheap?: boolean;
  /** Names the task so a policy `perTask` override can apply. */
  readonly taskTag?: string;
}

/** Pluggable scorer — higher wins. Defaults to the lexicographic comparator below (M5 eval hook). */
export type ScoreFn = (model: ModelInfo, request: CapabilityRequest) => number;

export interface CapabilityRouteParams {
  readonly registry: ModelRegistry;
  readonly request: CapabilityRequest;
  /** Optional policy — only `perTask` is read here (an explicit override wins outright). */
  readonly policy?: RoutingPolicy;
  readonly scoreFn?: ScoreFn;
}

export interface CapabilityRoute {
  readonly model: ModelInfo;
  /** Best-scored alternates after the winner — the loop can fall back through these. */
  readonly chain: readonly ModelInfo[];
  readonly reason: 'per-task' | 'capability';
}

// Latency as an ordinal only (D-023 — no ms claims): faster ranks higher in a tie.
const LATENCY_ORDINAL: Readonly<Record<ModelInfo['latencyHint'], number>> = {
  fast: 2,
  medium: 1,
  slow: 0,
};

/**
 * Default ranking among capable models, lexicographic so it needs no magic weights:
 *  - preferCheap → cheapest first, then richer capabilities, then faster, then id (stable);
 *  - otherwise  → richer capabilities first, then faster, then cheaper, then id (stable).
 * "Richer" = capability count, a rough proxy until M5 eval data supplies real strength.
 */
function compareModels(a: ModelInfo, b: ModelInfo, preferCheap: boolean): number {
  const costA = a.priceInputPerM + a.priceOutputPerM;
  const costB = b.priceInputPerM + b.priceOutputPerM;
  const byCost = costA - costB;
  const byRichness = b.capabilities.length - a.capabilities.length;
  const byLatency = LATENCY_ORDINAL[b.latencyHint] - LATENCY_ORDINAL[a.latencyHint];
  const order = preferCheap ? [byCost, byRichness, byLatency] : [byRichness, byLatency, byCost];
  for (const cmp of order) {
    if (cmp !== 0) return cmp;
  }
  return a.id.localeCompare(b.id);
}

/** Rank capable models, applying a pluggable ScoreFn when given, else the default comparator. */
function rankModels(
  models: readonly ModelInfo[],
  request: CapabilityRequest,
  scoreFn?: ScoreFn,
): ModelInfo[] {
  const ranked = [...models];
  if (scoreFn !== undefined) {
    ranked.sort((a, b) => scoreFn(b, request) - scoreFn(a, request));
  } else {
    ranked.sort((a, b) => compareModels(a, b, request.preferCheap === true));
  }
  return ranked;
}

export function selectByCapability(params: CapabilityRouteParams): Result<CapabilityRoute> {
  const { registry, request, policy, scoreFn } = params;

  // Capability is a hard filter (tool-capable + has the requested capability), ranked.
  const capable = registry.models.filter(
    (m) => m.toolCapable && m.capabilities.includes(request.capability),
  );

  // 1. An explicit per-task override wins outright (opt-in; only when configured + resolvable). Its
  //    fallback chain stays capability-filtered + ranked, so alternates still match the request.
  const overrideId = request.taskTag !== undefined ? policy?.perTask?.[request.taskTag] : undefined;
  if (overrideId !== undefined) {
    const override = getModel(registry, overrideId);
    if (override !== undefined) {
      const chain = rankModels(
        capable.filter((m) => m.id !== override.id),
        request,
        scoreFn,
      );
      return ok({ model: override, chain, reason: 'per-task' });
    }
    // A configured override that isn't in the registry falls through to capability scoring rather
    // than failing the turn — the model genuinely isn't available.
  }

  // 2. No override (or it was unresolvable) → pick the best capable model.
  if (capable.length === 0) {
    return err(
      new RizzError(
        'UNKNOWN',
        `no tool-capable model in the registry has capability "${request.capability}"`,
      ),
    );
  }
  const ranked = rankModels(capable, request, scoreFn);
  const model = ranked[0];
  if (model === undefined) {
    // Unreachable (capable.length > 0), but keeps the type honest without a cast.
    return err(new RizzError('UNKNOWN', 'no model after ranking'));
  }
  return ok({ model, chain: ranked.slice(1), reason: 'capability' });
}
