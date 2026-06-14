// SQLite session backend (D-020 PRIMARY) on Node's built-in `node:sqlite` — zero runtime
// dependency. One `sessions.db` per store dir; two tables. The synchronous DatabaseSync API is
// wrapped in the async SessionStore contract. This module is only imported when node:sqlite is known
// to be available (see openSessionStore), so the static import never breaks the JSONL fallback path.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Message } from '../provider.js';
import { type Result, RizzError, err, ok } from '../result.js';
import type { MetaPatch, SessionInit, SessionMeta, SessionStore, StoredSession } from './store.js';

// Load the builtin via createRequire so bundlers/test runners that rewrite `node:` specifiers can't
// break it (see sqliteAvailable in store.ts). The type comes from @types/node without a runtime import.
type NodeSqlite = typeof import('node:sqlite');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as NodeSqlite;

interface SessionRow {
  id: string;
  created_at: number;
  model: string;
  branch: string;
  tokens: number;
  cost_usd: number;
}
interface MessageRow {
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls: string | null;
}

function toMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    createdAt: row.created_at,
    model: row.model,
    branch: row.branch,
    tokens: row.tokens,
    costUsd: row.cost_usd,
  };
}

export function createSqliteStore(dir: string): SessionStore {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'sessions.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, model TEXT NOT NULL,
      branch TEXT NOT NULL, tokens INTEGER NOT NULL, cost_usd REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      tool_call_id TEXT, tool_calls TEXT,
      PRIMARY KEY (session_id, seq)
    );
  `);

  return {
    async create(init: SessionInit): Promise<Result<string>> {
      const id = randomUUID();
      try {
        db.prepare(
          'INSERT INTO sessions (id, created_at, model, branch, tokens, cost_usd) VALUES (?, ?, ?, ?, 0, 0)',
        ).run(id, Date.now(), init.model, init.branch);
      } catch (cause) {
        return err(new RizzError('TOOL_IO', `could not create session ${id}`, { cause }));
      }
      return ok(id);
    },

    async append(id: string, message: Message): Promise<Result<void>> {
      try {
        const row = db
          .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE session_id = ?')
          .get(id) as unknown as { next: number };
        db.prepare(
          'INSERT INTO messages (session_id, seq, role, content, tool_call_id, tool_calls) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          id,
          row.next,
          message.role,
          message.content,
          message.toolCallId ?? null,
          message.toolCalls !== undefined ? JSON.stringify(message.toolCalls) : null,
        );
      } catch (cause) {
        return err(new RizzError('TOOL_IO', `could not append to session ${id}`, { cause }));
      }
      return ok(undefined);
    },

    async updateMeta(id: string, patch: MetaPatch): Promise<Result<void>> {
      const sets: string[] = [];
      const values: (string | number)[] = [];
      if (patch.tokens !== undefined) {
        sets.push('tokens = ?');
        values.push(patch.tokens);
      }
      if (patch.costUsd !== undefined) {
        sets.push('cost_usd = ?');
        values.push(patch.costUsd);
      }
      if (patch.model !== undefined) {
        sets.push('model = ?');
        values.push(patch.model);
      }
      if (patch.branch !== undefined) {
        sets.push('branch = ?');
        values.push(patch.branch);
      }
      if (sets.length === 0) return ok(undefined);
      try {
        db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      } catch (cause) {
        return err(new RizzError('TOOL_IO', `could not update session ${id}`, { cause }));
      }
      return ok(undefined);
    },

    async load(id: string): Promise<Result<StoredSession>> {
      try {
        const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as
          | SessionRow
          | undefined;
        if (row === undefined) return err(new RizzError('TOOL_IO', `session ${id} not found`));
        const rows = db
          .prepare(
            'SELECT role, content, tool_call_id, tool_calls FROM messages WHERE session_id = ? ORDER BY seq',
          )
          .all(id) as unknown as MessageRow[];
        const messages: Message[] = rows.map((m) => ({
          role: m.role as Message['role'],
          content: m.content,
          ...(m.tool_call_id !== null ? { toolCallId: m.tool_call_id } : {}),
          ...(m.tool_calls !== null
            ? { toolCalls: JSON.parse(m.tool_calls) as NonNullable<Message['toolCalls']> }
            : {}),
        }));
        return ok({ meta: toMeta(row), messages });
      } catch (cause) {
        return err(new RizzError('TOOL_IO', `could not load session ${id}`, { cause }));
      }
    },

    async list(limit?: number): Promise<Result<readonly SessionMeta[]>> {
      try {
        const sql =
          limit === undefined
            ? 'SELECT * FROM sessions ORDER BY created_at DESC'
            : 'SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?';
        const rows = (limit === undefined
          ? db.prepare(sql).all()
          : db.prepare(sql).all(limit)) as unknown as SessionRow[];
        return ok(rows.map(toMeta));
      } catch (cause) {
        return err(new RizzError('TOOL_IO', 'could not list sessions', { cause }));
      }
    },

    async fork(id: string, atMessage: number): Promise<Result<string>> {
      const source = await this.load(id);
      if (!source.ok) return source;
      const created = await this.create({
        model: source.value.meta.model,
        branch: source.value.meta.branch,
      });
      if (!created.ok) return created;
      const newId = created.value;
      for (const message of source.value.messages.slice(0, atMessage)) {
        const appended = await this.append(newId, message);
        if (!appended.ok) return appended;
      }
      return ok(newId);
    },
  };
}
