// JSONL session backend (D-020 fallback) — zero dependencies, works on any Node. Per session:
// `<id>.meta.json` holds the metadata (rewritten on updateMeta — it is tiny) and `<id>.jsonl` is an
// append-only log of one JSON message per line. Each appended line is independently valid JSON, so a
// crash mid-append at worst loses the last line: `load` skips an unparseable trailing line and still
// returns a loadable session (the `--resume` "No messages returned" crash, latent-demands §6).

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '../provider.js';
import { type Result, RizzError, err, ok } from '../result.js';
import type {
  MetaPatch,
  SessionInit,
  SessionMeta,
  SessionStore,
  StoredSession,
} from './store.js';

function metaPath(dir: string, id: string): string {
  return join(dir, `${id}.meta.json`);
}
function logPath(dir: string, id: string): string {
  return join(dir, `${id}.jsonl`);
}

async function readMeta(dir: string, id: string): Promise<Result<SessionMeta>> {
  try {
    const raw = await readFile(metaPath(dir, id), 'utf8');
    return ok(JSON.parse(raw) as SessionMeta);
  } catch (cause) {
    return err(new RizzError('TOOL_IO', `session ${id} not found`, { cause }));
  }
}

async function readMessages(dir: string, id: string): Promise<readonly Message[]> {
  let raw: string;
  try {
    raw = await readFile(logPath(dir, id), 'utf8');
  } catch {
    return [];
  }
  const messages: Message[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      messages.push(JSON.parse(line) as Message);
    } catch {
      // Tolerate a torn trailing line from a crash — keep what loaded cleanly.
    }
  }
  return messages;
}

export function createJsonlStore(dir: string): SessionStore {
  const ready = mkdir(dir, { recursive: true });

  return {
    async create(init: SessionInit): Promise<Result<string>> {
      await ready;
      const id = randomUUID();
      const meta: SessionMeta = {
        id,
        createdAt: Date.now(),
        model: init.model,
        branch: init.branch,
        tokens: 0,
        costUsd: 0,
      };
      try {
        await writeFile(metaPath(dir, id), JSON.stringify(meta), 'utf8');
        await writeFile(logPath(dir, id), '', 'utf8');
      } catch (cause) {
        return err(new RizzError('TOOL_IO', `could not create session ${id}`, { cause }));
      }
      return ok(id);
    },

    async append(id: string, message: Message): Promise<Result<void>> {
      await ready;
      try {
        await appendFile(logPath(dir, id), `${JSON.stringify(message)}\n`, 'utf8');
      } catch (cause) {
        return err(new RizzError('TOOL_IO', `could not append to session ${id}`, { cause }));
      }
      return ok(undefined);
    },

    async updateMeta(id: string, patch: MetaPatch): Promise<Result<void>> {
      await ready;
      const current = await readMeta(dir, id);
      if (!current.ok) return current;
      const next: SessionMeta = { ...current.value, ...patch };
      try {
        await writeFile(metaPath(dir, id), JSON.stringify(next), 'utf8');
      } catch (cause) {
        return err(new RizzError('TOOL_IO', `could not update session ${id}`, { cause }));
      }
      return ok(undefined);
    },

    async load(id: string): Promise<Result<StoredSession>> {
      await ready;
      const meta = await readMeta(dir, id);
      if (!meta.ok) return meta;
      const messages = await readMessages(dir, id);
      return ok({ meta: meta.value, messages });
    },

    async list(limit?: number): Promise<Result<readonly SessionMeta[]>> {
      await ready;
      let files: string[];
      try {
        files = await readdir(dir);
      } catch (cause) {
        return err(new RizzError('TOOL_IO', 'could not list sessions', { cause }));
      }
      const metas: SessionMeta[] = [];
      for (const file of files) {
        if (!file.endsWith('.meta.json')) continue;
        const meta = await readMeta(dir, file.slice(0, -'.meta.json'.length));
        if (meta.ok) metas.push(meta.value);
      }
      metas.sort((a, b) => b.createdAt - a.createdAt);
      return ok(limit === undefined ? metas : metas.slice(0, limit));
    },

    async fork(id: string, atMessage: number): Promise<Result<string>> {
      await ready;
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
