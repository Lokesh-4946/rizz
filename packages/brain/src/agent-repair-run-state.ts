import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

interface RepairFailure {
  readonly code: string;
  readonly message: string;
}

export type RepairStateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RepairFailure };

export interface RepairRunState {
  readonly schema_version: 1;
  readonly ownership: string;
  readonly run_id: string;
  readonly handoff_id: string;
  readonly project_id: string;
  readonly repository_revision: string;
  readonly agent: 'codex' | 'claude' | 'copilot';
  readonly approved: true;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly worktree: {
    readonly root: string;
    readonly git_dir: string;
    readonly common_dir: string;
    readonly isolated: true;
  };
  readonly output: {
    readonly exit_code: number | null;
    readonly stdout_bytes: number;
    readonly stderr_bytes: number;
    readonly digest: string | null;
    readonly truncated: boolean;
  };
  readonly error: RepairFailure | null;
}

const MAX_REPAIR_STATE_BYTES = 64 * 1024;

function failure(code: string, message: string): RepairStateResult<never> {
  return { ok: false, error: { code, message } };
}

export function isRepairRunId(value: string): boolean {
  return /^repair-run-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}

export async function secureRepairRunsDirectory(
  projectDir: string,
): Promise<RepairStateResult<string>> {
  const workDir = join(projectDir, 'work');
  const runsDir = join(workDir, 'repair-runs');
  try {
    const work = await lstat(workDir);
    if (work.isSymbolicLink() || !work.isDirectory()) {
      return failure('REPAIR_STATE_PATH_UNSAFE', 'Repair work state must be a real directory.');
    }
    const existing = await lstat(runsDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (existing !== null && (existing.isSymbolicLink() || !existing.isDirectory())) {
      return failure('REPAIR_STATE_PATH_UNSAFE', 'Repair run state must be a real directory.');
    }
    await mkdir(runsDir, { recursive: true });
    const projectReal = await realpath(projectDir);
    const runsReal = await realpath(runsDir);
    const created = await lstat(runsDir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      return failure('REPAIR_STATE_PATH_UNSAFE', 'Repair run state must be a real directory.');
    }
    const local = relative(projectReal, runsReal);
    if (
      local.startsWith('..') ||
      isAbsolute(local) ||
      runsReal !== join(projectReal, 'work', 'repair-runs')
    ) {
      return failure('REPAIR_STATE_PATH_UNSAFE', 'Repair run state escaped the project store.');
    }
    return { ok: true, value: runsReal };
  } catch (error: unknown) {
    return failure(
      'REPAIR_STATE_WRITE_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function writeVerifiedRepairRunState(
  path: string,
  value: unknown,
): Promise<RepairStateResult<true>> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
    if ((await readFile(path, 'utf8')) !== contents) {
      return failure('REPAIR_STATE_VERIFY_FAILED', 'Repair run state verification failed.');
    }
    return { ok: true, value: true };
  } catch (error: unknown) {
    return failure(
      'REPAIR_STATE_WRITE_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRepairRunState(value: unknown): value is RepairRunState {
  if (!isRecord(value) || !isRecord(value.worktree) || !isRecord(value.output)) return false;
  const error = value.error;
  const isRunning = value.status === 'running';
  return (
    value.schema_version === 1 &&
    typeof value.ownership === 'string' &&
    isRepairRunId(typeof value.run_id === 'string' ? value.run_id : '') &&
    typeof value.handoff_id === 'string' &&
    /^[a-f0-9]{64}$/.test(value.handoff_id) &&
    typeof value.project_id === 'string' &&
    value.project_id.length > 0 &&
    typeof value.repository_revision === 'string' &&
    /^[a-f0-9]{40,64}$/.test(value.repository_revision) &&
    (value.agent === 'codex' || value.agent === 'claude' || value.agent === 'copilot') &&
    value.approved === true &&
    typeof value.started_at === 'string' &&
    (value.finished_at === null || typeof value.finished_at === 'string') &&
    (value.status === 'running' ||
      value.status === 'completed' ||
      value.status === 'failed' ||
      value.status === 'cancelled') &&
    (isRunning ? value.finished_at === null : typeof value.finished_at === 'string') &&
    typeof value.worktree.root === 'string' &&
    isAbsolute(value.worktree.root) &&
    typeof value.worktree.git_dir === 'string' &&
    isAbsolute(value.worktree.git_dir) &&
    typeof value.worktree.common_dir === 'string' &&
    isAbsolute(value.worktree.common_dir) &&
    value.worktree.isolated === true &&
    (value.output.exit_code === null || isNonNegativeInteger(value.output.exit_code)) &&
    isNonNegativeInteger(value.output.stdout_bytes) &&
    isNonNegativeInteger(value.output.stderr_bytes) &&
    (value.output.digest === null ||
      (typeof value.output.digest === 'string' && /^[a-f0-9]{64}$/.test(value.output.digest))) &&
    typeof value.output.truncated === 'boolean' &&
    (error === null ||
      (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string'))
  );
}

export async function readRepairRunState(path: string): Promise<RepairStateResult<RepairRunState>> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      return failure('REPAIR_STATE_PATH_UNSAFE', 'Repair run state must be a real file.');
    }
    if (entry.size > MAX_REPAIR_STATE_BYTES) {
      return failure('REPAIR_RUN_INVALID', 'Repair run state exceeds the 64 KiB limit.');
    }
    const contents = await readFile(path, 'utf8');
    if (Buffer.byteLength(contents) > MAX_REPAIR_STATE_BYTES) {
      return failure('REPAIR_RUN_INVALID', 'Repair run state exceeds the 64 KiB limit.');
    }
    const parsed: unknown = JSON.parse(contents);
    if (!isRepairRunState(parsed)) {
      return failure('REPAIR_RUN_INVALID', 'Repair run state is malformed.');
    }
    return { ok: true, value: parsed };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return failure('REPAIR_RUN_NOT_FOUND', 'Repair run state was not found.');
    }
    return failure('REPAIR_RUN_INVALID', error instanceof Error ? error.message : String(error));
  }
}
