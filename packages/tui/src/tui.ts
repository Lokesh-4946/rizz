// Simple-mode interactive TUI (UI/UX spec §4). Zero runtime dependencies — built on node:readline
// + the theme's ANSI (decision D-015). M3 wires the real agentic loop: it renders streamed turn
// events (tool lines, visible fallback, compaction notes), prompts inline for destructive/networked
// command approval, and shows the live budget. The real provider auth (`/login`) lands separately.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  DEFAULT_COMPRESS,
  type Session,
  type TurnEvent,
  createSession,
  newBudgetState,
  runTurn,
} from '@rizz/core';
import {
  type Provider,
  type SessionStore,
  StubProvider,
  estimateMessagesTokens,
  openSessionStore,
} from '@rizz/providers';
import { renderEmptyState, renderHeader, renderHint, renderStatusBar } from './render.js';
import { type Theme, createTheme, defaultColorEnabled } from './theme.js';

export interface TuiOptions {
  readonly provider?: Provider;
  readonly theme?: Theme;
  /** Resume a prior session by id (rehydrates its full message history). */
  readonly resumeId?: string;
}

/** Where sessions persist. Local-first; no cloud (D-011). */
const SESSIONS_DIR = join(homedir(), '.rizz', 'sessions');

interface OpenedSession {
  session: Session;
  sessionId: string | undefined;
  notice?: string;
}

/** Create a fresh persisted session; if the store can't create one, fall back to in-memory and say so. */
async function newSession(store: SessionStore, model: string): Promise<OpenedSession> {
  const created = await store.create({ model, branch: 'dev' });
  if (created.ok) return { session: createSession(), sessionId: created.value };
  // Never swallow it (§3.6): tell the user the turn won't be saved.
  return {
    session: createSession(),
    sessionId: undefined,
    notice: `session store unavailable (${created.error.code}) — running in-memory, nothing will be saved`,
  };
}

/** Resume a session by id (full history), else start fresh. Every failure path surfaces a notice. */
async function openSession(
  store: SessionStore,
  model: string,
  resumeId?: string,
): Promise<OpenedSession> {
  if (resumeId === undefined) return newSession(store, model);

  const loaded = await store.load(resumeId);
  if (loaded.ok) {
    const session = createSession();
    session.messages.push(...loaded.value.messages);
    return { session, sessionId: resumeId };
  }

  // Resume failed — never silently start blank (that IS the /resume failure the PR fixes). Start
  // fresh, surfacing both the resume failure and any store-create failure.
  const fresh = await newSession(store, model);
  const resumeNote = `could not resume session ${resumeId} (${loaded.error.code})`;
  return {
    ...fresh,
    notice:
      fresh.notice !== undefined
        ? `${resumeNote}; ${fresh.notice}`
        : `${resumeNote} — started a new session`,
  };
}

export async function startTui(options: TuiOptions = {}): Promise<void> {
  const provider = options.provider ?? new StubProvider();
  const theme = options.theme ?? createTheme({ color: defaultColorEnabled() });
  const cwd = process.cwd();

  // Open the local session store (node:sqlite primary, JSONL fallback) and create or resume a session.
  const store: SessionStore = await openSessionStore({ dir: SESSIONS_DIR });
  const budgetState = newBudgetState();
  const { session, sessionId, notice } = await openSession(store, provider.label, options.resumeId);
  // Do NOT seed budgetState.tokens from the rehydrated messages: the budget tracks THIS run's spend,
  // and recordUsage will count the first call's inputTokens (which already include the resumed
  // context). Seeding here would double-count and trip BUDGET_EXCEEDED on large resumes. The status
  // bar shows context fullness separately via estimateMessagesTokens(session.messages).

  const writeLine = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  writeLine(renderHeader(theme, provider.label));
  writeLine('');
  // A failed --resume must be visible, not silent (latent-demands §6).
  if (notice !== undefined) writeLine(theme.alert(`  ⚠ ${notice}`));
  writeLine(renderEmptyState(theme));
  writeLine(renderHint(theme));
  writeLine('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Resolves null if the interface closes (idle Ctrl+C / EOF) so the prompt loop never hangs.
  const ask = (question: string): Promise<string | null> =>
    new Promise((resolve) => {
      const onClose = (): void => resolve(null);
      rl.once('close', onClose);
      rl.question(question, (answer) => {
        rl.off('close', onClose);
        resolve(answer);
      });
    });

  // One controller per in-flight turn. Ctrl+C aborts a running turn; when idle, it quits.
  let inFlight: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
      writeLine(theme.alert('  ⛌ interrupted'));
      return;
    }
    rl.close();
  });

  const renderEvent = (event: TurnEvent): void => {
    switch (event.type) {
      case 'assistant':
        writeLine(theme.text(`  ${event.content}`));
        break;
      case 'tool': {
        const paint = event.ok ? theme.system : theme.alert;
        writeLine(paint(`  · ${event.display}`));
        break;
      }
      case 'fallback':
        writeLine(theme.alert(`  ↻ ${event.note}`));
        break;
      case 'compacted':
        writeLine(theme.dim(`  ⤵ ${event.note}`));
        break;
      case 'approval-denied':
        writeLine(theme.dim(`  ✗ denied: ${event.command}`));
        break;
      case 'notice':
        writeLine(theme.dim(`  ${event.message}`));
        break;
    }
  };

  const approve = async (req: {
    command: string;
    kind: 'destructive' | 'networked';
    reason: string;
  }): Promise<{ approved: true } | { approved: false }> => {
    writeLine(theme.alert(`  ⚠ ${req.kind} command needs approval:`));
    writeLine(theme.text(`    ${req.command}`));
    writeLine(theme.dim(`    ${req.reason}`));
    const answer = ((await ask(theme.accent('    approve? [y/N] '))) ?? '').trim().toLowerCase();
    return answer === 'y' || answer === 'yes' ? { approved: true } : { approved: false };
  };

  const statusLine = (): string => {
    const used = estimateMessagesTokens(session.messages);
    const ctxPct = Math.min(100, Math.round((used / DEFAULT_COMPRESS.contextWindow) * 100));
    return renderStatusBar(theme, {
      model: provider.label,
      auth: 'demo',
      ctxPct,
      tokens: budgetState.tokens,
      cost: '$0.00 (sub)',
      branch: 'dev', // TODO: read the active git branch once the workspace service lands.
    });
  };

  const handleLine = async (line: string): Promise<boolean> => {
    const input = line.trim();
    if (input === '') return true;
    if (input === '/exit' || input === '/quit') return false;
    if (input === '/help') {
      writeLine(renderHint(theme));
      return true;
    }

    inFlight = new AbortController();
    const result = await runTurn({
      provider,
      session,
      input,
      cwd,
      signal: inFlight.signal,
      budgetState,
      compress: DEFAULT_COMPRESS,
      store,
      ...(sessionId !== undefined ? { sessionId } : {}),
      onEvent: renderEvent,
      onApprovalNeeded: approve,
    });
    inFlight = null;

    if (!result.ok && result.error.code !== 'INTERRUPTED') {
      writeLine(theme.alert(`  ${result.error.code}: ${result.error.message}`));
    }
    writeLine(statusLine());
    return true;
  };

  for (;;) {
    const line = await ask(theme.accent('› '));
    if (line === null) break; // interface closed (idle Ctrl+C / EOF)
    const keepGoing = await handleLine(line);
    if (!keepGoing) break;
  }
  rl.close();
  writeLine(theme.dim('  bye.'));
}
