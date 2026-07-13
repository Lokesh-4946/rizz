import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeContextCommand } from './context-command.js';
import { doctorSkillRegistry } from './skill-registry-doctor.js';
import { addPinnedSkill } from './skill-source-manager.js';

const roots: string[] = [];

async function source(name: string, home: string): Promise<{ dir: string; revision: string }> {
  const repository = await mkdtemp(join(tmpdir(), `rizz-doctor-${name}-`));
  roots.push(repository);
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'rizz@example.test'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: repository });
  const dir = join(repository, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(repository, 'LICENSE'), 'MIT License\n');
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill.\n---\n`);
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', name], { cwd: repository });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  return { dir, revision };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('skill registry doctor', () => {
  it('serializes concurrent pins without losing a registry entry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rizz-doctor-home-'));
    roots.push(home);
    const [one, two] = await Promise.all([source('one', home), source('two', home)]);
    const results = await Promise.all([
      addPinnedSkill({
        sourceDir: one.dir,
        rizzHome: home,
        revision: one.revision,
        approved: true,
      }),
      addPinnedSkill({
        sourceDir: two.dir,
        rizzHome: home,
        revision: two.revision,
        approved: true,
      }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const registry = JSON.parse(
      await readFile(join(home, 'global', 'skills', 'registry.json'), 'utf8'),
    );
    expect(Object.keys(registry.skills).sort()).toEqual(['one', 'two']);
  });

  it('reports tampered, missing, and orphan caches without changing them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rizz-doctor-home-'));
    roots.push(home);
    const one = await source('one', home);
    const added = await addPinnedSkill({
      sourceDir: one.dir,
      rizzHome: home,
      revision: one.revision,
      approved: true,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await writeFile(join(added.value.cache_dir, 'SKILL.md'), 'tampered\n');
    const orphan = join(home, 'global', 'skills', 'cache', 'orphan');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'SKILL.md'), 'orphan\n');
    const report = await doctorSkillRegistry({ rizzHome: home });
    expect(report).toMatchObject({ ok: true, value: { healthy: false, repaired: false } });
    if (!report.ok) return;
    expect(report.value.findings.map((finding) => finding.code)).toEqual([
      'SKILL_CACHE_TAMPERED',
      'SKILL_CACHE_ORPHANED',
    ]);
    expect(await readFile(join(orphan, 'SKILL.md'), 'utf8')).toBe('orphan\n');
  });

  it('repairs only orphan caches after explicit approval and retains registered rollback objects', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rizz-doctor-home-'));
    roots.push(home);
    const cache = join(home, 'global', 'skills', 'cache');
    await mkdir(join(cache, 'orphan'), { recursive: true });
    await writeFile(join(cache, 'orphan', 'SKILL.md'), 'orphan\n');
    const rollback = join(cache, 'a'.repeat(64));
    await mkdir(rollback, { recursive: true });
    await writeFile(join(rollback, 'SKILL.md'), 'rollback\n');
    const preview = await doctorSkillRegistry({ rizzHome: home, repair: true, approved: false });
    expect(preview).toMatchObject({ ok: false, error: { code: 'SKILL_REPAIR_APPROVAL_REQUIRED' } });
    const repaired = await doctorSkillRegistry({ rizzHome: home, repair: true, approved: true });
    expect(repaired).toMatchObject({ ok: true, value: { healthy: false, repaired: true } });
    expect(await readFile(join(rollback, 'SKILL.md'), 'utf8')).toBe('rollback\n');
  });

  it('exposes JSON doctor and approval-gated repair through the CLI contract', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rizz-doctor-home-'));
    roots.push(home);
    const result = await executeContextCommand({
      rootDir: home,
      rizzHome: home,
      args: ['skills', 'doctor', '--json'],
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({ healthy: true, repaired: false });
    const rejected = await executeContextCommand({
      rootDir: home,
      rizzHome: home,
      args: ['skills', 'doctor', '--repair'],
    });
    expect(rejected.stderr).toContain('SKILL_REPAIR_APPROVAL_REQUIRED');
  });

  it('rejects malformed registry state with a stable structured error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rizz-doctor-home-'));
    roots.push(home);
    const base = join(home, 'global', 'skills');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'registry.json'), '{"schema_version":2,"skills":[]}\n');
    const result = await doctorSkillRegistry({ rizzHome: home });
    expect(result).toMatchObject({ ok: false, error: { code: 'SKILL_REGISTRY_INVALID' } });
  });
});
