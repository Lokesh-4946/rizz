import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enablePinnedSkill, listEnabledProjectSkills } from './project-skill-enablement.js';
import { applySkillUpdate, previewSkillUpdate, removeProjectSkill } from './skill-lifecycle.js';
import { addPinnedSkill, readPinnedSkillRecord } from './skill-source-manager.js';

const roots: string[] = [];

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'rizz@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: root });
  return root;
}

async function commit(root: string, message: string): Promise<string> {
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', message], { cwd: root });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture() {
  const sourceRepository = await repository('rizz-lifecycle-source-');
  const sourceDir = join(sourceRepository, 'skills', 'review-evidence');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceRepository, 'LICENSE'), 'MIT License\n');
  await writeFile(
    join(sourceDir, 'SKILL.md'),
    '---\nname: review-evidence\ndescription: Review version one.\n---\n',
  );
  const firstRevision = await commit(sourceRepository, 'v1');
  const project = await repository('rizz-lifecycle-project-');
  await writeFile(join(project, 'README.md'), '# project\n');
  await commit(project, 'project');
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-lifecycle-home-'));
  roots.push(rizzHome);
  const pinned = await addPinnedSkill({
    sourceDir,
    rizzHome,
    revision: firstRevision,
    approved: true,
  });
  if (!pinned.ok) throw new Error(pinned.error.message);
  const enabled = await enablePinnedSkill({
    rootDir: project,
    rizzHome,
    name: 'review-evidence',
    agents: ['codex'],
    approved: true,
  });
  if (!enabled.ok) throw new Error(enabled.error.message);
  await writeFile(
    join(sourceDir, 'SKILL.md'),
    '---\nname: review-evidence\ndescription: Review version two.\n---\n',
  );
  await writeFile(join(sourceDir, 'examples.md'), '# New evidence example\n');
  const secondRevision = await commit(sourceRepository, 'v2');
  return { sourceDir, project, rizzHome, firstRevision, secondRevision, pinned, enabled };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('skill update and ownership lifecycle', () => {
  it('previews exact update changes without writing global, project, or repository state', async () => {
    const setup = await fixture();
    const registryPath = join(setup.rizzHome, 'global', 'skills', 'registry.json');
    const registryBefore = await readFile(registryPath, 'utf8');
    const manifestBefore = await readFile(setup.enabled.value.manifest_path, 'utf8');
    const preview = await previewSkillUpdate({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      sourceDir: setup.sourceDir,
      revision: setup.secondRevision,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value).toMatchObject({
      name: 'review-evidence',
      current_revision: setup.firstRevision,
      proposed_revision: setup.secondRevision,
      project_enabled: true,
    });
    expect(preview.value.files.added).toEqual(['examples.md']);
    expect(preview.value.files.changed).toEqual(['SKILL.md']);
    expect(await readFile(registryPath, 'utf8')).toBe(registryBefore);
    expect(await readFile(setup.enabled.value.manifest_path, 'utf8')).toBe(manifestBefore);
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: setup.project, encoding: 'utf8' }),
    ).toBe('');
  });

  it('applies an approved update and preserves the old immutable cache for rollback', async () => {
    const setup = await fixture();
    const applied = await applySkillUpdate({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      sourceDir: setup.sourceDir,
      revision: setup.secondRevision,
      approved: true,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.previous_digest).toBe(setup.pinned.value.digest);
    expect(applied.value.digest).not.toBe(setup.pinned.value.digest);
    expect(applied.value.project_updated).toBe(true);
    expect(await readFile(applied.value.history_path, 'utf8')).toContain(setup.firstRevision);
    await expect(stat(setup.pinned.value.cache_dir)).resolves.toMatchObject({});
    const enabled = await listEnabledProjectSkills({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
    });
    expect(enabled.ok && enabled.value.skills[0]).toMatchObject({
      digest: applied.value.digest,
      agents: ['codex'],
    });
  });

  it('removes only Rizz-owned project enablement, records history, and retains the global pin', async () => {
    const setup = await fixture();
    const removed = await removeProjectSkill({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      name: 'review-evidence',
      approved: true,
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.removed).toBe(true);
    expect(await readFile(removed.value.history_path, 'utf8')).toContain(setup.pinned.value.digest);
    const pinned = await readPinnedSkillRecord({
      rizzHome: setup.rizzHome,
      name: 'review-evidence',
    });
    expect(pinned.ok).toBe(true);
    const listed = await listEnabledProjectSkills({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
    });
    expect(listed.ok && listed.value.skills).toHaveLength(0);
  });

  it('refuses removal when the project entry is not owned by Rizz', async () => {
    const setup = await fixture();
    const manifest = JSON.parse(await readFile(setup.enabled.value.manifest_path, 'utf8'));
    manifest.skills['review-evidence'].owner = 'user';
    await writeFile(setup.enabled.value.manifest_path, `${JSON.stringify(manifest)}\n`);
    const removed = await removeProjectSkill({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      name: 'review-evidence',
      approved: true,
    });
    expect(removed).toMatchObject({ ok: false, error: { code: 'SKILL_OWNERSHIP_MISMATCH' } });
    expect(await readFile(setup.enabled.value.manifest_path, 'utf8')).toContain('"owner":"user"');
  });
});
