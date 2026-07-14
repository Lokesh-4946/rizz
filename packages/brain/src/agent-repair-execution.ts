import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  type AgentRepairBridgeProcess,
  type AgentRepairExecutor,
  type AgentRepairExecutorResult,
  runAgentRepairBridge,
} from './agent-repair-bridge-service.js';
import { type RepairHandoffAgent, previewAgentRepairHandoff } from './agent-repair-handoff.js';
import { readProjectStore } from './project-store.js';

interface RepairFailure {
  readonly code: string;
  readonly message: string;
}

type RepairResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RepairFailure };

interface WorktreeIdentity {
  readonly root: string;
  readonly git_dir: string;
  readonly common_dir: string;
  readonly isolated: true;
}

type RepairRunStatus = 'completed' | 'failed' | 'cancelled';

export interface AgentRepairExecution {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly handoff_id: string;
  readonly project_id: string;
  readonly repository_revision: string;
  readonly agent: RepairHandoffAgent;
  readonly status: RepairRunStatus;
  readonly approved: true;
  readonly started_at: string;
  readonly finished_at: string;
  readonly worktree: WorktreeIdentity;
  readonly result: AgentRepairBridgeProcess | null;
  readonly error: RepairFailure | null;
  readonly state_path: string;
  readonly constraints: {
    readonly exact_handoff_required: true;
    readonly isolated_worktree_required: true;
    readonly repository_push_allowed: false;
    readonly provider_calls_required: true;
    readonly network_required: true;
  };
}

export type { AgentRepairExecutor } from './agent-repair-bridge-service.js';

function failure(code: string, message: string): RepairResult<never> {
  return { ok: false, error: { code, message } };
}

function gitValue(rootDir: string, args: readonly string[]): string | null {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value === '' ? null : value;
}

