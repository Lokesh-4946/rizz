import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from './catalog.js';
import {
  type PickerModel,
  renderComingSoon,
  renderEmptyState,
  renderHeader,
  renderModelPicker,
  renderPlanStub,
  renderStatusBar,
  renderThemeList,
} from './render.js';
import { THEME_NAMES, createTheme } from './theme.js';

const plain = createTheme({ color: false });

describe('tui render (plain theme)', () => {
  it('header shows the internal name + model, no ANSI', () => {
    const header = renderHeader(plain, 'no model');
    expect(header).toContain('rizz');
    expect(header).toContain('no model');
    expect(header).not.toContain('\x1b[');
  });

  it('empty state is an invitation, not blank', () => {
    expect(renderEmptyState(plain)).toContain('/help');
  });

  it('status bar shows model, tokens, cost, branch', () => {
    const bar = renderStatusBar(plain, {
      model: 'stub',
      auth: 'demo',
      ctxPct: 0,
      tokens: 12,
      cost: '$0.00 (sub)',
      branch: 'm2',
    });
    expect(bar).toContain('stub');
    expect(bar).toContain('12 tok · $0.00 (sub)');
    expect(bar).toContain('⎇m2');
  });

  it('color theme wraps text in truecolor ANSI (valoir gold)', () => {
    const colored = createTheme({ color: true }).accent('x');
    expect(colored).toContain('\x1b[38;2;227;179;65m');
  });
});

describe('model picker (D-029)', () => {
  const models: PickerModel[] = [
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', active: true },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', active: false },
  ];

  it('numbers the selectable models and marks the active one', () => {
    const out = renderModelPicker(plain, models, PROVIDER_CATALOG);
    expect(out).toContain('1. Claude Opus 4.8');
    expect(out).toContain('2. Claude Haiku 4.5');
  });

  it('lists unwired providers as dimmed "coming soon", never as selectable', () => {
    const out = renderModelPicker(plain, models, PROVIDER_CATALOG);
    expect(out).toContain('coming soon');
    expect(out).toContain('Codex');
    // The wired provider (Anthropic) is not shown in the coming-soon section.
    expect(out).not.toContain('Anthropic — Claude — API key (BYOK) · coming soon');
  });
});

describe('theme list + stubs', () => {
  it('lists the built-in themes and marks the active one', () => {
    const out = renderThemeList(plain, THEME_NAMES, 'nord');
    for (const name of THEME_NAMES) expect(out).toContain(name);
  });

  it('plan stub is honest, not a fake UI', () => {
    expect(renderPlanStub(plain)).toContain('plan-mode is coming');
  });

  it('coming-soon hint names the provider', () => {
    expect(renderComingSoon(plain, 'Codex')).toContain('Codex');
  });
});
