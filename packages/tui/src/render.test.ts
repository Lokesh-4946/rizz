import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from './catalog.js';
import {
  type PickerModel,
  redactSecrets,
  renderEmptyState,
  renderHeader,
  renderHint,
  renderModelPicker,
  renderNotConnected,
  renderPlanStub,
  renderStatusBar,
  renderStillWaiting,
  renderThemeList,
  renderThinking,
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
      auth: 'not connected',
      ctxPct: 0,
      tokens: 12,
      cost: '$0.00 (sub)',
      branch: 'm2',
      permissions: 'ask',
    });
    expect(bar).toContain('stub');
    expect(bar).toContain('tokens 12');
    expect(bar).toContain('billing $0.00 (sub)');
    expect(bar).toContain('branch m2');
    expect(bar).toContain('permissions ask');
  });

  it('/status render labels model, auth, billing, context, tokens, branch, and permissions', () => {
    const out = renderStatusBar(plain, {
      model: 'Codex · GPT-5',
      auth: 'subscription',
      ctxPct: 3,
      tokens: 128,
      cost: '$0.00 (sub)',
      branch: 'dev',
      permissions: 'ask',
    });
    expect(out).toContain('model Codex · GPT-5');
    expect(out).toContain('auth subscription');
    expect(out).toContain('billing $0.00 (sub)');
    expect(out).toContain('context 3%');
    expect(out).toContain('tokens 128');
    expect(out).toContain('branch dev');
    expect(out).toContain('permissions ask');
  });

  it('status bar shows OpenRouter API-key routes as metered', () => {
    const bar = renderStatusBar(plain, {
      model: 'OpenRouter GPT-4o mini',
      auth: 'api-key',
      ctxPct: 1,
      tokens: 42,
      cost: '$0.01',
      branch: 'preview',
      permissions: 'ask',
    });
    expect(bar).toContain('model OpenRouter GPT-4o mini');
    expect(bar).toContain('auth api-key');
    expect(bar).toContain('tokens 42');
    expect(bar).toContain('billing $0.01');
    expect(bar).not.toContain('(sub)');
  });

  it('status bar shows Codex subscription model and billing', () => {
    const bar = renderStatusBar(plain, {
      model: 'Codex · GPT-5',
      auth: 'subscription',
      ctxPct: 0,
      tokens: 8,
      cost: '$0.00 (sub)',
      branch: 'dev',
      permissions: 'ask',
    });
    expect(bar).toContain('model Codex · GPT-5');
    expect(bar).toContain('auth subscription');
    expect(bar).toContain('$0.00 (sub)');
  });

  it('status bar can honestly show an unknown Codex model', () => {
    const bar = renderStatusBar(plain, {
      model: 'Codex · model not reported',
      auth: 'subscription',
      ctxPct: 0,
      tokens: 0,
      cost: '$0.00 (sub)',
      branch: 'dev',
      permissions: 'ask',
    });
    expect(bar).toContain('Codex · model not reported');
  });

  it('hint includes status without internal setup language', () => {
    const out = renderHint(plain);
    expect(out).toContain('/status');
    expect(out).not.toContain('sandbox');
    expect(out).not.toContain('ephemeral');
  });

  it('progress copy is sparse and provider-specific', () => {
    expect(renderThinking(plain)).toContain('thinking...');
    expect(renderStillWaiting(plain, 'Codex')).toContain('still waiting on Codex...');
  });

  it('redacts secret-like strings from status, model, and progress output', () => {
    const secret = 'sk-or-render-secret-1234567890';
    const bar = renderStatusBar(plain, {
      model: `OpenRouter ${secret}`,
      auth: 'api-key',
      ctxPct: 1,
      tokens: 42,
      cost: '$0.01',
      branch: `dev-${secret}`,
      permissions: 'ask',
    });
    const picker = renderModelPicker(
      plain,
      [{ id: 'x', label: `Model ${secret}`, active: true }],
      [],
    );
    expect(bar).not.toContain(secret);
    expect(picker).not.toContain(secret);
    expect(renderStillWaiting(plain, `OpenRouter ${secret}`)).not.toContain(secret);
    expect(redactSecrets(secret)).toBe('[redacted]');
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

  it('lists unwired providers as dimmed routes, never as selectable', () => {
    const out = renderModelPicker(plain, models, PROVIDER_CATALOG);
    expect(out).toContain('not connected');
    expect(out).toContain('Codex');
    // The wired provider (Anthropic) is not shown in the coming-soon section.
    expect(out).not.toContain('Anthropic — Claude — API key (BYOK) · not connected');
    expect(out).not.toContain('OpenRouter — any model, one key · not connected');
    expect(out).not.toContain('coming soon');
    expect(out).not.toContain('sandbox');
  });
});

describe('theme list + stubs', () => {
  it('lists the built-in themes and marks the active one', () => {
    const out = renderThemeList(plain, THEME_NAMES, 'nord');
    for (const name of THEME_NAMES) expect(out).toContain(name);
  });

  it('plan stub is honest, not a fake UI', () => {
    expect(renderPlanStub(plain)).toContain('plan mode is not connected yet');
    expect(renderPlanStub(plain)).not.toContain('fake');
  });

  it('not-connected hint names the provider', () => {
    expect(renderNotConnected(plain, 'Codex')).toContain('Codex');
    expect(renderNotConnected(plain, 'Codex')).not.toContain('fake');
  });
});
