import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_THEMES, THEME_NAMES, createTheme, detectColorDepth } from './theme.js';

describe('createTheme — color-depth ladder', () => {
  it('emits 24-bit SGR at truecolor', () => {
    const t = createTheme({ depth: 'truecolor' });
    expect(t.accent('x')).toContain('\x1b[38;2;');
  });

  it('emits a 256-color index at depth 256', () => {
    const s = createTheme({ depth: '256' }).accent('x');
    expect(s.startsWith('\x1b[38;5;')).toBe(true);
  });

  it('emits a 16-color SGR code at depth 16 (not 24-bit or 256)', () => {
    const s = createTheme({ depth: '16' }).accent('x');
    expect(s.startsWith('\x1b[')).toBe(true);
    expect(s).not.toContain('38;2;');
    expect(s).not.toContain('38;5;');
  });

  it('emits plain strings at depth none', () => {
    const t = createTheme({ depth: 'none' });
    expect(t.accent('x')).toBe('x');
  });

  it('maps the back-compat color flag', () => {
    expect(createTheme({ color: true }).depth).toBe('truecolor');
    expect(createTheme({ color: false }).depth).toBe('none');
  });

  it('uses Unicode glyphs on rich rungs and ASCII on the lean ones', () => {
    expect(createTheme({ depth: 'truecolor' }).glyphs.check).toBe('✓');
    expect(createTheme({ depth: '16' }).glyphs.check).toBe('[ok]');
    expect(createTheme({ depth: 'none' }).glyphs.caret).toBe('>');
  });

  it('selects a built-in theme by name and falls back to valoir for unknown', () => {
    expect(createTheme({ depth: 'none', spec: 'nord' }).name).toBe('nord');
    expect(createTheme({ depth: 'none', spec: 'does-not-exist' }).name).toBe('valoir');
  });

  it('ships the five built-ins', () => {
    expect(THEME_NAMES).toEqual(['valoir', 'gruvbox', 'nord', 'paper', 'high-contrast']);
    for (const name of THEME_NAMES) expect(BUILTIN_THEMES[name]?.palette.accent).toBeDefined();
  });
});

describe('detectColorDepth', () => {
  const saved = { ...process.env };
  let savedIsTty: boolean | undefined;
  beforeEach(() => {
    savedIsTty = process.stdout.isTTY;
  });
  afterEach(() => {
    process.env = { ...saved };
    Object.defineProperty(process.stdout, 'isTTY', { value: savedIsTty, configurable: true });
  });

  const setTty = (v: boolean): void => {
    Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
  };

  // detectColorDepth only reads NO_COLOR, COLORTERM, TERM + stdout.isTTY, so a minimal env per case
  // is sufficient (and avoids `delete`, which Biome flags).
  it('returns none when not a TTY', () => {
    setTty(false);
    process.env = {};
    expect(detectColorDepth()).toBe('none');
  });

  it('returns none when NO_COLOR is set even on a TTY', () => {
    setTty(true);
    process.env = { NO_COLOR: '1' };
    expect(detectColorDepth()).toBe('none');
  });

  it('returns truecolor when COLORTERM=truecolor', () => {
    setTty(true);
    process.env = { COLORTERM: 'truecolor' };
    expect(detectColorDepth()).toBe('truecolor');
  });

  it('returns 256 for a *-256color TERM', () => {
    setTty(true);
    process.env = { TERM: 'xterm-256color' };
    expect(detectColorDepth()).toBe('256');
  });

  it('returns 16 for a bare TTY', () => {
    setTty(true);
    process.env = { TERM: 'xterm' };
    expect(detectColorDepth()).toBe('16');
  });
});
