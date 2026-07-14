import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeContextCommand } from './context-command.js';
import {
  compileTaskBrief,
  completeLoopWork,
  createLoopHandoff,
  readLoopStatus,
  recordLoopCheckpoint,
  startLoopWork,
} from './context-loop.js';
import { TASK_BRIEF_MAX_BYTES, TASK_BRIEF_MAX_CLAIMS } from './task-brief-budget.js';

const roots: string[] = [];

async function fixture(): Promise<{ rootDir: string; rizzHome: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), 'rizz-context-repo-'));
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-context-home-'));
  roots.push(rootDir, rizzHome);
  execFileSync('git', ['init', '-q'], { cwd: rootDir });
  execFileSync('git', ['config', 'user.email', 'rizz@example.test'], { cwd: rootDir });
  execFileSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: rootDir });
  await mkdir(join(rootDir, 'src'), { recursive: true });
  await writeFile(join(rootDir, 'src', 'hero.ts'), 'export const hero = true;\n');
  execFileSync('git', ['add', '.'], { cwd: rootDir });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: rootDir });
  return { rootDir, rizzHome };
}

async function seedBrain(rootDir: string, rizzHome: string): Promise<void> {
  const { prepareProjectStore } = await import('./project-store.js');
  const store = await prepareProjectStore({ rootDir, rizzHome, remote: null });
  if (!store.ok) throw new Error(store.error.message);
  const entitiesDir = join(store.value.brainDir, 'entities');
  await mkdir(entitiesDir, { recursive: true });
  await writeFile(
    join(store.value.brainDir, 'latest.json'),
    `${JSON.stringify({ generated_at: '2026-07-12T00:00:00.000Z' })}\n`,
  );
  await writeFile(
    join(entitiesDir, 'files.json'),
    `${JSON.stringify({
      entities: [
        {
          id: 'file:src/hero.ts',
          type: 'file',
          name: 'Hero',
          description: 'Homepage hero component',
          confidence: 'verified',
          evidence_ids: ['evidence:src/hero.ts'],
          source_files: ['src/hero.ts'],
        },
        {
          id: 'file:src/unrelated.ts',
          type: 'file',
          name: 'Unrelated',
          description: 'Unrelated worker',
          confidence: 'uncertain',
          evidence_ids: [],
          source_files: ['src/unrelated.ts'],
        },
      ],
    })}\n`,
  );
}

