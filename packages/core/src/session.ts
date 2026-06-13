import type { Message } from '@rizz/providers';

/** In-memory conversation state. Persistence (SQLite + resume) lands in a later milestone. */
export interface Session {
  readonly messages: Message[];
}

export const createSession = (system?: string): Session => ({
  messages: system === undefined ? [] : [{ role: 'system', content: system }],
});
