import { describe, expect, it } from 'vitest';
import { applyEol, detectEol } from './eol.js';

describe('detectEol', () => {
  it('defaults to lf with no newlines', () => {
    expect(detectEol('no newlines here')).toBe('lf');
  });
  it('detects lf-dominant content', () => {
    expect(detectEol('a\nb\nc\n')).toBe('lf');
  });
  it('detects crlf-dominant content', () => {
    expect(detectEol('a\r\nb\r\nc\r\n')).toBe('crlf');
  });
  it('does not count the lf inside a crlf as a lone lf', () => {
    // 3 CRLF, 0 lone LF → crlf.
    expect(detectEol('x\r\ny\r\nz\r\n')).toBe('crlf');
  });
});

describe('applyEol', () => {
  it('converts lf to crlf and back idempotently', () => {
    expect(applyEol('a\nb', 'crlf')).toBe('a\r\nb');
    expect(applyEol('a\r\nb', 'lf')).toBe('a\nb');
    expect(applyEol('a\r\nb', 'crlf')).toBe('a\r\nb');
  });
});
