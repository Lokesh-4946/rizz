import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentRepairExecutor, executeAgentRepair } from './agent-repair-execution.js';
import { previewAgentRepairHandoff } from './agent-repair-handoff.js';
import type { AgentRepairPacket } from './agent-repair-packets.js';
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

function packet(): AgentRepairPacket {
  return {
    priority: 1,
    packet_id: 'repair:review:first',
    related_packet_ids: [],
    source: 'review_blast_radius',
    severity: 'high',
    target_type: 'review_finding',
    target_id: 'finding:first',
    intent: 'Repair the first finding.',
    read_first_files: ['src/first.ts'],
    inspect_actions: ['Inspect src/first.ts.'],
    repair_actions: ['Repair only finding:first.'],
    verification_actions: ['Run pnpm test.'],
    evidence_ids: ['evidence:first'],
    evidence_gap_ids: [],
    artifacts: ['.rizz/research/review_eval.json'],
    agent_prompt: 'Repair finding:first from exact evidence.',
    stop_conditions: ['Stop if the repository revision changes.'],
    confidence: 'verified',
  };
}

async function fixture(linkedWorktree: boolean): Promise<{
  readonly rootDir: string;
  readonly rizzHome: string;
  readonly store: ProjectStore;
}> {
  const parent = await mkdtemp(join(tmpdir(), 'rizz-repair-execution-project-'));
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-repair-execution-home-'));
  roots.push(parent, rizzHome);
  const repository = join(parent, 'repository');
  await mkdir(repository);
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'rizz@example.test']);
  git(repository, ['config', 'user.name', 'Rizz Test']);
  await mkdir(join(repository, 'src'));
  await writeFile(join(repository, 'src', 'first.ts'), 'export const first = true;\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-qm', 'project']);
  let rootDir = repository;
  if (linkedWorktree) {
    rootDir = join(parent, 'repair-worktree');
    git(repository, ['worktree', 'add', '-q', '-b', 'repair/test', rootDir]);
  }
  const prepared = await prepareProjectStore({ rootDir, rizzHome });
  if (!prepared.ok) throw new Error(prepared.error.message);
  await writeFile(
    join(prepared.value.researchDir, 'agent_repair_packets.json'),
    `${JSON.stringify({
      schema_version: 1,
      generated_at: '2026-07-14T00:00:00.000Z',
      deterministic: true,
      provider_calls_required: false,
      network_required: false,
      packet_count: 1,
      packets: [packet()],
    })}\n`,
  );
  return { rootDir, rizzHome, store: prepared.value };
}

