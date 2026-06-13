// Simple-mode interactive TUI (UI/UX spec §4). Zero runtime dependencies — built on node:readline
// + the theme's ANSI (decision D-015). Streaming/diffs/approvals and the real model arrive in M3;
// this is the walking-skeleton shell: header, empty-state, the loop, interrupt, /help, /exit.

import { createInterface } from 'node:readline';
import { createSession, newBudgetState, runTurn } from '@rizz/core';
import { type Provider, StubProvider } from '@rizz/providers';
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

  const writeLine = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  writeLine(renderHeader(theme, provider.label));
  writeLine('');
  writeLine(renderEmptyState(theme));
  writeLine(renderHint(theme));
  writeLine('');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: theme.accent('› '),
  });

  // One controller per in-flight turn. Ctrl+C aborts a running turn; when idle, it quits.
  let inFlight: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
      writeLine(theme.alert('  ⛌ interrupted'));
      rl.prompt();
      return;
    }
    rl.close();
  });

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
      signal: inFlight.signal,
      budgetState,
      onChunk: (text) => writeLine(theme.text(`  ${text}`)),
    });
    inFlight = null;

    if (!result.ok && result.error.code !== 'INTERRUPTED') {
      writeLine(theme.alert(`  ${result.error.code}: ${result.error.message}`));
    }
    writeLine(
      renderStatusBar(theme, {
        model: provider.label,
        auth: 'demo',
        ctxPct: 0,
        tokens: budgetState.tokens,
        cost: '$0.00 (sub)',
        branch: 'm2',
      }),
    );
    return true;
  };

  rl.prompt();
  for await (const line of rl) {
    const keepGoing = await handleLine(line);
    if (!keepGoing) break;
    rl.prompt();
  }
  rl.close();
  writeLine(theme.dim('  bye.'));
}
