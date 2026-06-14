import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '../hash.js';
import { editTool } from './edit.js';

const dirs: string[] = [];
async function tmpFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rizz-edit-'));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}
afterEach(() => {
  dirs.length = 0;
});

describe('editTool', () => {
  it('replaces a unique snippet and verifies the bytes landed', async () => {
    const path = await tmpFile('a.txt', 'const x = 1;\nconst y = 2;\n');
    const result = await editTool({ path, oldText: 'const x = 1;', newText: 'const x = 42;' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.replacements).toBe(1);
    expect(await readFile(path, 'utf8')).toBe('const x = 42;\nconst y = 2;\n');
  });

  it('fails AMBIGUOUS_MATCH when oldText occurs more than once', async () => {
    const path = await tmpFile('a.txt', 'dup\ndup\n');
    const result = await editTool({ path, oldText: 'dup', newText: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AMBIGUOUS_MATCH');
    // Unchanged on disk — never edits the first hit.
    expect(await readFile(path, 'utf8')).toBe('dup\ndup\n');
  });

  it('fails NO_MATCH when oldText is absent', async () => {
    const path = await tmpFile('a.txt', 'hello\n');
    const result = await editTool({ path, oldText: 'goodbye', newText: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_MATCH');
  });

  it('fails NO_MATCH on empty oldText', async () => {
    const path = await tmpFile('a.txt', 'hello\n');
    const result = await editTool({ path, oldText: '', newText: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_MATCH');
  });

  it('fails STALE_FILE when the baseHash no longer matches', async () => {
    const path = await tmpFile('a.txt', 'original\n');
    const staleHash = contentHash('something else entirely');
    const result = await editTool({
      path,
      oldText: 'original',
      newText: 'new',
      baseHash: staleHash,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('STALE_FILE');
  });

  it('applies when the baseHash matches the current file', async () => {
    const path = await tmpFile('a.txt', 'original\n');
    const goodHash = contentHash('original\n');
    const result = await editTool({
      path,
      oldText: 'original',
      newText: 'new',
      baseHash: goodHash,
    });
    expect(result.ok).toBe(true);
  });

  it('preserves CRLF line endings — never normalizes to LF (the #13456 failure)', async () => {
    const path = await tmpFile('a.txt', 'one\r\ntwo\r\nthree\r\n');
    // The model sends oldText with LF; matching is EOL-agnostic but output stays CRLF.
    const result = await editTool({ path, oldText: 'two', newText: 'TWO' });
    expect(result.ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('one\r\nTWO\r\nthree\r\n');
  });
});
