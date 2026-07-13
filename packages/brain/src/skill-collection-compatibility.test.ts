import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeContextCommand } from './context-command.js';
import { scanSkillCollection } from './skill-collection-compatibility.js';

const roots: string[] = [];

async function fixture(): Promise<{ repository: string; revision: string }> {
  const repository = await mkdtemp(join(tmpdir(), 'rizz-skill-collection-'));
  roots.push(repository);
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'rizz@example.test'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: repository });
  await writeFile(join(repository, 'LICENSE'), 'MIT License\n');
  await mkdir(join(repository, 'skills', 'valid'), { recursive: true });
  await writeFile(
    join(repository, 'skills', 'valid', 'SKILL.md'),
    '---\nname: valid\ndescription: Valid skill.\n---\n',
  );
  await mkdir(join(repository, 'skills', 'quoted'), { recursive: true });
  await writeFile(
    join(repository, 'skills', 'quoted', 'SKILL.md'),
    '---\nname: "quoted"\ndescription: "Quoted skill."\n---\n',
  );
  await mkdir(join(repository, 'skills', 'invalid'), { recursive: true });
  await writeFile(join(repository, 'skills', 'invalid', 'SKILL.md'), '# Missing frontmatter\n');
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'collection'], { cwd: repository });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  return { repository, revision };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('upstream skill collection compatibility', () => {
  it('reports every tracked skill with exact revision and structured compatibility evidence', async () => {
    const setup = await fixture();
    const result = await scanSkillCollection({ checkoutDir: setup.repository });
    expect(result).toMatchObject({
      ok: true,
      value: { revision: setup.revision, total: 3, compatible: 2, incompatible: 1 },
    });
    if (!result.ok) return;
    expect(result.value.skills).toEqual([
      {
        path: 'skills/invalid',
        compatible: false,
        audit_status: null,
        findings: ['SKILL_MANIFEST_INVALID'],
      },
      { path: 'skills/quoted', compatible: true, audit_status: 'clean', findings: [] },
      { path: 'skills/valid', compatible: true, audit_status: 'clean', findings: [] },
    ]);
  });

  it('scans only the exact previously acquired global checkout through CLI JSON', async () => {
    const setup = await fixture();
    const home = await mkdtemp(join(tmpdir(), 'rizz-skill-home-'));
    roots.push(home);
    const checkout = join(home, 'global', 'skills', 'sources', 'openai-skills', setup.revision);
    await mkdir(join(checkout, '..'), { recursive: true });
    execFileSync('git', ['clone', '--quiet', setup.repository, checkout]);
    const result = await executeContextCommand({
      rootDir: setup.repository,
      rizzHome: home,
      args: ['skills', 'scan', 'openai-skills', '--pin', setup.revision, '--json'],
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      total: 3,
      compatible: 2,
      revision: setup.revision,
    });
  });
});