async function worktreeIdentity(rootDir: string): Promise<RepairResult<WorktreeIdentity>> {
  const root = await realpath(rootDir);
  const top = gitValue(root, ['rev-parse', '--show-toplevel']);
  const gitDir = gitValue(root, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const commonDir = gitValue(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (top === null || gitDir === null || commonDir === null) {
    return failure('REPAIR_WORKTREE_INVALID', 'Agent repair requires a valid Git worktree.');
  }
  const resolvedTop = await realpath(top);
  const resolvedGitDir = await realpath(gitDir);
  const resolvedCommonDir = await realpath(commonDir);
  if (resolvedTop !== root) {
    return failure('REPAIR_WORKTREE_INVALID', 'Run agent repair from the prepared worktree root.');
  }
  if (resolvedGitDir === resolvedCommonDir) {
    return failure(
      'REPAIR_ISOLATED_WORKTREE_REQUIRED',
      'Agent repair must run in a linked, isolated Git worktree.',
    );
  }
  return {
    ok: true,
    value: {
      root,
      git_dir: resolvedGitDir,
      common_dir: resolvedCommonDir,
      isolated: true,
    },
  };
}

async function secureRunsDirectory(projectDir: string): Promise<RepairResult<string>> {
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
    if (existing?.isSymbolicLink() === true) {
      return failure('REPAIR_STATE_PATH_UNSAFE', 'Repair run state directory cannot be a symlink.');
    }
    await mkdir(runsDir, { recursive: true });
    const projectReal = await realpath(projectDir);
    const runsReal = await realpath(runsDir);
    const local = relative(projectReal, runsReal);
    if (local.startsWith('..') || isAbsolute(local)) {
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

async function writeVerifiedJson(path: string, value: unknown): Promise<RepairResult<true>> {
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

function outputEvidence(result: AgentRepairBridgeProcess | null): {
  readonly exit_code: number | null;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly digest: string | null;
  readonly truncated: boolean;
} {
  if (result === null) {
    return { exit_code: null, stdout_bytes: 0, stderr_bytes: 0, digest: null, truncated: false };
  }
  return {
    exit_code: result.exit_code,
    stdout_bytes: Buffer.byteLength(result.stdout),
    stderr_bytes: Buffer.byteLength(result.stderr),
    digest: createHash('sha256')
      .update(result.stdout)
      .update('\0')
      .update(result.stderr)
      .digest('hex'),
    truncated: result.output_truncated,
  };
}

function terminalOutcome(executed: AgentRepairExecutorResult): {
  readonly status: RepairRunStatus;
  readonly result: AgentRepairBridgeProcess | null;
  readonly error: RepairFailure | null;
} {
  if (!executed.ok) {
    return {
      status: executed.error.code === 'INTERRUPTED' ? 'cancelled' : 'failed',
      result: null,
      error: executed.error,
    };
  }
  if (executed.value.exit_code === 0) {
    return { status: 'completed', result: executed.value, error: null };
  }
  return {
    status: 'failed',
    result: executed.value,
    error: {
      code: 'REPAIR_BRIDGE_FAILED',
      message: `Agent repair bridge exited with code ${executed.value.exit_code}.`,
    },
  };
}

export async function executeAgentRepair(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly agent: string;
  readonly handoffId: string;
  readonly approved: boolean;
  readonly packetIds?: readonly string[];
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly executor?: AgentRepairExecutor;
}): Promise<RepairResult<AgentRepairExecution>> {
  if (!options.approved) {
    return failure(
      'REPAIR_APPROVAL_REQUIRED',
      'Agent repair execution requires explicit --approve confirmation.',
    );
  }
  if (!/^[a-f0-9]{64}$/.test(options.handoffId)) {
    return failure('REPAIR_HANDOFF_INVALID', 'Agent repair requires an exact handoff ID.');
  }
  const preview = await previewAgentRepairHandoff({
    rootDir: options.rootDir,
    ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
    agent: options.agent,
    ...(options.packetIds === undefined ? {} : { packetIds: options.packetIds }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  if (!preview.ok) return preview;
  if (preview.value.handoff_id !== options.handoffId) {
    return failure(
      'REPAIR_HANDOFF_STALE',
      'Repair handoff no longer matches the project, revision, packet artifact, or selection.',
    );
  }
  const worktree = await worktreeIdentity(options.rootDir);
  if (!worktree.ok) return worktree;
  const startRevision = gitValue(worktree.value.root, ['rev-parse', 'HEAD']);
  if (startRevision !== preview.value.repository_revision) {
    return failure(
      'REPAIR_HANDOFF_STALE',
      'Repository revision changed before the repair bridge could start.',
    );
  }
  const store = await readProjectStore({
    rootDir: options.rootDir,
    ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
  });
  if (!store.ok) return store;
  const runsDir = await secureRunsDirectory(store.value.projectDir);
  if (!runsDir.ok) return runsDir;
  const runId = `repair-run-${randomUUID()}`;
  const statePath = join(runsDir.value, `${runId}.json`);
  const startedAt = new Date().toISOString();
  const baseState = {
    schema_version: 1,
    ownership: 'rizz',
    run_id: runId,
    handoff_id: preview.value.handoff_id,
    project_id: preview.value.project_id,
    repository_revision: preview.value.repository_revision,
    agent: preview.value.agent,
    approved: true,
    started_at: startedAt,
    finished_at: null,
    status: 'running',
    worktree: worktree.value,
    output: outputEvidence(null),
    error: null,
  } as const;
  const runningWrite = await writeVerifiedJson(statePath, baseState);
  if (!runningWrite.ok) return runningWrite;
  let executed: AgentRepairExecutorResult;
  try {
    executed = await (options.executor ?? runAgentRepairBridge)({
      agent: preview.value.agent,
      cwd: worktree.value.root,
      prompt: preview.value.prompt,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error: unknown) {
    executed = {
      ok: false,
      error: {
        code: 'REPAIR_BRIDGE_UNAVAILABLE',
        message: 'Agent repair executor failed unexpectedly.',
      },
    };
  }
  const outcome = terminalOutcome(executed);
  const finishedAt = new Date().toISOString();
  const terminalState = {
    ...baseState,
    finished_at: finishedAt,
    status: outcome.status,
    output: outputEvidence(outcome.result),
    error: outcome.error,
  };
  const terminalWrite = await writeVerifiedJson(statePath, terminalState);
  if (!terminalWrite.ok) return terminalWrite;
  return {
    ok: true,
    value: {
      schema_version: 1,
      run_id: runId,
      handoff_id: preview.value.handoff_id,
      project_id: preview.value.project_id,
      repository_revision: preview.value.repository_revision,
      agent: preview.value.agent,
      status: outcome.status,
      approved: true,
      started_at: startedAt,
      finished_at: finishedAt,
      worktree: worktree.value,
      result: outcome.result,
      error: outcome.error,
      state_path: `.rizz/work/repair-runs/${runId}.json`,
      constraints: {
        exact_handoff_required: true,
        isolated_worktree_required: true,
        repository_push_allowed: false,
        provider_calls_required: true,
        network_required: true,
      },
    },
  };
}
