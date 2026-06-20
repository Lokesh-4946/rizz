// Pure render helpers for the Simple-mode TUI (UI/UX spec §4, §8, §9). They take a theme + data and
// return a string — no I/O — so they're unit-testable without a TTY.

import type { CatalogProvider } from './catalog.js';
import type { ColorDepth, Theme } from './theme.js';

export interface StatusInfo {
  readonly model: string;
  readonly auth: string;
  readonly ctxPct: number;
  readonly tokens: number;
  readonly cost: string;
  readonly branch: string;
}

export interface SetupLaunchInfo {
  readonly agentName: string;
  readonly mode: 'Demo / Harness';
}

export interface SetupBootOptions {
  readonly compact?: boolean;
}

export interface SetupBootPanelInput {
  readonly isTTY: boolean;
  readonly columns?: number;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly colorDepth: ColorDepth;
}

// Internal name only (decision D-010 — no hardcoded public product name yet).
export const renderHeader = (theme: Theme, model: string): string =>
  `${theme.dim('┌─ ')}${theme.accent('rizz')}${theme.dim(' · by Valoir')}${theme.dim(' — ')}${theme.text(model)}`;

// Empty/first-message state: an invitation, never a blank screen (spec §9).
export const renderEmptyState = (theme: Theme): string =>
  `${theme.dim('  type to start, or ')}${theme.accent('/help')}${theme.dim(' for commands.')}`;

export const renderHint = (theme: Theme): string =>
  theme.dim('  /login · /model · /theme · /workspace · /help');

export function shouldRenderSetupBootPanel(input: SetupBootPanelInput): boolean {
  if (!input.isTTY) return false;
  if (input.env.CI !== undefined && input.env.CI.trim() !== '' && input.env.CI !== '0') {
    return false;
  }
  if (input.env.NO_COLOR !== undefined) return false;
  if (
    input.env.RIZZ_REDUCED_MOTION !== undefined &&
    input.env.RIZZ_REDUCED_MOTION.trim() !== '' &&
    input.env.RIZZ_REDUCED_MOTION !== '0'
  ) {
    return false;
  }
  if (input.colorDepth === 'none') return false;
  return input.columns === undefined || input.columns >= 72;
}

export const renderSetupBoot = (theme: Theme, options: SetupBootOptions = {}): string => {
  const statusLines = [
    'rizz setup',
    '[ok] dependency doctor complete',
    '[ok] demo provider selected',
    '[ok] Harness Mode ready',
  ];
  if (options.compact === true) {
    return statusLines.join('\n');
  }
  return [
    theme.dim('  .----.'),
    theme.dim(' /|_||_|\\'),
    theme.dim(' |  __  |'),
    theme.dim(' |_/  \\_|'),
    theme.system('  SYS: RIZZ ONLINE'),
    '',
    theme.dim(`  ${statusLines[0]}`),
    theme.system(`  ${statusLines[1]}`),
    theme.system(`  ${statusLines[2]}`),
    theme.accent(`  ${statusLines[3]}`),
  ].join('\n');
};

export const renderSetupLaunch = (theme: Theme, info: SetupLaunchInfo): string =>
  [
    theme.accent(`  ${info.agentName} online`),
    theme.text(`  mode: ${info.mode}`),
    theme.dim('  provider: demo'),
    theme.dim('  billing: $0.00 (sub)'),
    theme.dim('  permissions: ask'),
  ].join('\n');

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

/** One selectable model row for the picker. */
export interface PickerModel {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
}

// The /model picker (spec §4, D-029): numbered selectable models, then the full catalog with
// unwired providers dimmed + a "coming soon" label so the roadmap is honest without faking capability.
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
  lines.push(theme.dim('  ─ also on the roadmap (not yet selectable) ─'));
  for (const p of catalog) {
    if (p.wired) continue;
    lines.push(theme.dim(`    ${theme.glyphs.bulletOpen} ${p.label} — ${p.blurb} · coming soon`));
  }
  lines.push(theme.dim('  type a number to switch, or press enter to cancel'));
  return lines.join('\n');
};

// The /theme list (spec §2.1): each built-in with a live swatch; the active one marked.
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

// /plan is a visible stub at M3 (D-030): reserve the verb honestly, don't fake a planning UI.
export const renderPlanStub = (theme: Theme): string =>
  theme.dim("  plan-mode is coming — for now, just describe the task and I'll work it directly.");

// Selecting a not-yet-wired provider (D-029): a one-line honest hint, never a fake flow.
export const renderComingSoon = (theme: Theme, label: string): string =>
  theme.dim(`  ${label} isn't wired yet — BYOK/login for more providers lands in M4.`);
