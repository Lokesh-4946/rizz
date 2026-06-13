// Pure render helpers for the Simple-mode TUI (UI/UX spec §4, §8, §9). They take a theme + data and
// return a string — no I/O — so they're unit-testable without a TTY.

import type { Theme } from './theme.js';

export interface StatusInfo {
  readonly model: string;
  readonly auth: string;
  readonly ctxPct: number;
  readonly tokens: number;
  readonly cost: string;
  readonly branch: string;
}

// Internal name only (decision D-010 — no hardcoded public product name yet).
export const renderHeader = (theme: Theme, model: string): string =>
  `${theme.dim('┌─ ')}${theme.accent('rizz')}${theme.dim(' · by Valoir')}${theme.dim(' — ')}${theme.text(model)}`;

// Empty/first-message state: an invitation, never a blank screen (spec §9).
export const renderEmptyState = (theme: Theme): string =>
  `${theme.dim('  type to start, or ')}${theme.accent('/help')}${theme.dim(' for commands.')}`;

export const renderHint = (theme: Theme): string =>
  theme.dim('  /login · /model · /theme · /workspace · /help');

// Always-visible status line: model · auth │ ctx% │ tokens · cost │ branch (spec §8).
export const renderStatusBar = (theme: Theme, info: StatusInfo): string => {
  const parts = [
    `${info.model} · ${info.auth}`,
    `ctx ${info.ctxPct}%`,
    `${info.tokens} tok · ${info.cost}`,
    `⎇${info.branch}`,
  ];
  return theme.system(`  ${parts.join('  │  ')}`);
};
