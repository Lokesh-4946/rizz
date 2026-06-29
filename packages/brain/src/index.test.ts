import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainProjectTarget, generateProjectBrain, reviewProjectChanges } from './index.js';

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

describe('project brain generation', () => {
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
        scanned_files: number;
        changed_files: string[];
        new_files: string[];
        reused_files: number;
        recomputed_files: number;
        file_reuse_ratio: number;
      }>(join(first.value.researchDir, 'incremental_update.json'));
      expect(firstIncremental).toMatchObject({
        scanned_files: 3,
        changed_files: [
          'packages/brain/package.json',
          'packages/brain/src/index.test.ts',
          'packages/brain/src/index.ts',
        ],
        new_files: [
          'packages/brain/package.json',
          'packages/brain/src/index.test.ts',
          'packages/brain/src/index.ts',
        ],
        reused_files: 0,
        recomputed_files: 3,
        file_reuse_ratio: 0,
      });

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
        'evidence_quality.json',
        'architecture_reasoning.json',
        'component_intelligence.json',
        'flow_confidence.json',
        'flow_coverage.json',
        'flow_understanding.json',
        'incremental_update.json',
      ].sort((a, b) => a.localeCompare(b));
      expect((await readdir(researchDir)).sort((a, b) => a.localeCompare(b))).toEqual(
        artifactNames,
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
        risk_concentrations: Array<{ entity_id: string; kind: string }>;
        review_hints: Array<{ reason: string; affected_flows: string[] }>;
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
      expect(architectureReasoning.unknowns).toContain(
        '2 reconstructed flow(s) are not verified yet.',
      );

      const incremental = await readJson<{
        scanned_files: number;
        changed_files: string[];
        stale_files: string[];
        reused_files: number;
        recomputed_files: number;
        file_reuse_ratio: number;
        file_status_counts: { changed: number; current: number };
      }>(join(researchDir, 'incremental_update.json'));
      expect(incremental).toMatchObject({
        scanned_files: 3,
        changed_files: ['packages/brain/src/index.ts'],
        stale_files: [],
        reused_files: 2,
        recomputed_files: 1,
        file_reuse_ratio: 0.6667,
        file_status_counts: { changed: 1, current: 2 },
      });

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
        new_files: string[];
        reused_files: number;
        recomputed_files: number;
        file_reuse_ratio: number;
      }>(join(third.value.researchDir, 'incremental_update.json'));
      expect(mixedIncremental).toMatchObject({
        scanned_files: 4,
        changed_files: ['packages/brain/src/extra.ts'],
        new_files: ['packages/brain/src/extra.ts'],
        reused_files: 3,
        recomputed_files: 1,
        file_reuse_ratio: 0.75,
      });

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
      expect(testFlow?.data?.steps?.[0]?.evidence).toContain(
        'evidence:file-packages--brain--src--index.ts',
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
          component_intelligence: string;
          incremental_update: string;
          flow_understanding: string;
          architecture_reasoning: string;
        };
      }>(join(dir, '.rizz', 'brain', 'index.json'));
      expect(index.flow_index_path).toBe('.rizz/brain/flows/index.json');
      expect(index.research_paths).toMatchObject({
        metrics: '.rizz/research/metrics.json',
        component_intelligence: '.rizz/research/component_intelligence.json',
        incremental_update: '.rizz/research/incremental_update.json',
        flow_understanding: '.rizz/research/flow_understanding.json',
        architecture_reasoning: '.rizz/research/architecture_reasoning.json',
      });
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
        tradeoffs: true,
        failure_modes: true,
        known_risks: true,
      });
      expect(helperComponent?.field_evidence.tradeoffs).toBe(0);
      expect(helperComponent?.field_evidence.failure_modes).toBe(0);
      expect(helperComponent?.field_evidence.known_risks).toBe(0);
      expect(componentIntelligence.evidence_coverage.tradeoffs).toBe(0);
      expect(componentIntelligence.evidence_coverage.failure_modes).toBe(0);
      expect(componentIntelligence.evidence_coverage.known_risks).toBe(0);
      expect(componentIntelligence.evidence_backed_field_score).toBeLessThan(
        componentIntelligence.field_coverage_score,
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
      expect(report).toContain('<h2>Start Here</h2>');
      expect(report).toContain('Responsibilities');
      expect(report).toContain('Coupling');
      expect(report).toContain('If Removed');
      expect(report).toContain('Risky Seams');
      expect(report).toContain('Important Files');
      expect(report).toContain('Evidence');
      expect(report).toContain('Command-line surface');
      expect(report).toContain('Search components, files, risks, commands, evidence...');
      expect(report).toContain(
        '<label class="sr-only" for="global-filter">Search project intelligence</label>',
      );
      expect(report).toContain("document.querySelectorAll('[data-search]')");
      expect(report).toContain('data-filter="unknown"');
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
      expect(report.indexOf('<h2>Start Here</h2>')).toBeLessThan(
        report.indexOf('<h2>Component Intelligence</h2>'),
      );
      expect(report).not.toContain('<script src=');
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
        what_breaks: Array<{ component_id: string; impacts: string[] }>;
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
      expect(report).toContain('component:packages--cli: medium (6/10)');
      expect(report).toContain('Static imports cross component boundaries');
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
        entry_points: expect.arrayContaining(['command: packages/brain/package.json#test']),
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
      const flowReport = await readFile(join(dir, '.rizz', 'reports', 'explain.html'), 'utf8');
      expect(flowReport).toContain('Flow Steps');
      expect(flowReport).toContain('flow:packages--brain--test');
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
      expect(generated).toContain('redacted:sensitive-file:');
      expect(generated).toContain('[redacted secret]');
      expect(generated).toContain('.env.example');
      expect(generated).toContain('Some evidence labels were redacted');
      expect(generated).not.toContain(
        'Configuration artifact detected at redacted:sensitive-file:',
      );

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
        redacted_evidence_count: expect.any(Number),
        verified_claim_count: expect.any(Number),
        inferred_claim_count: expect.any(Number),
        uncertain_claim_count: expect.any(Number),
        evidence_coverage_score: expect.any(Number),
        redaction_safety_score: 100,
        confidence_distribution: expect.any(Object),
        top_uncertain_areas: expect.any(Array),
      });
      expect(evidenceQuality.redacted_evidence_count).toBeGreaterThan(0);

      expect(JSON.stringify(review.value.review)).not.toContain('client_secret_handler.ts');
      expect(review.value.review.changed_files).toContainEqual(
        expect.stringMatching(/^redacted:sensitive-file:/),
      );
      expect(JSON.stringify(explain.value.explanation)).not.toContain('client_secret_handler.ts');
      expect(explain.value.explanation.resolved_entity_id).toContain('redacted:sensitive-file:');
    });
  });

  it('skips default local agent, build, binary, and tsbuildinfo noise', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, '.agents', 'handoffs'), { recursive: true });
      await mkdir(join(dir, '.codex'), { recursive: true });
      await mkdir(join(dir, 'dist-pack'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await writeFile(join(dir, 'src', 'index.ts'), 'export const ok = true;');
      await writeFile(join(dir, '.agents', 'handoffs', 'handoff.md'), 'local agent memory');
      await writeFile(join(dir, '.codex', 'config.toml'), 'model = "test"');
      await writeFile(join(dir, 'dist-pack', 'sample.tgz'), 'packed package');
      await writeFile(join(dir, 'tsconfig.tsbuildinfo'), '{}');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:34:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: { scannedFiles: 2, changedFiles: 2 },
      });
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).toContain('src/index.ts');
      expect(generated).not.toContain('local agent memory');
      expect(generated).not.toContain('.codex/config.toml');
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
          blastRadius: 'narrow',
          recommendedAction: 'investigate',
        },
      });
      if (!result.ok) return;
      expect(result.value.review.changed_files).toEqual(['packages/cli/src/index.ts']);
      expect(result.value.review.affected_components).toContain('component:packages--cli');
      expect(result.value.review.affected_flows).toContainEqual(
        expect.objectContaining({
          id: 'flow:packages--cli--check',
          changed_files: ['packages/cli/src/index.ts'],
          tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
        }),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({ category: 'Missing tests', severity: 'medium' }),
      );
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Known flows overlap the diff',
          affected_entities: expect.arrayContaining(['flow:packages--cli--check']),
        }),
      );

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
          readonly affected_flows?: string[];
        };
      }>(join(dir, '.rizz', 'brain', 'latest.json'));
      expect(latest.latest_review_status).toMatchObject({
        status: 'investigate',
        affected_flows: ['flow:packages--cli--check'],
      });
      expect(Number(latest.latest_review_status.findings)).toBeGreaterThanOrEqual(1);
      const report = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(report).toContain('rizz review');
      expect(report).toContain('Affected Flows');
      expect(report).toContain('flow:packages--cli--check');
      expect(report).toContain('Missing tests');
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
});
