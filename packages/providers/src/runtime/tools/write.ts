// `write` tool (design §2.2). Creates or overwrites a file (auto-creating parent dirs) and then
// runs the edit-verify contract. When overwriting an existing file we preserve that file's existing
// line-ending style so a CRLF file stays CRLF (design §2.4 step 1) — a brand-new file keeps the
// content exactly as provided.

import { readFile } from 'node:fs/promises';
import { type Result } from '../../result.js';
import { applyEol, detectEol } from '../eol.js';
import { type VerifiedWrite, verifyWrite } from '../verify.js';

export interface WriteParams {
  readonly path: string;
  readonly content: string;
}

export type WriteResult = VerifiedWrite;

export async function writeTool(params: WriteParams): Promise<Result<WriteResult>> {
  let intended = params.content;
  try {
    const existing = await readFile(params.path, 'utf8');
    intended = applyEol(params.content, detectEol(existing));
  } catch {
    // New file (or unreadable): write the content as given. verifyWrite reports any real I/O error.
  }
  return verifyWrite(params.path, intended);
}
