import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileTaskBrief } from './context-loop.js';
import { generateProjectBrain } from './index.js';
import { enablePinnedSkill, listEnabledProjectSkills } from './project-skill-enablement.js';
import { prepareProjectStore } from './project-store.js';
import { addPinnedSkill } from './skill-source-manager.js';

const roots: string[] = [];

async function gitRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'rizz@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: root });
  return root;
}

async function fixture() {
  const sourceRepository = await gitRepo('rizz-enable-source-');
  const sourceDir = join(sourceRepository, 'skills', 'review-evidence');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceRepository, 'LICENSE'), 'MIT License\n');
  await writeFile(
    join(sourceDir, 'SKILL.md'),
    '---\nname: review-evidence\ndescription: Review repository changes with exact evidence.\n---\n',
  );
  execFileSync('git', ['add', '.'], { cwd: sourceRepository });
  execFileSync('git', ['commit', '-qm', 'skill'], { cwd: sourceRepository });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRepository,
    encoding: 'utf8',
  }).trim();
  const project = await gitRepo('rizz-enable-project-');
  await writeFile(join(project, 'README.md'), '# project\n');
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'project'], { cwd: project });
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-enable-home-'));
  roots.push(rizzHome);
  const pinned = await addPinnedSkill({
    sourceDir,
    rizzHome,
    revision,
    approved: true,
  });
  if (!pinned.ok) throw new Error(pinned.error.message);
  return { sourceDir, project, rizzHome, pinned };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('isolated project skill enablement', () => {
  it('enables a pinned skill for selected compatible agents without changing the repository', async () => {
    const setup = await fixture();
    const enabled = await enablePinnedSkill({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      name: 'review-evidence',
      agents: ['codex', 'claude'],
      approved: true,
    });
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    expect(enabled.value).toMatchObject({
      name: 'review-evidence',
      digest: setup.pinned.value.digest,
      agents: ['claude', 'codex'],
      owner: 'rizz',
    });
    expect(enabled.value.manifest_path).toContain(setup.rizzHome);
    await expect(stat(join(setup.project, '.rizz'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: setup.project, encoding: 'utf8' }),
    ).toBe('');
  });

  it('rejects unknown skills, unsupported agents, and cache tampering', async () => {
    const setup = await fixture();
    const missing = await enablePinnedSkill({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      name: 'missing',
      agents: ['codex'],
      approved: true,
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'SKILL_NOT_PINNED' } });
    const incompatible = await enablePinnedSkill({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      name: 'review-evidence',
      agents: ['unknown'],
      approved: true,
    });
    expect(incompatible).toMatchObject({ ok: false, error: { code: 'SKILL_AGENT_UNSUPPORTED' } });
    await writeFile(join(setup.pinned.value.cache_dir, 'SKILL.md'), 'tampered\n');
    const tampered = await enablePinnedSkill({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      name: 'review-evidence',
      agents: ['codex'],
      approved: true,
    });
    expect(tampered).toMatchObject({ ok: false, error: { code: 'SKILL_CACHE_TAMPERED' } });
  });

  it('requires project-level approval for credential-bearing skills', async () => {
    const setup = await fixture();
    const refused = await enablePinnedSkill({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      name: 'review-evidence',
      agents: ['codex'],
      approved: false,
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'SKILL_ENABLE_APPROVAL_REQUIRED' } });
  });

  it('keeps enablement isolated between projects with similar content', async () => {
    const setup = await fixture();
    const secondProject = await gitRepo('rizz-enable-project-');
    await writeFile(join(secondProject, 'README.md'), '# project\n');
    execFileSync('git', ['add', '.'], { cwd: secondProject });
    execFileSync('git', ['commit', '-qm', 'project'], { cwd: secondProject });
    await enablePinnedSkill({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      name: 'review-evidence',
      agents: ['codex'],
      approved: true,
    });
    const first = await listEnabledProjectSkills({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
    });
    const second = await listEnabledProjectSkills({
      rootDir: secondProject,
      rizzHome: setup.rizzHome,
    });
    expect(first.ok && first.value.skills).toHaveLength(1);
    expect(second.ok && second.value.skills).toHaveLength(0);
    expect(first.ok && second.ok && first.value.project_id).not.toBe(
      second.ok && second.value.project_id,
    );
  });

  it('projects enabled compatible skills into the bounded task brief', async () => {
    const setup = await fixture();
    await enablePinnedSkill({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      name: 'review-evidence',
      agents: ['codex'],
      approved: true,
    });
    const store = await prepareProjectStore({ rootDir: setup.project, rizzHome: setup.rizzHome });
    if (!store.ok) throw new Error(store.error.message);
    const brain = await generateProjectBrain({
      rootDir: setup.project,
      outputDir: store.value.projectDir,
    });
    if (!brain.ok) throw new Error(brain.error.message);
    const brief = await compileTaskBrief({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      task: 'Review repository changes',
    });
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect((brief.value as unknown as { compatible_skills: unknown }).compatible_skills).toEqual([
      expect.objectContaining({ name: 'review-evidence', agents: ['codex'] }),
    ]);
  });

  it('returns a structured error for corrupted project enablement state', async () => {
    const setup = await fixture();
    const enabled = await enablePinnedSkill({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      name: 'review-evidence',
      agents: ['codex'],
      approved: true,
    });
    if (!enabled.ok) throw new Error(enabled.error.message);
    await writeFile(enabled.value.manifest_path, '{"project_id":"wrong","skills":[]}\n');
    await expect(
      listEnabledProjectSkills({ rootDir: setup.project, rizzHome: setup.rizzHome }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'SKILL_ENABLEMENT_INVALID' },
    });
  });
});
