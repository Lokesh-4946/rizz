import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeContextCommand } from './context-command.js';
import { searchAcquiredSkills } from './skill-discovery-index.js';

const roots: string[] = [];

async function acquiredOpenAiFixture(): Promise<{
  readonly home: string;
  readonly repository: string;
  readonly revision: string;
  readonly checkout: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), 'rizz-skill-discovery-source-'));
  const home = await mkdtemp(join(tmpdir(), 'rizz-skill-discovery-home-'));
  roots.push(repository, home);
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'rizz@example.test'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: repository });
  await writeFile(join(repository, 'LICENSE'), 'Approved source license fixture.\n');
  await mkdir(join(repository, 'skills', 'review'), { recursive: true });
  await writeFile(
    join(repository, 'skills', 'review', 'SKILL.md'),
    [
      '---',
      'name: review-evidence',
      'description: Review exact repository evidence.',
      '---',
      'Use curl with $REVIEW_API_TOKEN only after approval.',
      '',
    ].join('\n'),
  );
  await mkdir(join(repository, 'skills', 'testing'), { recursive: true });
  await writeFile(
    join(repository, 'skills', 'testing', 'SKILL.md'),
    '---\nname: test-first\ndescription: Write focused tests first.\n---\n',
  );
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const checkout = join(home, 'global', 'skills', 'sources', 'openai-skills', revision);
  await mkdir(join(checkout, '..'), { recursive: true });
  execFileSync('git', ['clone', '--quiet', repository, checkout]);
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/openai/skills.git'], {
    cwd: checkout,
  });
  return { home, repository, revision, checkout };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('acquired skill discovery index', () => {
  it('indexes and searches audited skills with exact source evidence outside repositories', async () => {
    const setup = await acquiredOpenAiFixture();

    const result = await searchAcquiredSkills({
      rizzHome: setup.home,
      query: 'repository evidence',
      limit: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        total_indexed: 2,
        matched: 1,
        returned: 1,
        truncated: false,
        results: [
          {
            name: 'review-evidence',
            description: 'Review exact repository evidence.',
            relative_path: 'skills/review',
            source_id: 'openai-skills',
            revision: setup.revision,
            source_repository: 'https://github.com/openai/skills.git',
            supported_agents: ['codex', 'agents'],
            audit_status: 'approval-required',
            requirements: { shell: false, network: true, credentials: true },
            license: 'Apache-2.0',
            attribution: 'OpenAI',
          },
        ],
      },
    });
    if (!result.ok) return;
    expect(result.value.index_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.value.results[0]?.audit_findings.map((finding) => finding.code)).not.toContain(
      'SKILL_LICENSE_UNKNOWN',
    );
    expect(result.value.index_path).toBe(
      join(setup.home, 'global', 'skills', 'indexes', `${result.value.index_digest}.json`),
    );
    const index = JSON.parse(await readFile(result.value.index_path, 'utf8')) as {
      readonly skills: readonly { readonly name: string }[];
    };
    expect(index.skills.map((skill) => skill.name)).toEqual(['review-evidence', 'test-first']);
    expect(result.value.index_path.startsWith(setup.repository)).toBe(false);
  });

  it('provides deterministic bounded CLI JSON with exact revision evidence', async () => {
    const setup = await acquiredOpenAiFixture();

    const first = await executeContextCommand({
      rootDir: setup.repository,
      rizzHome: setup.home,
      args: ['skills', 'search', '', '--limit', '1', '--json'],
    });
    const second = await executeContextCommand({
      rootDir: setup.repository,
      rizzHome: setup.home,
      args: ['skills', 'search', '', '--limit', '1', '--json'],
    });

    expect(first).toMatchObject({ exitCode: 0, stderr: '' });
    expect(first.stdout).toBe(second.stdout);
    expect(JSON.parse(first.stdout)).toMatchObject({
      total_indexed: 2,
      matched: 2,
      returned: 1,
      truncated: true,
      results: [{ name: 'review-evidence', revision: setup.revision }],
    });
  });

  it('rejects tampered and revision-drifted acquired checkouts', async () => {
    const setup = await acquiredOpenAiFixture();
    await writeFile(
      join(setup.checkout, 'skills', 'review', 'SKILL.md'),
      '---\nname: changed\ndescription: Tampered.\n---\n',
    );

    expect(await searchAcquiredSkills({ rizzHome: setup.home, query: '' })).toMatchObject({
      ok: false,
      error: { code: 'SKILL_SOURCE_TAMPERED' },
    });

    execFileSync('git', ['reset', '--hard', '--quiet'], { cwd: setup.checkout });
    const drifted = join(
      setup.home,
      'global',
      'skills',
      'sources',
      'openai-skills',
      'a'.repeat(40),
    );
    await rename(setup.checkout, drifted);
    expect(await searchAcquiredSkills({ rizzHome: setup.home, query: '' })).toMatchObject({
      ok: false,
      error: { code: 'SKILL_SOURCE_REVISION_DRIFT' },
    });
  });

  it('rejects an exact acquired source revision when its checkout is missing', async () => {
    const setup = await acquiredOpenAiFixture();
    const missingRevision = 'f'.repeat(40);

    const result = await executeContextCommand({
      rootDir: setup.repository,
      rizzHome: setup.home,
      args: [
        'skills',
        'search',
        'review',
        '--source',
        'openai-skills',
        '--pin',
        missingRevision,
        '--json',
      ],
    });

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: expect.stringContaining('SKILL_SOURCE_CACHE_MISSING'),
    });
  });

  it('rejects a symbolic revision before inspecting the acquired cache', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rizz-skill-discovery-empty-home-'));
    roots.push(home);

    expect(
      await searchAcquiredSkills({
        rizzHome: home,
        query: '',
        sourceId: 'openai-skills',
        revision: 'main',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'SKILL_SOURCE_REVISION_INVALID' },
    });
  });

  it('rejects a source-cache symlink that redirects acquired revisions outside Rizz home', async () => {
    const setup = await acquiredOpenAiFixture();
    const sourceBase = join(setup.checkout, '..');
    const redirected = await mkdtemp(join(tmpdir(), 'rizz-skill-discovery-redirect-'));
    roots.push(redirected);
    await rename(setup.checkout, join(redirected, setup.revision));
    await rm(sourceBase, { recursive: true, force: true });
    await symlink(redirected, sourceBase, process.platform === 'win32' ? 'junction' : 'dir');

    expect(await searchAcquiredSkills({ rizzHome: setup.home, query: '' })).toMatchObject({
      ok: false,
      error: { code: 'SKILL_SOURCE_TAMPERED' },
    });
  });

  it('refuses to write the content-addressed index inside the project repository', async () => {
    const setup = await acquiredOpenAiFixture();
    const repositoryLocalHome = join(setup.repository, '.rizz-home');
    await rename(setup.home, repositoryLocalHome);

    const result = await executeContextCommand({
      rootDir: setup.repository,
      rizzHome: repositoryLocalHome,
      args: ['skills', 'search', 'review', '--json'],
    });

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: expect.stringContaining('SKILL_INDEX_REPOSITORY_LOCAL'),
    });
    await expect(
      readFile(join(repositoryLocalHome, 'global', 'skills', 'indexes'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
