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
        'component_intelligence.json',
        'flow_confidence.json',
        'flow_coverage.json',
        'flow_understanding.json',
        'incremental_update.json',
        'benchmark_ready.json',
        'understanding_score.json',
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
      expect(missionControlReport).toContain('Inspect First');

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
          blocking_unknowns: string[];
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
      expect(architectureReasoning.unknowns).toContain(
        '2 reconstructed flow(s) are not verified yet.',
      );
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
      expect(architectureReasoning.confidence_debt.blocking_unknowns).toContain(
        '2 reconstructed flow(s) are not verified yet.',
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
        readiness: { is_ready: boolean; score: number; blocking_gaps: string[] };
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

      const understandingScore = await readJson<{
        schema_version: number;
        overall_score: number;
        score_band: string;
        dimensions: {
          components: { score: number; weak_spots: string[] };
          flows: { score: number; weak_spots: string[] };
          architecture: { score: number; weak_spots: string[] };
          evidence: { score: number; weak_spots: string[] };
          incremental_status: { score: number; weak_spots: string[] };
          review_readiness: { score: number; weak_spots: string[] };
          unknowns: { score: number; weak_spots: string[] };
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
      });
      expect(understandingScore.overall_score).toBeGreaterThan(0);
      expect(understandingScore.score_band).toMatch(/strong|usable|weak|not ready/);
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
      expect(understandingScore.changed).toMatchObject({
        changed_file_count: 1,
        changed_entity_count: incremental.changed_entity_count,
        scan_efficiency_score: incremental.scan_efficiency_score,
      });

      const latest = await readJson<{
        latest_understanding_score: {
          overall_score: number;
          dimensions: {
            components: { score: number };
            flows: { score: number };
            evidence: { score: number };
            review_readiness: { score: number };
          };
          read_first: Array<{ path: string }>;
        };
        latest_incremental_update: {
          changed_file_count: number;
          changed_entity_count: number;
          reused_understanding_count: number;
          recomputed_understanding_count: number;
          stale_fact_count: number;
          scan_efficiency_score: number;
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
      expect(latest.latest_understanding_score).toMatchObject({
        overall_score: understandingScore.overall_score,
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
      const report = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(report).toContain('Project Intelligence');
      expect(report).toContain('Understanding Score');
      expect(report).toContain('Evidence Quality');
      expect(report).toContain('Unknown Risk');
      expect(report).toContain('Mission Control scorecard');
      expect(report).toContain('Components');
      expect(report).toContain('Flows');
      expect(report).toContain('Architecture');
      expect(report).toContain('Confidence Debt');
      expect(report).toContain('Evidence');
      expect(report).toContain('Review Readiness');
      expect(report).toContain('Unknowns');
      expect(report).toContain('Read First');
      expect(report).toContain('Incremental Understanding');
      expect(report).toContain('changed understanding');
      expect(report).toContain('scan efficiency');
      expect(report).toContain('<section class="objects" aria-label="Mission Control objects">');
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
        benchmark_ready: '.rizz/research/benchmark_ready.json',
        understanding_score: '.rizz/research/understanding_score.json',
      });
    });
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
        source_file_coverage_ratio: number;
        test_file_coverage_ratio: number;
        config_file_coverage_ratio: number;
      }>(join(result.value.researchDir, 'flow_coverage.json'));
      expect(flowCoverage.entrypoint_component_coverage_ratio).toBe(1);
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
        cross_component_flows: Array<{ flow_id: string; components: string[] }>;
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
          confidence: 'inferred',
        }),
      );
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
      expect(report).toContain('Confidence Debt');
      expect(report).toContain('Design Pressures');
      expect(report).toContain('Coupling Rationale');
      expect(report).toContain('Evidence Gaps');

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
            confidence_reasons?: string[];
            field_evidence?: Record<string, string[]>;
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
        confidence_reasons: expect.arrayContaining([
          'Entrypoint evidence is recorded.',
          'Validation evidence is recorded.',
          'Side-effect evidence is recorded.',
          'Linked test artifact is recorded.',
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
      });

      const flowUnderstanding = await readJson<{
        flows_with_contracts: number;
        contracts: Array<{
          id: string;
          entry_contract: string[];
          exit_contract: string[];
          side_effects: string[];
          required_tests: string[];
        }>;
      }>(join(result.value.researchDir, 'flow_understanding.json'));
      expect(flowUnderstanding.flows_with_contracts).toBeGreaterThan(0);
      expect(flowUnderstanding.contracts).toContainEqual(
        expect.objectContaining({
          id: flowId,
          side_effects: expect.arrayContaining([
            'State/session/cache/database or filesystem side effect inferred from source.',
          ]),
          required_tests: expect.arrayContaining(['validation failure coverage']),
        }),
      );

      const flowCoverage = await readJson<{
        contract_backed_flow_ratio: number;
        flows: Array<{
          id: string;
          entry_contract: number;
          exit_contract: number;
          side_effects: number;
          required_tests: number;
        }>;
      }>(join(result.value.researchDir, 'flow_coverage.json'));
      expect(flowCoverage.contract_backed_flow_ratio).toBeGreaterThan(0);
      expect(flowCoverage.flows).toContainEqual(
        expect.objectContaining({
          id: flowId,
          entry_contract: expect.any(Number),
          exit_contract: expect.any(Number),
          side_effects: expect.any(Number),
          required_tests: expect.any(Number),
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
        confidence_reasons: expect.arrayContaining(['Validation evidence is recorded.']),
      });
      const explainReport = await readFile(join(dir, '.rizz', 'reports', 'explain.html'), 'utf8');
      expect(explainReport).toContain('Entry Contract');
      expect(explainReport).toContain('Side Effects');
      expect(explainReport).toContain('validation failure coverage');
      expect(explainReport).not.toContain(dir);
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
          '  if (input === undefined) throw new Error("invalid order");',
          '  return { id: "order-1", input };',
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
      expect(ordersFlow?.id).toBe('flow:http--post--orders--src--server.ts');
      expect(ordersFlow?.data).toMatchObject({
        kind: 'api',
        route_type: 'POST',
        files: expect.arrayContaining(['src/server.ts', 'src/orders/service.ts']),
        dependencies: expect.arrayContaining(['dependency:express', 'dependency:fastify']),
        configs: expect.arrayContaining(['package.json', 'tsconfig.json']),
        tests: expect.arrayContaining(['src/orders/orders.test.ts']),
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
        tests: expect.arrayContaining(['evidence:file-src--orders--orders.test.ts']),
      });

      const flowUnderstanding = await readJson<{
        contracts: Array<{
          id: string;
          framework?: string;
          route_path?: string;
          route_type?: string;
          outputs: string[];
        }>;
      }>(join(result.value.researchDir, 'flow_understanding.json'));
      expect(flowUnderstanding.contracts).toContainEqual(
        expect.objectContaining({
          id: 'flow:http--post--orders--src--server.ts',
          framework: 'express-fastify-http',
          route_path: '/orders',
          route_type: 'POST',
          outputs: expect.arrayContaining(['HTTP/API response.']),
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
        entrypoints: expect.arrayContaining([
          expect.objectContaining({ path: 'src/server.ts', symbol: 'POST /orders' }),
        ]),
        outputs: expect.arrayContaining(['HTTP/API response.']),
      });
      const explainReport = await readFile(join(dir, '.rizz', 'reports', 'explain.html'), 'utf8');
      expect(explainReport).toContain('POST /orders');
      expect(explainReport).toContain('HTTP POST /orders route enters src/server.ts');
      expect(explainReport).not.toContain(dir);
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
          evidence_gap_ids: expect.arrayContaining([`gap:${docsPage.id}:runtime-verification`]),
          confidence: 'inferred',
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
          unknowns: expect.arrayContaining([expect.stringContaining('not runtime verified')]),
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
          '/docs/[slug] route flow (page) includes changed component evidence: src/components/DocPage.tsx.',
          '/docs/[slug] route flow (page) includes changed config evidence: next.config.ts.',
          '/docs/[slug] route flow (page) includes changed content evidence: src/content/docs.ts.',
          '/docs/[slug] route flow (page) includes changed entrypoint evidence: src/app/docs/[slug]/page.tsx.',
          '/docs/[slug] route flow (page) includes changed test evidence: src/app/docs/[slug]/page.test.tsx.',
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
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({
          title: 'Known flows overlap the diff',
          description: expect.stringContaining('/docs/[slug] route flow (page)'),
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
      expect(report).toContain('Review Blast Radius');
      expect(report).toContain('Unknown Risk');
      expect(report).toContain('Raw Artifacts');
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
        top_evidence_gaps: expect.any(Array),
        top_uncertain_areas: expect.any(Array),
      });
      expect(evidenceQuality.redacted_evidence_count).toBeGreaterThan(0);
      expect(JSON.stringify(evidenceQuality)).not.toContain('client_secret_handler.ts');
      expect(JSON.stringify(evidenceQuality)).not.toContain('OPENAI_API_KEY');
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
      expect(result.value.review.review_evidence_summary).toMatchObject({
        changed_files: 1,
        direct_components: 1,
        dependent_components: 0,
        affected_flows: 1,
        affected_tests: expect.arrayContaining(['packages/cli/src/index.test.ts']),
        affected_configs: expect.arrayContaining(['packages/cli/package.json']),
      });
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
          readonly direct_affected_components?: string[];
          readonly dependent_components?: string[];
          readonly affected_flows?: string[];
          readonly blast_radius_reasons?: string[];
        };
      }>(join(dir, '.rizz', 'brain', 'latest.json'));
      expect(latest.latest_review_status).toMatchObject({
        status: 'investigate',
        direct_affected_components: ['component:packages--cli'],
        dependent_components: [],
        affected_flows: ['flow:packages--cli--check'],
      });
      expect(latest.latest_review_status.blast_radius_reasons).toContainEqual(
        expect.stringContaining('affected flow(s) link the change'),
      );
      expect(Number(latest.latest_review_status.findings)).toBeGreaterThanOrEqual(1);
      const report = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(report).toContain('rizz review');
      expect(report).toContain('Blast Radius Evidence');
      expect(report).toContain('Direct Components');
      expect(report).toContain('Dependent Components');
      expect(report).toContain('Affected Flows');
      expect(report).toContain('flow:packages--cli--check');
      expect(report).toContain('packages/cli/package.json');
      expect(report).toContain('Missing tests');
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
      expect(result.value.review.review_evidence_summary).toMatchObject({
        direct_components: 1,
        dependent_components: 1,
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
});