async function seedLargeInventoryBrain(rootDir: string, rizzHome: string): Promise<void> {
  const { prepareProjectStore } = await import('./project-store.js');
  const store = await prepareProjectStore({ rootDir, rizzHome, remote: null });
  if (!store.ok) throw new Error(store.error.message);
  const entitiesDir = join(store.value.brainDir, 'entities');
  await mkdir(entitiesDir, { recursive: true });
  await writeFile(
    join(store.value.brainDir, 'latest.json'),
    `${JSON.stringify({ generated_at: '2026-07-14T00:00:00.000Z' })}\n`,
  );
  await writeFile(
    join(entitiesDir, 'files.json'),
    `${JSON.stringify({
      entities: [
        {
          id: 'file:packages/expect/src/jest-expect.ts',
          type: 'file',
          name: 'jest-expect.ts',
          description: 'toHaveProperty matcher implementation',
          confidence: 'verified',
          evidence_ids: Array.from({ length: 20_000 }, (_, index) => `evidence:${index}`),
          source_files: [
            'packages/expect/src/jest-expect.ts',
            ...Array.from({ length: 20_000 }, (_, index) => `packages/模块-${index}/source.ts`),
          ],
        },
        {
          id: 'folder:docs-translations',
          type: 'folder',
          name: 'Translated docs',
          description: 'Router path test review documentation',
          confidence: 'verified',
          evidence_ids: Array.from({ length: 20_000 }, (_, index) => `docs-evidence:${index}`),
          source_files: Array.from(
            { length: 20_000 },
            (_, index) => `docs/translations/${index}.md`,
          ),
        },
      ],
    })}\n`,
  );
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('context compiler', () => {
  it('builds a bounded revision-stamped packet containing only cited relevant claims', async () => {
    const setup = await fixture();
    await seedBrain(setup.rootDir, setup.rizzHome);

    const result = await compileTaskBrief({
      ...setup,
      task: 'Update the homepage Hero',
      maxClaims: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.project_id).toMatch(/^[a-f0-9]{24}$/);
    expect(result.value.repository_revision).toMatch(/^[a-f0-9]{40}$/);
    expect(result.value.claims).toEqual([
      expect.objectContaining({
        entity_id: 'file:src/hero.ts',
        evidence_class: 'verified',
        source_files: ['src/hero.ts'],
        evidence_ids: ['evidence:src/hero.ts'],
      }),
    ]);
    expect(result.value.omissions).toContain('1 lower-ranked or uncited claim(s) omitted');
    expect(result.value.stale_evidence_warnings).toContain(
      'Brain evidence is timestamped but not bound to this exact repository revision.',
    );
  });

  it('provides matching JSON CLI contracts for briefs and loop state', async () => {
    const setup = await fixture();
    await seedBrain(setup.rootDir, setup.rizzHome);
    const previousHome = process.env.RIZZ_HOME;
    process.env.RIZZ_HOME = setup.rizzHome;
    try {
      const brief = await executeContextCommand({
        rootDir: setup.rootDir,
        args: ['brief', 'Update Hero', '--json'],
      });
      expect(brief.exitCode).toBe(0);
      expect(JSON.parse(brief.stdout)).toEqual(
        expect.objectContaining({ task: 'Update Hero', claims: expect.any(Array) }),
      );
      const started = await executeContextCommand({
        rootDir: setup.rootDir,
        args: ['loop', 'start', '--task', 'Update Hero', '--agent', 'codex', '--json'],
      });
      expect(started.exitCode).toBe(0);
      const status = await executeContextCommand({
        rootDir: setup.rootDir,
        args: ['loop', 'status', '--json'],
      });
      expect(JSON.parse(status.stdout)).toEqual(
        expect.objectContaining({ agent: 'codex', sequence: 1 }),
      );
    } finally {
      if (previousHome === undefined) process.env.RIZZ_HOME = undefined;
      else process.env.RIZZ_HOME = previousHome;
    }
  });

  it('requires prepared intelligence instead of inventing context', async () => {
    const setup = await fixture();
    const result = await compileTaskBrief({ ...setup, task: 'Change hero' });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'BRAIN_PREPARE_REQUIRED' }),
    });
  });

  it('enforces exact-anchor relevance and the serialized-byte ceiling on large inventories', async () => {
    const setup = await fixture();
    await seedLargeInventoryBrain(setup.rootDir, setup.rizzHome);

    const result = await compileTaskBrief({
      ...setup,
      task: 'Fix `toHaveProperty` in packages/expect/src/jest-expect.ts',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.value);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(TASK_BRIEF_MAX_BYTES);
    expect(result.value.size_budget).toMatchObject({
      max_claims: TASK_BRIEF_MAX_CLAIMS,
      included_claims: 1,
      max_bytes: TASK_BRIEF_MAX_BYTES,
      emitted_bytes: Buffer.byteLength(json),
      truncated_source_files: 19_993,
      truncated_evidence_ids: 19_992,
    });
    expect(result.value.claims).toEqual([
      expect.objectContaining({
        entity_id: 'file:packages/expect/src/jest-expect.ts',
        source_files: expect.arrayContaining(['packages/expect/src/jest-expect.ts']),
        relevance_reasons: expect.arrayContaining([
          'exact:jest-expect.ts',
          'exact:packages/expect/src/jest-expect.ts',
        ]),
      }),
    ]);
    expect(result.value.claims.map((claim) => claim.entity_id)).not.toContain(
      'folder:docs-translations',
    );
  });

  it('returns a structured error rather than partial JSON when the envelope cannot fit', async () => {
    const setup = await fixture();
    await seedBrain(setup.rootDir, setup.rizzHome);

    const result = await compileTaskBrief({ ...setup, task: 'Update Hero', maxBytes: 32 });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'BRIEF_BYTE_BUDGET_EXCEEDED' }),
    });
  });
});

