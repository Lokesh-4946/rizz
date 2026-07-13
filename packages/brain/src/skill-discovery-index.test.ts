import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeContextCommand } from './context-command.js';
import { searchAcquiredSkills } from './skill-discovery-index.js';

const roots: string[] = [];

function gitFixture(cwd: string, args: readonly string[]): string {
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

async function acquiredOpenAiFixture(): Promise<{
  readonly home: string;
  readonly repository: string;
  readonly revision: string;
  readonly checkout: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), 'rizz-skill-discovery-source-'));
  const home = await mkdtemp(join(tmpdir(), 'rizz-skill-discovery-home-'));
  roots.push(repository, home);
  gitFixture(repository, ['init', '-q']);
  gitFixture(repository, ['config', 'user.email', 'rizz@example.test']);
  gitFixture(repository, ['config', 'user.name', 'Rizz Test']);
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
  gitFixture(repository, ['add', '.']);
  gitFixture(repository, ['commit', '-qm', 'fixture']);
  const revision = gitFixture(repository, ['rev-parse', 'HEAD']);
  const checkout = join(home, 'global', 'skills', 'sources', 'openai-skills', revision);
  await mkdir(join(checkout, '..'), { recursive: true });
  gitFixture(repository, ['clone', '--quiet', repository, checkout]);
  gitFixture(checkout, ['remote', 'set-url', 'origin', 'https://github.com/openai/skills.git']);
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

    gitFixture(setup.checkout, ['reset', '--hard', '--quiet']);
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
