import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type SessionEngine,
  type SessionStore,
  openSessionStore,
  sqliteAvailable,
} from './store.js';

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rizz-session-'));
}

// The same contract must hold for whichever engine is selected. We always run JSONL (no dep) and,
// when node:sqlite is present on this runtime, also run sqlite — confirming the D-020 matrix choice.
function contract(name: string, open: () => Promise<SessionStore>): void {
  describe(`SessionStore contract — ${name}`, () => {
    it('creates, appends, and resumes the FULL message list', async () => {
      const store = await open();
      const created = await store.create({ model: 'claude-opus-4-8', branch: 'develop' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value;

      await store.append(id, { role: 'user', content: 'first' });
      await store.append(id, { role: 'assistant', content: 'second' });

      const loaded = await store.load(id);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.messages).toEqual([
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
        ]);
        expect(loaded.value.meta.model).toBe('claude-opus-4-8');
      }
    });

    it('persists running token/cost totals via updateMeta', async () => {
      const store = await open();
      const created = await store.create({ model: 'm', branch: 'b' });
      if (!created.ok) return;
      await store.updateMeta(created.value, { tokens: 1234, costUsd: 0 });
      const loaded = await store.load(created.value);
      if (loaded.ok) expect(loaded.value.meta.tokens).toBe(1234);
    });

    it('lists sessions newest-first and honors a limit', async () => {
      const store = await open();
      await store.create({ model: 'm', branch: 'b' });
      await store.create({ model: 'm', branch: 'b' });
      const list = await store.list(1);
      expect(list.ok).toBe(true);
      if (list.ok) expect(list.value).toHaveLength(1);
    });

    it('forks a session up to a message index', async () => {
      const store = await open();
      const created = await store.create({ model: 'm', branch: 'b' });
      if (!created.ok) return;
      await store.append(created.value, { role: 'user', content: 'a' });
      await store.append(created.value, { role: 'assistant', content: 'b' });
      await store.append(created.value, { role: 'user', content: 'c' });
      const forked = await store.fork(created.value, 2);
      expect(forked.ok).toBe(true);
      if (forked.ok) {
        const loaded = await store.load(forked.value);
        if (loaded.ok) expect(loaded.value.messages.map((m) => m.content)).toEqual(['a', 'b']);
      }
    });

    it('errors loading a missing session rather than crashing', async () => {
      const store = await open();
      const loaded = await store.load('does-not-exist');
      expect(loaded.ok).toBe(false);
    });
  });
}

contract('jsonl', async () => openSessionStore({ dir: await freshDir(), engine: 'jsonl' }));

const sqliteOn = sqliteAvailable();
const engine: SessionEngine = 'sqlite';
describe.skipIf(!sqliteOn)('sqlite engine (D-020 primary)', () => {
  contract('sqlite', async () => openSessionStore({ dir: await freshDir(), engine }));
});
