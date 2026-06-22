// Pure render helpers for the Simple-mode TUI (UI/UX spec §4, §8, §9). They take a theme + data and
// return a string — no I/O — so they're unit-testable without a TTY.

import type { CatalogProvider } from './catalog.js';
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
  theme.dim('  /status · /login · /model · /theme · /workspace · /help');

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

/** @internal */
export const renderThinking = (theme: Theme): string => theme.dim('  thinking...');

/** @internal */
export const renderStillWaiting = (theme: Theme, provider: string): string =>
  theme.dim(`  still waiting on ${provider}...`);

/** @internal */
export interface PickerModel {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
}

/** @internal */
export const renderModelPicker = (
  theme: Theme,
  models: readonly PickerModel[],
  catalog: readonly CatalogProvider[],
): string => {
  const lines: string[] = [theme.accent('  Select a model')];
  models.forEach((m, i) => {
    const marker = m.active ? theme.accent(theme.glyphs.star) : ' ';
    lines.push(`  ${marker} ${theme.text(`${i + 1}. ${m.label}`)}`);
  });
  lines.push(theme.dim('  ─ other routes ─'));
  for (const p of catalog) {
    if (p.wired) continue;
    lines.push(theme.dim(`    ${theme.glyphs.bulletOpen} ${p.label} — ${p.blurb} · not connected`));
  }
  lines.push(theme.dim('  type a number to switch, or press enter to cancel'));
  return lines.join('\n');
};

/** @internal */
export const renderThemeList = (
  theme: Theme,
  names: readonly string[],
  activeName: string,
): string => {
  const lines: string[] = [theme.accent('  Themes')];
  for (const name of names) {
    const marker = name === activeName ? theme.accent(theme.glyphs.selected) : ' ';
    const swatch = `${theme.accent('█')}${theme.system('█')}${theme.alert('█')}`;
    lines.push(`  ${marker} ${theme.text(name)}  ${swatch}`);
  }
  lines.push(theme.dim('  /theme set <name> to switch (hot-swaps, no restart)'));
  return lines.join('\n');
};

/** @internal */
export const renderPlanStub = (theme: Theme): string =>
  theme.dim("  plan mode is not connected yet — describe the task and I'll work it directly.");

/** @internal */
export const renderNotConnected = (theme: Theme, label: string): string =>
  theme.dim(`  ${label} is not connected yet.`);
