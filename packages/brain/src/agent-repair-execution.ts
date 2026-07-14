import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  type AgentRepairBridgeProcess,
  type AgentRepairExecutor,
  type AgentRepairExecutorResult,
  runAgentRepairBridge,
} from './agent-repair-bridge-service.js';
import { type RepairHandoffAgent, previewAgentRepairHandoff } from './agent-repair-handoff.js';
import {
  secureRepairRunsDirectory,
  writeVerifiedRepairRunState,
} from './agent-repair-run-state.js';
import {
  type AgentRepairWorktreeIdentity,
  inspectAgentRepairWorktree,
  readAgentRepairRevision,
} from './agent-repair-worktree.js';
import { readProjectStore } from './project-store.js';

interface RepairFailure {
  readonly code: string;
  readonly message: string;
}

type RepairResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RepairFailure };

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
  readonly worktree: AgentRepairWorktreeIdentity;
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
  const worktree = await inspectAgentRepairWorktree(options.rootDir);
  if (!worktree.ok) return worktree;
  const startRevision = readAgentRepairRevision(worktree.value.root);
  if (!startRevision.ok) return startRevision;
  if (startRevision.value !== preview.value.repository_revision) {
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
  const runsDir = await secureRepairRunsDirectory(store.value.projectDir);
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
  const runningWrite = await writeVerifiedRepairRunState(statePath, baseState);
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
  const terminalWrite = await writeVerifiedRepairRunState(statePath, terminalState);
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