describe('isolated engineering loop', () => {
  it('records project-scoped start and byte-verified checkpoints without repository writes', async () => {
    const setup = await fixture();
    await seedBrain(setup.rootDir, setup.rizzHome);
    const before = execFileSync('git', ['status', '--porcelain'], {
      cwd: setup.rootDir,
      encoding: 'utf8',
    });

    const started = await startLoopWork({
      ...setup,
      task: 'Update Hero',
      agent: 'codex',
      scope: ['src/hero.ts'],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.status).toBe('started');
    expect(started.value.sequence).toBe(1);

    const checkpoint = await recordLoopCheckpoint({
      ...setup,
      summary: 'Inspected direct importer',
      filesInspected: ['src/hero.ts'],
      commands: ['pnpm test'],
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) return;
    expect(checkpoint.value.sequence).toBe(2);
    expect(checkpoint.value.checkpoints).toHaveLength(1);

    const status = await readLoopStatus(setup);
    expect(status).toEqual(checkpoint);
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: setup.rootDir, encoding: 'utf8' }),
    ).toBe(before);
    expect(await readFile(join(started.value.workspace_path, 'state.json'), 'utf8')).toContain(
      'Inspected direct importer',
    );
  });

  it('rejects a second active work item and checkpoints without an active loop', async () => {
    const setup = await fixture();
    await seedBrain(setup.rootDir, setup.rizzHome);
    const missing = await recordLoopCheckpoint({ ...setup, summary: 'too early' });
    expect(missing).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'LOOP_NOT_ACTIVE' }),
    });
    await startLoopWork({ ...setup, task: 'First', agent: 'codex' });
    const duplicate = await startLoopWork({ ...setup, task: 'Second', agent: 'claude' });
    expect(duplicate).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'LOOP_ALREADY_ACTIVE' }),
    });
  });

  it('guards concurrent mutations and completes with a durable handoff', async () => {
    const setup = await fixture();
    await seedBrain(setup.rootDir, setup.rizzHome);
    const started = await startLoopWork({ ...setup, task: 'Ship Hero', agent: 'copilot' });
    if (!started.ok) throw new Error(started.error.message);
    const stale = await recordLoopCheckpoint({
      ...setup,
      summary: 'stale writer',
      expectedSequence: 0,
    });
    expect(stale).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'LOOP_REVISION_MISMATCH' }),
    });
    const secret = ['sk', 'test', 'secret', 'value', '1234567890'].join('-');
    const handoff = await createLoopHandoff({
      ...setup,
      summary: `Hero is ready; api_key=${secret}`,
      nextBaton: 'Run browser UAT',
      expectedSequence: 1,
    });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    const handoffText = await readFile(handoff.value.handoff_path, 'utf8');
    expect(handoffText).toContain('Run browser UAT');
    expect(handoffText).not.toContain(secret);
    const completed = await completeLoopWork({
      ...setup,
      summary: 'Merged after verification',
      expectedSequence: 2,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.status).toBe('completed');
    expect(completed.value.sequence).toBe(3);
  });

  it('serializes concurrent checkpoints so only one matching sequence can commit', async () => {
    const setup = await fixture();
    await seedBrain(setup.rootDir, setup.rizzHome);
    await startLoopWork({ ...setup, task: 'Concurrent Hero', agent: 'codex' });
    const results = await Promise.all([
      recordLoopCheckpoint({ ...setup, summary: 'writer one', expectedSequence: 1 }),
      recordLoopCheckpoint({ ...setup, summary: 'writer two', expectedSequence: 1 }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map((result) => result.error.code)).toEqual([
      'LOOP_REVISION_MISMATCH',
    ]);
  });

  it('does not trust a stored workspace path during a mutation', async () => {
    const setup = await fixture();
    await seedBrain(setup.rootDir, setup.rizzHome);
    const started = await startLoopWork({ ...setup, task: 'Isolate Hero', agent: 'codex' });
    if (!started.ok) throw new Error(started.error.message);
    const foreign = await mkdtemp(join(tmpdir(), 'rizz-foreign-loop-'));
    roots.push(foreign);
    await writeFile(
      join(started.value.workspace_path, 'state.json'),
      `${JSON.stringify({ ...started.value, workspace_path: foreign, project_id: 'other-project' })}\n`,
    );
    const result = await recordLoopCheckpoint({
      ...setup,
      summary: 'safe mutation',
      expectedSequence: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace_path).toBe(started.value.workspace_path);
    expect(result.value.project_id).toBe(started.value.project_id);
    await expect(readFile(join(foreign, 'state.json'), 'utf8')).rejects.toThrow();
  });
});
