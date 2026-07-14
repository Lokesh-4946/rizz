import { join } from 'node:path';
import {
  type RepairStateResult,
  isRepairRunId,
  readRepairRunState,
  secureRepairRunsDirectory,
  writeVerifiedRepairRunState,
} from './agent-repair-run-state.js';
import { inspectAgentRepairWorktree } from './agent-repair-worktree.js';
import { readProjectStore } from './project-store.js';

interface RepairFailure {
  readonly code: string;
  readonly message: string;
}

export interface AgentRepairRecovery {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly handoff_id: string;
  readonly project_id: string;
  readonly status: 'cancelled';
  readonly recovered: true;
  readonly finished_at: string;
  readonly error: RepairFailure;
  readonly state_path: string;
}

function failure(code: string, message: string): RepairStateResult<never> {
  return { ok: false, error: { code, message } };
}

export async function recoverAgentRepairRun(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly runId: string;
  readonly handoffId: string;
  readonly approved: boolean;
}): Promise<RepairStateResult<AgentRepairRecovery>> {
  if (!options.approved) {
    return failure(
      'REPAIR_APPROVAL_REQUIRED',
      'Agent repair recovery requires explicit --approve confirmation.',
    );
  }
  if (!isRepairRunId(options.runId)) {
    return failure('REPAIR_RUN_INVALID', 'Agent repair recovery requires an exact run ID.');
  }
  if (!/^[a-f0-9]{64}$/.test(options.handoffId)) {
    return failure('REPAIR_HANDOFF_INVALID', 'Agent repair recovery requires an exact handoff ID.');
  }
  const store = await readProjectStore({
    rootDir: options.rootDir,
    ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
  });
  if (!store.ok) return store;
  const worktree = await inspectAgentRepairWorktree(options.rootDir);
  if (!worktree.ok) return worktree;
  const runsDir = await secureRepairRunsDirectory(store.value.projectDir);
  if (!runsDir.ok) return runsDir;
  const statePath = join(runsDir.value, `${options.runId}.json`);
  const state = await readRepairRunState(statePath);
  if (!state.ok) return state;
  if (state.value.ownership !== 'rizz') {
    return failure('REPAIR_RUN_NOT_OWNED', 'Rizz does not own this repair run state.');
  }
  if (
    state.value.run_id !== options.runId ||
    state.value.handoff_id !== options.handoffId ||
    state.value.project_id !== store.value.projectId ||
    state.value.worktree.root !== store.value.rootPath ||
    state.value.worktree.root !== worktree.value.root ||
    state.value.worktree.git_dir !== worktree.value.git_dir ||
    state.value.worktree.common_dir !== worktree.value.common_dir
  ) {
    return failure(
      'REPAIR_RUN_MISMATCH',
      'Repair run identity does not match this project, worktree, or handoff.',
    );
  }
  if (state.value.status !== 'running') {
    return failure(
      'REPAIR_RUN_NOT_RUNNING',
      'Only an interrupted running repair can be recovered.',
    );
  }
  const finishedAt = new Date().toISOString();
  const interrupted: RepairFailure = {
    code: 'REPAIR_RUN_INTERRUPTED',
    message: 'The repair process ended before it wrote a terminal result.',
  };
  const terminalState = {
    ...state.value,
    finished_at: finishedAt,
    status: 'cancelled',
    error: interrupted,
  } as const;
  const written = await writeVerifiedRepairRunState(statePath, terminalState);
  if (!written.ok) return written;
  return {
    ok: true,
    value: {
      schema_version: 1,
      run_id: state.value.run_id,
      handoff_id: state.value.handoff_id,
      project_id: state.value.project_id,
      status: 'cancelled',
      recovered: true,
      finished_at: finishedAt,
      error: interrupted,
      state_path: `.rizz/work/repair-runs/${state.value.run_id}.json`,
    },
  };
}
