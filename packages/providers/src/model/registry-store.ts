// Local-first registry loader (ADR-002 / D-023 — COMMIT/M4). Reads ~/.rizz/models.json if present
// (versioned, offline, **secrets-free**) and otherwise falls back to the curated in-code
// DEFAULT_REGISTRY. The on-disk registry references providers by id only — BYOK keys bind via the
// keychain SecretRef and NEVER live here (§3.6). A malformed or secret-bearing file is rejected with a
// reason rather than trusted; the loader never throws (returns data + an optional notice).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_PROFILES, type Profile } from './profiles.js';
import {
  type Capability,
  DEFAULT_REGISTRY,
  type ModelInfo,
  type ModelRegistry,
} from './registry.js';

/** Bump when the on-disk schema changes; older files are still read leniently for the fields we use. */
export const REGISTRY_VERSION = 1;

// Keys that must NEVER appear in the on-disk registry — the secrets-free invariant (§3.6).
const FORBIDDEN_KEYS = ['apikey', 'api_key', 'key', 'secret', 'token', 'password', 'authorization'];

export interface LoadRegistryOptions {
  /** Override the registry path (default ~/.rizz/models.json). */
  readonly path?: string;
  /** Injected reader (tests). Returns null when the file is absent. */
  readonly readFile?: (path: string) => string | null;
}

export interface LoadedRegistry {
  readonly registry: ModelRegistry;
  /** Built-in profiles merged with any the file declares (file wins on a name clash). */
  readonly profiles: Readonly<Record<string, Profile>>;
  readonly source: 'file' | 'builtin';
  /** Set when a file was present but rejected — surfaced to the user, never silent. */
  readonly notice?: string;
}

function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Recursively true if any object key is a known secret-bearing name (case-insensitive). */
function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(k.toLowerCase())) return true;
      if (hasForbiddenKey(v)) return true;
    }
  }
  return false;
}

const CAPABILITIES: readonly Capability[] = ['code', 'plan', 'cheap', 'long-context'];

/** Strict guard: a user-edited entry must be a complete ModelInfo before we trust it. */
function isModelInfo(value: unknown): value is ModelInfo {
  if (value === null || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    m.id !== '' &&
    typeof m.provider === 'string' &&
    typeof m.label === 'string' &&
    Array.isArray(m.capabilities) &&
    m.capabilities.every((c) => typeof c === 'string' && CAPABILITIES.includes(c as Capability)) &&
    typeof m.contextWindow === 'number' &&
    typeof m.priceInputPerM === 'number' &&
    typeof m.priceOutputPerM === 'number' &&
    (m.latencyHint === 'fast' || m.latencyHint === 'medium' || m.latencyHint === 'slow') &&
    typeof m.toolCapable === 'boolean'
  );
}

function isProfile(value: unknown): value is Profile {
  if (value === null || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.name === 'string' && typeof p.model === 'string' && typeof p.description === 'string'
  );
}

/**
 * Load the active registry + profiles. Missing file → the curated built-ins (the common, zero-cost
 * cold path). Present-but-bad file → built-ins + a notice explaining why it was ignored.
 */
export function loadRegistry(options: LoadRegistryOptions = {}): LoadedRegistry {
  const path = options.path ?? join(homedir(), '.rizz', 'models.json');
  const read = options.readFile ?? defaultRead;

  const builtin = (notice?: string): LoadedRegistry => ({
    registry: DEFAULT_REGISTRY,
    profiles: { ...BUILTIN_PROFILES },
    source: 'builtin',
    ...(notice !== undefined ? { notice } : {}),
  });

  const raw = read(path);
  if (raw === null) return builtin();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return builtin('~/.rizz/models.json is not valid JSON — using the built-in registry');
  }
  if (hasForbiddenKey(parsed)) {
    return builtin(
      '~/.rizz/models.json contains a secret-bearing field — ignored; the registry must be secrets-free (keys live in the keychain)',
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    return builtin('~/.rizz/models.json is not an object — using the built-in registry');
  }

  const obj = parsed as { models?: unknown; profiles?: unknown };
  if (!Array.isArray(obj.models) || obj.models.length === 0 || !obj.models.every(isModelInfo)) {
    return builtin('~/.rizz/models.json has no valid "models" array — using the built-in registry');
  }

  const fileProfiles: Record<string, Profile> = {};
  if (obj.profiles !== null && typeof obj.profiles === 'object') {
    for (const [name, p] of Object.entries(obj.profiles as Record<string, unknown>)) {
      if (isProfile(p)) fileProfiles[name] = p;
    }
  }

  return {
    registry: { models: obj.models },
    profiles: { ...BUILTIN_PROFILES, ...fileProfiles },
    source: 'file',
  };
}
