// `edit` tool (design §2.3) — exact-match string replace, hash-anchored, then edit-verified.
//
// Three guards make this the reliability headline:
//   1. STALE_FILE     — if a `baseHash` is supplied and the file's current hash differs, the file
//                       moved under us; we refuse to apply a stale diff (the #1 user pain).
//   2. AMBIGUOUS_MATCH — if `oldText` occurs more than once we refuse rather than edit the first hit
//                       (the wrong-place-match failure, Aider #15951 analogue); ask for more context.
//   3. NO_MATCH       — if `oldText` is absent, fail loudly instead of writing nothing silently.
//
// Matching is EOL-agnostic (we normalize both sides to LF) but the written result is converted back
// to the file's original line-ending style, so a CRLF file is never silently rewritten to LF.

import { readFile } from 'node:fs/promises';
import { type Result, RizzError, err } from '../../result.js';
import { applyEol, detectEol } from '../eol.js';
import { contentHash } from '../hash.js';
import { type VerifiedWrite, verifyWrite } from '../verify.js';

export interface EditParams {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  /** Optional anchor captured at read time. If present and stale, the edit fails with STALE_FILE. */
  readonly baseHash?: string;
}

export interface EditResult extends VerifiedWrite {
  readonly replacements: number;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

export async function editTool(params: EditParams): Promise<Result<EditResult>> {
  if (params.oldText === '') {
    return err(new RizzError('NO_MATCH', 'edit oldText is empty — nothing to match'));
  }

  let raw: string;
  try {
    raw = await readFile(params.path, 'utf8');
  } catch (cause) {
    return err(new RizzError('TOOL_IO', `cannot read ${params.path} to edit`, { cause }));
  }

  if (params.baseHash !== undefined && contentHash(raw) !== params.baseHash) {
    return err(
      new RizzError('STALE_FILE', `${params.path} changed since it was read — re-read before editing`),
    );
  }

  const eol = detectEol(raw);
  const rawLf = raw.replace(/\r\n/g, '\n');
  const oldLf = params.oldText.replace(/\r\n/g, '\n');
  const newLf = params.newText.replace(/\r\n/g, '\n');

  const occurrences = countOccurrences(rawLf, oldLf);
  if (occurrences === 0) {
    return err(new RizzError('NO_MATCH', `oldText not found in ${params.path}`));
  }
  if (occurrences > 1) {
    return err(
      new RizzError(
        'AMBIGUOUS_MATCH',
        `oldText matches ${occurrences}× in ${params.path} — add surrounding context to disambiguate`,
      ),
    );
  }

  const resultLf = rawLf.replace(oldLf, newLf);
  const intended = applyEol(resultLf, eol);

  const written = await verifyWrite(params.path, intended);
  if (!written.ok) return written;
  return { ok: true, value: { ...written.value, replacements: 1 } };
}
