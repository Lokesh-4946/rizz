import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type MissionPreviewOptions,
  acceptMission,
  previewMission,
  verifyMissionIdentity,
} from './mission-contract.js';
import { enablePinnedSkill } from './project-skill-enablement.js';
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

async function addSkill(params: {
  readonly rizzHome: string;
  readonly project: string;
  readonly name: string;
  readonly body: string;
}): Promise<{ readonly cacheDir: string }> {
  const sourceRepository = await gitRepo(`rizz-mission-${params.name}-`);
  const sourceDir = join(sourceRepository, 'skills', params.name);
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceRepository, 'LICENSE'), 'MIT License\n');
  await writeFile(
    join(sourceDir, 'SKILL.md'),
    `---\nname: ${params.name}\ndescription: Review exact mission evidence.\n---\n${params.body}\n`,
  );
  execFileSync('git', ['add', '.'], { cwd: sourceRepository });
  execFileSync('git', ['commit', '-qm', 'skill'], { cwd: sourceRepository });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRepository,
    encoding: 'utf8',
  }).trim();
  const pinned = await addPinnedSkill({
    sourceDir,
    rizzHome: params.rizzHome,
    revision,
    approved: true,
  });
  if (!pinned.ok) throw new Error(pinned.error.message);
  const enabled = await enablePinnedSkill({
    rootDir: params.project,
    rizzHome: params.rizzHome,
    name: params.name,
    agents: ['codex'],
    approved: true,
  });
  if (!enabled.ok) throw new Error(enabled.error.message);
  return { cacheDir: pinned.value.cache_dir };
}

async function fixture(options: { readonly risky?: boolean } = {}) {
  const project = await gitRepo('rizz-mission-project-');
  await mkdir(join(project, 'src'));
  await writeFile(join(project, 'src', 'a.ts'), 'export const a = true;\n');
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'project'], { cwd: project });
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-mission-home-'));
  roots.push(rizzHome);
  const skillName = options.risky ? 'network-review' : 'review-evidence';
  const skill = await addSkill({
    rizzHome,
    project,
    name: skillName,
    body: options.risky
      ? 'Run curl https://example.test before review.'
      : 'Inspect local evidence.',
  });
  return { project, rizzHome, skillName, cacheDir: skill.cacheDir };
}

