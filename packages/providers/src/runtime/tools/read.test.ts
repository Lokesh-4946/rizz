import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentHash } from '../hash.js';
import { readTool } from './read.js';

async function tmpFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rizz-read-'));
  const path = join(dir, 'a.txt');
  await writeFile(path, content, 'utf8');
  return path;
}

describe('readTool', () => {
  it('returns content and a full-file hash usable as an edit anchor', async () => {
    const path = await tmpFile('a\nb\nc\n');
    const result = await readTool({ path });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hash).toBe(contentHash('a\nb\nc\n'));
      expect(result.value.totalLines).toBe(4); // trailing newline → empty final element
      expect(result.value.truncated).toBe(false);
    }
  });

  it('paginates with offset/limit and reports truncation against the full file', async () => {
    const path = await tmpFile('l0\nl1\nl2\nl3\nl4');
    const result = await readTool({ path, offset: 1, limit: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('l1\nl2');
      expect(result.value.truncated).toBe(true);
      // hash is of the whole file, not the slice.
      expect(result.value.hash).toBe(contentHash('l0\nl1\nl2\nl3\nl4'));
    }
  });

  it('returns TOOL_IO for a missing file', async () => {
    const result = await readTool({ path: '/no/such/rizz/file.txt' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOOL_IO');
  });
});
