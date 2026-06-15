// Small shared helpers for HTTP model adapters: map a status to a stable RizzError code, and redact a
// secret from any text before it could be surfaced. Shared so every adapter classifies + redacts the
// same way (and to avoid per-adapter drift).

import type { RizzErrorCode } from '../result.js';

/** Map an HTTP status to a stable error code the loop can classify (design §5). */
export function codeForStatus(status: number): RizzErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH';
  if (status === 429) return 'PROVIDER_RATE_LIMIT';
  // 408/409/5xx (incl. provider "overloaded") are transient → fallback/retry.
  if (status === 408 || status === 409 || status >= 500) return 'PROVIDER_UNAVAILABLE';
  // Other 4xx (400/404/422…) are caller-side and non-retryable → surface, don't loop.
  return 'UNKNOWN';
}

/** Remove a secret from text before it could be surfaced (defense in depth — the key isn't logged). */
export function redact(text: string, secret: string): string {
  return secret === '' ? text : text.split(secret).join('«redacted»');
}
