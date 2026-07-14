import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAgentRepair } from './agent-repair-execution.js';
import { previewAgentRepairHandoff } from './agent-repair-handoff.js';
import type { AgentRepairPacket } from './agent-repair-packets.js';
import { recoverAgentRepairRun } from './agent-repair-recovery.js';
import { addVerificationEvidence } from './index.js';
import { type ProjectStore, prepareProjectStore } from './project-store.js';

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;

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
    packet_id: 'repair:review:lifecycle',
    related_packet_ids: [],
    source: 'review_blast_radius',
    severity: 'high',
    target_type: 'review_finding',
    target_id: 'finding:lifecycle',
    intent: 'Repair the lifecycle fixture.',
    read_first_files: ['src/first.ts'],
    inspect_actions: ['Inspect src/first.ts.'],
    repair_actions: ['Repair only src/first.ts.'],
    verification_actions: ['Run git diff --check.'],
    evidence_ids: ['evidence:lifecycle'],
    evidence_gap_ids: [],
    artifacts: ['.rizz/research/review_eval.json'],
    agent_prompt: 'Repair the exact lifecycle fixture.',
    stop_conditions: ['Stop if the repository revision changes.'],
    confidence: 'verified',
  };
}

async function fixture(agent: 'codex' | 'claude' | 'copilot'): Promise<{
  readonly agent: 'codex' | 'claude' | 'copilot';
  readonly rootDir: string;
  readonly rizzHome: string;
  readonly store: ProjectStore;
}> {
  const parent = await mkdtemp(join(tmpdir(), `rizz-repair-lifecycle-${agent}-`));
  const rizzHome = await mkdtemp(join(tmpdir(), `rizz-repair-lifecycle-home-${agent}-`));
  roots.push(parent, rizzHome);
  const repository = join(parent, 'repository');
  const rootDir = join(parent, 'repair-worktree');
  await mkdir(join(repository, 'src'), { recursive: true });
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'rizz@example.test']);
  git(repository, ['config', 'user.name', 'Rizz Test']);
  await writeFile(join(repository, 'src', 'first.ts'), 'export const first = true;\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-qm', 'project']);
  git(repository, ['worktree', 'add', '-q', '-b', `repair/${agent}-lifecycle`, rootDir]);
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
  return { agent, rootDir, rizzHome, store: prepared.value };
}

function fakeAgentProgram(agent: 'codex' | 'claude' | 'copilot'): string {
  return `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const agent = ${JSON.stringify(agent)};
const args = process.argv.slice(2);
let exact = false;
if (agent === 'codex') {
  exact = JSON.stringify(args) === JSON.stringify(['exec', '--ephemeral', '--sandbox', 'workspace-write', '--color', 'never', '-']);
} else if (agent === 'claude') {
  exact = JSON.stringify(args) === JSON.stringify(['--print', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
} else {
  exact = args.includes('-p') && args.includes('-s') && args.includes('--no-ask-user') && args.includes('--allow-tool=write') && args.includes('--deny-tool=shell') && args.includes('--deny-tool=url') && args.includes('--excluded-tools=web_fetch,web_search');
}
if (!exact) {
  process.stderr.write('unexpected adapter arguments: ' + JSON.stringify(args));
  process.exit(9);
}
writeFileSync(join(process.cwd(), 'src', 'first.ts'), 'export const repairedBy = ' + JSON.stringify(agent) + ';\\n');
process.stdout.write(JSON.stringify({ adapter: agent, arguments_verified: true }));
`;
}

async function installFakeAgents(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rizz-repair-fake-agents-'));
  roots.push(directory);
  for (const agent of ['codex', 'claude', 'copilot'] as const) {
    const program = fakeAgentProgram(agent);
    const modulePath = join(directory, `${agent}.mjs`);
    await writeFile(modulePath, program);
    const executablePath = join(directory, agent);
    await writeFile(executablePath, program);
    await chmod(executablePath, 0o755);
    await writeFile(join(directory, `${agent}.cmd`), `@node "%~dp0${agent}.mjs" %*\r\n`);
  }
  return directory;
}

async function exactHandoff(setup: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const preview = await previewAgentRepairHandoff({
    rootDir: setup.rootDir,
    rizzHome: setup.rizzHome,
    agent: setup.agent,
  });
  if (!preview.ok) throw new Error(preview.error.message);
  return preview.value.handoff_id;
}

