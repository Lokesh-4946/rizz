// The Result type every service returns. Expected failures (network, provider 4xx/5xx, bad tool
// calls, failed patches) come back as `{ ok: false }` — the orchestration layer classifies and
// decides retry/fallback/surface. Throwing is reserved for programmer error. See CLAUDE.md.

/** Stable, user-facing error codes. Extend as the harness grows. */
export type RizzErrorCode =
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'BAD_TOOL_CALL'
  | 'EDIT_VERIFY_FAILED'
  // Edit sub-failures kept distinct from EDIT_VERIFY_FAILED so the loop can react precisely (design
  // §2.3/§2.4): the file moved under us, the search text is ambiguous, or it was not found at all.
  | 'STALE_FILE'
  | 'AMBIGUOUS_MATCH'
  | 'NO_MATCH'
  // A tool's underlying I/O failed (file not found, permission denied, command spawn error).
  | 'TOOL_IO'
  | 'BUDGET_EXCEEDED'
  | 'INTERRUPTED'
  | 'UNKNOWN';

/** A user-facing error with a stable code. Never surface a raw stack to the user. */
export class RizzError extends Error {
  readonly code: RizzErrorCode;
  constructor(code: RizzErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RizzError';
    this.code = code;
  }
}

export type Result<T, E = RizzError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E = RizzError>(error: E): Result<never, E> => ({ ok: false, error });
