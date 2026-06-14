// Simple-mode interactive TUI (UI/UX spec §4). Zero runtime dependencies — built on node:readline
// + the theme's ANSI (decision D-015). M3 wires the real agentic loop: it renders streamed turn
// events (tool lines, visible fallback, compaction notes), prompts inline for destructive/networked
// command approval, and shows the live budget. The real provider auth (`/login`) lands separately.

import { createInterface } from 'node:readline';
import {
  DEFAULT_COMPRESS,
  type TurnEvent,
  createSession,
  newBudgetState,
  runTurn,
} from '@rizz/core';
import { type Provider, StubProvider, estimateMessagesTokens } from '@rizz/providers';
import { renderEmptyState, renderHeader, renderHint, renderStatusBar } from './render.js';
import { type Theme, createTheme, defaultColorEnabled } from './theme.js';

export interface TuiOptions {
  readonly provider?: Provider;
  readonly theme?: Theme;
}

export async function startTui(options: TuiOptions = {}): Promise<void> {
  const provider = options.provider ?? new StubProvider();
  const theme = options.theme ?? createTheme({ color: defaultColorEnabled() });
  const session = createSession();
  const budgetState = newBudgetState();
  const cwd = process.cwd();

  const writeLine = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  writeLine(renderHeader(theme, provider.label));
  writeLine('');
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
      case 'tool':
        writeLine((event.ok ? theme.system : theme.alert)(`  · ${event.display}`));
        break;
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
      branch: 'm3',
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
