export type StaffErrorCode =
  | 'NOT_INITIALIZED'
  | 'BAD_REQUEST'
  | 'INVALID_STATE'
  | 'IO_FAILED'
  | 'WRITE_VERIFY_FAILED'
  | 'HOST_UNKNOWN'
  | 'CODEX_ROLLUP_COMPRESSED';

export interface StaffError {
  readonly code: StaffErrorCode;
  readonly message: string;
}

export type StaffResult<T> = { ok: true; value: T } | { ok: false; error: StaffError };

export function staffOk<T>(value: T): StaffResult<T> {
  return { ok: true, value };
}

export function staffErr(code: StaffErrorCode, message: string): StaffResult<never> {
  return { ok: false, error: { code, message } };
}
