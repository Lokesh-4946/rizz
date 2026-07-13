import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pinAcquiredSkill, previewAcquiredSkill } from './acquired-skill-selection.js';
import { executeContextCommand } from './context-command.js';
import { doctorSkillRegistry } from './skill-registry-doctor.js';

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

async function fixture(): Promise<{
  readonly home: string;
  readonly repository: string;
  readonly checkout: string;
  readonly revision: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), 'rizz-selected-skill-source-'));
  const home = await mkdtemp(join(tmpdir(), 'rizz-selected-skill-home-'));
  roots.push(repository, home);
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'rizz@example.test']);
  git(repository, ['config', 'user.name', 'Rizz Test']);
  await writeFile(join(repository, 'LICENSE'), 'Approved source license fixture.\n');
  await mkdir(join(repository, 'skills', 'review', 'scripts'), { recursive: true });
  await writeFile(
    join(repository, 'skills', 'review', 'SKILL.md'),
    '---\nname: evidence-review\ndescription: Review exact evidence.\n---\n',
  );
  await writeFile(
    join(repository, 'skills', 'review', 'scripts', 'check.sh'),
    `#!/bin/sh\ntouch "${join(repository, 'executed')}"\n`,
  );
  await mkdir(join(repository, 'skills', 'other'), { recursive: true });
  await writeFile(
    join(repository, 'skills', 'other', 'SKILL.md'),
    '---\nname: other-skill\ndescription: Another exact skill.\n---\n',
  );
  await mkdir(join(repository, 'skills', 'duplicate', 'scripts'), { recursive: true });
  await writeFile(
    join(repository, 'skills', 'duplicate', 'SKILL.md'),
    '---\nname: evidence-review\ndescription: Review exact evidence.\n---\n',
  );
  await writeFile(
    join(repository, 'skills', 'duplicate', 'scripts', 'check.sh'),
    `#!/bin/sh\ntouch "${join(repository, 'executed')}"\n`,
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-qm', 'fixture']);
  const revision = git(repository, ['rev-parse', 'HEAD']);
  const checkout = join(home, 'global', 'skills', 'sources', 'openai-skills', revision);
  await mkdir(join(checkout, '..'), { recursive: true });
  git(repository, ['clone', '--quiet', repository, checkout]);
  git(checkout, ['remote', 'set-url', 'origin', 'https://github.com/openai/skills.git']);
  return { home, repository, checkout, revision };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('selection and pinning from acquired collections', () => {
  it('previews and approval-gates one exact path with complete provenance without execution', async () => {
    const setup = await fixture();
    const options = {
      rizzHome: setup.home,
      sourceId: 'openai-skills',
      revision: setup.revision,
      skillPath: 'skills/review',
    };

    const preview = await previewAcquiredSkill(options);
    expect(preview).toMatchObject({
      ok: true,
      value: {
        name: 'evidence-review',
        source_id: 'openai-skills',
        skill_path: 'skills/review',
        source_repository: 'https://github.com/openai/skills.git',
        revision: setup.revision,
        license: 'Apache-2.0',
        attribution: 'OpenAI',
        requirements: { shell: true, network: false, credentials: false },
        audit_status: 'approval-required',
        supported_agents: ['codex', 'agents'],
        approval_required: true,
        writes_repository: false,
        executes_content: false,
      },
    });
    if (!preview.ok) return;
    expect(preview.value.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.value.file_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.value.audit_findings.map((finding) => finding.code)).toContain(
      'SKILL_SCRIPT_PRESENT',
    );

    const rejected = await pinAcquiredSkill({ ...options, approved: false });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'SKILL_APPROVAL_REQUIRED' },
    });
    await expect(readFile(join(setup.repository, 'executed'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('pins immutable cached content and records exact acquired-source evidence through the CLI', async () => {
    const setup = await fixture();
    const args = [
      'skills',
      'pin',
      'openai-skills',
      '--pin',
      setup.revision,
      '--path',
      'skills/review',
      '--preview',
      '--json',
    ];
    const preview = await executeContextCommand({
      rootDir: setup.repository,
      rizzHome: setup.home,
      args,
    });
    expect(preview).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(preview.stdout)).toMatchObject({
      source_id: 'openai-skills',
      revision: setup.revision,
      skill_path: 'skills/review',
      executes_content: false,
    });

    const applied = await executeContextCommand({
      rootDir: setup.repository,
      rizzHome: setup.home,
      args: args.map((arg) => (arg === '--preview' ? '--apply' : arg)).concat('--approve'),
    });
    expect(applied).toMatchObject({ exitCode: 0, stderr: '' });
    const result = JSON.parse(applied.stdout) as { readonly cache_dir: string };
    expect(result.cache_dir.startsWith(setup.home)).toBe(true);
    const registry = JSON.parse(
      await readFile(join(setup.home, 'global', 'skills', 'registry.json'), 'utf8'),
    );
    expect(registry.skills['evidence-review']).toMatchObject({
      source_id: 'openai-skills',
      skill_path: 'skills/review',
      source_repository: 'https://github.com/openai/skills.git',
      revision: setup.revision,
      license: 'Apache-2.0',
      attribution: 'OpenAI',
      audit_status: 'approval-required',
      requirements: { shell: true, network: false, credentials: false },
      supported_agents: ['codex', 'agents'],
    });
    expect(registry.skills['evidence-review'].file_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.skills['evidence-review'].audit_findings).toEqual([
      expect.objectContaining({ code: 'SKILL_SCRIPT_PRESENT' }),
    ]);
    expect(await readFile(join(result.cache_dir, 'SKILL.md'), 'utf8')).toContain(
      'name: evidence-review',
    );
    await expect(readFile(join(setup.repository, 'executed'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects traversal, dirty checkouts, revision drift, and conflicting skill names', async () => {
    const setup = await fixture();
    const base = {
      rizzHome: setup.home,
      sourceId: 'openai-skills',
      revision: setup.revision,
    };
    const traversed = await previewAcquiredSkill({ ...base, skillPath: '../skills/review' });
    expect(traversed).toMatchObject({
      ok: false,
      error: { code: 'SKILL_PATH_INVALID' },
    });

    await writeFile(join(setup.checkout, 'untracked.txt'), 'contamination\n');
    const dirty = await previewAcquiredSkill({ ...base, skillPath: 'skills/review' });
    expect(dirty).toMatchObject({
      ok: false,
      error: { code: 'SKILL_SOURCE_TAMPERED' },
    });
    await rm(join(setup.checkout, 'untracked.txt'));

    const first = await pinAcquiredSkill({
      ...base,
      skillPath: 'skills/review',
      approved: true,
    });
    expect(first.ok).toBe(true);
    const conflict = await pinAcquiredSkill({
      ...base,
      skillPath: 'skills/duplicate',
      approved: true,
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'SKILL_NAME_AMBIGUOUS' },
    });
    const doctor = await doctorSkillRegistry({ rizzHome: setup.home });
    expect(doctor).toMatchObject({ ok: true, value: { healthy: true, findings: [] } });

    git(setup.checkout, ['config', 'user.email', 'rizz@example.test']);
    git(setup.checkout, ['config', 'user.name', 'Rizz Test']);
    git(setup.checkout, ['commit', '--allow-empty', '-qm', 'drift']);
    const drifted = await previewAcquiredSkill({ ...base, skillPath: 'skills/other' });
    expect(drifted).toMatchObject({
      ok: false,
      error: { code: 'SKILL_SOURCE_REVISION_DRIFT' },
    });
  });

  it('keeps concurrent selected pins without losing either registry record', async () => {
    const setup = await fixture();
    const base = {
      rizzHome: setup.home,
      sourceId: 'openai-skills',
      revision: setup.revision,
      approved: true,
    };
    const results = await Promise.all([
      pinAcquiredSkill({ ...base, skillPath: 'skills/review' }),
      pinAcquiredSkill({ ...base, skillPath: 'skills/other' }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const registry = JSON.parse(
      await readFile(join(setup.home, 'global', 'skills', 'registry.json'), 'utf8'),
    );
    expect(Object.keys(registry.skills).sort()).toEqual(['evidence-review', 'other-skill']);
  });

  it('refuses a cache-root symlink without writing through it', async () => {
    const setup = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'rizz-selected-skill-outside-'));
    roots.push(outside);
    await symlink(
      outside,
      join(setup.home, 'global', 'skills', 'cache'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await pinAcquiredSkill({
      rizzHome: setup.home,
      sourceId: 'openai-skills',
      revision: setup.revision,
      skillPath: 'skills/review',
      approved: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SKILL_CACHE_SYMLINK_REJECTED' },
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a symlink inside an existing immutable cache object', async () => {
    const setup = await fixture();
    const preview = await previewAcquiredSkill({
      rizzHome: setup.home,
      sourceId: 'openai-skills',
      revision: setup.revision,
      skillPath: 'skills/review',
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const outside = await mkdtemp(join(tmpdir(), 'rizz-selected-skill-outside-'));
    roots.push(outside);
    const object = join(setup.home, 'global', 'skills', 'cache', preview.value.digest);
    await mkdir(object, { recursive: true });
    await symlink(
      outside,
      join(object, 'scripts'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await pinAcquiredSkill({
      rizzHome: setup.home,
      sourceId: 'openai-skills',
      revision: setup.revision,
      skillPath: 'skills/review',
      approved: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SKILL_CACHE_SYMLINK_REJECTED' },
    });
    expect(await readdir(outside)).toEqual([]);
  });
});