async function handoff(setup: {
  readonly rootDir: string;
  readonly rizzHome: string;
}): Promise<string> {
  const result = await previewAgentRepairHandoff({
    rootDir: setup.rootDir,
    rizzHome: setup.rizzHome,
    agent: 'codex',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.handoff_id;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent repair execution', () => {
  it('consumes an exact approved handoff in a linked worktree and records bounded external state', async () => {
    const setup = await fixture(true);
    const handoffId = await handoff(setup);
    const calls: Parameters<AgentRepairExecutor>[0][] = [];
    const executor: AgentRepairExecutor = async (options) => {
      calls.push(options);
      return {
        ok: true,
        value: { exit_code: 0, stdout: 'repair complete', stderr: '', output_truncated: false },
      };
    };

    const result = await executeContextCommand({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      args: [
        'repair',
        'execute',
        '--agent',
        'codex',
        '--handoff',
        handoffId,
        '--approve',
        '--json',
      ],
      repairExecutor: executor,
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      schema_version: 1,
      handoff_id: handoffId,
      project_id: setup.store.projectId,
      agent: 'codex',
      status: 'completed',
      approved: true,
      worktree: { root: setup.store.rootPath, isolated: true },
      result: { exit_code: 0, stdout: 'repair complete' },
      constraints: {
        exact_handoff_required: true,
        isolated_worktree_required: true,
        repository_push_allowed: false,
        provider_calls_required: true,
        network_required: true,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agent: 'codex', cwd: setup.store.rootPath });
    expect(calls[0]?.prompt).toContain(handoffId);
    const state = JSON.parse(
      await readFile(
        join(setup.store.projectDir, 'work', 'repair-runs', `${output.run_id}.json`),
        'utf8',
      ),
    );
    expect(state).toMatchObject({
      ownership: 'rizz',
      status: 'completed',
      handoff_id: handoffId,
      output: { exit_code: 0, stdout_bytes: 15, stderr_bytes: 0 },
    });
    expect(state).not.toHaveProperty('prompt');
    await expect(stat(join(setup.rootDir, '.rizz'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses missing approval, a main checkout, and a stale handoff before execution', async () => {
    const linked = await fixture(true);
    const linkedHandoff = await handoff(linked);
    let calls = 0;
    const executor: AgentRepairExecutor = async () => {
      calls += 1;
      return {
        ok: true,
        value: { exit_code: 0, stdout: '', stderr: '', output_truncated: false },
      };
    };
    const unapproved = await executeAgentRepair({
      rootDir: linked.rootDir,
      rizzHome: linked.rizzHome,
      agent: 'codex',
      handoffId: linkedHandoff,
      approved: false,
      executor,
    });
    expect(unapproved).toMatchObject({ ok: false, error: { code: 'REPAIR_APPROVAL_REQUIRED' } });

    await writeFile(join(linked.rootDir, 'revision-change.txt'), 'new revision\n');
    git(linked.rootDir, ['add', '.']);
    git(linked.rootDir, ['commit', '-qm', 'change revision']);
    const stale = await executeAgentRepair({
      rootDir: linked.rootDir,
      rizzHome: linked.rizzHome,
      agent: 'codex',
      handoffId: linkedHandoff,
      approved: true,
      executor,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'REPAIR_HANDOFF_STALE' } });

    const main = await fixture(false);
    const mainHandoff = await handoff(main);
    const notIsolated = await executeAgentRepair({
      rootDir: main.rootDir,
      rizzHome: main.rizzHome,
      agent: 'codex',
      handoffId: mainHandoff,
      approved: true,
      executor,
    });
    expect(notIsolated).toMatchObject({
      ok: false,
      error: { code: 'REPAIR_ISOLATED_WORKTREE_REQUIRED' },
    });
    expect(calls).toBe(0);
  });

  it('classifies cancellation and byte-verifies the terminal run record', async () => {
    const setup = await fixture(true);
    const handoffId = await handoff(setup);
    const result = await executeAgentRepair({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      agent: 'codex',
      handoffId,
      approved: true,
      signal: AbortSignal.abort(),
      executor: async () => ({
        ok: false,
        error: { code: 'INTERRUPTED', message: 'agent repair interrupted' },
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'cancelled', error: { code: 'INTERRUPTED' } },
    });
    if (!result.ok) return;
    const state = JSON.parse(
      await readFile(
        join(setup.store.projectDir, 'work', 'repair-runs', `${result.value.run_id}.json`),
        'utf8',
      ),
    );
    expect(state).toMatchObject({ status: 'cancelled', error: { code: 'INTERRUPTED' } });
  });

  it('refuses to write repair state through a tampered project-work symlink', async () => {
    const setup = await fixture(true);
    const handoffId = await handoff(setup);
    const outside = join(setup.store.projectDir, '..', 'outside-repair-state');
    await mkdir(outside);
    await rm(join(setup.store.projectDir, 'work'), { recursive: true });
    await symlink(
      outside,
      join(setup.store.projectDir, 'work'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const result = await executeAgentRepair({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      agent: 'codex',
      handoffId,
      approved: true,
      executor: async () => ({
        ok: true,
        value: { exit_code: 0, stdout: '', stderr: '', output_truncated: false },
      }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'REPAIR_STATE_PATH_UNSAFE' } });
    expect(await readdir(outside)).toEqual([]);
  });
});
