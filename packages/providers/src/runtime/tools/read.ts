// `read` tool (design §2.1). Returns file content plus a full-file content hash that anchors a
// later `edit` (the hash lets edit detect a file that changed under us — design §2.3). Text defaults
// to the first 2000 lines (Pi parity); offset/limit page through larger files.

import { readFile } from 'node:fs/promises';
import { type Result, RizzError, err, ok } from '../../result.js';
import { type Eol, detectEol } from '../eol.js';
import { contentHash } from '../hash.js';

const DEFAULT_LINE_LIMIT = 2000;

export interface ReadParams {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadResult {
  readonly content: string;
  /** Hash of the FULL file (not the returned slice) — the anchor an `edit` passes as `baseHash`. */
  readonly hash: string;
  readonly eol: Eol;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export async function readTool(params: ReadParams): Promise<Result<ReadResult>> {
  let raw: string;
  try {
    raw = await readFile(params.path, 'utf8');
  } catch (cause) {
    return err(new RizzError('TOOL_IO', `cannot read ${params.path}`, { cause }));
  }

  const eol = detectEol(raw);
  const hash = contentHash(raw);
  const lines = raw.split('\n');
  const totalLines = lines.length;

  const offset = Math.max(0, params.offset ?? 0);
  const limit = params.limit ?? DEFAULT_LINE_LIMIT;
  const slice = lines.slice(offset, offset + limit);
  const truncated = offset > 0 || offset + limit < totalLines;

  return ok({ content: slice.join('\n'), hash, eol, totalLines, truncated });
}
