// Session persistence service (design §3.5, §8). Local-first, append-only. The store owns the *how*
// of persistence; the loop owns *when* to persist (ADR-001). Resume = load by id and rehydrate the
// FULL message list (directly answering the /resume failure cluster — latent-demands §6), never a
// lossy 20–40% rehydrate.
//
// Engine (D-020): `node:sqlite` is PRIMARY (built into Node ≥ 22.5 → zero runtime dependency), with
// an append-only JSONL FALLBACK when the running Node lacks it. `openSessionStore` auto-detects so
// the cross-platform CI matrix (Node 24) works whether or not node:sqlite is present.

import { createRequire } from 'node:module';
import type { Message } from '../provider.js';
import type { Result } from '../result.js';

export interface SessionMeta {
  readonly id: string;
  readonly createdAt: number;
  readonly model: string;
  readonly branch: string;
  readonly tokens: number;
  readonly costUsd: number;
}

export interface SessionInit {
  readonly model: string;
  readonly branch: string;
}

export interface StoredSession {
  readonly meta: SessionMeta;
  readonly messages: readonly Message[];
}

export type MetaPatch = Partial<Pick<SessionMeta, 'tokens' | 'costUsd' | 'model' | 'branch'>>;

export interface SessionStore {
  create(init: SessionInit): Promise<Result<string>>;
  append(id: string, message: Message): Promise<Result<void>>;
  updateMeta(id: string, patch: MetaPatch): Promise<Result<void>>;
  load(id: string): Promise<Result<StoredSession>>;
  list(limit?: number): Promise<Result<readonly SessionMeta[]>>;
  /** Tree/fork (Pi parity) — copy messages [0, atMessage) into a fresh session. */
  fork(id: string, atMessage: number): Promise<Result<string>>;
}

export type SessionEngine = 'sqlite' | 'jsonl';

/**
 * True when `node:sqlite` is importable on this runtime (Node ≥ 22.5). Uses `createRequire` rather
 * than `import('node:sqlite')` because bundlers/test runners (Vitest's Vite resolver) rewrite the
 * `node:` specifier and fail to resolve it; a runtime require of the builtin is bypass-proof.
 */
export function sqliteAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as { DatabaseSync?: unknown };
    return typeof mod.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

export interface OpenStoreOptions {
  readonly dir: string;
  /** Force an engine; default auto-detects (sqlite primary, jsonl fallback — D-020). */
  readonly engine?: SessionEngine;
}

export async function openSessionStore(options: OpenStoreOptions): Promise<SessionStore> {
  const engine = options.engine ?? (sqliteAvailable() ? 'sqlite' : 'jsonl');
  if (engine === 'sqlite') {
    const { createSqliteStore } = await import('./sqlite.js');
    return createSqliteStore(options.dir);
  }
  const { createJsonlStore } = await import('./jsonl.js');
  return createJsonlStore(options.dir);
}
