import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverAgentRepairRun } from './agent-repair-recovery.js';
import { executeContextCommand } from './context-command.js';
import { type ProjectStore, prepareProjectStore } from './project-store.js';

const roots: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

async function fixture(): Promise<{
  readonly rootDir: string;
  readonly rizzHome: string;
  readonly store: ProjectStore;
  readonly runId: string;
  readonly handoffId: string;
  readonly statePath: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), 'rizz-repair-recovery-project-'));
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-repair-recovery-home-'));
  roots.push(parent, rizzHome);
  const repository = join(parent, 'repository');
  const rootDir = join(parent, 'repair-worktree');
  await mkdir(repository);
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'rizz@example.test']);
  git(repository, ['config', 'user.name', 'Rizz Test']);
  await writeFile(join(repository, 'source.ts'), 'export const source = true;\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-qm', 'project']);
  git(repository, ['worktree', 'add', '-q', '-b', 'repair/recovery-test', rootDir]);
  const prepared = await prepareProjectStore({ rootDir, rizzHome });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const runId = 'repair-run-11111111-1111-4111-8111-111111111111';
  const handoffId = 'a'.repeat(64);
  const runsDir = join(prepared.value.projectDir, 'work', 'repair-runs');
  await mkdir(runsDir);
  const statePath = join(runsDir, `${runId}.json`);
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        schema_version: 1,
        ownership: 'rizz',
        run_id: runId,
        handoff_id: handoffId,
        project_id: prepared.value.projectId,
        repository_revision: git(rootDir, ['rev-parse', 'HEAD']),
        agent: 'codex',
        approved: true,
        started_at: '2026-07-14T00:00:00.000Z',
        finished_at: null,
        status: 'running',
        worktree: {
          root: prepared.value.rootPath,
          git_dir: await realpath(
            git(rootDir, ['rev-parse', '--path-format=absolute', '--git-dir']),
          ),
          common_dir: await realpath(
            git(rootDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
          ),
          isolated: true,
        },
        output: {
          exit_code: null,
          stdout_bytes: 0,
          stderr_bytes: 0,
          digest: null,
          truncated: false,
        },
        error: null,
      },
      null,
      2,
    )}\n`,
  );
  return { rootDir, rizzHome, store: prepared.value, runId, handoffId, statePath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent repair interrupted-run recovery', () => {
  it('requires exact approval and ownership before byte-verifying a cancelled terminal record', async () => {
    const setup = await fixture();
    const denied = await recoverAgentRepairRun({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      runId: setup.runId,
      handoffId: setup.handoffId,
      approved: false,
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'REPAIR_APPROVAL_REQUIRED' } });

    const command = await executeContextCommand({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      args: [
        'repair',
        'recover',
        '--run',
        setup.runId,
        '--handoff',
        setup.handoffId,
        '--approve',
        '--json',
      ],
    });
    expect(command).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(command.stdout)).toMatchObject({
      run_id: setup.runId,
      handoff_id: setup.handoffId,
      project_id: setup.store.projectId,
      status: 'cancelled',
      recovered: true,
      error: { code: 'REPAIR_RUN_INTERRUPTED' },
    });
    const state = JSON.parse(await readFile(setup.statePath, 'utf8'));
    expect(state).toMatchObject({
      ownership: 'rizz',
      status: 'cancelled',
      error: { code: 'REPAIR_RUN_INTERRUPTED' },
    });
    expect(state.finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await writeFile(
      setup.statePath,
      `${JSON.stringify({ ...state, status: 'running', finished_at: null, ownership: 'other' })}\n`,
    );
    const foreign = await recoverAgentRepairRun({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      runId: setup.runId,
      handoffId: setup.handoffId,
      approved: true,
    });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'REPAIR_RUN_NOT_OWNED' } });

    await writeFile(
      setup.statePath,
      `${JSON.stringify({ ...state, status: 'running', finished_at: null })}\n`,
    );
    const wrongHandoff = await recoverAgentRepairRun({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      runId: setup.runId,
      handoffId: 'b'.repeat(64),
      approved: true,
    });
    expect(wrongHandoff).toMatchObject({
      ok: false,
      error: { code: 'REPAIR_RUN_MISMATCH' },
    });

    await writeFile(
      setup.statePath,
      `${JSON.stringify({
        ...state,
        status: 'running',
        finished_at: null,
        project_id: 'project:other',
      })}\n`,
    );
    const wrongProject = await recoverAgentRepairRun({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      runId: setup.runId,
      handoffId: setup.handoffId,
      approved: true,
    });
    expect(wrongProject).toMatchObject({
      ok: false,
      error: { code: 'REPAIR_RUN_MISMATCH' },
    });

    await writeFile(
      setup.statePath,
      `${JSON.stringify({
        ...state,
        status: 'running',
        finished_at: null,
        worktree: { ...state.worktree, root: '/foreign/worktree' },
      })}\n`,
    );
    const wrongWorktree = await recoverAgentRepairRun({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      runId: setup.runId,
      handoffId: setup.handoffId,
      approved: true,
    });
    expect(wrongWorktree).toMatchObject({
      ok: false,
      error: { code: 'REPAIR_RUN_MISMATCH' },
    });

    await writeFile(
      setup.statePath,
      `${JSON.stringify({
        ...state,
        status: 'running',
        finished_at: null,
        worktree: { ...state.worktree, git_dir: join(setup.rootDir, 'foreign-git-dir') },
      })}\n`,
    );
    const wrongGitDirectory = await recoverAgentRepairRun({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      runId: setup.runId,
      handoffId: setup.handoffId,
      approved: true,
    });
    expect(wrongGitDirectory).toMatchObject({
      ok: false,
      error: { code: 'REPAIR_RUN_MISMATCH' },
    });

    await writeFile(setup.statePath, `${JSON.stringify({ ...state, status: 'completed' })}\n`);
    const terminal = await recoverAgentRepairRun({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      runId: setup.runId,
      handoffId: setup.handoffId,
      approved: true,
    });
    expect(terminal).toMatchObject({
      ok: false,
      error: { code: 'REPAIR_RUN_NOT_RUNNING' },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to recover through an externally redirected state-file symlink',
    async () => {
      const setup = await fixture();
      const contents = await readFile(setup.statePath, 'utf8');
      const outside = join(setup.rizzHome, 'outside-repair-state.json');
      await writeFile(outside, contents);
      await rm(setup.statePath);
      await symlink(outside, setup.statePath);
      const result = await recoverAgentRepairRun({
        rootDir: setup.rootDir,
        rizzHome: setup.rizzHome,
        runId: setup.runId,
        handoffId: setup.handoffId,
        approved: true,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'REPAIR_STATE_PATH_UNSAFE' },
      });
      expect(await readFile(outside, 'utf8')).toBe(contents);
    },
  );
});
