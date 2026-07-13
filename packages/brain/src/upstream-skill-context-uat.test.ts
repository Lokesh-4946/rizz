import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pinAcquiredSkill, previewAcquiredSkill } from './acquired-skill-selection.js';
import { executeContextCommand } from './context-command.js';
import { generateProjectBrain } from './index.js';
import { createMcpServer } from './mcp-server.js';
import { prepareProjectStore } from './project-store.js';
import { searchAcquiredSkills } from './skill-discovery-index.js';

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

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'rizz@example.test']);
  git(root, ['config', 'user.name', 'Rizz Test']);
  return root;
}

async function project(prefix: string): Promise<string> {
  const root = await repository(prefix);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'review.ts'), 'export const review = true;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'project']);
  return root;
}

async function fixture(): Promise<{
  readonly firstProject: string;
  readonly secondProject: string;
  readonly rizzHome: string;
  readonly revision: string;
}> {
  const source = await repository('rizz-upstream-context-source-');
  await writeFile(join(source, 'LICENSE'), 'Approved source license fixture.\n');
  await mkdir(join(source, 'skills', 'review'), { recursive: true });
  await writeFile(
    join(source, 'skills', 'review', 'SKILL.md'),
    '---\nname: upstream-review\ndescription: Review exact repository evidence.\n---\n',
  );
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'skill']);
  const revision = git(source, ['rev-parse', 'HEAD']);
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-upstream-context-home-'));
  roots.push(rizzHome);
  const checkout = join(rizzHome, 'global', 'skills', 'sources', 'openai-skills', revision);
  await mkdir(join(checkout, '..'), { recursive: true });
  git(source, ['clone', '--quiet', source, checkout]);
  git(checkout, ['remote', 'set-url', 'origin', 'https://github.com/openai/skills.git']);
  return {
    firstProject: await project('rizz-upstream-context-project-'),
    secondProject: await project('rizz-upstream-context-project-'),
    rizzHome,
    revision,
  };
}

async function prepare(rootDir: string, rizzHome: string): Promise<void> {
  const store = await prepareProjectStore({ rootDir, rizzHome });
  if (!store.ok) throw new Error(store.error.message);
  const brain = await generateProjectBrain({ rootDir, outputDir: store.value.projectDir });
  if (!brain.ok) throw new Error(brain.error.message);
}

function capture() {
  const messages: Array<Record<string, unknown>> = [];
  return {
    messages,
    write(line: string) {
      messages.push(JSON.parse(line));
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('upstream skill project and agent-context UAT', () => {
  it('keeps exact compatible evidence equivalent across isolated CLI and MCP briefs', async () => {
    const setup = await fixture();
    const searched = await searchAcquiredSkills({
      rizzHome: setup.rizzHome,
      sourceId: 'openai-skills',
      revision: setup.revision,
      query: 'upstream-review',
    });
    expect(searched).toMatchObject({ ok: true, value: { matched: 1, returned: 1 } });
    const selected = {
      rizzHome: setup.rizzHome,
      sourceId: 'openai-skills',
      revision: setup.revision,
      skillPath: 'skills/review',
    };
    const preview = await previewAcquiredSkill(selected);
    expect(preview).toMatchObject({ ok: true, value: { name: 'upstream-review' } });
    const pinned = await pinAcquiredSkill({ ...selected, approved: true });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;

    const enabled = await executeContextCommand({
      rootDir: setup.firstProject,
      rizzHome: setup.rizzHome,
      args: ['skills', 'enable', 'upstream-review', '--agent', 'codex', '--approve', '--json'],
    });
    expect(enabled).toMatchObject({ exitCode: 0, stderr: '' });
    await Promise.all([
      prepare(setup.firstProject, setup.rizzHome),
      prepare(setup.secondProject, setup.rizzHome),
    ]);

    const cli = await executeContextCommand({
      rootDir: setup.firstProject,
      rizzHome: setup.rizzHome,
      args: ['brief', 'Review changes', '--agent', 'codex', '--json'],
    });
    expect(cli).toMatchObject({ exitCode: 0, stderr: '' });
    const cliBrief = JSON.parse(cli.stdout) as {
      readonly task: string;
      readonly agent: string;
      readonly compatible_skills: readonly Record<string, unknown>[];
    };
    expect(cliBrief.task).toBe('Review changes');
    expect(cliBrief.agent).toBe('codex');
    expect(cliBrief.compatible_skills).toEqual([
      expect.objectContaining({
        name: 'upstream-review',
        source_id: 'openai-skills',
        skill_path: 'skills/review',
        source_repository: 'https://github.com/openai/skills.git',
        revision: setup.revision,
        digest: pinned.value.digest,
        file_digest: pinned.value.file_digest,
        license: 'Apache-2.0',
        attribution: 'OpenAI',
        agents: ['codex'],
        audit_status: 'clean',
        audit_findings: [],
      }),
    ]);

    const output = capture();
    const mcp = createMcpServer({
      rootDir: setup.firstProject,
      rizzHome: setup.rizzHome,
      write: output.write,
    });
    await mcp.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }));
    await mcp.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_task_brief',
          arguments: { task: 'Review changes', agent: 'codex' },
        },
      }),
    );
    const mcpResult = output.messages[1]?.result as {
      readonly structuredContent: { readonly compatible_skills: readonly unknown[] };
    };
    expect(mcpResult.structuredContent.compatible_skills).toEqual(cliBrief.compatible_skills);

    const incompatible = await executeContextCommand({
      rootDir: setup.firstProject,
      rizzHome: setup.rizzHome,
      args: ['brief', 'Review changes', '--agent', 'copilot', '--json'],
    });
    expect(JSON.parse(incompatible.stdout).compatible_skills).toEqual([]);
    const isolated = await executeContextCommand({
      rootDir: setup.secondProject,
      rizzHome: setup.rizzHome,
      args: ['brief', 'Review changes', '--agent', 'codex', '--json'],
    });
    expect(JSON.parse(isolated.stdout).compatible_skills).toEqual([]);

    const unsupported = await executeContextCommand({
      rootDir: setup.firstProject,
      rizzHome: setup.rizzHome,
      args: ['brief', 'Review changes', '--agent', 'unknown', '--json'],
    });
    expect(unsupported).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('SKILL_AGENT_UNSUPPORTED'),
    });
    await mcp.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_task_brief',
          arguments: { task: 'Review changes', agent: 'unknown' },
        },
      }),
    );
    expect(output.messages[2]?.result).toMatchObject({
      isError: true,
      structuredContent: { code: 'SKILL_AGENT_UNSUPPORTED' },
    });

    for (const rootDir of [setup.firstProject, setup.secondProject]) {
      expect(git(rootDir, ['status', '--porcelain'])).toBe('');
      await expect(stat(join(rootDir, '.rizz'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 15_000);
});
