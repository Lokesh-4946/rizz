// The edit-verify-after-write contract (NON-NEGOTIABLE — brief §3.6, design §2.4). Applied by both
// `write` and `edit`: after touching disk we re-read from a fresh handle and confirm the bytes match
// what we intended, byte-for-byte. A write that can't be verified is a FAILURE (EDIT_VERIFY_FAILED),
// never a silent success or a warning. This targets the #1 real-world harness failure.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Result, RizzError, err, ok } from '../result.js';
import { contentHash } from './hash.js';

export interface VerifiedWrite {
  readonly path: string;
  readonly bytesWritten: number;
  readonly newHash: string;
}

/**
 * Write `intendedContent` to `path` (creating parent dirs), then re-read and confirm byte-for-byte.
 * `intendedContent` must already be in the file's intended line-ending style — EOL normalization is
 * the caller's job (see eol.ts), because comparing here must be against the exact bytes written.
 */
export async function verifyWrite(
  path: string,
  intendedContent: string,
): Promise<Result<VerifiedWrite>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, intendedContent, 'utf8');
  } catch (cause) {
    return err(new RizzError('TOOL_IO', `could not write ${path}`, { cause }));
  }

  let reread: string;
  try {
    // Fresh read, no cache: a write that "succeeds" but lands wrong must be caught here.
    reread = await readFile(path, 'utf8');
  } catch (cause) {
    return err(
      new RizzError('EDIT_VERIFY_FAILED', `could not re-read ${path} to verify`, { cause }),
    );
  }

  const expectedHash = contentHash(intendedContent);
  const actualHash = contentHash(reread);
  if (actualHash !== expectedHash) {
    return err(
      new RizzError(
        'EDIT_VERIFY_FAILED',
        `write to ${path} did not land byte-for-byte (expected ${expectedHash}, on disk ${actualHash})`,
      ),
    );
  }

  return ok({
    path,
    bytesWritten: Buffer.byteLength(intendedContent, 'utf8'),
    newHash: actualHash,
  });
}
