// Declarative model profiles (ADR-002 §5, D-023 — COMMIT/M4). A profile names *intent* ("deep",
// "cheap") instead of a model id, so a user picks a posture and the registry resolves the model. This
// is the §12 churn hedge at the UX layer: rename/replace a model in the registry, and profiles still
// resolve. Built-ins ship as data; a user's flat config can add/override them. Pure resolution — no
// state, no I/O (ADR-001).

import { type Result, RizzError, err, ok } from '../result.js';
import { type ModelInfo, type ModelRegistry, getModel } from './registry.js';

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';

export interface Profile {
  readonly name: string;
  /** Registry model id this profile selects. */
  readonly model: string;
  /** Forward-looking knobs — declared now, wired into adapters as they gain support. */
  readonly thinkingLevel?: ThinkingLevel;
  readonly temperature?: number;
  readonly description: string;
}

// Built-in profiles (D-023). Names are intent, not model IDs; reversible + overridable via config.
// `local` references a not-yet-wired provider on purpose — it resolves only once a local adapter +
// registry entry exist, surfacing an honest "not configured" until then (D-029 spirit).
export const BUILTIN_PROFILES: Readonly<Record<string, Profile>> = {
  default: {
    name: 'default',
    model: 'claude-opus-4-8',
    thinkingLevel: 'medium',
    description: 'balanced default',
  },
  deep: {
    name: 'deep',
    model: 'claude-opus-4-8',
    thinkingLevel: 'high',
    description: 'maximum reasoning',
  },
  fast: {
    name: 'fast',
    model: 'claude-sonnet-4-6',
    thinkingLevel: 'low',
    description: 'quick and capable',
  },
  cheap: {
    name: 'cheap',
    model: 'claude-haiku-4-5',
    thinkingLevel: 'none',
    description: 'lowest cost',
  },
  local: {
    name: 'local',
    model: 'ollama',
    description: 'offline local model (configure an endpoint first)',
  },
};

export const PROFILE_NAMES: readonly string[] = Object.keys(BUILTIN_PROFILES);

export interface ResolvedProfile {
  readonly profile: Profile;
  readonly model: ModelInfo;
}

/** Resolve a profile name → its Profile + the backing ModelInfo from the registry. Pure. */
export function resolveProfile(
  registry: ModelRegistry,
  profiles: Readonly<Record<string, Profile>>,
  name: string,
): Result<ResolvedProfile> {
  const profile = profiles[name];
  if (profile === undefined) {
    return err(
      new RizzError(
        'UNKNOWN',
        `no profile "${name}" — available: ${Object.keys(profiles).join(', ')}`,
      ),
    );
  }
  const model = getModel(registry, profile.model);
  if (model === undefined) {
    return err(
      new RizzError(
        'UNKNOWN',
        `profile "${name}" needs model "${profile.model}", which isn't in the registry yet`,
      ),
    );
  }
  return ok({ profile, model });
}
