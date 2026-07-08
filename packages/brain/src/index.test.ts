import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  addVerificationEvidence,
  askProjectQuestion,
  explainProjectTarget,
  generateProjectBrain,
  reviewProjectChanges,
} from './index.js';

vi.setConfig({ testTimeout: 30_000 });

async function withTempProject<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'rizz-brain-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readTreeText(dir: string): Promise<string> {
  let out = '';
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out += await readTreeText(path);
      continue;
    }
    if (entry.isFile()) out += await readFile(path, 'utf8');
  }
  return out;
}

async function readTreeFiles(dir: string): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const label = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path, label);
        continue;
      }
      if (entry.isFile()) out.set(label, await readFile(path, 'utf8'));
    }
  }
  await walk(dir, '');
  return out;
}

async function git(dir: string, args: readonly string[]): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
}

async function initGitProject(dir: string): Promise<void> {
  await git(dir, ['init', '-b', 'develop']);
  await git(dir, ['config', 'user.email', 'rizz@example.com']);
  await git(dir, ['config', 'user.name', 'rizz test']);
}

async function setAskReadiness(
  dir: string,
  status: 'ready' | 'limited' | 'blocked',
  reasons: readonly string[] = [],
): Promise<void> {
  const path = join(dir, '.rizz', 'research', 'benchmark_ready.json');
  const benchmarkReady = await readJson<Record<string, unknown>>(path);
  benchmarkReady.ask_readiness = {
    ...(typeof benchmarkReady.ask_readiness === 'object' && benchmarkReady.ask_readiness !== null
      ? benchmarkReady.ask_readiness
      : {}),
    status,
    score: status === 'ready' ? 92 : status === 'limited' ? 61 : 18,
    summary: `${status} ask readiness for test`,
    reasons,
    next_required_improvements: ['Improve component, flow, evidence, and unknown coverage.'],
    deterministic: true,
    provider_calls_required: false,
    network_required: false,
  };
  await writeFile(path, JSON.stringify(benchmarkReady, null, 2));
}

describe('project brain generation', () => {
  it('prioritizes manifests, configs, and tests before content-heavy trees under scan caps', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'aaa-content'), { recursive: true });
      await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, 'tests'), { recursive: true });
      for (let index = 0; index < 16; index += 1) {
        await writeFile(
          join(dir, 'aaa-content', `${String(index).padStart(2, '0')}.md`),
          '# Doc\n',
        );
        await writeFile(
          join(dir, '.github', 'workflows', `${String(index).padStart(2, '0')}.yml`),
          'name: noisy workflow\n',
        );
      }
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'large-repo-priority',
          scripts: { build: 'tsc -b', test: 'vitest run' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.0.0' },
        }),
      );
      await writeFile(join(dir, 'tsconfig.json'), '{}');
      await writeFile(join(dir, 'src', 'index.ts'), 'export const value = 1;\n');
      await writeFile(
        join(dir, 'tests', 'index.test.ts'),
        'import { expect, it } from "vitest";\n',
      );
      const progressEvents: Array<{
        readonly phase: string;
        readonly detail?: string;
        readonly message: string;
        readonly scannedFiles?: number;
      }> = [];

      const result = await generateProjectBrain({
        rootDir: dir,
        maxFiles: 4,
        now: new Date('2026-07-04T10:30:00.000Z'),
        onProgress: (progress) => progressEvents.push(progress),
      });

      expect(result).toMatchObject({
        ok: true,
        value: { scannedFiles: 4, commands: 2, tests: 1 },
      });
      if (!result.ok) return;

      const files = await readJson<{
        entities: Array<{ name: string; data?: { relativePath?: string } }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'files.json'));
      const paths = files.entities.map((entity) => entity.data?.relativePath ?? entity.name);
      expect(paths).toEqual(
        expect.arrayContaining(['package.json', 'tsconfig.json', 'tests/index.test.ts']),
      );
      expect(paths.some((path) => path.startsWith('aaa-content/'))).toBe(false);
      expect(paths.some((path) => path.startsWith('.github/workflows/'))).toBe(false);
      expect(progressEvents.map((event) => event.phase)).toEqual(
        expect.arrayContaining(['prepare', 'scan', 'analyze', 'write', 'done']),
      );
      expect(progressEvents.map((event) => `${event.phase}/${event.detail ?? 'summary'}`)).toEqual(
        expect.arrayContaining([
          'analyze/research-artifacts',
          'analyze/mission-control',
          'write/research-artifacts',
          'write/mission-control',
        ]),
      );
      expect(progressEvents.some((event) => event.scannedFiles === 4)).toBe(true);
    });
  });

  it('scores high-signal flow candidates separately from inventory-only scripts', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src', 'accounts'), { recursive: true });
      await mkdir(join(dir, 'tests'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'flow-signal-calibration',
          scripts: {
            start: 'tsx src/server.ts',
            test: 'vitest run',
            build: 'tsc -b',
            lint: 'eslint .',
            format: 'prettier --check .',
            docs: 'node scripts/docs.js',
            clean: 'rimraf dist',
            'clean:packages': "lerna exec 'node ../../scripts/rm.mjs dist'",
            bench: 'node scripts/bench.js',
          },
          dependencies: { express: '^4.19.0' },
          devDependencies: { tsx: '^4.0.0', typescript: '^5.0.0', vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'src', 'server.ts'),
        'import express from "express";\nimport { loadProfile } from "./accounts/repository.js";\nconst app = express();\napp.get("/profile", async (_req, res) => res.json(await loadProfile("guest")));\nexport { app };\n',
      );
      await writeFile(
        join(dir, 'src', 'accounts', 'repository.ts'),
        'export async function loadProfile(id: string) { return { id, source: "repository" }; }\n',
      );
      await writeFile(
        join(dir, 'tests', 'profile.test.ts'),
        'import { expect, it } from "vitest";\nit("loads a profile", () => expect("profile").toBe("profile"));\n',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:00:00.000Z'),
      });

      expect(brain.ok).toBe(true);
      if (!brain.ok) return;

      const understandingScore = await readJson<{
        dimensions: {
          flows: {
            score: number;
            summary: string;
            signals: string[];
            weak_spots: string[];
          };
        };
        capability_scorecard: {
          capabilities: Array<{
            key: string;
            score: number;
            evidence_basis: string[];
          }>;
        };
      }>(join(brain.value.researchDir, 'understanding_score.json'));
      expect(understandingScore.dimensions.flows.score).toBeGreaterThanOrEqual(80);
      expect(understandingScore.dimensions.flows.summary).toContain('high-signal candidate');
      expect(understandingScore.dimensions.flows.signals).toEqual(
        expect.arrayContaining([
          expect.stringContaining('high-signal flow candidate'),
          expect.stringContaining('inventory-only script flow'),
          expect.stringContaining('causal surfaces'),
          expect.stringContaining('verification surfaces'),
        ]),
      );
      expect(understandingScore.dimensions.flows.weak_spots).toEqual(
        expect.arrayContaining([expect.stringContaining('inventory-only')]),
      );
      expect(understandingScore.capability_scorecard.capabilities).toContainEqual(
        expect.objectContaining({
          key: 'flow_understanding',
          score: understandingScore.dimensions.flows.score,
          evidence_basis: expect.arrayContaining([
            expect.stringContaining('high-signal flow candidate'),
            expect.stringContaining('inventory-only script flow'),
          ]),
        }),
      );

      const flows = await readJson<{
        entities: Array<{
          id: string;
          confidence: string;
          data?: {
            confidence?: { score: number };
            signals?: string[];
            steps?: Array<{ type: string; path: string; evidence: string[] }>;
            unknowns?: string[];
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      const docsFlow = flows.entities.find((flow) => flow.id === 'flow:scripts--docs');
      expect(docsFlow).toMatchObject({
        confidence: 'inferred',
        data: expect.objectContaining({
          signals: expect.arrayContaining(['command target', 'package script']),
        }),
      });
      expect(docsFlow?.data?.confidence?.score).toBeGreaterThanOrEqual(0.5);
      expect(docsFlow?.data?.steps).toContainEqual(
        expect.objectContaining({
          type: 'handler',
          path: 'scripts/docs.js',
          evidence: ['evidence:file-package.json'],
        }),
      );
      expect(docsFlow?.data?.unknowns).not.toContain(
        'No source entry file was detected for this package script.',
      );

      const compoundFlow = flows.entities.find(
        (flow) => flow.id === 'flow:scripts--clean-packages',
      );
      expect(compoundFlow?.data?.signals).not.toContain('command target');
      expect(compoundFlow?.data?.steps).not.toContainEqual(
        expect.objectContaining({
          path: expect.stringContaining(' '),
        }),
      );
      expect(compoundFlow?.data?.unknowns).toContain(
        'No source entry file was detected for this package script.',
      );
    });
  });

  it('writes relational brain files, latest state, graph, snapshot, and report', async () => {
    await withTempProject(async (dir) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'sample-app',
          scripts: { build: 'tsc -b', test: 'vitest run', start: 'node dist/index.js' },
          dependencies: { '@example/runtime': '^1.0.0' },
          devDependencies: { vitest: '^2.0.0', typescript: '^5.0.0' },
        }),
      );
      await writeFile(join(dir, 'tsconfig.json'), '{}');
      await writeFile(join(dir, 'README.md'), '# Sample');
      await writeFile(join(dir, 'src.test.ts'), 'import { expect, it } from "vitest";');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:30:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: { scannedFiles: 4, changedFiles: 4, staleFiles: 0, commands: 3, tests: 1 },
      });
      if (!result.ok) return;

      const latest = await readJson<Record<string, unknown>>(result.value.latestPath);
      expect(latest.latest_architecture_summary).toContain('component');
      expect(latest.project_state).toMatchObject({
        package_manager: 'unknown',
        changed_files: expect.arrayContaining([
          'README.md',
          'package.json',
          'src.test.ts',
          'tsconfig.json',
        ]),
        stale_files: [],
      });

      const graph = await readJson<{ relationships: Array<{ from: string; relation: string }> }>(
        join(dir, '.rizz', 'brain', 'graph.json'),
      );
      expect(graph.relationships.some((rel) => rel.relation === 'depends_on')).toBe(true);
      expect(graph.relationships.some((rel) => rel.relation === 'exposes')).toBe(true);

      const files = await readJson<{ entities: Array<{ id: string; data?: { hash?: string } }> }>(
        join(dir, '.rizz', 'brain', 'entities', 'files.json'),
      );
      expect(files.entities.map((entity) => entity.id)).toContain('file:package.json');
      expect(files.entities.every((entity) => typeof entity.data?.hash === 'string')).toBe(true);

      const report = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(report).toContain('Mission Control · rizz-brain-test-');
      expect(report).toContain('Dependency Graph');

      const snapshot = await readJson<Record<string, unknown>>(
        join(dir, '.rizz', 'brain', 'snapshots', '2026-06-28T10-30-00.000Z.json'),
      );
      expect(snapshot).toHaveProperty('latest');
    });
  });

  it('backs folder ownership relationships with direct child-file evidence', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src', 'feature'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'folder-evidence-app' }));
      await writeFile(join(dir, 'src', 'feature', 'handler.ts'), 'export const handler = true;\n');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:31:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const graph = await readJson<{
        relationships: Array<{
          from: string;
          relation: string;
          to: string;
          evidence_ids: string[];
        }>;
      }>(join(dir, '.rizz', 'brain', 'graph.json'));
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          relation: 'owns',
          to: 'folder:src--feature',
          evidence_ids: expect.arrayContaining(['evidence:file-src--feature--handler.ts']),
        }),
      );

      const folders = await readJson<{
        entities: Array<{ id: string; evidence_ids: string[] }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'folders.json'));
      expect(folders.entities).toContainEqual(
        expect.objectContaining({
          id: 'folder:src--feature',
          evidence_ids: expect.arrayContaining(['evidence:file-src--feature--handler.ts']),
        }),
      );
    });
  });

  it('ingests verification evidence into research storage and review eval counts', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'verified-app',
          scripts: { test: 'vitest run', typecheck: 'tsc -b' },
          devDependencies: { vitest: '^2.0.0', typescript: '^5.0.0' },
        }),
      );
      await writeFile(join(dir, 'src', 'index.ts'), 'export const value = 1;\n');
      await writeFile(join(dir, 'src', 'index.test.ts'), 'import { it } from "vitest";\n');

      const generated = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:35:00.000Z'),
      });
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;
      const reportBefore = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');

      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(join(dir, 'src', 'index.ts'), 'export const value = 2;\n');

      const added = await addVerificationEvidence({
        rootDir: dir,
        name: 'unit tests',
        command: 'pnpm test',
        status: 'passed',
        outputSummary: 'passed with token sk-or-v1-1234567890abcdef redacted',
        affectedConfidenceAreas: ['local'],
        now: new Date('2026-06-28T10:36:00.000Z'),
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const artifact = await readJson<{
        items: Array<{ id: string; output_summary?: string }>;
        status_counts: { passed: number };
        local_checks_passed: string[];
      }>(join(dir, '.rizz', 'research', 'verification_evidence.json'));
      expect(artifact.items).toContainEqual(
        expect.objectContaining({
          id: added.value.item.id,
          output_summary: 'passed with token [redacted secret] redacted',
        }),
      );
      expect(artifact.status_counts.passed).toBe(1);
      expect(artifact.local_checks_passed).toContain('unit tests: pnpm test');

      const latest = await readJson<{
        latest_verification_evidence?: {
          latest_item_id?: string;
          status_counts?: { passed?: number };
        };
        latest_research_artifacts?: { verification_evidence?: string };
      }>(join(dir, '.rizz', 'brain', 'latest.json'));
      expect(latest.latest_verification_evidence).toMatchObject({
        latest_item_id: added.value.item.id,
        status_counts: { passed: 1 },
      });
      expect(latest.latest_research_artifacts?.verification_evidence).toBe(
        '.rizz/research/verification_evidence.json',
      );
      const index = await readJson<{
        research_paths?: { verification_evidence?: string };
      }>(join(dir, '.rizz', 'brain', 'index.json'));
      expect(index.research_paths?.verification_evidence).toBe(
        '.rizz/research/verification_evidence.json',
      );
      const reportAfter = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(reportAfter).toBe(reportBefore);

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:37:00.000Z'),
      });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.review.review_evidence_summary.verification_evidence_ids).toContain(
        added.value.item.id,
      );
      expect(review.value.review.verification_status.passed_checks).toContain(
        'unit tests: pnpm test',
      );
      expect(review.value.review.verification_evidence_score).toMatchObject({
        recorded_count: 1,
        passed_count: 1,
        failed_count: 0,
        approval_state: expect.any(String),
        score: expect.any(Number),
      });
      expect(review.value.reviewEval).toMatchObject({
        verification_evidence_count: 1,
        verification_passed_count: 1,
        verification_failed_count: 0,
        verification_evidence_score: expect.any(Number),
      });
      const reviewReport = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      const missionControl = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(reviewReport).toContain('Proof Score');
      expect(reviewReport).toContain('Approval State');
      expect(reviewReport).toContain('Covered Proof');
      expect(missionControl).toContain('Proof Score');
      expect(missionControl).toContain('Covered Proof');
    });
  });

  it('preserves stable file ids and marks removed files as stale on later scans', async () => {
    await withTempProject(async (dir) => {
      const packagePath = join(dir, 'package.json');
      await writeFile(
        packagePath,
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(dir, 'old.ts'), 'export const oldValue = 1;');

      const first = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:30:00.000Z'),
      });
      expect(first.ok).toBe(true);

      await rm(join(dir, 'old.ts'));
      await writeFile(
        packagePath,
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest' } }),
      );

      const second = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:31:00.000Z'),
      });
      expect(second).toMatchObject({
        ok: true,
        value: { scannedFiles: 1, changedFiles: 1, staleFiles: 1 },
      });

      const files = await readJson<{
        entities: Array<{ id: string; latest_status: string; created_at: string }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'files.json'));
      expect(files.entities).toContainEqual(
        expect.objectContaining({
          id: 'file:old.ts',
          latest_status: 'stale',
          created_at: '2026-06-28T10:30:00.000Z',
        }),
      );
      expect(files.entities).toContainEqual(
        expect.objectContaining({
          id: 'file:package.json',
          latest_status: 'changed',
          created_at: '2026-06-28T10:30:00.000Z',
        }),
      );
    });
  });

  it('excludes stale components and relationships from current review blast radius', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'core', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'stale-review-app' }));
      await writeFile(
        join(dir, 'packages', 'core', 'package.json'),
        JSON.stringify({ name: '@sample/core' }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({ name: '@sample/cli' }),
      );
      await writeFile(
        join(dir, 'packages', 'core', 'src', 'index.ts'),
        'export function runCore() { return "core"; }\n',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'import { runCore } from "../../core/src/index.js";\nexport function main() { return runCore(); }\n',
      );

      const first = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:32:00.000Z'),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      const componentsPath = join(dir, '.rizz', 'brain', 'entities', 'components.json');
      const components = await readJson<{
        entities: Array<Record<string, unknown> & { id: string; latest_status: string }>;
      }>(componentsPath);
      await writeFile(
        componentsPath,
        JSON.stringify(
          {
            ...components,
            entities: components.entities.map((component) =>
              component.id === 'component:packages--core'
                ? { ...component, latest_status: 'stale' }
                : component,
            ),
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(dir, 'packages', 'core', 'src', 'index.ts'),
        'export function runCore() { return "changed"; }\n',
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:34:00.000Z'),
      });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.review.changed_files).toContain('packages/core/src/index.ts');
      expect(review.value.review.direct_affected_components).not.toContainEqual(
        expect.objectContaining({ id: 'component:packages--core' }),
      );
      expect(review.value.review.dependent_components).not.toContainEqual(
        expect.objectContaining({ id: 'component:packages--core' }),
      );
      expect(review.value.review.affected_relationships).not.toContainEqual(
        expect.objectContaining({ from: 'component:packages--core' }),
      );
      expect(review.value.review.affected_relationships).not.toContainEqual(
        expect.objectContaining({ to: 'component:packages--core' }),
      );
    });
  });

  it('clears stale review-derived architecture claims after a fresh brain scan', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'core', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'stale-architecture-app', workspaces: ['packages/*'] }),
      );
      await writeFile(
        join(dir, 'packages', 'core', 'package.json'),
        JSON.stringify({ name: '@sample/core' }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({ name: '@sample/cli', scripts: { test: 'vitest run packages/cli' } }),
      );
      await writeFile(
        join(dir, 'packages', 'core', 'src', 'index.ts'),
        'export function runCore() { return "core"; }\n',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'import { runCore } from "../../core/src/index.js";\nexport function main() { return runCore(); }\n',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.test.ts'),
        'import { it } from "vitest"; it("starts", () => {});\n',
      );

      const first = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:36:00.000Z'),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'import { runCore } from "../../core/src/index.js";\nexport function main() { return `${runCore()} changed`; }\n',
      );
      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:37:00.000Z'),
      });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(JSON.stringify(review.value.review.architecture_impact_map)).toContain(
        'impact:component:packages--cli',
      );
      expect(await fileExists(join(dir, '.rizz', 'reports', 'review.html'))).toBe(true);
      expect(await fileExists(join(dir, '.rizz', 'research', 'review_claim_evidence.json'))).toBe(
        true,
      );

      await rm(join(dir, 'packages', 'cli'), { recursive: true, force: true });
      const refreshed = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:38:00.000Z'),
      });
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) return;

      const latest = await readJson<{ latest_review_status: { status: string } }>(
        join(dir, '.rizz', 'brain', 'latest.json'),
      );
      expect(latest.latest_review_status.status).toBe('not_run');
      expect(await fileExists(join(dir, '.rizz', 'reports', 'review.html'))).toBe(false);
      expect(await fileExists(join(dir, '.rizz', 'research', 'review_claim_evidence.json'))).toBe(
        false,
      );
      expect(await fileExists(join(dir, '.rizz', 'research', 'review_eval.json'))).toBe(false);

      const architectureReasoning = await readJson<Record<string, unknown>>(
        join(dir, '.rizz', 'research', 'architecture_reasoning.json'),
      );
      const architectureText = JSON.stringify(architectureReasoning);
      expect(architectureText).not.toContain('component:packages--cli');
      expect(architectureText).not.toContain('impact:component:packages--cli');
      expect(architectureText).not.toContain('evidence:file-packages--cli');

      const report = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(report).not.toContain('impact:component:packages--cli');
      expect(report).not.toContain('.rizz/reports/review.html');
      expect(report).not.toContain('.rizz/research/review_claim_evidence.json');
      expect(report).toContain('No review has run for the current brain');
    });
  });

  it('writes deterministic research artifacts with metrics, coverage, confidence, evidence quality, and incremental update data', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'packages', 'brain', 'src'), { recursive: true });
      const packagePath = join(dir, 'packages', 'brain', 'package.json');
      await writeFile(
        packagePath,
        JSON.stringify({
          name: '@sample/brain',
          scripts: { test: 'vitest run packages/brain', build: 'tsc -b' },
          dependencies: { zod: '^3.0.0' },
        }),
      );
      await writeFile(join(dir, 'packages', 'brain', 'src', 'index.ts'), 'export const brain = 1;');
      await writeFile(
        join(dir, 'packages', 'brain', 'src', 'index.test.ts'),
        'import { it } from "vitest";',
      );

      const first = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:00:00.000Z'),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const firstIncremental = await readJson<{
        previous_brain_fingerprint: string | null;
        current_brain_fingerprint: string;
        scanned_files: number;
        changed_files: string[];
        changed_file_count: number;
        new_files: string[];
        reused_files: number;
        recomputed_files: number;
        file_reuse_ratio: number;
        added_entity_count: number;
        changed_entity_count: number;
        stable_entity_count: number;
        reused_understanding_count: number;
        recomputed_understanding_count: number;
        scan_efficiency_score: number;
        understanding_deltas: {
          previous_scan_available: boolean;
          changed_surface_count: number;
          new_surface_count: number;
          stable_surface_count: number;
          stale_surface_count: number;
          new_surfaces: Array<{ surface_type: string; surface_id: string; status: string }>;
        };
      }>(join(first.value.researchDir, 'incremental_update.json'));
      expect(firstIncremental).toMatchObject({
        previous_brain_fingerprint: null,
        scanned_files: 3,
        changed_files: [
          'packages/brain/package.json',
          'packages/brain/src/index.test.ts',
          'packages/brain/src/index.ts',
        ],
        changed_file_count: 3,
        new_files: [
          'packages/brain/package.json',
          'packages/brain/src/index.test.ts',
          'packages/brain/src/index.ts',
        ],
        reused_files: 0,
        recomputed_files: 3,
        file_reuse_ratio: 0,
      });
      expect(firstIncremental.current_brain_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(firstIncremental.added_entity_count).toBeGreaterThan(0);
      expect(firstIncremental.changed_entity_count).toBe(0);
      expect(firstIncremental.stable_entity_count).toBe(0);
      expect(firstIncremental.reused_understanding_count).toBe(0);
      expect(firstIncremental.recomputed_understanding_count).toBeGreaterThan(0);
      expect(firstIncremental.scan_efficiency_score).toBe(0);
      expect(firstIncremental.understanding_deltas).toMatchObject({
        previous_scan_available: false,
        changed_surface_count: 0,
        stable_surface_count: 0,
        stale_surface_count: 0,
      });
      expect(firstIncremental.understanding_deltas.new_surface_count).toBeGreaterThan(0);
      expect(firstIncremental.understanding_deltas.new_surfaces).toContainEqual(
        expect.objectContaining({
          surface_type: 'component',
          surface_id: 'component:packages--brain',
          status: 'new',
        }),
      );
      const firstUnderstandingScore = await readJson<{
        dimensions: {
          incremental_status: {
            score: number;
            summary: string;
            signals: string[];
            weak_spots: string[];
          };
        };
        capability_scorecard: {
          capabilities: Array<{
            key: string;
            score: number;
            remaining_to_100: number;
            evidence_basis: string[];
            next_required_improvements: string[];
          }>;
        };
      }>(join(first.value.researchDir, 'understanding_score.json'));
      expect(firstUnderstandingScore.dimensions.incremental_status).toMatchObject({
        score: 88,
        summary: expect.stringContaining('baseline file'),
        signals: expect.arrayContaining([
          '100/100 baseline capture readiness',
          expect.stringContaining('First scan establishes the baseline'),
          'First-scan Incremental Understanding score is capped at 88/100 until reuse is proven.',
        ]),
        weak_spots: expect.arrayContaining([
          expect.stringContaining('Run a second scan to prove stable/reused understanding'),
        ]),
      });
      expect(firstUnderstandingScore.capability_scorecard.capabilities).toContainEqual(
        expect.objectContaining({
          key: 'incremental_understanding_metrics',
          score: 88,
          remaining_to_100: 12,
          evidence_basis: expect.arrayContaining(['100/100 baseline capture readiness']),
          next_required_improvements: expect.arrayContaining([
            expect.stringContaining('Run a second scan to prove stable/reused understanding'),
          ]),
        }),
      );

      await writeFile(join(dir, 'packages', 'brain', 'src', 'index.ts'), 'export const brain = 2;');
      const second = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:01:00.000Z'),
      });

      expect(second).toMatchObject({
        ok: true,
        value: { scannedFiles: 3, changedFiles: 1, staleFiles: 0 },
      });
      if (!second.ok) return;

      const researchDir = second.value.researchDir;
      const artifactNames = [
        'metrics.json',
        'coverage.json',
        'confidence.json',
        'reasoning_traces.json',
        'evidence_quality.json',
        'architecture_reasoning.json',
        'security_scan.json',
        'tool_inventory.json',
        'component_intelligence.json',
        'flow_confidence.json',
        'flow_coverage.json',
        'flow_understanding.json',
        'incremental_update.json',
        'benchmark_ready.json',
        'benchmark_tasks.json',
        'understanding_score.json',
        'pie_acceptance.json',
        'service_intelligence.json',
        'verification_plan.json',
        'verification_evidence.json',
        'agent_repair_packets.json',
      ].sort((a, b) => a.localeCompare(b));
      expect((await readdir(researchDir)).sort((a, b) => a.localeCompare(b))).toEqual(
        artifactNames,
      );
      const verificationPlan = await readJson<{
        execution_owner: string;
        runtime_execution_policy: string;
        plan_count: number;
        required_count: number;
        items: Array<{
          priority: string;
          verification_type: string;
          command: string;
          expected_evidence: { record_with: string; confidence_upgrade_rule: string };
        }>;
      }>(join(researchDir, 'verification_plan.json'));
      expect(verificationPlan).toMatchObject({
        execution_owner: 'coding_agent',
        plan_count: expect.any(Number),
        required_count: expect.any(Number),
      });
      expect(verificationPlan.runtime_execution_policy).toContain('coding agent runs commands');
      expect(verificationPlan.items).toContainEqual(
        expect.objectContaining({
          priority: 'required',
          verification_type: 'test',
          command: expect.stringContaining('vitest'),
          expected_evidence: expect.objectContaining({ record_with: 'rizz verify add' }),
        }),
      );
      const agentRepairPackets = await readJson<{
        sources: { verification: number };
        packets: Array<{
          source: string;
          artifacts: string[];
          verification_actions: string[];
        }>;
      }>(join(researchDir, 'agent_repair_packets.json'));
      expect(agentRepairPackets.sources.verification).toBeGreaterThan(0);
      expect(agentRepairPackets.packets).toContainEqual(
        expect.objectContaining({
          source: 'verification',
          artifacts: expect.arrayContaining([
            '.rizz/research/verification_plan.json',
            '.rizz/research/verification_evidence.json',
          ]),
          verification_actions: expect.arrayContaining([
            expect.stringContaining('rizz verify add'),
          ]),
        }),
      );

      const metrics = await readJson<{
        generated_at: string;
        scanned_files: number;
        changed_files: number;
        components: number;
        flows: number;
        flow_steps: number;
        flow_risks: number;
        entity_counts: { component: number; evidence: number; test: number };
        relationship_counts: { owns: number; depends_on: number; tests: number };
      }>(join(researchDir, 'metrics.json'));
      expect(metrics).toMatchObject({
        generated_at: '2026-06-28T12:01:00.000Z',
        scanned_files: 3,
        changed_files: 1,
        components: 1,
        flows: 2,
      });
      expect(metrics.flow_steps).toBeGreaterThan(0);
      expect(metrics.flow_risks).toBeGreaterThanOrEqual(0);
      expect(metrics.entity_counts.component).toBe(1);
      expect(metrics.entity_counts.evidence).toBe(3);
      expect(metrics.entity_counts.test).toBe(1);
      expect(metrics.relationship_counts.owns).toBeGreaterThan(0);
      expect(metrics.relationship_counts.depends_on).toBeGreaterThan(0);
      expect(metrics.relationship_counts.tests).toBeGreaterThan(0);

      const coverage = await readJson<{
        files_by_kind: Record<string, number>;
        components_with_tests: number;
        flows_with_tests: number;
        component_file_coverage_ratio: number;
        component_coverage: Array<{ id: string; tests: string[]; configs: string[] }>;
      }>(join(researchDir, 'coverage.json'));
      expect(coverage.files_by_kind).toEqual({ 'package-manifest': 1, source: 1, test: 1 });
      expect(coverage.components_with_tests).toBe(1);
      expect(coverage.flows_with_tests).toBeGreaterThan(0);
      expect(coverage.component_file_coverage_ratio).toBe(1);
      expect(coverage.component_coverage).toContainEqual(
        expect.objectContaining({
          id: 'component:packages--brain',
          tests: ['packages/brain/src/index.test.ts'],
          configs: ['packages/brain/package.json'],
        }),
      );

      const confidence = await readJson<{
        entity_confidence_counts: { verified: number; inferred: number; uncertain: number };
        relationship_confidence_counts: { verified: number; inferred: number; uncertain: number };
        surface_calibration: {
          component: { total: number; average_score: number; evidence_backed: number };
          flow: { total: number; average_score: number; evidence_backed: number };
          architecture: { total: number; average_score: number; evidence_backed: number };
          evidence: { total: number; evidence_backed: number; unknowns: number };
          review: { total: number; average_score: number; evidence_backed: number };
          unknowns: { total: number; evidence_backed: number };
        };
        component_confidence: Array<{ id: string; confidence: string; evidence_ids: string[] }>;
        flow_confidence: Array<{ id: string; confidence: string; evidence_ids: string[] }>;
      }>(join(researchDir, 'confidence.json'));
      expect(confidence.entity_confidence_counts.verified).toBeGreaterThan(0);
      expect(confidence.entity_confidence_counts.inferred).toBeGreaterThan(0);
      expect(confidence.relationship_confidence_counts.verified).toBeGreaterThan(0);
      expect(confidence.component_confidence).toContainEqual(
        expect.objectContaining({
          id: 'component:packages--brain',
          confidence: 'inferred',
          evidence_ids: expect.arrayContaining([
            'evidence:file-packages--brain--package.json',
            'evidence:file-packages--brain--src--index.ts',
          ]),
        }),
      );
      expect(confidence.flow_confidence).toContainEqual(
        expect.objectContaining({
          id: 'flow:packages--brain--test',
          confidence: 'inferred',
        }),
      );
      expect(confidence.surface_calibration).toMatchObject({
        component: { total: 1, evidence_backed: 1 },
        flow: { total: 2, evidence_backed: 2 },
        evidence: { total: 3, unknowns: 0 },
      });
      expect(confidence.surface_calibration.component.average_score).toBeGreaterThan(0);
      expect(confidence.surface_calibration.flow.average_score).toBeGreaterThan(0);
      expect(confidence.surface_calibration.architecture.total).toBeGreaterThan(0);
      expect(confidence.surface_calibration.review.total).toBeGreaterThan(0);

      const reasoningTraces = await readJson<{
        deterministic: boolean;
        provider_calls_required: boolean;
        trace_count: number;
        trace_counts_by_type: Record<string, number>;
        traces: Array<{
          trace_id: string;
          entity_id: string;
          reasoning_type: string;
          claim: string;
          evidence_ids: string[];
          confidence: string;
          confidence_score: number;
          rules: string[];
          unknowns: string[];
          redacted_evidence_count: number;
        }>;
      }>(join(researchDir, 'reasoning_traces.json'));
      expect(reasoningTraces).toMatchObject({
        deterministic: true,
        provider_calls_required: false,
      });
      expect(reasoningTraces.trace_count).toBe(reasoningTraces.traces.length);
      expect(reasoningTraces.trace_counts_by_type.component).toBeGreaterThan(0);
      expect(reasoningTraces.trace_counts_by_type.flow).toBeGreaterThan(0);
      expect(reasoningTraces.trace_counts_by_type.architecture).toBeGreaterThan(0);
      expect(reasoningTraces.trace_counts_by_type.review).toBeGreaterThan(0);
      expect(reasoningTraces.traces).toContainEqual(
        expect.objectContaining({
          entity_id: 'component:packages--brain',
          reasoning_type: 'component',
          evidence_ids: expect.arrayContaining(['evidence:file-packages--brain--package.json']),
          rules: expect.arrayContaining(['boundary_type:service']),
          redacted_evidence_count: 0,
        }),
      );
      expect(reasoningTraces.traces).toContainEqual(
        expect.objectContaining({
          entity_id: 'flow:packages--brain--test',
          reasoning_type: 'flow',
          evidence_ids: expect.arrayContaining(['evidence:file-packages--brain--src--index.ts']),
          confidence_score: expect.any(Number),
        }),
      );
      expect(reasoningTraces.traces).toContainEqual(
        expect.objectContaining({
          entity_id: 'component:packages--brain',
          reasoning_type: 'architecture',
          evidence_ids: expect.arrayContaining(['evidence:file-packages--brain--package.json']),
          claim: expect.stringContaining('Architecture reasoning'),
        }),
      );

      const componentIntelligence = await readJson<{
        component_understanding_score: number;
        field_coverage_score: number;
        evidence_backed_field_score: number;
        flow_coverage_score: number;
        total_components: number;
        fields: string[];
        components: Array<{
          id: string;
          boundary_type: string;
          flow_count: number;
          field_coverage: Record<string, boolean>;
          field_evidence: Record<string, number>;
        }>;
      }>(join(researchDir, 'component_intelligence.json'));
      expect(componentIntelligence.total_components).toBe(1);
      expect(componentIntelligence.component_understanding_score).toBeGreaterThan(0);
      expect(componentIntelligence.field_coverage_score).toBeGreaterThan(0);
      expect(componentIntelligence.evidence_backed_field_score).toBeGreaterThan(0);
      expect(componentIntelligence.flow_coverage_score).toBe(100);
      expect(componentIntelligence.fields).toContain('failure_modes');
      const brainComponent = componentIntelligence.components.find(
        (component) => component.id === 'component:packages--brain',
      );
      expect(brainComponent).toMatchObject({
        id: 'component:packages--brain',
        boundary_type: 'service',
        flow_count: 2,
        field_coverage: expect.objectContaining({
          purpose: true,
          tradeoffs: true,
          failure_modes: true,
        }),
      });
      expect(brainComponent?.field_evidence.purpose).toBeGreaterThan(0);
      expect(brainComponent?.field_evidence.failure_modes).toBeGreaterThan(0);

      const evidenceQuality = await readJson<{
        evidence_records: number;
        referenced_evidence_ids: number;
        unsupported_claims: number;
        weak_evidence_claims: number;
        evidence_gap_count: number;
        evidence_coverage_score: number;
        redaction_safety_score: number;
        redacted_evidence_count: number;
        redacted_reference_count: number;
        confidence_downgrades: number;
        overall_score: number;
        quality_band: string;
        field_coverage_by_entity_type: {
          component: { unsupported_fields: number; weak_evidence_fields: number };
          flow: { unsupported_fields: number; weak_evidence_fields: number };
        };
        confidence_adjustments: {
          weak_entity_claims: number;
          weak_relationship_claims: number;
          weak_field_claims: number;
          unsupported_field_claims: number;
        };
        evidence_calibration: {
          scoring_inputs: {
            evidence_coverage_score: number;
            redaction_safety_score: number;
            reference_integrity_score: number;
            field_evidence_score: number;
          };
          claim_categories: Array<{
            surface: string;
            total_claims: number;
            evidence_coverage_score: number;
            confidence_mix: { verified: number; inferred: number; uncertain: number };
          }>;
          surface_confidence_mix: Array<{
            surface: string;
            evidence_coverage_score: number;
            confidence_mix: { verified: number; inferred: number; uncertain: number };
          }>;
          weak_evidence_areas: Array<{ surface: string; reason: string }>;
          redaction_impact: {
            impact: string;
            redaction_safety_score: number;
            confidence_downgrades: number;
          };
          inspect_first: Array<{ priority: number; id: string; inspect_hint: string }>;
          summary: string;
        };
        actionability: {
          summary: string;
          top_evidence_gaps: Array<{ kind: string; id: string; reason: string }>;
          unbacked_claim_groups: Array<{
            group: string;
            claim_count: number;
            example_ids: string[];
            inspect_hint: string;
          }>;
          low_confidence_claim_areas: Array<{
            area: string;
            claim_count: number;
            confidence_mix: { verified: number; inferred: number; uncertain: number };
            example_ids: string[];
            inspect_hint: string;
          }>;
          redaction_hidden_evidence: {
            hidden_evidence_count: number;
            impact: string;
            confidence_downgrades: number;
          };
          suggested_read_first: Array<{
            priority: number;
            target_id: string;
            target_entities: string[];
            read_first_files: string[];
            inspect_hint: string;
          }>;
          evidence_confidence_deltas: Array<{
            priority: number;
            target_id: string;
            current_confidence: string;
            target_confidence: string;
            confidence_delta: number;
            verification_actions: string[];
            read_first_files: string[];
            evidence_ids: string[];
          }>;
          confidence_inspection_queue: {
            item_count: number;
            high_priority_count: number;
            sources: {
              evidence: number;
              architecture: number;
              incremental: number;
              security: number;
              tools: number;
            };
            items: Array<{
              priority: number;
              source: string;
              severity: string;
              target_id: string;
              artifacts: string[];
              evidence_gap_ids: string[];
            }>;
          };
          calibration_summary: {
            overall_score: number;
            quality_band: string;
            evidence_coverage_score: number;
            summary: string;
          };
        };
        unbacked_claim_groups: Array<{ group: string; claim_count: number }>;
        low_confidence_claim_areas: Array<{ area: string; claim_count: number }>;
        redaction_hidden_evidence: { hidden_evidence_count: number; impact: string };
        suggested_read_first: Array<{ priority: number; target_id: string }>;
        evidence_confidence_deltas: Array<{ priority: number; target_id: string }>;
        confidence_inspection_queue: {
          item_count: number;
          high_priority_count: number;
          sources: {
            evidence: number;
            architecture: number;
            incremental: number;
            security: number;
            tools: number;
          };
          items: Array<{ priority: number; source: string; target_id: string }>;
        };
        calibration_summary: { overall_score: number; summary: string };
        top_evidence_gaps: Array<{ kind: string; id: string; field?: string; reason: string }>;
        entity_evidence_coverage_ratio: number;
        relationship_evidence_coverage_ratio: number;
        missing_evidence_references: string[];
        component_field_evidence: Array<{
          id: string;
          fields: { dependencies?: number; tests?: number; configs?: number };
        }>;
        flow_field_evidence: Array<{ id: string; fields: { steps?: number; tests?: number } }>;
      }>(join(researchDir, 'evidence_quality.json'));
      expect(evidenceQuality.evidence_records).toBe(3);
      expect(evidenceQuality.referenced_evidence_ids).toBe(3);
      expect(evidenceQuality.unsupported_claims).toBeGreaterThan(0);
      expect(evidenceQuality.weak_evidence_claims).toBeGreaterThan(0);
      expect(evidenceQuality.evidence_gap_count).toBeGreaterThanOrEqual(
        evidenceQuality.unsupported_claims + evidenceQuality.weak_evidence_claims,
      );
      expect(evidenceQuality.field_coverage_by_entity_type.component).toMatchObject({
        unsupported_fields: expect.any(Number),
        weak_evidence_fields: expect.any(Number),
      });
      expect(evidenceQuality.field_coverage_by_entity_type.flow).toMatchObject({
        unsupported_fields: expect.any(Number),
        weak_evidence_fields: expect.any(Number),
      });
      expect(evidenceQuality.confidence_adjustments).toMatchObject({
        weak_entity_claims: expect.any(Number),
        weak_relationship_claims: expect.any(Number),
        weak_field_claims: expect.any(Number),
        unsupported_field_claims: expect.any(Number),
      });
      expect(evidenceQuality.evidence_calibration.scoring_inputs).toMatchObject({
        evidence_coverage_score: evidenceQuality.evidence_coverage_score,
        redaction_safety_score: evidenceQuality.redaction_safety_score,
        reference_integrity_score: expect.any(Number),
        field_evidence_score: expect.any(Number),
      });
      expect(evidenceQuality.evidence_calibration.claim_categories).toContainEqual(
        expect.objectContaining({
          surface: 'architecture_surface',
          total_claims: expect.any(Number),
          evidence_coverage_score: expect.any(Number),
          confidence_mix: expect.objectContaining({
            verified: expect.any(Number),
            inferred: expect.any(Number),
            uncertain: expect.any(Number),
          }),
        }),
      );
      expect(evidenceQuality.evidence_calibration.surface_confidence_mix).toContainEqual(
        expect.objectContaining({
          surface: 'flow_fields',
          evidence_coverage_score: expect.any(Number),
          confidence_mix: expect.objectContaining({
            verified: expect.any(Number),
            inferred: expect.any(Number),
            uncertain: expect.any(Number),
          }),
        }),
      );
      expect(evidenceQuality.evidence_calibration.weak_evidence_areas.length).toBeGreaterThan(0);
      expect(evidenceQuality.evidence_calibration.redaction_impact).toMatchObject({
        impact: expect.any(String),
        redaction_safety_score: evidenceQuality.redaction_safety_score,
        confidence_downgrades: expect.any(Number),
      });
      expect(evidenceQuality.evidence_calibration.inspect_first.length).toBeGreaterThan(0);
      expect(evidenceQuality.evidence_calibration.inspect_first[0]).toMatchObject({
        priority: 1,
        id: expect.any(String),
        inspect_hint: expect.any(String),
      });
      expect(evidenceQuality.top_evidence_gaps.length).toBeGreaterThan(0);
      expect(evidenceQuality.actionability.summary).toContain('prioritized evidence gap');
      expect(evidenceQuality.actionability.top_evidence_gaps).toEqual(
        evidenceQuality.top_evidence_gaps,
      );
      expect(evidenceQuality.actionability.unbacked_claim_groups.length).toBeGreaterThan(0);
      expect(evidenceQuality.actionability.unbacked_claim_groups[0]).toMatchObject({
        group: expect.any(String),
        claim_count: expect.any(Number),
        inspect_hint: expect.any(String),
      });
      expect(evidenceQuality.actionability.low_confidence_claim_areas.length).toBeGreaterThan(0);
      expect(evidenceQuality.actionability.redaction_hidden_evidence).toMatchObject({
        hidden_evidence_count:
          evidenceQuality.redacted_evidence_count + evidenceQuality.redacted_reference_count,
        impact:
          evidenceQuality.redacted_evidence_count + evidenceQuality.redacted_reference_count > 0
            ? 'contained'
            : 'none',
        confidence_downgrades: evidenceQuality.confidence_downgrades,
      });
      expect(evidenceQuality.actionability.suggested_read_first.length).toBeGreaterThan(0);
      expect(evidenceQuality.actionability.suggested_read_first[0]).toMatchObject({
        priority: 1,
        target_id: expect.any(String),
        inspect_hint: expect.any(String),
      });
      expect(evidenceQuality.actionability.evidence_confidence_deltas.length).toBeGreaterThan(0);
      expect(evidenceQuality.actionability.evidence_confidence_deltas[0]).toMatchObject({
        priority: 1,
        target_id: expect.any(String),
        current_confidence: expect.stringMatching(/verified|inferred|uncertain/),
        target_confidence: expect.stringMatching(/verified|inferred|uncertain/),
        confidence_delta: expect.any(Number),
        verification_actions: expect.arrayContaining([expect.any(String)]),
      });
      expect(evidenceQuality.actionability.confidence_inspection_queue).toMatchObject({
        item_count: expect.any(Number),
        high_priority_count: expect.any(Number),
        sources: expect.objectContaining({
          evidence: expect.any(Number),
          architecture: expect.any(Number),
          incremental: expect.any(Number),
          security: expect.any(Number),
          tools: expect.any(Number),
        }),
      });
      expect(
        evidenceQuality.actionability.confidence_inspection_queue.items.length,
      ).toBeGreaterThan(0);
      expect(evidenceQuality.actionability.confidence_inspection_queue.items[0]).toMatchObject({
        priority: 1,
        source: expect.stringMatching(/evidence|architecture|incremental|security|tools/),
        severity: expect.stringMatching(/high|medium|low/),
        target_id: expect.any(String),
        artifacts: expect.arrayContaining([expect.any(String)]),
        evidence_gap_ids: expect.any(Array),
      });
      expect(evidenceQuality.actionability.calibration_summary).toMatchObject({
        overall_score: evidenceQuality.overall_score,
        quality_band: evidenceQuality.quality_band,
        evidence_coverage_score: evidenceQuality.evidence_coverage_score,
      });
      expect(evidenceQuality.unbacked_claim_groups).toEqual(
        evidenceQuality.actionability.unbacked_claim_groups,
      );
      expect(evidenceQuality.low_confidence_claim_areas).toEqual(
        evidenceQuality.actionability.low_confidence_claim_areas,
      );
      expect(evidenceQuality.redaction_hidden_evidence).toEqual(
        evidenceQuality.actionability.redaction_hidden_evidence,
      );
      expect(evidenceQuality.suggested_read_first).toEqual(
        evidenceQuality.actionability.suggested_read_first,
      );
      expect(evidenceQuality.evidence_confidence_deltas).toEqual(
        evidenceQuality.actionability.evidence_confidence_deltas,
      );
      expect(evidenceQuality.confidence_inspection_queue).toEqual(
        evidenceQuality.actionability.confidence_inspection_queue,
      );
      expect(evidenceQuality.calibration_summary).toEqual(
        evidenceQuality.actionability.calibration_summary,
      );
      expect(evidenceQuality.entity_evidence_coverage_ratio).toBeGreaterThan(0);
      expect(evidenceQuality.relationship_evidence_coverage_ratio).toBeGreaterThan(0);
      expect(evidenceQuality.missing_evidence_references).toEqual([]);
      expect(evidenceQuality.component_field_evidence).toContainEqual(
        expect.objectContaining({
          id: 'component:packages--brain',
          fields: expect.objectContaining({ dependencies: 1, tests: 1, configs: 1 }),
        }),
      );
      expect(evidenceQuality.flow_field_evidence).toContainEqual(
        expect.objectContaining({
          id: 'flow:packages--brain--test',
          fields: expect.objectContaining({ steps: expect.any(Number), tests: 1 }),
        }),
      );
      const missionControlReport = await readFile(
        join(dir, '.rizz', 'reports', 'index.html'),
        'utf8',
      );
      expect(missionControlReport).toContain('Evidence Calibration');
      expect(missionControlReport).toContain('Evidence Actionability');
      expect(missionControlReport).toContain('Read First To Improve Confidence');
      expect(missionControlReport).toContain('Confidence Upgrade Queue');
      expect(missionControlReport).toContain('Unbacked Claim Groups');
      expect(missionControlReport).toContain('Low-Confidence Claim Areas');
      expect(missionControlReport).toContain('Redaction-Hidden Evidence');
      expect(missionControlReport).toContain('Inspect First');
      expect(missionControlReport).toContain('Ask readiness');
      expect(missionControlReport).toContain('future broader repo questions');
      expect(missionControlReport).toContain('Remaining to 100%');
      expect(missionControlReport).toContain('Flow Understanding');
      expect(missionControlReport).toContain('Architecture Reasoning');
      expect(missionControlReport).toContain('Evidence Quality scoring');
      expect(missionControlReport).toContain('Mission Control UX');
      expect(missionControlReport).toContain('PI-Bench seed dataset/task format');
      expect(missionControlReport).toContain('Incremental Understanding metrics');
      expect(missionControlReport).toContain('Review Intelligence with true blast radius');
      expect(missionControlReport).toContain('rizz ask');
      expect(missionControlReport).toContain('What Can Break');
      expect(missionControlReport).toContain('component:packages--brain');
      expect(missionControlReport).toContain('Evidence</h4>');
      expect(missionControlReport).toContain(
        'href="#evidence-file-packages--brain--src--index-ts"',
      );
      expect(missionControlReport).toContain('Unknowns are review prompts, not failures.');

      const flowUnderstanding = await readJson<{
        total_flows: number;
        flows_with_tests: number;
        flows_without_tests: number;
        low_confidence_flows: Array<{ id: string }>;
      }>(join(researchDir, 'flow_understanding.json'));
      expect(flowUnderstanding).toMatchObject({
        total_flows: 2,
        flows_with_tests: 2,
        flows_without_tests: 0,
      });
      expect(flowUnderstanding.low_confidence_flows).toContainEqual(
        expect.objectContaining({ id: 'flow:packages--brain--test' }),
      );

      const flowCoverage = await readJson<{
        test_backed_flow_ratio: number;
        flows: Array<{ id: string; tests: number; configs: number }>;
      }>(join(researchDir, 'flow_coverage.json'));
      expect(flowCoverage.test_backed_flow_ratio).toBe(1);
      expect(flowCoverage.flows).toContainEqual(
        expect.objectContaining({ id: 'flow:packages--brain--test', tests: 1, configs: 1 }),
      );

      const flowConfidence = await readJson<{
        low_confidence_flows: Array<{ id: string; score: number }>;
        flow_confidence_counts: { inferred: number };
      }>(join(researchDir, 'flow_confidence.json'));
      expect(flowConfidence.flow_confidence_counts.inferred).toBeGreaterThan(0);
      expect(flowConfidence.low_confidence_flows).toContainEqual(
        expect.objectContaining({ id: 'flow:packages--brain--test' }),
      );

      const architectureReasoning = await readJson<{
        boundary_candidates: Array<{ component_id: string; flow_count: number }>;
        coupling_hotspots: Array<{
          component_id: string;
          coupling_level: string;
          static_import_count: number;
        }>;
        critical_paths: Array<{ component_id: string; blast_radius: string }>;
        risky_seams: Array<{ component_id: string; seam: string }>;
        tradeoff_matrix: Array<{ component_id: string; coupling_level: string }>;
        what_breaks: Array<{ component_id: string; impacts: string[] }>;
        impact_map: {
          summary: {
            total_surfaces: number;
            component_surfaces: number;
            route_surfaces: number;
            test_backed_surfaces: number;
            config_backed_surfaces: number;
          };
          entries: Array<{
            impact_id: string;
            surface_type: string;
            entity_id: string;
            affected_flows: string[];
            affected_tests: string[];
            affected_configs: string[];
            coupling_level: string;
            confidence: string;
            evidence_ids: string[];
            what_breaks: string[];
          }>;
          calibration_rule: string;
        };
        risk_concentrations: Array<{ entity_id: string; kind: string }>;
        review_hints: Array<{ reason: string; affected_flows: string[] }>;
        confidence_debt: {
          debt_level: string;
          debt_count: number;
          unsupported_assumption_count: number;
          inferred_tradeoff_count: number;
          low_confidence_area_count: number;
          blocking_unknown_count: number;
          unsupported_assumptions: Array<{
            assumption_id: string;
            reason: string;
            evidence_gap_ids: string[];
          }>;
          inferred_tradeoffs: Array<{ entity_id: string; tradeoff: string; confidence: string }>;
          low_confidence_areas: Array<{ area_id: string; reason: string; confidence: string }>;
          inspection_queue: Array<{
            priority: number;
            source: string;
            target_id: string;
            reason: string;
            evidence_gap_ids: string[];
          }>;
          blocking_unknowns: string[];
          calibration_rule: string;
        };
        flow_evidence_precision: {
          weak_flow_count: number;
          local_evidence_gap_count: number;
          static_runtime_verification_count: number;
          calibration_rule: string;
        };
        unknowns: string[];
      }>(join(researchDir, 'architecture_reasoning.json'));
      expect(architectureReasoning.boundary_candidates).toContainEqual(
        expect.objectContaining({ component_id: 'component:packages--brain', flow_count: 2 }),
      );
      expect(architectureReasoning.risk_concentrations).toContainEqual(
        expect.objectContaining({ entity_id: 'flow:packages--brain--test', kind: 'flow' }),
      );
      expect(architectureReasoning.review_hints).toContainEqual(
        expect.objectContaining({
          reason: expect.stringContaining('Low-confidence flows'),
          affected_flows: expect.arrayContaining(['flow:packages--brain--test']),
        }),
      );
      expect(architectureReasoning.tradeoff_matrix).toContainEqual(
        expect.objectContaining({ component_id: 'component:packages--brain' }),
      );
      expect(architectureReasoning.what_breaks).toContainEqual(
        expect.objectContaining({
          component_id: 'component:packages--brain',
          impacts: expect.arrayContaining([expect.stringContaining('Validation tied')]),
        }),
      );
      expect(architectureReasoning.impact_map.summary).toMatchObject({
        total_surfaces: 1,
        component_surfaces: 1,
        route_surfaces: 0,
        test_backed_surfaces: 1,
        config_backed_surfaces: 1,
      });
      expect(architectureReasoning.impact_map.entries).toContainEqual(
        expect.objectContaining({
          impact_id: 'impact:component:packages--brain',
          surface_type: 'component',
          entity_id: 'component:packages--brain',
          affected_flows: expect.arrayContaining([
            'flow:packages--brain--build',
            'flow:packages--brain--test',
          ]),
          affected_tests: ['packages/brain/src/index.test.ts'],
          affected_configs: ['packages/brain/package.json'],
          coupling_level: 'low',
          confidence: 'inferred',
          evidence_ids: expect.arrayContaining([
            'evidence:file-packages--brain--package.json',
            'evidence:file-packages--brain--src--index.ts',
          ]),
          what_breaks: expect.arrayContaining([
            expect.stringContaining(
              'component:packages--brain changes can affect 2 reconstructed flow',
            ),
          ]),
        }),
      );
      expect(architectureReasoning.impact_map.calibration_rule).toContain(
        'deterministic static inference',
      );
      expect(architectureReasoning.unknowns).not.toContain('2 flow(s) need local evidence.');
      expect(architectureReasoning.flow_evidence_precision).toMatchObject({
        weak_flow_count: 2,
        local_evidence_gap_count: 0,
        static_runtime_verification_count: 2,
        calibration_rule: expect.stringContaining('do not claim runtime verification'),
      });
      expect(architectureReasoning.confidence_debt).toMatchObject({
        debt_level: expect.stringMatching(/low|medium|high/),
        debt_count: expect.any(Number),
        unsupported_assumption_count: expect.any(Number),
        inferred_tradeoff_count: expect.any(Number),
        low_confidence_area_count: expect.any(Number),
        blocking_unknown_count: expect.any(Number),
        calibration_rule: expect.stringContaining('local architecture assumptions'),
      });
      expect(architectureReasoning.confidence_debt.low_confidence_areas.length).toBeGreaterThan(0);
      expect(architectureReasoning.confidence_debt.inspection_queue.length).toBeGreaterThan(0);
      expect(architectureReasoning.confidence_debt.inspection_queue[0]).toMatchObject({
        priority: expect.any(Number),
        source: 'architecture',
        target_id: expect.any(String),
        reason: expect.any(String),
        evidence_gap_ids: expect.any(Array),
      });
      expect(architectureReasoning.confidence_debt.blocking_unknowns).not.toContain(
        '2 flow(s) need local evidence.',
      );

      const benchmarkReady = await readJson<{
        schema_version: number;
        benchmark_suite: string;
        deterministic: boolean;
        provider_calls_required: boolean;
        network_required: boolean;
        coverage: {
          component: { total: number; covered: number; coverage_ratio: number };
          flow: { total: number; covered: number; coverage_ratio: number };
          evidence: {
            records: number;
            claims: number;
            claims_with_evidence: number;
            coverage_ratio: number;
            missing_references: string[];
          };
          unknown: { total: number; covered: number; coverage_ratio: number };
        };
        readiness: {
          is_ready: boolean;
          score: number;
          calibration_score: number;
          blocking_gaps: string[];
        };
        ask_readiness: {
          status: 'ready' | 'limited' | 'blocked';
          score: number;
          summary: string;
          deterministic: boolean;
          provider_calls_required: boolean;
          network_required: boolean;
          scope: string;
          gates: Array<{
            key: string;
            label: string;
            status: 'ready' | 'limited' | 'blocked';
            score: number;
            reasons: string[];
            next_required_improvements: string[];
          }>;
          reasons: string[];
          next_required_improvements: string[];
          redaction_safety: {
            status: string;
            redaction_applied: boolean;
            redaction_safety_score: number;
            redacted_evidence_count: number;
            redacted_reference_count: number;
            unsafe_sensitive_reference_count: number;
            output_share_safe: boolean;
          };
        };
        readiness_calibration: {
          overall_score: number;
          redaction_safe: boolean;
          dimensions: {
            component_coverage: { score: number; coverage_ratio: number };
            flow_coverage: { score: number; coverage_ratio: number };
            evidence_coverage: { score: number; coverage_ratio: number };
            unknown_coverage: { score: number; coverage_ratio: number };
            confidence_calibration: {
              score: number;
              confidence_distribution: Record<string, number>;
              low_confidence_entity_count: number;
            };
            benchmark_task_category_coverage: {
              score: number;
              required_categories: string[];
              covered_categories: string[];
              missing_categories: string[];
              task_categories: Record<string, number>;
            };
            local_scan_readiness_summary: {
              score: number;
              active_file_entities: number;
              changed_file_count: number;
              scan_efficiency_score: number;
              ready: boolean;
            };
          };
        };
      }>(join(researchDir, 'benchmark_ready.json'));
      expect(benchmarkReady).toMatchObject({
        schema_version: 1,
        benchmark_suite: 'pi-bench-seed',
        deterministic: true,
        provider_calls_required: false,
        network_required: false,
      });
      expect(benchmarkReady.coverage.component).toMatchObject({
        total: 1,
        covered: 1,
        coverage_ratio: 1,
      });
      expect(benchmarkReady.coverage.flow.total).toBe(2);
      expect(benchmarkReady.coverage.flow.covered).toBeGreaterThan(0);
      expect(benchmarkReady.coverage.evidence.records).toBe(3);
      expect(benchmarkReady.coverage.evidence.claims_with_evidence).toBeGreaterThan(0);
      expect(benchmarkReady.coverage.evidence.missing_references).toEqual([]);
      expect(benchmarkReady.coverage.unknown.coverage_ratio).toBeGreaterThanOrEqual(0);
      expect(benchmarkReady.readiness.score).toBeGreaterThan(0);
      expect(benchmarkReady.readiness_calibration).toMatchObject({
        overall_score: expect.any(Number),
        redaction_safe: true,
        dimensions: {
          component_coverage: expect.objectContaining({
            score: 100,
            coverage_ratio: benchmarkReady.coverage.component.coverage_ratio,
          }),
          flow_coverage: expect.objectContaining({
            score: expect.any(Number),
            coverage_ratio: benchmarkReady.coverage.flow.coverage_ratio,
          }),
          evidence_coverage: expect.objectContaining({
            score: expect.any(Number),
            coverage_ratio: benchmarkReady.coverage.evidence.coverage_ratio,
          }),
          unknown_coverage: expect.objectContaining({
            score: expect.any(Number),
            coverage_ratio: benchmarkReady.coverage.unknown.coverage_ratio,
          }),
          confidence_calibration: expect.objectContaining({
            score: expect.any(Number),
            confidence_distribution: expect.any(Object),
            low_confidence_entity_count: expect.any(Number),
          }),
          benchmark_task_category_coverage: expect.objectContaining({
            score: 100,
            required_categories: [
              'component-explanation',
              'flow-explanation',
              'architecture-impact',
              'review-blast-radius',
              'evidence-unknown-coverage',
            ],
            missing_categories: [],
          }),
          local_scan_readiness_summary: expect.objectContaining({
            active_file_entities: 3,
            changed_file_count: 1,
            ready: true,
          }),
        },
      });
      expect(benchmarkReady.readiness.calibration_score).toBe(
        benchmarkReady.readiness_calibration.overall_score,
      );
      expect(benchmarkReady.ask_readiness).toMatchObject({
        status: expect.stringMatching(/ready|limited|blocked/),
        score: expect.any(Number),
        deterministic: true,
        provider_calls_required: false,
        network_required: false,
        scope: expect.stringContaining('future broader repo questions'),
        redaction_safety: expect.objectContaining({
          status: 'ready',
          redaction_safety_score: 100,
          unsafe_sensitive_reference_count: 0,
          output_share_safe: true,
        }),
      });
      expect(benchmarkReady.ask_readiness.summary).toContain('future broader repo questions');
      expect(benchmarkReady.ask_readiness.scope).not.toContain('command');
      expect(benchmarkReady.ask_readiness.gates.map((gate) => gate.key)).toEqual([
        'component_coverage',
        'flow_coverage',
        'architecture_impact_coverage',
        'evidence_quality',
        'unknown_coverage',
        'review_readiness',
        'benchmark_task_coverage',
        'incremental_freshness',
        'redaction_safety',
      ]);
      expect(benchmarkReady.ask_readiness.gates).toContainEqual(
        expect.objectContaining({
          key: 'benchmark_task_coverage',
          status: 'ready',
          score: 100,
        }),
      );

      const benchmarkTasks = await readJson<{
        schema_version: number;
        deterministic: boolean;
        provider_calls_required: boolean;
        network_required: boolean;
        task_count: number;
        task_categories: Record<string, number>;
        research_pointer: {
          latest: string;
          index: string;
          mission_control: string;
          summary: string;
        };
        understanding_goal: string;
        tasks: Array<{
          id: string;
          category: string;
          prompt: string;
          target: { entity_id: string; entity_type: string; name: string; surface: string };
          evidence_ids: string[];
          redacted_evidence_markers: string[];
          redacted_evidence_count: number;
          confidence: string;
          confidence_score: number;
          expected_artifact: string;
          expected_check_fields: string[];
          why_it_matters: string;
        }>;
      }>(join(researchDir, 'benchmark_tasks.json'));
      expect(benchmarkTasks).toMatchObject({
        schema_version: 1,
        deterministic: true,
        provider_calls_required: false,
        network_required: false,
        research_pointer: {
          latest: '.rizz/brain/latest.json',
          index: '.rizz/brain/index.json',
          mission_control: '.rizz/reports/index.html',
        },
      });
      expect(benchmarkTasks.understanding_goal).toContain(
        'Understand any repo in 10 minutes instead of 2 days',
      );
      expect(benchmarkTasks.task_count).toBe(benchmarkTasks.tasks.length);
      expect(benchmarkTasks.task_categories).toMatchObject({
        'component-explanation': expect.any(Number),
        'flow-explanation': expect.any(Number),
        'architecture-impact': expect.any(Number),
        'review-blast-radius': expect.any(Number),
        'evidence-unknown-coverage': expect.any(Number),
      });
      expect(benchmarkTasks.tasks.map((task) => task.id)).toEqual(
        benchmarkTasks.tasks.map((task) => task.id).sort((a, b) => a.localeCompare(b)),
      );
      expect(benchmarkTasks.tasks).toContainEqual(
        expect.objectContaining({
          category: 'component-explanation',
          target: expect.objectContaining({ entity_id: 'component:packages--brain' }),
          expected_artifact: '.rizz/research/component_intelligence.json',
          evidence_ids: expect.arrayContaining(['evidence:file-packages--brain--package.json']),
          why_it_matters: expect.stringContaining('10 minutes instead of 2 days'),
        }),
      );
      expect(benchmarkTasks.tasks).toContainEqual(
        expect.objectContaining({
          category: 'flow-explanation',
          target: expect.objectContaining({ entity_id: 'flow:packages--brain--test' }),
          expected_artifact: '.rizz/research/flow_understanding.json',
        }),
      );
      expect(benchmarkTasks.tasks).toContainEqual(
        expect.objectContaining({
          category: 'architecture-impact',
          expected_artifact: '.rizz/research/architecture_reasoning.json',
          expected_check_fields: expect.arrayContaining(['impact_map.entries[].what_breaks']),
        }),
      );
      expect(benchmarkTasks.tasks).toContainEqual(
        expect.objectContaining({
          category: 'review-blast-radius',
          expected_check_fields: expect.arrayContaining(['review_hints[].suggested_tests']),
        }),
      );
      expect(benchmarkTasks.tasks).toContainEqual(
        expect.objectContaining({
          category: 'evidence-unknown-coverage',
          expected_artifact: expect.stringMatching(
            /^\.rizz\/research\/(evidence_quality|architecture_reasoning)\.json$/,
          ),
        }),
      );
      expect(JSON.stringify(benchmarkTasks)).not.toContain('sk-');

      const pieAcceptance = await readJson<{
        schema_version: number;
        deterministic: boolean;
        provider_calls_required: boolean;
        network_required: boolean;
        goal: string;
        overall_status: string;
        overall_score: number;
        dimensions: Array<{
          key: string;
          label: string;
          status: 'pass' | 'limited' | 'blocking';
          score: number;
          evidence_basis: string[];
          artifact_pointers: string[];
          blocking_gaps: string[];
          next_required_improvements: string[];
        }>;
        artifact_pointers: {
          pie_acceptance: string;
          benchmark_ready: string;
          benchmark_tasks: string;
          mission_control: string;
        };
        confidence: {
          status: 'pass' | 'limited' | 'blocking';
          score: number;
          evidence_basis: string[];
          redaction_safety: {
            score: number;
            redacted_evidence_count: number;
            redacted_reference_count: number;
            unsafe_sensitive_reference_count: number;
            output_share_safe: boolean;
          };
        };
      }>(join(researchDir, 'pie_acceptance.json'));
      expect(pieAcceptance).toMatchObject({
        schema_version: 1,
        deterministic: true,
        provider_calls_required: false,
        network_required: false,
        goal: 'Understand any repo in 10 minutes instead of 2 days.',
        artifact_pointers: {
          pie_acceptance: '.rizz/research/pie_acceptance.json',
          benchmark_ready: '.rizz/research/benchmark_ready.json',
          benchmark_tasks: '.rizz/research/benchmark_tasks.json',
          mission_control: '.rizz/reports/index.html',
        },
      });
      expect(pieAcceptance.overall_status).toMatch(/pass|limited|blocking/);
      expect(pieAcceptance.overall_score).toBeGreaterThan(0);
      expect(pieAcceptance.dimensions.map((dimension) => dimension.key)).toEqual([
        'component_understanding',
        'flow_understanding',
        'architecture_reasoning',
        'evidence_quality_actionability',
        'incremental_understanding',
        'review_intelligence_blast_radius',
        'benchmark_task_coverage',
        'explain_quality',
        'ask_readiness',
        'secret_safe_reliability',
        'mission_control_coverage',
      ]);
      expect(pieAcceptance.dimensions).toContainEqual(
        expect.objectContaining({
          key: 'benchmark_task_coverage',
          status: 'pass',
          score: 100,
          artifact_pointers: expect.arrayContaining(['.rizz/research/benchmark_tasks.json']),
        }),
      );
      expect(pieAcceptance.dimensions).toContainEqual(
        expect.objectContaining({
          key: 'secret_safe_reliability',
          status: 'pass',
          score: 100,
        }),
      );
      expect(pieAcceptance.confidence).toMatchObject({
        evidence_basis: expect.arrayContaining([
          expect.stringContaining('Deterministic local brain entities'),
        ]),
        redaction_safety: {
          score: 100,
          unsafe_sensitive_reference_count: 0,
          output_share_safe: true,
        },
      });
      expect(JSON.stringify(pieAcceptance)).not.toContain('sk-');

      const understandingScore = await readJson<{
        schema_version: number;
        overall_score: number;
        score_band: string;
        dimensions: {
          components: { score: number; weak_spots: string[] };
          flows: { score: number; weak_spots: string[] };
          architecture: { score: number; weak_spots: string[] };
          evidence: { score: number; weak_spots: string[] };
          incremental_status: {
            score: number;
            summary: string;
            signals: string[];
            weak_spots: string[];
          };
          review_readiness: { score: number; weak_spots: string[] };
          unknowns: { score: number; weak_spots: string[] };
        };
        capability_scorecard: {
          target_score: number;
          average_score: number;
          average_remaining_to_100: number;
          foundation_average_score: number;
          capability_count: number;
          capabilities: Array<{
            key: string;
            label: string;
            target_score: number;
            score: number;
            remaining_to_100: number;
            status: string;
            evidence_basis: string[];
            next_required_improvements: string[];
          }>;
        };
        top_unknowns: string[];
        read_first: Array<{ path: string; component_id: string; reason: string }>;
        changed: {
          changed_file_count: number;
          changed_entity_count: number;
          scan_efficiency_score: number;
        };
        review_readiness: { score: number; status: string; required_attention: string[] };
        redaction_safety: {
          redaction_safety_score: number;
          unsafe_sensitive_reference_count: number;
        };
      }>(join(researchDir, 'understanding_score.json'));
      expect(understandingScore).toMatchObject({
        schema_version: 1,
        dimensions: {
          components: expect.objectContaining({ score: expect.any(Number) }),
          flows: expect.objectContaining({ score: expect.any(Number) }),
          architecture: expect.objectContaining({ score: expect.any(Number) }),
          evidence: expect.objectContaining({ score: expect.any(Number) }),
          incremental_status: expect.objectContaining({ score: expect.any(Number) }),
          review_readiness: expect.objectContaining({ score: expect.any(Number) }),
          unknowns: expect.objectContaining({ score: expect.any(Number) }),
        },
        capability_scorecard: {
          target_score: 100,
          average_score: expect.any(Number),
          average_remaining_to_100: expect.any(Number),
          foundation_average_score: expect.any(Number),
          capability_count: 8,
          capabilities: expect.any(Array),
        },
      });
      expect(understandingScore.overall_score).toBeGreaterThan(0);
      expect(understandingScore.score_band).toMatch(/strong|usable|weak|not ready/);
      expect(understandingScore.capability_scorecard.capabilities.map((item) => item.key)).toEqual([
        'flow_understanding',
        'architecture_reasoning',
        'evidence_quality_scoring',
        'mission_control_ux',
        'pi_bench_seed_dataset_task_format',
        'incremental_understanding_metrics',
        'review_intelligence_true_blast_radius',
        'rizz_ask',
      ]);
      for (const capability of understandingScore.capability_scorecard.capabilities) {
        expect(capability.target_score).toBe(100);
        expect(capability.score).toBeGreaterThanOrEqual(0);
        expect(capability.score).toBeLessThanOrEqual(100);
        expect(capability.remaining_to_100).toBe(100 - capability.score);
        expect(capability.evidence_basis.length).toBeGreaterThan(0);
      }
      expect(understandingScore.capability_scorecard.capabilities).toContainEqual(
        expect.objectContaining({
          key: 'rizz_ask',
          label: 'rizz ask',
          status: 'blocked',
          next_required_improvements: expect.arrayContaining([
            expect.stringContaining('Keep broad rizz ask blocked'),
          ]),
        }),
      );
      expect(understandingScore.read_first).toContainEqual(
        expect.objectContaining({
          path: 'packages/brain/package.json',
          component_id: 'component:packages--brain',
        }),
      );
      expect(understandingScore.changed).toMatchObject({
        changed_file_count: 1,
        changed_entity_count: expect.any(Number),
        scan_efficiency_score: expect.any(Number),
      });
      expect(understandingScore.review_readiness.score).toBe(benchmarkReady.readiness.score);
      expect(understandingScore.redaction_safety).toMatchObject({
        redaction_safety_score: 100,
        unsafe_sensitive_reference_count: 0,
      });

      const incremental = await readJson<{
        previous_brain_fingerprint: string;
        current_brain_fingerprint: string;
        scanned_files: number;
        changed_files: string[];
        changed_file_count: number;
        stale_files: string[];
        changed_entity_count: number;
        stable_entity_count: number;
        added_entities: Array<{ id: string; type: string; name: string }>;
        changed_entities: Array<{ id: string; type: string; name: string }>;
        relationship_delta: {
          added_count: number;
          removed_count: number;
          changed_count: number;
        };
        evidence_delta: {
          added_count: number;
          removed_count: number;
          changed_count: number;
          changed: string[];
        };
        reused_understanding_count: number;
        recomputed_understanding_count: number;
        stale_fact_count: number;
        scan_efficiency_score: number;
        reused_files: number;
        recomputed_files: number;
        file_reuse_ratio: number;
        file_status_counts: { changed: number; current: number };
        understanding_deltas: {
          previous_scan_available: boolean;
          changed_surface_count: number;
          new_surface_count: number;
          stable_surface_count: number;
          stale_surface_count: number;
          changed_surfaces: Array<{
            surface_id: string;
            surface_type: string;
            status: string;
            previous_score: number | null;
            current_score: number | null;
            score_delta: number | null;
          }>;
          stable_surfaces: Array<{ surface_id: string; surface_type: string; status: string }>;
          stale_surfaces: Array<{ surface_id: string; surface_type: string; status: string }>;
          by_surface_type: {
            architecture: { stable: number; changed: number; new: number; stale: number };
            component: { stable: number; changed: number; new: number; stale: number };
            evidence: { stable: number; changed: number; new: number; stale: number };
            flow: { stable: number; changed: number; new: number; stale: number };
            service: { stable: number; changed: number; new: number; stale: number };
            unknown: { stable: number; changed: number; new: number; stale: number };
          };
          score_deltas: Array<{
            surface_id: string;
            previous_score: number;
            current_score: number;
            delta: number;
          }>;
        };
      }>(join(researchDir, 'incremental_update.json'));
      expect(incremental).toMatchObject({
        scanned_files: 3,
        changed_files: ['packages/brain/src/index.ts'],
        changed_file_count: 1,
        stale_files: [],
        reused_files: 2,
        recomputed_files: 1,
        file_reuse_ratio: 0.6667,
        file_status_counts: { changed: 1, current: 2 },
      });
      expect(incremental.previous_brain_fingerprint).toBe(
        firstIncremental.current_brain_fingerprint,
      );
      expect(incremental.current_brain_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(incremental.current_brain_fingerprint).not.toBe(
        incremental.previous_brain_fingerprint,
      );
      expect(incremental.changed_entity_count).toBeGreaterThan(0);
      expect(incremental.stable_entity_count).toBeGreaterThan(0);
      expect(incremental.changed_entities).toContainEqual(
        expect.objectContaining({ id: 'evidence:file-packages--brain--src--index.ts' }),
      );
      expect(incremental.relationship_delta).toMatchObject({
        added_count: 0,
        removed_count: 0,
        changed_count: 0,
      });
      expect(incremental.evidence_delta).toMatchObject({
        added_count: 0,
        removed_count: 0,
        changed_count: 1,
        changed: ['evidence:file-packages--brain--src--index.ts'],
      });
      expect(incremental.reused_understanding_count).toBe(incremental.stable_entity_count);
      expect(incremental.recomputed_understanding_count).toBeGreaterThan(0);
      expect(incremental.stale_fact_count).toBe(0);
      expect(incremental.scan_efficiency_score).toBeGreaterThan(0);
      expect(incremental.understanding_deltas.previous_scan_available).toBe(true);
      expect(incremental.understanding_deltas.changed_surface_count).toBeGreaterThan(0);
      expect(incremental.understanding_deltas.stable_surface_count).toBeGreaterThan(0);
      expect(incremental.understanding_deltas.stale_surface_count).toBe(0);
      expect(incremental.understanding_deltas.changed_surfaces).toContainEqual(
        expect.objectContaining({
          surface_id: 'evidence:file-packages--brain--src--index.ts',
          surface_type: 'evidence',
          status: 'changed',
          previous_score: expect.any(Number),
          current_score: expect.any(Number),
        }),
      );
      expect(incremental.understanding_deltas.stable_surfaces).toContainEqual(
        expect.objectContaining({
          surface_id: 'component:packages--brain',
          surface_type: 'component',
          status: 'stable',
        }),
      );
      expect(incremental.understanding_deltas.stable_surfaces).toContainEqual(
        expect.objectContaining({
          surface_id: 'architecture:relationship-map',
          surface_type: 'architecture',
          status: 'stable',
        }),
      );
      expect(incremental.understanding_deltas.by_surface_type.evidence.changed).toBeGreaterThan(0);
      expect(incremental.understanding_deltas.by_surface_type.component.stable).toBeGreaterThan(0);
      expect(understandingScore.changed).toMatchObject({
        changed_file_count: 1,
        changed_entity_count: incremental.changed_entity_count,
        scan_efficiency_score: incremental.scan_efficiency_score,
      });

      const latest = await readJson<{
        latest_understanding_score: {
          overall_score: number;
          capability_scorecard: {
            capability_count: number;
            capabilities: Array<{ key: string; score: number; remaining_to_100: number }>;
          };
          dimensions: {
            components: { score: number };
            flows: { score: number };
            evidence: { score: number };
            review_readiness: { score: number };
          };
          read_first: Array<{ path: string }>;
        };
        latest_benchmark_tasks: {
          path: string;
          pie_acceptance: {
            path: string;
            overall_status: string;
            overall_score: number;
          };
          task_count: number;
          task_categories: Record<string, number>;
          mission_control: string;
          summary: string;
        };
        latest_pie_acceptance: {
          path: string;
          overall_status: string;
          overall_score: number;
          mission_control: string;
          summary: string;
        };
        latest_incremental_update: {
          changed_file_count: number;
          changed_entity_count: number;
          reused_understanding_count: number;
          recomputed_understanding_count: number;
          stale_fact_count: number;
          scan_efficiency_score: number;
          understanding_deltas: {
            changed_surface_count: number;
            stable_surface_count: number;
            stale_surface_count: number;
            changed_surfaces: Array<{ surface_id: string; surface_type: string }>;
            stable_surfaces: Array<{ surface_id: string; surface_type: string }>;
          };
        };
      }>(join(dir, '.rizz', 'brain', 'latest.json'));
      expect(latest.latest_incremental_update).toMatchObject({
        changed_file_count: 1,
        changed_entity_count: incremental.changed_entity_count,
        reused_understanding_count: incremental.reused_understanding_count,
        recomputed_understanding_count: incremental.recomputed_understanding_count,
        stale_fact_count: 0,
        scan_efficiency_score: incremental.scan_efficiency_score,
      });
      expect(latest.latest_incremental_update.understanding_deltas).toMatchObject({
        changed_surface_count: incremental.understanding_deltas.changed_surface_count,
        stable_surface_count: incremental.understanding_deltas.stable_surface_count,
        stale_surface_count: 0,
      });
      expect(latest.latest_incremental_update.understanding_deltas.changed_surfaces).toContainEqual(
        expect.objectContaining({ surface_id: 'evidence:file-packages--brain--src--index.ts' }),
      );
      expect(latest.latest_understanding_score).toMatchObject({
        overall_score: understandingScore.overall_score,
        capability_scorecard: {
          capability_count: 8,
          capabilities: expect.arrayContaining([
            expect.objectContaining({ key: 'flow_understanding' }),
            expect.objectContaining({ key: 'rizz_ask' }),
          ]),
        },
        dimensions: {
          components: expect.objectContaining({ score: expect.any(Number) }),
          flows: expect.objectContaining({ score: expect.any(Number) }),
          evidence: expect.objectContaining({ score: expect.any(Number) }),
          review_readiness: expect.objectContaining({ score: expect.any(Number) }),
        },
        read_first: expect.arrayContaining([
          expect.objectContaining({ path: 'packages/brain/package.json' }),
        ]),
      });
      expect(latest.latest_benchmark_tasks).toMatchObject({
        path: '.rizz/research/benchmark_tasks.json',
        pie_acceptance: {
          path: '.rizz/research/pie_acceptance.json',
          overall_score: pieAcceptance.overall_score,
        },
        task_count: benchmarkTasks.task_count,
        mission_control: '.rizz/reports/index.html',
      });
      expect(latest.latest_pie_acceptance).toMatchObject({
        path: '.rizz/research/pie_acceptance.json',
        overall_status: pieAcceptance.overall_status,
        overall_score: pieAcceptance.overall_score,
        mission_control: '.rizz/reports/index.html',
      });
      expect(latest.latest_pie_acceptance.summary).toContain('PIE acceptance readiness');
      expect(latest.latest_benchmark_tasks.task_categories).toMatchObject(
        benchmarkTasks.task_categories,
      );
      const report = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(report).toContain('Project Intelligence');
      expect(report).toContain('data-object="understanding" open');
      expect(report).toContain('data-object="components"');
      expect(report).toContain('data-object="service-intelligence"');
      expect(report).toContain('data-object="service-causality"');
      expect(report).toContain('data-object="flows"');
      expect(report).toContain('data-object="incremental-health"');
      expect(report).toContain('data-object="architecture"');
      expect(report).toContain('data-object="evidence-quality"');
      expect(report).toContain('data-object="evidence"');
      expect(report).toContain('data-object="unknowns"');
      expect(report).toContain('data-object="review-dependency-runtime-impact"');
      expect(report).toContain('data-object="review-readiness"');
      expect(report).toContain('data-object="benchmark-tasks"');
      expect(report).toContain('Understanding Score');
      expect(report).toContain('Evidence Quality');
      expect(report).toContain('Evidence Quality Inspect');
      expect(report).toContain('Evidence Quality Artifacts');
      expect(report).toContain('Unknown Risk');
      expect(report).toContain('Mission Control scorecard');
      expect(report).toContain('Components');
      expect(report).toContain('Flows');
      expect(report).toContain('Architecture');
      expect(report).toContain('Confidence Debt');
      expect(report).toContain('Evidence');
      expect(report).toContain('Review Readiness');
      expect(report).toContain('Review/Dependency Runtime Impact');
      expect(report).toContain('Dependency Runtime Inspect');
      expect(report).toContain('Unknowns');
      expect(report).toContain('Read First');
      expect(report).toContain('Flagship Summary');
      expect(report).toContain('Understanding Level');
      expect(report).toContain('Evidence Quality Calibration');
      expect(report).toContain('Flow Coverage');
      expect(report).toContain('Architecture Confidence Debt');
      expect(report).toContain('Service Causality');
      expect(report).toContain('Incremental Health');
      expect(report).toContain('Incremental Changed / Stable');
      expect(report).toContain('Read First Pointers');
      expect(report).toContain('Research Artifacts');
      expect(report).toContain('PIE Acceptance');
      expect(report).toContain('.rizz/research/pie_acceptance.json');
      expect(report).toContain('.rizz/research/benchmark_tasks.json');
      expect(report).toContain(
        '<a href="../brain/latest.json"><code>.rizz/brain/latest.json</code></a>',
      );
      expect(report).toContain(
        '<a href="../research/benchmark_tasks.json"><code>.rizz/research/benchmark_tasks.json</code></a>',
      );
      expect(report).toContain(
        '<a href="../research/pie_acceptance.json"><code>.rizz/research/pie_acceptance.json</code></a>',
      );
      expect(report).toContain('Incremental Understanding');
      expect(report).toContain('Changed Understanding Surfaces');
      expect(report).toContain('Stable Understanding Surfaces');
      expect(report).toContain('Stale Understanding Surfaces');
      expect(report).toContain('Scan Efficiency');
      expect(report).toContain('<section class="objects" aria-label="Mission Control objects">');
      const objectOrder = [
        'data-object="understanding"',
        'data-object="components"',
        'data-object="service-intelligence"',
        'data-object="service-causality"',
        'data-object="flows"',
        'data-object="incremental-health"',
        'data-object="architecture"',
        'data-object="evidence"',
        'data-object="unknowns"',
        'data-object="review-readiness"',
        'data-object="benchmark-tasks"',
      ].map((marker) => report.indexOf(marker));
      expect(objectOrder.every((index) => index >= 0)).toBe(true);
      expect(objectOrder).toEqual([...objectOrder].sort((a, b) => a - b));
      expect(report).not.toContain('data-object="read-first"');
      expect(report).not.toContain('data-object="runbook"');
      expect(report).not.toContain(dir);
      expect(report).toContain('<h3>weak</h3>');
      expect(report).toContain('<h3>usable</h3>');
      expect(report).toContain('<h3>strong</h3>');

      await writeFile(join(dir, 'packages', 'brain', 'src', 'extra.ts'), 'export const extra = 1;');
      const third = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:02:00.000Z'),
      });
      expect(third.ok).toBe(true);
      if (!third.ok) return;
      const mixedIncremental = await readJson<{
        scanned_files: number;
        changed_files: string[];
        added_entity_count: number;
        relationship_delta: { added_count: number };
        new_files: string[];
        reused_files: number;
        recomputed_files: number;
        file_reuse_ratio: number;
        understanding_deltas: {
          changed_surface_count: number;
          new_surface_count: number;
          stable_surface_count: number;
          stale_surface_count: number;
          changed_surfaces: Array<{ surface_id: string; surface_type: string; status: string }>;
          new_surfaces: Array<{ surface_id: string; surface_type: string; status: string }>;
          stable_surfaces: Array<{ surface_id: string; surface_type: string; status: string }>;
          by_surface_type: {
            architecture: { changed: number };
            evidence: { new: number };
            service: { new: number };
          };
        };
      }>(join(third.value.researchDir, 'incremental_update.json'));
      expect(mixedIncremental).toMatchObject({
        scanned_files: 4,
        changed_files: ['packages/brain/src/extra.ts'],
        new_files: ['packages/brain/src/extra.ts'],
        reused_files: 3,
        recomputed_files: 1,
        file_reuse_ratio: 0.75,
      });
      expect(mixedIncremental.added_entity_count).toBeGreaterThan(0);
      expect(mixedIncremental.relationship_delta.added_count).toBeGreaterThan(0);
      expect(mixedIncremental.understanding_deltas.new_surface_count).toBeGreaterThan(0);
      expect(mixedIncremental.understanding_deltas.changed_surface_count).toBeGreaterThan(0);
      expect(mixedIncremental.understanding_deltas.stable_surface_count).toBeGreaterThan(0);
      expect(mixedIncremental.understanding_deltas.stale_surface_count).toBe(0);
      expect(mixedIncremental.understanding_deltas.new_surfaces).toContainEqual(
        expect.objectContaining({
          surface_id: 'evidence:file-packages--brain--src--extra.ts',
          surface_type: 'evidence',
          status: 'new',
        }),
      );
      expect(mixedIncremental.understanding_deltas.changed_surfaces).toContainEqual(
        expect.objectContaining({
          surface_id: 'architecture:relationship-map',
          surface_type: 'architecture',
          status: 'changed',
        }),
      );
      expect(mixedIncremental.understanding_deltas.by_surface_type.evidence.new).toBeGreaterThan(0);
      expect(mixedIncremental.understanding_deltas.by_surface_type.architecture.changed).toBe(1);

      const flows = await readJson<{
        entities: Array<{
          id: string;
          type: string;
          name: string;
          confidence: string;
          data?: {
            kind?: string;
            components?: string[];
            files?: string[];
            tests?: string[];
            configs?: string[];
            risks?: Array<{ kind: string }>;
            steps?: Array<{ order: number; path: string; evidence: string[] }>;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      expect(flows.entities).toContainEqual(
        expect.objectContaining({
          id: 'flow:packages--brain--test',
          type: 'flow',
          name: 'test test flow',
          confidence: 'inferred',
          data: expect.objectContaining({
            kind: 'test',
            components: ['component:packages--brain'],
            files: expect.arrayContaining([
              'packages/brain/package.json',
              'packages/brain/src/index.test.ts',
              'packages/brain/src/index.ts',
            ]),
            tests: ['packages/brain/src/index.test.ts'],
            configs: ['packages/brain/package.json'],
          }),
        }),
      );
      const testFlow = flows.entities.find((flow) => flow.id === 'flow:packages--brain--test');
      const testFlowOrders = testFlow?.data?.steps?.map((step) => step.order) ?? [];
      expect(testFlowOrders).toEqual(testFlowOrders.map((_, index) => index + 1));
      expect(testFlow?.data?.steps).toContainEqual(
        expect.objectContaining({
          evidence: expect.arrayContaining(['evidence:file-packages--brain--src--index.ts']),
        }),
      );

      const flowIndex = await readJson<{
        flows: Array<{
          id: string;
          file: string;
          latest_status: string;
          steps: number;
          tests: number;
        }>;
      }>(join(dir, '.rizz', 'brain', 'flows', 'index.json'));
      expect(flowIndex.flows).toContainEqual(
        expect.objectContaining({
          id: 'flow:packages--brain--test',
          file: '.rizz/brain/flows/flow-packages--brain--test.json',
          latest_status: 'current',
          tests: 1,
        }),
      );
      const flowDetail = await readJson<{
        id: string;
        data?: { steps?: Array<{ order: number }> };
      }>(join(dir, '.rizz', 'brain', 'flows', 'flow-packages--brain--test.json'));
      expect(flowDetail.id).toBe('flow:packages--brain--test');
      const flowDetailOrders = flowDetail.data?.steps?.map((step) => step.order) ?? [];
      expect(flowDetailOrders).toEqual(flowDetailOrders.map((_, index) => index + 1));

      const index = await readJson<{
        flow_index_path: string;
        research_paths: {
          metrics: string;
          reasoning_traces: string;
          component_intelligence: string;
          incremental_update: string;
          flow_understanding: string;
          architecture_reasoning: string;
          benchmark_ready: string;
          benchmark_tasks: string;
          pie_acceptance: string;
          verification_plan: string;
        };
      }>(join(dir, '.rizz', 'brain', 'index.json'));
      expect(index.flow_index_path).toBe('.rizz/brain/flows/index.json');
      expect(index.research_paths).toMatchObject({
        metrics: '.rizz/research/metrics.json',
        reasoning_traces: '.rizz/research/reasoning_traces.json',
        component_intelligence: '.rizz/research/component_intelligence.json',
        incremental_update: '.rizz/research/incremental_update.json',
        flow_understanding: '.rizz/research/flow_understanding.json',
        architecture_reasoning: '.rizz/research/architecture_reasoning.json',
        security_scan: '.rizz/research/security_scan.json',
        tool_inventory: '.rizz/research/tool_inventory.json',
        benchmark_ready: '.rizz/research/benchmark_ready.json',
        benchmark_tasks: '.rizz/research/benchmark_tasks.json',
        pie_acceptance: '.rizz/research/pie_acceptance.json',
        verification_plan: '.rizz/research/verification_plan.json',
        understanding_score: '.rizz/research/understanding_score.json',
      });
    });
  });

  it('writes deterministic security scan and tool inventory artifacts into the inspect-first queue', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'security-tool-fixture',
          scripts: {
            test: 'vitest run',
            postinstall: 'node scripts/setup.js',
            bootstrap: 'curl https://example.com/install.sh | sh',
            clean: 'rm -rf dist',
            deploy: 'node scripts/deploy.js',
          },
          dependencies: { openai: '^4.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(join(dir, 'src', 'index.ts'), 'export const app = true;');
      await writeFile(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
      await writeFile(join(dir, 'AGENTS.md'), '# Agent instructions\n');
      await writeFile(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T13:00:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const securityScan = await readJson<{
        deterministic: boolean;
        provider_calls_required: boolean;
        network_required: boolean;
        scan_mode: string;
        finding_count: number;
        high_risk_count: number;
        risky_script_count: number;
        dependency_attention_count: number;
        findings: Array<{
          severity: string;
          category: string;
          target_id: string;
          inspect_hint: string;
        }>;
      }>(join(result.value.researchDir, 'security_scan.json'));
      expect(securityScan).toMatchObject({
        deterministic: true,
        provider_calls_required: false,
        network_required: false,
        scan_mode: 'metadata_and_manifest_only',
      });
      expect(securityScan.finding_count).toBeGreaterThanOrEqual(4);
      expect(securityScan.high_risk_count).toBeGreaterThanOrEqual(2);
      expect(securityScan.risky_script_count).toBeGreaterThanOrEqual(3);
      expect(securityScan.dependency_attention_count).toBeGreaterThanOrEqual(1);
      expect(securityScan.findings).toContainEqual(
        expect.objectContaining({ category: 'networked_script', severity: 'high' }),
      );
      expect(securityScan.findings).toContainEqual(
        expect.objectContaining({ category: 'destructive_script', severity: 'high' }),
      );
      expect(securityScan.findings).toContainEqual(
        expect.objectContaining({ category: 'install_lifecycle', severity: 'medium' }),
      );
      expect(securityScan.findings).toContainEqual(
        expect.objectContaining({ category: 'sensitive_dependency', severity: 'low' }),
      );

      const toolInventory = await readJson<{
        deterministic: boolean;
        surface_count: number;
        mcp_config_count: number;
        agent_config_count: number;
        ci_workflow_count: number;
        package_script_count: number;
        high_risk_count: number;
        surfaces: Array<{ kind: string; risk_level: string; path: string; inspect_hint: string }>;
      }>(join(result.value.researchDir, 'tool_inventory.json'));
      expect(toolInventory).toMatchObject({
        deterministic: true,
        mcp_config_count: 1,
        agent_config_count: 1,
        ci_workflow_count: 1,
      });
      expect(toolInventory.surface_count).toBeGreaterThanOrEqual(8);
      expect(toolInventory.package_script_count).toBeGreaterThanOrEqual(5);
      expect(toolInventory.high_risk_count).toBeGreaterThanOrEqual(1);
      expect(toolInventory.surfaces).toContainEqual(
        expect.objectContaining({ kind: 'mcp_config', risk_level: 'high' }),
      );
      expect(toolInventory.surfaces).toContainEqual(
        expect.objectContaining({ kind: 'agent_config' }),
      );

      const latest = await readJson<{
        latest_security_scan: { finding_count: number; high_risk_count: number };
        latest_tool_inventory: { surface_count: number; mcp_config_count: number };
        latest_confidence_inspection_queue: {
          sources: { security: number; tools: number };
          items: Array<{ source: string; artifacts: string[] }>;
        };
      }>(join(result.value.latestPath));
      expect(latest.latest_security_scan.finding_count).toBe(securityScan.finding_count);
      expect(latest.latest_tool_inventory.surface_count).toBe(toolInventory.surface_count);
      expect(latest.latest_confidence_inspection_queue.sources.security).toBeGreaterThan(0);
      expect(latest.latest_confidence_inspection_queue.sources.tools).toBeGreaterThan(0);
      expect(latest.latest_confidence_inspection_queue.items).toContainEqual(
        expect.objectContaining({
          source: 'security',
          artifacts: expect.arrayContaining(['.rizz/research/security_scan.json']),
        }),
      );
      expect(latest.latest_confidence_inspection_queue.items).toContainEqual(
        expect.objectContaining({
          source: 'tools',
          artifacts: expect.arrayContaining(['.rizz/research/tool_inventory.json']),
        }),
      );

      const report = await readFile(result.value.reportPath, 'utf8');
      expect(report).toContain('Security &amp; Tools');
      expect(report).toContain('.rizz/research/security_scan.json');
      expect(report).toContain('.rizz/research/tool_inventory.json');
    });
  });

  it('emits stable readiness calibration for equivalent fresh scans', async () => {
    async function generateCalibration(dir: string): Promise<unknown> {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'stable-calibration',
          scripts: { test: 'vitest run', build: 'tsc -b' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.0.0' },
        }),
      );
      await writeFile(join(dir, 'src.ts'), 'export const stableCalibration = true;');
      await writeFile(join(dir, 'src.test.ts'), 'import { it } from "vitest";');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T13:00:00.000Z'),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return undefined;

      const benchmarkReady = await readJson<{
        readiness_calibration: {
          overall_score: number;
          dimensions: Record<string, unknown>;
        };
      }>(join(result.value.researchDir, 'benchmark_ready.json'));
      const pieAcceptance = await readJson<Record<string, unknown>>(
        join(result.value.researchDir, 'pie_acceptance.json'),
      );
      const pieDimensions = Array.isArray(pieAcceptance.dimensions)
        ? pieAcceptance.dimensions
            .filter((dimension): dimension is Record<string, unknown> => {
              return (
                dimension !== null && typeof dimension === 'object' && !Array.isArray(dimension)
              );
            })
            .map((dimension) => ({
              key: dimension.key,
              status: dimension.status,
              score: dimension.score,
              artifact_pointers: dimension.artifact_pointers,
            }))
        : [];
      const pieConfidence: Record<string, unknown> =
        pieAcceptance.confidence !== null &&
        typeof pieAcceptance.confidence === 'object' &&
        !Array.isArray(pieAcceptance.confidence)
          ? (pieAcceptance.confidence as Record<string, unknown>)
          : {};
      return {
        readiness_calibration: benchmarkReady.readiness_calibration,
        pie_acceptance: {
          deterministic: pieAcceptance.deterministic,
          provider_calls_required: pieAcceptance.provider_calls_required,
          network_required: pieAcceptance.network_required,
          overall_status: pieAcceptance.overall_status,
          overall_score: pieAcceptance.overall_score,
          dimensions: pieDimensions,
          artifact_pointers: pieAcceptance.artifact_pointers,
          confidence: {
            status: pieConfidence.status,
            score: pieConfidence.score,
            redaction_safety: pieConfidence.redaction_safety,
          },
        },
      };
    }

    const first = await withTempProject(generateCalibration);
    const second = await withTempProject(generateCalibration);

    expect(first).toEqual(second);
  });

  it('maps flow entrypoints through command paths, imports, components, files, tests, and configs', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'core', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({
          name: '@sample/cli',
          scripts: {
            start: 'node dist/index.js',
            test: 'vitest run packages/cli',
          },
          dependencies: { '@sample/core': 'workspace:*' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'core', 'package.json'),
        JSON.stringify({ name: '@sample/core' }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'import { runCore } from "@sample/core";\nimport { localCli } from "./local.js";\nexport function main() { return runCore() + localCli(); }\n',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'local.ts'),
        'export function localCli() { return "local"; }\n',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.test.ts'),
        'import { it } from "vitest";\nit("starts", () => {});\n',
      );
      await writeFile(
        join(dir, 'packages', 'core', 'src', 'index.ts'),
        'export function runCore() { return "core"; }\n',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:10:00.000Z'),
      });

      expect(result).toMatchObject({ ok: true, value: { flows: 2 } });
      if (!result.ok) return;

      const flows = await readJson<{
        entities: Array<{
          id: string;
          data?: {
            entrypoints?: Array<{ component_id?: string }>;
            components?: string[];
            files?: string[];
            runtime_surfaces?: string[];
            tests?: string[];
            configs?: string[];
            steps?: Array<{ type: string; path: string }>;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      const startFlow = flows.entities.find((flow) => flow.id === 'flow:packages--cli--start');
      expect(startFlow?.data?.entrypoints).toContainEqual(
        expect.objectContaining({ component_id: 'component:packages--cli' }),
      );
      expect(startFlow?.data?.components).toEqual(
        expect.arrayContaining(['component:packages--cli', 'component:packages--core']),
      );
      expect(startFlow?.data?.files).toEqual(
        expect.arrayContaining([
          'packages/cli/package.json',
          'packages/cli/src/index.ts',
          'packages/cli/src/local.ts',
          'packages/core/src/index.ts',
        ]),
      );
      expect(startFlow?.data?.tests).toEqual(['packages/cli/src/index.test.ts']);
      expect(startFlow?.data?.configs).toContain('packages/cli/package.json');
      expect(startFlow?.data?.runtime_surfaces).toEqual(
        expect.arrayContaining([
          'flow kind:cli',
          'package script:start',
          'runtime:node',
          'config:packages/cli/package.json',
        ]),
      );
      expect(startFlow?.data?.steps).toContainEqual(
        expect.objectContaining({ type: 'function', path: 'packages/cli/src/local.ts' }),
      );

      const graph = await readJson<{
        relationships: Array<{ from: string; relation: string; to: string }>;
      }>(join(dir, '.rizz', 'brain', 'graph.json'));
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'flow:packages--cli--start',
          relation: 'depends_on',
          to: 'file:packages--cli--src--local.ts',
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'test:packages--cli--src--index.test.ts',
          relation: 'tests',
          to: 'flow:packages--cli--start',
        }),
      );

      const flowCoverage = await readJson<{
        entrypoint_component_coverage_ratio: number;
        runtime_surface_coverage_ratio: number;
        runtime_surfaces_covered_by_flows: string[];
        source_file_coverage_ratio: number;
        test_file_coverage_ratio: number;
        config_file_coverage_ratio: number;
      }>(join(result.value.researchDir, 'flow_coverage.json'));
      expect(flowCoverage.entrypoint_component_coverage_ratio).toBe(1);
      expect(flowCoverage.runtime_surface_coverage_ratio).toBe(1);
      expect(flowCoverage.runtime_surfaces_covered_by_flows).toEqual(
        expect.arrayContaining(['package script:start', 'runtime:node']),
      );
      expect(flowCoverage.source_file_coverage_ratio).toBe(1);
      expect(flowCoverage.test_file_coverage_ratio).toBe(1);
      expect(flowCoverage.config_file_coverage_ratio).toBe(1);

      const architectureReasoning = await readJson<{
        architecture_assumptions: Array<{
          assumption_id: string;
          entity_id: string;
          assumption: string;
          inferred_from: string[];
          evidence_ids: string[];
          evidence_gap_ids: string[];
          confidence: string;
          confidence_score: number;
          rules: string[];
          unknowns: string[];
        }>;
        design_pressures: Array<{
          pressure_id: string;
          entity_id: string;
          pressure_type: string;
          pressure: string;
          strength: string;
          evidence_ids: string[];
          rules: string[];
        }>;
        boundary_rationale: Array<{
          component_id: string;
          boundary_type: string;
          rationale: string;
          evidence_ids: string[];
          confidence: string;
          rules: string[];
          unknowns: string[];
        }>;
        component_boundary_evidence: Array<{
          component_id: string;
          direct_entrypoint_count: number;
          local_test_count: number;
          local_config_count: number;
          read_first_count: number;
          direct_entrypoints: string[];
          local_tests: string[];
          local_configs: string[];
          read_first: string[];
          confidence: string;
          evidence_ids: string[];
          calibration_rule: string;
        }>;
        component_correction_packets: Array<{
          packet_id: string;
          component_id: string;
          severity: string;
          missing_evidence: string[];
          read_first_files: string[];
          inspect_actions: string[];
          test_actions: string[];
          verification_actions: string[];
          evidence_gap_ids: string[];
          agent_prompt: string;
        }>;
        coupling_rationale: Array<{
          component_id: string;
          coupling_level: string;
          coupling_score: number;
          rationale: string;
          intentional_coupling: boolean;
          risky_coupling: boolean;
          evidence_ids: string[];
          rules: string[];
          unknowns: string[];
        }>;
        risk_tradeoff_summary: {
          assumption_count: number;
          high_pressure_count: number;
          intentional_coupling_count: number;
          risky_coupling_count: number;
          evidence_gap_count: number;
          summary: string;
        };
        assumption_confidence: {
          assumption_count: number;
          average_score: number;
          confidence_counts: Record<string, number>;
          low_confidence_assumptions: string[];
          calibration_rule: string;
        };
        confidence_debt: {
          unsupported_assumption_count: number;
          inferred_tradeoff_count: number;
          low_confidence_area_count: number;
          blocking_unknown_count: number;
          unsupported_assumptions: Array<{
            assumption_id: string;
            evidence_gap_ids: string[];
            confidence: string;
          }>;
          low_confidence_areas: Array<{
            area_id: string;
            entity_id: string;
            area_type: string;
            reason: string;
          }>;
          inspection_queue: Array<{
            source: string;
            target_type: string;
            target_id: string;
            reason: string;
            read_first_files: string[];
            verification_actions: string[];
          }>;
          blocking_unknowns: string[];
          summary: string;
        };
        evidence_gaps: Array<{
          gap_id: string;
          entity_id: string;
          gap: string;
          severity: string;
          evidence_ids: string[];
          rules: string[];
        }>;
        impact_map: {
          summary: {
            total_surfaces: number;
            component_surfaces: number;
            test_backed_surfaces: number;
            config_backed_surfaces: number;
            evidence_backed_surfaces: number;
            what_breaks_surfaces: number;
            dependent_component_surfaces: number;
            top_impacted_surfaces: string[];
          };
          entries: Array<{
            impact_id: string;
            surface_type: string;
            entity_id: string;
            affected_flows: string[];
            affected_tests: string[];
            affected_configs: string[];
            dependent_components: string[];
            risk_reasoning: {
              risk_level: string;
              risk_score: number;
              criticality: string;
              coupling_level: string;
              tradeoffs: string[];
              risky_surfaces: string[];
              review_focus: string[];
              reasons: string[];
            };
            reasons: string[];
          }>;
        };
        cross_component_flows: Array<{ flow_id: string; components: string[] }>;
        cross_component_relationships: Array<{
          from: string;
          relation: string;
          to: string;
          evidence_ids: string[];
          what_breaks: string[];
        }>;
      }>(join(result.value.researchDir, 'architecture_reasoning.json'));
      expect(architectureReasoning.cross_component_flows).toContainEqual(
        expect.objectContaining({
          flow_id: 'flow:packages--cli--start',
          components: expect.arrayContaining([
            'component:packages--cli',
            'component:packages--core',
          ]),
        }),
      );
      expect(architectureReasoning.cross_component_relationships).toContainEqual(
        expect.objectContaining({
          from: 'component:packages--cli',
          relation: 'imports',
          to: 'component:packages--core',
          evidence_ids: expect.arrayContaining(['evidence:file-packages--cli--src--index.ts']),
          what_breaks: expect.arrayContaining([
            expect.stringContaining('component:packages--cli imports component:packages--core'),
          ]),
        }),
      );
      expect(
        architectureReasoning.architecture_assumptions.every(
          (assumption) =>
            assumption.evidence_ids.length > 0 || assumption.evidence_gap_ids.length > 0,
        ),
      ).toBe(true);
      expect(architectureReasoning.architecture_assumptions).toContainEqual(
        expect.objectContaining({
          assumption_id: 'assumption:component:packages--cli:boundary',
          entity_id: 'component:packages--cli',
          evidence_ids: expect.arrayContaining([
            'evidence:file-packages--cli--package.json',
            'evidence:file-packages--cli--src--index.ts',
          ]),
          evidence_gap_ids: [],
          rules: expect.arrayContaining([
            'boundary_type:entrypoint',
            'flow_links:2',
            'configs:1',
            'dependencies:2',
          ]),
        }),
      );
      expect(architectureReasoning.architecture_assumptions).toContainEqual(
        expect.objectContaining({
          assumption_id: 'assumption:component:packages--cli:coupling',
          entity_id: 'component:packages--cli',
          assumption: expect.stringContaining('medium coupling'),
          confidence_score: expect.any(Number),
          rules: expect.arrayContaining(['coupling:medium', 'static_imports:2']),
        }),
      );
      expect(architectureReasoning.design_pressures).toContainEqual(
        expect.objectContaining({
          pressure_id: 'pressure:component:packages--cli:dependency',
          pressure_type: 'dependency',
          pressure: expect.stringContaining('package dependency signal'),
          evidence_ids: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        }),
      );
      expect(architectureReasoning.design_pressures).toContainEqual(
        expect.objectContaining({
          pressure_id: 'pressure:component:packages--cli:config',
          pressure_type: 'config',
          rules: ['configs:1'],
        }),
      );
      expect(architectureReasoning.boundary_rationale).toContainEqual(
        expect.objectContaining({
          component_id: 'component:packages--cli',
          boundary_type: 'entrypoint',
          rationale: expect.stringContaining('linked flow'),
          confidence: 'verified',
        }),
      );
      const cliBoundaryEvidence = architectureReasoning.component_boundary_evidence.find(
        (record) => record.component_id === 'component:packages--cli',
      );
      expect(cliBoundaryEvidence).toMatchObject({
        confidence: 'verified',
        direct_entrypoint_count: expect.any(Number),
        local_test_count: expect.any(Number),
        local_config_count: expect.any(Number),
        read_first_count: expect.any(Number),
        direct_entrypoints: expect.arrayContaining(['packages/cli/src/index.ts']),
        local_tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
        local_configs: expect.arrayContaining(['packages/cli/package.json']),
        read_first: expect.arrayContaining(['packages/cli/package.json']),
        calibration_rule: expect.stringContaining('does not claim runtime verification'),
      });
      expect(cliBoundaryEvidence?.direct_entrypoint_count).toBeGreaterThan(0);
      expect(cliBoundaryEvidence?.local_test_count).toBeGreaterThan(0);
      expect(cliBoundaryEvidence?.local_config_count).toBeGreaterThan(0);
      expect(cliBoundaryEvidence?.read_first_count).toBeGreaterThan(0);
      expect(architectureReasoning.coupling_rationale).toContainEqual(
        expect.objectContaining({
          component_id: 'component:packages--cli',
          coupling_level: 'medium',
          intentional_coupling: true,
          risky_coupling: true,
          rules: expect.arrayContaining(['internal_imports:1']),
        }),
      );
      expect(architectureReasoning.risk_tradeoff_summary).toMatchObject({
        assumption_count: expect.any(Number),
        intentional_coupling_count: expect.any(Number),
        risky_coupling_count: expect.any(Number),
        evidence_gap_count: expect.any(Number),
      });
      expect(architectureReasoning.risk_tradeoff_summary.assumption_count).toBe(
        architectureReasoning.architecture_assumptions.length,
      );
      expect(architectureReasoning.assumption_confidence).toMatchObject({
        assumption_count: architectureReasoning.architecture_assumptions.length,
        average_score: expect.any(Number),
        calibration_rule: expect.stringContaining('component confidence'),
      });
      expect(architectureReasoning.confidence_debt).toMatchObject({
        unsupported_assumption_count: expect.any(Number),
        inferred_tradeoff_count: expect.any(Number),
        low_confidence_area_count: expect.any(Number),
        blocking_unknown_count: expect.any(Number),
        summary: expect.stringContaining('unsupported assumption'),
      });
      expect(architectureReasoning.confidence_debt.low_confidence_areas).toContainEqual(
        expect.objectContaining({
          entity_id: 'flow:packages--cli--start',
          area_type: 'evidence_gap',
        }),
      );
      expect(architectureReasoning.confidence_debt.blocking_unknowns).toContainEqual(
        expect.stringContaining('not runtime verified'),
      );
      expect(architectureReasoning.evidence_gaps).toContainEqual(
        expect.objectContaining({
          entity_id: 'flow:packages--cli--start',
          gap: expect.stringContaining('not runtime verified'),
          severity: 'high',
          rules: expect.arrayContaining(['confidence:inferred', 'components:2']),
        }),
      );
      expect(architectureReasoning.impact_map.summary).toMatchObject({
        total_surfaces: 2,
        component_surfaces: 2,
        test_backed_surfaces: 2,
        config_backed_surfaces: 2,
        evidence_backed_surfaces: 2,
        what_breaks_surfaces: 2,
      });
      expect(architectureReasoning.impact_map.summary.top_impacted_surfaces).toContain(
        'impact:component:packages--cli',
      );
      expect(architectureReasoning.impact_map.entries).toContainEqual(
        expect.objectContaining({
          impact_id: 'impact:component:packages--cli',
          surface_type: 'component',
          entity_id: 'component:packages--cli',
          affected_flows: expect.arrayContaining([
            'flow:packages--cli--start',
            'flow:packages--cli--test',
          ]),
          affected_tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
          affected_configs: expect.arrayContaining(['packages/cli/package.json']),
          dependent_components: [],
          risk_reasoning: expect.objectContaining({
            risk_level: 'high',
            criticality: 'high',
            coupling_level: 'medium',
            tradeoffs: expect.arrayContaining([expect.stringContaining('entrypoints')]),
            risky_surfaces: expect.arrayContaining([
              'high-criticality surface',
              'configuration-backed surface',
            ]),
            review_focus: expect.arrayContaining([
              expect.stringContaining('Verify 2 reconstructed flow'),
              expect.stringContaining('linked test artifact'),
            ]),
            reasons: expect.arrayContaining(['criticality:high', 'tests:1']),
          }),
          reasons: expect.arrayContaining([
            'boundary_type:entrypoint',
            'flow_links:2',
            'configs:2',
          ]),
        }),
      );

      const assumptionTraces = await readJson<{
        traces: Array<{
          entity_id: string;
          reasoning_type: string;
          claim: string;
          evidence_ids: string[];
          rules: string[];
          unknowns: string[];
        }>;
      }>(join(result.value.researchDir, 'reasoning_traces.json'));
      expect(assumptionTraces.traces).toContainEqual(
        expect.objectContaining({
          entity_id: 'component:packages--cli',
          reasoning_type: 'architecture',
          claim: expect.stringContaining('Architecture assumption'),
          evidence_ids: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
          rules: expect.arrayContaining(['architecture_assumption', 'boundary_type:entrypoint']),
        }),
      );

      const report = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(report).toContain('Architecture Assumptions');
      expect(report).toContain('Impact Map');
      expect(report).toContain('2 impact surface(s)');
      expect(report).toContain('high risk (');
      expect(report).toContain('Confidence Debt');
      expect(report).toContain('Design Pressures');
      expect(report).toContain('Coupling Rationale');
      expect(report).toContain('Evidence Gaps');

      const understandingScore = await readJson<{
        dimensions: {
          architecture: {
            score: number;
            signals: string[];
          };
        };
        capability_scorecard: {
          capabilities: Array<{ key: string; evidence_basis: string[] }>;
        };
      }>(join(result.value.researchDir, 'understanding_score.json'));
      expect(understandingScore.dimensions.architecture.score).toBeGreaterThanOrEqual(80);
      expect(understandingScore.dimensions.architecture.signals).toEqual(
        expect.arrayContaining([
          expect.stringContaining('impact surface'),
          expect.stringContaining('cross-component relationship'),
          expect.stringContaining('service causality path'),
        ]),
      );
      expect(understandingScore.capability_scorecard.capabilities).toContainEqual(
        expect.objectContaining({
          key: 'architecture_reasoning',
          evidence_basis: expect.arrayContaining([
            expect.stringContaining('architecture impact surface'),
            expect.stringContaining('cross-component relationship'),
          ]),
        }),
      );

      const explained = await explainProjectTarget({
        rootDir: dir,
        target: 'flow:packages--cli--start',
        now: new Date('2026-06-28T12:11:00.000Z'),
      });
      expect(explained.ok).toBe(true);
      if (!explained.ok) return;
      expect(explained.value.explanation.entry_points).toContain(
        'command: packages/cli/package.json#start -> component:packages--cli',
      );
      expect(explained.value.explanation.tradeoffs).toContainEqual(
        expect.stringContaining('deterministic static reconstructions'),
      );
      expect(explained.value.explanation.failure_modes).not.toContain(
        'No directly linked tests were detected for this flow.',
      );
    });
  });

  it('writes component correction packets into the architecture inspection queue', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'config', 'kubernetes'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'config-gap-app' }));
      await writeFile(join(dir, 'config', 'kubernetes', 'deployment.yaml'), 'kind: Deployment\n');
      await writeFile(join(dir, 'config', 'kubernetes', 'service.yaml'), 'kind: Service\n');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:12:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const architectureReasoning = await readJson<{
        component_correction_packets: Array<{
          component_id: string;
          severity: string;
          missing_evidence: string[];
          read_first_files: string[];
          inspect_actions: string[];
          test_actions: string[];
          verification_actions: string[];
          calibration_rule: string;
        }>;
        confidence_debt: {
          inspection_queue: Array<{
            source: string;
            target_type: string;
            target_id: string;
            reason: string;
            read_first_files: string[];
            verification_actions: string[];
          }>;
        };
      }>(join(result.value.researchDir, 'architecture_reasoning.json'));

      expect(architectureReasoning.component_correction_packets).toContainEqual(
        expect.objectContaining({
          component_id: 'component:config',
          severity: 'high',
          missing_evidence: expect.arrayContaining([
            'direct entrypoint evidence',
            'component-local test evidence',
            'reconstructed flow coverage',
          ]),
          read_first_files: expect.arrayContaining(['config/kubernetes/deployment.yaml']),
          inspect_actions: expect.arrayContaining([
            expect.stringContaining('Start with the listed read-first files'),
          ]),
          test_actions: expect.arrayContaining([expect.stringContaining('component-local test')]),
          verification_actions: expect.arrayContaining([
            expect.stringContaining('component_boundary_evidence improves'),
          ]),
          calibration_rule: expect.stringContaining('do not assert repairs were performed'),
        }),
      );
      expect(architectureReasoning.confidence_debt.inspection_queue[0]).toMatchObject({
        source: 'architecture',
        target_type: 'component_correction_packet',
        target_id: 'component:config',
        read_first_files: expect.arrayContaining(['config/kubernetes/deployment.yaml']),
        verification_actions: expect.arrayContaining([
          expect.stringContaining('component_boundary_evidence improves'),
        ]),
      });

      const agentRepairPackets = await readJson<{
        packet_count: number;
        high_priority_count: number;
        sources: { architecture: number; evidence_quality: number; verification: number };
        packets: Array<{
          priority: number;
          related_packet_ids: string[];
          source: string;
          target_type: string;
          target_id: string;
          read_first_files: string[];
          verification_actions: string[];
          artifacts: string[];
          calibration_rule?: string;
        }>;
        calibration_rule: string;
      }>(join(result.value.researchDir, 'agent_repair_packets.json'));
      expect(agentRepairPackets.packet_count).toBeGreaterThan(0);
      expect(agentRepairPackets.sources.architecture).toBeGreaterThan(0);
      expect(agentRepairPackets.sources.verification).toBe(0);
      expect(agentRepairPackets.packets).toContainEqual(
        expect.objectContaining({
          source: 'architecture',
          target_type: 'component_correction_packet',
          target_id: 'component:config',
          related_packet_ids: expect.any(Array),
          read_first_files: expect.arrayContaining(['config/kubernetes/deployment.yaml']),
          verification_actions: expect.arrayContaining([
            expect.stringContaining('component_boundary_evidence improves'),
          ]),
          artifacts: expect.arrayContaining(['.rizz/research/agent_repair_packets.json']),
        }),
      );
      expect(agentRepairPackets.calibration_rule).toContain('do not claim repairs');
    });
  });

  it('links standalone script service entrypoints back to command-flow causality', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'scripts'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'script-service-app',
          scripts: { test: 'vitest run' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'scripts', 'upload-adapter-results.mjs'),
        [
          'import { writeFile } from "node:fs/promises";',
          'const endpoint = process.env.ADAPTER_RESULTS_ENDPOINT;',
          'const response = await fetch(endpoint, { method: "POST" });',
          'await writeFile(".adapter-results.json", String(response.status));',
          '',
        ].join('\n'),
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:10:30.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const services = await readJson<{
        entities: Array<{
          id: string;
          data?: {
            related_flows?: string[];
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'services.json'));
      const scriptService = services.entities.find((service) => service.id === 'service:scripts');
      expect(scriptService?.data?.related_flows).toContain(
        'flow:service-job--scripts--upload-adapter-results.mjs',
      );

      const flows = await readJson<{
        entities: Array<{
          id: string;
          data?: {
            services?: string[];
            service_causality?: Array<{
              service_id: string;
              files: string[];
              step_ids: string[];
              effects: string[];
              evidence_ids: string[];
            }>;
            signals?: string[];
            unknowns?: string[];
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      const serviceFlow = flows.entities.find(
        (flow) => flow.id === 'flow:service-job--scripts--upload-adapter-results.mjs',
      );
      expect(serviceFlow?.data?.services).toEqual(['service:scripts']);
      expect(serviceFlow?.data?.signals).toEqual(
        expect.arrayContaining(['service entrypoint', 'service job', 'external API evidence']),
      );
      expect(serviceFlow?.data?.unknowns).toContain(
        'No package script or route command was found for this service entrypoint in the capped scan.',
      );
      expect(serviceFlow?.data?.service_causality).toContainEqual(
        expect.objectContaining({
          service_id: 'service:scripts',
          files: expect.arrayContaining(['scripts/upload-adapter-results.mjs']),
          step_ids: expect.arrayContaining([
            'flow-step:flow-service-job--scripts--upload-adapter-results.mjs:001',
            'flow-step:flow-service-job--scripts--upload-adapter-results.mjs:002',
          ]),
          effects: expect.arrayContaining([
            'env:ADAPTER_RESULTS_ENDPOINT',
            'external:http-client',
            'storage:filesystem',
          ]),
          evidence_ids: expect.arrayContaining([
            'evidence:file-scripts--upload-adapter-results.mjs',
          ]),
        }),
      );

      const architectureReasoning = await readJson<{
        service_causality_reasoning: {
          total_services: number;
          total_paths: number;
          affected_flows: string[];
          affected_services: string[];
          effect_count: number;
          missing_step_link_paths: string[];
        };
      }>(join(result.value.researchDir, 'architecture_reasoning.json'));
      expect(architectureReasoning.service_causality_reasoning.total_services).toBe(1);
      expect(architectureReasoning.service_causality_reasoning.total_paths).toBe(1);
      expect(architectureReasoning.service_causality_reasoning.effect_count).toBeGreaterThan(0);
      expect(architectureReasoning.service_causality_reasoning.missing_step_link_paths).toEqual([]);
      expect(architectureReasoning.service_causality_reasoning.affected_flows).toContain(
        'flow:service-job--scripts--upload-adapter-results.mjs',
      );
      expect(architectureReasoning.service_causality_reasoning.affected_services).toContain(
        'service:scripts',
      );
    });
  });

  it('emits deterministic flow contracts for validation, side effects, outputs, tests, and configs', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'packages', 'api', 'src', 'routes'), { recursive: true });
      await writeFile(
        join(dir, 'packages', 'api', 'package.json'),
        JSON.stringify({
          name: '@sample/api',
          scripts: { test: 'vitest run packages/api' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'api', 'src', 'routes', 'createSession.route.ts'),
        [
          'import { saveSession } from "./session-store.js";',
          'export async function POST(request: Request): Promise<Response> {',
          '  const body = await request.json();',
          '  if (!body.userId) throw new Error("invalid userId");',
          '  const session = saveSession({ userId: body.userId });',
          '  return Response.json({ sessionId: session.id });',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'packages', 'api', 'src', 'routes', 'session-store.ts'),
        [
          'const sessionCache = new Map<string, { userId: string }>();',
          'const databaseSessions = new Map<string, { userId: string }>();',
          'export function saveSession(input: { userId: string }): { id: string } {',
          '  const id = `session-${input.userId}`;',
          '  sessionCache.set(id, input);',
          '  databaseSessions.set(id, input);',
          '  return { id };',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'packages', 'api', 'src', 'routes', 'createSession.route.test.ts'),
        'import { it } from "vitest";\nit("validates and returns a session response", () => {});\n',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:20:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const flowId = 'flow:api--packages--api--src--routes--createsession.route.ts';
      const flows = await readJson<{
        entities: Array<{
          id: string;
          data?: {
            entry_contract?: string[];
            exit_contract?: string[];
            inputs?: string[];
            outputs?: string[];
            side_effects?: string[];
            state_transitions?: string[];
            failure_modes?: string[];
            required_tests?: string[];
            runtime_surfaces?: string[];
            confidence_reasons?: string[];
            field_evidence?: Record<string, string[]>;
            journey?: {
              name?: string;
              category?: string;
              confidence?: string;
              missing_evidence?: string[];
            };
            journey_steps?: Array<{
              type?: string;
              label?: string;
              files?: string[];
              tests?: string[];
              configs?: string[];
              confidence?: string;
            }>;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      const routeFlow = flows.entities.find((flow) => flow.id === flowId);
      expect(routeFlow?.data).toMatchObject({
        entry_contract: expect.arrayContaining([
          'Entrypoint performs validation before continuing to downstream steps.',
        ]),
        exit_contract: expect.arrayContaining([
          'Returns an HTTP/API response from the route flow.',
        ]),
        inputs: expect.arrayContaining(['HTTP request route input.']),
        outputs: expect.arrayContaining(['HTTP/API response.']),
        side_effects: expect.arrayContaining([
          'State/session/cache/database or filesystem side effect inferred from source.',
        ]),
        state_transitions: expect.arrayContaining([
          'State changes when session, cache, database, store, or file mutation succeeds.',
          'Invalid input transitions into validation failure instead of normal output.',
        ]),
        failure_modes: expect.arrayContaining([
          'Source evidence contains explicit error handling paths.',
          'Validation can reject malformed or missing input.',
        ]),
        required_tests: expect.arrayContaining([
          'packages/api/src/routes/createSession.route.test.ts',
          'validation failure coverage',
          'state/session/cache/database side-effect coverage',
          'response/output contract coverage',
        ]),
        runtime_surfaces: expect.arrayContaining([
          'flow kind:api',
          'config:packages/api/package.json',
        ]),
        confidence_reasons: expect.arrayContaining([
          'Entrypoint evidence is recorded.',
          'Validation evidence is recorded.',
          'Side-effect evidence is recorded.',
          'Linked test artifact is recorded.',
        ]),
        journey: expect.objectContaining({
          name: 'User login journey',
          category: 'auth_login',
          confidence: 'verified',
        }),
        journey_steps: expect.arrayContaining([
          expect.objectContaining({
            type: 'trigger',
            label: 'Trigger',
            files: expect.arrayContaining(['packages/api/src/routes/createSession.route.ts']),
          }),
          expect.objectContaining({
            type: 'validation_auth',
            label: 'Validation/auth',
          }),
          expect.objectContaining({
            type: 'read_write_storage',
            label: 'Read/write storage',
            files: expect.arrayContaining(['packages/api/src/routes/session-store.ts']),
          }),
          expect.objectContaining({
            type: 'test_coverage',
            label: 'Test coverage',
            tests: expect.arrayContaining(['packages/api/src/routes/createSession.route.test.ts']),
          }),
        ]),
      });
      expect(routeFlow?.data?.field_evidence).toMatchObject({
        entry_contract: expect.arrayContaining([
          'evidence:file-packages--api--src--routes--createsession.route.ts',
        ]),
        side_effects: expect.arrayContaining([
          'evidence:file-packages--api--src--routes--session-store.ts',
        ]),
        required_tests: expect.arrayContaining([
          'evidence:file-packages--api--src--routes--createsession.route.test.ts',
        ]),
        runtime_surfaces: expect.arrayContaining([
          'evidence:file-packages--api--src--routes--createsession.route.ts',
          'evidence:file-packages--api--package.json',
        ]),
      });

      const flowUnderstanding = await readJson<{
        flows_with_contracts: number;
        flows_with_runtime_surfaces: number;
        flows_with_journey_names: number;
        journey_steps: number;
        runtime_surfaces: string[];
        journeys: Array<{
          id: string;
          journey_name: string;
          category: string;
          confidence: string;
          step_count: number;
        }>;
        journey_steps_by_type: Record<string, number>;
        contracts: Array<{
          id: string;
          journey_name?: string;
          entry_contract: string[];
          exit_contract: string[];
          side_effects: string[];
          required_tests: string[];
          runtime_surfaces: string[];
          journey_steps?: Array<{ type: string; confidence: string }>;
        }>;
      }>(join(result.value.researchDir, 'flow_understanding.json'));
      expect(flowUnderstanding.flows_with_contracts).toBeGreaterThan(0);
      expect(flowUnderstanding.flows_with_runtime_surfaces).toBeGreaterThan(0);
      expect(flowUnderstanding.flows_with_journey_names).toBeGreaterThan(0);
      expect(flowUnderstanding.journey_steps).toBeGreaterThan(0);
      expect(flowUnderstanding.journeys).toContainEqual(
        expect.objectContaining({
          id: flowId,
          journey_name: 'User login journey',
          category: 'auth_login',
          confidence: 'verified',
          step_count: expect.any(Number),
        }),
      );
      expect(flowUnderstanding.journey_steps_by_type).toMatchObject({
        trigger: expect.any(Number),
        validation_auth: expect.any(Number),
        read_write_storage: expect.any(Number),
        test_coverage: expect.any(Number),
      });
      expect(flowUnderstanding.runtime_surfaces).toEqual(
        expect.arrayContaining(['config:packages/api/package.json', 'flow kind:api']),
      );
      expect(flowUnderstanding.contracts).toContainEqual(
        expect.objectContaining({
          id: flowId,
          side_effects: expect.arrayContaining([
            'State/session/cache/database or filesystem side effect inferred from source.',
          ]),
          required_tests: expect.arrayContaining(['validation failure coverage']),
          runtime_surfaces: expect.arrayContaining(['config:packages/api/package.json']),
          journey_name: 'User login journey',
          journey_steps: expect.arrayContaining([
            expect.objectContaining({ type: 'validation_auth', confidence: expect.any(String) }),
            expect.objectContaining({ type: 'read_write_storage', confidence: expect.any(String) }),
          ]),
        }),
      );

      const flowCoverage = await readJson<{
        contract_backed_flow_ratio: number;
        runtime_surface_coverage_ratio: number;
        journey_named_flow_ratio: number;
        journey_step_coverage_ratio: number;
        runtime_surfaces_covered_by_flows: string[];
        flows: Array<{
          id: string;
          journey_name?: string;
          journey_confidence?: string;
          journey_steps?: number;
          entry_contract: number;
          exit_contract: number;
          side_effects: number;
          required_tests: number;
          runtime_surfaces: number;
        }>;
      }>(join(result.value.researchDir, 'flow_coverage.json'));
      expect(flowCoverage.contract_backed_flow_ratio).toBeGreaterThan(0);
      expect(flowCoverage.runtime_surface_coverage_ratio).toBeGreaterThan(0);
      expect(flowCoverage.journey_named_flow_ratio).toBeGreaterThan(0);
      expect(flowCoverage.journey_step_coverage_ratio).toBeGreaterThan(0);
      expect(flowCoverage.runtime_surfaces_covered_by_flows).toEqual(
        expect.arrayContaining(['config:packages/api/package.json', 'flow kind:api']),
      );
      expect(flowCoverage.flows).toContainEqual(
        expect.objectContaining({
          id: flowId,
          journey_name: 'User login journey',
          journey_confidence: 'verified',
          journey_steps: expect.any(Number),
          entry_contract: expect.any(Number),
          exit_contract: expect.any(Number),
          side_effects: expect.any(Number),
          required_tests: expect.any(Number),
          runtime_surfaces: expect.any(Number),
        }),
      );

      const evidenceQuality = await readJson<{
        flow_field_evidence: Array<{
          id: string;
          fields: {
            entry_contract?: number;
            exit_contract?: number;
            side_effects?: number;
            required_tests?: number;
            runtime_surfaces?: number;
          };
        }>;
        top_evidence_gaps: Array<{ id: string; field?: string }>;
      }>(join(result.value.researchDir, 'evidence_quality.json'));
      expect(evidenceQuality.flow_field_evidence).toContainEqual(
        expect.objectContaining({
          id: flowId,
          fields: expect.objectContaining({
            entry_contract: expect.any(Number),
            exit_contract: expect.any(Number),
            side_effects: expect.any(Number),
            required_tests: expect.any(Number),
            runtime_surfaces: expect.any(Number),
          }),
        }),
      );
      expect(evidenceQuality.top_evidence_gaps).not.toContainEqual(
        expect.objectContaining({ id: flowId, field: 'entry_contract' }),
      );

      const explained = await explainProjectTarget({
        rootDir: dir,
        target: flowId,
        now: new Date('2026-06-28T12:21:00.000Z'),
      });
      expect(explained.ok).toBe(true);
      if (!explained.ok) return;
      expect(explained.value.explanation.flow).toMatchObject({
        entry_contract: expect.arrayContaining([
          'Entrypoint performs validation before continuing to downstream steps.',
        ]),
        exit_contract: expect.arrayContaining([
          'Returns an HTTP/API response from the route flow.',
        ]),
        inputs: expect.arrayContaining(['HTTP request route input.']),
        outputs: expect.arrayContaining(['HTTP/API response.']),
        side_effects: expect.arrayContaining([
          'State/session/cache/database or filesystem side effect inferred from source.',
        ]),
        state_transitions: expect.arrayContaining([
          'Invalid input transitions into validation failure instead of normal output.',
        ]),
        required_tests: expect.arrayContaining(['validation failure coverage']),
        runtime_surfaces: expect.arrayContaining(['config:packages/api/package.json']),
        confidence_reasons: expect.arrayContaining(['Validation evidence is recorded.']),
        journey: expect.objectContaining({
          name: 'User login journey',
          category: 'auth_login',
        }),
        journey_steps: expect.arrayContaining([
          expect.objectContaining({ type: 'validation_auth' }),
          expect.objectContaining({ type: 'read_write_storage' }),
        ]),
      });
      const explainReport = await readFile(join(dir, '.rizz', 'reports', 'explain.html'), 'utf8');
      const missionControlReport = await readFile(
        join(dir, '.rizz', 'reports', 'index.html'),
        'utf8',
      );
      expect(explainReport).toContain('Entry Contract');
      expect(explainReport).toContain('Journey Steps');
      expect(explainReport).toContain('User login journey');
      expect(explainReport).toContain('Runtime Surfaces');
      expect(explainReport).toContain('Side Effects');
      expect(explainReport).toContain('validation failure coverage');
      expect(explainReport).not.toContain(dir);
      expect(missionControlReport).toContain('data-object="journey-intelligence"');
      expect(missionControlReport).toContain('User login journey');
      expect(missionControlReport).toContain('Evidence Health');
    });
  });

  it('understands static Express and Fastify-style HTTP route declarations', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src', 'orders'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'http-route-app',
          scripts: { dev: 'tsx src/server.ts', test: 'vitest run' },
          dependencies: { express: '^5.0.0', fastify: '^5.0.0' },
          devDependencies: { tsx: '^4.0.0', vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { module: 'NodeNext', strict: true } }),
      );
      await writeFile(
        join(dir, 'src', 'server.ts'),
        [
          'import express from "express";',
          'import Fastify from "fastify";',
          'import { createOrder } from "./orders/service.js";',
          '',
          'const app = express();',
          'const server = Fastify();',
          '',
          'app.get("/health", (_req, res) => res.json({ ok: true }));',
          'server.post("/orders", async (request, reply) => {',
          '  const order = createOrder(await request.body);',
          '  return reply.send(order);',
          '});',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'orders', 'service.ts'),
        [
          'export function createOrder(input: unknown): { id: string; input: unknown } {',
          '  const currency = process.env.DEFAULT_CURRENCY ?? "USD";',
          '  if (input === undefined) throw new Error("invalid order");',
          '  return { id: `order-1-${currency}`, input };',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'orders', 'orders.test.ts'),
        'import { it } from "vitest";\nit("covers the post orders route", () => {});\n',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:30:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const flows = await readJson<{
        entities: Array<{
          id: string;
          name: string;
          data?: {
            framework?: string;
            route_path?: string;
            route_type?: string;
            kind?: string;
            files?: string[];
            dependencies?: string[];
            configs?: string[];
            tests?: string[];
            services?: string[];
            service_causality?: Array<{
              service_id: string;
              service_name: string;
              files: string[];
              step_ids: string[];
              cause: string;
              effects: string[];
              evidence_ids: string[];
              confidence: string;
              unknowns: string[];
            }>;
            entrypoints?: Array<{ type: string; path: string; symbol: string | null }>;
            steps?: Array<{ type: string; path: string; symbol: string | null }>;
            inputs?: string[];
            outputs?: string[];
            failure_modes?: string[];
            confidence_reasons?: string[];
            field_evidence?: Record<string, string[]>;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      const httpFlows = flows.entities.filter(
        (flow) => flow.data?.framework === 'express-fastify-http',
      );
      expect(httpFlows).toHaveLength(2);

      const healthFlow = httpFlows.find((flow) => flow.data?.route_path === '/health');
      const ordersFlow = httpFlows.find((flow) => flow.data?.route_path === '/orders');
      expect(healthFlow?.id).toBe('flow:http--get--health--src--server.ts');
      expect(healthFlow?.data).toMatchObject({
        kind: 'api',
        route_type: 'GET',
        files: expect.arrayContaining(['src/server.ts']),
        configs: expect.arrayContaining(['package.json', 'tsconfig.json']),
        entrypoints: expect.arrayContaining([
          expect.objectContaining({
            type: 'route',
            path: 'src/server.ts',
            symbol: 'GET /health',
          }),
        ]),
        inputs: expect.arrayContaining(['HTTP request route input.']),
        outputs: expect.arrayContaining(['HTTP/API response.']),
      });
      expect(healthFlow?.data?.services ?? []).not.toContain('service:src--orders');
      expect(healthFlow?.data?.service_causality ?? []).toEqual([]);
      expect(ordersFlow?.id).toBe('flow:http--post--orders--src--server.ts');
      expect(ordersFlow?.data).toMatchObject({
        kind: 'api',
        route_type: 'POST',
        files: expect.arrayContaining(['src/server.ts', 'src/orders/service.ts']),
        dependencies: expect.arrayContaining(['dependency:express', 'dependency:fastify']),
        configs: expect.arrayContaining(['package.json', 'tsconfig.json']),
        tests: expect.arrayContaining(['src/orders/orders.test.ts']),
        services: expect.arrayContaining(['service:src--orders']),
        service_causality: expect.arrayContaining([
          expect.objectContaining({
            service_id: 'service:src--orders',
            service_name: 'src/orders',
            files: expect.arrayContaining(['src/orders/service.ts']),
            step_ids: expect.arrayContaining([
              expect.stringContaining('flow-http--post--orders--src--server.ts:002'),
            ]),
            cause: expect.stringContaining('HTTP POST /orders reaches service:src--orders'),
            effects: expect.arrayContaining(['env:DEFAULT_CURRENCY']),
            evidence_ids: expect.arrayContaining(['evidence:file-src--orders--service.ts']),
            confidence: 'uncertain',
            unknowns: expect.arrayContaining([
              'No API route evidence was linked directly to this service.',
            ]),
          }),
        ]),
        steps: expect.arrayContaining([
          expect.objectContaining({
            type: 'route',
            path: 'src/server.ts',
            symbol: 'POST /orders',
          }),
          expect.objectContaining({
            type: 'service',
            path: 'src/orders/service.ts',
          }),
        ]),
        failure_modes: expect.arrayContaining([
          'Source evidence contains explicit error handling paths.',
        ]),
        confidence_reasons: expect.arrayContaining([
          'Signal: http route declaration.',
          'Linked test artifact is recorded.',
        ]),
      });
      expect(ordersFlow?.data?.field_evidence).toMatchObject({
        entrypoints: expect.arrayContaining(['evidence:file-src--server.ts']),
        files: expect.arrayContaining([
          'evidence:file-src--server.ts',
          'evidence:file-src--orders--service.ts',
        ]),
        services: expect.arrayContaining(['evidence:file-src--orders--service.ts']),
        service_causality: expect.arrayContaining(['evidence:file-src--orders--service.ts']),
        tests: expect.arrayContaining(['evidence:file-src--orders--orders.test.ts']),
      });

      const evidenceQuality = await readJson<{
        service_causality_claim_count: number;
        service_causality_evidence_backed_claims: number;
        service_causality_uncertain_claims: number;
        service_causality_missing_evidence_claims: number;
        service_causality_missing_effect_claims: number;
        service_causality_missing_step_link_claims: number;
        service_causality_coverage_score: number;
        service_causality_quality: {
          total_claims: number;
          evidence_backed_claims: number;
          weak_evidence_claims: number;
          confidence_mix: { verified: number; inferred: number; uncertain: number };
          claim_examples: Array<{
            flow_id: string;
            service_id: string;
            evidence_ids: number;
            effects: number;
            step_ids: number;
            confidence: string;
          }>;
        };
        evidence_calibration: {
          surface_confidence_mix: Array<{
            surface: string;
            total_claims: number;
            evidence_backed_claims: number;
            confidence_mix: { verified: number; inferred: number; uncertain: number };
          }>;
        };
        actionability: {
          low_confidence_claim_areas: Array<{ area: string; inspect_hint: string }>;
        };
      }>(join(result.value.researchDir, 'evidence_quality.json'));
      expect(evidenceQuality).toMatchObject({
        service_causality_claim_count: 2,
        service_causality_evidence_backed_claims: 2,
        service_causality_uncertain_claims: 2,
        service_causality_missing_evidence_claims: 0,
        service_causality_missing_effect_claims: 0,
        service_causality_missing_step_link_claims: 0,
        service_causality_coverage_score: 100,
      });
      expect(evidenceQuality.service_causality_quality).toMatchObject({
        total_claims: 2,
        evidence_backed_claims: 2,
        weak_evidence_claims: 2,
        confidence_mix: { verified: 0, inferred: 0, uncertain: 2 },
      });
      expect(evidenceQuality.service_causality_quality.claim_examples).toContainEqual(
        expect.objectContaining({
          flow_id: 'flow:http--post--orders--src--server.ts',
          service_id: 'service:src--orders',
          evidence_ids: expect.any(Number),
          effects: expect.any(Number),
          step_ids: expect.any(Number),
          confidence: 'uncertain',
        }),
      );
      expect(evidenceQuality.evidence_calibration.surface_confidence_mix).toContainEqual(
        expect.objectContaining({
          surface: 'service_causality',
          total_claims: 2,
          evidence_backed_claims: 2,
          confidence_mix: { verified: 0, inferred: 0, uncertain: 2 },
        }),
      );
      expect(evidenceQuality.actionability.low_confidence_claim_areas).toContainEqual(
        expect.objectContaining({
          area: 'service causality evidence-backed claims',
          inspect_hint: expect.stringContaining('static-import service causality'),
        }),
      );

      const services = await readJson<{
        entities: Array<{
          id: string;
          type: string;
          name: string;
          confidence: string;
          data?: {
            runtime?: string;
            framework?: string;
            files?: string[];
            entrypoints?: string[];
            related_flows?: string[];
            related_components?: string[];
            risks?: string[];
            unknowns?: string[];
            field_evidence?: Record<string, string[]>;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'services.json'));
      const ordersService = services.entities.find(
        (service) => service.id === 'service:src--orders',
      );
      expect(ordersService).toMatchObject({
        id: 'service:src--orders',
        type: 'service',
        name: 'src/orders',
        confidence: 'uncertain',
        data: {
          runtime: 'node',
          framework: 'express-fastify-http',
          files: expect.arrayContaining(['src/orders/service.ts']),
          entrypoints: expect.arrayContaining(['src/orders/service.ts']),
          related_flows: expect.arrayContaining(['flow:http--post--orders--src--server.ts']),
          risks: expect.arrayContaining([
            'Environment variables are read but no service-local config artifact was linked.',
          ]),
          unknowns: expect.arrayContaining([
            'No API route evidence was linked directly to this service.',
          ]),
        },
      });

      const flowUnderstanding = await readJson<{
        contracts: Array<{
          id: string;
          framework?: string;
          route_path?: string;
          route_type?: string;
          services?: string[];
          service_causality?: Array<{ service_id: string; effects: string[] }>;
          outputs: string[];
        }>;
      }>(join(result.value.researchDir, 'flow_understanding.json'));
      expect(flowUnderstanding.contracts).toContainEqual(
        expect.objectContaining({
          id: 'flow:http--post--orders--src--server.ts',
          framework: 'express-fastify-http',
          route_path: '/orders',
          route_type: 'POST',
          services: expect.arrayContaining(['service:src--orders']),
          service_causality: expect.arrayContaining([
            expect.objectContaining({
              service_id: 'service:src--orders',
              effects: expect.arrayContaining(['env:DEFAULT_CURRENCY']),
            }),
          ]),
          outputs: expect.arrayContaining(['HTTP/API response.']),
        }),
      );
      const serviceIntelligence = await readJson<{
        total_services: number;
        services_with_related_flows: number;
        flow_links: Array<{ flow_id: string; service_ids: string[] }>;
        services: Array<{
          id: string;
          runtime: string;
          framework: string;
          related_flows: string[];
          evidence_ids: string[];
        }>;
      }>(join(result.value.researchDir, 'service_intelligence.json'));
      expect(serviceIntelligence.total_services).toBe(1);
      expect(serviceIntelligence.services_with_related_flows).toBe(1);
      expect(serviceIntelligence.flow_links).toContainEqual(
        expect.objectContaining({
          flow_id: 'flow:http--post--orders--src--server.ts',
          service_ids: expect.arrayContaining(['service:src--orders']),
        }),
      );
      expect(serviceIntelligence.services).toContainEqual(
        expect.objectContaining({
          id: 'service:src--orders',
          runtime: 'node',
          framework: 'express-fastify-http',
          related_flows: expect.arrayContaining(['flow:http--post--orders--src--server.ts']),
          evidence_ids: expect.arrayContaining(['evidence:file-src--orders--service.ts']),
        }),
      );

      const architectureReasoning = await readJson<{
        service_causality_reasoning: {
          total_paths: number;
          affected_flows: string[];
          affected_services: string[];
          effect_count: number;
          effects: string[];
          effect_categories: string[];
          route_impacts: Array<{
            flow_id: string;
            route_path: string;
            service_id: string;
            effects: string[];
            what_breaks: string[];
            evidence_ids: string[];
            confidence: string;
          }>;
          missing_effect_paths: string[];
          missing_step_link_paths: string[];
          evidence_ids: string[];
          confidence_distribution: { verified: number; inferred: number; uncertain: number };
          top_risky_effects: string[];
          unknowns: string[];
        };
        impact_map: {
          summary: {
            route_surfaces: number;
            service_causality_paths: number;
            service_causality_effect_count: number;
            service_causality_backed_surfaces: number;
            service_causality_unknown_count: number;
          };
          entries: Array<{
            impact_id: string;
            surface_type: string;
            entity_id: string;
            route_path?: string;
            route_type?: string;
            affected_flows: string[];
            affected_files: string[];
            affected_tests: string[];
            affected_configs: string[];
            service_causality?: Array<{ service_id: string; effects: string[] }>;
            coupling_level: string;
            confidence: string;
            evidence_ids: string[];
            what_breaks: string[];
            risk_reasoning: {
              risk_level: string;
              risk_score: number;
              criticality: string;
              tradeoffs: string[];
              risky_surfaces: string[];
              review_focus: string[];
              reasons: string[];
            };
            reasons: string[];
          }>;
        };
      }>(join(result.value.researchDir, 'architecture_reasoning.json'));
      expect(architectureReasoning.service_causality_reasoning).toMatchObject({
        total_paths: 2,
        affected_flows: expect.arrayContaining(['flow:http--post--orders--src--server.ts']),
        affected_services: expect.arrayContaining(['service:src--orders']),
        effect_count: 1,
        effects: expect.arrayContaining(['env:DEFAULT_CURRENCY']),
        effect_categories: expect.arrayContaining(['env']),
        missing_effect_paths: [],
        missing_step_link_paths: [],
        evidence_ids: expect.arrayContaining(['evidence:file-src--orders--service.ts']),
        confidence_distribution: { verified: 0, inferred: 0, uncertain: 2 },
        top_risky_effects: expect.arrayContaining(['env:DEFAULT_CURRENCY']),
      });
      expect(architectureReasoning.service_causality_reasoning.route_impacts).toContainEqual(
        expect.objectContaining({
          flow_id: 'flow:http--post--orders--src--server.ts',
          route_path: '/orders',
          service_id: 'service:src--orders',
          effects: expect.arrayContaining(['env:DEFAULT_CURRENCY']),
          what_breaks: expect.arrayContaining([
            expect.stringContaining('service:src--orders can change route /orders behavior'),
          ]),
          evidence_ids: expect.arrayContaining(['evidence:file-src--orders--service.ts']),
          confidence: 'uncertain',
        }),
      );
      expect(architectureReasoning.impact_map.summary).toMatchObject({
        route_surfaces: 2,
        service_causality_paths: 1,
        service_causality_effect_count: 1,
        service_causality_backed_surfaces: 1,
        service_causality_unknown_count: 0,
      });
      expect(architectureReasoning.impact_map.entries).toContainEqual(
        expect.objectContaining({
          impact_id: 'impact:flow:http--post--orders--src--server.ts',
          surface_type: 'route',
          entity_id: 'flow:http--post--orders--src--server.ts',
          route_path: '/orders',
          route_type: 'POST',
          affected_flows: ['flow:http--post--orders--src--server.ts'],
          affected_files: expect.arrayContaining(['src/server.ts', 'src/orders/service.ts']),
          affected_tests: expect.arrayContaining(['src/orders/orders.test.ts']),
          affected_configs: expect.arrayContaining(['package.json', 'tsconfig.json']),
          service_causality: expect.arrayContaining([
            expect.objectContaining({
              service_id: 'service:src--orders',
              effects: expect.arrayContaining(['env:DEFAULT_CURRENCY']),
            }),
          ]),
          coupling_level: 'medium',
          confidence: 'verified',
          evidence_ids: expect.arrayContaining([
            'evidence:file-src--server.ts',
            'evidence:file-src--orders--service.ts',
          ]),
          what_breaks: expect.arrayContaining([
            expect.stringContaining('Changing route /orders can alter POST request handling'),
          ]),
          risk_reasoning: expect.objectContaining({
            risk_level: 'high',
            criticality: 'high',
            tradeoffs: expect.arrayContaining([
              expect.stringContaining('Service causality makes side effects visible'),
            ]),
            risky_surfaces: expect.arrayContaining([
              'configuration-backed surface',
              'service-side-effect surface',
            ]),
            review_focus: expect.arrayContaining([
              expect.stringContaining('service side-effect signal'),
            ]),
            reasons: expect.arrayContaining(['service_effects:1']),
          }),
          reasons: expect.arrayContaining([
            'framework:express-fastify-http',
            'route_type:POST',
            'tests:1',
            'service_causality:1',
          ]),
        }),
      );

      const explained = await explainProjectTarget({
        rootDir: dir,
        target: 'flow:http--post--orders--src--server.ts',
        now: new Date('2026-06-28T12:31:00.000Z'),
      });
      expect(explained.ok).toBe(true);
      if (!explained.ok) return;
      expect(explained.value.explanation.flow).toMatchObject({
        framework: 'express-fastify-http',
        route_path: '/orders',
        route_type: 'POST',
        services: expect.arrayContaining(['service:src--orders']),
        service_causality: expect.arrayContaining([
          expect.objectContaining({
            service_id: 'service:src--orders',
            effects: expect.arrayContaining(['env:DEFAULT_CURRENCY']),
          }),
        ]),
        entrypoints: expect.arrayContaining([
          expect.objectContaining({ path: 'src/server.ts', symbol: 'POST /orders' }),
        ]),
        outputs: expect.arrayContaining(['HTTP/API response.']),
      });
      const flowExplainReport = await readFile(
        join(dir, '.rizz', 'reports', 'explain.html'),
        'utf8',
      );
      expect(flowExplainReport).toContain('POST /orders');
      expect(flowExplainReport).toContain('HTTP POST /orders route enters src/server.ts');
      expect(flowExplainReport).toContain('service:src--orders');
      expect(flowExplainReport).toContain('Service Causality');
      expect(flowExplainReport).toContain('env:DEFAULT_CURRENCY');
      expect(flowExplainReport).not.toContain(dir);

      const serviceExplained = await explainProjectTarget({
        rootDir: dir,
        target: 'service src/orders',
        now: new Date('2026-06-28T12:32:00.000Z'),
      });
      expect(serviceExplained.ok).toBe(true);
      if (!serviceExplained.ok) return;
      expect(serviceExplained.value.explanation.resolved_entity_id).toBe('service:src--orders');
      expect(serviceExplained.value.explanation.entity_type).toBe('service');
      expect(serviceExplained.value.explanation.service).toMatchObject({
        runtime: 'node',
        framework: 'express-fastify-http',
        related_flows: expect.arrayContaining(['flow:http--post--orders--src--server.ts']),
      });
      const serviceExplainReport = await readFile(
        join(dir, '.rizz', 'reports', 'explain.html'),
        'utf8',
      );
      expect(serviceExplainReport).toContain('Service Runtime');
      expect(serviceExplainReport).toContain('Related Flows');
      expect(serviceExplainReport).toContain('flow:http--post--orders--src--server.ts');
      expect(serviceExplainReport).not.toContain(dir);

      const missionControl = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(missionControl).toContain('Service Intelligence');
      expect(missionControl).toContain('rizz explain service src/orders');
      expect(missionControl).toContain('.rizz/research/service_intelligence.json');
      expect(missionControl).toContain('Reachability Quality');
      expect(missionControl).toContain('2 static reachability path(s)');
      expect(missionControl).toContain('Effects & Unknowns');
      expect(missionControl).toContain('Freshness');
      expect(missionControl).toContain('Reachability Paths');
      expect(missionControl).toContain('uncertain/static-import-only claim(s)');
      expect(missionControl).toContain('100/100 freshness');
      expect(missionControl).toContain('.rizz/research/architecture_reasoning.json');
      expect(missionControl).toContain('.rizz/research/evidence_quality.json');
      expect(missionControl).toContain('.rizz/research/incremental_update.json');
    });
  });

  it('reports service and related flow incremental reuse after a service source change', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src', 'orders'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'http-route-incremental-app',
          scripts: { dev: 'tsx src/server.ts', test: 'vitest run' },
          dependencies: { express: '^5.0.0' },
          devDependencies: { tsx: '^4.0.0', vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'src', 'server.ts'),
        [
          'import express from "express";',
          'import { createOrder } from "./orders/service.js";',
          '',
          'const app = express();',
          'app.post("/orders", async (req, res) => {',
          '  const order = createOrder(req.body);',
          '  return res.json(order);',
          '});',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'health.ts'),
        [
          'import express from "express";',
          '',
          'const health = express();',
          'health.get("/health", (_req, res) => res.json({ ok: true }));',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'orders', 'service.ts'),
        [
          'export function createOrder(input: unknown): { id: string; input: unknown } {',
          '  const currency = process.env.DEFAULT_CURRENCY ?? "USD";',
          '  return { id: `order-1-${currency}`, input };',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'orders', 'orders.test.ts'),
        'import { it } from "vitest";\nit("covers the post orders route", () => {});\n',
      );

      const first = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:50:00.000Z'),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      await writeFile(
        join(dir, 'src', 'orders', 'service.ts'),
        [
          'export function createOrder(input: unknown): { id: string; input: unknown } {',
          '  const currency = process.env.DEFAULT_CURRENCY ?? "USD";',
          '  return { id: `order-2-${currency}`, input };',
          '}',
          '',
        ].join('\n'),
      );

      const second = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:51:00.000Z'),
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      const incremental = await readJson<{
        changed_files: string[];
        service_count: number;
        service_changed: number;
        service_recomputed: number;
        service_reused: number;
        reused_understanding_count: number;
        service_incremental_health: {
          changed_ids: string[];
          recomputed_ids: string[];
          source_changed_ids: string[];
        };
        flow_count: number;
        flow_changed: number;
        flow_recomputed: number;
        flow_reused: number;
        flow_incremental_health: {
          changed_ids: string[];
          reused_ids: string[];
          recomputed_ids: string[];
          source_changed_ids: string[];
        };
        service_causality_delta: {
          previous_path_count: number;
          current_path_count: number;
          stable_path_count: number;
          recomputed_path_count: number;
          drifted_path_count: number;
          evidence_changed_path_count: number;
          affected_flow_count: number;
          affected_service_count: number;
          affected_flows: string[];
          affected_services: string[];
          changed_evidence_ids: string[];
          freshness_score: number;
          path_deltas: Array<{
            flow_id: string;
            service_id: string;
            status: string;
            changed_files: string[];
            changed_evidence_ids: string[];
            reasons: string[];
          }>;
        };
        understanding_deltas: {
          by_surface_type: {
            flow: { changed: number; stable: number };
            service: { changed: number };
          };
        };
      }>(join(second.value.researchDir, 'incremental_update.json'));
      expect(incremental.changed_files).toEqual(['src/orders/service.ts']);
      expect(incremental).toMatchObject({
        service_count: 1,
        service_changed: 1,
        service_recomputed: 1,
        service_reused: 0,
      });
      expect(incremental.flow_count).toBeGreaterThan(1);
      expect(incremental.flow_changed).toBeGreaterThan(0);
      expect(incremental.flow_recomputed).toBeGreaterThan(0);
      expect(incremental.reused_understanding_count).toBeGreaterThan(0);
      expect(incremental.service_incremental_health.changed_ids).toEqual(['service:src--orders']);
      expect(incremental.service_incremental_health.recomputed_ids).toEqual([
        'service:src--orders',
      ]);
      expect(incremental.service_incremental_health.source_changed_ids).toEqual([
        'service:src--orders',
      ]);
      expect(incremental.flow_incremental_health.changed_ids).toContain(
        'flow:http--post--orders--src--server.ts',
      );
      expect(incremental.flow_incremental_health.recomputed_ids).toContain(
        'flow:http--post--orders--src--server.ts',
      );
      expect(incremental.flow_incremental_health.source_changed_ids).toContain(
        'flow:http--post--orders--src--server.ts',
      );
      expect(incremental.service_causality_delta).toMatchObject({
        previous_path_count: 2,
        current_path_count: 2,
        stable_path_count: 0,
        recomputed_path_count: 0,
        drifted_path_count: 2,
        evidence_changed_path_count: 2,
        affected_flow_count: 2,
        affected_service_count: 1,
        affected_flows: ['flow:http--post--orders--src--server.ts', 'flow:scripts--dev'],
        affected_services: ['service:src--orders'],
        changed_evidence_ids: ['evidence:file-src--orders--service.ts'],
        freshness_score: 0,
      });
      expect(incremental.service_causality_delta.path_deltas).toContainEqual(
        expect.objectContaining({
          flow_id: 'flow:http--post--orders--src--server.ts',
          service_id: 'service:src--orders',
          status: 'drifted',
          changed_files: ['src/orders/service.ts'],
          changed_evidence_ids: ['evidence:file-src--orders--service.ts'],
          reasons: expect.arrayContaining([
            'linked evidence changed',
            'linked source file changed',
            'target service was recomputed',
            'causality fingerprint stayed stable while linked evidence changed',
          ]),
        }),
      );
      expect(incremental.understanding_deltas.by_surface_type.flow.changed).toBeGreaterThan(0);
      expect(incremental.understanding_deltas.by_surface_type.service.changed).toBe(1);

      const latest = await readJson<{
        latest_incremental_update: {
          service_count: number;
          service_recomputed: number;
          flow_count: number;
          flow_reused: number;
          flow_recomputed: number;
          service_incremental_health: { source_changed_ids: string[] };
          flow_incremental_health: { reused_ids: string[]; source_changed_ids: string[] };
          service_causality_delta: {
            drifted_path_count: number;
            affected_services: string[];
            changed_evidence_ids: string[];
            freshness_score: number;
          };
        };
        project_state?: {
          incremental_health?: {
            services?: { recomputed_ids: string[] };
            flows?: { reused_ids: string[]; recomputed_ids: string[] };
            service_causality?: {
              drifted_path_count: number;
              affected_flows: string[];
            };
          };
        };
      }>(join(dir, '.rizz', 'brain', 'latest.json'));
      expect(latest.latest_incremental_update).toMatchObject({
        service_count: 1,
        service_recomputed: 1,
      });
      expect(latest.latest_incremental_update.flow_count).toBe(incremental.flow_count);
      expect(latest.latest_incremental_update.flow_reused).toBe(incremental.flow_reused);
      expect(latest.latest_incremental_update.flow_recomputed).toBe(incremental.flow_recomputed);
      expect(
        latest.latest_incremental_update.service_incremental_health.source_changed_ids,
      ).toEqual(['service:src--orders']);
      expect(latest.latest_incremental_update.flow_incremental_health.source_changed_ids).toContain(
        'flow:http--post--orders--src--server.ts',
      );
      expect(latest.project_state?.incremental_health?.services?.recomputed_ids).toEqual([
        'service:src--orders',
      ]);
      expect(latest.project_state?.incremental_health?.flows?.recomputed_ids).toContain(
        'flow:http--post--orders--src--server.ts',
      );
      expect(latest.latest_incremental_update.service_causality_delta).toMatchObject({
        drifted_path_count: 2,
        affected_services: ['service:src--orders'],
        changed_evidence_ids: ['evidence:file-src--orders--service.ts'],
        freshness_score: 0,
      });
      expect(latest.project_state?.incremental_health?.service_causality).toMatchObject({
        drifted_path_count: 2,
        affected_flows: expect.arrayContaining(['flow:http--post--orders--src--server.ts']),
      });

      const missionControl = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(missionControl).toContain('Service Causality');
      expect(missionControl).toContain('Incremental Health');
      expect(missionControl).toContain('flow-service causality link(s)');
      expect(missionControl).toContain('source-changed service(s)');
      expect(missionControl).toContain('source-changed flow(s)');
      expect(missionControl).toContain('data-object="service-causality"');
      expect(missionControl).toContain('data-object="incremental-health"');
      expect(missionControl).toContain('service:src--orders');
      expect(missionControl).toContain('flow:http--post--orders--src--server.ts');
      expect(missionControl).toContain('env:DEFAULT_CURRENCY');
      expect(missionControl).not.toContain(dir);

      const flowUnderstanding = await readJson<{
        incremental_update: {
          changed_count: number;
          reused_count: number;
          recomputed_count: number;
          source_changed: string[];
        };
      }>(join(second.value.researchDir, 'flow_understanding.json'));
      expect(flowUnderstanding.incremental_update).toMatchObject({
        changed_count: incremental.flow_changed,
        reused_count: incremental.flow_reused,
        recomputed_count: incremental.flow_recomputed,
      });
      expect(flowUnderstanding.incremental_update.source_changed).toContain(
        'flow:http--post--orders--src--server.ts',
      );
    });
  });

  it('links FastAPI route flows to Python service intelligence', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'app', 'routers'), { recursive: true });
      await mkdir(join(dir, 'app', 'services'), { recursive: true });
      await writeFile(
        join(dir, 'pyproject.toml'),
        [
          '[project]',
          'name = "kb-api"',
          'version = "0.1.0"',
          'dependencies = ["fastapi", "requests"]',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'app', 'routers', 'kb.py'),
        [
          'from fastapi import APIRouter',
          'from app.services.kb_service import ingest_video',
          '',
          'router = APIRouter()',
          '',
          '@router.get("/health")',
          'def health() -> dict:',
          '    return {"ok": True}',
          '',
          '@router.post("/kb/youtube")',
          'def ingest_youtube(payload: dict):',
          '    return ingest_video(payload["url"])',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'app', 'services', 'kb_service.py'),
        [
          'import os',
          'import sqlite3',
          'import requests',
          '',
          'DATABASE_PATH = os.getenv("DATABASE_PATH", "/tmp/kb.db")',
          '',
          'def ingest_video(url: str) -> dict:',
          '    if not url:',
          '        raise ValueError("missing url")',
          '    sqlite3.connect(DATABASE_PATH)',
          '    requests.get(url)',
          '    return {"source": "youtube", "url": url}',
          '',
        ].join('\n'),
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:40:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const flows = await readJson<{
        entities: Array<{
          id: string;
          data?: {
            framework?: string;
            route_path?: string;
            route_type?: string;
            files?: string[];
            services?: string[];
            service_causality?: Array<{
              service_id: string;
              files: string[];
              cause: string;
              effects: string[];
              evidence_ids: string[];
            }>;
            steps?: Array<{ type: string; path: string; symbol: string | null }>;
            field_evidence?: Record<string, string[]>;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      const kbFlow = flows.entities.find(
        (flow) => flow.id === 'flow:http--post--kb--youtube--app--routers--kb.py',
      );
      expect(kbFlow?.data).toMatchObject({
        framework: 'fastapi',
        route_path: '/kb/youtube',
        route_type: 'POST',
        files: expect.arrayContaining(['app/routers/kb.py', 'app/services/kb_service.py']),
        services: expect.arrayContaining(['service:app--services']),
        service_causality: expect.arrayContaining([
          expect.objectContaining({
            service_id: 'service:app--services',
            files: expect.arrayContaining(['app/services/kb_service.py']),
            cause: expect.stringContaining(
              'FastAPI POST /kb/youtube reaches service:app--services',
            ),
            effects: expect.arrayContaining([
              'storage:sqlite/database',
              'storage:temporary filesystem',
              'env:DATABASE_PATH',
              'external:http-client',
              'external:youtube',
            ]),
            evidence_ids: expect.arrayContaining(['evidence:file-app--services--kb_service.py']),
          }),
        ]),
        steps: expect.arrayContaining([
          expect.objectContaining({
            type: 'route',
            path: 'app/routers/kb.py',
            symbol: 'POST /kb/youtube',
          }),
          expect.objectContaining({
            type: 'service',
            path: 'app/services/kb_service.py',
          }),
        ]),
        field_evidence: expect.objectContaining({
          services: expect.arrayContaining(['evidence:file-app--services--kb_service.py']),
          service_causality: expect.arrayContaining(['evidence:file-app--services--kb_service.py']),
        }),
      });
      const healthFlow = flows.entities.find(
        (flow) => flow.id === 'flow:http--get--health--app--routers--kb.py',
      );
      expect(healthFlow?.data).toMatchObject({
        framework: 'fastapi',
        route_path: '/health',
        route_type: 'GET',
        files: ['app/routers/kb.py'],
      });
      expect(healthFlow?.data?.services ?? []).not.toContain('service:app--services');
      expect(healthFlow?.data?.service_causality ?? []).toEqual([]);

      const services = await readJson<{
        entities: Array<{
          id: string;
          data?: {
            runtime?: string;
            storage_dependencies?: string[];
            environment_variables?: string[];
            external_services?: string[];
            related_flows?: string[];
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'services.json'));
      expect(services.entities).toContainEqual(
        expect.objectContaining({
          id: 'service:app--services',
          data: expect.objectContaining({
            runtime: 'python',
            storage_dependencies: expect.arrayContaining([
              'sqlite/database',
              'temporary filesystem',
            ]),
            environment_variables: expect.arrayContaining(['DATABASE_PATH']),
            external_services: expect.arrayContaining(['http-client', 'youtube']),
            related_flows: expect.arrayContaining([
              'flow:http--post--kb--youtube--app--routers--kb.py',
            ]),
          }),
        }),
      );

      const serviceIntelligence = await readJson<{
        services_with_storage: number;
        services_with_external_apis: number;
        flow_links: Array<{ flow_id: string; service_ids: string[] }>;
      }>(join(result.value.researchDir, 'service_intelligence.json'));
      expect(serviceIntelligence.services_with_storage).toBe(1);
      expect(serviceIntelligence.services_with_external_apis).toBe(1);
      expect(serviceIntelligence.flow_links).toContainEqual(
        expect.objectContaining({
          flow_id: 'flow:http--post--kb--youtube--app--routers--kb.py',
          service_ids: expect.arrayContaining(['service:app--services']),
        }),
      );

      const explained = await explainProjectTarget({
        rootDir: dir,
        target: 'service app/services',
        now: new Date('2026-06-28T12:41:00.000Z'),
      });
      expect(explained.ok).toBe(true);
      if (!explained.ok) return;
      expect(explained.value.explanation.service).toMatchObject({
        runtime: 'python',
        storage_dependencies: expect.arrayContaining(['sqlite/database']),
        external_services: expect.arrayContaining(['http-client', 'youtube']),
        related_flows: expect.arrayContaining([
          'flow:http--post--kb--youtube--app--routers--kb.py',
        ]),
      });
    });
  });

  it('understands Hono route app declarations with local contracts and explain data', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src', 'sessions'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'hono-route-app',
          scripts: { test: 'vitest run' },
          dependencies: { hono: '^4.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { module: 'NodeNext', strict: true } }),
      );
      await writeFile(
        join(dir, 'src', 'api.ts'),
        [
          'import { Hono } from "hono";',
          'import { createSession } from "./sessions/service.js";',
          '',
          'const api = new Hono();',
          '',
          'api.get("/health", (context) => context.json({ ok: true }));',
          'api.post("/sessions", async (context) => {',
          '  const body = await context.req.json();',
          '  const session = createSession(body);',
          '  return context.json(session, 201);',
          '});',
          '',
          'export default api;',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'sessions', 'service.ts'),
        [
          'export function createSession(input: unknown): { id: string; input: unknown } {',
          '  if (input === undefined) throw new Error("invalid session");',
          '  return { id: "session-1", input };',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'sessions', 'session.test.ts'),
        'import { it } from "vitest";\nit("covers the post sessions route", () => {});\n',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:45:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const flows = await readJson<{
        entities: Array<{
          id: string;
          name: string;
          data?: {
            framework?: string;
            route_path?: string;
            route_type?: string;
            files?: string[];
            dependencies?: string[];
            configs?: string[];
            tests?: string[];
            services?: string[];
            service_causality?: Array<{
              service_id: string;
              effects: string[];
              evidence_ids: string[];
              step_ids: string[];
              confidence: string;
            }>;
            entrypoints?: Array<{ type: string; path: string; symbol: string | null }>;
            steps?: Array<{ type: string; path: string; symbol: string | null }>;
            inputs?: string[];
            outputs?: string[];
            confidence_reasons?: string[];
            field_evidence?: Record<string, string[]>;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      const honoFlows = flows.entities.filter((flow) => flow.data?.framework === 'hono');
      expect(honoFlows).toHaveLength(2);

      const healthFlow = honoFlows.find((flow) => flow.data?.route_path === '/health');
      const sessionFlow = honoFlows.find((flow) => flow.data?.route_path === '/sessions');
      expect(healthFlow?.data?.services ?? []).not.toContain('service:src--sessions');
      expect(healthFlow?.data?.service_causality ?? []).toEqual([]);
      expect(sessionFlow?.id).toBe('flow:hono--post--sessions--src--api.ts');
      expect(sessionFlow?.name).toBe('POST /sessions Hono route');
      expect(sessionFlow?.data).toMatchObject({
        route_type: 'POST',
        files: expect.arrayContaining(['src/api.ts', 'src/sessions/service.ts']),
        dependencies: expect.arrayContaining(['dependency:hono']),
        configs: expect.arrayContaining(['package.json', 'tsconfig.json']),
        tests: expect.arrayContaining(['src/sessions/session.test.ts']),
        services: expect.arrayContaining(['service:src--sessions']),
        service_causality: expect.arrayContaining([
          expect.objectContaining({
            service_id: 'service:src--sessions',
            effects: [],
            evidence_ids: expect.arrayContaining(['evidence:file-src--sessions--service.ts']),
            step_ids: expect.arrayContaining([
              expect.stringContaining('flow-hono--post--sessions--src--api.ts:002'),
            ]),
            confidence: 'uncertain',
          }),
        ]),
        entrypoints: expect.arrayContaining([
          expect.objectContaining({
            type: 'route',
            path: 'src/api.ts',
            symbol: 'POST /sessions',
          }),
        ]),
        steps: expect.arrayContaining([
          expect.objectContaining({
            type: 'route',
            path: 'src/api.ts',
            symbol: 'POST /sessions',
          }),
          expect.objectContaining({
            type: 'service',
            path: 'src/sessions/service.ts',
          }),
        ]),
        inputs: expect.arrayContaining(['HTTP request route input.']),
        outputs: expect.arrayContaining(['HTTP/API response.']),
        confidence_reasons: expect.arrayContaining([
          'Signal: hono route app.',
          'Signal: http route declaration.',
          'Linked test artifact is recorded.',
        ]),
      });
      expect(sessionFlow?.data?.field_evidence).toMatchObject({
        entrypoints: expect.arrayContaining(['evidence:file-src--api.ts']),
        files: expect.arrayContaining([
          'evidence:file-src--api.ts',
          'evidence:file-src--sessions--service.ts',
        ]),
        service_causality: expect.arrayContaining(['evidence:file-src--sessions--service.ts']),
        tests: expect.arrayContaining(['evidence:file-src--sessions--session.test.ts']),
      });

      const evidenceQuality = await readJson<{
        service_causality_claim_count: number;
        service_causality_evidence_backed_claims: number;
        service_causality_uncertain_claims: number;
        service_causality_missing_effect_claims: number;
        service_causality_missing_step_link_claims: number;
        service_causality_quality: {
          missing_effect_claims: number;
          missing_step_link_claims: number;
          claim_examples: Array<{ flow_id: string; service_id: string; effects: number }>;
        };
        top_evidence_gaps: Array<{ kind: string; id: string; field?: string; reason: string }>;
        top_uncertain_areas: string[];
        actionability: {
          top_evidence_gaps: Array<{
            kind: string;
            id: string;
            field?: string;
            reason: string;
          }>;
        };
      }>(join(result.value.researchDir, 'evidence_quality.json'));
      expect(evidenceQuality).toMatchObject({
        service_causality_claim_count: 1,
        service_causality_evidence_backed_claims: 1,
        service_causality_uncertain_claims: 1,
        service_causality_missing_effect_claims: 1,
        service_causality_missing_step_link_claims: 0,
      });
      expect(evidenceQuality.service_causality_quality).toMatchObject({
        missing_effect_claims: 1,
        missing_step_link_claims: 0,
      });
      expect(evidenceQuality.service_causality_quality.claim_examples).toContainEqual(
        expect.objectContaining({
          flow_id: 'flow:hono--post--sessions--src--api.ts',
          service_id: 'service:src--sessions',
          effects: 0,
        }),
      );
      expect(evidenceQuality.top_evidence_gaps).toContainEqual(
        expect.objectContaining({
          kind: 'uncertain_service_causality_effect',
          id: 'flow:hono--post--sessions--src--api.ts service_causality service:src--sessions',
          field: 'service_causality',
          reason: expect.stringContaining('no recorded effects'),
        }),
      );
      expect(evidenceQuality.actionability.top_evidence_gaps).toEqual(
        evidenceQuality.top_evidence_gaps,
      );
      expect(evidenceQuality.top_uncertain_areas).toContain(
        'service causality: flow:hono--post--sessions--src--api.ts service_causality service:src--sessions (uncertain_service_causality_effect)',
      );

      const flowUnderstanding = await readJson<{
        contracts: Array<{
          id: string;
          framework?: string;
          route_path?: string;
          route_type?: string;
          outputs: string[];
          confidence_reasons: string[];
        }>;
      }>(join(result.value.researchDir, 'flow_understanding.json'));
      expect(flowUnderstanding.contracts).toContainEqual(
        expect.objectContaining({
          id: 'flow:hono--post--sessions--src--api.ts',
          framework: 'hono',
          route_path: '/sessions',
          route_type: 'POST',
          outputs: expect.arrayContaining(['HTTP/API response.']),
          confidence_reasons: expect.arrayContaining(['Signal: hono route app.']),
        }),
      );

      const architectureReasoning = await readJson<{
        impact_map: {
          summary: { route_surfaces: number };
          entries: Array<{
            impact_id: string;
            surface_type: string;
            entity_id: string;
            route_path?: string;
            route_type?: string;
            affected_flows: string[];
            affected_files: string[];
            affected_tests: string[];
            affected_configs: string[];
            confidence: string;
            what_breaks: string[];
            reasons: string[];
          }>;
        };
      }>(join(result.value.researchDir, 'architecture_reasoning.json'));
      expect(architectureReasoning.impact_map.summary.route_surfaces).toBe(2);
      expect(architectureReasoning.impact_map.entries).toContainEqual(
        expect.objectContaining({
          impact_id: 'impact:flow:hono--post--sessions--src--api.ts',
          surface_type: 'route',
          entity_id: 'flow:hono--post--sessions--src--api.ts',
          route_path: '/sessions',
          route_type: 'POST',
          affected_flows: ['flow:hono--post--sessions--src--api.ts'],
          affected_files: expect.arrayContaining(['src/api.ts', 'src/sessions/service.ts']),
          affected_tests: expect.arrayContaining(['src/sessions/session.test.ts']),
          affected_configs: expect.arrayContaining(['package.json', 'tsconfig.json']),
          confidence: 'verified',
          what_breaks: expect.arrayContaining([
            expect.stringContaining('Changing route /sessions can alter POST request handling'),
          ]),
          reasons: expect.arrayContaining(['framework:hono', 'route_type:POST', 'tests:1']),
        }),
      );

      const explained = await explainProjectTarget({
        rootDir: dir,
        target: 'flow:hono--post--sessions--src--api.ts',
        now: new Date('2026-06-28T12:46:00.000Z'),
      });
      expect(explained.ok).toBe(true);
      if (!explained.ok) return;
      expect(explained.value.explanation.flow).toMatchObject({
        framework: 'hono',
        route_path: '/sessions',
        route_type: 'POST',
        entrypoints: expect.arrayContaining([
          expect.objectContaining({ path: 'src/api.ts', symbol: 'POST /sessions' }),
        ]),
        outputs: expect.arrayContaining(['HTTP/API response.']),
        confidence_reasons: expect.arrayContaining(['Signal: hono route app.']),
      });
      const explainReport = await readFile(join(dir, '.rizz', 'reports', 'explain.html'), 'utf8');
      expect(explainReport).toContain('POST /sessions');
      expect(explainReport).toContain('Hono POST /sessions route enters src/api.ts');
      expect(explainReport).not.toContain(dir);
    });
  });

  it('reconstructs deployment flows with deployment config risks and Mission Control summary', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'packages', 'web', 'src'), { recursive: true });
      await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
      await writeFile(
        join(dir, 'packages', 'web', 'package.json'),
        JSON.stringify({
          name: '@sample/web',
          scripts: {
            build: 'vite build',
            deploy: 'pnpm build && vercel deploy --prod',
          },
          devDependencies: { vite: '^5.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'web', 'src', 'index.ts'),
        'export const app = true;\n',
      );
      await writeFile(
        join(dir, 'packages', 'web', 'vercel.json'),
        JSON.stringify({
          version: 2,
          env: {
            DATABASE_PATH: '/tmp/app.db',
            AUTH_ENABLED: 'false',
            CORS_ORIGINS: '*',
          },
        }),
      );
      await writeFile(
        join(dir, '.github', 'workflows', 'deploy.yml'),
        'name: deploy\non: workflow_dispatch\njobs:\n  deploy:\n    steps:\n      - run: pnpm --filter @sample/web deploy\n',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:40:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const flows = await readJson<{
        entities: Array<{
          id: string;
          data?: {
            configs?: string[];
            signals?: string[];
            risks?: Array<{ kind: string; description: string }>;
            required_tests?: string[];
            failure_modes?: string[];
            confidence_reasons?: string[];
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      const deployFlow = flows.entities.find((flow) => flow.id === 'flow:packages--web--deploy');
      expect(deployFlow?.data).toMatchObject({
        configs: expect.arrayContaining([
          'packages/web/package.json',
          'packages/web/vercel.json',
          '.github/workflows/deploy.yml',
        ]),
        signals: expect.arrayContaining(['deployment', 'configuration']),
        required_tests: expect.arrayContaining(['production smoke check']),
        confidence_reasons: expect.arrayContaining(['Deployment config evidence is recorded.']),
      });
      expect(deployFlow?.data?.failure_modes).toContain(
        'Deployment can succeed locally while production storage, auth, CORS, or runtime env remain unverified.',
      );
      expect(deployFlow?.data?.risks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'deployment_storage' }),
          expect.objectContaining({ kind: 'deployment_auth' }),
          expect.objectContaining({ kind: 'deployment_cors' }),
        ]),
      );

      const architectureReasoning = await readJson<{
        deployment_intelligence: {
          summary: {
            deployment_flow_count: number;
            deployment_config_count: number;
            production_risk_count: number;
            posture: string;
          };
          flows: Array<{
            flow_id: string;
            configs: string[];
            production_risk_count: number;
            required_tests: string[];
          }>;
        };
        review_hints: Array<{ reason: string; affected_flows?: string[] }>;
      }>(join(result.value.researchDir, 'architecture_reasoning.json'));
      expect(architectureReasoning.deployment_intelligence.summary).toMatchObject({
        deployment_flow_count: 1,
        production_risk_count: 3,
        posture: 'risky until verified',
      });
      expect(architectureReasoning.deployment_intelligence.flows).toContainEqual(
        expect.objectContaining({
          flow_id: 'flow:packages--web--deploy',
          production_risk_count: 3,
          required_tests: expect.arrayContaining(['production smoke check']),
        }),
      );
      expect(architectureReasoning.review_hints).toContainEqual(
        expect.objectContaining({
          reason: expect.stringContaining('Deployment flows should be reviewed'),
          affected_flows: expect.arrayContaining(['flow:packages--web--deploy']),
        }),
      );

      const report = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(report).toContain('Deployment Intelligence');
      expect(report).toContain('risky until verified');
    });
  });

  it('understands Next.js app router route, render, and metadata flows', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src', 'app', 'docs', '[slug]'), { recursive: true });
      await mkdir(join(dir, 'src', 'app', 'api', 'health'), { recursive: true });
      await mkdir(join(dir, 'src', 'components'), { recursive: true });
      await mkdir(join(dir, 'src', 'content'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'next-app',
          scripts: { dev: 'next dev', test: 'vitest run' },
          dependencies: { next: '^15.0.0', react: '^19.0.0' },
          devDependencies: { vitest: '^2.0.0', typescript: '^5.0.0' },
        }),
      );
      await writeFile(join(dir, 'next.config.ts'), 'export default { typedRoutes: true };\n');
      await writeFile(join(dir, '.env.local'), 'RIZZ_TEST_TOKEN=secret\n');
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@/*': ['./src/*'],
              '~/*': ['./src/*'],
            },
          },
        }),
      );
      await writeFile(
        join(dir, 'src', 'components', 'Hero.tsx'),
        [
          'export function Hero(): JSX.Element {',
          '  return <section>Home</section>;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'components', 'DocPage.tsx'),
        [
          'export function DocPage(props: { title: string }): JSX.Element {',
          '  return <article>{props.title}</article>;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'content', 'docs.ts'),
        [
          'export const docs = new Map<string, { title: string }>([',
          '  ["intro", { title: "Intro" }],',
          ']);',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'app', 'page.tsx'),
        [
          'import { Hero } from "@/components/Hero";',
          'export default function Page(): JSX.Element {',
          '  return <Hero />;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'app', 'layout.tsx'),
        [
          'export default function RootLayout(props: { children: React.ReactNode }): JSX.Element {',
          '  return <html lang="en"><body>{props.children}</body></html>;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'app', 'docs', '[slug]', 'page.tsx'),
        [
          'import { DocPage } from "@/components/DocPage";',
          'import { docs } from "~/content/docs";',
          'export default function Page(props: { params: { slug: string } }): JSX.Element {',
          '  const doc = docs.get(props.params.slug);',
          '  if (!doc) throw new Error("not found");',
          '  return <DocPage title={doc.title} />;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'app', 'api', 'health', 'route.ts'),
        [
          'export function GET(): Response {',
          '  return Response.json({ ok: true });',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'app', 'opengraph-image.tsx'),
        [
          'import { ImageResponse } from "next/og";',
          'export const size = { width: 1200, height: 630 };',
          'export default function Image(): ImageResponse {',
          '  return new ImageResponse(<div>Docs</div>, size);',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'app', 'docs', '[slug]', 'page.test.tsx'),
        'import { it } from "vitest";\nit("renders the docs slug page", () => {});\n',
      );
      await writeFile(
        join(dir, 'src', 'app', 'api', 'health', 'route.test.ts'),
        'import { it } from "vitest";\nit("returns health", () => {});\n',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:40:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const flows = await readJson<{
        entities: Array<{
          id: string;
          data?: {
            framework?: string;
            route_path?: string;
            route_type?: string;
            kind?: string;
            components?: string[];
            dependencies?: string[];
            files?: string[];
            configs?: string[];
            tests?: string[];
            entry_contract?: string[];
            exit_contract?: string[];
            inputs?: string[];
            outputs?: string[];
            failure_modes?: string[];
            confidence_reasons?: string[];
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      const nextFlows = flows.entities.filter(
        (flow) => flow.data?.framework === 'nextjs-app-router',
      );
      expect(nextFlows).toHaveLength(5);

      const homePage = nextFlows.find(
        (flow) => flow.data?.route_path === '/' && flow.data?.route_type === 'page',
      );
      const docsPage = nextFlows.find(
        (flow) => flow.data?.route_path === '/docs/[slug]' && flow.data?.route_type === 'page',
      );
      const layout = nextFlows.find(
        (flow) => flow.data?.route_path === '/' && flow.data?.route_type === 'layout',
      );
      const apiRoute = nextFlows.find(
        (flow) => flow.data?.route_path === '/api/health' && flow.data?.route_type === 'api',
      );
      const metadataRoute = nextFlows.find(
        (flow) =>
          flow.data?.route_path === '/opengraph-image' && flow.data?.route_type === 'metadata',
      );

      expect(homePage?.data).toMatchObject({
        kind: 'ui',
        components: expect.arrayContaining(['component:src']),
        dependencies: [],
        files: expect.arrayContaining(['src/app/page.tsx', 'src/components/Hero.tsx']),
        configs: expect.arrayContaining(['next.config.ts', 'package.json', 'tsconfig.json']),
        entry_contract: expect.arrayContaining([
          'Next.js app route / from src/app/page.tsx renders a page component.',
        ]),
        outputs: expect.arrayContaining(['Rendered React route output.']),
      });
      expect(docsPage?.data).toMatchObject({
        kind: 'ui',
        components: expect.arrayContaining(['component:src']),
        dependencies: [],
        files: expect.arrayContaining([
          'src/app/docs/[slug]/page.tsx',
          'src/components/DocPage.tsx',
          'src/content/docs.ts',
        ]),
        tests: expect.arrayContaining(['src/app/docs/[slug]/page.test.tsx']),
        inputs: expect.arrayContaining([
          'Next.js route params, search params, children, or render context input.',
          'Source evidence reads request, CLI, parameter, query, body, or environment input.',
        ]),
        failure_modes: expect.arrayContaining([
          'Render can fail when imported components, dynamic route params, or content modules drift.',
          'Source evidence contains explicit error handling paths.',
        ]),
        confidence_reasons: expect.arrayContaining([
          'Next.js app-router file maps to route path /docs/[slug].',
          'Next.js route type is page.',
          'Linked test artifact is recorded.',
        ]),
      });
      expect(layout?.data).toMatchObject({
        route_type: 'layout',
        exit_contract: expect.arrayContaining([
          'Exits by returning a React layout shell for nested route content.',
        ]),
      });
      expect(apiRoute?.data).toMatchObject({
        kind: 'api',
        tests: expect.arrayContaining(['src/app/api/health/route.test.ts']),
        entry_contract: expect.arrayContaining([
          'Next.js app route /api/health from src/app/api/health/route.ts handles HTTP requests with a route handler.',
        ]),
        exit_contract: expect.arrayContaining([
          'Returns an HTTP/API response from the route flow.',
        ]),
        outputs: expect.arrayContaining(['HTTP/API response.']),
      });
      expect(metadataRoute?.data).toMatchObject({
        kind: 'ui',
        route_type: 'metadata',
        dependencies: expect.arrayContaining(['dependency:next--og']),
        entry_contract: expect.arrayContaining([
          'Next.js metadata route /opengraph-image from src/app/opengraph-image.tsx serves a generated metadata asset.',
        ]),
        outputs: expect.arrayContaining(['Generated metadata asset output.']),
      });

      const flowUnderstanding = await readJson<{
        flows_by_kind: Record<string, number>;
        contracts: Array<{
          id: string;
          framework?: string;
          route_path?: string;
          route_type?: string;
          outputs: string[];
          confidence_reasons: string[];
        }>;
      }>(join(result.value.researchDir, 'flow_understanding.json'));
      expect(flowUnderstanding.flows_by_kind.ui).toBeGreaterThanOrEqual(4);
      expect(flowUnderstanding.contracts).toContainEqual(
        expect.objectContaining({
          id: docsPage?.id,
          framework: 'nextjs-app-router',
          route_path: '/docs/[slug]',
          route_type: 'page',
          outputs: expect.arrayContaining(['Rendered React route output.']),
          confidence_reasons: expect.arrayContaining([
            'Next.js app-router file maps to route path /docs/[slug].',
          ]),
        }),
      );

      const evidenceQuality = await readJson<{
        flow_field_evidence: Array<{ id: string; fields: Record<string, number> }>;
        unsafe_sensitive_reference_count: number;
      }>(join(result.value.researchDir, 'evidence_quality.json'));
      expect(evidenceQuality.unsafe_sensitive_reference_count).toBe(0);
      expect(evidenceQuality.flow_field_evidence).toContainEqual(
        expect.objectContaining({
          id: docsPage?.id,
          fields: expect.objectContaining({
            entry_contract: expect.any(Number),
            exit_contract: expect.any(Number),
            inputs: expect.any(Number),
            outputs: expect.any(Number),
            confidence_reasons: expect.any(Number),
          }),
        }),
      );

      expect(docsPage).toBeDefined();
      if (docsPage === undefined) return;

      const architectureReasoning = await readJson<{
        route_architecture: Array<{
          flow_id: string;
          route_path: string;
          route_type: string;
          entrypoints: string[];
          components: string[];
          configs: string[];
          tests: string[];
          assumptions: string[];
          tradeoffs: string[];
          what_breaks: string[];
          evidence_gap_ids: string[];
          confidence: string;
          confidence_score: number;
        }>;
        route_what_breaks: Array<{
          flow_id: string;
          route_path: string;
          impacts: string[];
          tests: string[];
        }>;
        impact_map: {
          summary: {
            route_surfaces: number;
            test_backed_surfaces: number;
            config_backed_surfaces: number;
          };
          entries: Array<{
            impact_id: string;
            surface_type: string;
            entity_id: string;
            route_path?: string;
            route_type?: string;
            affected_flows: string[];
            affected_components: string[];
            affected_tests: string[];
            affected_configs: string[];
            evidence_gap_ids: string[];
            what_breaks: string[];
            reasons: string[];
          }>;
        };
        architecture_assumptions: Array<{
          assumption_id: string;
          entity_id: string;
          assumption: string;
          rules: string[];
          unknowns: string[];
          evidence_ids: string[];
        }>;
        design_pressures: Array<{
          pressure_id: string;
          entity_id: string;
          pressure_type: string;
          pressure: string;
          rules: string[];
        }>;
        review_hints: Array<{
          reason: string;
          affected_routes?: string[];
          affected_flows?: string[];
        }>;
      }>(join(result.value.researchDir, 'architecture_reasoning.json'));
      expect(architectureReasoning.route_architecture).toContainEqual(
        expect.objectContaining({
          flow_id: docsPage.id,
          route_path: '/docs/[slug]',
          route_type: 'page',
          entrypoints: expect.arrayContaining([
            'route: src/app/docs/[slug]/page.tsx#/docs/[slug] -> component:src',
          ]),
          components: expect.arrayContaining(['component:src']),
          configs: expect.arrayContaining(['next.config.ts', 'package.json', 'tsconfig.json']),
          tests: expect.arrayContaining(['src/app/docs/[slug]/page.test.tsx']),
          assumptions: expect.arrayContaining([
            expect.stringContaining('/docs/[slug] is an architecture surface'),
          ]),
          tradeoffs: expect.arrayContaining([
            expect.stringContaining('Framework-native routes make ownership easier'),
          ]),
          what_breaks: expect.arrayContaining([
            expect.stringContaining('Changing the route entrypoint can alter /docs/[slug]'),
          ]),
          evidence_gap_ids: [],
          confidence: 'verified',
          confidence_score: expect.any(Number),
        }),
      );
      expect(architectureReasoning.route_what_breaks).toContainEqual(
        expect.objectContaining({
          flow_id: docsPage.id,
          route_path: '/docs/[slug]',
          impacts: expect.arrayContaining([
            expect.stringContaining('/docs/[slug] page route can stop rendering'),
          ]),
          tests: expect.arrayContaining(['src/app/docs/[slug]/page.test.tsx']),
        }),
      );
      expect(architectureReasoning.impact_map.summary).toMatchObject({
        route_surfaces: expect.any(Number),
        test_backed_surfaces: expect.any(Number),
        config_backed_surfaces: expect.any(Number),
      });
      expect(architectureReasoning.impact_map.entries).toContainEqual(
        expect.objectContaining({
          impact_id: `impact:${docsPage.id}`,
          surface_type: 'route',
          entity_id: docsPage.id,
          route_path: '/docs/[slug]',
          route_type: 'page',
          affected_flows: [docsPage.id],
          affected_components: expect.arrayContaining(['component:src']),
          affected_tests: expect.arrayContaining(['src/app/docs/[slug]/page.test.tsx']),
          affected_configs: expect.arrayContaining(['next.config.ts', 'package.json']),
          evidence_gap_ids: [],
          what_breaks: expect.arrayContaining([
            expect.stringContaining('Changing route /docs/[slug] can alter page rendering'),
          ]),
          reasons: expect.arrayContaining([
            'framework:nextjs-app-router',
            'route_type:page',
            'tests:2',
          ]),
        }),
      );
      expect(architectureReasoning.architecture_assumptions).toContainEqual(
        expect.objectContaining({
          assumption_id: `assumption:${docsPage.id}:route-architecture`,
          entity_id: docsPage.id,
          assumption: expect.stringContaining('Next.js page architecture surface'),
          rules: expect.arrayContaining([
            'framework:nextjs-app-router',
            'route_type:page',
            'tests:2',
          ]),
          evidence_ids: expect.arrayContaining([expect.stringContaining('evidence:file-')]),
          unknowns: [],
          confidence: 'verified',
        }),
      );
      expect(architectureReasoning.design_pressures).toContainEqual(
        expect.objectContaining({
          pressure_id: `pressure:${docsPage.id}:route-entrypoint`,
          entity_id: docsPage.id,
          pressure_type: 'flow',
          pressure: expect.stringContaining('/docs/[slug] is a Next.js page entrypoint'),
          rules: expect.arrayContaining(['framework:nextjs-app-router', 'route_type:page']),
        }),
      );
      expect(architectureReasoning.review_hints).toContainEqual(
        expect.objectContaining({
          reason: 'Next.js app-router surfaces should be reviewed as route-level architecture.',
          affected_routes: expect.arrayContaining(['/docs/[slug]']),
          affected_flows: expect.arrayContaining([docsPage.id]),
        }),
      );
      const architectureText = await readFile(
        join(result.value.researchDir, 'architecture_reasoning.json'),
        'utf8',
      );
      expect(architectureText).not.toContain('.env.local');
      expect(architectureText).not.toContain(dir);

      const explained = await explainProjectTarget({
        rootDir: dir,
        target: docsPage.id,
        now: new Date('2026-06-28T12:41:00.000Z'),
      });
      expect(explained.ok).toBe(true);
      if (!explained.ok) return;
      expect(explained.value.explanation.flow).toMatchObject({
        framework: 'nextjs-app-router',
        route_path: '/docs/[slug]',
        route_type: 'page',
        components: expect.arrayContaining(['component:src']),
        files: expect.arrayContaining([
          'src/app/docs/[slug]/page.tsx',
          'src/components/DocPage.tsx',
          'src/content/docs.ts',
        ]),
        tests: expect.arrayContaining(['src/app/docs/[slug]/page.test.tsx']),
        outputs: expect.arrayContaining(['Rendered React route output.']),
        confidence_reasons: expect.arrayContaining([
          'Next.js app-router file maps to route path /docs/[slug].',
        ]),
      });
      const explainReport = await readFile(join(dir, '.rizz', 'reports', 'explain.html'), 'utf8');
      expect(explainReport).toContain('Next.js app-router file maps to route path /docs/[slug].');
      expect(explainReport).toContain('Rendered React route output.');
      expect(explainReport).not.toContain(dir);

      const missionControlReport = await readFile(
        join(dir, '.rizz', 'reports', 'index.html'),
        'utf8',
      );
      expect(missionControlReport).toContain('<h4>Route Context</h4>');
      expect(missionControlReport).toContain('Framework: nextjs-app-router');
      expect(missionControlReport).toContain('Route path: /docs/[slug]');
      expect(missionControlReport).toContain('Route type: page');
      expect(missionControlReport).toContain(
        'route: src/app/docs/[slug]/page.tsx#/docs/[slug] -&gt; component:src',
      );
      expect(missionControlReport).not.toContain(dir);
      expect(missionControlReport).not.toContain('<script src=');
      expect(missionControlReport).not.toContain('<script>');
      expect(missionControlReport).not.toContain('https://');
      expect(missionControlReport).not.toContain('http://');
    });
  });

  it('reports route-level blast radius for Next.js route flows in review JSON', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src', 'app', 'docs', '[slug]'), { recursive: true });
      await mkdir(join(dir, 'src', 'components'), { recursive: true });
      await mkdir(join(dir, 'src', 'content'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'next-review-app',
          scripts: { test: 'vitest run', typecheck: 'tsc -b' },
          dependencies: { next: '^15.0.0', react: '^19.0.0' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.0.0' },
        }),
      );
      await writeFile(join(dir, 'next.config.ts'), 'export default { typedRoutes: true };\n');
      await writeFile(join(dir, 'tsconfig.json'), '{}\n');
      await writeFile(
        join(dir, 'src', 'components', 'DocPage.tsx'),
        [
          'export function DocPage(props: { title: string }): JSX.Element {',
          '  return <article>{props.title}</article>;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'content', 'docs.ts'),
        [
          'export const docs = new Map<string, { title: string }>([',
          '  ["intro", { title: "Intro" }],',
          ']);',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'app', 'docs', '[slug]', 'page.tsx'),
        [
          'import { DocPage } from "../../../components/DocPage.js";',
          'import { docs } from "../../../content/docs.js";',
          'export default function Page(props: { params: { slug: string } }): JSX.Element {',
          '  const doc = docs.get(props.params.slug);',
          '  if (!doc) throw new Error("not found");',
          '  return <DocPage title={doc.title} />;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'app', 'docs', '[slug]', 'page.test.tsx'),
        'import { it } from "vitest";\nit("renders the docs slug page", () => {});\n',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:50:00.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(
        join(dir, 'next.config.ts'),
        'export default { typedRoutes: true, reactStrictMode: true };\n',
      );
      await writeFile(
        join(dir, 'src', 'components', 'DocPage.tsx'),
        [
          'export function DocPage(props: { title: string }): JSX.Element {',
          '  return <article data-doc>{props.title}</article>;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'content', 'docs.ts'),
        [
          'export const docs = new Map<string, { title: string }>([',
          '  ["intro", { title: "Intro" }],',
          '  ["routing", { title: "Routing" }],',
          ']);',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'app', 'docs', '[slug]', 'page.tsx'),
        [
          'import { DocPage } from "../../../components/DocPage.js";',
          'import { docs } from "../../../content/docs.js";',
          'export default function Page(props: { params: { slug: string } }): JSX.Element {',
          '  const doc = docs.get(props.params.slug);',
          '  if (!doc) throw new Error("not found");',
          '  return <DocPage title={`${doc.title} docs`} />;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'app', 'docs', '[slug]', 'page.test.tsx'),
        'import { it } from "vitest";\nit("renders the docs slug page contract", () => {});\n',
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T12:51:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const docsFlow = result.value.review.affected_flows.find(
        (flow) => flow.route_path === '/docs/[slug]' && flow.route_type === 'page',
      );
      expect(docsFlow).toMatchObject({
        framework: 'nextjs-app-router',
        route_path: '/docs/[slug]',
        route_type: 'page',
        entrypoints: expect.arrayContaining(['src/app/docs/[slug]/page.tsx#/docs/[slug]']),
        changed_files: expect.arrayContaining([
          'next.config.ts',
          'src/app/docs/[slug]/page.tsx',
          'src/app/docs/[slug]/page.test.tsx',
          'src/components/DocPage.tsx',
          'src/content/docs.ts',
        ]),
        tests: expect.arrayContaining(['src/app/docs/[slug]/page.test.tsx']),
        configs: expect.arrayContaining(['next.config.ts', 'package.json', 'tsconfig.json']),
        reasons: expect.arrayContaining([
          'Docs Slug rendering journey (/docs/[slug] page) includes changed component evidence: src/components/DocPage.tsx.',
          'Docs Slug rendering journey (/docs/[slug] page) includes changed config evidence: next.config.ts.',
          'Docs Slug rendering journey (/docs/[slug] page) includes changed content evidence: src/content/docs.ts.',
          'Docs Slug rendering journey (/docs/[slug] page) includes changed entrypoint evidence: src/app/docs/[slug]/page.tsx.',
          'Docs Slug rendering journey (/docs/[slug] page) includes changed test evidence: src/app/docs/[slug]/page.test.tsx.',
        ]),
      });
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('/docs/[slug] route flow (page) is affected'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('changed component evidence: src/components/DocPage.tsx'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('changed content evidence: src/content/docs.ts'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('changed config evidence: next.config.ts'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('changed test evidence: src/app/docs/[slug]/page.test.tsx'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('Linked tests: src/app/docs/[slug]/page.test.tsx'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('Entrypoints: src/app/docs/[slug]/page.tsx#/docs/[slug]'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('Components: component:src'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('architecture impact-map surface(s) overlap the diff'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining(
          'impact:flow:nextjs--page--docs---slug---src--app--docs---slug---page.tsx',
        ),
      );
      expect(result.value.review.architecture_impact_map).toContainEqual(
        expect.objectContaining({
          impact_id: 'impact:flow:nextjs--page--docs---slug---src--app--docs---slug---page.tsx',
          surface_type: 'route',
          route_path: '/docs/[slug]',
          route_type: 'page',
          matched_changed_files: expect.arrayContaining([
            'next.config.ts',
            'src/app/docs/[slug]/page.tsx',
            'src/app/docs/[slug]/page.test.tsx',
            'src/components/DocPage.tsx',
            'src/content/docs.ts',
          ]),
          affected_tests: expect.arrayContaining(['src/app/docs/[slug]/page.test.tsx']),
          affected_configs: expect.arrayContaining(['next.config.ts', 'package.json']),
          what_breaks: expect.arrayContaining([
            expect.stringContaining('Changing route /docs/[slug] can alter page rendering'),
          ]),
          risk_reasoning: expect.objectContaining({
            risk_level: expect.stringMatching(/medium|high/),
            risky_surfaces: expect.arrayContaining(['configuration-backed surface']),
            review_focus: expect.arrayContaining([
              expect.stringContaining('linked test artifact'),
              expect.stringContaining('linked config/dependency artifact'),
            ]),
          }),
          reasons: expect.arrayContaining(['changed_files:5', 'matched_flows:1']),
        }),
      );
      expect(result.value.review.review_evidence_summary).toMatchObject({
        architecture_impact_surfaces: expect.any(Number),
        architecture_what_breaks: expect.arrayContaining([
          expect.stringContaining('Changing route /docs/[slug] can alter page rendering'),
        ]),
        architecture_risk_reasoning: expect.arrayContaining([
          expect.stringContaining(
            'impact:flow:nextjs--page--docs---slug---src--app--docs---slug---page.tsx',
          ),
          expect.stringContaining('linked config/dependency artifact'),
        ]),
        affected_tests: expect.arrayContaining(['src/app/docs/[slug]/page.test.tsx']),
        affected_configs: expect.arrayContaining(['next.config.ts', 'package.json']),
      });
      expect(result.value.reviewEval).toMatchObject({
        architecture_impact_route_surface_count: expect.any(Number),
        architecture_what_breaks_note_count:
          result.value.review.review_evidence_summary.architecture_what_breaks.length,
        architecture_risk_reasoning_count:
          result.value.review.review_evidence_summary.architecture_risk_reasoning.length,
        architecture_evidence_gap_count:
          result.value.review.review_evidence_summary.architecture_evidence_gap_ids.length,
        architecture_confidence_gap_count:
          result.value.review.review_evidence_summary.architecture_confidence_gaps.length,
      });
      expect(result.value.reviewEval.architecture_impact_surface_count).toBeGreaterThan(0);
      expect(result.value.reviewEval.architecture_impact_route_surface_count).toBeGreaterThan(0);
      expect(result.value.reviewEval.architecture_affected_test_count).toBeGreaterThan(0);
      expect(result.value.reviewEval.architecture_affected_config_count).toBeGreaterThan(0);
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Known flows overlap the diff',
          description: expect.stringContaining('Docs Slug rendering journey (/docs/[slug] page)'),
        }),
      );
      expect(result.value.review.suggested_reviewer_focus_areas).toContain(
        'route flow: /docs/[slug]',
      );
      expect(result.value.review.suggested_reviewer_focus_areas).toContain(
        'route flow: /docs/[slug] component evidence',
      );
      expect(result.value.review.suggested_reviewer_focus_areas).toContain(
        'route flow: /docs/[slug] content evidence',
      );
      expect(result.value.review.suggested_reviewer_focus_areas).toContain(
        'route flow: /docs/[slug] config evidence',
      );
      expect(result.value.review.suggested_reviewer_focus_areas).toContain(
        'route flow: /docs/[slug] test evidence',
      );

      const reviewReport = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(reviewReport).toContain('/docs/[slug] route flow (page) is affected');
      expect(reviewReport).toContain(
        'flow:nextjs--page--docs---slug---src--app--docs---slug---page.tsx',
      );
      expect(reviewReport).toContain('src/app/docs/[slug]/page.tsx#/docs/[slug]');
      expect(reviewReport).toContain('/docs/[slug] page');
      expect(reviewReport).not.toContain(dir);

      const missionControlReport = await readFile(
        join(dir, '.rizz', 'reports', 'index.html'),
        'utf8',
      );
      expect(missionControlReport).toContain('<h3>Affected Route Flows</h3>');
      expect(missionControlReport).toContain('/docs/[slug]');
      expect(missionControlReport).toContain('Route type: page');
      expect(missionControlReport).toContain(
        'route: src/app/docs/[slug]/page.tsx#/docs/[slug] -&gt; component:src',
      );
      expect(missionControlReport).toContain(
        'flow:nextjs--page--docs---slug---src--app--docs---slug---page.tsx',
      );
      expect(missionControlReport).not.toContain(dir);
      expect(missionControlReport).not.toContain('<script src=');
      expect(missionControlReport).not.toContain('<script>');
      expect(missionControlReport).not.toContain('https://');
      expect(missionControlReport).not.toContain('http://');
    });
  });

  it('does not count absence-only component heuristics as evidence-backed fields', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'lib'), { recursive: true });
      await writeFile(join(dir, 'lib', 'helper.ts'), 'const helper = 1;\n');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:05:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const componentIntelligence = await readJson<{
        field_coverage_score: number;
        evidence_backed_field_score: number;
        evidence_coverage: Record<string, number>;
        components: Array<{
          id: string;
          field_coverage: Record<string, boolean>;
          field_evidence: Record<string, number>;
        }>;
      }>(join(result.value.researchDir, 'component_intelligence.json'));
      const helperComponent = componentIntelligence.components.find(
        (component) => component.id === 'component:lib',
      );

      expect(helperComponent?.field_coverage).toMatchObject({
        coupling: true,
        tradeoffs: true,
        failure_modes: true,
        known_risks: true,
      });
      expect(helperComponent?.field_evidence.coupling).toBe(0);
      expect(helperComponent?.field_evidence.tradeoffs).toBe(0);
      expect(helperComponent?.field_evidence.failure_modes).toBe(0);
      expect(helperComponent?.field_evidence.known_risks).toBe(0);
      expect(componentIntelligence.evidence_coverage.coupling).toBe(0);
      expect(componentIntelligence.evidence_coverage.tradeoffs).toBe(0);
      expect(componentIntelligence.evidence_coverage.failure_modes).toBe(0);
      expect(componentIntelligence.evidence_coverage.known_risks).toBe(0);
      expect(componentIntelligence.evidence_backed_field_score).toBeLessThan(
        componentIntelligence.field_coverage_score,
      );

      const architectureReasoning = await readJson<{
        architecture_assumptions: Array<{
          assumption_id: string;
          entity_id: string;
          evidence_ids: string[];
          evidence_gap_ids: string[];
          unknowns: string[];
        }>;
        evidence_gaps: Array<{
          gap_id: string;
          entity_id: string;
          gap: string;
          rules: string[];
        }>;
        assumption_confidence: {
          assumption_count: number;
          low_confidence_assumptions: string[];
        };
        unknowns: string[];
      }>(join(result.value.researchDir, 'architecture_reasoning.json'));
      expect(architectureReasoning.unknowns).toEqual(
        expect.arrayContaining([
          'No reconstructed flows are available yet.',
          '1 component(s) are not covered by reconstructed flows yet.',
        ]),
      );
      expect(architectureReasoning.architecture_assumptions).toContainEqual(
        expect.objectContaining({
          assumption_id: 'assumption:component:lib:boundary',
          entity_id: 'component:lib',
          evidence_ids: expect.arrayContaining(['evidence:file-lib--helper.ts']),
          evidence_gap_ids: ['gap:component:lib:flow'],
          unknowns: expect.arrayContaining([
            'No reconstructed flow currently crosses or reaches this boundary.',
          ]),
        }),
      );
      expect(
        architectureReasoning.architecture_assumptions.every(
          (assumption) =>
            assumption.evidence_ids.length > 0 || assumption.evidence_gap_ids.length > 0,
        ),
      ).toBe(true);
      expect(architectureReasoning.evidence_gaps).toContainEqual(
        expect.objectContaining({
          gap_id: 'gap:component:lib:flow',
          entity_id: 'component:lib',
          gap: expect.stringContaining('no reconstructed flow coverage'),
          rules: ['flow_links:0'],
        }),
      );
      expect(architectureReasoning.assumption_confidence).toMatchObject({
        assumption_count: architectureReasoning.architecture_assumptions.length,
        low_confidence_assumptions: expect.arrayContaining(['assumption:component:lib:boundary']),
      });

      const benchmarkReady = await readJson<{
        coverage: {
          component: { total: number; covered: number };
          flow: { total: number; coverage_ratio: number };
          unknown: { total: number; covered: number; coverage_ratio: number };
        };
        readiness: { is_ready: boolean; blocking_gaps: string[] };
        ask_readiness: {
          status: string;
          gates: Array<{ key: string; status: string; score: number; reasons: string[] }>;
          reasons: string[];
          next_required_improvements: string[];
        };
      }>(join(result.value.researchDir, 'benchmark_ready.json'));
      expect(benchmarkReady.coverage.component.total).toBe(1);
      expect(benchmarkReady.coverage.component.covered).toBe(0);
      expect(benchmarkReady.coverage.flow).toMatchObject({ total: 0, coverage_ratio: 0 });
      expect(benchmarkReady.coverage.unknown.total).toBeGreaterThan(0);
      expect(benchmarkReady.coverage.unknown.covered).toBeGreaterThan(0);
      expect(benchmarkReady.coverage.unknown.coverage_ratio).toBeGreaterThan(0);
      expect(benchmarkReady.coverage.unknown.coverage_ratio).toBeLessThan(1);
      expect(benchmarkReady.readiness.is_ready).toBe(false);
      expect(benchmarkReady.readiness.blocking_gaps).toContain(
        'No component has benchmark coverage across boundary, flow, and evidence signals.',
      );
      expect(benchmarkReady.ask_readiness.status).toBe('blocked');
      expect(benchmarkReady.ask_readiness.gates).toContainEqual(
        expect.objectContaining({
          key: 'flow_coverage',
          status: 'blocked',
          score: 0,
        }),
      );
      expect(benchmarkReady.ask_readiness.gates).toContainEqual(
        expect.objectContaining({
          key: 'unknown_coverage',
          status: expect.stringMatching(/limited|blocked/),
        }),
      );
      const evidenceQualityGate = benchmarkReady.ask_readiness.gates.find(
        (gate) => gate.key === 'evidence_quality',
      );
      expect(evidenceQualityGate?.score).toBeLessThan(100);
      expect(evidenceQualityGate?.reasons.join(' ')).toContain('evidence quality');
      expect(benchmarkReady.ask_readiness.reasons.length).toBeGreaterThan(0);
      expect(benchmarkReady.ask_readiness.next_required_improvements.length).toBeGreaterThan(0);
    });
  });

  it('uses import and package evidence for component coupling instead of broad component files', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'core', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({
          name: '@sample/cli',
          dependencies: { '@sample/core': 'workspace:*' },
        }),
      );
      await writeFile(join(dir, 'packages', 'cli', 'README.md'), '# CLI package\n');
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'import { run } from "@sample/core";\nexport const main = run;\n',
      );
      await writeFile(
        join(dir, 'packages', 'core', 'package.json'),
        JSON.stringify({ name: '@sample/core' }),
      );
      await writeFile(join(dir, 'packages', 'core', 'src', 'index.ts'), 'export const run = 1;\n');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:06:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const components = await readJson<{
        entities: Array<{
          id: string;
          data?: { field_evidence?: Record<string, string[]> };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'components.json'));
      const cli = components.entities.find((entity) => entity.id === 'component:packages--cli');
      expect(cli?.data?.field_evidence?.coupling).toEqual([
        'evidence:file-packages--cli--package.json',
        'evidence:file-packages--cli--src--index.ts',
      ]);
      expect(cli?.data?.field_evidence?.coupling).not.toContain(
        'evidence:file-packages--cli--readme.md',
      );

      const evidenceQuality = await readJson<{
        component_field_evidence: Array<{ id: string; fields: { coupling?: number } }>;
      }>(join(result.value.researchDir, 'evidence_quality.json'));
      expect(evidenceQuality.component_field_evidence).toContainEqual(
        expect.objectContaining({
          id: 'component:packages--cli',
          fields: expect.objectContaining({ coupling: 2 }),
        }),
      );
    });
  });

  it('keeps apps workspace package roots separate for file explanations', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'apps', 'api', 'src', 'lib'), { recursive: true });
      await mkdir(join(dir, 'apps', 'admin-portal', 'src'), { recursive: true });
      await mkdir(join(dir, 'apps', 'docgrid-ui-v2', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'shared', 'src'), { recursive: true });
      await mkdir(join(dir, 'stitch-export', 'stitch_npds_trust_platform_ux_system'), {
        recursive: true,
      });
      await mkdir(join(dir, '.sovereign-data', 'models'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'enterprise-content-workflow-platform',
          workspaces: ['apps/*', 'packages/*'],
        }),
      );
      await writeFile(
        join(dir, 'apps', 'api', 'package.json'),
        JSON.stringify({
          name: 'npds-api',
          scripts: {
            build: 'tsc -p tsconfig.json',
            test: 'cd ../.. && vitest run apps/api/src',
          },
          dependencies: { '@npds/shared': '0.1.0', zod: '^3.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'apps', 'api', 'src', 'lib', 'uiV2Contracts.ts'),
        [
          'import { sharedWorkflowId } from "@npds/shared";',
          'export interface WorkflowFormRuntime { workflowId: string; fields: string[] }',
          'export function createWorkflowFormRuntime(fields: string[]): WorkflowFormRuntime {',
          '  return { workflowId: sharedWorkflowId, fields };',
          '}',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'apps', 'api', 'src', 'lib', 'uiV2Contracts.test.ts'),
        'import { createWorkflowFormRuntime } from "./uiV2Contracts";',
      );
      await writeFile(
        join(dir, 'apps', 'admin-portal', 'package.json'),
        JSON.stringify({ name: 'admin-portal', scripts: { build: 'vite build' } }),
      );
      await writeFile(join(dir, 'apps', 'admin-portal', 'src', 'App.tsx'), 'export const App = 1;');
      await writeFile(
        join(dir, 'apps', 'docgrid-ui-v2', 'package.json'),
        JSON.stringify({ name: 'docgrid-ui-v2', scripts: { build: 'vite build' } }),
      );
      await writeFile(
        join(dir, 'apps', 'docgrid-ui-v2', 'src', 'viewerApi.ts'),
        'export const viewerApi = 1;',
      );
      await writeFile(
        join(dir, 'packages', 'shared', 'package.json'),
        JSON.stringify({ name: '@npds/shared' }),
      );
      await writeFile(
        join(dir, 'packages', 'shared', 'src', 'index.ts'),
        'export const sharedWorkflowId = "workflow";',
      );
      await writeFile(
        join(dir, 'stitch-export', 'stitch_npds_trust_platform_ux_system', 'package.json'),
        JSON.stringify({ name: 'stitch-junk' }),
      );
      await writeFile(join(dir, '.sovereign-data', 'models', 'cache.json'), '{}');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:20:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const components = await readJson<{ entities: Array<{ id: string; description: string }> }>(
        join(dir, '.rizz', 'brain', 'entities', 'components.json'),
      );
      const componentIds = components.entities.map((entity) => entity.id);
      expect(componentIds).toEqual(
        expect.arrayContaining([
          'component:apps--admin-portal',
          'component:apps--api',
          'component:apps--docgrid-ui-v2',
          'component:packages--shared',
        ]),
      );
      expect(componentIds).not.toContain('component:apps');
      expect(componentIds).not.toContain('component:stitch-export');
      expect(await readTreeText(join(dir, '.rizz'))).not.toContain('.sovereign-data');

      const explained = await explainProjectTarget({
        rootDir: dir,
        target: 'apps/api/src/lib/uiV2Contracts.ts',
        now: new Date('2026-06-28T10:21:00.000Z'),
      });
      expect(explained.ok).toBe(true);
      if (!explained.ok) return;
      expect(explained.value.explanation).toMatchObject({
        resolved_entity_id: 'file:apps--api--src--lib--uiv2contracts.ts',
        entity_type: 'file',
        related_components: ['component:apps--api'],
        purpose: expect.stringContaining('workflow/form'),
        entry_points: expect.arrayContaining(['apps/api/package.json']),
        tests: expect.arrayContaining(['apps/api/src/lib/uiV2Contracts.test.ts']),
      });
      expect(explained.value.explanation.purpose).toContain('WorkflowFormRuntime');
      expect(explained.value.explanation.purpose).toContain('createWorkflowFormRuntime');
      expect(explained.value.explanation.responsibilities).toEqual(
        expect.arrayContaining([
          expect.stringContaining('WorkflowFormRuntime'),
          expect.stringContaining('static source inspection'),
        ]),
      );
      expect(explained.value.explanation.purpose).not.toContain('admin-portal');
      expect(explained.value.explanation.entry_points).not.toContain(
        'apps/admin-portal/package.json',
      );
    });
  });

  it('enriches components with purpose, interfaces, criticality, dependencies, and removal impact', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({
          name: '@sample/cli',
          scripts: { start: 'node dist/index.js', test: 'vitest run' },
          dependencies: { commander: '^12.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'export function main() { return "ok"; }',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.test.ts'),
        'import { it } from "vitest";',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:31:30.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const components = await readJson<{
        entities: Array<{
          id: string;
          description: string;
          data?: {
            purpose?: string;
            boundary_type?: string;
            responsibilities?: string[];
            interfaces?: string[];
            entry_points?: string[];
            consumers?: string[];
            dependencies?: string[];
            dependency_roles?: string[];
            exposed_apis?: string[];
            tests?: string[];
            configs?: string[];
            coupling?: {
              level?: string;
              score?: number;
              static_import_count?: number;
              internal_imports?: string[];
              external_imports?: string[];
              reasons?: string[];
            };
            criticality?: string;
            criticality_score?: number;
            blast_radius?: string;
            ownership_confidence?: { score?: number; reason?: string; signals?: string[] };
            tradeoffs?: string[];
            failure_modes?: string[];
            what_breaks_if_removed?: string[];
            risky_seams?: string[];
            important_files?: string[];
            read_first?: string[];
            known_risks?: string[];
            unknowns?: string[];
            field_evidence?: Record<string, string[]>;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'components.json'));
      const cli = components.entities.find((entity) => entity.id === 'component:packages--cli');
      expect(cli).toBeDefined();
      expect(cli?.description).toContain('Command-line surface');
      expect(cli?.data).toMatchObject({
        purpose: expect.stringContaining('Command-line surface'),
        boundary_type: 'entrypoint',
        criticality: 'high',
      });
      expect(cli?.data?.coupling).toMatchObject({
        level: 'low',
        score: 0,
        static_import_count: 0,
      });
      expect(cli?.data?.blast_radius).toBe('broad');
      expect(cli?.data?.responsibilities).toContain(
        'Expose user-facing commands and route them to product flows.',
      );
      expect(cli?.data?.interfaces).toEqual(
        expect.arrayContaining(['package: @sample/cli', 'script: start', 'script: test']),
      );
      expect(cli?.data?.entry_points).toEqual(
        expect.arrayContaining([
          'packages/cli/package.json',
          'packages/cli/package.json#start -> node dist/index.js',
          'packages/cli/src/index.ts',
        ]),
      );
      expect(cli?.data?.consumers).toContain('Developers invoking the rizz CLI.');
      expect(cli?.data?.dependencies).toEqual(expect.arrayContaining(['commander', 'vitest']));
      expect(cli?.data?.dependency_roles).toEqual(
        expect.arrayContaining(['runtime dependency: commander', 'test dependency: vitest']),
      );
      expect(cli?.data?.exposed_apis).toContain('module export surface: packages/cli/src/index.ts');
      expect(cli?.data?.tests).toEqual(['packages/cli/src/index.test.ts']);
      expect(cli?.data?.configs).toEqual(['packages/cli/package.json']);
      expect(cli?.data?.criticality_score).toBeGreaterThanOrEqual(7);
      expect(cli?.data?.ownership_confidence?.score).toBeGreaterThanOrEqual(0.8);
      expect(cli?.data?.ownership_confidence?.reason).toContain('Component boundary');
      expect(cli?.data?.tradeoffs?.some((item) => item.includes('entrypoints'))).toBe(true);
      expect(cli?.data?.failure_modes?.some((item) => item.includes('Entrypoints'))).toBe(true);
      expect(cli?.data?.what_breaks_if_removed).toContainEqual(
        expect.stringContaining('likely critical'),
      );
      expect(cli?.data?.risky_seams).toContain(
        'Entrypoint depends on config; command behavior can drift without source changes.',
      );
      expect(cli?.data?.important_files).toEqual(
        expect.arrayContaining(['packages/cli/package.json', 'packages/cli/src/index.ts']),
      );
      expect(cli?.data?.read_first).toEqual(
        expect.arrayContaining(['packages/cli/package.json', 'packages/cli/src/index.ts']),
      );
      expect(cli?.data?.known_risks).toEqual([]);
      expect(cli?.data?.unknowns).toEqual([]);
      expect(cli?.data?.field_evidence).toMatchObject({
        boundary_type: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        purpose: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        dependency_roles: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        dependencies: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        tests: ['evidence:file-packages--cli--src--index.test.ts'],
        configs: ['evidence:file-packages--cli--package.json'],
        coupling: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        exposed_apis: ['evidence:file-packages--cli--src--index.ts'],
        tradeoffs: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        failure_modes: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        risky_seams: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        read_first: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
      });

      const latest = await readJson<{ latest_component_map: Array<Record<string, unknown>> }>(
        result.value.latestPath,
      );
      expect(latest.latest_component_map).toContainEqual(
        expect.objectContaining({
          id: 'component:packages--cli',
          purpose: expect.stringContaining('Command-line surface'),
          boundary_type: 'entrypoint',
          responsibilities: expect.arrayContaining([
            'Expose user-facing commands and route them to product flows.',
          ]),
          dependency_roles: expect.arrayContaining(['runtime dependency: commander']),
          entry_points: expect.arrayContaining(['packages/cli/src/index.ts']),
          criticality: 'high',
          blast_radius: 'broad',
          tradeoffs: expect.arrayContaining([
            'User-facing entrypoints improve reachability but make interface changes riskier.',
          ]),
          failure_modes: expect.arrayContaining([
            'Entrypoints for packages/cli can fail if command, package, or module exports drift.',
          ]),
          what_breaks_if_removed: expect.arrayContaining([
            expect.stringContaining('likely critical'),
          ]),
          important_files: expect.arrayContaining(['packages/cli/package.json']),
          read_first: expect.arrayContaining(['packages/cli/package.json']),
        }),
      );

      const explained = await explainProjectTarget({
        rootDir: dir,
        target: 'packages/cli',
        now: new Date('2026-06-28T10:31:45.000Z'),
      });
      expect(explained.ok).toBe(true);
      if (!explained.ok) return;
      expect(explained.value.explanation.dependency_roles).toContain(
        'runtime dependency: commander',
      );
      expect(
        explained.value.explanation.tradeoffs.some((item) => item.includes('entrypoints')),
      ).toBe(true);
      expect(
        explained.value.explanation.failure_modes.some((item) => item.includes('Entrypoints')),
      ).toBe(true);
      expect(explained.value.explanation.component).toMatchObject({
        boundary_type: 'entrypoint',
        criticality: 'high',
      });

      const research = await readJson<{
        component_understanding_score: number;
        components: Array<{
          id: string;
          boundary_type: string;
          flow_count: number;
          field_coverage: Record<string, boolean>;
        }>;
      }>(join(dir, '.rizz', 'research', 'component_intelligence.json'));
      expect(research.component_understanding_score).toBeGreaterThan(70);
      expect(research.components).toContainEqual(
        expect.objectContaining({
          id: 'component:packages--cli',
          boundary_type: 'entrypoint',
          field_coverage: expect.objectContaining({
            dependency_roles: true,
            tradeoffs: true,
            failure_modes: true,
            read_first: true,
          }),
        }),
      );

      const graph = await readJson<{
        relationships: Array<{ from: string; relation: string; to: string }>;
      }>(join(dir, '.rizz', 'brain', 'graph.json'));
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'component:packages--cli',
          relation: 'owns',
          to: 'file:packages--cli--src--index.ts',
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'component:packages--cli',
          relation: 'depends_on',
          to: 'dependency:commander',
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'test:packages--cli--src--index.test.ts',
          relation: 'tests',
          to: 'component:packages--cli',
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'component:packages--cli',
          relation: 'exposes',
        }),
      );

      const report = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(report).toContain('<title>Mission Control · rizz-brain-test-');
      expect(report).toContain('local project intelligence');
      expect(report).toContain('Static local view generated from <code>.rizz/brain</code>');
      expect(report).toContain('No server. No network. No model call.');
      expect(report).toContain('Flagship Summary');
      expect(report).toContain('Fast local answer to what Rizz understands');
      expect(report).toContain('Understanding Level');
      expect(report).toContain('Evidence Quality Calibration');
      expect(report).toContain('Flow Coverage');
      expect(report).toContain('Architecture Confidence Debt');
      expect(report).toContain('Review Readiness');
      expect(report).toContain('Incremental Changed / Stable');
      expect(report).toContain('Read First Pointers');
      expect(report).toContain('Review Blast Radius');
      expect(report).toContain('Review/Dependency Runtime Impact');
      expect(report).toContain('Dependency Runtime Inspect');
      expect(report).toContain('Benchmark Tasks');
      expect(report).toContain('Unknown Risk');
      expect(report).toContain('Raw Artifacts');
      expect(report).toContain('Evidence Quality Inspect');
      expect(report).toContain('Evidence Quality Artifacts');
      expect(report).toContain('.rizz/research/evidence_quality.json');
      expect(report).toContain('<h2>Start Here</h2>');
      expect(report).toContain('<h3>Entry Points</h3>');
      expect(report).toContain('Responsibilities');
      expect(report).toContain('Coupling');
      expect(report).toContain('If Removed');
      expect(report).toContain('Risky Seams');
      expect(report).toContain('Important Files');
      expect(report).toContain('Evidence');
      expect(report).toContain('Command-line surface');
      expect(report).toContain('data-kind="unknown"');
      expect(report).toContain(
        'No risk records detected yet. This does not mean the project is risk-free.',
      );
      expect(report).toContain('href="#evidence-file-packages--cli--package-json"');
      expect(report).toContain('id="evidence-file-packages--cli--package-json"');
      expect(report).toContain('Explain this: <code>rizz explain packages/cli</code>');
      expect(report).toContain('Explain this: <code>rizz explain packages/cli/package.json</code>');
      expect(report).toContain('Coupling Hotspots');
      expect(report).toContain('Critical Paths');
      expect(report).toContain('Tradeoff Matrix');
      expect(report).toContain('What Breaks');
      expect(report.indexOf('>Components<')).toBeLessThan(report.indexOf('>Flows<'));
      expect(report.indexOf('>Evidence<')).toBeLessThan(report.indexOf('>Unknowns<'));
      expect(report).not.toContain('<script src=');
      expect(report).not.toContain('<script>');
      expect(report).not.toContain('<link rel="stylesheet"');
      expect(report).not.toContain('fetch(');
      expect(report).not.toContain('https://');
      expect(report).not.toContain('http://');
    });
  });

  it('detects deterministic local coupling, risky seams, and architecture reasoning hotspots', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'core', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'providers', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({
          name: '@sample/cli',
          scripts: { start: 'node dist/index.js', test: 'vitest run packages/cli' },
          dependencies: { '@sample/providers': 'workspace:*' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'core', 'package.json'),
        JSON.stringify({ name: '@sample/core' }),
      );
      await writeFile(
        join(dir, 'packages', 'providers', 'package.json'),
        JSON.stringify({ name: '@sample/providers' }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        [
          'import { loop } from "../../core/src/index.js";',
          'import { callModel } from "@sample/providers";',
          'export function main(): string { return `${loop()} ${callModel()}`; }',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.test.ts'),
        'import { it } from "vitest"; it("starts", () => {});\n',
      );
      await writeFile(
        join(dir, 'packages', 'core', 'src', 'index.ts'),
        'export function loop(): string { return "loop"; }\n',
      );
      await writeFile(
        join(dir, 'packages', 'providers', 'src', 'index.ts'),
        'export function callModel(): string { return "local"; }\n',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:10:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const components = await readJson<{
        entities: Array<{
          id: string;
          data?: {
            coupling?: {
              level?: string;
              score?: number;
              static_import_count?: number;
              internal_imports?: string[];
              external_imports?: string[];
            };
            tradeoffs?: string[];
            failure_modes?: string[];
            what_breaks_if_removed?: string[];
            risky_seams?: string[];
            blast_radius?: string;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'components.json'));
      const cli = components.entities.find((entity) => entity.id === 'component:packages--cli');

      expect(cli?.data?.coupling).toMatchObject({
        level: 'medium',
        score: 6,
        static_import_count: 2,
        internal_imports: ['component:packages--core', 'component:packages--providers'],
        external_imports: [],
      });
      expect(cli?.data?.tradeoffs).toContain(
        'Cross-component coupling improves reuse but widens review scope for local changes.',
      );
      expect(cli?.data?.failure_modes).toContain(
        'Static cross-component imports can break when either side changes exports.',
      );
      expect(cli?.data?.what_breaks_if_removed).toContainEqual(
        expect.stringContaining('Cross-component import consumers or callees need review'),
      );
      expect(cli?.data?.risky_seams).toContain(
        'Static imports cross component boundaries; review both sides before changing exports.',
      );
      expect(cli?.data?.blast_radius).toBe('broad');

      const graph = await readJson<{
        relationships: Array<{ from: string; relation: string; to: string }>;
      }>(join(dir, '.rizz', 'brain', 'graph.json'));
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'component:packages--cli',
          relation: 'imports',
          to: 'component:packages--core',
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'component:packages--cli',
          relation: 'imports',
          to: 'component:packages--providers',
        }),
      );

      const reasoning = await readJson<{
        coupling_hotspots: Array<{
          component_id: string;
          coupling_level: string;
          internal_imports: string[];
        }>;
        risky_seams: Array<{ component_id: string; seam: string }>;
        critical_paths: Array<{ component_id: string; blast_radius: string }>;
        tradeoff_matrix: Array<{ component_id: string; coupling_level: string }>;
        what_breaks: Array<{ component_id: string; impacts: string[]; evidence_ids: string[] }>;
        review_hints: Array<{ reason: string; affected_components?: string[] }>;
      }>(join(dir, '.rizz', 'research', 'architecture_reasoning.json'));
      expect(reasoning.coupling_hotspots).toContainEqual(
        expect.objectContaining({
          component_id: 'component:packages--cli',
          coupling_level: 'medium',
          internal_imports: ['component:packages--core', 'component:packages--providers'],
        }),
      );
      expect(reasoning.risky_seams).toContainEqual(
        expect.objectContaining({
          component_id: 'component:packages--cli',
          seam: expect.stringContaining('Static imports cross component boundaries'),
        }),
      );
      expect(reasoning.critical_paths).toContainEqual(
        expect.objectContaining({
          component_id: 'component:packages--cli',
          blast_radius: 'broad',
        }),
      );
      expect(reasoning.tradeoff_matrix).toContainEqual(
        expect.objectContaining({
          component_id: 'component:packages--cli',
          coupling_level: 'medium',
        }),
      );
      expect(reasoning.what_breaks).toContainEqual(
        expect.objectContaining({
          component_id: 'component:packages--cli',
          impacts: expect.arrayContaining([
            expect.stringContaining('Cross-component import consumers or callees need review'),
          ]),
          evidence_ids: expect.arrayContaining(['evidence:file-packages--cli--src--index.ts']),
        }),
      );
      expect(reasoning.review_hints).toContainEqual(
        expect.objectContaining({
          reason: expect.stringContaining('Coupling hotspots'),
          affected_components: expect.arrayContaining(['component:packages--cli']),
        }),
      );

      const report = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(report).toContain('Coupling Hotspots');
      expect(report).toContain('Risky Seams');
      expect(report).toContain('What Can Break');
      expect(report).toContain('What Breaks Summary');
      expect(report).toContain('component:packages--cli: medium (6/10)');
      expect(report).toContain('Static imports cross component boundaries');
      expect(report).toContain('Cross-component import consumers or callees need review');
      expect(report).toContain('href="#evidence-file-packages--cli--src--index-ts"');
      const architectureObject = report.slice(
        report.indexOf('data-object="architecture"'),
        report.indexOf('data-object="review-readiness"'),
      );
      expect(architectureObject).toContain('What Can Break');
      expect(architectureObject).toContain(
        'Cross-component import consumers or callees need review',
      );
      expect(architectureObject).toContain('href="#evidence-file-packages--cli--src--index-ts"');
    });
  });

  it('explains components, files, folders, fuzzy targets, missing targets, and reports', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'packages', 'brain', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run' } }),
      );
      await writeFile(
        join(dir, 'packages', 'brain', 'package.json'),
        JSON.stringify({
          name: '@sample/brain',
          scripts: { build: 'tsc -b', test: 'vitest run packages/brain' },
          dependencies: { zod: '^3.0.0' },
        }),
      );
      await writeFile(join(dir, 'packages', 'brain', 'src', 'index.ts'), 'export const brain = 1;');
      await writeFile(
        join(dir, 'packages', 'brain', 'src', 'index.test.ts'),
        'import { it } from "vitest"; it("works", () => {});',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T11:00:00.000Z'),
      });
      expect(brain.ok).toBe(true);

      const notFoundBeforeReport = await explainProjectTarget({
        rootDir: dir,
        target: 'not-a-real-target',
      });
      expect(notFoundBeforeReport).toMatchObject({
        ok: false,
        error: { code: 'EXPLAIN_TARGET_NOT_FOUND' },
      });
      expect(await fileExists(join(dir, '.rizz', 'reports', 'explain.html'))).toBe(false);

      const component = await explainProjectTarget({
        rootDir: dir,
        target: 'component:packages--brain',
        now: new Date('2026-06-28T11:01:00.000Z'),
      });
      expect(component.ok).toBe(true);
      if (!component.ok) return;
      expect(component.value.explanation).toMatchObject({
        target: 'component:packages--brain',
        resolved_entity_id: 'component:packages--brain',
        entity_type: 'component',
        purpose: expect.stringContaining('Project understanding layer'),
        dependencies: expect.arrayContaining(['zod']),
        entry_points: expect.arrayContaining(['packages/brain/src/index.ts']),
        tests: expect.arrayContaining(['packages/brain/src/index.test.ts']),
        configs: expect.arrayContaining(['packages/brain/package.json']),
        confidence: 'inferred',
      });
      expect(component.value.explanation.evidence_ids).toContain(
        'evidence:file-packages--brain--package.json',
      );
      expect(component.value.explanation.confidence_basis).toContainEqual(
        expect.stringContaining('direct evidence reference'),
      );
      expect(component.value.explanation.evidence_summary).toMatchObject({
        evidence_count: expect.any(Number),
        redacted_evidence_count: 0,
        records: expect.arrayContaining([
          expect.objectContaining({
            id: 'evidence:file-packages--brain--package.json',
            source_files: expect.arrayContaining(['packages/brain/package.json']),
          }),
        ]),
      });
      expect(component.value.explanation.related_flows).toContain('flow:packages--brain--test');
      expect(component.value.explanation.benchmark_task_hints).toContainEqual(
        expect.objectContaining({
          category: 'component-explanation',
          expected_artifact: '.rizz/research/component_intelligence.json',
        }),
      );
      expect(component.value.explanation.research_artifacts).toMatchObject({
        proving: expect.arrayContaining([
          '.rizz/research/benchmark_tasks.json',
          '.rizz/research/component_intelligence.json',
        ]),
        limiting: expect.arrayContaining([
          '.rizz/research/confidence.json',
          '.rizz/research/evidence_quality.json',
        ]),
      });

      const flow = await explainProjectTarget({
        rootDir: dir,
        target: 'flow:packages--brain--test',
        now: new Date('2026-06-28T11:01:30.000Z'),
      });
      expect(flow.ok).toBe(true);
      if (!flow.ok) return;
      expect(flow.value.explanation).toMatchObject({
        target: 'flow:packages--brain--test',
        resolved_entity_id: 'flow:packages--brain--test',
        entity_type: 'flow',
        entry_points: expect.arrayContaining([
          'command: packages/brain/package.json#test -> component:packages--brain',
        ]),
        tests: expect.arrayContaining(['packages/brain/src/index.test.ts']),
        configs: expect.arrayContaining(['packages/brain/package.json']),
        important_files: expect.arrayContaining(['packages/brain/src/index.ts']),
        confidence: 'inferred',
        flow: expect.objectContaining({
          kind: 'test',
          confidence_score: expect.any(Number),
          components: expect.arrayContaining(['component:packages--brain']),
        }),
      });
      expect(flow.value.explanation.flow?.steps).toContainEqual(
        expect.objectContaining({ path: 'packages/brain/src/index.ts' }),
      );
      expect(flow.value.explanation.unknowns).toContainEqual(
        expect.stringContaining('Flow confidence reason:'),
      );
      expect(flow.value.explanation.confidence_basis).toContainEqual(
        expect.stringContaining('field-level evidence reference'),
      );
      expect(flow.value.explanation.evidence_summary.records).toContainEqual(
        expect.objectContaining({
          id: 'evidence:file-packages--brain--package.json',
          source_files: expect.arrayContaining(['packages/brain/package.json']),
        }),
      );
      expect(flow.value.explanation.related_components).toContain('component:packages--brain');
      expect(flow.value.explanation.related_flows).toContain('flow:packages--brain--test');
      expect(flow.value.explanation.benchmark_task_hints).toContainEqual(
        expect.objectContaining({
          category: 'flow-explanation',
          expected_artifact: '.rizz/research/flow_understanding.json',
        }),
      );
      expect(flow.value.explanation.research_artifacts.proving).toEqual(
        expect.arrayContaining([
          '.rizz/research/benchmark_tasks.json',
          '.rizz/research/flow_confidence.json',
          '.rizz/research/flow_coverage.json',
          '.rizz/research/flow_understanding.json',
        ]),
      );
      const flowReport = await readFile(join(dir, '.rizz', 'reports', 'explain.html'), 'utf8');
      expect(flowReport).toContain('Flow Steps');
      expect(flowReport).toContain('flow:packages--brain--test');
      expect(flowReport).toContain('Evidence Summary');
      expect(flowReport).toContain('Benchmark Task Hints');
      expect(flowReport).toContain('.rizz/research/flow_understanding.json');
      expect(flowReport).not.toContain('sk-or-v1-');

      const file = await explainProjectTarget({
        rootDir: dir,
        target: 'packages/brain/src/index.ts',
        now: new Date('2026-06-28T11:02:00.000Z'),
      });
      expect(file.ok).toBe(true);
      if (!file.ok) return;
      expect(file.value.explanation).toMatchObject({
        resolved_entity_id: 'file:packages--brain--src--index.ts',
        entity_type: 'file',
      });
      expect(file.value.explanation.read_first).toContain('packages/brain/src/index.ts');

      const folder = await explainProjectTarget({
        rootDir: dir,
        target: 'packages/brain',
        now: new Date('2026-06-28T11:03:00.000Z'),
      });
      expect(folder.ok).toBe(true);
      if (!folder.ok) return;
      expect(folder.value.explanation.resolved_entity_id).toBe('component:packages--brain');

      const fuzzy = await explainProjectTarget({
        rootDir: dir,
        target: 'brain',
        now: new Date('2026-06-28T11:04:00.000Z'),
      });
      expect(fuzzy.ok).toBe(true);
      if (!fuzzy.ok) return;
      expect(fuzzy.value.explanation.resolved_entity_id).toBe('component:packages--brain');

      const ambiguous = await explainProjectTarget({
        rootDir: dir,
        target: 'index',
      });
      expect(ambiguous).toMatchObject({
        ok: false,
        error: { code: 'EXPLAIN_TARGET_AMBIGUOUS' },
      });
      if (!ambiguous.ok) expect(ambiguous.error.message).toContain('file:packages--brain--src');

      const report = await readFile(join(dir, '.rizz', 'reports', 'explain.html'), 'utf8');
      expect(report).toContain('rizz explain');
      expect(report).toContain('component:packages--brain');
      expect(report).toContain('Component Boundary');
      expect(report).toContain('Boundary type: service');
      expect(report).toContain('Dependency Roles');
      expect(report).toContain('runtime dependency: zod');
      expect(report).toContain('Tradeoffs');
      expect(report).toContain('Failure Modes');
      expect(report).toContain('What Breaks If Changed');
      expect(report).toContain('Evidence');
      expect(report).not.toContain('sk-or-v1-');
    });
  });

  it('fails explain clearly when the project brain is missing', async () => {
    await withTempProject(async (dir) => {
      const result = await explainProjectTarget({ rootDir: dir, target: 'packages/brain' });
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'BRAIN_MISSING',
          message: 'Project brain not found. Run rizz brain, then rerun rizz explain.',
        },
      });
    });
  });

  it('answers the supported ask intents from local brain and research artifacts', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'packages', 'brain', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run' } }),
      );
      await writeFile(
        join(dir, 'packages', 'brain', 'package.json'),
        JSON.stringify({
          name: '@sample/brain',
          scripts: { build: 'tsc -b', test: 'vitest run packages/brain' },
          dependencies: { zod: '^3.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'brain', 'src', 'index.ts'),
        'export function askProjectQuestion(): string { return "local brain"; }\n',
      );
      await writeFile(
        join(dir, 'packages', 'brain', 'src', 'index.test.ts'),
        'import { it } from "vitest"; it("answers locally", () => {});\n',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({
          name: '@sample/cli',
          dependencies: { '@sample/brain': 'workspace:*' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'import { askProjectQuestion } from "@sample/brain"; export const run = askProjectQuestion;\n',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T13:00:00.000Z'),
      });
      expect(brain.ok).toBe(true);
      await setAskReadiness(dir, 'ready');

      const readFirst = await askProjectQuestion({
        rootDir: dir,
        question: 'what should I read first?',
        now: new Date('2026-06-28T13:01:00.000Z'),
      });
      expect(readFirst.ok).toBe(true);
      if (!readFirst.ok) return;
      expect(readFirst.value.answer).toMatchObject({
        intent: 'read_first',
        status: 'answered',
        deterministic: true,
        provider_calls_required: false,
        network_required: false,
      });
      expect(readFirst.value.answer.answer_items.length).toBeGreaterThan(0);
      expect(readFirst.value.answer.research_artifacts).toContain(
        '.rizz/research/benchmark_ready.json',
      );

      const breaks = await askProjectQuestion({
        rootDir: dir,
        question: 'what breaks if packages/brain changes?',
        now: new Date('2026-06-28T13:02:00.000Z'),
      });
      expect(breaks.ok).toBe(true);
      if (!breaks.ok) return;
      expect(breaks.value.answer.intent).toBe('breaks_if_changed');
      expect(breaks.value.answer.answer_items.length).toBeGreaterThan(0);
      expect(breaks.value.answer.related_entities).toContain('component:packages--brain');
      expect(breaks.value.answer.evidence_ids).toContain(
        'evidence:file-packages--brain--package.json',
      );

      const dependents = await askProjectQuestion({
        rootDir: dir,
        question: 'who depends on packages/brain?',
        now: new Date('2026-06-28T13:03:00.000Z'),
      });
      expect(dependents.ok).toBe(true);
      if (!dependents.ok) return;
      expect(dependents.value.answer.intent).toBe('dependents');
      expect(JSON.stringify(dependents.value.answer)).toContain('component:packages--cli');

      const why = await askProjectQuestion({
        rootDir: dir,
        question: 'why does packages/brain exist?',
        now: new Date('2026-06-28T13:04:00.000Z'),
      });
      expect(why.ok).toBe(true);
      if (!why.ok) return;
      expect(why.value.answer.intent).toBe('why_exists');
      expect(why.value.answer.answer_items).toContainEqual(
        expect.stringContaining('Project understanding layer'),
      );

      const evidence = await askProjectQuestion({
        rootDir: dir,
        question: 'what evidence backs packages/brain?',
        now: new Date('2026-06-28T13:05:00.000Z'),
      });
      expect(evidence.ok).toBe(true);
      if (!evidence.ok) return;
      expect(evidence.value.answer.intent).toBe('evidence');
      expect(evidence.value.answer.evidence_summary.records).toContainEqual(
        expect.objectContaining({ id: 'evidence:file-packages--brain--package.json' }),
      );

      const jsonRoundTrip = JSON.parse(JSON.stringify(evidence.value.answer)) as {
        intent: string;
        confidence: string;
        research_artifacts: string[];
      };
      expect(jsonRoundTrip).toMatchObject({
        intent: 'evidence',
        confidence: expect.stringMatching(/verified|inferred|uncertain/),
      });
      expect(jsonRoundTrip.research_artifacts).toContain('.rizz/research/evidence_quality.json');

      const report = await readFile(join(dir, '.rizz', 'reports', 'ask.html'), 'utf8');
      expect(report).toContain('rizz ask');
      expect(report).toContain('local Project Intelligence');
      expect(report).not.toMatch(/\bv1\b/i);
      expect(report).not.toMatch(/\bv2\b/i);
    });
  });

  it('honors blocked and limited ask readiness without hallucinating a broad answer', async () => {
    await withTempProject(async (dir) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(dir, 'index.test.ts'), 'import { it } from "vitest";\n');

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T13:10:00.000Z'),
      });
      expect(brain.ok).toBe(true);

      await setAskReadiness(dir, 'blocked', ['No usable flow coverage is available.']);
      const blocked = await askProjectQuestion({
        rootDir: dir,
        question: 'what should I read first?',
        now: new Date('2026-06-28T13:11:00.000Z'),
      });
      expect(blocked.ok).toBe(true);
      if (!blocked.ok) return;
      expect(blocked.value.answer).toMatchObject({
        status: 'blocked',
        confidence: 'uncertain',
        evidence_ids: [],
      });
      expect(blocked.value.answer.answer).toContain('blocked by readiness gates');
      expect(blocked.value.answer.unknowns).toContain('No usable flow coverage is available.');

      await setAskReadiness(dir, 'limited', ['Some known unknowns lack evidence pointers.']);
      const limited = await askProjectQuestion({
        rootDir: dir,
        question: 'what should I read first?',
        now: new Date('2026-06-28T13:12:00.000Z'),
      });
      expect(limited.ok).toBe(true);
      if (!limited.ok) return;
      expect(limited.value.answer.status).toBe('limited');
      expect(limited.value.answer.readiness.status).toBe('limited');
      expect(limited.value.answer.unknowns).toContain(
        'Some known unknowns lack evidence pointers.',
      );
    });
  });

  it('rejects unsupported broad ask questions before writing a report', async () => {
    await withTempProject(async (dir) => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T13:20:00.000Z'),
      });
      expect(brain.ok).toBe(true);

      const result = await askProjectQuestion({
        rootDir: dir,
        question: 'write a generic chatbot answer about this repository',
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'ASK_UNSUPPORTED_QUESTION' },
      });
      expect(await fileExists(join(dir, '.rizz', 'reports', 'ask.html'))).toBe(false);
    });
  });

  it('redacts secret-like ask targets from JSON output and report', async () => {
    await withTempProject(async (dir) => {
      await writeFile(
        join(dir, 'sk-or-brainsecret0000000000000000.ts'),
        'export const ok = true;\n',
      );
      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T13:30:00.000Z'),
      });
      expect(brain.ok).toBe(true);
      await setAskReadiness(dir, 'ready');

      const result = await askProjectQuestion({
        rootDir: dir,
        question: 'what evidence backs sk-or-brainsecret0000000000000000.ts?',
        now: new Date('2026-06-28T13:31:00.000Z'),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const output = JSON.stringify(result.value.answer);
      expect(output).not.toContain('sk-or-brainsecret');
      expect(output).toContain('redacted:sensitive-file:');
      const report = await readFile(join(dir, '.rizz', 'reports', 'ask.html'), 'utf8');
      expect(report).not.toContain('sk-or-brainsecret');
      expect(report).toContain('redacted:sensitive-file:');
    });
  });

  it('fails explain clearly when required entity stores are missing', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, '.rizz', 'brain'), { recursive: true });
      await writeFile(
        join(dir, '.rizz', 'brain', 'latest.json'),
        JSON.stringify({
          generated_at: '2026-06-28T11:05:00.000Z',
          latest_component_map: [],
        }),
      );
      await writeFile(join(dir, '.rizz', 'brain', 'graph.json'), '{"relationships":[]}');

      const result = await explainProjectTarget({ rootDir: dir, target: 'packages/brain' });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'BRAIN_SCHEMA_INVALID' },
      });
      if (!result.ok) expect(result.error.message).toContain('components.json missing');
    });
  });

  it('redacts secret-like path-derived ids from explain output and report', async () => {
    await withTempProject(async (dir) => {
      await writeFile(
        join(dir, 'sk-or-v1-brainsecret0000000000000000.ts'),
        'export const ok = true;',
      );
      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T11:06:00.000Z'),
      });
      expect(brain.ok).toBe(true);

      const result = await explainProjectTarget({
        rootDir: dir,
        target: 'sk-or-v1-brainsecret0000000000000000.ts',
        now: new Date('2026-06-28T11:07:00.000Z'),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const output = JSON.stringify(result.value.explanation);
      expect(output).not.toContain('sk-or-v1-brainsecret');
      const report = await readFile(join(dir, '.rizz', 'reports', 'explain.html'), 'utf8');
      expect(report).not.toContain('sk-or-v1-brainsecret');
      const research = await readTreeText(join(dir, '.rizz', 'research'));
      expect(research).not.toContain('sk-or-v1-brainsecret');
      expect(research).toContain('redacted:sensitive-file:');
    });
  });

  it('keeps incremental understanding metrics secret-safe for sensitive changed paths', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      const sensitivePath = join(dir, 'src', 'client_secret_incremental.ts');
      await writeFile(sensitivePath, 'export const tokenHandler = "first";\n');
      const first = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T11:08:00.000Z'),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      await writeFile(sensitivePath, 'export const tokenHandler = "second";\n');
      const second = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T11:09:00.000Z'),
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      const incremental = await readJson<{
        previous_brain_fingerprint: string | null;
        current_brain_fingerprint: string;
        changed_file_count: number;
        changed_files: string[];
        changed_entity_count: number;
        stable_entity_count: number;
        evidence_delta: { changed_count: number; changed: string[] };
        changed_entities: Array<{ id: string; name: string }>;
        scan_efficiency_score: number;
        understanding_deltas: {
          changed_surfaces: Array<{ surface_id: string; name: string; surface_type: string }>;
          stable_surfaces: Array<{ surface_id: string; name: string; surface_type: string }>;
        };
      }>(join(second.value.researchDir, 'incremental_update.json'));
      expect(incremental.previous_brain_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(incremental.current_brain_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(incremental.changed_file_count).toBe(1);
      expect(incremental.changed_files).toHaveLength(1);
      expect(incremental.changed_files[0]).toMatch(/^redacted:sensitive-file:/);
      expect(incremental.changed_entity_count).toBeGreaterThan(0);
      expect(incremental.stable_entity_count).toBeGreaterThan(0);
      expect(incremental.evidence_delta.changed_count).toBeGreaterThan(0);
      expect(incremental.evidence_delta.changed).toContainEqual(
        expect.stringMatching(/^evidence:redacted:sensitive-file:/),
      );
      expect(incremental.changed_entities).toContainEqual(
        expect.objectContaining({
          id: expect.stringMatching(/^evidence:redacted:sensitive-file:/),
          name: expect.stringMatching(/^redacted:sensitive-file:/),
        }),
      );
      expect(incremental.understanding_deltas.changed_surfaces).toContainEqual(
        expect.objectContaining({
          surface_id: expect.stringMatching(/^evidence:redacted:sensitive-file:/),
          name: expect.stringMatching(/^redacted:sensitive-file:/),
          surface_type: 'evidence',
        }),
      );
      expect(incremental.scan_efficiency_score).toBeGreaterThan(0);

      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).not.toContain('client_secret_incremental.ts');
      expect(generated).toContain('redacted:sensitive-file:');
    });
  });

  it('redacts secret-like strings from generated brain and report output', async () => {
    await withTempProject(async (dir) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'sample-app',
          scripts: {
            test: 'OPENAI_API_KEY=sk-ant-brainsecret0000000000000000 ghp_token=ghp_brainsecret000000000000000 vitest run --header "Authorization: Bearer brain.secret.token"',
          },
        }),
      );
      await writeFile(
        join(dir, '.env.example'),
        'OPENROUTER_API_KEY=sk-or-v1-brainsecret0000000000000000',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:32:00.000Z'),
      });

      expect(result.ok).toBe(true);
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).not.toContain('sk-ant-brainsecret');
      expect(generated).not.toContain('sk-or-v1-brainsecret');
      expect(generated).not.toContain('ghp_brainsecret');
      expect(generated).not.toContain('Bearer brain.secret.token');
      expect(generated).toContain('[redacted secret]');
    });
  });

  it('skips private env and key files while keeping env examples', async () => {
    await withTempProject(async (dir) => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await writeFile(join(dir, '.env'), 'OPENAI_API_KEY=sk-ant-private0000000000000000');
      await writeFile(
        join(dir, '.env.local'),
        'OPENROUTER_API_KEY=sk-or-v1-private0000000000000000',
      );
      await writeFile(join(dir, 'server.key'), 'private key sentinel');
      await writeFile(join(dir, '.env.example'), 'OPENROUTER_API_KEY=');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:33:00.000Z'),
      });

      expect(result.ok).toBe(true);
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).not.toContain('"relativePath": ".env"');
      expect(generated).not.toContain('.env.local');
      expect(generated).not.toContain('server.key');
      expect(generated).not.toContain('private key sentinel');
      expect(generated).toContain('.env.example');
    });
  });

  it('redacts sensitive path names across brain, research, reports, review, and explain', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, '.aws'), { recursive: true });
      await mkdir(join(dir, 'keys'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'sample-app',
          scripts: {
            test: 'OPENAI_API_KEY=sk-ant-fixturesecret0000000000000000 ghp_token=ghp_fixturesecret000000000000000 vitest run --header "Authorization: Bearer fixture.secret.token"',
          },
        }),
      );
      await writeFile(
        join(dir, 'src', 'client_secret_handler.ts'),
        'export function handleClientSecret(): string { return "ok"; }\n',
      );
      await writeFile(
        join(dir, 'src', 'secret-token-flow.test.ts'),
        'import { expect, it } from "vitest";\nit("works", () => expect(true).toBe(true));\n',
      );
      await writeFile(join(dir, '.env'), 'OPENAI_API_KEY=sk-ant-private0000000000000000');
      await writeFile(
        join(dir, '.env.local'),
        'OPENROUTER_API_KEY=sk-or-v1-private0000000000000000',
      );
      await writeFile(join(dir, '.aws', 'credentials'), 'aws_access_key_id = private');
      await writeFile(join(dir, 'keys', 'server.key'), 'private key sentinel');
      await writeFile(join(dir, '.env.example'), 'OPENROUTER_API_KEY=');

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T11:20:00.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;

      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'src', 'client_secret_handler.ts'),
        'export function handleClientSecret(): string { return "changed"; }\n',
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T11:21:00.000Z'),
      });
      expect(review.ok).toBe(true);
      if (!review.ok) return;

      const explain = await explainProjectTarget({
        rootDir: dir,
        target: 'src/client_secret_handler.ts',
        now: new Date('2026-06-28T11:22:00.000Z'),
      });
      expect(explain.ok).toBe(true);
      if (!explain.ok) return;

      const forbidden = [
        'client_secret_handler.ts',
        'secret-token-flow.test.ts',
        'sk-ant-fixturesecret',
        'ghp_fixturesecret',
        'Bearer fixture.secret.token',
        '.env.local',
        '.aws/credentials',
        'server.key',
        'private key sentinel',
        dir,
      ];
      const expectNoLeaks = (label: string, text: string): void => {
        for (const value of forbidden) {
          expect(text, `${label} leaked ${value}`).not.toContain(value);
        }
      };

      const files = await readTreeFiles(join(dir, '.rizz'));
      for (const label of [
        'brain/latest.json',
        'brain/graph.json',
        'brain/entities/evidence.json',
        'reports/index.html',
        'reports/review.html',
        'reports/explain.html',
      ]) {
        expectNoLeaks(label, files.get(label) ?? '');
      }
      for (const [label, text] of files) {
        if (label.startsWith('brain/entities/') || label.startsWith('research/')) {
          expectNoLeaks(label, text);
        }
      }

      const generated = [...files.values()].join('\n');
      expectNoLeaks('.rizz tree', generated);
      expect(files.get('reports/index.html')).toContain('Flagship Summary');
      expect(files.get('reports/index.html')).toContain('Evidence Quality Calibration');
      expect(files.get('reports/index.html')).toContain('Evidence Actionability');
      expect(files.get('reports/index.html')).toContain('Read First To Improve Confidence');
      expect(files.get('reports/index.html')).toContain('data-object="benchmark-tasks"');
      expect(files.get('reports/index.html')).toContain('href="../research/benchmark_tasks.json"');
      expect(generated).toContain('redacted:sensitive-file:');
      expect(generated).toContain('[redacted secret]');
      expect(generated).toContain('.env.example');
      expect(generated).toContain('Some evidence labels were redacted');
      expect(generated).not.toContain(
        'Configuration artifact detected at redacted:sensitive-file:',
      );

      const architectureReasoning = await readJson<Record<string, unknown>>(
        join(dir, '.rizz', 'research', 'architecture_reasoning.json'),
      );
      const architectureReasoningText = JSON.stringify(architectureReasoning);
      expectNoLeaks('architecture_reasoning.json', architectureReasoningText);
      expect(architectureReasoningText).toContain('redacted:sensitive-file:');

      const architectureReviewClaimEvidence = await readJson<{
        architecture_impact_claim_count: number;
        architecture_impact_claims: Array<{
          confidence: string;
          evidence_ids: string[];
          redacted_evidence_count: number;
        }>;
      }>(join(dir, '.rizz', 'research', 'review_claim_evidence.json'));
      expect(architectureReviewClaimEvidence.architecture_impact_claim_count).toBeGreaterThan(0);
      expect(JSON.stringify(architectureReviewClaimEvidence)).toContain('redacted:sensitive-file:');
      expect(JSON.stringify(architectureReviewClaimEvidence)).not.toContain(
        'client_secret_handler.ts',
      );
      const redactedArchitectureClaim =
        architectureReviewClaimEvidence.architecture_impact_claims.find(
          (claim) => claim.redacted_evidence_count > 0,
        );
      expect(redactedArchitectureClaim).toBeDefined();
      expect(redactedArchitectureClaim?.confidence).not.toBe('verified');
      expect(redactedArchitectureClaim?.evidence_ids).toContainEqual(
        expect.stringMatching(/^evidence:redacted:sensitive-file:[a-f0-9]{12}$/),
      );

      const missionControlReport = files.get('reports/index.html') ?? '';
      expect(missionControlReport).toContain('Architecture Impact Claims');
      expect(missionControlReport).toContain('redacted:sensitive-file:');
      expect(missionControlReport).toContain('href="#evidence-redacted-sensitive-file-');
      expectNoLeaks('reports/index.html architecture claims', missionControlReport);

      const evidence = await readJson<{
        readonly entities: readonly { readonly id: string; readonly confidence: string }[];
      }>(join(dir, '.rizz', 'brain', 'entities', 'evidence.json'));
      const redactedEvidence = evidence.entities.find((entity) =>
        /^evidence:redacted:sensitive-file:[a-f0-9]{12}$/.test(entity.id),
      );
      expect(redactedEvidence).toBeDefined();
      expect(redactedEvidence?.confidence).not.toBe('verified');

      const evidenceQuality = await readJson<Record<string, unknown>>(
        join(dir, '.rizz', 'research', 'evidence_quality.json'),
      );
      expect(evidenceQuality).toMatchObject({
        total_claims: expect.any(Number),
        claims_with_evidence: expect.any(Number),
        claims_without_evidence: expect.any(Number),
        unsupported_claims: expect.any(Number),
        weak_evidence_claims: expect.any(Number),
        evidence_gap_count: expect.any(Number),
        redacted_evidence_count: expect.any(Number),
        verified_claim_count: expect.any(Number),
        inferred_claim_count: expect.any(Number),
        uncertain_claim_count: expect.any(Number),
        evidence_coverage_score: expect.any(Number),
        redaction_safety_score: 100,
        confidence_distribution: expect.any(Object),
        field_coverage_by_entity_type: expect.any(Object),
        confidence_adjustments: expect.any(Object),
        actionability: expect.any(Object),
        unbacked_claim_groups: expect.any(Array),
        low_confidence_claim_areas: expect.any(Array),
        redaction_hidden_evidence: expect.any(Object),
        suggested_read_first: expect.any(Array),
        calibration_summary: expect.any(Object),
        top_evidence_gaps: expect.any(Array),
        top_uncertain_areas: expect.any(Array),
      });
      expect(evidenceQuality.redacted_evidence_count).toBeGreaterThan(0);
      expect(JSON.stringify(evidenceQuality)).not.toContain('client_secret_handler.ts');
      expect(JSON.stringify(evidenceQuality)).not.toContain('OPENAI_API_KEY');
      const actionability = evidenceQuality.actionability as {
        readonly summary?: string;
        readonly unbacked_claim_groups?: readonly unknown[];
        readonly low_confidence_claim_areas?: readonly unknown[];
        readonly redaction_hidden_evidence?: {
          readonly hidden_evidence_count?: number;
          readonly impact?: string;
          readonly confidence_downgrades?: number;
        };
        readonly suggested_read_first?: readonly unknown[];
        readonly calibration_summary?: { readonly summary?: string };
      };
      expect(actionability.summary).toContain('prioritized evidence gap');
      expect(actionability.unbacked_claim_groups?.length).toBeGreaterThan(0);
      expect(actionability.low_confidence_claim_areas?.length).toBeGreaterThan(0);
      expect(actionability.redaction_hidden_evidence).toMatchObject({
        hidden_evidence_count: expect.any(Number),
        impact: 'contained',
        confidence_downgrades: expect.any(Number),
      });
      expect(actionability.redaction_hidden_evidence?.hidden_evidence_count).toBeGreaterThan(0);
      expect(actionability.suggested_read_first?.length).toBeGreaterThan(0);
      expect(actionability.calibration_summary?.summary).toContain('unsupported claim');
      expect(JSON.stringify(actionability)).not.toContain('client_secret_handler.ts');
      expect(JSON.stringify(actionability)).not.toContain('secret-token-flow.test.ts');
      expect(JSON.stringify(actionability)).not.toContain('OPENAI_API_KEY');
      const evidenceCalibration = evidenceQuality.evidence_calibration as {
        readonly redaction_impact?: {
          readonly impact?: string;
          readonly redaction_safety_score?: number;
          readonly redacted_evidence_count?: number;
          readonly redacted_reference_count?: number;
          readonly confidence_downgrades?: number;
        };
        readonly inspect_first?: readonly {
          readonly id?: string;
          readonly inspect_hint?: string;
        }[];
        readonly weak_evidence_areas?: readonly {
          readonly surface?: string;
          readonly reason?: string;
        }[];
      };
      expect(evidenceCalibration.redaction_impact).toMatchObject({
        impact: 'contained',
        redaction_safety_score: 100,
        redacted_evidence_count: expect.any(Number),
        redacted_reference_count: expect.any(Number),
        confidence_downgrades: expect.any(Number),
      });
      expect(evidenceCalibration.redaction_impact?.redacted_evidence_count).toBeGreaterThan(0);
      expect(evidenceCalibration.redaction_impact?.confidence_downgrades).toBeGreaterThan(0);
      expect(evidenceCalibration.inspect_first?.length).toBeGreaterThan(0);
      expect(evidenceCalibration.weak_evidence_areas?.length).toBeGreaterThan(0);
      expect(JSON.stringify(evidenceCalibration)).not.toContain('client_secret_handler.ts');
      expect(JSON.stringify(evidenceCalibration)).not.toContain('OPENAI_API_KEY');
      const understandingScore = await readJson<Record<string, unknown>>(
        join(dir, '.rizz', 'research', 'understanding_score.json'),
      );
      expect(JSON.stringify(understandingScore)).not.toContain('client_secret_handler.ts');
      expect(JSON.stringify(understandingScore)).not.toContain('secret-token-flow.test.ts');
      expect(JSON.stringify(understandingScore)).not.toContain('OPENAI_API_KEY');
      expect(JSON.stringify(understandingScore)).toContain('redacted:sensitive-file:');

      const reasoningTraces = await readJson<{
        traces: Array<{
          entity_id: string;
          evidence_ids: string[];
          redacted_evidence_count: number;
        }>;
      }>(join(dir, '.rizz', 'research', 'reasoning_traces.json'));
      const reasoningTraceText = JSON.stringify(reasoningTraces);
      expect(reasoningTraceText).not.toContain('client_secret_handler.ts');
      expect(reasoningTraceText).not.toContain('secret-token-flow.test.ts');
      expect(reasoningTraceText).toContain('redacted:sensitive-file:');
      expect(reasoningTraces.traces.some((trace) => trace.redacted_evidence_count > 0)).toBe(true);
      expect(reasoningTraces.traces).toContainEqual(
        expect.objectContaining({
          evidence_ids: expect.arrayContaining([
            expect.stringMatching(/^evidence:redacted:sensitive-file:/),
          ]),
        }),
      );

      const benchmarkReady = await readJson<{
        ask_readiness: {
          redaction_safety: {
            status: string;
            redaction_applied: boolean;
            redaction_safety_score: number;
            redacted_evidence_count: number;
            redacted_reference_count: number;
            unsafe_sensitive_reference_count: number;
            output_share_safe: boolean;
          };
          gates: Array<{ key: string; status: string; score: number; reasons: string[] }>;
        };
      }>(join(dir, '.rizz', 'research', 'benchmark_ready.json'));
      expect(JSON.stringify(benchmarkReady)).not.toContain('client_secret_handler.ts');
      expect(JSON.stringify(benchmarkReady)).not.toContain('secret-token-flow.test.ts');
      expect(JSON.stringify(benchmarkReady)).not.toContain('OPENAI_API_KEY');
      expect(benchmarkReady.ask_readiness.redaction_safety).toMatchObject({
        status: 'ready',
        redaction_applied: true,
        redaction_safety_score: 100,
        unsafe_sensitive_reference_count: 0,
        output_share_safe: true,
      });
      expect(
        benchmarkReady.ask_readiness.redaction_safety.redacted_evidence_count +
          benchmarkReady.ask_readiness.redaction_safety.redacted_reference_count,
      ).toBeGreaterThan(0);
      expect(benchmarkReady.ask_readiness.gates).toContainEqual(
        expect.objectContaining({
          key: 'redaction_safety',
          status: 'ready',
          score: 100,
        }),
      );

      const pieAcceptance = await readJson<{
        confidence: {
          redaction_safety: {
            score: number;
            redacted_evidence_count: number;
            redacted_reference_count: number;
            unsafe_sensitive_reference_count: number;
            output_share_safe: boolean;
          };
        };
        dimensions: Array<{ key: string; status: string; score: number }>;
      }>(join(dir, '.rizz', 'research', 'pie_acceptance.json'));
      const pieAcceptanceText = JSON.stringify(pieAcceptance);
      expect(pieAcceptanceText).not.toContain('client_secret_handler.ts');
      expect(pieAcceptanceText).not.toContain('secret-token-flow.test.ts');
      expect(pieAcceptanceText).not.toContain('OPENAI_API_KEY');
      expect(pieAcceptance.confidence.redaction_safety).toMatchObject({
        score: 100,
        unsafe_sensitive_reference_count: 0,
        output_share_safe: true,
      });
      expect(
        pieAcceptance.confidence.redaction_safety.redacted_evidence_count +
          pieAcceptance.confidence.redaction_safety.redacted_reference_count,
      ).toBeGreaterThan(0);
      expect(pieAcceptance.dimensions).toContainEqual(
        expect.objectContaining({
          key: 'secret_safe_reliability',
          status: 'pass',
          score: 100,
        }),
      );

      const benchmarkTasks = await readJson<{
        tasks: Array<{
          evidence_ids: string[];
          redacted_evidence_markers: string[];
          redacted_evidence_count: number;
        }>;
      }>(join(dir, '.rizz', 'research', 'benchmark_tasks.json'));
      const benchmarkTaskText = JSON.stringify(benchmarkTasks);
      expect(benchmarkTaskText).not.toContain('client_secret_handler.ts');
      expect(benchmarkTaskText).not.toContain('secret-token-flow.test.ts');
      expect(benchmarkTaskText).not.toContain('OPENAI_API_KEY');
      expect(benchmarkTasks.tasks).toContainEqual(
        expect.objectContaining({
          redacted_evidence_markers: expect.arrayContaining([
            expect.stringMatching(/^evidence:redacted:sensitive-file:/),
          ]),
        }),
      );
      expect(benchmarkTasks.tasks.some((task) => task.redacted_evidence_count > 0)).toBe(true);

      expect(JSON.stringify(review.value.review)).not.toContain('client_secret_handler.ts');
      expect(review.value.review.changed_files).toContainEqual(
        expect.stringMatching(/^redacted:sensitive-file:/),
      );
      const reviewClaimEvidence = await readJson<{
        redacted_evidence_count: number;
        claims: Array<{ redacted_evidence_count: number; source_files: string[] }>;
        secret_safety: {
          redacted_reference_count: number;
          unsafe_sensitive_reference_count: number;
          output_secret_safe: boolean;
        };
      }>(join(dir, '.rizz', 'research', 'review_claim_evidence.json'));
      expect(JSON.stringify(reviewClaimEvidence)).not.toContain('client_secret_handler.ts');
      expect(JSON.stringify(reviewClaimEvidence)).not.toContain('secret-token-flow.test.ts');
      expect(reviewClaimEvidence.secret_safety).toMatchObject({
        unsafe_sensitive_reference_count: 0,
        output_secret_safe: true,
      });
      expect(reviewClaimEvidence.secret_safety.redacted_reference_count).toBeGreaterThan(0);
      expect(reviewClaimEvidence.redacted_evidence_count).toBeGreaterThan(0);
      expect(
        reviewClaimEvidence.claims.some(
          (claim) =>
            claim.redacted_evidence_count > 0 ||
            claim.source_files.some((file) => file.startsWith('redacted:sensitive-file:')),
        ),
      ).toBe(true);
      expect(JSON.stringify(explain.value.explanation)).not.toContain('client_secret_handler.ts');
      expect(explain.value.explanation.resolved_entity_id).toContain('redacted:sensitive-file:');
    });
  });

  it('skips default local agent, deployment-state, editor, build, binary, and tsbuildinfo noise', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, '.agents', 'handoffs'), { recursive: true });
      await mkdir(join(dir, '.codex'), { recursive: true });
      await mkdir(join(dir, '.vercel'), { recursive: true });
      await mkdir(join(dir, '.vscode'), { recursive: true });
      await mkdir(join(dir, 'dist-pack'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await writeFile(join(dir, 'vercel.json'), JSON.stringify({ version: 2 }));
      await writeFile(join(dir, 'src', 'index.ts'), 'export const ok = true;');
      await writeFile(join(dir, '.agents', 'handoffs', 'handoff.md'), 'local agent memory');
      await writeFile(join(dir, '.codex', 'config.toml'), 'model = "test"');
      await writeFile(join(dir, '.vercel', 'project.json'), '{"projectId":"local-only"}');
      await writeFile(join(dir, '.vscode', 'settings.json'), '{"editor.formatOnSave":true}');
      await writeFile(join(dir, 'dist-pack', 'sample.tgz'), 'packed package');
      await writeFile(join(dir, 'tsconfig.tsbuildinfo'), '{}');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:34:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: { scannedFiles: 3, changedFiles: 3 },
      });
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).toContain('src/index.ts');
      expect(generated).toContain('vercel.json');
      expect(generated).not.toContain('local agent memory');
      expect(generated).not.toContain('.codex/config.toml');
      expect(generated).not.toContain('.vercel/project.json');
      expect(generated).not.toContain('.vscode/settings.json');
      expect(generated).not.toContain('sample.tgz');
      expect(generated).not.toContain('tsconfig.tsbuildinfo');
    });
  });

  it('honors project .rizzignore patterns for user-controlled scan scope', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, 'tmp'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await writeFile(join(dir, '.rizzignore'), 'tmp/\n*.generated.ts\n');
      await writeFile(join(dir, 'src', 'index.ts'), 'export const ok = true;');
      await writeFile(join(dir, 'src', 'client.generated.ts'), 'export const generated = true;');
      await writeFile(join(dir, 'tmp', 'notes.md'), 'scratch');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:35:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: { scannedFiles: 3, changedFiles: 3 },
      });
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).toContain('.rizzignore');
      expect(generated).toContain('src/index.ts');
      expect(generated).not.toContain('client.generated.ts');
      expect(generated).not.toContain('tmp/notes.md');
    });
  });

  it('drops previously known files from active state when they become ignored', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'tmp'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await writeFile(join(dir, 'tmp', 'notes.md'), 'scratch');

      const first = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:36:00.000Z'),
      });
      expect(first).toMatchObject({
        ok: true,
        value: { scannedFiles: 2, staleFiles: 0 },
      });

      await writeFile(join(dir, '.rizzignore'), 'tmp/\n');
      const second = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:37:00.000Z'),
      });
      expect(second).toMatchObject({
        ok: true,
        value: { scannedFiles: 2, staleFiles: 0 },
      });

      const files = await readJson<{ entities: Array<{ name: string; latest_status: string }> }>(
        join(dir, '.rizz', 'brain', 'entities', 'files.json'),
      );
      expect(files.entities).not.toContainEqual(expect.objectContaining({ name: 'tmp/notes.md' }));
      expect(files.entities).not.toContainEqual(
        expect.objectContaining({ latest_status: 'stale' }),
      );
    });
  });

  it('reviews the current git diff and writes evidence-backed review artifacts', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'sample-app',
          scripts: { check: 'vitest run && tsc -b', build: 'tsc -b' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({
          name: '@sample/cli',
          scripts: { check: 'vitest run packages/cli && tsc -b' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'export const answer = 1;\n',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.test.ts'),
        'import { it } from "vitest"; it("checks", () => {});\n',
      );
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:38:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'export const answer = 2;\n',
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:39:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          changedFiles: 1,
          affectedComponents: 1,
          blastRadius: 'moderate',
          recommendedAction: 'investigate',
        },
      });
      if (!result.ok) return;
      expect(result.value.review.changed_files).toEqual(['packages/cli/src/index.ts']);
      expect(result.value.review.affected_components).toContain('component:packages--cli');
      expect(result.value.review.direct_affected_components).toContainEqual(
        expect.objectContaining({
          id: 'component:packages--cli',
          changed_files: ['packages/cli/src/index.ts'],
          tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
          configs: expect.arrayContaining(['packages/cli/package.json']),
        }),
      );
      expect(result.value.review.dependent_components).toEqual([]);
      expect(result.value.review.affected_flows).toContainEqual(
        expect.objectContaining({
          id: 'flow:packages--cli--check',
          changed_files: ['packages/cli/src/index.ts'],
          tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
          configs: expect.arrayContaining(['packages/cli/package.json']),
        }),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('1 changed file(s) map to 1 direct component(s)'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('architecture impact-map surface(s) overlap the diff'),
      );
      expect(result.value.review.architecture_impact_map).toContainEqual(
        expect.objectContaining({
          impact_id: 'impact:component:packages--cli',
          surface_type: 'component',
          entity_id: 'component:packages--cli',
          matched_changed_files: ['packages/cli/src/index.ts'],
          affected_tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
          affected_configs: expect.arrayContaining(['packages/cli/package.json']),
          matched_flows: expect.arrayContaining(['flow:packages--cli--check']),
          what_breaks: expect.arrayContaining([
            expect.stringContaining('component:packages--cli changes can affect'),
          ]),
          risk_reasoning: expect.objectContaining({
            risk_level: 'medium',
            risky_surfaces: expect.arrayContaining([
              'high-criticality surface',
              'configuration-backed surface',
            ]),
            review_focus: expect.arrayContaining([
              expect.stringContaining('Verify 1 reconstructed flow'),
              expect.stringContaining('linked config/dependency artifact'),
            ]),
          }),
          reasons: expect.arrayContaining(['changed_files:1', 'matched_flows:1']),
        }),
      );
      expect(result.value.review.review_evidence_summary).toMatchObject({
        changed_files: 1,
        direct_components: 1,
        dependent_components: 0,
        affected_flows: 1,
        architecture_impact_surfaces: 1,
        architecture_what_breaks: expect.arrayContaining([
          expect.stringContaining('component:packages--cli changes can affect'),
        ]),
        architecture_risk_reasoning: expect.arrayContaining([
          expect.stringContaining('impact:component:packages--cli:medium'),
          expect.stringContaining('linked config/dependency artifact'),
        ]),
        affected_tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
        affected_configs: expect.arrayContaining(['packages/cli/package.json']),
      });
      expect(result.value.review.review_governance).toMatchObject({
        status: 'needs_attention',
        git: expect.objectContaining({ diff_basis: 'working_tree', working_tree_dirty: true }),
        reviewable_changed_files: ['packages/cli/src/index.ts'],
        generated_artifacts: [],
        scope_clusters: ['packages/cli'],
      });
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({ category: 'Missing tests', severity: 'medium' }),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Version-control hygiene needs attention',
          category: 'Correctness',
        }),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Known flows overlap the diff',
          affected_entities: expect.arrayContaining(['flow:packages--cli--check']),
        }),
      );
      expect(result.value.reviewEvalPath).toBe(join(dir, '.rizz', 'research', 'review_eval.json'));
      expect(result.value.reviewClaimEvidencePath).toBe(
        join(dir, '.rizz', 'research', 'review_claim_evidence.json'),
      );
      expect(result.value.reviewEval).toMatchObject({
        schema_version: 1,
        deterministic: true,
        provider_calls_required: false,
        network_required: false,
        review_id: 'review:2026-06-28t10-39-00.000z-git-diff',
        total_findings: result.value.review.findings.length,
        affected_component_count: 1,
        affected_flow_count: 1,
        affected_relationship_count: result.value.review.affected_relationships.length,
        architecture_impact_surface_count: 1,
        architecture_impact_component_surface_count: 1,
        architecture_impact_route_surface_count: 0,
        architecture_what_breaks_note_count:
          result.value.review.review_evidence_summary.architecture_what_breaks.length,
        architecture_risk_reasoning_count:
          result.value.review.review_evidence_summary.architecture_risk_reasoning.length,
        architecture_evidence_gap_count:
          result.value.review.review_evidence_summary.architecture_evidence_gap_ids.length,
        architecture_confidence_gap_count:
          result.value.review.review_evidence_summary.architecture_confidence_gaps.length,
        architecture_affected_test_count: 1,
        architecture_affected_config_count: 1,
        required_test_count: result.value.review.required_tests.length,
        evidence_id_count: result.value.review.review_evidence_summary.evidence_ids.length,
        blast_radius: 'moderate',
        overall_risk: 'medium',
        surgicality_score: result.value.review.surgicality_score,
        blast_radius_actionability_status: expect.stringMatching(/^(strong|partial|weak)$/),
        review_precision_status: expect.stringMatching(/^(strong|partial|weak)$/),
        review_governance_status: 'needs_attention',
        version_control_warning_count: expect.any(Number),
        blast_radius_actionability: {
          changed_file_count: 1,
          affected_journey_count: expect.any(Number),
          affected_journey_step_count: expect.any(Number),
          user_visible_failure_mode_count: expect.any(Number),
          architecture_what_breaks_note_count:
            result.value.review.review_evidence_summary.architecture_what_breaks.length,
          affected_test_count: 1,
        },
        precision_calibration: {
          changed_file_count: 1,
          runtime_source_change_count: 1,
          false_positive_guards: expect.arrayContaining(['state_data_overstatement_guard']),
          false_negative_signals: expect.arrayContaining([
            'affected_flow_context_preserved',
            'test_evidence_preserved',
            'architecture_what_breaks_context_preserved',
          ]),
        },
        review_governance: {
          git: expect.objectContaining({ diff_basis: 'working_tree' }),
          scope_clusters: ['packages/cli'],
        },
        secret_safety: {
          unsafe_sensitive_reference_count: 0,
          output_secret_safe: true,
        },
      });
      expect(result.value.reviewEval.findings_by_severity.medium).toBeGreaterThan(0);
      expect(result.value.reviewEval.findings_by_category['Missing tests']).toBeGreaterThan(0);
      expect(result.value.reviewEval.review_readiness_score).toBeGreaterThanOrEqual(0);
      expect(result.value.reviewEval.review_readiness_score).toBeLessThanOrEqual(100);
      expect(result.value.reviewEval.blast_radius_actionability_score).toBeGreaterThanOrEqual(0);
      expect(result.value.reviewEval.blast_radius_actionability_score).toBeLessThanOrEqual(100);
      expect(result.value.reviewEval.actionable_signal_count).toBeGreaterThan(0);
      expect(result.value.reviewEval.actionability_gap_count).toBeGreaterThanOrEqual(0);
      expect(result.value.reviewEval.review_precision_score).toBeGreaterThanOrEqual(0);
      expect(result.value.reviewEval.review_precision_score).toBeLessThanOrEqual(100);
      expect(result.value.reviewEval.false_positive_guard_count).toBeGreaterThan(0);
      expect(result.value.reviewEval.false_negative_signal_count).toBeGreaterThan(0);
      expect(result.value.reviewEval.precision_gap_count).toBeGreaterThanOrEqual(0);
      expect(result.value.reviewEval.blast_radius_actionability.signals).toEqual(
        expect.arrayContaining([
          expect.stringContaining('architecture what-breaks note'),
          expect.stringContaining('affected test artifact'),
        ]),
      );
      expect(result.value.reviewClaimEvidence).toMatchObject({
        schema_version: 1,
        deterministic: true,
        provider_calls_required: false,
        network_required: false,
        review_id: 'review:2026-06-28t10-39-00.000z-git-diff',
        basis: {
          source: 'pre_change_project_brain_plus_git_diff',
          review_fields: expect.arrayContaining(['architecture_impact_map']),
        },
        changed_files: ['packages/cli/src/index.ts'],
        total_claims:
          result.value.review.blast_radius_reasons.length +
          result.value.review.findings.length +
          result.value.review.affected_flows.length +
          result.value.review.verification_plan.length,
        architecture_impact_claim_count: 1,
        claim_counts: {
          total:
            result.value.review.blast_radius_reasons.length +
            result.value.review.findings.length +
            result.value.review.affected_flows.length +
            result.value.review.verification_plan.length +
            1,
          architecture_impact_claims: 1,
        },
        secret_safety: {
          unsafe_sensitive_reference_count: 0,
          output_secret_safe: true,
        },
        blast_radius_actionability: {
          score: result.value.reviewEval.blast_radius_actionability_score,
          status: result.value.reviewEval.blast_radius_actionability_status,
        },
      });
      expect(result.value.reviewClaimEvidence.claims_by_surface).toMatchObject({
        blast_radius_reason: result.value.review.blast_radius_reasons.length,
        finding: result.value.review.findings.length,
        affected_flow: result.value.review.affected_flows.length,
        verification_plan: result.value.review.verification_plan.length,
      });
      expect(result.value.reviewClaimEvidence.claims).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            surface: 'blast_radius_reason',
            confidence: expect.any(String),
            rules: expect.arrayContaining([expect.stringContaining('blast_radius')]),
          }),
          expect.objectContaining({
            surface: 'finding',
            evidence_ids: expect.any(Array),
            source_files: expect.any(Array),
          }),
          expect.objectContaining({
            surface: 'affected_flow',
            affected_entities: expect.arrayContaining(['flow:packages--cli--check']),
          }),
          expect.objectContaining({
            surface: 'verification_plan',
            rules: expect.arrayContaining([expect.stringContaining('verification_plan')]),
          }),
        ]),
      );
      expect(result.value.reviewClaimEvidence.architecture_impact_claims).toContainEqual(
        expect.objectContaining({
          impact_id: 'impact:component:packages--cli',
          surface_type: 'component',
          confidence: expect.any(String),
          source_files: expect.arrayContaining(['packages/cli/src/index.ts']),
          affected_entities: expect.arrayContaining([
            'component:packages--cli',
            'flow:packages--cli--check',
          ]),
          matched_flows: expect.arrayContaining(['flow:packages--cli--check']),
          affected_tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
          affected_configs: expect.arrayContaining(['packages/cli/package.json']),
          what_breaks: expect.arrayContaining([
            expect.stringContaining('component:packages--cli changes can affect'),
          ]),
          review_focus: expect.arrayContaining([
            expect.stringContaining('Verify 1 reconstructed flow'),
          ]),
          rules: expect.arrayContaining([
            'architecture_impact_map',
            'surface:component',
            expect.stringContaining('coupling:'),
            expect.stringContaining('risk:'),
          ]),
          redacted_evidence_count: expect.any(Number),
        }),
      );
      for (const claim of result.value.reviewClaimEvidence.claims) {
        expect(claim.claim_id).toEqual(expect.any(String));
        expect(claim.surface).toEqual(expect.any(String));
        expect(claim.claim).toEqual(expect.any(String));
        expect(claim.confidence).toEqual(expect.any(String));
        expect(claim.evidence_ids).toEqual(expect.any(Array));
        expect(claim.source_files).toEqual(expect.any(Array));
        expect(claim.affected_entities).toEqual(expect.any(Array));
        expect(claim.rules).toEqual(expect.any(Array));
        expect(claim.unknowns).toEqual(expect.any(Array));
        expect(claim.redacted_evidence_count).toEqual(expect.any(Number));
      }

      const reviews = await readJson<{
        entities: Array<{ id: string; data?: { overall_risk?: string } }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'reviews.json'));
      expect(reviews.entities).toContainEqual(
        expect.objectContaining({
          id: 'review:2026-06-28t10-39-00.000z-git-diff',
          data: expect.objectContaining({ overall_risk: 'medium' }),
        }),
      );
      const latest = await readJson<{
        latest_review_status: {
          readonly status?: string;
          readonly findings?: number;
          readonly direct_affected_components?: string[];
          readonly dependent_components?: string[];
          readonly affected_flows?: string[];
          readonly architecture_impact_surfaces?: string[];
          readonly architecture_impact_claim_count?: number;
          readonly architecture_impact_claims?: Array<{
            readonly impact_id?: string;
            readonly source_files?: string[];
            readonly what_breaks?: string[];
          }>;
          readonly blast_radius_reasons?: string[];
          readonly research_artifacts?: {
            readonly review_eval?: string;
            readonly review_claim_evidence?: string;
          };
          readonly review_governance?: {
            readonly status?: string;
            readonly scope_clusters?: string[];
          };
        };
        latest_research_artifacts?: {
          readonly review_eval?: string;
          readonly review_claim_evidence?: string;
        };
      }>(join(dir, '.rizz', 'brain', 'latest.json'));
      expect(latest.latest_review_status).toMatchObject({
        status: 'investigate',
        direct_affected_components: ['component:packages--cli'],
        dependent_components: [],
        affected_flows: ['flow:packages--cli--check'],
        architecture_impact_surfaces: ['impact:component:packages--cli'],
        architecture_impact_claim_count: 1,
        architecture_impact_claims: [
          expect.objectContaining({
            impact_id: 'impact:component:packages--cli',
            source_files: expect.arrayContaining(['packages/cli/src/index.ts']),
            what_breaks: expect.arrayContaining([
              expect.stringContaining('component:packages--cli changes can affect'),
            ]),
          }),
        ],
        review_governance: {
          status: 'needs_attention',
          scope_clusters: ['packages/cli'],
        },
        research_artifacts: {
          review_eval: '.rizz/research/review_eval.json',
          review_claim_evidence: '.rizz/research/review_claim_evidence.json',
        },
      });
      expect(latest.latest_research_artifacts).toMatchObject({
        review_eval: '.rizz/research/review_eval.json',
        review_claim_evidence: '.rizz/research/review_claim_evidence.json',
      });
      expect(latest.latest_review_status.blast_radius_reasons).toContainEqual(
        expect.stringContaining('affected flow(s) link the change'),
      );
      expect(Number(latest.latest_review_status.findings)).toBeGreaterThanOrEqual(1);
      const reviewEval = await readJson<{
        total_findings: number;
        findings_by_severity: { medium: number };
        findings_by_category: { 'Missing tests': number; 'Hidden coupling': number };
        affected_component_count: number;
        affected_flow_count: number;
        affected_relationship_count: number;
        architecture_impact_surface_count: number;
        architecture_impact_component_surface_count: number;
        architecture_impact_route_surface_count: number;
        architecture_what_breaks_note_count: number;
        architecture_risk_reasoning_count: number;
        architecture_evidence_gap_count: number;
        architecture_confidence_gap_count: number;
        architecture_affected_test_count: number;
        architecture_affected_config_count: number;
        required_test_count: number;
        evidence_id_count: number;
        blast_radius: string;
        overall_risk: string;
        surgicality_score: number;
        review_readiness_score: number;
        review_governance_score: number;
        review_governance_status: string;
        secret_safety: {
          redaction_applied: boolean;
          redacted_reference_count: number;
          unsafe_sensitive_reference_count: number;
          output_secret_safe: boolean;
        };
      }>(join(dir, '.rizz', 'research', 'review_eval.json'));
      expect(reviewEval).toMatchObject({
        total_findings: result.value.review.findings.length,
        affected_component_count: 1,
        affected_flow_count: 1,
        affected_relationship_count: result.value.review.affected_relationships.length,
        architecture_impact_surface_count: 1,
        architecture_impact_component_surface_count: 1,
        architecture_impact_route_surface_count: 0,
        architecture_what_breaks_note_count:
          result.value.review.review_evidence_summary.architecture_what_breaks.length,
        architecture_risk_reasoning_count:
          result.value.review.review_evidence_summary.architecture_risk_reasoning.length,
        architecture_evidence_gap_count:
          result.value.review.review_evidence_summary.architecture_evidence_gap_ids.length,
        architecture_confidence_gap_count:
          result.value.review.review_evidence_summary.architecture_confidence_gaps.length,
        architecture_affected_test_count: 1,
        architecture_affected_config_count: 1,
        required_test_count: result.value.review.required_tests.length,
        evidence_id_count: result.value.review.review_evidence_summary.evidence_ids.length,
        blast_radius: 'moderate',
        overall_risk: 'medium',
        surgicality_score: result.value.review.surgicality_score,
        review_governance_score: result.value.review.review_governance.score,
        review_governance_status: 'needs_attention',
        secret_safety: {
          unsafe_sensitive_reference_count: 0,
          output_secret_safe: true,
        },
      });
      expect(reviewEval.findings_by_severity.medium).toBeGreaterThan(0);
      expect(reviewEval.findings_by_category['Missing tests']).toBeGreaterThan(0);
      expect(reviewEval.findings_by_category['Hidden coupling']).toBeGreaterThan(0);
      expect(reviewEval.review_readiness_score).toBe(
        result.value.reviewEval.review_readiness_score,
      );
      const reviewClaimEvidence = await readJson<{
        review_id: string;
        basis: { source: string; review_fields: string[] };
        changed_files: string[];
        total_claims: number;
        architecture_impact_claim_count: number;
        claim_counts: {
          total: number;
          generic_claims: number;
          architecture_impact_claims: number;
          with_evidence: number;
          without_evidence: number;
        };
        claims_by_surface: {
          blast_radius_reason: number;
          finding: number;
          affected_flow: number;
          verification_plan: number;
        };
        claims: Array<{
          claim_id: string;
          surface: string;
          claim: string;
          confidence: string;
          evidence_ids: string[];
          source_files: string[];
          affected_entities: string[];
          rules: string[];
          unknowns: string[];
          redacted_evidence_count: number;
        }>;
        architecture_impact_claims: Array<{
          impact_id: string;
          source_files: string[];
          affected_entities: string[];
          what_breaks: string[];
          rules: string[];
        }>;
        secret_safety: {
          unsafe_sensitive_reference_count: number;
          output_secret_safe: boolean;
        };
      }>(join(dir, '.rizz', 'research', 'review_claim_evidence.json'));
      expect(reviewClaimEvidence.review_id).toBe(result.value.review.id);
      expect(reviewClaimEvidence.basis).toMatchObject({
        source: 'pre_change_project_brain_plus_git_diff',
        review_fields: expect.arrayContaining(['architecture_impact_map']),
      });
      expect(reviewClaimEvidence.changed_files).toEqual(['packages/cli/src/index.ts']);
      expect(reviewClaimEvidence.total_claims).toBe(result.value.reviewClaimEvidence.total_claims);
      expect(reviewClaimEvidence.architecture_impact_claim_count).toBe(1);
      expect(reviewClaimEvidence.claim_counts).toMatchObject({
        total:
          reviewClaimEvidence.total_claims + reviewClaimEvidence.architecture_impact_claim_count,
        generic_claims: reviewClaimEvidence.total_claims,
        architecture_impact_claims: 1,
      });
      expect(reviewClaimEvidence.claims_by_surface).toMatchObject(
        result.value.reviewClaimEvidence.claims_by_surface,
      );
      expect(reviewClaimEvidence.claims.length).toBe(
        result.value.reviewClaimEvidence.claims.length,
      );
      expect(reviewClaimEvidence.secret_safety).toMatchObject({
        unsafe_sensitive_reference_count: 0,
        output_secret_safe: true,
      });
      expect(reviewClaimEvidence.architecture_impact_claims).toContainEqual(
        expect.objectContaining({
          impact_id: 'impact:component:packages--cli',
          source_files: expect.arrayContaining(['packages/cli/src/index.ts']),
          affected_entities: expect.arrayContaining(['component:packages--cli']),
          what_breaks: expect.arrayContaining([
            expect.stringContaining('component:packages--cli changes can affect'),
          ]),
          rules: expect.arrayContaining(['architecture_impact_map']),
        }),
      );
      const index = await readJson<{
        research_paths?: { review_eval?: string; review_claim_evidence?: string };
      }>(join(dir, '.rizz', 'brain', 'index.json'));
      expect(index.research_paths).toMatchObject({
        review_eval: '.rizz/research/review_eval.json',
        review_claim_evidence: '.rizz/research/review_claim_evidence.json',
      });
      const report = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(report).toContain('rizz review');
      expect(report).toContain('Blast Radius Evidence');
      expect(report).toContain('Direct Components');
      expect(report).toContain('Dependent Components');
      expect(report).toContain('Affected Flows');
      expect(report).toContain('Architecture Impact Evidence');
      expect(report).toContain(
        'Based on the pre-change Project Intelligence Layer plus the current git diff',
      );
      expect(report).toContain('impact:component:packages--cli');
      expect(report).toContain('component:packages--cli changes can affect');
      expect(report).toContain('flow:packages--cli--check');
      expect(report).toContain('packages/cli/package.json');
      expect(report).toContain('Missing tests');
      expect(report).toContain('Review Governance');
      expect(report).toContain('Version-Control Warnings');
      expect(report).toContain('review_claim_evidence.json');
      const missionControl = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(missionControl).toContain('Architecture Impact Claims');
      expect(missionControl).toContain(
        'Basis: pre-change Project Intelligence Layer plus current git diff',
      );
      expect(missionControl).toContain('impact:component:packages--cli');
      expect(missionControl).toContain('packages/cli/src/index.ts');
      expect(missionControl).toContain('component:packages--cli changes can affect');
      expect(missionControl).toContain('review_claim_evidence.json');
    });
  });

  it('reports review governance for scope drift and repeated changed code', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'api', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'web', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(dir, 'README.md'), '# sample\n');
      await writeFile(join(dir, 'packages', 'api', 'src', 'auth.ts'), 'export const api = 1;\n');
      await writeFile(join(dir, 'packages', 'web', 'src', 'auth.ts'), 'export const web = 1;\n');
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:48:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      const repeatedLine = 'export function duplicatedGuard() { return "same behavior"; }\n';
      await writeFile(join(dir, 'packages', 'api', 'src', 'auth.ts'), repeatedLine);
      await writeFile(join(dir, 'packages', 'web', 'src', 'auth.ts'), repeatedLine);
      await writeFile(join(dir, 'README.md'), '# sample\n\nChanged behavior docs.\n');
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run', check: 'tsc -b' } }),
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:49:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.review.review_governance).toMatchObject({
        status: 'needs_attention',
        git: expect.objectContaining({ diff_basis: 'working_tree', working_tree_dirty: true }),
        scope_clusters: expect.arrayContaining(['packages/api', 'packages/web', 'root']),
      });
      expect(result.value.review.review_governance.scope_drift_signals).toContainEqual(
        expect.stringContaining('Source, docs, and config/package files changed together'),
      );
      expect(result.value.review.review_governance.duplicate_change_signals).toContainEqual(
        expect.stringContaining('Repeated changed line across 2 file(s)'),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({ title: 'Diff may include extra mission scope' }),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Repeated changed code may be duplicate implementation work',
        }),
      );
      const report = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(report).toContain('Review Governance');
      expect(report).toContain('Possible Duplication');
    });
  });

  it('compares review diffs against a deterministic mission contract', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'mission-match', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(dir, 'packages', 'cli', 'src', 'index.ts'), 'export const cli = 1;\n');
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:51:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(join(dir, 'packages', 'cli', 'src', 'index.ts'), 'export const cli = 2;\n');

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:52:00.000Z'),
        mission: JSON.stringify({
          id: 'cli-review',
          summary: 'Keep review governance changes inside the CLI package.',
          target_branch: 'origin/develop',
          allowed_path_prefixes: ['packages/cli'],
          expected_scope_clusters: ['packages/cli'],
          expected_components: ['component:packages--cli'],
          max_reviewable_files: 1,
        }),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.review.review_governance.mission_contract).toMatchObject({
        status: 'matched',
        score: 100,
        source: 'inline',
        contract_id: 'cli-review',
        compared_fields: expect.arrayContaining([
          'allowed_path_prefixes',
          'expected_scope_clusters',
          'expected_components',
          'max_reviewable_files',
          'target_branch',
        ]),
        matched_paths: ['packages/cli/src/index.ts'],
        violating_paths: [],
      });
      expect(result.value.review.findings).not.toContainEqual(
        expect.objectContaining({
          description: expect.stringContaining('Mission contract:'),
        }),
      );
      const report = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(report).toContain('Mission Contract');
      expect(report).toContain('Diff matches the deterministic mission contract boundaries.');
    });
  });

  it('normalizes plain-text mission contracts into deterministic review scope', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'mission-text', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(dir, 'packages', 'cli', 'src', 'index.ts'), 'export const cli = 1;\n');
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:52:30.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(join(dir, 'packages', 'cli', 'src', 'index.ts'), 'export const cli = 2;\n');

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:52:45.000Z'),
        mission: [
          'Keep the CLI review change tight.',
          'allowed paths: packages/cli',
          'scope clusters: packages/cli',
          'components: component:packages--cli',
          'checks: pnpm check, pnpm pack:check',
          'max files: 1',
        ].join('\n'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.review.review_governance.mission_contract).toMatchObject({
        status: 'matched',
        source: 'inline',
        matched_paths: ['packages/cli/src/index.ts'],
        violating_paths: [],
        required_checks: ['pnpm check', 'pnpm pack:check'],
        normalization_notes: expect.arrayContaining([
          'Parsed plain-text mission contract sections.',
          'Normalized allowed_paths to allowed_path_prefixes.',
          'Normalized expectedScopes to expected_scope_clusters.',
          'Normalized components to expected_components.',
          'Normalized checks to required_checks.',
          'Normalized max_files to max_reviewable_files.',
        ]),
      });
      const report = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(report).toContain('Normalization: Parsed plain-text mission contract sections.');
    });
  });

  it('flags mission-contract mismatches as review governance findings', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'api', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'web', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'mission-mismatch', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(dir, 'packages', 'api', 'src', 'index.ts'), 'export const api = 1;\n');
      await writeFile(join(dir, 'packages', 'web', 'src', 'index.ts'), 'export const web = 1;\n');
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:53:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(join(dir, 'packages', 'api', 'src', 'index.ts'), 'export const api = 2;\n');
      await writeFile(join(dir, 'packages', 'web', 'src', 'index.ts'), 'export const web = 2;\n');

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:54:00.000Z'),
        mission: JSON.stringify({
          id: 'api-only',
          summary: 'Only the API package should change.',
          allowed_path_prefixes: ['packages/api'],
          expected_scope_clusters: ['packages/api'],
          forbidden_path_prefixes: ['packages/web'],
          max_scope_clusters: 1,
        }),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.review.review_governance).toMatchObject({
        status: 'needs_attention',
        mission_contract: {
          status: 'mismatch',
          source: 'inline',
          contract_id: 'api-only',
          matched_paths: ['packages/api/src/index.ts'],
          violating_paths: ['packages/web/src/index.ts'],
          forbidden_paths: ['packages/web/src/index.ts'],
          unexpected_scope_clusters: ['packages/web'],
        },
      });
      expect(result.value.review.review_governance.agent_next_actions).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Move or justify out-of-mission file: packages/web/src/index.ts'),
        ]),
      );
      expect(result.value.review.review_governance.scope_drift_signals).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'Mission contract: Move or justify out-of-mission file: packages/web/src/index.ts',
          ),
        ]),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Diff may include extra mission scope',
          category: 'Overengineering',
          affected_files: expect.arrayContaining([
            'packages/api/src/index.ts',
            'packages/web/src/index.ts',
          ]),
        }),
      );
      const report = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(report).toContain('Out-of-mission path: packages/web/src/index.ts');
      expect(report).toContain('Forbidden path: packages/web/src/index.ts');
    });
  });

  it('detects structurally duplicated changed function blocks across files', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'api', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'web', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'normalized-duplicate', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(dir, 'packages', 'api', 'src', 'guard.ts'), 'export const api = 1;\n');
      await writeFile(join(dir, 'packages', 'web', 'src', 'guard.ts'), 'export const web = 1;\n');
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:54:30.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(
        join(dir, 'packages', 'api', 'src', 'guard.ts'),
        [
          'export function ensureApiUser(request: ApiRequest) {',
          '  const current = request.user;',
          '  if (!current) {',
          '    throw new Error("missing user");',
          '  }',
          '  return current.id;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'packages', 'web', 'src', 'guard.ts'),
        [
          'export function ensureWebAccount(context: WebContext) {',
          '  const account = context.account;',
          '  if (!account) {',
          '    throw new Error("missing account");',
          '  }',
          '  return account.id;',
          '}',
          '',
        ].join('\n'),
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:54:45.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.review.review_governance.duplicate_change_signals).toContainEqual(
        expect.stringContaining('Repeated normalized function block across 2 file(s)'),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Repeated changed code may be duplicate implementation work',
        }),
      );
    });
  });

  it('reviews service changes with affected service blast radius evidence', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src', 'orders'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'service-review-app',
          scripts: { test: 'vitest run' },
          dependencies: { express: '^5.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'src', 'server.ts'),
        [
          'import express from "express";',
          'import { createOrder } from "./orders/service.js";',
          '',
          'const app = express();',
          'app.post("/orders", (_req, res) => res.json(createOrder({})));',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'orders', 'service.ts'),
        [
          'export function createOrder(input: unknown): { id: string; input: unknown; region: string } {',
          '  if (input === undefined) throw new Error("missing input");',
          '  const region = process.env.ORDER_REGION ?? "us";',
          '  return { id: "order-1", input, region };',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'orders', 'service.test.ts'),
        'import { it } from "vitest"; it("covers orders service", () => {});\n',
      );
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T13:00:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(
        join(dir, 'src', 'orders', 'service.ts'),
        [
          'export function createOrder(input: unknown): { id: string; input: unknown; region: string } {',
          '  if (input === undefined) throw new Error("missing input");',
          '  const region = process.env.ORDER_REGION ?? "eu";',
          '  return { id: "order-2", input, region };',
          '}',
          '',
        ].join('\n'),
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T13:01:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.review.changed_files).toEqual(['src/orders/service.ts']);
      expect(result.value.review.affected_services).toContainEqual(
        expect.objectContaining({
          id: 'service:src--orders',
          changed_files: ['src/orders/service.ts'],
          affected_flows: expect.arrayContaining(['flow:http--post--orders--src--server.ts']),
          tests: expect.arrayContaining(['src/orders/service.test.ts']),
          evidence_ids: expect.arrayContaining(['evidence:file-src--orders--service.ts']),
        }),
      );
      expect(result.value.review.affected_flows).toContainEqual(
        expect.objectContaining({
          id: 'flow:http--post--orders--src--server.ts',
          journey_name: 'Checkout payment journey',
          journey_confidence: expect.any(String),
          affected_steps: expect.arrayContaining([
            expect.objectContaining({
              type: expect.stringMatching(/business_logic|validation_auth|read_write_storage/),
              files: expect.arrayContaining(['src/orders/service.ts']),
            }),
          ]),
          user_visible_failure_modes: expect.arrayContaining([
            expect.stringContaining('Checkout payment journey'),
          ]),
          runtime_surfaces: expect.arrayContaining(['flow kind:api']),
          changed_files: ['src/orders/service.ts'],
          services: expect.arrayContaining(['service:src--orders']),
          service_causality: expect.arrayContaining([
            expect.objectContaining({
              service_id: 'service:src--orders',
              effects: expect.arrayContaining(['env:ORDER_REGION']),
              evidence_ids: expect.arrayContaining(['evidence:file-src--orders--service.ts']),
            }),
          ]),
          tests: expect.arrayContaining(['src/orders/service.test.ts']),
        }),
      );
      expect(result.value.review.review_evidence_summary).toMatchObject({
        affected_services: 1,
        affected_flows: 1,
        service_causality_paths: 1,
        service_causality_effects: expect.arrayContaining(['env:ORDER_REGION']),
        affected_tests: expect.arrayContaining(['src/orders/service.test.ts']),
        affected_journeys: expect.arrayContaining(['Checkout payment journey']),
        affected_journey_steps: expect.any(Number),
        user_visible_failure_modes: expect.arrayContaining([
          expect.stringContaining('Checkout payment journey'),
        ]),
      });
      expect(result.value.review.review_evidence_summary.affected_journey_steps).toBeGreaterThan(0);
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('service causality path(s) explain flow-to-service blast radius'),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Service causality explains affected flow blast radius',
          affected_entities: expect.arrayContaining([
            'flow:http--post--orders--src--server.ts',
            'service:src--orders',
          ]),
        }),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('affected service(s) link the change'),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Service intelligence overlaps the diff',
          affected_entities: expect.arrayContaining(['service:src--orders']),
        }),
      );
      expect(result.value.reviewEval).toMatchObject({
        affected_service_count: 1,
        affected_flow_count: 1,
        affected_journey_count: 1,
        affected_journey_step_count:
          result.value.review.review_evidence_summary.affected_journey_steps,
        user_visible_failure_mode_count:
          result.value.review.review_evidence_summary.user_visible_failure_modes.length,
        service_causality_path_count: 1,
        service_causality_effect_count: 1,
      });

      const latest = await readJson<{
        latest_review_status: {
          affected_services?: string[];
          affected_flows?: string[];
          service_causality_paths?: number;
          service_causality_effects?: string[];
          review_evidence_summary?: {
            affected_journeys?: string[];
            affected_journey_steps?: number;
            user_visible_failure_modes?: string[];
          };
        };
        project_state?: { last_reviewed_services?: string[] };
      }>(join(dir, '.rizz', 'brain', 'latest.json'));
      expect(latest.latest_review_status.affected_services).toEqual(['service:src--orders']);
      expect(latest.latest_review_status.affected_flows).toContain(
        'flow:http--post--orders--src--server.ts',
      );
      expect(latest.latest_review_status.service_causality_paths).toBe(1);
      expect(latest.latest_review_status.service_causality_effects).toContain('env:ORDER_REGION');
      expect(latest.latest_review_status.review_evidence_summary).toMatchObject({
        affected_journeys: ['Checkout payment journey'],
        affected_journey_steps: expect.any(Number),
        user_visible_failure_modes: expect.arrayContaining([
          expect.stringContaining('Checkout payment journey'),
        ]),
      });
      expect(latest.project_state?.last_reviewed_services).toEqual(['service:src--orders']);

      const report = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(report).toContain('Affected Services');
      expect(report).toContain('service causality path(s)');
      expect(report).toContain('Checkout payment journey');
      expect(report).toContain('User-Visible Risk');
      expect(report).toContain('service:src--orders');
      expect(report).toContain('env:ORDER_REGION');
      expect(report).toContain('flow:http--post--orders--src--server.ts');
    });
  });

  it('links package and config diffs to dependency/runtime blast radius evidence', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({
          name: '@sample/cli',
          scripts: {
            build: 'tsc -b packages/cli',
            check: 'vitest run packages/cli && tsc -b',
            pack: 'pnpm pack',
            start: 'node dist/index.js',
          },
          dependencies: { zod: '^3.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'export function main(input: unknown): unknown { return input; }\n',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.test.ts'),
        'import { it } from "vitest"; it("starts", () => {});\n',
      );
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T13:10:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({
          name: '@sample/cli',
          scripts: {
            build: 'tsc -b packages/cli --pretty false',
            check: 'vitest run packages/cli && tsc -b',
            pack: 'pnpm pack',
            start: 'node dist/index.js',
          },
          dependencies: { zod: '^4.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T13:11:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.review.changed_files).toEqual(['packages/cli/package.json']);
      expect(result.value.review.dependency_runtime_impact).toMatchObject({
        changed_files: ['packages/cli/package.json'],
        package_manifests: ['packages/cli/package.json'],
        lockfiles: [],
        config_files: ['packages/cli/package.json'],
        dependency_entities: expect.arrayContaining(['dependency:zod']),
        affected_components: expect.arrayContaining(['component:packages--cli']),
        affected_flows: expect.arrayContaining(['flow:packages--cli--check']),
        affected_tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
        affected_configs: expect.arrayContaining(['packages/cli/package.json']),
        runtime_surfaces: expect.arrayContaining([
          'install/dependency resolution',
          'package script:build',
          'package script:typecheck',
          'package script:pack',
          'reconstructed flows',
        ]),
        verification_focus: expect.arrayContaining([
          'Validate package install and lockfile resolution for the changed dependency files.',
          'Run package script packages/cli/package.json#build: tsc -b packages/cli.',
          'Run package script packages/cli/package.json#check: vitest run packages/cli && tsc -b.',
          'Run package script packages/cli/package.json#pack: pnpm pack.',
          'Run linked test artifact packages/cli/src/index.test.ts.',
        ]),
        confidence: 'inferred',
      });
      expect(result.value.review.dependency_runtime_impact?.package_scripts).toContainEqual(
        expect.objectContaining({
          manifest: 'packages/cli/package.json',
          name: 'build',
          category: 'build',
        }),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Configuration or dependency surface changed',
          description: expect.stringContaining('Runtime/dependency impact links'),
          affected_entities: expect.arrayContaining([
            'component:packages--cli',
            'dependency:zod',
            'flow:packages--cli--check',
          ]),
          recommendation: expect.stringContaining('Validate package install'),
        }),
      );
      expect(result.value.review.review_evidence_summary).toMatchObject({
        dependency_runtime_impacts: 1,
        dependency_runtime_changed_files: ['packages/cli/package.json'],
        dependency_runtime_surfaces: expect.arrayContaining(['package script:build']),
        dependency_runtime_verification_focus: expect.arrayContaining([
          'Validate package install and lockfile resolution for the changed dependency files.',
        ]),
      });
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('Dependency/runtime impact links changed package/config files'),
      );
      expect(result.value.review.suggested_reviewer_focus_areas).toContain(
        'dependency/runtime: package script:build',
      );
      expect(result.value.reviewEval).toMatchObject({
        dependency_runtime_impact_count: 1,
        dependency_runtime_changed_file_count: 1,
        dependency_runtime_surface_count:
          result.value.review.dependency_runtime_impact?.runtime_surfaces.length,
        dependency_runtime_verification_focus_count:
          result.value.review.dependency_runtime_impact?.verification_focus.length,
      });

      const latest = await readJson<{
        latest_review_status: {
          dependency_runtime_impact?: { changed_files?: string[]; affected_flows?: string[] };
        };
      }>(join(dir, '.rizz', 'brain', 'latest.json'));
      expect(latest.latest_review_status.dependency_runtime_impact).toMatchObject({
        changed_files: ['packages/cli/package.json'],
        affected_flows: expect.arrayContaining(['flow:packages--cli--check']),
      });

      const report = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(report).toContain('Dependency Runtime Impact');
      expect(report).toContain('packages/cli/package.json#build');
      expect(report).toContain('Validate package install');

      const missionControl = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(missionControl).toContain('data-object="review-dependency-runtime-impact"');
      expect(missionControl).toContain('Review/Dependency Runtime Impact');
      expect(missionControl).toContain('Dependency Runtime Inspect');
      expect(missionControl).toContain('Changed Package / Config');
      expect(missionControl).toContain('Runtime Surfaces');
      expect(missionControl).toContain('Package Scripts');
      expect(missionControl).toContain('Focused Verification');
      expect(missionControl).toContain('packages/cli/package.json#build');
      expect(missionControl).toContain('Validate package install');
    });
  });

  it('records verification evidence and calibrates review without erasing production unknowns', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'verified-app',
          scripts: {
            lint: 'eslint .',
            typecheck: 'tsc --noEmit',
            build: 'vite build',
            test: 'pytest',
          },
        }),
      );
      await writeFile(join(dir, 'src', 'index.ts'), 'export const answer = 1;\n');
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T11:00:00.000Z'),
      });

      const lint = await addVerificationEvidence({
        rootDir: dir,
        name: 'lint',
        command: 'npm run lint',
        status: 'passed',
        now: new Date('2026-06-28T11:01:00.000Z'),
        outputSummary: 'passed; checked .env output redaction',
      });
      expect(lint).toMatchObject({ ok: true });
      const pytest = await addVerificationEvidence({
        rootDir: dir,
        name: 'pytest',
        command: 'pytest',
        status: 'passed',
        now: new Date('2026-06-28T11:02:00.000Z'),
      });
      expect(pytest).toMatchObject({ ok: true });

      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(join(dir, 'src', 'index.ts'), 'export const answer = 2;\n');

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T11:03:00.000Z'),
      });

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.value.review.verification_status).toMatchObject({
        total_checks: 2,
        local_checks_passed: expect.arrayContaining(['lint: npm run lint', 'pytest: pytest']),
        risks_reduced: expect.arrayContaining([
          'Local syntax/build/test regression risk reduced by recorded passed checks.',
        ]),
        remaining_unknowns: expect.arrayContaining([
          'No production or deployment smoke evidence has been recorded yet.',
        ]),
      });
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          category: 'Missing tests',
          severity: 'low',
          title: 'Runtime files changed without new tests, but local checks are recorded',
        }),
      );
      expect(result.value.review.review_evidence_summary.verification_evidence_ids).toHaveLength(2);
      expect(result.value.review.verification_evidence_score).toMatchObject({
        recorded_count: 2,
        passed_count: 2,
        failed_count: 0,
        approval_state: expect.any(String),
        score: expect.any(Number),
      });
      expect(result.value.reviewEval).toMatchObject({
        verification_evidence_count: 2,
        verification_passed_count: 2,
        verification_failed_count: 0,
        verification_evidence_score: expect.any(Number),
      });

      const artifact = await readJson<{
        local_checks_passed: string[];
        remaining_unknowns: string[];
      }>(join(dir, '.rizz', 'research', 'verification_evidence.json'));
      expect(artifact.local_checks_passed).toEqual(
        expect.arrayContaining(['lint: npm run lint', 'pytest: pytest']),
      );
      expect(JSON.stringify(artifact)).not.toContain('.env');
      expect(artifact.remaining_unknowns).toContain(
        'No production or deployment smoke evidence has been recorded yet.',
      );

      const reviewReport = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(reviewReport).toContain('Verification Calibration');
      expect(reviewReport).toContain('Proof Score');
      expect(reviewReport).toContain('Approval State');
      expect(reviewReport).toContain('Covered Proof');
      expect(reviewReport).toContain('Local syntax/build/test regression risk reduced');
    });
  });

  it('uses graph consumers to include dependent components in review blast radius', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await mkdir(join(dir, 'packages', 'core', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({
          name: '@sample/cli',
          scripts: { start: 'node dist/index.js', test: 'vitest run packages/cli' },
          dependencies: { '@sample/core': 'workspace:*' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'core', 'package.json'),
        JSON.stringify({ name: '@sample/core' }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'import { runCore } from "../../core/src/index.js";\nexport function main() { return runCore(); }\n',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.test.ts'),
        'import { it } from "vitest"; it("starts", () => {});\n',
      );
      await writeFile(
        join(dir, 'packages', 'core', 'src', 'index.ts'),
        'export function runCore() { return "core"; }\n',
      );
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:46:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(
        join(dir, 'packages', 'core', 'src', 'index.ts'),
        'export function runCore() { return "changed"; }\n',
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:47:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          changedFiles: 1,
          affectedComponents: 2,
          blastRadius: 'moderate',
        },
      });
      if (!result.ok) return;

      expect(result.value.review.direct_affected_components).toContainEqual(
        expect.objectContaining({
          id: 'component:packages--core',
          changed_files: ['packages/core/src/index.ts'],
        }),
      );
      expect(result.value.review.dependent_components).toContainEqual(
        expect.objectContaining({
          id: 'component:packages--cli',
          reason: expect.stringContaining(
            'component:packages--cli imports component:packages--core',
          ),
          tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
          configs: expect.arrayContaining(['packages/cli/package.json']),
        }),
      );
      expect(result.value.review.affected_relationships).toContainEqual(
        expect.objectContaining({
          from: 'component:packages--cli',
          relation: 'imports',
          to: 'component:packages--core',
        }),
      );
      expect(result.value.review.affected_flows).toContainEqual(
        expect.objectContaining({
          id: 'flow:packages--cli--start',
          changed_files: ['packages/core/src/index.ts'],
          tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
          configs: expect.arrayContaining(['packages/cli/package.json']),
        }),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('dependent consumer component(s) require review'),
      );
      expect(result.value.review.blast_radius_reasons).toContainEqual(
        expect.stringContaining('architecture impact-map surface(s) overlap the diff'),
      );
      expect(result.value.review.architecture_impact_map).toContainEqual(
        expect.objectContaining({
          impact_id: 'impact:component:packages--core',
          entity_id: 'component:packages--core',
          matched_changed_files: ['packages/core/src/index.ts'],
          dependent_components: expect.arrayContaining(['component:packages--cli']),
          what_breaks: expect.arrayContaining([
            expect.stringContaining('dependent component(s) can break'),
          ]),
          affected_tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
          affected_configs: expect.arrayContaining(['packages/cli/package.json']),
        }),
      );
      expect(result.value.review.review_evidence_summary).toMatchObject({
        direct_components: 1,
        dependent_components: 1,
        architecture_impact_surfaces: 2,
        architecture_what_breaks: expect.arrayContaining([
          expect.stringContaining('dependent component(s) can break'),
        ]),
        affected_tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
        affected_configs: expect.arrayContaining(['packages/cli/package.json']),
      });
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Consumer components depend on changed components',
          affected_entities: expect.arrayContaining([
            'component:packages--cli',
            'component:packages--core',
          ]),
        }),
      );
    });
  });

  it('automatically creates a lightweight brain when review runs first', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(join(dir, 'README.md'), '# changed\n');

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:40:00.000Z'),
      });

      expect(result.ok).toBe(true);
      expect(await readFile(join(dir, '.rizz', 'brain', 'latest.json'), 'utf8')).toContain(
        'latest_review_status',
      );
    });
  });

  it('fails review when required brain schema files are malformed', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, '.rizz', 'brain'), { recursive: true });
      await writeFile(join(dir, '.rizz', 'brain', 'latest.json'), '{}');
      await writeFile(join(dir, '.rizz', 'brain', 'graph.json'), '{"relationships":[]}');
      await writeFile(join(dir, 'README.md'), '# sample\n');
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(join(dir, 'README.md'), '# changed\n');

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:41:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'BRAIN_SCHEMA_INVALID' },
      });
    });
  });

  it('redacts secret-like strings from review findings and reports', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(dir, 'provider.ts'), 'export const key = "";\n');
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:42:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'provider.ts'),
        'export const key = "sk-or-v1-reviewsecret0000000000000000";\n',
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:43:00.000Z'),
      });

      expect(result.ok).toBe(true);
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).not.toContain('sk-or-v1-reviewsecret');
      expect(generated).toContain('Security-sensitive surface changed');
    });
  });

  it('detects secret-like strings in untracked files without persisting them', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run' } }),
      );
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:44:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'scratch.ts'),
        'export const key = "sk-or-v1-untrackedsecret0000000000000000";\n',
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:45:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({ category: 'Security', severity: 'critical' }),
      );
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).not.toContain('sk-or-v1-untrackedsecret');
      expect(generated).toContain('Security-sensitive surface changed');
    });
  });

  it('links transitive route flows to state/data dependencies and review blast radius', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src', 'accounts'), { recursive: true });
      await mkdir(join(dir, 'src', 'db'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'stateful-app',
          scripts: { test: 'vitest run', start: 'node dist/server.js' },
          dependencies: { express: '^4.19.0' },
          devDependencies: { vitest: '^2.0.0', typescript: '^5.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'src', 'server.ts'),
        [
          'import express from "express";',
          'import { profileHandler } from "./accounts/profile-handler.js";',
          'const app = express();',
          'app.get("/profile", profileHandler);',
          'export { app };',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'accounts', 'profile-handler.ts'),
        [
          'import { loadProfile, saveProfile } from "./profile-repository.js";',
          'export async function profileHandler(req: { userId?: string }, res: { json: (value: unknown) => void }) {',
          '  const profile = await loadProfile(req.userId ?? "guest");',
          '  await saveProfile(profile.id, { lastSeen: Date.now() });',
          '  res.json(profile);',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'accounts', 'profile-repository.ts'),
        [
          'import { profileSchema } from "../db/schema.js";',
          'const profiles = new Map<string, { id: string; lastSeen?: number }>();',
          'export async function loadProfile(id: string) {',
          '  const cached = profiles.get(id);',
          '  return cached ?? { id, schema: profileSchema.table };',
          '}',
          'export async function saveProfile(id: string, update: { lastSeen: number }) {',
          '  profiles.set(id, { id, ...update });',
          '  return profiles.get(id);',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'db', 'schema.ts'),
        [
          'export const profileSchema = {',
          '  table: "profiles",',
          '  columns: ["id", "lastSeen"],',
          '};',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'accounts', 'profile-handler.test.ts'),
        'import { it } from "vitest"; it("loads profile", () => {});\n',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:00:00.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;

      const flows = await readJson<{
        entities: Array<{
          id: string;
          data?: {
            route_path?: string;
            files?: string[];
            data_dependencies?: Array<{
              label: string;
              kind: string;
              operations: string[];
              files: string[];
            }>;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      const profileFlow = flows.entities.find((flow) => flow.data?.route_path === '/profile');
      expect(profileFlow).toBeDefined();
      expect(profileFlow?.data?.files).toEqual(
        expect.arrayContaining([
          'src/server.ts',
          'src/accounts/profile-handler.ts',
          'src/accounts/profile-repository.ts',
          'src/db/schema.ts',
        ]),
      );
      expect(profileFlow?.data?.data_dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'data schema/model',
            kind: 'schema',
            operations: expect.arrayContaining(['schema']),
            files: expect.arrayContaining(['src/db/schema.ts']),
          }),
          expect.objectContaining({
            label: 'state repository/module',
            operations: expect.arrayContaining(['read', 'write']),
            files: expect.arrayContaining(['src/accounts/profile-repository.ts']),
          }),
        ]),
      );

      const flowUnderstanding = await readJson<{
        flows_with_data_dependencies: number;
        data_dependencies: number;
        state_operations_by_type: Record<string, number>;
      }>(join(dir, '.rizz', 'research', 'flow_understanding.json'));
      expect(flowUnderstanding.flows_with_data_dependencies).toBeGreaterThan(0);
      expect(flowUnderstanding.data_dependencies).toBeGreaterThan(0);
      expect(flowUnderstanding.state_operations_by_type.schema).toBeGreaterThan(0);

      const explain = await explainProjectTarget({
        rootDir: dir,
        target: profileFlow?.id ?? 'flow:http--get--profile',
        now: new Date('2026-06-28T12:01:00.000Z'),
      });
      expect(explain.ok).toBe(true);
      if (!explain.ok) return;
      expect(explain.value.explanation.flow?.data_dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'data schema/model', kind: 'schema' }),
        ]),
      );
      const explainReport = await readFile(join(dir, '.rizz', 'reports', 'explain.html'), 'utf8');
      expect(explainReport).toContain('State/Data Dependencies');
      expect(explainReport).toContain('data schema/model');

      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'src', 'db', 'schema.ts'),
        [
          'export const profileSchema = {',
          '  table: "profiles",',
          '  columns: ["id", "lastSeen", "plan"],',
          '};',
          '',
        ].join('\n'),
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T12:02:00.000Z'),
      });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.review.review_evidence_summary.affected_data_dependencies).toContain(
        'data schema/model',
      );
      expect(review.value.review.review_evidence_summary.affected_state_operations).toContain(
        'schema',
      );
      expect(review.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'State/data dependency overlaps the diff',
          category: 'Hidden coupling',
        }),
      );
      expect(review.value.review.verification_plan).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            priority: 'required',
            verification_type: 'test',
            linked_flows: expect.arrayContaining([profileFlow?.id]),
          }),
          expect.objectContaining({
            priority: 'required',
            verification_type: 'data',
            linked_files: expect.arrayContaining(['src/db/schema.ts']),
          }),
        ]),
      );
      expect(review.value.reviewEval).toMatchObject({
        affected_data_dependency_count: expect.any(Number),
        affected_state_operation_count: expect.any(Number),
        verification_plan_count: expect.any(Number),
        verification_plan_required_count: expect.any(Number),
      });
      expect(review.value.reviewEval.affected_data_dependency_count).toBeGreaterThan(0);
      expect(review.value.reviewEval.affected_state_operation_count).toBeGreaterThan(0);
      expect(review.value.reviewEval.verification_plan_count).toBe(
        review.value.review.verification_plan.length,
      );
      expect(review.value.reviewEval.verification_plan_required_count).toBeGreaterThan(0);
      const agentRepairPackets = await readJson<{
        packet_count: number;
        high_priority_count: number;
        sources: { review_blast_radius: number; verification: number };
        packets: Array<{
          source: string;
          target_type: string;
          verification_actions: string[];
          artifacts: string[];
        }>;
      }>(join(dir, '.rizz', 'research', 'agent_repair_packets.json'));
      expect(agentRepairPackets).toMatchObject({
        packet_count: expect.any(Number),
        high_priority_count: expect.any(Number),
        sources: expect.objectContaining({
          review_blast_radius: expect.any(Number),
          verification: expect.any(Number),
        }),
      });
      expect(agentRepairPackets.sources.review_blast_radius).toBeGreaterThan(0);
      expect(agentRepairPackets.sources.verification).toBeGreaterThan(0);
      expect(agentRepairPackets.packets).toContainEqual(
        expect.objectContaining({
          source: 'verification',
          target_type: expect.stringContaining('verification:'),
          verification_actions: expect.arrayContaining([
            expect.stringContaining('Record the result with rizz verification evidence'),
          ]),
        }),
      );
      expect(agentRepairPackets.packets).toContainEqual(
        expect.objectContaining({
          source: 'review_blast_radius',
          artifacts: expect.arrayContaining(['.rizz/research/review_claim_evidence.json']),
        }),
      );
      const reviewReport = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      const missionControl = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(reviewReport).toContain('State/Data Impact');
      expect(reviewReport).toContain('Targeted Verification');
      expect(reviewReport).toContain('data schema/model');
      expect(missionControl).toContain('Targeted Verification');
      expect(missionControl).toContain('Verification Summary');
    });
  });

  it('does not infer state/data dependencies from plain UI copy alone', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'copy-only-app', scripts: { start: 'vite' } }),
      );
      await writeFile(
        join(dir, 'src', 'home.tsx'),
        [
          'export function Home() {',
          '  return <p>Storefront schema copy mentions cache, update, and delete help text.</p>;',
          '}',
          '',
        ].join('\n'),
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:03:00.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;

      const flows = await readJson<{
        entities: Array<{ data?: { data_dependencies?: unknown[] } }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      expect(flows.entities.flatMap((flow) => flow.data?.data_dependencies ?? [])).toEqual([]);
    });
  });

  it('does not infer state/data dependencies from config or test wording alone', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'config-copy-app',
          scripts: { build: 'next build', test: 'vitest run' },
          dependencies: { next: '^15.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'next.config.mjs'),
        [
          '// Operator note: update Redis cache TTL and delete stale sessions in the runbook.',
          'const nextConfig = { output: "standalone" };',
          'export default nextConfig;',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'runtime.test.ts'),
        [
          'import { it } from "vitest";',
          'it("mentions Redis cache update and delete coverage in test copy", () => {});',
          '',
        ].join('\n'),
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:03:30.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;

      const flows = await readJson<{
        entities: Array<{ data?: { data_dependencies?: unknown[] } }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'flows.json'));
      expect(flows.entities.flatMap((flow) => flow.data?.data_dependencies ?? [])).toEqual([]);
    });
  });

  it('does not report config-only TypeScript changes as runtime source or state/data impact', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'next-config-review-app',
          scripts: { build: 'next build', test: 'vitest run' },
          dependencies: { next: '^15.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'next.config.ts'),
        [
          'const nextConfig = {',
          '  output: "standalone",',
          '};',
          'export default nextConfig;',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'page.tsx'),
        'export function Page() { return <main>Ready</main>; }\n',
      );
      await writeFile(
        join(dir, 'src', 'page.test.tsx'),
        'import { it } from "vitest"; it("renders", () => {});\n',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:03:45.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'next.config.ts'),
        [
          '// Operator note: update Redis cache TTL and delete stale sessions in the runbook.',
          'const nextConfig = {',
          '  output: "standalone",',
          '  poweredByHeader: false,',
          '};',
          'export default nextConfig;',
          '',
        ].join('\n'),
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T12:04:00.000Z'),
      });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.review.changed_files).toEqual(['next.config.ts']);
      expect(review.value.review.findings).not.toContainEqual(
        expect.objectContaining({
          category: 'Missing tests',
          title: expect.stringContaining('Runtime files changed'),
        }),
      );
      expect(review.value.review.findings).not.toContainEqual(
        expect.objectContaining({ title: 'State/data dependency overlaps the diff' }),
      );
      expect(review.value.review.review_evidence_summary.affected_data_dependencies).toEqual([]);
      expect(review.value.review.review_evidence_summary.affected_state_operations).toEqual([]);
      expect(review.value.review.verification_plan).not.toContainEqual(
        expect.objectContaining({ verification_type: 'data' }),
      );
      expect(review.value.review.findings).toContainEqual(
        expect.objectContaining({ title: 'Configuration or dependency surface changed' }),
      );
    });
  });

  it('does not report comment-only or type-support changes as state/data impact', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src', 'accounts'), { recursive: true });
      await mkdir(join(dir, 'src', 'db'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'comment-type-review-app',
          scripts: { test: 'vitest run' },
          dependencies: { express: '^4.19.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'src', 'server.ts'),
        [
          'import express from "express";',
          'import { profileHandler } from "./accounts/profile-handler.js";',
          'const app = express();',
          'app.get("/profile", profileHandler);',
          'export { app };',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'accounts', 'profile-handler.ts'),
        [
          'import { loadProfile } from "./profile-repository.js";',
          'export async function profileHandler(req: { userId?: string }, res: { json: (value: unknown) => void }) {',
          '  res.json(await loadProfile(req.userId ?? "guest"));',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'accounts', 'profile-repository.ts'),
        [
          'import type { Profile } from "../db/profile-types.js";',
          'const profiles = new Map<string, Profile>();',
          'export async function loadProfile(id: string) {',
          '  return profiles.get(id) ?? { id, name: "Guest" };',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'db', 'profile-types.ts'),
        ['export type Profile = {', '  id: string;', '  name: string;', '};', ''].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'accounts', 'profile-handler.test.ts'),
        'import { it } from "vitest"; it("loads profile", () => {});\n',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:04:30.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'src', 'accounts', 'profile-repository.ts'),
        [
          'import type { Profile } from "../db/profile-types.js";',
          '// Operator note: delete stale cache/session entries in the runbook.',
          'const profiles = new Map<string, Profile>();',
          'export async function loadProfile(id: string) {',
          '  return profiles.get(id) ?? { id, name: "Guest" };',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'db', 'profile-types.ts'),
        [
          'export type Profile = {',
          '  id: string;',
          '  name: string;',
          '  displayName?: string;',
          '};',
          '',
        ].join('\n'),
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T12:05:00.000Z'),
      });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.review.changed_files).toEqual(
        expect.arrayContaining(['src/accounts/profile-repository.ts', 'src/db/profile-types.ts']),
      );
      expect(review.value.review.affected_flows.length).toBeGreaterThan(0);
      expect(review.value.review.review_evidence_summary.affected_data_dependencies).toEqual([]);
      expect(review.value.review.review_evidence_summary.affected_state_operations).toEqual([]);
      expect(review.value.review.review_evidence_summary.user_visible_failure_modes).not.toEqual(
        expect.arrayContaining([expect.stringContaining('persisted state correctly')]),
      );
      expect(review.value.review.findings).not.toContainEqual(
        expect.objectContaining({
          category: 'Missing tests',
          title: expect.stringContaining('Runtime files changed'),
        }),
      );
      expect(review.value.review.findings).not.toContainEqual(
        expect.objectContaining({ title: 'State/data dependency overlaps the diff' }),
      );
      expect(review.value.review.verification_plan).not.toContainEqual(
        expect.objectContaining({ verification_type: 'data' }),
      );
      expect(review.value.reviewEval).toMatchObject({
        affected_data_dependency_count: 0,
        affected_state_operation_count: 0,
      });
    });
  });

  it('calibrates test-only changes as confidence evidence instead of runtime blast radius', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src', 'auth'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'test-evidence-review-app',
          scripts: { test: 'vitest run' },
          dependencies: { express: '^4.19.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'src', 'server.ts'),
        [
          'import express from "express";',
          'import { loginHandler } from "./auth/login-handler.js";',
          'const app = express();',
          'app.post("/login", loginHandler);',
          'export { app };',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'auth', 'login-handler.ts'),
        [
          'import { saveSession } from "./session-store.js";',
          'export async function loginHandler(req: { userId?: string }, res: { json: (value: unknown) => void }) {',
          '  const session = await saveSession(req.userId ?? "guest");',
          '  res.json({ ok: true, session });',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'auth', 'session-store.ts'),
        [
          'const sessions = new Map<string, { id: string; userId: string }>();',
          'export async function saveSession(userId: string) {',
          '  const session = { id: `session-${userId}`, userId };',
          '  sessions.set(session.id, session);',
          '  return session;',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'auth', 'login-handler.test.ts'),
        'import { it } from "vitest"; it("covers login", () => {});\n',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:07:30.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'src', 'auth', 'login-handler.test.ts'),
        'import { expect, it } from "vitest"; it("covers login response", () => expect(true).toBe(true));\n',
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T12:08:00.000Z'),
      });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.review.changed_files).toEqual(['src/auth/login-handler.test.ts']);
      expect(review.value.review.affected_flows.length).toBeGreaterThan(0);
      expect(review.value.review.review_evidence_summary.test_evidence_changes).toContainEqual(
        expect.stringContaining('src/auth/login-handler.test.ts updates test evidence'),
      );
      expect(review.value.review.review_evidence_summary.affected_data_dependencies).toEqual([]);
      expect(review.value.review.review_evidence_summary.affected_state_operations).toEqual([]);
      expect(review.value.review.findings).toContainEqual(
        expect.objectContaining({
          category: 'Correctness',
          title: 'Test evidence changed without runtime surface changes',
        }),
      );
      expect(review.value.review.findings).not.toContainEqual(
        expect.objectContaining({
          category: 'Missing tests',
          title: expect.stringContaining('Runtime files changed'),
        }),
      );
      expect(review.value.review.findings).not.toContainEqual(
        expect.objectContaining({ title: 'State/data dependency overlaps the diff' }),
      );
      expect(review.value.reviewEval).toMatchObject({
        test_evidence_change_count: 1,
        affected_data_dependency_count: 0,
        affected_state_operation_count: 0,
      });
    });
  });

  it('keeps generated artifact changes visible without treating them as authored blast radius', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src', 'generated'), { recursive: true });
      await mkdir(join(dir, 'src', 'routes'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'generated-review-app',
          scripts: { test: 'vitest run' },
          dependencies: { express: '^4.19.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'src', 'server.ts'),
        [
          'import express from "express";',
          'import { profileHandler } from "./routes/profile.js";',
          'const app = express();',
          'app.get("/profile", profileHandler);',
          'export { app };',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'routes', 'profile.ts'),
        [
          'import { getProfileClient } from "../generated/profile-client.js";',
          'export async function profileHandler(_req: unknown, res: { json: (value: unknown) => void }) {',
          '  res.json(getProfileClient());',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'generated', 'profile-client.ts'),
        ['export function getProfileClient() {', '  return { status: "ready" };', '}', ''].join(
          '\n',
        ),
      );
      await writeFile(
        join(dir, 'src', 'routes', 'profile.test.ts'),
        'import { it } from "vitest"; it("profiles", () => {});\n',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:05:30.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'src', 'generated', 'profile-client.ts'),
        [
          'export function getProfileClient() {',
          '  return { status: "ready", schemaVersion: 2 };',
          '}',
          '',
        ].join('\n'),
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T12:06:00.000Z'),
      });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.review.changed_files).toEqual(['src/generated/profile-client.ts']);
      expect(review.value.review.direct_affected_components).toEqual([]);
      expect(review.value.review.affected_flows).toEqual([]);
      expect(review.value.review.affected_relationships).toEqual([]);
      expect(review.value.review.review_evidence_summary.generated_artifacts).toEqual([
        'src/generated/profile-client.ts',
      ]);
      expect(review.value.review.review_evidence_summary.test_evidence_changes).toEqual([]);
      expect(review.value.review.review_evidence_summary.affected_data_dependencies).toEqual([]);
      expect(review.value.review.review_evidence_summary.affected_state_operations).toEqual([]);
      expect(review.value.review.findings).toContainEqual(
        expect.objectContaining({
          category: 'Maintainability',
          title: 'Generated or vendor artifacts changed',
        }),
      );
      expect(review.value.review.findings).not.toContainEqual(
        expect.objectContaining({
          category: 'Missing tests',
          title: expect.stringContaining('Runtime files changed'),
        }),
      );
      expect(review.value.reviewEval).toMatchObject({
        generated_artifact_count: 1,
        test_evidence_change_count: 0,
        affected_flow_count: 0,
        affected_relationship_count: 0,
        affected_data_dependency_count: 0,
        affected_state_operation_count: 0,
        precision_calibration: {
          generated_artifact_only_change: true,
          false_positive_guards: expect.arrayContaining([
            'generated_artifact_visibility_guard',
            'state_data_overstatement_guard',
            'architecture_overstatement_guard',
            'missing_tests_overstatement_guard',
          ]),
          false_negative_signals: expect.arrayContaining(['generated_artifact_change_visible']),
          precision_gaps: expect.not.arrayContaining([
            'runtime_source_change_without_flow_context',
          ]),
        },
      });
    });
  });

  it('keeps lockfile changes in dependency runtime impact instead of generated artifact treatment', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'lockfile-review-app',
          scripts: { test: 'vitest run', build: 'tsc -b' },
          dependencies: { express: '^4.19.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'pnpm-lock.yaml'),
        ['lockfileVersion: 9.0', 'packages:', '  express@4.19.0:', '    resolution: {}', ''].join(
          '\n',
        ),
      );
      await writeFile(join(dir, 'src', 'index.ts'), 'export const ready = true;\n');

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:06:30.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'pnpm-lock.yaml'),
        [
          'lockfileVersion: 9.0',
          'packages:',
          '  express@4.19.0:',
          '    resolution: {}',
          '  vitest@2.1.0:',
          '    resolution: {}',
          '',
        ].join('\n'),
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T12:07:00.000Z'),
      });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.review.changed_files).toEqual(['pnpm-lock.yaml']);
      expect(review.value.review.review_evidence_summary.generated_artifacts).toEqual([]);
      expect(review.value.review.dependency_runtime_impact).toMatchObject({
        changed_files: ['pnpm-lock.yaml'],
        lockfiles: ['pnpm-lock.yaml'],
      });
      expect(review.value.review.review_evidence_summary.dependency_runtime_impacts).toBe(1);
      expect(
        review.value.review.review_evidence_summary.dependency_runtime_verification_focus,
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Validate package install and lockfile resolution'),
        ]),
      );
      expect(review.value.review.findings).toContainEqual(
        expect.objectContaining({
          category: 'Backward compatibility',
          title: 'Configuration or dependency surface changed',
        }),
      );
      expect(review.value.review.findings).not.toContainEqual(
        expect.objectContaining({ title: 'Generated or vendor artifacts changed' }),
      );
      expect(review.value.reviewEval).toMatchObject({
        generated_artifact_count: 0,
        dependency_runtime_impact_count: 1,
        precision_calibration: {
          dependency_or_config_only_change: true,
          lockfile_only_change: true,
          false_positive_guards: expect.arrayContaining([
            'dependency_config_runtime_guard',
            'lockfile_install_resolution_guard',
            'state_data_overstatement_guard',
            'architecture_overstatement_guard',
            'missing_tests_overstatement_guard',
          ]),
          false_negative_signals: expect.arrayContaining([
            'dependency_runtime_context_preserved',
            'evidence_links_preserved',
          ]),
          precision_gaps: [],
        },
      });
    });
  });

  it('keeps state/data blast radius when a schema file is renamed', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src', 'accounts'), { recursive: true });
      await mkdir(join(dir, 'src', 'db'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'rename-state-app',
          scripts: { test: 'vitest run' },
          dependencies: { express: '^4.19.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'src', 'server.ts'),
        'import express from "express";\nimport { loadProfile } from "./accounts/repository.js";\nconst app = express();\napp.get("/profile", async (_req, res) => res.json(await loadProfile("guest")));\nexport { app };\n',
      );
      await writeFile(
        join(dir, 'src', 'accounts', 'repository.ts'),
        'import { profileSchema } from "../db/schema.js";\nexport async function loadProfile(id: string) { return { id, table: profileSchema.table }; }\n',
      );
      await writeFile(
        join(dir, 'src', 'db', 'schema.ts'),
        'export const profileSchema = { table: "profiles", columns: ["id"] };\n',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:04:00.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;

      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await git(dir, ['mv', 'src/db/schema.ts', 'src/db/profile-schema.ts']);

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T12:05:00.000Z'),
      });

      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.review.changed_files).toEqual(
        expect.arrayContaining(['src/db/schema.ts', 'src/db/profile-schema.ts']),
      );
      expect(review.value.review.review_evidence_summary.affected_data_dependencies).toContain(
        'data schema/model',
      );
      expect(review.value.review.review_evidence_summary.affected_state_operations).toContain(
        'schema',
      );
      expect(review.value.review.verification_plan).toContainEqual(
        expect.objectContaining({
          priority: 'required',
          verification_type: 'data',
          linked_files: expect.arrayContaining(['src/db/schema.ts']),
        }),
      );
    });
  });

  it('surfaces missing state/data evidence when affected flows have no linked tests', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src', 'accounts'), { recursive: true });
      await mkdir(join(dir, 'src', 'db'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'untested-state-app',
          scripts: { test: 'vitest run' },
          dependencies: { express: '^4.19.0' },
        }),
      );
      await writeFile(
        join(dir, 'src', 'server.ts'),
        'import express from "express";\nimport { loadProfile } from "./accounts/repository.js";\nconst app = express();\napp.get("/profile", async (_req, res) => res.json(await loadProfile("guest")));\nexport { app };\n',
      );
      await writeFile(
        join(dir, 'src', 'accounts', 'repository.ts'),
        'import { profileSchema } from "../db/schema.js";\nexport async function loadProfile(id: string) { return { id, table: profileSchema.table }; }\n',
      );
      await writeFile(
        join(dir, 'src', 'db', 'schema.ts'),
        'export const profileSchema = { table: "profiles", columns: ["id"] };\n',
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T12:06:00.000Z'),
      });
      expect(brain.ok).toBe(true);
      if (!brain.ok) return;

      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'src', 'db', 'schema.ts'),
        'export const profileSchema = { table: "profiles", columns: ["id", "plan"] };\n',
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T12:07:00.000Z'),
      });

      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.review.review_evidence_summary.journey_missing_evidence).toContain(
        'No linked test verifies this data/state dependency.',
      );
      expect(review.value.review.verification_plan).toContainEqual(
        expect.objectContaining({
          priority: 'required',
          verification_type: 'test',
          manual_checks: expect.arrayContaining([
            'Add or identify focused tests for the changed runtime behavior.',
          ]),
        }),
      );
      const reviewReport = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(reviewReport).toContain('No linked test verifies this data/state dependency.');
    });
  });
});
