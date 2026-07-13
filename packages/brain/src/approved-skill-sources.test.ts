import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ApprovedSkillSource,
  acquireApprovedSkillSource,
  previewApprovedSkillSource,
  searchApprovedSkillSources,
} from './approved-skill-sources.js';
import { executeContextCommand } from './context-command.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('approved skill source catalog', () => {
  it('searches deterministic approved metadata without network access', () => {
    const results = searchApprovedSkillSources({ query: 'Anthropic' });
    expect(results.map((source) => source.id)).toEqual(['anthropic-skills']);
    expect(results[0]).toMatchObject({ owner: 'Anthropic', agents: ['claude', 'agents'] });
  });

  it('previews an exact immutable pin and rejects symbolic revisions', () => {
    const revision = 'a'.repeat(40);
    expect(previewApprovedSkillSource({ id: 'openai-skills', revision })).toMatchObject({
      ok: true,
      value: { id: 'openai-skills', revision, writes_repository: false, executes_content: false },
    });
    expect(previewApprovedSkillSource({ id: 'openai-skills', revision: 'main' })).toMatchObject({
      ok: false,
      error: { code: 'SKILL_SOURCE_PIN_INVALID' },
    });
  });

  it('exposes search and network-free fetch preview through CLI JSON', async () => {
    const searched = await executeContextCommand({
      rootDir: tmpdir(),
      args: ['skills', 'search', 'OpenAI', '--json'],
    });
    expect(JSON.parse(searched.stdout).map((source: { id: string }) => source.id)).toEqual([
      'openai-skills',
    ]);
    const previewed = await executeContextCommand({
      rootDir: tmpdir(),
      args: ['skills', 'fetch', 'openai-skills', '--pin', 'a'.repeat(40), '--preview', '--json'],
    });
    expect(JSON.parse(previewed.stdout)).toMatchObject({
      id: 'openai-skills',
      executes_content: false,
      requires_network: true,
    });
  });

  it('requires approval and acquires only the exact requested commit into the global source cache', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'rizz-approved-source-'));
    const home = await mkdtemp(join(tmpdir(), 'rizz-approved-home-'));
    roots.push(repository, home);
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'rizz@example.test'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: repository });
    await mkdir(join(repository, 'skills', 'review'), { recursive: true });
    await writeFile(
      join(repository, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review.\n---\n',
    );
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    const fixture: ApprovedSkillSource = {
      id: 'fixture',
      owner: 'Rizz Test',
      repository: `file://${repository}`,
      description: 'Fixture.',
      agents: ['agents'],
      license: 'MIT',
    };
    const rejected = await acquireApprovedSkillSource({
      id: 'fixture',
      revision,
      rizzHome: home,
      approved: false,
      catalog: [fixture],
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'SKILL_SOURCE_APPROVAL_REQUIRED' },
    });
    const acquired = await acquireApprovedSkillSource({
      id: 'fixture',
      revision,
      rizzHome: home,
      approved: true,
      catalog: [fixture],
    });
    if (!acquired.ok) throw new Error(JSON.stringify(acquired.error));
    expect(acquired).toMatchObject({
      ok: true,
      value: { revision, source: fixture, executes_content: false },
    });
    if (!acquired.ok) return;
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: acquired.value.checkout_dir,
        encoding: 'utf8',
      }).trim(),
    ).toBe(revision);
    expect(
      await readFile(join(acquired.value.checkout_dir, 'skills', 'review', 'SKILL.md'), 'utf8'),
    ).toContain('name: review');
  });

  it('removes partial source checkouts after a failed acquisition', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'rizz-approved-source-'));
    const home = await mkdtemp(join(tmpdir(), 'rizz-approved-home-'));
    roots.push(repository, home);
    execFileSync('git', ['init', '-q'], { cwd: repository });
    const fixture: ApprovedSkillSource = {
      id: 'fixture',
      owner: 'Rizz Test',
      repository: `file://${repository}`,
      description: 'Fixture.',
      agents: ['agents'],
      license: 'MIT',
    };
    const failed = await acquireApprovedSkillSource({
      id: 'fixture',
      revision: 'f'.repeat(40),
      rizzHome: home,
      approved: true,
      catalog: [fixture],
    });
    expect(failed).toMatchObject({ ok: false, error: { code: 'SKILL_SOURCE_FETCH_FAILED' } });
    const sourceBase = join(home, 'global', 'skills', 'sources', 'fixture');
    const entries = await import('node:fs/promises').then(async ({ readdir }) =>
      readdir(sourceBase),
    );
    expect(entries).toEqual([]);
  });
});