async function waitForRunningState(runsDir: string): Promise<{ runId: string; path: string }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const files = await readdir(runsDir).catch(() => []);
    const file = files.find((candidate) => candidate.startsWith('repair-run-'));
    if (file !== undefined) {
      const path = join(runsDir, file);
      const state = JSON.parse(await readFile(path, 'utf8'));
      if (state.status === 'running') return { runId: state.run_id, path };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for running repair state');
}

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalPathExt === undefined) Reflect.deleteProperty(process.env, 'PATHEXT');
  else process.env.PATHEXT = originalPathExt;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('disposable agent repair lifecycle', () => {
  it('runs exact approved Codex, Claude, and Copilot adapters in isolated worktrees and records verification evidence', async () => {
    const fakeAgents = await installFakeAgents();
    process.env.PATH = `${fakeAgents}${delimiter}${originalPath ?? ''}`;
    process.env.PATHEXT = `.CMD;${originalPathExt ?? ''}`;
    const setups = await Promise.all(
      (['codex', 'claude', 'copilot'] as const).map((agent) => fixture(agent)),
    );
    expect(new Set(setups.map((setup) => setup.store.projectDir)).size).toBe(3);

    for (const setup of setups) {
      const handoffId = await exactHandoff(setup);
      const result = await executeAgentRepair({
        rootDir: setup.rootDir,
        rizzHome: setup.rizzHome,
        agent: setup.agent,
        handoffId,
        approved: true,
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          agent: setup.agent,
          status: 'completed',
          handoff_id: handoffId,
          project_id: setup.store.projectId,
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      expect(JSON.parse(result.value.result?.stdout ?? '{}')).toEqual({
        adapter: setup.agent,
        arguments_verified: true,
      });
      expect(git(setup.rootDir, ['status', '--short'])).toBe('M src/first.ts');
      expect(await readFile(join(setup.rootDir, 'src', 'first.ts'), 'utf8')).toBe(
        `export const repairedBy = ${JSON.stringify(setup.agent)};\n`,
      );
      execFileSync('git', ['diff', '--check'], { cwd: setup.rootDir });
      const evidence = await addVerificationEvidence({
        rootDir: setup.rootDir,
        outputDir: setup.store.projectDir,
        name: `${setup.agent} repair lifecycle`,
        command: 'git diff --check',
        status: 'passed',
        outputSummary: 'Adapter arguments, changed-file ownership, and diff integrity passed.',
      });
      expect(evidence).toMatchObject({ ok: true, value: { item: { status: 'passed' } } });
      const verification = JSON.parse(
        await readFile(join(setup.store.researchDir, 'verification_evidence.json'), 'utf8'),
      );
      expect(verification.items).toEqual([
        expect.objectContaining({ name: `${setup.agent} repair lifecycle`, status: 'passed' }),
      ]);
      await expect(stat(join(setup.rootDir, '.rizz'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 20_000);

  it('refuses a stale handoff without invoking or changing the repository', async () => {
    const setup = await fixture('codex');
    const handoffId = await exactHandoff(setup);
    await writeFile(join(setup.rootDir, 'revision.ts'), 'export const revision = 2;\n');
    git(setup.rootDir, ['add', '.']);
    git(setup.rootDir, ['commit', '-qm', 'change revision']);
    const before = git(setup.rootDir, ['status', '--short']);
    const result = await executeAgentRepair({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      agent: setup.agent,
      handoffId,
      approved: true,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'REPAIR_HANDOFF_STALE' } });
    expect(git(setup.rootDir, ['status', '--short'])).toBe(before);
    expect(await readFile(join(setup.rootDir, 'src', 'first.ts'), 'utf8')).toBe(
      'export const first = true;\n',
    );
  });

  it('recovers a running record left by a terminated repair process', async () => {
    const setup = await fixture('codex');
    const handoffId = await exactHandoff(setup);
    const moduleUrl = pathToFileURL(join(process.cwd(), 'packages/brain/dist/index.js')).href;
    const childCode = `
        import { executeAgentRepair } from ${JSON.stringify(moduleUrl)};
        await executeAgentRepair({
          rootDir: ${JSON.stringify(setup.rootDir)},
          rizzHome: ${JSON.stringify(setup.rizzHome)},
          agent: 'codex',
          handoffId: ${JSON.stringify(handoffId)},
          approved: true,
          executor: async () => await new Promise(() => {}),
        });
      `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
      stdio: 'ignore',
    });
    const runsDir = join(setup.store.projectDir, 'work', 'repair-runs');
    const running = await waitForRunningState(runsDir);
    await new Promise<void>((resolve) => {
      const onExit = (): void => resolve();
      child.once('exit', onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off('exit', onExit);
        resolve();
        return;
      }
      child.kill();
    });

    const recovered = await recoverAgentRepairRun({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      runId: running.runId,
      handoffId,
      approved: true,
    });
    expect(recovered).toMatchObject({
      ok: true,
      value: {
        run_id: running.runId,
        status: 'cancelled',
        recovered: true,
        error: { code: 'REPAIR_RUN_INTERRUPTED' },
      },
    });
    const terminal = JSON.parse(await readFile(running.path, 'utf8'));
    expect(terminal).toMatchObject({
      ownership: 'rizz',
      status: 'cancelled',
      error: { code: 'REPAIR_RUN_INTERRUPTED' },
    });
  }, 15_000);
});
