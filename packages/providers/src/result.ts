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