function previewOptions(
  setup: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<MissionPreviewOptions> = {},
): MissionPreviewOptions {
  return {
    rootDir: setup.project,
    rizzHome: setup.rizzHome,
    task: 'Review `src/a.ts` with exact evidence',
    agent: 'codex',
    scope: ['src/a.ts'],
    scopeStatus: 'accepted',
    requestedSkills: [setup.skillName],
    constraints: ['No network execution'],
    stopConditions: ['Stop when focused tests fail unexpectedly'],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('versioned mission contract', () => {
  it('previews deterministically, persists acceptance externally, and verifies exact identity', async () => {
    const setup = await fixture();
    const options = previewOptions(setup);

    const first = await previewMission(options);
    const second = await previewMission(options);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) return;
    expect(first.value).toMatchObject({
      schema_version: 1,
      mission_id: expect.stringMatching(/^[a-f0-9]{64}$/),
      repository_revision: expect.stringMatching(/^[a-f0-9]{40}$/),
      agent: 'codex',
      scope: ['src/a.ts'],
      scope_status: 'accepted',
      approved: false,
      blockers: [],
      selected_skills: [
        expect.objectContaining({
          name: 'review-evidence',
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          revision: expect.stringMatching(/^[a-f0-9]{40}$/),
          selection_reasons: ['explicitly-requested'],
        }),
      ],
    });

    const accepted = await acceptMission({
      ...options,
      missionId: first.value.mission_id,
      approved: true,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.approved).toBe(true);
    const verified = await verifyMissionIdentity({
      rootDir: setup.project,
      rizzHome: setup.rizzHome,
      missionId: accepted.value.mission_id,
    });
    expect(verified).toEqual(accepted);

    const store = await prepareProjectStore({ rootDir: setup.project, rizzHome: setup.rizzHome });
    if (!store.ok) throw new Error(store.error.message);
    const persisted = await readFile(
      join(store.value.projectDir, 'work', 'missions', `${accepted.value.mission_id}.json`),
      'utf8',
    );
    expect(JSON.parse(persisted)).toEqual(accepted.value);
  });

  it('requires renewed approval when scope or selected skill identity changes', async () => {
    const setup = await fixture();
    const options = previewOptions(setup);
    const preview = await previewMission(options);
    if (!preview.ok) throw new Error(preview.error.message);

    await expect(
      acceptMission({
        ...options,
        scope: ['src/a.ts', 'src/b.ts'],
        missionId: preview.value.mission_id,
        approved: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'MISSION_PREVIEW_STALE' } });
    await expect(
      acceptMission({
        ...options,
        requestedSkills: [],
        missionId: preview.value.mission_id,
        approved: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'MISSION_PREVIEW_STALE' } });
  });

  it('refuses open scope and requires explicit approval for risky skills', async () => {
    const openSetup = await fixture();
    const openOptions = previewOptions(openSetup, {
      scope: [],
      scopeStatus: 'open',
      requestedSkills: [],
    });
    const open = await previewMission(openOptions);
    if (!open.ok) throw new Error(open.error.message);
    await expect(
      acceptMission({
        ...openOptions,
        missionId: open.value.mission_id,
        approved: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'MISSION_SCOPE_UNRESOLVED' } });

    const riskySetup = await fixture({ risky: true });
    const riskyOptions = previewOptions(riskySetup);
    const risky = await previewMission(riskyOptions);
    expect(risky).toMatchObject({
      ok: true,
      value: {
        blockers: [
          expect.objectContaining({
            code: 'MISSION_SKILL_APPROVAL_REQUIRED',
            skill: 'network-review',
          }),
        ],
      },
    });
    if (!risky.ok) return;
    await expect(
      acceptMission({
        ...riskyOptions,
        missionId: risky.value.mission_id,
        approved: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'MISSION_SKILL_APPROVAL_REQUIRED' },
    });
  });

  it('rejects tampered pinned content and stale accepted repository revisions', async () => {
    const setup = await fixture();
    const options = previewOptions(setup);
    const preview = await previewMission(options);
    if (!preview.ok) throw new Error(preview.error.message);
    const accepted = await acceptMission({
      ...options,
      missionId: preview.value.mission_id,
      approved: true,
    });
    if (!accepted.ok) throw new Error(accepted.error.message);

    await writeFile(join(setup.cacheDir, 'SKILL.md'), 'tampered\n');
    await expect(previewMission(options)).resolves.toMatchObject({
      ok: false,
      error: { code: 'SKILL_CACHE_TAMPERED' },
    });

    await writeFile(join(setup.project, 'src', 'b.ts'), 'export const b = true;\n');
    execFileSync('git', ['add', '.'], { cwd: setup.project });
    execFileSync('git', ['commit', '-qm', 'revision change'], { cwd: setup.project });
    await expect(
      verifyMissionIdentity({
        rootDir: setup.project,
        rizzHome: setup.rizzHome,
        missionId: accepted.value.mission_id,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'MISSION_PREVIEW_STALE' } });
  });

  it('keeps AI-suggested constraints and non-goals proposed with literal citations', async () => {
    const setup = await fixture();
    const preview = await previewMission(
      previewOptions(setup, {
        constraints: ['User requires local-only execution'],
        nonGoals: ['Accepted spec excludes generated files'],
        proposedConstraints: [
          {
            statement: 'Keep changes near the cited implementation',
            citations: [{ kind: 'path', value: 'src/a.ts' }],
          },
        ],
        proposedNonGoals: [
          {
            statement: 'Consider leaving adjacent modules unchanged',
            citations: [{ kind: 'symbol', value: 'a', path: 'src/a.ts' }],
          },
        ],
      }),
    );

    expect(preview).toMatchObject({
      ok: true,
      value: {
        constraints: ['User requires local-only execution'],
        non_goals: ['Accepted spec excludes generated files'],
        proposed_constraints: [
          {
            statement: 'Keep changes near the cited implementation',
            source: 'ai',
            citations: [{ kind: 'path', value: 'src/a.ts' }],
          },
        ],
        proposed_non_goals: [
          {
            statement: 'Consider leaving adjacent modules unchanged',
            source: 'ai',
            citations: [{ kind: 'symbol', value: 'a', path: 'src/a.ts' }],
          },
        ],
      },
    });
  });

  it('preserves risk provenance and rejects unsupported AI inference', async () => {
    const setup = await fixture();
    const valid = await previewMission(
      previewOptions(setup, {
        risks: [
          { statement: 'User reported an API stability risk', provenance: 'explicit' },
          {
            statement: 'The changed symbol may affect its callers',
            provenance: 'ai_inferred',
            citations: [{ kind: 'symbol', value: 'a', path: 'src/a.ts' }],
          },
        ],
      }),
    );

    expect(valid).toMatchObject({
      ok: true,
      value: {
        risks: [
          {
            statement: 'The changed symbol may affect its callers',
            provenance: 'ai_inferred',
            status: 'hypothesis',
            citations: [{ kind: 'symbol', value: 'a', path: 'src/a.ts' }],
          },
          {
            statement: 'User reported an API stability risk',
            provenance: 'explicit',
            status: 'reported',
            citations: [],
          },
        ],
      },
    });

    await expect(
      previewMission(
        previewOptions(setup, {
          risks: [{ statement: 'Unsupported inference', provenance: 'ai_inferred' }],
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'MISSION_AI_RISK_EVIDENCE_REQUIRED' },
    });
    await expect(
      previewMission(
        previewOptions(setup, {
          risks: [
            {
              statement: 'Missing implementation may be risky',
              provenance: 'ai_inferred',
              citations: [{ kind: 'path', value: 'src/missing.ts' }],
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'MISSION_REFERENCE_UNSUPPORTED' },
    });
  });
});
