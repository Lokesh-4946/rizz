import { describe, expect, it } from 'vitest';
import { parseCommand, parseThemeArg } from './commands.js';

describe('parseCommand', () => {
  it('treats plain text as chat', () => {
    expect(parseCommand('fix my auth bug')).toEqual({ kind: 'chat', text: 'fix my auth bug' });
  });

  it('treats blank input as empty', () => {
    expect(parseCommand('   ')).toEqual({ kind: 'empty' });
  });

  it.each([
    ['/login', 'login'],
    ['/model', 'model'],
    ['/status', 'status'],
    ['/plan', 'plan'],
    ['/workspace', 'workspace'],
    ['/help', 'help'],
    ['/exit', 'exit'],
    ['/quit', 'exit'],
  ])('parses %s', (line, kind) => {
    expect(parseCommand(line).kind).toBe(kind);
  });

  it('parses /theme with and without an argument', () => {
    expect(parseCommand('/theme')).toEqual({ kind: 'theme' });
    expect(parseCommand('/theme set nord')).toEqual({ kind: 'theme', arg: 'set nord' });
  });

  it('reports an unknown command rather than treating it as chat', () => {
    expect(parseCommand('/frobnicate')).toEqual({ kind: 'unknown', name: 'frobnicate' });
  });

  it('is case-insensitive for the command word', () => {
    expect(parseCommand('/LOGIN').kind).toBe('login');
  });
});

describe('parseThemeArg', () => {
  it('returns undefined for a bare list', () => {
    expect(parseThemeArg(undefined)).toBeUndefined();
    expect(parseThemeArg('')).toBeUndefined();
  });

  it('reads "set <name>" and a bare name', () => {
    expect(parseThemeArg('set nord')).toBe('nord');
    expect(parseThemeArg('gruvbox')).toBe('gruvbox');
  });
});
