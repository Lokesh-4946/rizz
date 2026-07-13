import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

function packet(
  packetId: string,
  priority: number,
  targetId: string,
  file: string,
  verification: string,
): AgentRepairPacket {
  return {
    priority,
    packet_id: packetId,
    related_packet_ids: [],
    source: 'review_blast_radius',
    severity: priority === 1 ? 'high' : 'medium',
    target_type: 'review_finding',
    target_id: targetId,
    intent: `Repair ${targetId}.`,
    read_first_files: [file],
    inspect_actions: [`Inspect ${file}.`],
    repair_actions: [`Repair only ${targetId}.`],
    verification_actions: [verification],
    evidence_ids: [`evidence:${targetId}`],
    evidence_gap_ids: [],
    artifacts: ['.rizz/research/review_eval.json'],
    agent_prompt: `Repair ${targetId} from exact evidence.`,
    stop_conditions: ['Stop if the repository revision changes.'],
    confidence: 'verified',
  };
}

async function fixture(): Promise<{
  readonly rootDir: string;
  readonly rizzHome: string;
  readonly store: ProjectStore;
  readonly revision: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'rizz-repair-handoff-project-'));
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-repair-handoff-home-'));
  roots.push(rootDir, rizzHome);
  git(rootDir, ['init', '-q']);
  git(rootDir, ['config', 'user.email', 'rizz@example.test']);
  git(rootDir, ['config', 'user.name', 'Rizz Test']);
  await mkdir(join(rootDir, 'src'));
  await writeFile(join(rootDir, 'src', 'first.ts'), 'export const first = true;\n');
  await writeFile(join(rootDir, 'src', 'second.ts'), 'export const second = true;\n');
  git(rootDir, ['add', '.']);
  git(rootDir, ['commit', '-qm', 'project']);
  const store = await prepareProjectStore({ rootDir, rizzHome });
  if (!store.ok) throw new Error(store.error.message);
  await writeFile(
    join(store.value.researchDir, 'agent_repair_packets.json'),
    `${JSON.stringify({
      schema_version: 1,
      generated_at: '2026-07-14T00:00:00.000Z',
      deterministic: true,
      provider_calls_required: false,
      network_required: false,
      packet_count: 2,
      high_priority_count: 1,
      sources: { review_blast_radius: 2 },
      packets: [
        packet('repair:review:first', 1, 'finding:first', 'src/first.ts', 'Run pnpm test.'),
        packet('repair:review:second', 2, 'finding:second', 'src/second.ts', 'Run pnpm lint.'),
      ],
      summary: 'Two exact repair packets.',
      calibration_rule: 'Guidance does not claim repair execution.',
    })}\n`,
  );
  return { rootDir, rizzHome, store: store.value, revision: git(rootDir, ['rev-parse', 'HEAD']) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent repair handoff preview', () => {
  it('builds a bounded revision-bound handoff without executing an agent or writing the repo', async () => {
    const setup = await fixture();
    const beforeState = await readdir(setup.store.projectDir, { recursive: true });
    const result = await previewAgentRepairHandoff({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      agent: 'codex',
      limit: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      schema_version: 1,
      project_id: setup.store.projectId,
      repository_revision: setup.revision,
      agent: 'codex',
      packet_count: 1,
      selected_packet_ids: ['repair:review:first'],
      scope: {
        target_ids: ['finding:first'],
        read_first_files: ['src/first.ts'],
        max_files: 16,
      },
      verification: {
        actions: ['Run pnpm test.'],
        max_actions: 12,
        evidence_required: true,
      },
      constraints: {
        max_packets: 8,
        max_artifact_bytes: 1048576,
        max_prompt_bytes: 32768,
        approval_required: true,
        executes_agent: false,
        writes_repository: false,
        writes_state: false,
        network_required: false,
        provider_calls_required: false,
        isolated_worktree_required: true,
      },
    });
    expect(result.value.handoff_id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.value.artifact_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.value.prompt).toContain('repair:review:first');
    expect(await readdir(setup.store.projectDir, { recursive: true })).toEqual(beforeState);
    expect(git(setup.rootDir, ['status', '--porcelain'])).toBe('');
  });

  it('exposes exact packet selection through CLI and rejects unsupported or missing inputs', async () => {
    const setup = await fixture();
    const selected = await executeContextCommand({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      args: [
        'repair',
        'handoff',
        '--agent',
        'claude',
        '--packet',
        'repair:review:second',
        '--preview',
        '--json',
      ],
    });
    expect(selected).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(selected.stdout)).toMatchObject({
      agent: 'claude',
      selected_packet_ids: ['repair:review:second'],
      scope: { read_first_files: ['src/second.ts'] },
    });

    const unsupported = await executeContextCommand({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      args: ['repair', 'handoff', '--agent', 'agents', '--preview', '--json'],
    });
    expect(unsupported).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('REPAIR_AGENT_UNSUPPORTED'),
    });
    const invalid = await executeContextCommand({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      args: ['repair', 'handoff', '--agent', 'codex', '--json'],
    });
    expect(invalid).toMatchObject({ exitCode: 2, stderr: expect.stringContaining('REPAIR_USAGE') });
  });

  it('rejects hostile path and enum values from corrupted external packet state', async () => {
    const setup = await fixture();
    const hostile = packet(
      'repair:review:hostile',
      1,
      'finding:hostile',
      '../outside-secret.txt',
      'Run pnpm test.',
    );
    await writeFile(
      join(setup.store.researchDir, 'agent_repair_packets.json'),
      `${JSON.stringify({
        schema_version: 1,
        generated_at: '2026-07-14T00:00:00.000Z',
        deterministic: true,
        provider_calls_required: false,
        network_required: false,
        packet_count: 1,
        packets: [{ ...hostile, confidence: 'invented' }],
      })}\n`,
    );

    const result = await previewAgentRepairHandoff({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      agent: 'codex',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'REPAIR_PACKET_INVALID' } });
  });
});
