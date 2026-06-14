import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeTool } from './write.js';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rizz-write-'));
}

describe('writeTool', () => {
  it('creates a new file, auto-creating parent dirs, and verifies', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'nested', 'deep', 'a.txt');
    const result = await writeTool({ path, content: 'hello\nworld\n' });
    expect(result.ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('hello\nworld\n');
  });

  it('overwriting a CRLF file preserves CRLF even if new content uses LF', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'a.txt');
    await writeFile(path, 'old\r\nlines\r\n', 'utf8');
    const result = await writeTool({ path, content: 'new\nlines\nhere\n' });
    expect(result.ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('new\r\nlines\r\nhere\r\n');
  });

  it('returns a verified hash that matches the bytes on disk', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'a.txt');
    const result = await writeTool({ path, content: 'content' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { contentHash } = await import('../hash.js');
      expect(result.value.newHash).toBe(contentHash('content'));
    }
  });
});
