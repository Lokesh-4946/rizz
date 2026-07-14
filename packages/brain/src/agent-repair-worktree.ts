import { spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';

interface RepairWorktreeFailure {
  readonly code: string;
  readonly message: string;
}

export type RepairWorktreeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RepairWorktreeFailure };

export interface AgentRepairWorktreeIdentity {
  readonly root: string;
  readonly git_dir: string;
  readonly common_dir: string;
  readonly isolated: true;
}

function failure(code: string, message: string): RepairWorktreeResult<never> {
  return { ok: false, error: { code, message } };
}

function gitValue(rootDir: string, args: readonly string[]): string | null {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value === '' ? null : value;
}

export async function inspectAgentRepairWorktree(
  rootDir: string,
): Promise<RepairWorktreeResult<AgentRepairWorktreeIdentity>> {
  try {
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
      return failure(
        'REPAIR_WORKTREE_INVALID',
        'Run agent repair from the prepared worktree root.',
      );
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
  } catch {
    return failure('REPAIR_WORKTREE_INVALID', 'Agent repair requires a valid Git worktree.');
  }
}

export function readAgentRepairRevision(rootDir: string): RepairWorktreeResult<string> {
  const revision = gitValue(rootDir, ['rev-parse', 'HEAD']);
  return revision === null
    ? failure('REPAIR_WORKTREE_INVALID', 'Agent repair requires a valid Git revision.')
    : { ok: true, value: revision };
}
