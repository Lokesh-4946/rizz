import { describe, expect, it } from 'vitest';
import { renderEmptyState, renderHeader, renderStatusBar } from './render.js';
import { createTheme } from './theme.js';

const plain = createTheme({ color: false });

describe('tui render (plain theme)', () => {
  it('header shows the internal name + model, no ANSI', () => {
    const header = renderHeader(plain, 'demo (no provider)');
    expect(header).toContain('rizz');
    expect(header).toContain('demo (no provider)');
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
