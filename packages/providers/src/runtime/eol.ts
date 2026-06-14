// Line-ending detection and preservation. CRLF false-positives are a documented harness failure
// (latent-demands §1, issue #13456: a write "succeeds" but the verify compares LF-normalized text
// to CRLF on disk and reports a phantom mismatch). The rule (design §2.4 step 1): detect the file's
// original style BEFORE editing and preserve it on write — never normalize-to-LF-then-compare.

export type Eol = 'lf' | 'crlf';

/** The dominant line-ending style of existing content. Defaults to LF when there are no newlines. */
export function detectEol(content: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== '\n') continue;
    if (i > 0 && content[i - 1] === '\r') {
      crlf += 1;
    } else {
      lf += 1;
    }
  }
  return crlf > lf ? 'crlf' : 'lf';
}

/** Rewrite all newlines in `content` to the given style (idempotent; normalizes CRLF→LF first). */
export function applyEol(content: string, eol: Eol): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
}
