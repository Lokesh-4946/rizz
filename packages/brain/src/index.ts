import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, readFileSync, statSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import {
  classifySensitivePath,
  containsSensitiveReference,
  redactSensitiveText,
  redactedReferenceCount,
  sensitiveIdentityKey,
  shouldOmitSensitivePath,
  unredactedSensitiveReferenceCount,
} from './sensitivity.js';

type Confidence = 'verified' | 'inferred' | 'uncertain';

type ReasoningType = 'component' | 'flow' | 'architecture' | 'review';

type ComponentBoundaryType =
  | 'entrypoint'
  | 'orchestration'
  | 'service'
  | 'adapter'
  | 'interface'
  | 'automation'
  | 'knowledge'
  | 'quality'
  | 'source'
  | 'unknown';

type EntityType =
  | 'project'
  | 'file'
  | 'folder'
  | 'component'
  | 'service'
  | 'api'
  | 'database/table'
  | 'config'
  | 'dependency'
  | 'command'
  | 'test'
  | 'flow'
  | 'decision'
  | 'risk'
  | 'agent'
  | 'task'
  | 'session'
  | 'handoff'
  | 'review'
  | 'finding'
  | 'evidence'
  | 'status';

type LatestStatus = 'new' | 'current' | 'changed' | 'stale' | 'open' | 'completed';

interface BrainEntity {
  readonly id: string;
  readonly type: EntityType;
  readonly name: string;
  readonly description: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly related_entity_ids: readonly string[];
  readonly source_files: readonly string[];
  readonly latest_status: LatestStatus;
  readonly data?: Record<string, unknown>;
}

interface BrainRelationship {
  readonly from: string;
  readonly relation:
    | 'owns'
    | 'depends_on'
    | 'used_by'
    | 'calls'
    | 'imports'
    | 'exposes'
    | 'configures'
    | 'tests'
    | 'breaks_if_removed'
    | 'changed_by'
    | 'reviewed_by'
    | 'handed_off_to'
    | 'produced'
    | 'supersedes'
    | 'contradicts'
    | 'related_to';
  readonly to: string;
  readonly evidence_ids: readonly string[];
  readonly confidence: Confidence;
}

interface ReasoningTrace {
  readonly trace_id: string;
  readonly entity_id: string;
  readonly reasoning_type: ReasoningType;
  readonly claim: string;
  readonly evidence_ids: readonly string[];
  readonly confidence: Confidence;
  readonly confidence_score: number;
  readonly rules: readonly string[];
  readonly unknowns: readonly string[];
  readonly redacted_evidence_count: number;
}

type ArchitecturePressureType = 'boundary' | 'coupling' | 'config' | 'dependency' | 'flow';

type ArchitecturePressureStrength = 'low' | 'medium' | 'high';

interface ArchitectureAssumption {
  readonly assumption_id: string;
  readonly entity_id: string;
  readonly assumption: string;
  readonly inferred_from: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly evidence_gap_ids: readonly string[];
  readonly confidence: Confidence;
  readonly confidence_score: number;
  readonly rules: readonly string[];
  readonly unknowns: readonly string[];
}

interface ArchitectureDesignPressure {
  readonly pressure_id: string;
  readonly entity_id: string;
  readonly pressure_type: ArchitecturePressureType;
  readonly pressure: string;
  readonly strength: ArchitecturePressureStrength;
  readonly evidence_ids: readonly string[];
  readonly rules: readonly string[];
}

interface ArchitectureBoundaryRationale {
  readonly component_id: string;
  readonly boundary_type: string;
  readonly rationale: string;
  readonly evidence_ids: readonly string[];
  readonly confidence: Confidence;
  readonly rules: readonly string[];
  readonly unknowns: readonly string[];
}

interface ArchitectureCouplingRationale {
  readonly component_id: string;
  readonly coupling_level: ComponentIntelligence['coupling']['level'];
  readonly coupling_score: number;
  readonly rationale: string;
  readonly intentional_coupling: boolean;
  readonly risky_coupling: boolean;
  readonly evidence_ids: readonly string[];
  readonly rules: readonly string[];
  readonly unknowns: readonly string[];
}

interface ArchitectureEvidenceGap {
  readonly gap_id: string;
  readonly entity_id: string;
  readonly gap: string;
  readonly severity: ArchitecturePressureStrength;
  readonly evidence_ids: readonly string[];
  readonly rules: readonly string[];
}

interface FileFact {
  readonly relativePath: string;
  readonly size: number;
  readonly extension: string;
  readonly hash: string;
}

interface IgnorePattern {
  readonly pattern: string;
  readonly negated: boolean;
}

interface PackageJsonFact {
  readonly relativePath: string;
  readonly name?: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

interface ComponentIntelligence {
  readonly purpose: string;
  readonly boundary_type: ComponentBoundaryType;
  readonly responsibilities: readonly string[];
  readonly interfaces: readonly string[];
  readonly entry_points: readonly string[];
  readonly consumers: readonly string[];
  readonly dependencies: readonly string[];
  readonly dependency_roles: readonly string[];
  readonly exposed_apis: readonly string[];
  readonly tests: readonly string[];
  readonly configs: readonly string[];
  readonly coupling: {
    readonly level: 'low' | 'medium' | 'high';
    readonly score: number;
    readonly static_import_count: number;
    readonly internal_imports: readonly string[];
    readonly external_imports: readonly string[];
    readonly reasons: readonly string[];
  };
  readonly criticality: 'low' | 'medium' | 'high';
  readonly criticality_score: number;
  readonly blast_radius: BlastRadius;
  readonly ownership_confidence: {
    readonly score: number;
    readonly reason: string;
    readonly signals: readonly string[];
  };
  readonly tradeoffs: readonly string[];
  readonly failure_modes: readonly string[];
  readonly what_breaks_if_removed: readonly string[];
  readonly risky_seams: readonly string[];
  readonly important_files: readonly string[];
  readonly read_first: readonly string[];
  readonly known_risks: readonly string[];
  readonly unknowns: readonly string[];
  readonly field_evidence: Readonly<Record<string, readonly string[]>>;
  readonly signals: readonly string[];
}

type FlowKind = 'api' | 'cli' | 'job' | 'ui' | 'config' | 'test' | 'unknown';

type FlowEntrypointType = 'route' | 'command' | 'function' | 'script' | 'file' | 'config';

type NextAppRouteType = 'api' | 'layout' | 'metadata' | 'page';

type FlowStepType =
  | 'route'
  | 'handler'
  | 'service'
  | 'function'
  | 'config'
  | 'dependency'
  | 'test'
  | 'external';

type FlowRiskKind =
  | 'missing_test'
  | 'missing_config'
  | 'weak_evidence'
  | 'orphan_step'
  | 'changed_hotspot';

interface FlowEntrypoint {
  readonly type: FlowEntrypointType;
  readonly path: string;
  readonly symbol: string | null;
  readonly component_id?: string | null;
  readonly evidence: readonly string[];
}

interface FlowStep {
  readonly step_id: string;
  readonly order: number;
  readonly type: FlowStepType;
  readonly path: string;
  readonly symbol: string | null;
  readonly description: string;
  readonly evidence: readonly string[];
}

interface FlowRisk {
  readonly risk_id: string;
  readonly kind: FlowRiskKind;
  readonly description: string;
  readonly evidence: readonly string[];
}

interface FlowConfidence {
  readonly score: number;
  readonly reason: string;
}

interface FlowEvidence {
  readonly path: string;
  readonly line_start: number;
  readonly line_end: number;
  readonly reason: string;
}

interface PathAliasPattern {
  readonly pattern: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly targets: readonly {
    readonly pattern: string;
    readonly prefix: string;
    readonly suffix: string;
  }[];
}

interface ImportAliasContext {
  readonly baseUrls: readonly string[];
  readonly pathAliases: readonly PathAliasPattern[];
}

interface FlowContractSummary {
  readonly entry_contract: readonly string[];
  readonly exit_contract: readonly string[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly side_effects: readonly string[];
  readonly state_transitions: readonly string[];
  readonly failure_modes: readonly string[];
  readonly required_tests: readonly string[];
  readonly confidence_reasons: readonly string[];
  readonly field_evidence: Readonly<Record<string, readonly string[]>>;
}

interface RouteContractContext {
  readonly framework: 'nextjs-app-router';
  readonly route_path: string;
  readonly route_type: NextAppRouteType;
  readonly entry_file: string;
}

interface FlowIntelligence {
  readonly flow_id: string;
  readonly name: string;
  readonly kind: FlowKind;
  readonly framework?: string;
  readonly route_path?: string;
  readonly route_type?: NextAppRouteType;
  readonly entrypoints: readonly FlowEntrypoint[];
  readonly steps: readonly FlowStep[];
  readonly components: readonly string[];
  readonly files: readonly string[];
  readonly dependencies: readonly string[];
  readonly configs: readonly string[];
  readonly tests: readonly string[];
  readonly risks: readonly FlowRisk[];
  readonly entry_contract: readonly string[];
  readonly exit_contract: readonly string[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly side_effects: readonly string[];
  readonly state_transitions: readonly string[];
  readonly failure_modes: readonly string[];
  readonly required_tests: readonly string[];
  readonly confidence_reasons: readonly string[];
  readonly confidence: FlowConfidence;
  readonly evidence: readonly FlowEvidence[];
  readonly field_evidence: Readonly<Record<string, readonly string[]>>;
  readonly unknowns: readonly string[];
  readonly signals: readonly string[];
}

interface PreviousFileFact {
  readonly id: string;
  readonly relativePath: string;
  readonly pathKey: string;
  readonly hash: string;
  readonly createdAt: string;
}

interface PreviousUnderstandingState {
  readonly entities: readonly BrainEntity[];
  readonly relationships: readonly BrainRelationship[];
  readonly fingerprint: string | null;
}

interface IncrementalUnderstandingMetrics {
  readonly generated_at: string;
  readonly previous_brain_fingerprint: string | null;
  readonly current_brain_fingerprint: string;
  readonly scanned_files: number;
  readonly changed_files: readonly string[];
  readonly changed_file_count: number;
  readonly stale_files: readonly string[];
  readonly stale_file_count: number;
  readonly file_status_counts: Readonly<Record<string, number>>;
  readonly reused_files: number;
  readonly recomputed_files: number;
  readonly file_reuse_ratio: number;
  readonly current_files: readonly string[];
  readonly new_files: readonly string[];
  readonly affected_flows: readonly string[];
  readonly previous_entity_count: number;
  readonly current_entity_count: number;
  readonly added_entity_count: number;
  readonly removed_entity_count: number;
  readonly changed_entity_count: number;
  readonly stable_entity_count: number;
  readonly added_entities: readonly IncrementalEntityDelta[];
  readonly removed_entities: readonly IncrementalEntityDelta[];
  readonly changed_entities: readonly IncrementalEntityDelta[];
  readonly relationship_delta: IncrementalRelationshipDelta;
  readonly evidence_delta: IncrementalEvidenceDelta;
  readonly reused_understanding_count: number;
  readonly recomputed_understanding_count: number;
  readonly stale_fact_count: number;
  readonly stale_fact_candidates: readonly string[];
  readonly scan_efficiency_score: number;
}

interface IncrementalEntityDelta {
  readonly id: string;
  readonly type: EntityType;
  readonly name: string;
}

interface IncrementalRelationshipDelta {
  readonly previous_count: number;
  readonly current_count: number;
  readonly added_count: number;
  readonly removed_count: number;
  readonly changed_count: number;
  readonly added: readonly IncrementalRelationshipItem[];
  readonly removed: readonly IncrementalRelationshipItem[];
  readonly changed: readonly IncrementalRelationshipItem[];
}

interface IncrementalRelationshipItem {
  readonly from: string;
  readonly relation: BrainRelationship['relation'];
  readonly to: string;
}

interface IncrementalEvidenceDelta {
  readonly previous_count: number;
  readonly current_count: number;
  readonly added_count: number;
  readonly removed_count: number;
  readonly changed_count: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

interface EntitySemanticValue {
  readonly id: string;
  readonly type: EntityType;
  readonly name: string;
  readonly description: string;
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly related_entity_ids: readonly string[];
  readonly source_files: readonly string[];
  readonly data: unknown;
}

interface BrainBuckets {
  readonly projects: BrainEntity[];
  readonly files: BrainEntity[];
  readonly folders: BrainEntity[];
  readonly components: BrainEntity[];
  readonly services: BrainEntity[];
  readonly apis: BrainEntity[];
  readonly databaseTables: BrainEntity[];
  readonly configs: BrainEntity[];
  readonly dependencies: BrainEntity[];
  readonly commands: BrainEntity[];
  readonly tests: BrainEntity[];
  readonly flows: BrainEntity[];
  readonly decisions: BrainEntity[];
  readonly risks: BrainEntity[];
  readonly agents: BrainEntity[];
  readonly tasks: BrainEntity[];
  readonly sessions: BrainEntity[];
  readonly handoffs: BrainEntity[];
  readonly reviews: BrainEntity[];
  readonly findings: BrainEntity[];
  readonly evidence: BrainEntity[];
  readonly status: BrainEntity[];
}

type ReviewSeverity = 'low' | 'medium' | 'high' | 'critical';

type ReviewCategory =
  | 'Correctness'
  | 'Regression risk'
  | 'Architecture drift'
  | 'Hidden coupling'
  | 'Missing tests'
  | 'Security'
  | 'Performance'
  | 'Maintainability'
  | 'Backward compatibility'
  | 'Overengineering';

type OverallRisk = 'low' | 'medium' | 'high' | 'critical';

type BlastRadius = 'narrow' | 'moderate' | 'broad';

type RecommendedAction = 'approve' | 'request changes' | 'investigate';

interface ReviewFindingData {
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly category: ReviewCategory;
  readonly title: string;
  readonly description: string;
  readonly affected_files: readonly string[];
  readonly affected_entities: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly confidence: Confidence;
  readonly recommendation: string;
  readonly safer_alternative?: string;
}

interface AffectedFlowData {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly confidence: Confidence;
  readonly score: number;
  readonly changed_files: readonly string[];
  readonly components: readonly string[];
  readonly tests: readonly string[];
  readonly configs: readonly string[];
  readonly risks: number;
  readonly evidence_ids: readonly string[];
}

interface ReviewAffectedComponentData {
  readonly id: string;
  readonly name: string;
  readonly boundary_type: string;
  readonly criticality: string;
  readonly blast_radius: string;
  readonly changed_files: readonly string[];
  readonly affected_flows: readonly string[];
  readonly tests: readonly string[];
  readonly configs: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly reason: string;
}

interface ReviewAffectedRelationshipData {
  readonly from: string;
  readonly relation: BrainRelationship['relation'];
  readonly to: string;
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
}

interface ReviewEvidenceSummaryData {
  readonly changed_files: number;
  readonly direct_components: number;
  readonly dependent_components: number;
  readonly affected_flows: number;
  readonly affected_tests: readonly string[];
  readonly affected_configs: readonly string[];
  readonly evidence_ids: readonly string[];
}

interface ReviewSummaryData {
  readonly id: string;
  readonly generated_at: string;
  readonly changed_files: readonly string[];
  readonly direct_affected_components: readonly ReviewAffectedComponentData[];
  readonly dependent_components: readonly ReviewAffectedComponentData[];
  readonly affected_components: readonly string[];
  readonly affected_flows: readonly AffectedFlowData[];
  readonly affected_relationships: readonly ReviewAffectedRelationshipData[];
  readonly affected_entities: readonly string[];
  readonly blast_radius_reasons: readonly string[];
  readonly review_evidence_summary: ReviewEvidenceSummaryData;
  readonly findings: readonly ReviewFindingData[];
  readonly overall_risk: OverallRisk;
  readonly surgicality_score: number;
  readonly blast_radius: BlastRadius;
  readonly required_tests: readonly string[];
  readonly suggested_reviewer_focus_areas: readonly string[];
  readonly recommended_action: RecommendedAction;
}

interface ExplainSummaryData {
  readonly generated_at: string;
  readonly target: string;
  readonly resolved_entity_id: string;
  readonly entity_type: EntityType;
  readonly summary: string;
  readonly purpose: string;
  readonly responsibilities: readonly string[];
  readonly dependencies: readonly string[];
  readonly dependency_roles: readonly string[];
  readonly consumers: readonly string[];
  readonly important_files: readonly string[];
  readonly entry_points: readonly string[];
  readonly tests: readonly string[];
  readonly configs: readonly string[];
  readonly tradeoffs: readonly string[];
  readonly failure_modes: readonly string[];
  readonly breaks_if_changed: readonly string[];
  readonly risks: readonly string[];
  readonly read_first: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly depends_on: readonly string[];
  readonly depended_on_by: readonly string[];
  readonly confidence: Confidence;
  readonly unknowns: readonly string[];
  readonly component?: {
    readonly boundary_type: string;
    readonly criticality: string;
    readonly criticality_score?: number;
    readonly ownership_confidence?: {
      readonly score?: number;
      readonly reason?: string;
      readonly signals?: readonly string[];
    };
  };
  readonly flow?: {
    readonly kind: FlowKind;
    readonly framework?: string;
    readonly route_path?: string;
    readonly route_type?: string;
    readonly entrypoints: readonly FlowEntrypoint[];
    readonly steps: readonly FlowStep[];
    readonly components: readonly string[];
    readonly files: readonly string[];
    readonly dependencies: readonly string[];
    readonly tests: readonly string[];
    readonly configs: readonly string[];
    readonly risks: readonly FlowRisk[];
    readonly entry_contract: readonly string[];
    readonly exit_contract: readonly string[];
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
    readonly side_effects: readonly string[];
    readonly state_transitions: readonly string[];
    readonly failure_modes: readonly string[];
    readonly required_tests: readonly string[];
    readonly confidence_reasons: readonly string[];
    readonly confidence_score: number;
    readonly confidence_reason: string;
  };
}

export interface GenerateProjectBrainOptions {
  readonly rootDir: string;
  readonly now?: Date;
  readonly maxFiles?: number;
}

export interface GenerateProjectBrainSummary {
  readonly rootDir: string;
  readonly brainDir: string;
  readonly researchDir: string;
  readonly latestPath: string;
  readonly reportPath: string;
  readonly scannedFiles: number;
  readonly changedFiles: number;
  readonly staleFiles: number;
  readonly components: number;
  readonly flows: number;
  readonly commands: number;
  readonly tests: number;
}

export type GenerateProjectBrainResult =
  | { readonly ok: true; readonly value: GenerateProjectBrainSummary }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface ReviewProjectChangesOptions {
  readonly rootDir: string;
  readonly now?: Date;
  readonly json?: boolean;
}

export interface ReviewProjectChangesSummary {
  readonly rootDir: string;
  readonly reviewPath: string;
  readonly latestPath: string;
  readonly reportPath: string;
  readonly changedFiles: number;
  readonly affectedComponents: number;
  readonly affectedFlows: number;
  readonly findings: number;
  readonly overallRisk: OverallRisk;
  readonly surgicalityScore: number;
  readonly blastRadius: BlastRadius;
  readonly recommendedAction: RecommendedAction;
  readonly review: ReviewSummaryData;
}

export type ReviewProjectChangesResult =
  | { readonly ok: true; readonly value: ReviewProjectChangesSummary }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface ExplainProjectTargetOptions {
  readonly rootDir: string;
  readonly target: string;
  readonly now?: Date;
}

export interface ExplainProjectTargetSummary {
  readonly rootDir: string;
  readonly latestPath: string;
  readonly reportPath: string;
  readonly targetId: string;
  readonly confidence: Confidence;
  readonly explanation: ExplainSummaryData;
}

export type ExplainProjectTargetResult =
  | { readonly ok: true; readonly value: ExplainProjectTargetSummary }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

const ENTITY_FILES: ReadonlyArray<readonly [keyof BrainBuckets, string, EntityType]> = [
  ['projects', 'project.json', 'project'],
  ['files', 'files.json', 'file'],
  ['folders', 'folders.json', 'folder'],
  ['components', 'components.json', 'component'],
  ['services', 'services.json', 'service'],
  ['apis', 'APIs.json', 'api'],
  ['databaseTables', 'database_tables.json', 'database/table'],
  ['configs', 'configs.json', 'config'],
  ['dependencies', 'dependencies.json', 'dependency'],
  ['commands', 'commands.json', 'command'],
  ['tests', 'tests.json', 'test'],
  ['flows', 'flows.json', 'flow'],
  ['decisions', 'decisions.json', 'decision'],
  ['risks', 'risks.json', 'risk'],
  ['agents', 'agents.json', 'agent'],
  ['tasks', 'tasks.json', 'task'],
  ['sessions', 'sessions.json', 'session'],
  ['handoffs', 'handoffs.json', 'handoff'],
  ['reviews', 'reviews.json', 'review'],
  ['findings', 'findings.json', 'finding'],
  ['evidence', 'evidence.json', 'evidence'],
  ['status', 'status.json', 'status'],
];

const RESEARCH_ARTIFACT_FILES = {
  metrics: 'metrics.json',
  coverage: 'coverage.json',
  confidence: 'confidence.json',
  reasoningTraces: 'reasoning_traces.json',
  componentIntelligence: 'component_intelligence.json',
  evidenceQuality: 'evidence_quality.json',
  incrementalUpdate: 'incremental_update.json',
  flowUnderstanding: 'flow_understanding.json',
  flowCoverage: 'flow_coverage.json',
  flowConfidence: 'flow_confidence.json',
  architectureReasoning: 'architecture_reasoning.json',
  benchmarkReady: 'benchmark_ready.json',
  understandingScore: 'understanding_score.json',
} as const;

const IGNORED_DIRS = new Set([
  '.agents',
  '.cache',
  '.claude',
  '.codex',
  '.git',
  '.rizz',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'dist-pack',
  'logs',
  'node_modules',
  'out',
  'target',
]);

const IGNORED_FILE_NAMES = new Set(['.DS_Store', 'tsconfig.tsbuildinfo']);

const IGNORED_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.bin',
  '.bmp',
  '.class',
  '.dmg',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp4',
  '.pdf',
  '.png',
  '.pyo',
  '.tar',
  '.tgz',
  '.webp',
  '.zip',
]);

const CONFIG_FILES = new Set([
  '.env.example',
  'Dockerfile',
  'Makefile',
  'docker-compose.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pyproject.toml',
  'requirements.txt',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'tsconfig.json',
  'vite.config.ts',
]);

function shouldSkipFile(name: string): boolean {
  if (shouldOmitSensitivePath(name)) return true;
  if (name.endsWith('.log')) return true;
  if (IGNORED_FILE_NAMES.has(name)) return true;
  if (IGNORED_EXTENSIONS.has(extname(name).toLowerCase())) return true;
  return false;
}

function shouldSkipRelativePath(
  relativePath: string,
  ignorePatterns: readonly IgnorePattern[],
): boolean {
  const parts = relativePath.split('/');
  if (parts.some((part) => IGNORED_DIRS.has(part))) return true;
  if (shouldOmitSensitivePath(relativePath)) return true;
  const name = parts[parts.length - 1] ?? relativePath;
  if (shouldSkipFile(name)) return true;
  return isIgnoredByPatterns(relativePath, ignorePatterns);
}

function parseIgnoreFile(content: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const negated = trimmed.startsWith('!');
    const pattern = (negated ? trimmed.slice(1) : trimmed).replace(/\\/g, '/').replace(/^\//, '');
    if (pattern !== '') patterns.push({ pattern, negated });
  }
  return patterns;
}

async function readRizzIgnore(rootDir: string): Promise<IgnorePattern[]> {
  try {
    return parseIgnoreFile(await readFile(join(rootDir, '.rizzignore'), 'utf8'));
  } catch {
    return [];
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function patternMatches(pattern: string, relativePath: string): boolean {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\//, '');
  if (normalized.endsWith('/')) {
    const prefix = normalized.slice(0, -1);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  }
  if (!normalized.includes('*')) {
    if (!normalized.includes('/')) return relativePath.split('/').includes(normalized);
    return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
  }
  const regex = new RegExp(
    `^${normalized
      .split('*')
      .map((part) => escapeRegex(part))
      .join('.*')}$`,
  );
  if (regex.test(relativePath)) return true;
  if (!normalized.includes('/')) return regex.test(basename(relativePath));
  return false;
}

function isIgnoredByPatterns(relativePath: string, patterns: readonly IgnorePattern[]): boolean {
  let ignored = false;
  for (const pattern of patterns) {
    if (!patternMatches(pattern.pattern, relativePath)) continue;
    ignored = !pattern.negated;
  }
  return ignored;
}

function emptyBuckets(): BrainBuckets {
  return {
    projects: [],
    files: [],
    folders: [],
    components: [],
    services: [],
    apis: [],
    databaseTables: [],
    configs: [],
    dependencies: [],
    commands: [],
    tests: [],
    flows: [],
    decisions: [],
    risks: [],
    agents: [],
    tasks: [],
    sessions: [],
    handoffs: [],
    reviews: [],
    findings: [],
    evidence: [],
    status: [],
  };
}

function stableSlug(value: string): string {
  const cleaned = value
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'root' : cleaned.replace(/\//g, '--');
}

function entityId(type: EntityType, name: string): string {
  const classification = classifySensitivePath(name);
  if (classification.isSensitive) return `${type}:${classification.redactedId}`;
  return `${type}:${stableSlug(safeText(name))}`;
}

function evidenceId(relativePath: string): string {
  const classification = classifySensitivePath(relativePath);
  if (classification.isSensitive) return `evidence:${classification.redactedId}`;
  return `evidence:file-${stableSlug(safeText(relativePath))}`;
}

function jsonString(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeText(value: string): string {
  return redactSensitiveText(value);
}

function safeBrainValue(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(safeBrainValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [safeText(key), safeBrainValue(item)]),
  );
}

function safeResearchValue(value: unknown): unknown {
  return safeBrainValue(value);
}

function sorted<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeVerifiedFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  const written = await readFile(path, 'utf8');
  if (written !== contents) throw new Error(`write verification failed for ${path}`);
}

async function scanFiles(
  rootDir: string,
  maxFiles: number,
  ignorePatterns: readonly IgnorePattern[],
): Promise<FileFact[]> {
  const facts: FileFact[] = [];

  async function walk(dir: string): Promise<void> {
    if (facts.length >= maxFiles) return;
    const entries = sorted(await readdir(dir, { withFileTypes: true }), (entry) => entry.name);
    for (const entry of entries) {
      if (facts.length >= maxFiles) return;
      const absolutePath = join(dir, entry.name);
      const rel = relative(rootDir, absolutePath).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!shouldSkipRelativePath(rel, ignorePatterns)) await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipRelativePath(rel, ignorePatterns)) continue;
      const fileStat = await stat(absolutePath);
      if (fileStat.size > 1_000_000) continue;
      const content = await readFile(absolutePath);
      facts.push({
        relativePath: rel,
        size: fileStat.size,
        extension: extname(entry.name),
        hash: createHash('sha256').update(content).digest('hex'),
      });
    }
  }

  await walk(rootDir);
  return sorted(facts, (fact) => fact.relativePath);
}

async function readPackageJsonFacts(
  rootDir: string,
  files: readonly FileFact[],
): Promise<PackageJsonFact[]> {
  const facts: PackageJsonFact[] = [];
  for (const file of files) {
    if (!file.relativePath.endsWith('package.json')) continue;
    const raw = await readJsonFile<Record<string, unknown>>(join(rootDir, file.relativePath));
    if (raw === undefined) continue;
    const scripts = asStringRecord(raw.scripts);
    const dependencies = asStringRecord(raw.dependencies);
    const devDependencies = asStringRecord(raw.devDependencies);
    facts.push({
      relativePath: file.relativePath,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      scripts,
      dependencies,
      devDependencies,
    });
  }
  return facts;
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

function previousFileFacts(
  entities: readonly BrainEntity[] | undefined,
): Map<string, PreviousFileFact> {
  const out = new Map<string, PreviousFileFact>();
  for (const entity of entities ?? []) {
    const relativePath =
      typeof entity.data?.relativePath === 'string' ? entity.data.relativePath : undefined;
    const pathKey = typeof entity.data?.path_key === 'string' ? entity.data.path_key : undefined;
    const hash = typeof entity.data?.hash === 'string' ? entity.data.hash : undefined;
    if (relativePath === undefined || hash === undefined) continue;
    out.set(pathKey ?? sensitiveIdentityKey(relativePath), {
      id: entity.id,
      relativePath,
      pathKey: pathKey ?? sensitiveIdentityKey(relativePath),
      hash,
      createdAt: entity.created_at,
    });
  }
  return out;
}

function downgradeConfidenceForRedaction(confidence: Confidence): Confidence {
  if (confidence === 'verified') return 'inferred';
  if (confidence === 'inferred') return 'uncertain';
  return 'uncertain';
}

function mergeUnknownsForRedaction(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const redactionUnknown =
    'Some evidence labels were redacted because filenames or paths are sensitive.';
  if (data === undefined) return { unknowns: [redactionUnknown] };
  const existingUnknowns = Array.isArray(data.unknowns)
    ? data.unknowns.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    ...data,
    unknowns: unique([...existingUnknowns, redactionUnknown]),
  };
}

function previousEntityMap(entities: readonly BrainEntity[] | undefined): Map<string, BrainEntity> {
  const out = new Map<string, BrainEntity>();
  for (const entity of entities ?? []) out.set(entity.id, entity);
  return out;
}

const UNDERSTANDING_ENTITY_TYPES = new Set<EntityType>([
  'project',
  'file',
  'folder',
  'component',
  'service',
  'api',
  'database/table',
  'config',
  'dependency',
  'command',
  'test',
  'flow',
  'decision',
  'risk',
  'task',
  'evidence',
]);

async function readPreviousUnderstandingState(
  entitiesDir: string,
  graphPath: string,
): Promise<PreviousUnderstandingState> {
  const entities: BrainEntity[] = [];
  for (const [, fileName] of ENTITY_FILES) {
    const entityFile = await readJsonFile<{ readonly entities?: readonly BrainEntity[] }>(
      join(entitiesDir, fileName),
    );
    entities.push(...(entityFile?.entities ?? []));
  }
  const graph = await readJsonFile<{ readonly relationships?: readonly BrainRelationship[] }>(
    graphPath,
  );
  const understandingEntities = filterUnderstandingEntities(entities);
  const relationships = graph?.relationships ?? [];
  return {
    entities,
    relationships,
    fingerprint:
      understandingEntities.length === 0 && relationships.length === 0
        ? null
        : brainFingerprint(understandingEntities, relationships),
  };
}

function filterUnderstandingEntities(entities: readonly BrainEntity[]): BrainEntity[] {
  return entities.filter((entity) => UNDERSTANDING_ENTITY_TYPES.has(entity.type));
}

function brainFingerprint(
  entities: readonly BrainEntity[],
  relationships: readonly BrainRelationship[],
): string {
  return stableHash({
    entities: sorted(entities.map(entitySemanticValue), (entity) => entity.id),
    relationships: sorted(relationships.map(relationshipSemanticValue), relationshipDeltaKey),
  });
}

function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(safeBrainValue(value))))
    .digest('hex');
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

function entitySemanticValue(entity: BrainEntity): EntitySemanticValue {
  return {
    id: entity.id,
    type: entity.type,
    name: entity.name,
    description: entity.description,
    confidence: entity.confidence,
    evidence_ids: unique([...entity.evidence_ids]),
    related_entity_ids: unique([...entity.related_entity_ids]),
    source_files: unique([...entity.source_files]),
    data: entity.data ?? {},
  };
}

function entitySemanticHash(entity: BrainEntity): string {
  return stableHash(entitySemanticValue(entity));
}

function relationshipSemanticValue(relationship: BrainRelationship): IncrementalRelationshipItem & {
  readonly confidence: Confidence;
  readonly evidence_ids: string[];
} {
  return {
    from: relationship.from,
    relation: relationship.relation,
    to: relationship.to,
    confidence: relationship.confidence,
    evidence_ids: unique([...relationship.evidence_ids]),
  };
}

function relationshipDeltaKey(relationship: IncrementalRelationshipItem): string {
  return `${relationship.from}\u0000${relationship.relation}\u0000${relationship.to}`;
}

function relationshipSemanticHash(relationship: BrainRelationship): string {
  return stableHash(relationshipSemanticValue(relationship));
}

function incrementalEntityDelta(entity: BrainEntity): IncrementalEntityDelta {
  return { id: entity.id, type: entity.type, name: entity.name };
}

function relationshipDeltaItem(relationship: BrainRelationship): IncrementalRelationshipItem {
  return {
    from: relationship.from,
    relation: relationship.relation,
    to: relationship.to,
  };
}

function makeEntity(params: {
  readonly id: string;
  readonly type: EntityType;
  readonly name: string;
  readonly description: string;
  readonly now: string;
  readonly createdAt?: string;
  readonly confidence?: Confidence;
  readonly evidenceIds?: readonly string[];
  readonly relatedEntityIds?: readonly string[];
  readonly sourceFiles?: readonly string[];
  readonly latestStatus?: LatestStatus;
  readonly data?: Record<string, unknown>;
}): BrainEntity {
  const redactionCount = redactedReferenceCount([
    params.id,
    params.name,
    params.description,
    params.evidenceIds ?? [],
    params.relatedEntityIds ?? [],
    params.sourceFiles ?? [],
    params.data ?? {},
  ]);
  const baseConfidence = params.confidence ?? 'verified';
  const confidence =
    redactionCount > 0 ? downgradeConfidenceForRedaction(baseConfidence) : baseConfidence;
  const data =
    redactionCount > 0
      ? {
          ...mergeUnknownsForRedaction(params.data),
          redacted_evidence_count: redactionCount,
        }
      : params.data;
  return {
    id: params.id,
    type: params.type,
    name: params.name,
    description: params.description,
    created_at: params.createdAt ?? params.now,
    updated_at: params.now,
    confidence,
    evidence_ids: unique(params.evidenceIds ?? []),
    related_entity_ids: unique(params.relatedEntityIds ?? []),
    source_files: unique(params.sourceFiles ?? []),
    latest_status: params.latestStatus ?? 'current',
    ...(data !== undefined ? { data } : {}),
  };
}

function detectPackageManager(files: readonly FileFact[]): string {
  const names = new Set(files.map((file) => file.relativePath));
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  if (names.has('package-lock.json')) return 'npm';
  if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun';
  return 'unknown';
}

function detectTechStack(
  files: readonly FileFact[],
  packages: readonly PackageJsonFact[],
): string[] {
  const stack = new Set<string>();
  if (packages.length > 0) stack.add('Node.js');
  if (files.some((file) => file.extension === '.ts' || file.extension === '.tsx'))
    stack.add('TypeScript');
  if (files.some((file) => file.extension === '.py')) stack.add('Python');
  if (packages.some((pkg) => 'react' in pkg.dependencies || 'react' in pkg.devDependencies))
    stack.add('React');
  if (packages.some((pkg) => 'vitest' in pkg.dependencies || 'vitest' in pkg.devDependencies))
    stack.add('Vitest');
  if (
    packages.some((pkg) => 'typescript' in pkg.dependencies || 'typescript' in pkg.devDependencies)
  ) {
    stack.add('TypeScript build');
  }
  return [...stack].sort((a, b) => a.localeCompare(b));
}

function folderPaths(files: readonly FileFact[]): string[] {
  const folders = new Set<string>(['.']);
  for (const file of files) {
    let dir = dirname(file.relativePath).split(sep).join('/');
    while (dir !== '.' && dir !== '') {
      folders.add(dir);
      dir = dirname(dir).split(sep).join('/');
    }
  }
  return [...folders].sort((a, b) => a.localeCompare(b));
}

function componentPaths(files: readonly FileFact[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.relativePath.split('/');
    const first = parts[0];
    const second = parts[1];
    if (first === undefined) continue;
    if (first === 'packages' && second !== undefined && parts.length > 2) {
      folders.add(`packages/${second}`);
      continue;
    }
    if (parts.length > 1 && first !== '.github') folders.add(first);
  }
  return [...folders].sort((a, b) => a.localeCompare(b));
}

function filesForComponent(files: readonly FileFact[], componentPath: string): FileFact[] {
  return files.filter((file) => file.relativePath.startsWith(`${componentPath}/`));
}

function packageFactsForComponent(
  packageFacts: readonly PackageJsonFact[],
  componentPath: string,
): PackageJsonFact[] {
  return packageFacts.filter((pkg) => pkg.relativePath.startsWith(`${componentPath}/`));
}

function componentKind(componentPath: string): string {
  const lower = componentPath.toLowerCase();
  if (lower.includes('cli')) return 'cli';
  if (lower.includes('tui') || lower.includes('ui')) return 'interface';
  if (lower.includes('core')) return 'core';
  if (lower.includes('provider')) return 'provider';
  if (lower.includes('brain') || lower.includes('intelligence')) return 'intelligence';
  if (lower.includes('script') || lower.includes('tool')) return 'automation';
  if (lower.includes('doc') || lower.includes('runbook')) return 'documentation';
  if (lower === 'src' || lower.endsWith('/src')) return 'source';
  if (lower.includes('test') || lower.includes('eval')) return 'quality';
  return 'component';
}

function purposeForComponent(componentPath: string, packages: readonly PackageJsonFact[]): string {
  const kind = componentKind(componentPath);
  const packageName = packages.find((pkg) => pkg.name !== undefined)?.name;
  const namedSuffix =
    packageName === undefined ? '' : ` Package identity: ${safeText(packageName)}.`;
  switch (kind) {
    case 'cli':
      return `Command-line surface that turns user commands into local Rizz workflows.${namedSuffix}`;
    case 'interface':
      return `Terminal or user-interface surface for interacting with Rizz.${namedSuffix}`;
    case 'core':
      return `Core orchestration logic that coordinates the default lightweight harness.${namedSuffix}`;
    case 'provider':
      return `Provider integration layer for model routes and external model APIs.${namedSuffix}`;
    case 'intelligence':
      return `Project understanding layer that extracts, stores, and reports local repo intelligence.${namedSuffix}`;
    case 'automation':
      return `Automation and release tooling used to operate or package the project.${namedSuffix}`;
    case 'documentation':
      return `Documentation and operational guidance for users, contributors, and release owners.${namedSuffix}`;
    case 'source':
      return `Primary source tree for the application or package.${namedSuffix}`;
    case 'quality':
      return `Quality, eval, or test support surface for validating behavior.${namedSuffix}`;
    default:
      return `Repository component inferred from ${safeText(componentPath)}.${namedSuffix}`;
  }
}

function boundaryTypeForComponent(
  componentPath: string,
  files: readonly FileFact[],
  packages: readonly PackageJsonFact[],
): ComponentBoundaryType {
  const kind = componentKind(componentPath);
  if (kind === 'cli') return 'entrypoint';
  if (kind === 'interface') return 'interface';
  if (kind === 'core') return 'orchestration';
  if (kind === 'provider') return 'adapter';
  if (kind === 'automation') return 'automation';
  if (kind === 'documentation') return 'knowledge';
  if (kind === 'quality') return 'quality';
  if (kind === 'source') return 'source';
  if (kind === 'intelligence') return 'service';
  if (packages.some((pkg) => Object.keys(pkg.scripts).length > 0)) return 'entrypoint';
  if (files.some((file) => isRouteLikeFile(file))) return 'entrypoint';
  if (files.some((file) => basename(file.relativePath).toLowerCase() === 'index.ts')) {
    return 'service';
  }
  return 'unknown';
}

function responsibilitiesForComponent(
  componentPath: string,
  files: readonly FileFact[],
  packages: readonly PackageJsonFact[],
): string[] {
  const responsibilities = new Set<string>();
  const kind = componentKind(componentPath);
  if (kind === 'cli')
    responsibilities.add('Expose user-facing commands and route them to product flows.');
  if (kind === 'interface')
    responsibilities.add('Render interactive terminal/user interface behavior.');
  if (kind === 'core')
    responsibilities.add('Coordinate orchestration state, policies, and local harness behavior.');
  if (kind === 'provider')
    responsibilities.add('Resolve and call configured model providers through stable adapters.');
  if (kind === 'intelligence')
    responsibilities.add('Build and maintain structured project understanding with evidence.');
  if (kind === 'automation')
    responsibilities.add('Run repeatable local automation for packaging, checks, or release.');
  if (kind === 'documentation')
    responsibilities.add('Explain setup, operation, architecture, and release procedures.');
  if (files.some((file) => classifySourceKind(file) === 'source')) {
    responsibilities.add('Own runtime/source implementation files.');
  }
  if (files.some((file) => classifySourceKind(file) === 'test')) {
    responsibilities.add('Own tests or executable validation artifacts.');
  }
  if (files.some((file) => classifySourceKind(file) === 'config')) {
    responsibilities.add('Own configuration that can change local or CI behavior.');
  }
  if (files.some((file) => classifySourceKind(file) === 'documentation')) {
    responsibilities.add('Own documentation or runbook knowledge.');
  }
  if (packages.length > 0) {
    responsibilities.add('Declare package metadata, scripts, and dependency surface.');
  }
  return [...responsibilities];
}

function interfacesForComponent(
  packages: readonly PackageJsonFact[],
  files: readonly FileFact[],
): string[] {
  const interfaces = new Set<string>();
  for (const pkg of packages) {
    if (pkg.name !== undefined) interfaces.add(`package: ${safeText(pkg.name)}`);
    for (const scriptName of Object.keys(pkg.scripts))
      interfaces.add(`script: ${safeText(scriptName)}`);
  }
  for (const file of files) {
    const name = basename(file.relativePath).toLowerCase();
    if (name === 'index.ts' || name === 'index.js')
      interfaces.add(`entry module: ${safeText(file.relativePath)}`);
    if (name === 'readme.md') interfaces.add(`documentation: ${safeText(file.relativePath)}`);
    if (file.relativePath.includes('/bin/') || name === 'cli.ts' || name === 'cli.js') {
      interfaces.add(`command module: ${safeText(file.relativePath)}`);
    }
  }
  return [...interfaces];
}

function entryPointsForComponent(
  packages: readonly PackageJsonFact[],
  files: readonly FileFact[],
): string[] {
  const entries = new Set<string>();
  for (const pkg of packages) {
    entries.add(safeText(pkg.relativePath));
    for (const [scriptName, command] of Object.entries(pkg.scripts)) {
      entries.add(`${safeText(pkg.relativePath)}#${safeText(scriptName)} -> ${safeText(command)}`);
    }
  }
  for (const file of files) {
    const name = basename(file.relativePath).toLowerCase();
    if (
      name === 'index.ts' ||
      name === 'index.js' ||
      name === 'main.ts' ||
      name === 'main.js' ||
      name === 'cli.ts' ||
      name === 'cli.js'
    ) {
      entries.add(safeText(file.relativePath));
    }
  }
  return [...entries].slice(0, 12);
}

function consumersForComponent(componentPath: string, files: readonly FileFact[]): string[] {
  const consumers = new Set<string>();
  const kind = componentKind(componentPath);
  if (kind === 'cli') consumers.add('Developers invoking the rizz CLI.');
  if (kind === 'interface') consumers.add('Users interacting through the terminal UI.');
  if (kind === 'core') consumers.add('CLI and other orchestration surfaces.');
  if (kind === 'provider') consumers.add('Core/model routing code that needs provider adapters.');
  if (kind === 'intelligence') consumers.add('CLI commands, Review, Portal, and Explain surfaces.');
  if (kind === 'automation') consumers.add('Release, CI, and local maintenance workflows.');
  if (kind === 'documentation')
    consumers.add('Users, contributors, and future agents reading project context.');
  if (files.some((file) => classifySourceKind(file) === 'test'))
    consumers.add('Project test/QA workflows.');
  if (consumers.size === 0)
    consumers.add('Other project components; exact consumers need deeper flow analysis.');
  return [...consumers];
}

function exposedApisForComponent(files: readonly FileFact[]): string[] {
  const exposed = new Set<string>();
  for (const file of files) {
    const lower = file.relativePath.toLowerCase();
    const name = basename(lower);
    if (lower.includes('/api/') || lower.includes('/routes/') || lower.includes('/route.')) {
      exposed.add(`route/API file: ${safeText(file.relativePath)}`);
    }
    if (lower.includes('/controller') || name.includes('controller')) {
      exposed.add(`controller file: ${safeText(file.relativePath)}`);
    }
    if (name === 'index.ts' || name === 'index.js') {
      exposed.add(`module export surface: ${safeText(file.relativePath)}`);
    }
  }
  return [...exposed].slice(0, 12);
}

function dependenciesForComponent(packages: readonly PackageJsonFact[]): string[] {
  return unique(
    packages.flatMap((pkg) => [
      ...Object.keys(pkg.dependencies).map((name) => safeText(name)),
      ...Object.keys(pkg.devDependencies).map((name) => safeText(name)),
    ]),
  ).slice(0, 20);
}

function dependencyRolesForComponent(packages: readonly PackageJsonFact[]): string[] {
  const roles = new Set<string>();
  for (const pkg of packages) {
    for (const name of Object.keys(pkg.dependencies)) {
      roles.add(`runtime dependency: ${safeText(name)}`);
    }
    for (const name of Object.keys(pkg.devDependencies)) {
      const role = /test|vitest|jest|mocha|playwright|testing/i.test(name)
        ? 'test dependency'
        : 'development dependency';
      roles.add(`${role}: ${safeText(name)}`);
    }
  }
  return [...roles].sort((a, b) => a.localeCompare(b)).slice(0, 20);
}

function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name === undefined ? specifier : `${scope}/${name}`;
  }
  return specifier.split('/')[0] ?? specifier;
}

function resolveRelativeImportTarget(params: {
  readonly fromFile: string;
  readonly specifier: string;
  readonly componentPaths: readonly string[];
}): string | undefined {
  const importedPath = join(dirname(params.fromFile), params.specifier).split(sep).join('/');
  const matches = params.componentPaths
    .filter((componentPath) => {
      return importedPath === componentPath || importedPath.startsWith(`${componentPath}/`);
    })
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  return matches[0];
}

function couplingForComponent(params: {
  readonly rootDir: string;
  readonly componentPath: string;
  readonly files: readonly FileFact[];
  readonly packageFacts: readonly PackageJsonFact[];
  readonly componentPaths: readonly string[];
}): ComponentIntelligence['coupling'] {
  const packageNameToComponent = new Map(
    params.packageFacts
      .filter((pkg) => pkg.name !== undefined && packageComponentPath(pkg) !== undefined)
      .map((pkg) => [pkg.name ?? '', packageComponentPath(pkg) ?? '']),
  );
  const internalImports = new Set<string>();
  const externalImports = new Set<string>();
  let staticImportCount = 0;

  for (const file of params.files.filter((item) => classifySourceKind(item) === 'source')) {
    const text = readTextIfAvailable(params.rootDir, file.relativePath);
    if (text === undefined) continue;
    for (const specifier of importSpecifiersFromText(text)) {
      staticImportCount += 1;
      let targetPath: string | undefined;
      if (specifier.startsWith('.')) {
        targetPath = resolveRelativeImportTarget({
          fromFile: file.relativePath,
          specifier,
          componentPaths: params.componentPaths,
        });
      } else {
        const packageName = packageNameFromSpecifier(specifier);
        targetPath = packageNameToComponent.get(packageName);
        if (targetPath === undefined) externalImports.add(packageName);
      }
      if (targetPath !== undefined && targetPath !== params.componentPath) {
        internalImports.add(entityId('component', targetPath));
      }
    }
  }

  const score = Math.min(
    10,
    internalImports.size * 3 + externalImports.size + (staticImportCount > 8 ? 2 : 0),
  );
  let level: ComponentIntelligence['coupling']['level'] = 'low';
  if (score >= 7) level = 'high';
  else if (score >= 3) level = 'medium';

  const reasons = unique([
    ...(internalImports.size > 0
      ? [`${internalImports.size} cross-component static import target(s) detected.`]
      : []),
    ...(externalImports.size > 0
      ? [`${externalImports.size} external import root(s) detected.`]
      : []),
    ...(staticImportCount > 8
      ? ['Static import surface is broad enough to widen review scope.']
      : []),
    ...(staticImportCount === 0 ? ['No static imports detected in source files.'] : []),
  ]);

  return {
    level,
    score,
    static_import_count: staticImportCount,
    internal_imports: [...internalImports].sort((a, b) => a.localeCompare(b)),
    external_imports: [...externalImports].sort((a, b) => a.localeCompare(b)).slice(0, 20),
    reasons,
  };
}

function couplingEvidenceIdsForComponent(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
  readonly packages: readonly PackageJsonFact[];
}): string[] {
  const evidenceIds = new Set<string>();
  for (const file of params.files.filter((item) => classifySourceKind(item) === 'source')) {
    const text = readTextIfAvailable(params.rootDir, file.relativePath);
    if (text !== undefined && importSpecifiersFromText(text).length > 0) {
      evidenceIds.add(evidenceId(file.relativePath));
    }
  }
  for (const pkg of params.packages) {
    if (Object.keys(pkg.dependencies).length > 0 || Object.keys(pkg.devDependencies).length > 0) {
      evidenceIds.add(evidenceId(pkg.relativePath));
    }
  }
  return [...evidenceIds].sort((a, b) => a.localeCompare(b));
}

function testPathsForComponent(files: readonly FileFact[]): string[] {
  return files
    .filter((file) => classifySourceKind(file) === 'test')
    .map((file) => file.relativePath);
}

function configPathsForComponent(files: readonly FileFact[]): string[] {
  return files
    .filter(
      (file) =>
        classifySourceKind(file) === 'config' || classifySourceKind(file) === 'package-manifest',
    )
    .map((file) => file.relativePath);
}

function criticalityForComponent(
  componentPath: string,
  files: readonly FileFact[],
  packages: readonly PackageJsonFact[],
): { readonly label: 'low' | 'medium' | 'high'; readonly score: number } {
  let score = 1;
  const kind = componentKind(componentPath);
  if (['cli', 'core', 'provider', 'intelligence'].includes(kind)) score += 3;
  if (packages.length > 0) score += 2;
  if (files.some((file) => classifySourceKind(file) === 'source')) score += 2;
  if (files.some((file) => classifySourceKind(file) === 'config')) score += 1;
  if (files.some((file) => classifySourceKind(file) === 'test')) score += 1;
  const capped = Math.min(10, score);
  if (capped >= 7) return { label: 'high', score: capped };
  if (capped >= 4) return { label: 'medium', score: capped };
  return { label: 'low', score: capped };
}

function whatBreaksIfRemovedForComponent(
  componentPath: string,
  intelligence: Pick<
    ComponentIntelligence,
    | 'criticality'
    | 'consumers'
    | 'interfaces'
    | 'entry_points'
    | 'exposed_apis'
    | 'dependencies'
    | 'tests'
    | 'coupling'
  >,
): string[] {
  const name = safeText(componentPath);
  const breaks = new Set<string>();
  if (intelligence.criticality === 'high') {
    const affected =
      intelligence.consumers
        .slice(0, 2)
        .map((consumer) => consumer.replace(/\.+$/, ''))
        .join(', ') || 'primary project workflows';
    breaks.add(`${name} is likely critical: removing it can affect ${affected}.`);
  }
  if (intelligence.criticality === 'medium') {
    const affected = intelligence.interfaces.slice(0, 2).join(', ') || 'its package or files';
    breaks.add(`${name} likely affects local workflows tied to ${affected}.`);
  }
  if (intelligence.entry_points.length > 0) {
    breaks.add(
      `Entry points may stop working: ${intelligence.entry_points.slice(0, 3).join(', ')}.`,
    );
  }
  if (intelligence.exposed_apis.length > 0) {
    breaks.add(
      `Exposed module/API surfaces may change: ${intelligence.exposed_apis.slice(0, 3).join(', ')}.`,
    );
  }
  if (intelligence.coupling.internal_imports.length > 0) {
    breaks.add(
      `Cross-component import consumers or callees need review: ${intelligence.coupling.internal_imports
        .slice(0, 4)
        .join(', ')}.`,
    );
  }
  if (intelligence.dependencies.length > 0) {
    breaks.add(
      `Dependency install/runtime behavior can change for ${intelligence.dependencies
        .slice(0, 4)
        .join(', ')}.`,
    );
  }
  if (intelligence.tests.length > 0) {
    breaks.add(
      `Validation tied to ${name} may fail: ${intelligence.tests.slice(0, 3).join(', ')}.`,
    );
  }
  if (breaks.size === 0) {
    breaks.add(
      `${name} may mostly affect documentation or local organization, but exact blast radius needs flow analysis.`,
    );
  }
  return [...breaks];
}

function firstFilesToRead(files: readonly FileFact[]): string[] {
  const ranked = [...files].sort((a, b) => {
    const aName = basename(a.relativePath).toLowerCase();
    const bName = basename(b.relativePath).toLowerCase();
    const rank = (name: string): number => {
      if (name === 'package.json') return 0;
      if (name === 'readme.md') return 1;
      if (name === 'index.ts' || name === 'index.js') return 2;
      if (name.includes('test') || name.includes('spec')) return 4;
      return 3;
    };
    return rank(aName) - rank(bName) || a.relativePath.localeCompare(b.relativePath);
  });
  return ranked.slice(0, 8).map((file) => file.relativePath);
}

function ownershipConfidenceForComponent(params: {
  readonly boundaryType: ComponentBoundaryType;
  readonly files: readonly FileFact[];
  readonly packages: readonly PackageJsonFact[];
  readonly signals: readonly string[];
  readonly entryPoints: readonly string[];
  readonly tests: readonly string[];
}): ComponentIntelligence['ownership_confidence'] {
  let score = 0.2;
  if (params.packages.length > 0) score += 0.25;
  if (params.files.some((file) => classifySourceKind(file) === 'source')) score += 0.2;
  if (params.entryPoints.length > 0) score += 0.15;
  if (params.tests.length > 0) score += 0.1;
  if (params.boundaryType !== 'unknown') score += 0.1;
  const capped = Math.min(0.95, Number(score.toFixed(2)));
  let reason = 'Component boundary is weak and mostly inferred from path structure.';
  if (capped >= 0.75) {
    reason = 'Component boundary is supported by package/source/test or entrypoint evidence.';
  } else if (capped >= 0.5) {
    reason = 'Component boundary is inferred from partial package or source evidence.';
  }
  return { score: capped, reason, signals: params.signals };
}

function componentSignals(
  files: readonly FileFact[],
  packages: readonly PackageJsonFact[],
): string[] {
  const signals = new Set<string>();
  if (packages.length > 0) signals.add('package manifest');
  if (files.some((file) => classifySourceKind(file) === 'source')) signals.add('source files');
  if (files.some((file) => classifySourceKind(file) === 'test')) signals.add('test files');
  if (files.some((file) => classifySourceKind(file) === 'config')) signals.add('configuration');
  if (files.some((file) => classifySourceKind(file) === 'documentation'))
    signals.add('documentation');
  return [...signals];
}

function tradeoffsForComponent(params: {
  readonly boundaryType: ComponentBoundaryType;
  readonly dependencies: readonly string[];
  readonly entryPoints: readonly string[];
  readonly configs: readonly string[];
  readonly tests: readonly string[];
  readonly exposedApis: readonly string[];
  readonly coupling: ComponentIntelligence['coupling'];
}): string[] {
  const tradeoffs = new Set<string>();
  if (params.boundaryType === 'entrypoint') {
    tradeoffs.add(
      'User-facing entrypoints improve reachability but make interface changes riskier.',
    );
  }
  if (params.boundaryType === 'adapter') {
    tradeoffs.add(
      'Adapter boundary isolates external/provider behavior but concentrates compatibility risk.',
    );
  }
  if (params.boundaryType === 'orchestration') {
    tradeoffs.add(
      'Orchestration boundary centralizes policy decisions but can become a coupling point.',
    );
  }
  if (params.dependencies.length > 8) {
    tradeoffs.add(
      'Large dependency surface gives capability breadth at the cost of upgrade review scope.',
    );
  }
  if (params.coupling.level !== 'low') {
    tradeoffs.add(
      'Cross-component coupling improves reuse but widens review scope for local changes.',
    );
  }
  if (params.configs.length > 0) {
    tradeoffs.add(
      'Configuration-backed behavior is flexible but can fail through environment or CI drift.',
    );
  }
  if (params.tests.length === 0) {
    tradeoffs.add(
      'Low local test evidence keeps the component lightweight but weakens change confidence.',
    );
  }
  if (params.exposedApis.length > 0 && params.entryPoints.length === 0) {
    tradeoffs.add('Exported surface is visible, but no explicit entrypoint was detected.');
  }
  return [...tradeoffs];
}

function failureModesForComponent(params: {
  readonly componentPath: string;
  readonly boundaryType: ComponentBoundaryType;
  readonly dependencies: readonly string[];
  readonly entryPoints: readonly string[];
  readonly configs: readonly string[];
  readonly tests: readonly string[];
  readonly exposedApis: readonly string[];
  readonly coupling: ComponentIntelligence['coupling'];
}): string[] {
  const name = safeText(params.componentPath);
  const failures = new Set<string>();
  if (params.entryPoints.length > 0) {
    failures.add(`Entrypoints for ${name} can fail if command, package, or module exports drift.`);
  }
  if (params.configs.length > 0) {
    failures.add(
      `Configuration changes can break ${name} before runtime code changes are touched.`,
    );
  }
  if (params.dependencies.length > 0) {
    failures.add(`Dependency upgrades can change ${name} behavior or install compatibility.`);
  }
  if (params.exposedApis.length > 0) {
    failures.add('Consumers can break if exposed module/API surfaces change shape.');
  }
  if (params.coupling.internal_imports.length > 0) {
    failures.add('Static cross-component imports can break when either side changes exports.');
  }
  if (params.tests.length === 0) {
    failures.add('No component-local tests were detected, so regressions may escape local checks.');
  }
  if (params.boundaryType === 'unknown') {
    failures.add(`Boundary role for ${name} is unclear; inspect read-first files before editing.`);
  }
  return [...failures];
}

function unknownsForComponent(params: {
  readonly boundaryType: ComponentBoundaryType;
  readonly signals: readonly string[];
  readonly consumers: readonly string[];
  readonly dependencies: readonly string[];
  readonly entryPoints: readonly string[];
  readonly tests: readonly string[];
}): string[] {
  const unknowns = new Set<string>();
  if (params.boundaryType === 'unknown') {
    unknowns.add('Component boundary type is inferred weakly from file organization.');
  }
  if (params.signals.length <= 1) {
    unknowns.add('Component understanding is backed by limited static evidence.');
  }
  if (
    params.consumers.some((consumer) =>
      consumer.includes('exact consumers need deeper flow analysis'),
    )
  ) {
    unknowns.add('Exact consumers are not fully known from static component evidence.');
  }
  if (params.dependencies.length === 0) {
    unknowns.add('No package dependency evidence was detected for this component.');
  }
  if (params.entryPoints.length === 0) {
    unknowns.add('No explicit entrypoint was detected for this component.');
  }
  if (params.tests.length === 0) {
    unknowns.add('No component-local test evidence was detected.');
  }
  return [...unknowns];
}

function knownRisksForComponent(
  intelligence: Pick<
    ComponentIntelligence,
    'tests' | 'criticality' | 'dependencies' | 'exposed_apis' | 'consumers' | 'signals' | 'coupling'
  >,
): string[] {
  const risks = new Set<string>();
  if (intelligence.tests.length === 0 && intelligence.criticality !== 'low') {
    risks.add('No component-local tests detected for a medium/high criticality component.');
  }
  if (intelligence.dependencies.length > 10) {
    risks.add('Large dependency surface may increase upgrade and security review scope.');
  }
  if (intelligence.exposed_apis.length > 0 && intelligence.consumers.length === 0) {
    risks.add('Potential public interface with no inferred consumers.');
  }
  if (intelligence.signals.length <= 1) {
    risks.add('Weak evidence: component understanding is mostly inferred from path structure.');
  }
  if (intelligence.coupling.level === 'high') {
    risks.add('High coupling score: cross-component edits need broader review.');
  }
  return [...risks];
}

function blastRadiusForComponent(params: {
  readonly criticality: 'low' | 'medium' | 'high';
  readonly boundaryType: ComponentBoundaryType;
  readonly coupling: ComponentIntelligence['coupling'];
  readonly entryPoints: readonly string[];
  readonly exposedApis: readonly string[];
}): BlastRadius {
  if (
    params.criticality === 'high' ||
    params.coupling.level === 'high' ||
    params.boundaryType === 'orchestration'
  ) {
    return 'broad';
  }
  if (
    params.criticality === 'medium' ||
    params.coupling.level === 'medium' ||
    params.entryPoints.length > 0 ||
    params.exposedApis.length > 0
  ) {
    return 'moderate';
  }
  return 'narrow';
}

function riskySeamsForComponent(params: {
  readonly boundaryType: ComponentBoundaryType;
  readonly criticality: 'low' | 'medium' | 'high';
  readonly coupling: ComponentIntelligence['coupling'];
  readonly configs: readonly string[];
  readonly tests: readonly string[];
  readonly exposedApis: readonly string[];
}): string[] {
  const seams = new Set<string>();
  if (params.coupling.internal_imports.length > 0) {
    seams.add(
      'Static imports cross component boundaries; review both sides before changing exports.',
    );
  }
  if (params.boundaryType === 'entrypoint' && params.configs.length > 0) {
    seams.add('Entrypoint depends on config; command behavior can drift without source changes.');
  }
  if (params.boundaryType === 'adapter') {
    seams.add(
      'Adapter boundary is a compatibility seam between local contracts and external behavior.',
    );
  }
  if (params.exposedApis.length > 0 && params.coupling.level !== 'low') {
    seams.add('Exposed API plus coupling means signature changes can cascade.');
  }
  if (params.criticality !== 'low' && params.tests.length === 0) {
    seams.add('Critical component lacks local test evidence.');
  }
  return [...seams];
}

function packageComponentPath(pkg: PackageJsonFact): string | undefined {
  const dir = dirname(pkg.relativePath).split(sep).join('/');
  return dir === '.' ? undefined : dir;
}

function sourceFilesForPackage(files: readonly FileFact[], pkg: PackageJsonFact): FileFact[] {
  const componentPath = packageComponentPath(pkg);
  if (componentPath === undefined) {
    return files.filter(
      (file) => dirname(file.relativePath) === '.' && isSourceFile(file.relativePath),
    );
  }
  return filesForComponent(files, componentPath);
}

function entrySourceFiles(files: readonly FileFact[]): readonly FileFact[] {
  const ranked = files
    .filter((file) => classifySourceKind(file) === 'source')
    .sort((a, b) => {
      const rank = (file: FileFact): number => {
        const name = basename(file.relativePath).toLowerCase();
        if (name === 'index.ts' || name === 'index.js') return 0;
        if (name === 'cli.ts' || name === 'cli.js') return 1;
        if (name === 'main.ts' || name === 'main.js') return 2;
        return 3;
      };
      return rank(a) - rank(b) || a.relativePath.localeCompare(b.relativePath);
    });
  return ranked.slice(0, 5);
}

function importSpecifiersFromText(text: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /import\s+(?:[^'"]+?\s+from\s*)?['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined && specifier.trim() !== '') specifiers.add(safeText(specifier));
    }
  }
  return [...specifiers].sort((a, b) => a.localeCompare(b));
}

const RESOLVABLE_SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
] as const;

function uniqueFileFacts(files: readonly FileFact[]): FileFact[] {
  const byPath = new Map<string, FileFact>();
  for (const file of files) byPath.set(file.relativePath, file);
  return [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function normalizedPathHint(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/[),;]+$/g, '');
}

function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]+)"|'([^']+)'|`([^`]+)`|[^\s]+/g;
  for (const match of command.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[0];
    const normalized = normalizedPathHint(token);
    if (normalized !== '') tokens.push(normalized);
  }
  return tokens;
}

function possibleFilePaths(basePath: string): string[] {
  const normalized = normalizedPathHint(basePath);
  const extension = extname(normalized);
  const candidates = new Set<string>([normalized]);
  if (extension !== '') {
    const withoutExtension = normalized.slice(0, -extension.length);
    for (const replacement of RESOLVABLE_SOURCE_EXTENSIONS) {
      candidates.add(`${withoutExtension}${replacement}`);
    }
    if (normalized.includes('/dist/')) {
      const sourceBase = withoutExtension.replace('/dist/', '/src/');
      for (const replacement of RESOLVABLE_SOURCE_EXTENSIONS) {
        candidates.add(`${sourceBase}${replacement}`);
      }
    }
  } else {
    for (const replacement of RESOLVABLE_SOURCE_EXTENSIONS) {
      candidates.add(`${normalized}${replacement}`);
      candidates.add(`${normalized}/index${replacement}`);
    }
  }
  return [...candidates];
}

function filesForPathHint(files: readonly FileFact[], hint: string): FileFact[] {
  const normalized = normalizedPathHint(hint);
  if (normalized === '' || normalized.startsWith('-') || normalized.includes('://')) return [];
  if (normalized.includes('=') && !normalized.includes('/')) return [];
  const known = new Map(files.map((file) => [file.relativePath, file]));
  const exactMatches = possibleFilePaths(normalized)
    .map((candidate) => known.get(candidate))
    .filter((file): file is FileFact => file !== undefined);
  if (exactMatches.length > 0) return uniqueFileFacts(exactMatches);
  if (!normalized.includes('/')) return [];
  return uniqueFileFacts(
    files
      .filter(
        (file) =>
          file.relativePath === normalized || file.relativePath.startsWith(`${normalized}/`),
      )
      .sort((a, b) => {
        const rank = (file: FileFact): number => {
          const kind = classifySourceKind(file);
          if (kind === 'source') return 0;
          if (kind === 'test') return 1;
          if (kind === 'package-manifest' || kind === 'config') return 2;
          return 3;
        };
        return rank(a) - rank(b) || a.relativePath.localeCompare(b.relativePath);
      })
      .slice(0, 20),
  );
}

function filesReferencedByCommand(
  files: readonly FileFact[],
  command: string,
  baseDir: string | undefined,
): FileFact[] {
  return uniqueFileFacts(
    commandTokens(command).flatMap((token) => {
      const direct = filesForPathHint(files, token);
      if (baseDir === undefined || token.startsWith('/') || token.startsWith('../')) {
        return direct;
      }
      return [...direct, ...filesForPathHint(files, `${baseDir}/${token}`)];
    }),
  );
}

function resolveRelativeImportFiles(
  files: readonly FileFact[],
  fromPath: string,
  specifier: string,
): FileFact[] {
  if (!specifier.startsWith('.')) return [];
  const base = join(dirname(fromPath), specifier).split(sep).join('/');
  return filesForPathHint(files, base);
}

function splitAliasPattern(pattern: string): {
  readonly prefix: string;
  readonly suffix: string;
} {
  const starIndex = pattern.indexOf('*');
  if (starIndex < 0) return { prefix: pattern, suffix: '' };
  return {
    prefix: pattern.slice(0, starIndex),
    suffix: pattern.slice(starIndex + 1),
  };
}

function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}

function joinConfigPath(configDir: string, path: string): string {
  const normalized = normalizedPathHint(path);
  if (normalized === '') return normalizedPathHint(configDir);
  if (normalized.startsWith('/')) return normalized.replace(/^\/+/, '');
  if (configDir === '.' || configDir === '') return normalized;
  return join(configDir, normalized).split(sep).join('/');
}

function stringArrayFromRecord(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function importAliasContextForConfigs(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
}): ImportAliasContext {
  const baseUrls = new Set<string>();
  const pathAliases: PathAliasPattern[] = [];
  const configFiles = params.files.filter((file) => {
    const name = basename(file.relativePath).toLowerCase();
    return name === 'tsconfig.json' || name === 'jsconfig.json';
  });

  for (const file of configFiles) {
    const text = readTextIfAvailable(params.rootDir, file.relativePath);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(text));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.compilerOptions)) continue;
    const configDir = dirname(file.relativePath).split(sep).join('/');
    const rawBaseUrl = parsed.compilerOptions.baseUrl;
    const baseDir =
      typeof rawBaseUrl === 'string'
        ? joinConfigPath(configDir, rawBaseUrl)
        : normalizedPathHint(configDir);
    if (baseDir !== '') baseUrls.add(baseDir);

    const rawPaths = parsed.compilerOptions.paths;
    if (!isRecord(rawPaths)) continue;
    for (const [pattern, targets] of Object.entries(rawPaths)) {
      const normalizedPattern = normalizedPathHint(pattern);
      if (normalizedPattern === '') continue;
      const normalizedTargets = stringArrayFromRecord(targets).map((target) =>
        joinConfigPath(baseDir, target),
      );
      if (normalizedTargets.length === 0) continue;
      const alias = splitAliasPattern(normalizedPattern);
      pathAliases.push({
        pattern: normalizedPattern,
        prefix: alias.prefix,
        suffix: alias.suffix,
        targets: normalizedTargets.map((target) => ({
          pattern: target,
          ...splitAliasPattern(target),
        })),
      });
    }
  }

  return {
    baseUrls: [...baseUrls].sort((a, b) => a.localeCompare(b)),
    pathAliases: pathAliases.sort(
      (a, b) =>
        b.prefix.length - a.prefix.length ||
        b.suffix.length - a.suffix.length ||
        a.pattern.localeCompare(b.pattern),
    ),
  };
}

function resolveAliasImportFiles(
  files: readonly FileFact[],
  specifier: string,
  aliasContext: ImportAliasContext,
): FileFact[] {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return [];
  const aliases = [
    ...aliasContext.pathAliases,
    {
      pattern: '@/*',
      prefix: '@/',
      suffix: '',
      targets: [{ pattern: 'src/*', prefix: 'src/', suffix: '' }],
    },
    {
      pattern: '~/*',
      prefix: '~/',
      suffix: '',
      targets: [{ pattern: 'src/*', prefix: 'src/', suffix: '' }],
    },
  ];
  for (const alias of aliases) {
    if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) continue;
    const middle = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
    const matches = alias.targets.flatMap((target) => {
      const candidate =
        target.prefix === '' && target.suffix === ''
          ? target.pattern
          : `${target.prefix}${middle}${target.suffix}`;
      return filesForPathHint(files, candidate);
    });
    if (matches.length > 0) return matches;
  }
  const baseUrlMatches = aliasContext.baseUrls.flatMap((baseUrl) =>
    filesForPathHint(files, `${baseUrl}/${specifier}`),
  );
  if (baseUrlMatches.length > 0) return baseUrlMatches;
  if (!specifier.startsWith('@/') && !specifier.startsWith('~/')) return [];
  return filesForPathHint(files, `src/${specifier.slice(2)}`);
}

function importContextForFiles(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
  readonly entryFiles: readonly FileFact[];
}): {
  readonly importedSpecifiers: readonly string[];
  readonly importedFiles: readonly FileFact[];
  readonly importEvidence: readonly FlowEvidence[];
} {
  const importedSpecifiers = new Set<string>();
  const importedFiles: FileFact[] = [];
  const importEvidence: FlowEvidence[] = [];
  const aliases = importAliasContextForConfigs(params);
  for (const file of params.entryFiles) {
    const text = readTextIfAvailable(params.rootDir, file.relativePath);
    if (text === undefined) continue;
    for (const specifier of importSpecifiersFromText(text)) {
      importedSpecifiers.add(specifier);
      importEvidence.push(
        flowEvidenceForNeedle({
          rootDir: params.rootDir,
          path: file.relativePath,
          needle: specifier,
          reason: `Static import evidence for ${specifier}.`,
        }),
      );
      importedFiles.push(...resolveRelativeImportFiles(params.files, file.relativePath, specifier));
      importedFiles.push(...resolveAliasImportFiles(params.files, specifier, aliases));
    }
  }
  return {
    importedSpecifiers: [...importedSpecifiers].sort((a, b) => a.localeCompare(b)),
    importedFiles: uniqueFileFacts(importedFiles),
    importEvidence: uniqueFlowEvidence(importEvidence),
  };
}

function readTextIfAvailable(rootDir: string, relativePath: string): string | undefined {
  try {
    return readFileSync(join(rootDir, relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

function lineSpanForNeedle(
  text: string | undefined,
  needle: string | RegExp,
): {
  readonly lineStart: number;
  readonly lineEnd: number;
} {
  if (text === undefined) return { lineStart: 1, lineEnd: 1 };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (typeof needle === 'string' ? line.includes(needle) : needle.test(line)) {
      return { lineStart: i + 1, lineEnd: i + 1 };
    }
  }
  return { lineStart: 1, lineEnd: 1 };
}

function flowEvidenceForNeedle(params: {
  readonly rootDir: string;
  readonly path: string;
  readonly needle: string | RegExp;
  readonly reason: string;
}): FlowEvidence {
  const span = lineSpanForNeedle(readTextIfAvailable(params.rootDir, params.path), params.needle);
  return {
    path: safeText(params.path),
    line_start: span.lineStart,
    line_end: span.lineEnd,
    reason: safeText(params.reason),
  };
}

function flowKindForScript(pkg: PackageJsonFact, scriptName: string, command: string): FlowKind {
  const lowerName = scriptName.toLowerCase();
  const lowerCommand = command.toLowerCase();
  const manifestDir = dirname(pkg.relativePath).toLowerCase();
  if (/test|check|lint|typecheck|vitest|pytest/.test(`${lowerName} ${lowerCommand}`)) {
    return 'test';
  }
  if (/build|release|deploy|publish|pack|sync|cron|job|generate/.test(lowerName)) return 'job';
  if (manifestDir.includes('cli') || /bin|cli|node .*index|rizz/.test(lowerCommand)) return 'cli';
  if (/vite|next|react|tsx|ui/.test(`${manifestDir} ${lowerCommand}`)) return 'ui';
  return 'job';
}

function flowNameForScript(scriptName: string, kind: FlowKind): string {
  if (kind === 'test') return `${safeText(scriptName)} test flow`;
  if (kind === 'job') return `${safeText(scriptName)} job`;
  if (kind === 'ui') return `${safeText(scriptName)} UI flow`;
  return `${safeText(scriptName)} command`;
}

function flowStepId(flowId: string, order: number): string {
  return `flow-step:${stableSlug(flowId)}:${String(order).padStart(3, '0')}`;
}

function componentPathFromId(componentId: string): string {
  return componentId.replace(/^component:/, '').replace(/--/g, '/');
}

function componentIdsForFiles(
  files: readonly string[],
  components: readonly BrainEntity[],
): string[] {
  return unique(
    components
      .filter((component) =>
        component.source_files.some((source) =>
          files.some((file) => file === source || source.startsWith(`${file}/`)),
        ),
      )
      .map((component) => component.id),
  );
}

function flowConfidenceFor(
  intelligence: Pick<FlowIntelligence, 'tests' | 'signals' | 'unknowns'>,
): {
  readonly confidence: Confidence;
  readonly score: number;
  readonly reason: string;
} {
  let score = 0.35;
  if (intelligence.signals.includes('package script')) score += 0.2;
  if (intelligence.signals.includes('static import')) score += 0.15;
  if (intelligence.signals.includes('route file')) score += 0.15;
  if (intelligence.tests.length > 0) score += 0.15;
  if (intelligence.unknowns.length > 0) score -= 0.1;
  const capped = Math.max(0.1, Math.min(0.95, Number(score.toFixed(2))));
  if (capped >= 0.9 && intelligence.unknowns.length === 0) {
    return {
      confidence: 'verified',
      score: capped,
      reason: 'Direct entrypoint, source, and test evidence were detected.',
    };
  }
  if (capped >= 0.5) {
    return {
      confidence: 'inferred',
      score: capped,
      reason:
        'Flow is reconstructed from local static evidence; runtime reachability is not traced.',
    };
  }
  return {
    confidence: 'uncertain',
    score: capped,
    reason: 'Flow has weak or partial static evidence and needs confirmation before relying on it.',
  };
}

function matchingEvidenceIds(params: {
  readonly rootDir: string;
  readonly files: readonly string[];
  readonly pattern: RegExp;
}): string[] {
  return unique(
    params.files
      .filter((file) => params.pattern.test(readTextIfAvailable(params.rootDir, file) ?? ''))
      .map(evidenceId),
  );
}

function fallbackEvidenceIds(
  entrypoints: readonly FlowEntrypoint[],
  steps: readonly FlowStep[],
): string[] {
  return unique([
    ...entrypoints.flatMap((entrypoint) => entrypoint.evidence),
    ...steps.flatMap((step) => step.evidence),
  ]).slice(0, 6);
}

function inferFlowContracts(params: {
  readonly rootDir: string;
  readonly kind: FlowKind;
  readonly command?: string;
  readonly entrypoints: readonly FlowEntrypoint[];
  readonly steps: readonly FlowStep[];
  readonly files: readonly string[];
  readonly configs: readonly string[];
  readonly tests: readonly string[];
  readonly risks: readonly FlowRisk[];
  readonly signals: readonly string[];
  readonly confidenceReason: string;
  readonly routeContract?: RouteContractContext;
}): FlowContractSummary {
  const entryEvidence = unique(params.entrypoints.flatMap((entrypoint) => entrypoint.evidence));
  const stepEvidence = unique(params.steps.flatMap((step) => step.evidence));
  const baseEvidence = fallbackEvidenceIds(params.entrypoints, params.steps);
  const validationEvidence = matchingEvidenceIds({
    rootDir: params.rootDir,
    files: params.files,
    pattern: /validate|schema|parse|assert|required|invalid|zod|safeParse/i,
  });
  const inputEvidence = matchingEvidenceIds({
    rootDir: params.rootDir,
    files: params.files,
    pattern:
      /process\.argv|commander|yargs|request\.json|req\.body|body|params|searchParams|query|process\.env/i,
  });
  const outputEvidence = matchingEvidenceIds({
    rootDir: params.rootDir,
    files: params.files,
    pattern: /return|response|res\.|json|send|console\.log|stdout|writeHead/i,
  });
  const sideEffectEvidence = matchingEvidenceIds({
    rootDir: params.rootDir,
    files: params.files,
    pattern:
      /session|cache|database|db\.|prisma|sqlite|writeFile|appendFile|setItem|save|insert|update|delete|mutate|store/i,
  });
  const failureEvidence = matchingEvidenceIds({
    rootDir: params.rootDir,
    files: params.files,
    pattern:
      /throw|catch|invalid|error|unauthorized|forbidden|not found|ok:\s*false|status\((4|5)\d\d\)/i,
  });
  const hasRouteEntry = params.entrypoints.some((entrypoint) => entrypoint.type === 'route');
  const hasCommandEntry = params.entrypoints.some((entrypoint) => entrypoint.type === 'command');
  const isNextPageRoute = params.routeContract?.route_type === 'page';
  const isNextLayoutRoute = params.routeContract?.route_type === 'layout';
  const isNextMetadataRoute = params.routeContract?.route_type === 'metadata';
  const isNextApiRoute = params.routeContract?.route_type === 'api';
  const commandInput =
    params.command === undefined ? [] : [`Command invocation: ${safeText(params.command)}.`];
  const nextRouteLabel =
    params.routeContract === undefined
      ? undefined
      : `${params.routeContract.route_path} from ${params.routeContract.entry_file}`;

  const entryContract = unique([
    ...params.entrypoints.map(formatFlowEntrypoint),
    ...(isNextPageRoute && nextRouteLabel !== undefined
      ? [`Next.js app route ${safeText(nextRouteLabel)} renders a page component.`]
      : []),
    ...(isNextLayoutRoute && nextRouteLabel !== undefined
      ? [
          `Next.js app route ${safeText(nextRouteLabel)} wraps nested route rendering with a layout.`,
        ]
      : []),
    ...(isNextApiRoute && nextRouteLabel !== undefined
      ? [
          `Next.js app route ${safeText(nextRouteLabel)} handles HTTP requests with a route handler.`,
        ]
      : []),
    ...(isNextMetadataRoute && nextRouteLabel !== undefined
      ? [`Next.js metadata route ${safeText(nextRouteLabel)} serves a generated metadata asset.`]
      : []),
    ...(validationEvidence.length > 0
      ? ['Entrypoint performs validation before continuing to downstream steps.']
      : []),
    ...(params.configs.length > 0
      ? [`Entrypoint depends on config artifact(s): ${params.configs.slice(0, 4).join(', ')}.`]
      : []),
  ]);
  const exitContract = unique([
    ...(hasRouteEntry && !isNextPageRoute && !isNextLayoutRoute && !isNextMetadataRoute
      ? ['Returns an HTTP/API response from the route flow.']
      : []),
    ...(isNextPageRoute ? ['Exits by returning a React component tree for the route.'] : []),
    ...(isNextLayoutRoute
      ? ['Exits by returning a React layout shell for nested route content.']
      : []),
    ...(isNextMetadataRoute
      ? ['Exits by returning metadata asset content or a metadata response.']
      : []),
    ...(hasCommandEntry ? ['Exits through the package script command result.'] : []),
    ...(outputEvidence.length > 0 ? ['Source evidence includes a return or response output.'] : []),
    ...(params.tests.length > 0
      ? [`Expected behavior is test-backed by ${params.tests.slice(0, 4).join(', ')}.`]
      : []),
  ]);
  const inputs = unique([
    ...commandInput,
    ...(hasRouteEntry && !isNextPageRoute && !isNextLayoutRoute && !isNextMetadataRoute
      ? ['HTTP request route input.']
      : []),
    ...(isNextPageRoute || isNextLayoutRoute
      ? ['Next.js route params, search params, children, or render context input.']
      : []),
    ...(isNextMetadataRoute ? ['Next.js metadata route request or generation context input.'] : []),
    ...(inputEvidence.length > 0
      ? ['Source evidence reads request, CLI, parameter, query, body, or environment input.']
      : []),
    ...(validationEvidence.length > 0 ? ['Validated input contract inferred from source.'] : []),
  ]);
  const outputs = unique([
    ...(hasRouteEntry && !isNextPageRoute && !isNextLayoutRoute && !isNextMetadataRoute
      ? ['HTTP/API response.']
      : []),
    ...(isNextPageRoute || isNextLayoutRoute ? ['Rendered React route output.'] : []),
    ...(isNextMetadataRoute ? ['Generated metadata asset output.'] : []),
    ...(hasCommandEntry ? ['Command completion status and command output.'] : []),
    ...(outputEvidence.length > 0 ? ['Return value, JSON/send response, or stdout output.'] : []),
  ]);
  const sideEffects = unique([
    ...(params.routeContract !== undefined
      ? [
          'No stateful side effects were inferred beyond framework rendering or route response work.',
        ]
      : []),
    ...(sideEffectEvidence.length > 0
      ? ['State/session/cache/database or filesystem side effect inferred from source.']
      : []),
    ...(params.configs.length > 0 ? ['Reads configuration that can alter runtime behavior.'] : []),
  ]);
  const stateTransitions = unique([
    ...(sideEffectEvidence.length > 0
      ? ['State changes when session, cache, database, store, or file mutation succeeds.']
      : []),
    ...(validationEvidence.length > 0
      ? ['Invalid input transitions into validation failure instead of normal output.']
      : []),
  ]);
  const failureModes = unique([
    ...params.risks.map(formatFlowRisk),
    ...(failureEvidence.length > 0
      ? ['Source evidence contains explicit error handling paths.']
      : []),
    ...(isNextPageRoute || isNextLayoutRoute
      ? [
          'Render can fail when imported components, dynamic route params, or content modules drift.',
        ]
      : []),
    ...(isNextMetadataRoute
      ? ['Metadata generation can fail if asset generation dependencies drift.']
      : []),
    ...(validationEvidence.length > 0 ? ['Validation can reject malformed or missing input.'] : []),
    ...(params.tests.length === 0 ? ['No directly linked tests were detected for this flow.'] : []),
    ...(params.configs.length === 0
      ? ['No directly linked configs were detected for this flow.']
      : []),
  ]);
  const requiredTests = unique([
    ...params.tests,
    ...(validationEvidence.length > 0 ? ['validation failure coverage'] : []),
    ...(sideEffectEvidence.length > 0 ? ['state/session/cache/database side-effect coverage'] : []),
    ...(outputEvidence.length > 0 ? ['response/output contract coverage'] : []),
  ]);
  const confidenceReasons = unique([
    params.confidenceReason,
    ...(params.routeContract !== undefined
      ? [
          `Next.js app-router file maps to route path ${safeText(params.routeContract.route_path)}.`,
          `Next.js route type is ${safeText(params.routeContract.route_type)}.`,
        ]
      : []),
    ...params.signals.map((signal) => `Signal: ${signal}.`),
    ...(entryEvidence.length > 0 ? ['Entrypoint evidence is recorded.'] : []),
    ...(stepEvidence.length > 0 ? ['Step evidence is recorded.'] : []),
    ...(validationEvidence.length > 0 ? ['Validation evidence is recorded.'] : []),
    ...(sideEffectEvidence.length > 0 ? ['Side-effect evidence is recorded.'] : []),
    ...(params.tests.length > 0 ? ['Linked test artifact is recorded.'] : []),
  ]);

  return {
    entry_contract: entryContract,
    exit_contract: exitContract,
    inputs,
    outputs,
    side_effects: sideEffects,
    state_transitions: stateTransitions,
    failure_modes: failureModes,
    required_tests: requiredTests,
    confidence_reasons: confidenceReasons,
    field_evidence: {
      entry_contract: entryEvidence.length > 0 ? entryEvidence : baseEvidence,
      exit_contract: unique([...outputEvidence, ...params.tests.map(evidenceId), ...baseEvidence]),
      inputs: unique([...inputEvidence, ...validationEvidence, ...entryEvidence]),
      outputs: unique([...outputEvidence, ...baseEvidence]),
      side_effects: sideEffectEvidence,
      ...(params.routeContract !== undefined && sideEffectEvidence.length === 0
        ? { side_effects: baseEvidence }
        : {}),
      state_transitions: unique([...sideEffectEvidence, ...validationEvidence]),
      failure_modes: unique([
        ...params.risks.flatMap((risk) => risk.evidence),
        ...failureEvidence,
        ...validationEvidence,
        ...(params.routeContract !== undefined ? baseEvidence : []),
      ]),
      required_tests: unique([
        ...params.tests.map(evidenceId),
        ...validationEvidence,
        ...sideEffectEvidence,
      ]),
      confidence_reasons: unique([
        ...entryEvidence,
        ...stepEvidence,
        ...params.tests.map(evidenceId),
        ...(params.routeContract !== undefined ? baseEvidence : []),
      ]),
    },
  };
}

function asFlowConfidenceScore(entity: BrainEntity): number {
  const confidence = entity.data?.confidence;
  if (!isRecord(confidence)) {
    if (entity.confidence === 'verified') return 1;
    if (entity.confidence === 'inferred') return 0.65;
    return 0.35;
  }
  const score = confidence.score;
  return typeof score === 'number' ? score : 0.35;
}

function flowConfidenceReason(entity: BrainEntity): string {
  const confidence = entity.data?.confidence;
  if (!isRecord(confidence)) return 'No confidence reason recorded.';
  return typeof confidence.reason === 'string'
    ? confidence.reason
    : 'No confidence reason recorded.';
}

function flowStringArray(entity: BrainEntity, key: string): string[] {
  return stringArrayData(entity, key);
}

function flowKind(entity: BrainEntity): FlowKind {
  const kind = stringData(entity, 'kind');
  if (
    kind === 'api' ||
    kind === 'cli' ||
    kind === 'job' ||
    kind === 'ui' ||
    kind === 'config' ||
    kind === 'test' ||
    kind === 'unknown'
  ) {
    return kind;
  }
  return 'unknown';
}

function flowEntrypoints(entity: BrainEntity): FlowEntrypoint[] {
  const entrypoints = entity.data?.entrypoints;
  if (!Array.isArray(entrypoints)) return [];
  return entrypoints.filter((entrypoint): entrypoint is FlowEntrypoint => {
    if (!isRecord(entrypoint)) return false;
    return (
      typeof entrypoint.type === 'string' &&
      typeof entrypoint.path === 'string' &&
      (typeof entrypoint.symbol === 'string' || entrypoint.symbol === null) &&
      (entrypoint.component_id === undefined ||
        typeof entrypoint.component_id === 'string' ||
        entrypoint.component_id === null) &&
      Array.isArray(entrypoint.evidence) &&
      entrypoint.evidence.every((item) => typeof item === 'string')
    );
  });
}

function safeFlowEntrypoints(entity: BrainEntity): FlowEntrypoint[] {
  return flowEntrypoints(entity).map((entrypoint) => ({
    type: entrypoint.type,
    path: safeText(entrypoint.path),
    symbol: entrypoint.symbol === null ? null : safeText(entrypoint.symbol),
    ...(entrypoint.component_id !== undefined
      ? {
          component_id: entrypoint.component_id === null ? null : safeText(entrypoint.component_id),
        }
      : {}),
    evidence: entrypoint.evidence.map(safeText),
  }));
}

function safeFlowSteps(entity: BrainEntity): FlowStep[] {
  return flowSteps(entity).map((step) => ({
    step_id: safeText(step.step_id),
    order: step.order,
    type: step.type,
    path: safeText(step.path),
    symbol: step.symbol === null ? null : safeText(step.symbol),
    description: safeText(step.description),
    evidence: step.evidence.map(safeText),
  }));
}

function safeFlowRisks(entity: BrainEntity): FlowRisk[] {
  return flowRisks(entity).map((risk) => ({
    risk_id: safeText(risk.risk_id),
    kind: risk.kind,
    description: safeText(risk.description),
    evidence: risk.evidence.map(safeText),
  }));
}

function flowRisks(entity: BrainEntity): FlowRisk[] {
  const risks = entity.data?.risks;
  if (!Array.isArray(risks)) return [];
  return risks.filter((risk): risk is FlowRisk => {
    if (!isRecord(risk)) return false;
    return (
      typeof risk.risk_id === 'string' &&
      typeof risk.kind === 'string' &&
      typeof risk.description === 'string' &&
      Array.isArray(risk.evidence) &&
      risk.evidence.every((item) => typeof item === 'string')
    );
  });
}

function flowSteps(entity: BrainEntity): FlowStep[] {
  const steps = entity.data?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter((step): step is FlowStep => {
    if (!isRecord(step)) return false;
    return (
      typeof step.step_id === 'string' &&
      typeof step.order === 'number' &&
      typeof step.type === 'string' &&
      typeof step.path === 'string' &&
      (typeof step.symbol === 'string' || step.symbol === null) &&
      typeof step.description === 'string' &&
      Array.isArray(step.evidence) &&
      step.evidence.every((item) => typeof item === 'string')
    );
  });
}

function inferScriptFlow(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
  readonly packageFacts: readonly PackageJsonFact[];
  readonly packageFact: PackageJsonFact;
  readonly scriptName: string;
  readonly command: string;
  readonly components: readonly BrainEntity[];
  readonly changedFiles: ReadonlySet<string>;
}): FlowIntelligence {
  const ownerPath = packageComponentPath(params.packageFact);
  const ownerComponentId = ownerPath === undefined ? undefined : entityId('component', ownerPath);
  const ownerFiles = sourceFilesForPackage(params.files, params.packageFact);
  const commandFiles = filesReferencedByCommand(params.files, params.command, ownerPath);
  const commandEntryFiles = commandFiles.filter((file) => classifySourceKind(file) === 'source');
  const entryFiles = uniqueFileFacts([
    ...(commandEntryFiles.length > 0 ? commandEntryFiles : []),
    ...entrySourceFiles(ownerFiles),
  ]).slice(0, 8);
  const packageNameToComponent = new Map(
    params.packageFacts
      .filter((pkg) => pkg.name !== undefined && packageComponentPath(pkg) !== undefined)
      .map((pkg) => [pkg.name ?? '', entityId('component', packageComponentPath(pkg) ?? '')]),
  );
  const importedSpecifiers = new Set<string>();
  const importContext = importContextForFiles({
    rootDir: params.rootDir,
    files: params.files,
    entryFiles,
  });
  for (const specifier of importContext.importedSpecifiers) importedSpecifiers.add(specifier);

  const commandText = safeText(params.command);
  for (const pkg of params.packageFacts) {
    if (pkg.name !== undefined && commandText.includes(pkg.name)) importedSpecifiers.add(pkg.name);
  }

  const relatedComponentIds = new Set<string>();
  if (ownerComponentId !== undefined) relatedComponentIds.add(ownerComponentId);
  for (const componentId of componentIdsForFiles(
    [...commandFiles, ...importContext.importedFiles].map((file) => file.relativePath),
    params.components,
  )) {
    relatedComponentIds.add(componentId);
  }
  for (const specifier of importedSpecifiers) {
    const componentId = packageNameToComponent.get(specifier);
    if (componentId !== undefined) relatedComponentIds.add(componentId);
  }

  const relatedComponents = params.components.filter((component) =>
    relatedComponentIds.has(component.id),
  );
  const files = unique([
    params.packageFact.relativePath,
    ...commandFiles.map((file) => file.relativePath),
    ...entryFiles.map((file) => file.relativePath),
    ...importContext.importedFiles.map((file) => file.relativePath),
    ...relatedComponents.flatMap((component) => stringArrayData(component, 'important_files')),
    ...relatedComponents.flatMap((component) => component.source_files.slice(0, 3)),
  ]).slice(0, 30);
  const configs = unique([
    params.packageFact.relativePath,
    ...relatedComponents.flatMap((component) => stringArrayData(component, 'configs')),
  ]);
  const tests = unique(
    relatedComponents.flatMap((component) => stringArrayData(component, 'tests')),
  );
  const dependencies = unique([
    ...Object.keys(params.packageFact.dependencies),
    ...Object.keys(params.packageFact.devDependencies),
    ...[...importedSpecifiers].filter((specifier) => !specifier.startsWith('.')),
  ]).map((dependency) => entityId('dependency', dependency));
  const kind = flowKindForScript(params.packageFact, params.scriptName, params.command);
  const flowBase =
    ownerPath === undefined ? `scripts/${params.scriptName}` : `${ownerPath}/${params.scriptName}`;
  const flowId = entityId('flow', flowBase);
  const scriptEvidenceId = evidenceId(params.packageFact.relativePath);
  const entrypoint: FlowEntrypoint = {
    type: 'command',
    path: safeText(params.packageFact.relativePath),
    symbol: safeText(params.scriptName),
    ...(ownerComponentId !== undefined ? { component_id: ownerComponentId } : {}),
    evidence: [scriptEvidenceId],
  };
  const steps: FlowStep[] = [];
  let order = 1;
  for (const file of entryFiles) {
    steps.push({
      step_id: flowStepId(flowId, order),
      order,
      type: 'handler',
      path: safeText(file.relativePath),
      symbol: safeText(params.scriptName),
      description: `Command flow enters source file ${safeText(file.relativePath)}.`,
      evidence: [evidenceId(file.relativePath)],
    });
    order += 1;
  }
  for (const component of relatedComponents.filter(
    (component) => component.id !== ownerComponentId,
  )) {
    const componentFile =
      stringArrayData(component, 'important_files')[0] ?? component.source_files[0];
    if (componentFile === undefined) continue;
    steps.push({
      step_id: flowStepId(flowId, order),
      order,
      type: 'service',
      path: safeText(componentFile),
      symbol: null,
      description: `Flow reaches related component ${safeText(component.name)}.`,
      evidence: [evidenceId(componentFile)],
    });
    order += 1;
  }
  for (const file of importContext.importedFiles.slice(0, 5)) {
    steps.push({
      step_id: flowStepId(flowId, order),
      order,
      type: 'function',
      path: safeText(file.relativePath),
      symbol: null,
      description: `Flow reaches statically imported file ${safeText(file.relativePath)}.`,
      evidence: [evidenceId(file.relativePath)],
    });
    order += 1;
  }
  for (const config of configs.slice(0, 3)) {
    steps.push({
      step_id: flowStepId(flowId, order),
      order,
      type: 'config',
      path: safeText(config),
      symbol: null,
      description: `Flow depends on configuration from ${safeText(config)}.`,
      evidence: [evidenceId(config)],
    });
    order += 1;
  }
  for (const test of tests.slice(0, 3)) {
    steps.push({
      step_id: flowStepId(flowId, order),
      order,
      type: 'test',
      path: safeText(test),
      symbol: null,
      description: 'Related test artifact for this flow.',
      evidence: [evidenceId(test)],
    });
    order += 1;
  }

  const signals = unique([
    'package script',
    ...(entryFiles.length > 0 ? ['source entry'] : []),
    ...(commandFiles.length > 0 ? ['command path'] : []),
    ...(importedSpecifiers.size > 0 ? ['static import'] : []),
    ...(importContext.importedFiles.length > 0 ? ['relative import'] : []),
    ...(tests.length > 0 ? ['test artifact'] : []),
    ...(configs.length > 0 ? ['configuration'] : []),
  ]);
  const unknowns = unique([
    ...(entryFiles.some((file) =>
      readTextIfAvailable(params.rootDir, file.relativePath)?.includes('import('),
    )
      ? ['Dynamic import is static evidence only; runtime reachability is not traced.']
      : []),
    ...(entryFiles.length === 0
      ? ['No source entry file was detected for this package script.']
      : []),
  ]);
  const risks: FlowRisk[] = [];
  if (tests.length === 0) {
    risks.push({
      risk_id: `${flowId}:missing-test`,
      kind: 'missing_test',
      description: 'No directly linked test artifact was detected for this flow.',
      evidence: [scriptEvidenceId],
    });
  }
  if (signals.length <= 1) {
    risks.push({
      risk_id: `${flowId}:weak-evidence`,
      kind: 'weak_evidence',
      description: 'Flow is backed by weak path or manifest evidence only.',
      evidence: [scriptEvidenceId],
    });
  }
  if (files.some((file) => params.changedFiles.has(file))) {
    risks.push({
      risk_id: `${flowId}:changed-hotspot`,
      kind: 'changed_hotspot',
      description: 'A file in this flow changed in the latest scan.',
      evidence: files.filter((file) => params.changedFiles.has(file)).map(evidenceId),
    });
  }
  const baseConfidence = flowConfidenceFor({ tests, signals, unknowns });
  const contracts = inferFlowContracts({
    rootDir: params.rootDir,
    kind,
    command: params.command,
    entrypoints: [entrypoint],
    steps,
    files,
    configs,
    tests,
    risks,
    signals,
    confidenceReason: baseConfidence.reason,
  });
  return {
    flow_id: flowId,
    name: flowNameForScript(params.scriptName, kind),
    kind,
    entrypoints: [entrypoint],
    steps,
    components: unique([...relatedComponentIds]),
    files,
    dependencies,
    configs,
    tests,
    risks,
    entry_contract: contracts.entry_contract,
    exit_contract: contracts.exit_contract,
    inputs: contracts.inputs,
    outputs: contracts.outputs,
    side_effects: contracts.side_effects,
    state_transitions: contracts.state_transitions,
    failure_modes: contracts.failure_modes,
    required_tests: contracts.required_tests,
    confidence_reasons: contracts.confidence_reasons,
    confidence: {
      score: baseConfidence.score,
      reason: baseConfidence.reason,
    },
    evidence: uniqueFlowEvidence([
      flowEvidenceForNeedle({
        rootDir: params.rootDir,
        path: params.packageFact.relativePath,
        needle: params.scriptName,
        reason: `Package script ${params.scriptName} declares this flow entrypoint.`,
      }),
      ...importContext.importEvidence,
      ...entryFiles.map((file) =>
        flowEvidenceForNeedle({
          rootDir: params.rootDir,
          path: file.relativePath,
          needle: params.scriptName,
          reason: `Source file is an inferred handler for ${params.scriptName}.`,
        }),
      ),
    ]),
    field_evidence: {
      entrypoints: [scriptEvidenceId],
      steps: unique(steps.flatMap((step) => step.evidence)),
      components: unique(relatedComponents.flatMap((component) => component.evidence_ids)),
      files: files.map(evidenceId),
      dependencies: [scriptEvidenceId],
      configs: configs.map(evidenceId),
      tests: tests.map(evidenceId),
      risks: unique(risks.flatMap((risk) => risk.evidence)),
      ...contracts.field_evidence,
    },
    unknowns,
    signals,
  };
}

function uniqueFlowEvidence(evidence: readonly FlowEvidence[]): FlowEvidence[] {
  const byKey = new Map<string, FlowEvidence>();
  for (const item of evidence) {
    byKey.set(`${item.path}:${item.line_start}:${item.line_end}:${item.reason}`, item);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line_start - b.line_start ||
      a.reason.localeCompare(b.reason),
  );
}

function isRouteLikeFile(file: FileFact): boolean {
  const lower = file.relativePath.toLowerCase();
  const name = basename(lower);
  return (
    lower.includes('/api/') ||
    lower.includes('/routes/') ||
    lower.includes('/controllers/') ||
    name === 'route.ts' ||
    name === 'route.js' ||
    name.includes('controller')
  );
}

const NEXT_APP_ROUTE_FILE_NAMES = new Set([
  'page.ts',
  'page.tsx',
  'page.js',
  'page.jsx',
  'layout.ts',
  'layout.tsx',
  'layout.js',
  'layout.jsx',
  'route.ts',
  'route.js',
]);

const NEXT_METADATA_ROUTE_NAMES = new Set([
  'apple-icon',
  'favicon',
  'icon',
  'manifest',
  'opengraph-image',
  'robots',
  'sitemap',
  'twitter-image',
]);

function routeSegmentForMetadataFile(fileName: string): string {
  const extension = extname(fileName);
  const stem = extension === '' ? fileName : fileName.slice(0, -extension.length);
  return stem.replace(/\.(ts|tsx|js|jsx)$/i, '');
}

function routePathFromNextSegments(segments: readonly string[]): string {
  const urlSegments = segments.filter(
    (segment) =>
      segment !== '' &&
      !segment.startsWith('(') &&
      !segment.endsWith(')') &&
      !segment.startsWith('@') &&
      !segment.startsWith('_'),
  );
  return urlSegments.length === 0 ? '/' : `/${urlSegments.join('/')}`;
}

function nextAppIndex(parts: readonly string[]): number {
  return parts.findIndex(
    (part, index) => part === 'app' && (index === 0 || parts[index - 1] === 'src'),
  );
}

function nextAppRouteInfo(file: FileFact):
  | {
      readonly routePath: string;
      readonly routeType: NextAppRouteType;
    }
  | undefined {
  const parts = file.relativePath.split('/');
  const appIndex = nextAppIndex(parts);
  if (appIndex < 0) return undefined;
  const fileName = parts[parts.length - 1]?.toLowerCase();
  if (fileName === undefined) return undefined;
  const routeSegments = parts.slice(appIndex + 1, -1);
  const metadataSegment = routeSegmentForMetadataFile(fileName);
  if (!NEXT_APP_ROUTE_FILE_NAMES.has(fileName) && !NEXT_METADATA_ROUTE_NAMES.has(metadataSegment)) {
    return undefined;
  }
  if (fileName.startsWith('page.')) {
    return { routePath: routePathFromNextSegments(routeSegments), routeType: 'page' };
  }
  if (fileName.startsWith('layout.')) {
    return { routePath: routePathFromNextSegments(routeSegments), routeType: 'layout' };
  }
  if (fileName.startsWith('route.')) {
    return { routePath: routePathFromNextSegments(routeSegments), routeType: 'api' };
  }
  if (NEXT_METADATA_ROUTE_NAMES.has(metadataSegment)) {
    return {
      routePath: routePathFromNextSegments([...routeSegments, metadataSegment]),
      routeType: 'metadata',
    };
  }
  return undefined;
}

function isNextAppRouteFile(file: FileFact): boolean {
  return nextAppRouteInfo(file) !== undefined;
}

function nextRouteTypeLabel(routeType: NextAppRouteType): string {
  switch (routeType) {
    case 'api':
      return 'API route';
    case 'layout':
      return 'layout render';
    case 'metadata':
      return 'metadata asset route';
    case 'page':
      return 'page render';
  }
}

function nextRouteFlowKind(routeType: NextAppRouteType): FlowKind {
  if (routeType === 'api') return 'api';
  return 'ui';
}

function nextRouteStepType(routeType: NextAppRouteType): FlowStepType {
  if (routeType === 'api') return 'route';
  if (routeType === 'metadata') return 'route';
  return 'handler';
}

function nextRouteSymbol(routeType: NextAppRouteType): string {
  if (routeType === 'api') return 'route handler';
  return routeType;
}

function nextRouteConfigs(files: readonly FileFact[]): string[] {
  return files
    .filter((file) => {
      const name = basename(file.relativePath).toLowerCase();
      return (
        name === 'next.config.js' ||
        name === 'next.config.mjs' ||
        name === 'next.config.ts' ||
        name === 'package.json' ||
        name === 'tsconfig.json'
      );
    })
    .map((file) => file.relativePath);
}

function nextRouteTestPaths(params: {
  readonly routeFile: FileFact;
  readonly routePath: string;
  readonly componentIds: readonly string[];
  readonly tests: readonly BrainEntity[];
}): string[] {
  const routeDir = dirname(params.routeFile.relativePath).split(sep).join('/');
  const fileStem = basename(params.routeFile.relativePath).replace(/\.(ts|tsx|js|jsx)$/i, '');
  const routePathNeedle = params.routePath.replace(/^\//, '').toLowerCase();
  const componentPathNeedles = params.componentIds.map(componentPathFromId);
  return unique(
    params.tests
      .filter((test) =>
        test.source_files.some((file) => {
          const lower = file.toLowerCase();
          return (
            file.startsWith(`${routeDir}/`) ||
            lower.includes(fileStem.toLowerCase()) ||
            (routePathNeedle !== '' && lower.includes(routePathNeedle)) ||
            componentPathNeedles.some((componentPath) => file.startsWith(`${componentPath}/`))
          );
        }),
      )
      .flatMap((test) => test.source_files),
  );
}

function nextRouteDescription(
  routeType: NextAppRouteType,
  routePath: string,
  filePath: string,
): string {
  switch (routeType) {
    case 'api':
      return `Next.js app-router API route ${safeText(routePath)} enters ${safeText(filePath)}.`;
    case 'layout':
      return `Next.js app-router layout ${safeText(routePath)} renders through ${safeText(filePath)}.`;
    case 'metadata':
      return `Next.js app-router metadata asset ${safeText(routePath)} is generated by ${safeText(filePath)}.`;
    case 'page':
      return `Next.js app-router page ${safeText(routePath)} renders through ${safeText(filePath)}.`;
  }
}

function inferNextAppRouteFlow(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
  readonly file: FileFact;
  readonly routePath: string;
  readonly routeType: NextAppRouteType;
  readonly components: readonly BrainEntity[];
  readonly tests: readonly BrainEntity[];
  readonly changedFiles: ReadonlySet<string>;
}): FlowIntelligence {
  const importContext = importContextForFiles({
    rootDir: params.rootDir,
    files: params.files,
    entryFiles: [params.file],
  });
  const allScannedFiles = [params.file, ...importContext.importedFiles];
  const componentIds = componentIdsForFiles(
    allScannedFiles.map((file) => file.relativePath),
    params.components,
  );
  const relatedComponents = params.components.filter((component) =>
    componentIds.includes(component.id),
  );
  const relatedTests = nextRouteTestPaths({
    routeFile: params.file,
    routePath: params.routePath,
    componentIds,
    tests: params.tests,
  });
  const configs = unique([
    ...nextRouteConfigs(params.files),
    ...relatedComponents.flatMap((component) => stringArrayData(component, 'configs')),
  ]);
  const dependencies = unique(
    importContext.importedSpecifiers
      .filter((specifier) => !specifier.startsWith('.'))
      .map((dependency) => entityId('dependency', dependency)),
  );
  const flowId = entityId(
    'flow',
    `nextjs/${params.routeType}/${params.routePath}/${params.file.relativePath}`,
  );
  const evId = evidenceId(params.file.relativePath);
  const risks: FlowRisk[] = [];
  if (relatedTests.length === 0) {
    risks.push({
      risk_id: `${flowId}:missing-test`,
      kind: 'missing_test',
      description: `No directly linked test artifact was detected for this Next.js ${nextRouteTypeLabel(
        params.routeType,
      )}.`,
      evidence: [evId],
    });
  }
  if (configs.length === 0) {
    risks.push({
      risk_id: `${flowId}:missing-config`,
      kind: 'missing_config',
      description: 'No Next.js package or config artifact was detected for this route flow.',
      evidence: [evId],
    });
  }
  if (params.changedFiles.has(params.file.relativePath)) {
    risks.push({
      risk_id: `${flowId}:changed-hotspot`,
      kind: 'changed_hotspot',
      description: 'The Next.js route file changed in the latest scan.',
      evidence: [evId],
    });
  }
  const steps: FlowStep[] = [
    {
      step_id: flowStepId(flowId, 1),
      order: 1,
      type: nextRouteStepType(params.routeType),
      path: safeText(params.file.relativePath),
      symbol: nextRouteSymbol(params.routeType),
      description: nextRouteDescription(
        params.routeType,
        params.routePath,
        params.file.relativePath,
      ),
      evidence: [evId],
    },
    ...importContext.importedFiles.slice(0, 8).map((file, index) => ({
      step_id: flowStepId(flowId, index + 2),
      order: index + 2,
      type: 'service' as const,
      path: safeText(file.relativePath),
      symbol: null,
      description: `Next.js route statically imports ${safeText(file.relativePath)}.`,
      evidence: [evidenceId(file.relativePath)],
    })),
  ];
  let order = steps.length + 1;
  for (const config of configs.slice(0, 4)) {
    steps.push({
      step_id: flowStepId(flowId, order),
      order,
      type: 'config',
      path: safeText(config),
      symbol: null,
      description: `Next.js route behavior can be configured by ${safeText(config)}.`,
      evidence: [evidenceId(config)],
    });
    order += 1;
  }
  for (const test of relatedTests.slice(0, 4)) {
    steps.push({
      step_id: flowStepId(flowId, order),
      order,
      type: 'test',
      path: safeText(test),
      symbol: null,
      description: 'Related test artifact for this Next.js route flow.',
      evidence: [evidenceId(test)],
    });
    order += 1;
  }
  const signals = unique([
    'nextjs app router',
    'route file',
    `nextjs ${params.routeType} route`,
    ...(importContext.importedSpecifiers.length > 0 ? ['static import'] : []),
    ...(importContext.importedFiles.length > 0 ? ['relative import'] : []),
    ...(relatedTests.length > 0 ? ['test artifact'] : []),
    ...(configs.length > 0 ? ['configuration'] : []),
  ]);
  const unknowns = unique([
    ...(componentIds.length === 0
      ? ['No owning component was detected for this Next.js route file.']
      : []),
    ...(readTextIfAvailable(params.rootDir, params.file.relativePath)?.includes('import(')
      ? ['Dynamic import is static evidence only; runtime reachability is not traced.']
      : []),
  ]);
  const kind = nextRouteFlowKind(params.routeType);
  const baseConfidence = flowConfidenceFor({ tests: relatedTests, signals, unknowns });
  const entrypoints: FlowEntrypoint[] = [
    {
      type: 'route',
      path: safeText(params.file.relativePath),
      symbol: safeText(params.routePath),
      component_id: componentIds[0] ?? null,
      evidence: [evId],
    },
  ];
  const files = unique([
    params.file.relativePath,
    ...importContext.importedFiles.map((file) => file.relativePath),
  ]);
  const routeContract: RouteContractContext = {
    framework: 'nextjs-app-router',
    route_path: params.routePath,
    route_type: params.routeType,
    entry_file: params.file.relativePath,
  };
  const contracts = inferFlowContracts({
    rootDir: params.rootDir,
    kind,
    entrypoints,
    steps,
    files,
    configs,
    tests: relatedTests,
    risks,
    signals,
    confidenceReason: baseConfidence.reason,
    routeContract,
  });
  return {
    flow_id: flowId,
    name: `Next.js ${safeText(params.routePath)} ${nextRouteTypeLabel(params.routeType)}`,
    kind,
    framework: 'nextjs-app-router',
    route_path: safeText(params.routePath),
    route_type: params.routeType,
    entrypoints,
    steps,
    components: componentIds,
    files,
    dependencies,
    configs,
    tests: relatedTests,
    risks,
    entry_contract: contracts.entry_contract,
    exit_contract: contracts.exit_contract,
    inputs: contracts.inputs,
    outputs: contracts.outputs,
    side_effects: contracts.side_effects,
    state_transitions: contracts.state_transitions,
    failure_modes: contracts.failure_modes,
    required_tests: contracts.required_tests,
    confidence_reasons: contracts.confidence_reasons,
    confidence: { score: baseConfidence.score, reason: baseConfidence.reason },
    evidence: [
      flowEvidenceForNeedle({
        rootDir: params.rootDir,
        path: params.file.relativePath,
        needle: /export|default|GET|POST|ImageResponse|metadata/i,
        reason: 'Next.js app-router file pattern is the flow entrypoint evidence.',
      }),
      ...importContext.importEvidence,
    ],
    field_evidence: {
      entrypoints: [evId],
      steps: unique(steps.flatMap((step) => step.evidence)),
      components: componentIds.flatMap(
        (id) => params.components.find((item) => item.id === id)?.evidence_ids ?? [],
      ),
      files: unique([
        evId,
        ...importContext.importedFiles.map((file) => evidenceId(file.relativePath)),
      ]),
      dependencies: importContext.importedSpecifiers.length > 0 ? [evId] : [],
      configs: configs.map(evidenceId),
      tests: relatedTests.map(evidenceId),
      risks: risks.flatMap((risk) => risk.evidence),
      ...contracts.field_evidence,
    },
    unknowns,
    signals,
  };
}

function inferRouteFlow(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
  readonly file: FileFact;
  readonly components: readonly BrainEntity[];
  readonly tests: readonly BrainEntity[];
  readonly changedFiles: ReadonlySet<string>;
}): FlowIntelligence {
  const importContext = importContextForFiles({
    rootDir: params.rootDir,
    files: params.files,
    entryFiles: [params.file],
  });
  const allScannedFiles = [params.file, ...importContext.importedFiles];
  const componentIds = componentIdsForFiles(
    allScannedFiles.map((file) => file.relativePath),
    params.components,
  );
  const relatedTests = params.tests
    .filter((test) => {
      const base = basename(params.file.relativePath).replace(/\.(ts|js|tsx|jsx)$/i, '');
      return test.source_files.some(
        (file) => file.includes(base) || file.includes(componentPathFromId(componentIds[0] ?? '')),
      );
    })
    .flatMap((test) => test.source_files);
  const flowId = entityId('flow', `api/${params.file.relativePath}`);
  const evId = evidenceId(params.file.relativePath);
  const risks: FlowRisk[] = [];
  if (relatedTests.length === 0) {
    risks.push({
      risk_id: `${flowId}:missing-test`,
      kind: 'missing_test',
      description: 'No directly linked test artifact was detected for this API flow.',
      evidence: [evId],
    });
  }
  if (params.changedFiles.has(params.file.relativePath)) {
    risks.push({
      risk_id: `${flowId}:changed-hotspot`,
      kind: 'changed_hotspot',
      description: 'The route file changed in the latest scan.',
      evidence: [evId],
    });
  }
  const configs = unique(
    params.components
      .filter((component) => componentIds.includes(component.id))
      .flatMap((component) => stringArrayData(component, 'configs')),
  );
  const dependencies = unique(
    importContext.importedSpecifiers
      .filter((specifier) => !specifier.startsWith('.'))
      .map((dependency) => entityId('dependency', dependency)),
  );
  const steps: FlowStep[] = [
    {
      step_id: flowStepId(flowId, 1),
      order: 1,
      type: 'route',
      path: safeText(params.file.relativePath),
      symbol: null,
      description: `API route entrypoint at ${safeText(params.file.relativePath)}.`,
      evidence: [evId],
    },
    ...importContext.importedFiles.slice(0, 6).map((file, index) => ({
      step_id: flowStepId(flowId, index + 2),
      order: index + 2,
      type: 'service' as const,
      path: safeText(file.relativePath),
      symbol: null,
      description: `Route statically imports ${safeText(file.relativePath)}.`,
      evidence: [evidenceId(file.relativePath)],
    })),
  ];
  const signals = unique([
    'route file',
    ...(importContext.importedSpecifiers.length > 0 ? ['static import'] : []),
    ...(importContext.importedFiles.length > 0 ? ['relative import'] : []),
    ...(relatedTests.length > 0 ? ['test artifact'] : []),
    ...(configs.length > 0 ? ['configuration'] : []),
  ]);
  const baseConfidence = flowConfidenceFor({ tests: relatedTests, signals, unknowns: [] });
  const entrypoints: FlowEntrypoint[] = [
    {
      type: 'route',
      path: safeText(params.file.relativePath),
      symbol: null,
      component_id: componentIds[0] ?? null,
      evidence: [evId],
    },
  ];
  const files = unique([
    params.file.relativePath,
    ...importContext.importedFiles.map((file) => file.relativePath),
  ]);
  const contracts = inferFlowContracts({
    rootDir: params.rootDir,
    kind: 'api',
    entrypoints,
    steps,
    files,
    configs,
    tests: unique(relatedTests),
    risks,
    signals,
    confidenceReason: baseConfidence.reason,
  });
  return {
    flow_id: flowId,
    name: `${safeText(basename(params.file.relativePath))} API flow`,
    kind: 'api',
    entrypoints,
    steps,
    components: componentIds,
    files,
    dependencies,
    configs,
    tests: unique(relatedTests),
    risks,
    entry_contract: contracts.entry_contract,
    exit_contract: contracts.exit_contract,
    inputs: contracts.inputs,
    outputs: contracts.outputs,
    side_effects: contracts.side_effects,
    state_transitions: contracts.state_transitions,
    failure_modes: contracts.failure_modes,
    required_tests: contracts.required_tests,
    confidence_reasons: contracts.confidence_reasons,
    confidence: { score: baseConfidence.score, reason: baseConfidence.reason },
    evidence: [
      flowEvidenceForNeedle({
        rootDir: params.rootDir,
        path: params.file.relativePath,
        needle: /route|handler|get|post|put|delete|export/i,
        reason: 'Route-like file pattern is the flow entrypoint evidence.',
      }),
      ...importContext.importEvidence,
    ],
    field_evidence: {
      entrypoints: [evId],
      steps: unique(steps.flatMap((step) => step.evidence)),
      components: componentIds.flatMap(
        (id) => params.components.find((item) => item.id === id)?.evidence_ids ?? [],
      ),
      files: unique([
        evId,
        ...importContext.importedFiles.map((file) => evidenceId(file.relativePath)),
      ]),
      dependencies: importContext.importedSpecifiers.length > 0 ? [evId] : [],
      configs: configs.map(evidenceId),
      tests: relatedTests.map(evidenceId),
      risks: risks.flatMap((risk) => risk.evidence),
      ...contracts.field_evidence,
    },
    unknowns:
      componentIds.length === 0 ? ['No owning component was detected for this route file.'] : [],
    signals,
  };
}

function buildFlowEntity(
  intelligence: FlowIntelligence,
  now: string,
  createdAt?: string,
): BrainEntity {
  const confidence = flowConfidenceFor({
    tests: intelligence.tests,
    signals: intelligence.signals,
    unknowns: intelligence.unknowns,
  });
  return makeEntity({
    id: intelligence.flow_id,
    type: 'flow',
    name: intelligence.name,
    description: `${intelligence.kind} flow reconstructed from local evidence.`,
    now,
    ...(createdAt !== undefined ? { createdAt } : {}),
    confidence: confidence.confidence,
    evidenceIds: unique([
      ...intelligence.entrypoints.flatMap((entrypoint) => entrypoint.evidence),
      ...intelligence.steps.flatMap((step) => step.evidence),
      ...intelligence.risks.flatMap((risk) => risk.evidence),
    ]),
    relatedEntityIds: unique([
      ...intelligence.components,
      ...intelligence.dependencies,
      ...intelligence.configs.map((config) => entityId('config', config)),
      ...intelligence.tests.map((test) => entityId('test', test)),
    ]),
    sourceFiles: intelligence.files,
    data: { ...intelligence, confidence: { ...intelligence.confidence, score: confidence.score } },
  });
}

function reconstructFlows(params: {
  readonly rootDir: string;
  readonly now: string;
  readonly files: readonly FileFact[];
  readonly packageFacts: readonly PackageJsonFact[];
  readonly buckets: BrainBuckets;
  readonly relationships: BrainRelationship[];
  readonly changedFiles: readonly string[];
  readonly previousFlows: ReadonlyMap<string, BrainEntity>;
}): void {
  const changedFileSet = new Set(params.changedFiles);
  const flowIntelligence: FlowIntelligence[] = [];
  for (const pkg of params.packageFacts) {
    for (const [scriptName, command] of Object.entries(pkg.scripts)) {
      flowIntelligence.push(
        inferScriptFlow({
          rootDir: params.rootDir,
          files: params.files,
          packageFacts: params.packageFacts,
          packageFact: pkg,
          scriptName,
          command,
          components: params.buckets.components,
          changedFiles: changedFileSet,
        }),
      );
    }
  }
  const nextAppRouteFiles = params.files.filter(isNextAppRouteFile);
  const nextAppRouteFilePaths = new Set(nextAppRouteFiles.map((file) => file.relativePath));
  for (const file of nextAppRouteFiles) {
    const routeInfo = nextAppRouteInfo(file);
    if (routeInfo === undefined) continue;
    flowIntelligence.push(
      inferNextAppRouteFlow({
        rootDir: params.rootDir,
        files: params.files,
        file,
        routePath: routeInfo.routePath,
        routeType: routeInfo.routeType,
        components: params.buckets.components,
        tests: params.buckets.tests,
        changedFiles: changedFileSet,
      }),
    );
  }
  for (const file of params.files.filter(
    (item) => isRouteLikeFile(item) && !nextAppRouteFilePaths.has(item.relativePath),
  )) {
    flowIntelligence.push(
      inferRouteFlow({
        rootDir: params.rootDir,
        files: params.files,
        file,
        components: params.buckets.components,
        tests: params.buckets.tests,
        changedFiles: changedFileSet,
      }),
    );
  }

  const byId = new Map<string, FlowIntelligence>();
  for (const flow of flowIntelligence) byId.set(flow.flow_id, flow);

  for (const flow of sorted([...byId.values()], (item) => item.flow_id)) {
    const previous = params.previousFlows.get(flow.flow_id);
    const entity = buildFlowEntity(flow, params.now, previous?.created_at);
    params.buckets.flows.push(entity);
    for (const componentId of flow.components) {
      addRelation(
        params.relationships,
        flow.flow_id,
        'calls',
        componentId,
        flow.field_evidence.components ?? entity.evidence_ids,
        entity.confidence,
      );
    }
    for (const dependencyId of flow.dependencies) {
      addRelation(
        params.relationships,
        flow.flow_id,
        'depends_on',
        dependencyId,
        flow.field_evidence.dependencies ?? entity.evidence_ids,
        'inferred',
      );
    }
    for (const configPath of flow.configs) {
      addRelation(
        params.relationships,
        flow.flow_id,
        'configures',
        entityId('config', configPath),
        [evidenceId(configPath)],
        'inferred',
      );
    }
    for (const filePath of flow.files) {
      addRelation(
        params.relationships,
        flow.flow_id,
        'depends_on',
        entityId('file', filePath),
        [evidenceId(filePath)],
        'inferred',
      );
    }
    for (const testPath of flow.tests) {
      addRelation(
        params.relationships,
        entityId('test', testPath),
        'tests',
        flow.flow_id,
        [evidenceId(testPath)],
        'inferred',
      );
    }
  }
  for (const [flowId, previous] of params.previousFlows.entries()) {
    if (byId.has(flowId)) continue;
    params.buckets.flows.push(
      makeEntity({
        id: previous.id,
        type: 'flow',
        name: previous.name,
        description: `Previously known flow ${safeText(previous.name)} was not reconstructed in this scan.`,
        now: params.now,
        createdAt: previous.created_at,
        confidence: 'uncertain',
        evidenceIds: previous.evidence_ids,
        relatedEntityIds: previous.related_entity_ids,
        sourceFiles: previous.source_files,
        latestStatus: 'stale',
        data: {
          ...(previous.data ?? {}),
          unknowns: unique([
            ...stringArrayData(previous, 'unknowns'),
            'Flow was not reconstructed in the latest scan; rerun with full source context or inspect stale evidence.',
          ]),
        },
      }),
    );
  }
}

function inferComponentIntelligence(
  rootDir: string,
  componentPath: string,
  files: readonly FileFact[],
  packageFacts: readonly PackageJsonFact[],
  componentPaths: readonly string[],
): ComponentIntelligence {
  const packages = packageFactsForComponent(packageFacts, componentPath);
  const boundaryType = boundaryTypeForComponent(componentPath, files, packages);
  const responsibilities = responsibilitiesForComponent(componentPath, files, packages);
  const interfaces = interfacesForComponent(packages, files);
  const entryPoints = entryPointsForComponent(packages, files);
  const consumers = consumersForComponent(componentPath, files);
  const dependencies = dependenciesForComponent(packages);
  const dependencyRoles = dependencyRolesForComponent(packages);
  const exposedApis = exposedApisForComponent(files);
  const tests = testPathsForComponent(files);
  const configs = configPathsForComponent(files);
  const coupling = couplingForComponent({
    rootDir,
    componentPath,
    files,
    packageFacts,
    componentPaths,
  });
  const couplingEvidenceIds = couplingEvidenceIdsForComponent({ rootDir, files, packages });
  const criticality = criticalityForComponent(componentPath, files, packages);
  const blastRadius = blastRadiusForComponent({
    criticality: criticality.label,
    boundaryType,
    coupling,
    entryPoints,
    exposedApis,
  });
  const riskySeams = riskySeamsForComponent({
    boundaryType,
    criticality: criticality.label,
    coupling,
    configs,
    tests,
    exposedApis,
  });
  const componentEvidenceIds = files.slice(0, 12).map((file) => evidenceId(file.relativePath));
  const testEvidenceIds = tests.map(evidenceId);
  const configEvidenceIds = configs.map(evidenceId);
  const apiEvidenceIds = exposedApis
    .map((api) => sourceFileFromSignal(api, new Set(files.map((file) => file.relativePath))))
    .filter((file): file is string => file !== undefined)
    .map(evidenceId);
  const dependencyEvidenceIds = packages.map((pkg) => evidenceId(pkg.relativePath));
  const signals = componentSignals(files, packages);
  const ownershipConfidence = ownershipConfidenceForComponent({
    boundaryType,
    files,
    packages,
    signals,
    entryPoints,
    tests,
  });
  const tradeoffs = tradeoffsForComponent({
    boundaryType,
    dependencies,
    entryPoints,
    configs,
    tests,
    exposedApis,
    coupling,
  });
  const failureModes = failureModesForComponent({
    componentPath,
    boundaryType,
    dependencies,
    entryPoints,
    configs,
    tests,
    exposedApis,
    coupling,
  });
  const readFirst = firstFilesToRead(files);
  const entryPointEvidenceIds = unique([
    ...configEvidenceIds,
    ...apiEvidenceIds,
    ...componentEvidenceIds,
  ]);
  const tradeoffEvidenceIds = unique([
    ...(entryPoints.length > 0 ? entryPointEvidenceIds : []),
    ...(boundaryType === 'adapter' || boundaryType === 'orchestration' ? componentEvidenceIds : []),
    ...(dependencies.length > 8 ? dependencyEvidenceIds : []),
    ...(configs.length > 0 ? configEvidenceIds : []),
    ...(exposedApis.length > 0 && entryPoints.length === 0 ? apiEvidenceIds : []),
  ]);
  const failureModeEvidenceIds = unique([
    ...(entryPoints.length > 0 ? entryPointEvidenceIds : []),
    ...(configs.length > 0 ? configEvidenceIds : []),
    ...(dependencies.length > 0 ? dependencyEvidenceIds : []),
    ...(exposedApis.length > 0 ? apiEvidenceIds : []),
  ]);
  const knownRiskEvidenceIds = unique([
    ...(dependencies.length > 10 ? dependencyEvidenceIds : []),
    ...(exposedApis.length > 0 && consumers.length === 0 ? apiEvidenceIds : []),
  ]);
  const partial = {
    purpose: purposeForComponent(componentPath, packages),
    boundary_type: boundaryType,
    responsibilities,
    interfaces,
    entry_points: entryPoints,
    consumers,
    dependencies,
    dependency_roles: dependencyRoles,
    exposed_apis: exposedApis,
    tests,
    configs,
    coupling,
    criticality: criticality.label,
    criticality_score: criticality.score,
    blast_radius: blastRadius,
    ownership_confidence: ownershipConfidence,
    tradeoffs,
    failure_modes: failureModes,
    important_files: readFirst,
    read_first: readFirst,
    unknowns: unknownsForComponent({
      boundaryType,
      signals,
      consumers,
      dependencies,
      entryPoints,
      tests,
    }),
    signals,
  };
  const whatBreaksIfRemoved = whatBreaksIfRemovedForComponent(componentPath, partial);
  return {
    ...partial,
    what_breaks_if_removed: whatBreaksIfRemoved,
    risky_seams: riskySeams,
    known_risks: knownRisksForComponent({
      ...partial,
    }),
    field_evidence: {
      purpose: componentEvidenceIds,
      boundary_type: componentEvidenceIds,
      responsibilities: componentEvidenceIds,
      interfaces: unique([...configEvidenceIds, ...apiEvidenceIds, ...componentEvidenceIds]),
      entry_points: unique([...configEvidenceIds, ...apiEvidenceIds, ...componentEvidenceIds]),
      consumers: componentEvidenceIds,
      dependencies: dependencyEvidenceIds,
      dependency_roles: dependencyEvidenceIds,
      exposed_apis: apiEvidenceIds,
      tests: testEvidenceIds,
      configs: configEvidenceIds,
      coupling: couplingEvidenceIds,
      criticality: componentEvidenceIds,
      blast_radius: componentEvidenceIds,
      ownership_confidence: unique([
        ...componentEvidenceIds,
        ...configEvidenceIds,
        ...testEvidenceIds,
      ]),
      tradeoffs: tradeoffEvidenceIds,
      failure_modes: failureModeEvidenceIds,
      what_breaks_if_removed: unique([
        ...componentEvidenceIds,
        ...configEvidenceIds,
        ...apiEvidenceIds,
      ]),
      risky_seams: unique([...componentEvidenceIds, ...configEvidenceIds, ...apiEvidenceIds]),
      important_files: componentEvidenceIds,
      read_first: componentEvidenceIds,
      known_risks: knownRiskEvidenceIds,
      unknowns: componentEvidenceIds,
    },
  };
}

function confidenceForComponent(intelligence: ComponentIntelligence): Confidence {
  if (intelligence.ownership_confidence.score < 0.5) return 'uncertain';
  if (intelligence.signals.length <= 1) return 'uncertain';
  if (
    intelligence.coupling.level !== 'low' &&
    (intelligence.field_evidence.coupling ?? []).length === 0
  ) {
    return 'uncertain';
  }
  if (
    intelligence.ownership_confidence.score >= 0.85 &&
    intelligence.tests.length > 0 &&
    intelligence.entry_points.length > 0
  ) {
    return 'inferred';
  }
  if (
    intelligence.signals.includes('package manifest') &&
    intelligence.signals.includes('source files')
  ) {
    return 'inferred';
  }
  return 'inferred';
}

function sourceFileFromSignal(signal: string, knownFiles: ReadonlySet<string>): string | undefined {
  const candidate = signal.slice(signal.indexOf(': ') + 2);
  return knownFiles.has(candidate) ? candidate : undefined;
}

function configFiles(files: readonly FileFact[]): FileFact[] {
  return files.filter((file) => isConfigPath(file.relativePath));
}

function testFiles(files: readonly FileFact[]): FileFact[] {
  return files.filter((file) => isTestPath(file.relativePath));
}

function classifySourceKind(file: FileFact): string {
  if (file.relativePath.endsWith('package.json')) return 'package-manifest';
  if (isConfigPath(file.relativePath)) return 'config';
  if (isTestPath(file.relativePath)) return 'test';
  if (isSourceFile(file.relativePath)) return 'source';
  if (file.extension === '.md') return 'documentation';
  return file.extension === '' ? 'file' : file.extension.slice(1);
}

function allBucketEntities(buckets: BrainBuckets): BrainEntity[] {
  return ENTITY_FILES.flatMap(([bucket]) => buckets[bucket]);
}

function countByValue(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function countByConfidence(values: readonly Confidence[]): Record<Confidence, number> {
  const counts: Record<Confidence, number> = { verified: 0, inferred: 0, uncertain: 0 };
  for (const value of values) counts[value] += 1;
  return counts;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function scorePercent(numerator: number, denominator: number): number {
  return Math.round(ratio(numerator, denominator) * 100);
}

function evidenceQualityBand(score: number, redactionSafetyScore: number): string {
  if (redactionSafetyScore < 100) return 'unsafe';
  if (score >= 85) return 'strong';
  if (score >= 65) return 'usable';
  if (score >= 40) return 'weak';
  return 'unsafe';
}

interface FieldCoverageSummary {
  readonly total_fields: number;
  readonly fields_with_values: number;
  readonly fields_with_evidence: number;
  readonly unsupported_fields: number;
  readonly weak_evidence_fields: number;
  readonly field_coverage_ratio: number;
  readonly evidence_coverage_ratio: number;
}

interface EvidenceGap {
  readonly kind: string;
  readonly id: string;
  readonly severity: 'high' | 'medium' | 'low';
  readonly reason: string;
  readonly entity_type?: EntityType | 'relationship';
  readonly field?: string;
  readonly confidence?: Confidence;
}

function flowFieldHasValue(flow: BrainEntity, field: string): boolean {
  const value = flow.data?.[field];
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

function fieldCoverageForComponents(components: readonly BrainEntity[]): FieldCoverageSummary {
  let fieldsWithValues = 0;
  let fieldsWithEvidence = 0;
  let unsupportedFields = 0;
  let weakEvidenceFields = 0;
  for (const component of components) {
    const fieldEvidence = recordStringArrayData(component, 'field_evidence');
    for (const field of COMPONENT_UNDERSTANDING_FIELDS) {
      if (!componentFieldHasValue(component, field)) continue;
      fieldsWithValues += 1;
      const evidenceCount = (fieldEvidence[field] ?? []).length;
      if (evidenceCount === 0) {
        unsupportedFields += 1;
        continue;
      }
      fieldsWithEvidence += 1;
      if (component.confidence !== 'verified') weakEvidenceFields += 1;
    }
  }
  const totalFields = components.length * COMPONENT_UNDERSTANDING_FIELDS.length;
  return {
    total_fields: totalFields,
    fields_with_values: fieldsWithValues,
    fields_with_evidence: fieldsWithEvidence,
    unsupported_fields: unsupportedFields,
    weak_evidence_fields: weakEvidenceFields,
    field_coverage_ratio: ratio(fieldsWithValues, totalFields),
    evidence_coverage_ratio: ratio(fieldsWithEvidence, fieldsWithValues),
  };
}

const FLOW_UNDERSTANDING_FIELDS = [
  'entrypoints',
  'steps',
  'components',
  'files',
  'dependencies',
  'configs',
  'tests',
  'risks',
  'entry_contract',
  'exit_contract',
  'inputs',
  'outputs',
  'side_effects',
  'state_transitions',
  'failure_modes',
  'required_tests',
  'confidence_reasons',
] as const;

function fieldCoverageForFlows(flows: readonly BrainEntity[]): FieldCoverageSummary {
  let fieldsWithValues = 0;
  let fieldsWithEvidence = 0;
  let unsupportedFields = 0;
  let weakEvidenceFields = 0;
  for (const flow of flows) {
    const fieldEvidence = recordStringArrayData(flow, 'field_evidence');
    for (const field of FLOW_UNDERSTANDING_FIELDS) {
      if (!flowFieldHasValue(flow, field)) continue;
      fieldsWithValues += 1;
      const evidenceCount = (fieldEvidence[field] ?? []).length;
      if (evidenceCount === 0) {
        unsupportedFields += 1;
        continue;
      }
      fieldsWithEvidence += 1;
      if (flow.confidence !== 'verified') weakEvidenceFields += 1;
    }
  }
  const totalFields = flows.length * FLOW_UNDERSTANDING_FIELDS.length;
  return {
    total_fields: totalFields,
    fields_with_values: fieldsWithValues,
    fields_with_evidence: fieldsWithEvidence,
    unsupported_fields: unsupportedFields,
    weak_evidence_fields: weakEvidenceFields,
    field_coverage_ratio: ratio(fieldsWithValues, totalFields),
    evidence_coverage_ratio: ratio(fieldsWithEvidence, fieldsWithValues),
  };
}

function fieldCoverageByEntityType(params: {
  readonly components: readonly BrainEntity[];
  readonly flows: readonly BrainEntity[];
}): Record<'component' | 'flow', FieldCoverageSummary> {
  return {
    component: fieldCoverageForComponents(params.components),
    flow: fieldCoverageForFlows(params.flows),
  };
}

function fieldEvidenceGapRecords(params: {
  readonly components: readonly BrainEntity[];
  readonly flows: readonly BrainEntity[];
}): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  for (const component of params.components) {
    const fieldEvidence = recordStringArrayData(component, 'field_evidence');
    for (const field of COMPONENT_UNDERSTANDING_FIELDS) {
      if (!componentFieldHasValue(component, field)) continue;
      const evidenceCount = (fieldEvidence[field] ?? []).length;
      if (evidenceCount === 0) {
        gaps.push({
          kind: 'unsupported_field',
          id: component.id,
          entity_type: 'component',
          field,
          severity: 'medium',
          confidence: component.confidence,
          reason: 'Field has a value but no field-specific evidence reference.',
        });
      }
    }
  }
  for (const flow of params.flows) {
    const fieldEvidence = recordStringArrayData(flow, 'field_evidence');
    for (const field of FLOW_UNDERSTANDING_FIELDS) {
      if (!flowFieldHasValue(flow, field)) continue;
      const evidenceCount = (fieldEvidence[field] ?? []).length;
      if (evidenceCount === 0) {
        gaps.push({
          kind: 'unsupported_field',
          id: flow.id,
          entity_type: 'flow',
          field,
          severity: 'medium',
          confidence: flow.confidence,
          reason: 'Flow field has a value but no field-specific evidence reference.',
        });
      }
    }
  }
  return gaps;
}

function topEvidenceGaps(params: {
  readonly entitiesWithoutEvidence: readonly BrainEntity[];
  readonly relationshipsWithoutEvidence: readonly BrainRelationship[];
  readonly missingEvidenceReferences: readonly string[];
  readonly fieldGaps: readonly EvidenceGap[];
}): EvidenceGap[] {
  const gaps: EvidenceGap[] = [
    ...params.missingEvidenceReferences.map((id) => ({
      kind: 'missing_reference',
      id: safeText(id),
      severity: 'high' as const,
      reason: 'Claim references an evidence id that was not emitted.',
    })),
    ...params.relationshipsWithoutEvidence.map((relationship) => ({
      kind: 'unsupported_relationship',
      id: `${safeText(relationship.from)} ${relationship.relation} ${safeText(relationship.to)}`,
      entity_type: 'relationship' as const,
      severity: 'high' as const,
      confidence: relationship.confidence,
      reason: 'Relationship claim has no evidence reference.',
    })),
    ...params.entitiesWithoutEvidence
      .filter((entity) => entity.type !== 'evidence')
      .map((entity) => ({
        kind: 'unsupported_entity',
        id: entity.id,
        entity_type: entity.type,
        severity: 'medium' as const,
        confidence: entity.confidence,
        reason: 'Entity claim has no evidence reference.',
      })),
    ...params.fieldGaps,
  ];
  const severityRank = (severity: EvidenceGap['severity']): number => {
    if (severity === 'high') return 0;
    if (severity === 'medium') return 1;
    return 2;
  };
  return gaps
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id) ||
        (a.field ?? '').localeCompare(b.field ?? ''),
    )
    .slice(0, 15);
}

function buildEvidenceQualityArtifact(params: {
  readonly now: string;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
}): Record<string, unknown> {
  const entities = allBucketEntities(params.buckets);
  const claimEntities = entities.filter((entity) => entity.type !== 'evidence');
  const referencedEvidenceIds = unique([
    ...entities.flatMap((entity) => entity.evidence_ids),
    ...params.relationships.flatMap((relationship) => relationship.evidence_ids),
  ]);
  const knownEvidenceIds = new Set(params.buckets.evidence.map((entity) => entity.id));
  const missingEvidenceReferences = referencedEvidenceIds.filter((id) => !knownEvidenceIds.has(id));
  const entitiesWithEvidence = entities.filter((entity) => entity.evidence_ids.length > 0);
  const entitiesWithoutEvidence = entities.filter((entity) => entity.evidence_ids.length === 0);
  const relationshipsWithEvidence = params.relationships.filter(
    (relationship) => relationship.evidence_ids.length > 0,
  );
  const relationshipsWithoutEvidence = params.relationships.filter(
    (relationship) => relationship.evidence_ids.length === 0,
  );
  const totalClaims = entities.length + params.relationships.length;
  const claimsWithEvidence = entitiesWithEvidence.length + relationshipsWithEvidence.length;
  const claimsWithoutEvidence =
    entitiesWithoutEvidence.length + relationshipsWithoutEvidence.length;
  const claimEntitiesWithoutEvidence = claimEntities.filter(
    (entity) => entity.evidence_ids.length === 0,
  );
  const claimEntitiesWithWeakEvidence = claimEntities.filter(
    (entity) => entity.evidence_ids.length > 0 && entity.confidence !== 'verified',
  );
  const relationshipsWithWeakEvidence = relationshipsWithEvidence.filter(
    (relationship) => relationship.confidence !== 'verified',
  );
  const confidenceDistribution = countByConfidence([
    ...entities.map((entity) => entity.confidence),
    ...params.relationships.map((relationship) => relationship.confidence),
  ]);
  const redactedEvidenceCount = params.buckets.evidence.filter((entity) =>
    containsSensitiveReference(entity),
  ).length;
  const redactedReferenceCount = redactedReferenceCountForBrain({
    entities,
    relationships: params.relationships,
  });
  const unsafeSensitiveReferenceCount = unredactedSensitiveReferenceCount(
    safeBrainValue({ entities, relationships: params.relationships }),
  );
  const confidenceDowngradeCount = entities.filter(
    (entity) => numberData(entity, 'redacted_evidence_count') !== undefined,
  ).length;
  const entityCoverageScore = scorePercent(entitiesWithEvidence.length, entities.length);
  const relationshipCoverageScore = scorePercent(
    relationshipsWithEvidence.length,
    params.relationships.length,
  );
  const fieldEvidenceEntries = [
    ...params.buckets.components.flatMap((component) =>
      Object.values(recordStringArrayData(component, 'field_evidence')),
    ),
    ...params.buckets.flows.flatMap((flow) =>
      Object.values(recordStringArrayData(flow, 'field_evidence')),
    ),
  ];
  const fieldsWithEvidence = fieldEvidenceEntries.filter((ids) => ids.length > 0).length;
  const fieldEvidenceScore = scorePercent(fieldsWithEvidence, fieldEvidenceEntries.length);
  const fieldCoverage = fieldCoverageByEntityType({
    components: params.buckets.components,
    flows: params.buckets.flows,
  });
  const fieldGaps = fieldEvidenceGapRecords({
    components: params.buckets.components,
    flows: params.buckets.flows,
  });
  const unsupportedFieldClaims =
    fieldCoverage.component.unsupported_fields + fieldCoverage.flow.unsupported_fields;
  const weakEvidenceFieldClaims =
    fieldCoverage.component.weak_evidence_fields + fieldCoverage.flow.weak_evidence_fields;
  const unsupportedClaims =
    claimEntitiesWithoutEvidence.length +
    relationshipsWithoutEvidence.length +
    unsupportedFieldClaims;
  const weakEvidenceClaims =
    claimEntitiesWithWeakEvidence.length +
    relationshipsWithWeakEvidence.length +
    weakEvidenceFieldClaims;
  const evidenceGapCount =
    missingEvidenceReferences.length + unsupportedClaims + weakEvidenceClaims;
  const evidenceCoverageScore = scorePercent(claimsWithEvidence, totalClaims);
  const referenceIntegrityScore = Math.max(0, 100 - missingEvidenceReferences.length * 10);
  const redactionSafetyScore = Math.max(0, 100 - unsafeSensitiveReferenceCount * 25);
  const overallScore = Math.round(
    evidenceCoverageScore * 0.4 +
      referenceIntegrityScore * 0.25 +
      fieldEvidenceScore * 0.2 +
      redactionSafetyScore * 0.15,
  );
  const topUncertainAreas = unique([
    ...entitiesWithoutEvidence.slice(0, 8).map((entity) => `${entity.type}: ${entity.id}`),
    ...entities
      .filter((entity) => entity.confidence === 'uncertain')
      .slice(0, 8)
      .map((entity) => `${entity.type}: ${entity.id}`),
    ...missingEvidenceReferences.slice(0, 8).map((id) => `missing evidence: ${id}`),
  ]).slice(0, 12);
  const topGaps = topEvidenceGaps({
    entitiesWithoutEvidence,
    relationshipsWithoutEvidence,
    missingEvidenceReferences,
    fieldGaps,
  });

  return {
    generated_at: params.now,
    total_claims: totalClaims,
    claims_with_evidence: claimsWithEvidence,
    claims_without_evidence: claimsWithoutEvidence,
    unsupported_claims: unsupportedClaims,
    weak_evidence_claims: weakEvidenceClaims,
    evidence_gap_count: evidenceGapCount,
    redacted_evidence_count: redactedEvidenceCount,
    redacted_reference_count: redactedReferenceCount,
    unsafe_sensitive_reference_count: unsafeSensitiveReferenceCount,
    verified_claim_count: confidenceDistribution.verified,
    inferred_claim_count: confidenceDistribution.inferred,
    uncertain_claim_count: confidenceDistribution.uncertain,
    evidence_coverage_score: evidenceCoverageScore,
    redaction_safety_score: redactionSafetyScore,
    confidence_distribution: confidenceDistribution,
    field_coverage_by_entity_type: fieldCoverage,
    confidence_adjustments: {
      redaction_downgrades: confidenceDowngradeCount,
      weak_entity_claims: claimEntitiesWithWeakEvidence.length,
      weak_relationship_claims: relationshipsWithWeakEvidence.length,
      weak_field_claims: weakEvidenceFieldClaims,
      unsupported_entity_claims: claimEntitiesWithoutEvidence.length,
      unsupported_relationship_claims: relationshipsWithoutEvidence.length,
      unsupported_field_claims: unsupportedFieldClaims,
    },
    top_evidence_gaps: topGaps,
    top_uncertain_areas: topUncertainAreas,
    overall_score: overallScore,
    quality_band: evidenceQualityBand(overallScore, redactionSafetyScore),
    coverage_score: evidenceCoverageScore,
    reference_integrity_score: referenceIntegrityScore,
    field_evidence_score: fieldEvidenceScore,
    redaction_penalty: 100 - redactionSafetyScore,
    redacted_evidence_records: redactedEvidenceCount,
    redacted_file_references: redactedReferenceCount,
    confidence_downgrades: confidenceDowngradeCount,
    unknowns_from_redaction: entities
      .filter((entity) => containsSensitiveReference(entity))
      .map((entity) => `Sensitive evidence redacted for ${entity.type}.`)
      .slice(0, 10),
    scoring_notes: [
      'Evidence quality is computed from local brain entities, relationships, field evidence, confidence, and redaction safety.',
      'Redacted sensitive references preserve trust without exposing raw filenames or paths.',
    ],
    evidence_records: params.buckets.evidence.length,
    referenced_evidence_ids: referencedEvidenceIds.length,
    missing_evidence_references: missingEvidenceReferences,
    entities_with_evidence: entitiesWithEvidence.length,
    entities_without_evidence: entitiesWithoutEvidence.length,
    entity_evidence_coverage_ratio: ratio(entitiesWithEvidence.length, entities.length),
    entities_without_evidence_by_type: countByValue(
      entitiesWithoutEvidence.map((entity) => entity.type),
    ),
    relationships_with_evidence: relationshipsWithEvidence.length,
    relationships_without_evidence: relationshipsWithoutEvidence.length,
    relationship_evidence_coverage_ratio: ratio(
      relationshipsWithEvidence.length,
      params.relationships.length,
    ),
    component_field_evidence: params.buckets.components.map((component) => ({
      id: component.id,
      confidence: component.confidence,
      fields: Object.fromEntries(
        Object.entries(recordStringArrayData(component, 'field_evidence')).map(([field, ids]) => [
          field,
          ids.length,
        ]),
      ),
    })),
    flow_field_evidence: params.buckets.flows.map((flow) => ({
      id: flow.id,
      confidence: flow.confidence,
      fields: Object.fromEntries(
        Object.entries(recordStringArrayData(flow, 'field_evidence')).map(([field, ids]) => [
          field,
          ids.length,
        ]),
      ),
    })),
  };
}

function redactedReferenceCountForBrain(params: {
  readonly entities: readonly BrainEntity[];
  readonly relationships: readonly BrainRelationship[];
}): number {
  return redactedReferenceCount({
    entities: params.entities,
    relationships: params.relationships,
  });
}

const COMPONENT_UNDERSTANDING_FIELDS = [
  'purpose',
  'boundary_type',
  'responsibilities',
  'interfaces',
  'entry_points',
  'consumers',
  'dependencies',
  'dependency_roles',
  'coupling',
  'criticality',
  'blast_radius',
  'ownership_confidence',
  'tradeoffs',
  'failure_modes',
  'what_breaks_if_removed',
  'risky_seams',
  'important_files',
  'read_first',
  'known_risks',
] as const;

function componentFieldHasValue(component: BrainEntity, field: string): boolean {
  if (field === 'ownership_confidence') return isRecord(component.data?.ownership_confidence);
  if (field === 'coupling') return isRecord(component.data?.coupling);
  if (field === 'purpose' || field === 'boundary_type' || field === 'criticality') {
    return stringData(component, field) !== undefined;
  }
  if (field === 'blast_radius') return stringData(component, field) !== undefined;
  return stringArrayData(component, field).length > 0;
}

function buildComponentIntelligenceArtifact(params: {
  readonly now: string;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
}): Record<string, unknown> {
  const components = params.buckets.components.filter(
    (component) => component.latest_status !== 'stale',
  );
  const flows = params.buckets.flows.filter((flow) => flow.latest_status !== 'stale');
  const fieldSlots = components.length * COMPONENT_UNDERSTANDING_FIELDS.length;
  const coveredFieldSlots = components.reduce(
    (count, component) =>
      count +
      COMPONENT_UNDERSTANDING_FIELDS.filter((field) => componentFieldHasValue(component, field))
        .length,
    0,
  );
  const evidenceBackedFieldSlots = components.reduce((count, component) => {
    const fieldEvidence = recordStringArrayData(component, 'field_evidence');
    return (
      count +
      COMPONENT_UNDERSTANDING_FIELDS.filter(
        (field) =>
          componentFieldHasValue(component, field) && (fieldEvidence[field] ?? []).length > 0,
      ).length
    );
  }, 0);
  const flowsByComponent = new Map<string, BrainEntity[]>();
  for (const flow of flows) {
    for (const componentId of flowStringArray(flow, 'components')) {
      const existing = flowsByComponent.get(componentId) ?? [];
      flowsByComponent.set(componentId, [...existing, flow]);
    }
  }
  const componentsWithFlows = components.filter(
    (component) => (flowsByComponent.get(component.id) ?? []).length > 0,
  );
  const highCriticality = components.filter(
    (component) => stringData(component, 'criticality') === 'high',
  );
  const highCriticalityWithoutTests = highCriticality.filter(
    (component) => stringArrayData(component, 'tests').length === 0,
  );
  const fieldCoverageScore = scorePercent(coveredFieldSlots, fieldSlots);
  const evidenceBackedFieldScore = scorePercent(evidenceBackedFieldSlots, fieldSlots);
  const flowCoverageScore = scorePercent(componentsWithFlows.length, components.length);
  const confidenceDistribution = countByConfidence(
    components.map((component) => component.confidence),
  );
  const unknownComponentCount = components.filter(
    (component) =>
      component.confidence === 'uncertain' || stringArrayData(component, 'unknowns').length > 0,
  ).length;
  const componentUnderstandingScore = Math.round(
    fieldCoverageScore * 0.45 + evidenceBackedFieldScore * 0.35 + flowCoverageScore * 0.2,
  );
  const couplingByComponent = components.map((component) => {
    const inbound = params.relationships.filter(
      (relationship) =>
        relationship.to === component.id &&
        relationship.from !== component.id &&
        relationship.relation !== 'owns',
    );
    const outbound = params.relationships.filter(
      (relationship) =>
        relationship.from === component.id &&
        relationship.to !== component.id &&
        relationship.relation !== 'owns',
    );
    const relatedFlows = flowsByComponent.get(component.id) ?? [];
    return {
      id: component.id,
      boundary_type: stringData(component, 'boundary_type') ?? 'unknown',
      criticality: stringData(component, 'criticality') ?? 'unknown',
      blast_radius: stringData(component, 'blast_radius') ?? 'unknown',
      coupling: isRecord(component.data?.coupling) ? component.data.coupling : undefined,
      confidence: component.confidence,
      ownership_confidence: isRecord(component.data?.ownership_confidence)
        ? component.data.ownership_confidence
        : undefined,
      flow_count: relatedFlows.length,
      flow_ids: relatedFlows.map((flow) => flow.id),
      inbound_relationships: inbound.length,
      outbound_relationships: outbound.length,
      risky_seams: stringArrayData(component, 'risky_seams'),
      unknowns: stringArrayData(component, 'unknowns'),
      read_first: stringArrayData(component, 'read_first'),
      evidence_ids: component.evidence_ids,
      field_coverage: Object.fromEntries(
        COMPONENT_UNDERSTANDING_FIELDS.map((field) => [
          field,
          componentFieldHasValue(component, field),
        ]),
      ),
      field_evidence: Object.fromEntries(
        COMPONENT_UNDERSTANDING_FIELDS.map((field) => [
          field,
          componentFieldHasValue(component, field)
            ? (recordStringArrayData(component, 'field_evidence')[field] ?? []).length
            : 0,
        ]),
      ),
    };
  });

  return {
    generated_at: params.now,
    total_components: components.length,
    component_understanding_score: componentUnderstandingScore,
    field_coverage_score: fieldCoverageScore,
    evidence_backed_field_score: evidenceBackedFieldScore,
    flow_coverage_score: flowCoverageScore,
    confidence_distribution: confidenceDistribution,
    high_criticality_components: highCriticality.length,
    high_criticality_without_tests: highCriticalityWithoutTests.map((component) => component.id),
    unknown_component_count: unknownComponentCount,
    top_uncertain_components: components
      .filter((component) => component.confidence === 'uncertain')
      .slice(0, 10)
      .map((component) => ({
        id: component.id,
        unknowns: stringArrayData(component, 'unknowns'),
        evidence_ids: component.evidence_ids,
      })),
    fields: COMPONENT_UNDERSTANDING_FIELDS,
    field_coverage: Object.fromEntries(
      COMPONENT_UNDERSTANDING_FIELDS.map((field) => [
        field,
        components.filter((component) => componentFieldHasValue(component, field)).length,
      ]),
    ),
    evidence_coverage: Object.fromEntries(
      COMPONENT_UNDERSTANDING_FIELDS.map((field) => [
        field,
        components.filter(
          (component) =>
            componentFieldHasValue(component, field) &&
            (recordStringArrayData(component, 'field_evidence')[field] ?? []).length > 0,
        ).length,
      ]),
    ),
    component_flow_coverage: couplingByComponent.map((component) => ({
      id: component.id,
      flow_count: component.flow_count,
      flow_ids: component.flow_ids,
      inbound_relationships: component.inbound_relationships,
      outbound_relationships: component.outbound_relationships,
    })),
    components: couplingByComponent,
    scoring_notes: [
      'Component Intelligence measures deterministic static understanding, not runtime behavior.',
      'Scores combine field coverage, evidence-backed fields, and reconstructed flow coverage.',
      'Unknowns are intentional prompts for what a human or future reasoning pass should inspect next.',
    ],
  };
}

function componentCouplingRecord(component: BrainEntity): ComponentIntelligence['coupling'] {
  const coupling = component.data?.coupling;
  if (!isRecord(coupling)) {
    return {
      level: 'low',
      score: 0,
      static_import_count: 0,
      internal_imports: [],
      external_imports: [],
      reasons: ['No coupling record is available.'],
    };
  }
  const level =
    coupling.level === 'high' || coupling.level === 'medium' || coupling.level === 'low'
      ? coupling.level
      : 'low';
  const score = typeof coupling.score === 'number' ? coupling.score : 0;
  const staticImportCount =
    typeof coupling.static_import_count === 'number' ? coupling.static_import_count : 0;
  return {
    level,
    score,
    static_import_count: staticImportCount,
    internal_imports: asStringArray(coupling.internal_imports),
    external_imports: asStringArray(coupling.external_imports),
    reasons: asStringArray(coupling.reasons),
  };
}

function architectureEvidenceIdsForComponent(params: {
  readonly component: BrainEntity;
  readonly componentFlows: readonly BrainEntity[];
  readonly relationships: readonly BrainRelationship[];
}): string[] {
  return unique([
    ...evidenceIdsForComponent(params.component),
    ...params.componentFlows.flatMap(evidenceIdsForFlow),
    ...params.relationships
      .filter(
        (relationship) =>
          relationship.from === params.component.id || relationship.to === params.component.id,
      )
      .flatMap((relationship) => relationship.evidence_ids),
  ]).slice(0, 12);
}

function architectureAssumptionConfidence(params: {
  readonly component: BrainEntity;
  readonly componentFlows: readonly BrainEntity[];
}): Confidence {
  return weakestConfidence([
    params.component.confidence,
    ...params.componentFlows.map((flow) => flow.confidence),
  ]);
}

function architectureAssumptionScore(params: {
  readonly component: BrainEntity;
  readonly componentFlows: readonly BrainEntity[];
}): number {
  return averageConfidenceScore([
    componentConfidenceScore(params.component),
    ...params.componentFlows.map(asFlowConfidenceScore),
  ]);
}

function architectureAssumptionGapIds(params: {
  readonly entityId: string;
  readonly evidenceIds: readonly string[];
  readonly componentFlows: readonly BrainEntity[];
}): string[] {
  return unique([
    ...(params.evidenceIds.length === 0 ? [`gap:${safeText(params.entityId)}:evidence`] : []),
    ...(params.componentFlows.length === 0 ? [`gap:${safeText(params.entityId)}:flow`] : []),
  ]);
}

function pressureStrengthFromCount(count: number): ArchitecturePressureStrength {
  if (count >= 3) return 'high';
  if (count >= 1) return 'medium';
  return 'low';
}

function pressureStrengthFromCoupling(
  coupling: ComponentIntelligence['coupling'],
): ArchitecturePressureStrength {
  if (coupling.level === 'high') return 'high';
  if (coupling.level === 'medium') return 'medium';
  return coupling.score > 0 ? 'medium' : 'low';
}

function architectureAssumptionRecords(params: {
  readonly components: readonly BrainEntity[];
  readonly flowsByComponent: ReadonlyMap<string, readonly BrainEntity[]>;
  readonly relationships: readonly BrainRelationship[];
}): ArchitectureAssumption[] {
  const assumptions: ArchitectureAssumption[] = [];
  for (const component of params.components) {
    const boundaryType = stringData(component, 'boundary_type') ?? 'unknown';
    const componentFlows = params.flowsByComponent.get(component.id) ?? [];
    const coupling = componentCouplingRecord(component);
    const configs = stringArrayData(component, 'configs');
    const dependencies = stringArrayData(component, 'dependencies');
    const evidenceIds = architectureEvidenceIdsForComponent({
      component,
      componentFlows,
      relationships: params.relationships,
    });
    const evidenceGapIds = architectureAssumptionGapIds({
      entityId: component.id,
      evidenceIds,
      componentFlows,
    });
    const confidence = architectureAssumptionConfidence({ component, componentFlows });
    const confidenceScore = architectureAssumptionScore({ component, componentFlows });
    const fieldEvidence = recordStringArrayData(component, 'field_evidence');
    assumptions.push({
      assumption_id: `assumption:${safeText(component.id)}:boundary`,
      entity_id: safeText(component.id),
      assumption: safeText(
        `${component.id} is treated as a ${boundaryType} boundary because local structure, interfaces, and flow links point at that role.`,
      ),
      inferred_from: unique([
        ...stringArrayData(component, 'signals'),
        ...(componentFlows.length > 0 ? [`${componentFlows.length} linked flow(s)`] : []),
        ...(configs.length > 0 ? [`${configs.length} config signal(s)`] : []),
        ...(dependencies.length > 0 ? [`${dependencies.length} dependency signal(s)`] : []),
      ]).map(safeText),
      evidence_ids: unique([
        ...evidenceIds,
        ...(fieldEvidence.boundary_type ?? []),
        ...(fieldEvidence.purpose ?? []),
      ]).slice(0, 12),
      evidence_gap_ids: evidenceGapIds,
      confidence,
      confidence_score: confidenceScore,
      rules: [
        `boundary_type:${boundaryType}`,
        `flow_links:${componentFlows.length}`,
        `configs:${configs.length}`,
        `dependencies:${dependencies.length}`,
      ],
      unknowns: unique([
        ...stringArrayData(component, 'unknowns'),
        ...(componentFlows.length === 0
          ? ['No reconstructed flow currently crosses or reaches this boundary.']
          : []),
      ]).map(safeText),
    });
    if (
      coupling.score > 0 ||
      coupling.internal_imports.length > 0 ||
      coupling.external_imports.length > 0
    ) {
      assumptions.push({
        assumption_id: `assumption:${safeText(component.id)}:coupling`,
        entity_id: safeText(component.id),
        assumption: safeText(
          `${component.id} has ${coupling.level} coupling because static imports and package signals connect it to other code.`,
        ),
        inferred_from: unique([
          ...coupling.reasons,
          ...(coupling.internal_imports.length > 0
            ? [`${coupling.internal_imports.length} internal import target(s)`]
            : []),
          ...(coupling.external_imports.length > 0
            ? [`${coupling.external_imports.length} external import root(s)`]
            : []),
        ]).map(safeText),
        evidence_ids: evidenceIds,
        evidence_gap_ids: evidenceGapIds,
        confidence,
        confidence_score: confidenceScore,
        rules: [
          `coupling:${coupling.level}`,
          `coupling_score:${coupling.score}`,
          `static_imports:${coupling.static_import_count}`,
          `internal_imports:${coupling.internal_imports.length}`,
        ],
        unknowns:
          coupling.internal_imports.length === 0
            ? ['No internal import target was found; external/runtime coupling may still exist.']
            : [],
      });
    }
  }
  return sorted(assumptions, (assumption) => assumption.assumption_id);
}

function architectureDesignPressures(params: {
  readonly components: readonly BrainEntity[];
  readonly flowsByComponent: ReadonlyMap<string, readonly BrainEntity[]>;
}): ArchitectureDesignPressure[] {
  const pressures: ArchitectureDesignPressure[] = [];
  for (const component of params.components) {
    const componentFlows = params.flowsByComponent.get(component.id) ?? [];
    const coupling = componentCouplingRecord(component);
    const configs = stringArrayData(component, 'configs');
    const dependencies = stringArrayData(component, 'dependencies');
    const tests = stringArrayData(component, 'tests');
    const evidenceIds = evidenceIdsForComponent(component).slice(0, 12);
    if (componentFlows.length > 0) {
      pressures.push({
        pressure_id: `pressure:${safeText(component.id)}:flow`,
        entity_id: safeText(component.id),
        pressure_type: 'flow',
        pressure: safeText(
          `${component.id} participates in ${componentFlows.length} reconstructed flow(s), so boundary changes can affect navigation through the system.`,
        ),
        strength: pressureStrengthFromCount(componentFlows.length),
        evidence_ids: unique([
          ...evidenceIds,
          ...componentFlows.flatMap((flow) => flow.evidence_ids),
        ]).slice(0, 12),
        rules: [`flow_links:${componentFlows.length}`],
      });
    }
    if (coupling.score > 0) {
      pressures.push({
        pressure_id: `pressure:${safeText(component.id)}:coupling`,
        entity_id: safeText(component.id),
        pressure_type: 'coupling',
        pressure: safeText(
          `${component.id} has ${coupling.level} static coupling, which widens review scope when imports or exports change.`,
        ),
        strength: pressureStrengthFromCoupling(coupling),
        evidence_ids: evidenceIds,
        rules: [
          `coupling:${coupling.level}`,
          `coupling_score:${coupling.score}`,
          `static_imports:${coupling.static_import_count}`,
        ],
      });
    }
    if (configs.length > 0) {
      pressures.push({
        pressure_id: `pressure:${safeText(component.id)}:config`,
        entity_id: safeText(component.id),
        pressure_type: 'config',
        pressure: safeText(
          `${component.id} behavior is influenced by ${configs.length} config/manifest file(s).`,
        ),
        strength: pressureStrengthFromCount(configs.length),
        evidence_ids: unique([
          ...evidenceIds,
          ...(recordStringArrayData(component, 'field_evidence').configs ?? []),
        ]).slice(0, 12),
        rules: [`configs:${configs.length}`],
      });
    }
    if (dependencies.length > 0) {
      pressures.push({
        pressure_id: `pressure:${safeText(component.id)}:dependency`,
        entity_id: safeText(component.id),
        pressure_type: 'dependency',
        pressure: safeText(
          `${component.id} relies on ${dependencies.length} package dependency signal(s).`,
        ),
        strength: pressureStrengthFromCount(dependencies.length),
        evidence_ids: unique([
          ...evidenceIds,
          ...(recordStringArrayData(component, 'field_evidence').dependencies ?? []),
        ]).slice(0, 12),
        rules: [`dependencies:${dependencies.length}`],
      });
    }
    if (tests.length === 0 && stringData(component, 'criticality') !== 'low') {
      pressures.push({
        pressure_id: `pressure:${safeText(component.id)}:boundary`,
        entity_id: safeText(component.id),
        pressure_type: 'boundary',
        pressure: safeText(
          `${component.id} is medium/high criticality without component-local test evidence.`,
        ),
        strength: 'high',
        evidence_ids: evidenceIds,
        rules: [`criticality:${stringData(component, 'criticality') ?? 'unknown'}`, 'tests:0'],
      });
    }
  }
  return sorted(pressures, (pressure) => pressure.pressure_id);
}

function architectureBoundaryRationale(params: {
  readonly components: readonly BrainEntity[];
  readonly flowsByComponent: ReadonlyMap<string, readonly BrainEntity[]>;
  readonly relationships: readonly BrainRelationship[];
}): ArchitectureBoundaryRationale[] {
  return sorted(
    params.components.map((component) => {
      const boundaryType = stringData(component, 'boundary_type') ?? 'unknown';
      const componentFlows = params.flowsByComponent.get(component.id) ?? [];
      const signals = stringArrayData(component, 'signals');
      const configs = stringArrayData(component, 'configs');
      const dependencies = stringArrayData(component, 'dependencies');
      return {
        component_id: safeText(component.id),
        boundary_type: boundaryType,
        rationale: safeText(
          `${component.id} is a ${boundaryType} boundary from ${signals.length} structural signal(s), ${componentFlows.length} linked flow(s), ${configs.length} config signal(s), and ${dependencies.length} dependency signal(s).`,
        ),
        evidence_ids: architectureEvidenceIdsForComponent({
          component,
          componentFlows,
          relationships: params.relationships,
        }),
        confidence: architectureAssumptionConfidence({ component, componentFlows }),
        rules: [
          `boundary_type:${boundaryType}`,
          `signals:${signals.length}`,
          `flow_links:${componentFlows.length}`,
          `configs:${configs.length}`,
          `dependencies:${dependencies.length}`,
        ],
        unknowns: stringArrayData(component, 'unknowns').map(safeText),
      };
    }),
    (rationale) => rationale.component_id,
  );
}

function architectureCouplingRationale(params: {
  readonly components: readonly BrainEntity[];
  readonly flowsByComponent: ReadonlyMap<string, readonly BrainEntity[]>;
  readonly relationships: readonly BrainRelationship[];
}): ArchitectureCouplingRationale[] {
  return sorted(
    params.components
      .map((component) => {
        const componentFlows = params.flowsByComponent.get(component.id) ?? [];
        const coupling = componentCouplingRecord(component);
        const tests = stringArrayData(component, 'tests');
        const intentionalCoupling =
          coupling.internal_imports.length > 0 &&
          componentFlows.some((flow) => flowStringArray(flow, 'components').length > 1);
        const riskyCoupling =
          coupling.level !== 'low' ||
          (coupling.internal_imports.length > 0 && tests.length === 0) ||
          stringData(component, 'blast_radius') === 'broad';
        return {
          component_id: safeText(component.id),
          coupling_level: coupling.level,
          coupling_score: coupling.score,
          rationale: safeText(
            `${component.id} coupling is ${coupling.level} from ${coupling.static_import_count} static import(s), ${coupling.internal_imports.length} internal target(s), and ${coupling.external_imports.length} external root(s).`,
          ),
          intentional_coupling: intentionalCoupling,
          risky_coupling: riskyCoupling,
          evidence_ids: architectureEvidenceIdsForComponent({
            component,
            componentFlows,
            relationships: params.relationships,
          }),
          rules: [
            `coupling:${coupling.level}`,
            `coupling_score:${coupling.score}`,
            `static_imports:${coupling.static_import_count}`,
            `internal_imports:${coupling.internal_imports.length}`,
            `tests:${tests.length}`,
          ],
          unknowns:
            coupling.score === 0
              ? ['No static coupling found; runtime coupling is outside this local scan.']
              : [],
        };
      })
      .filter(
        (rationale) =>
          rationale.coupling_score > 0 ||
          rationale.intentional_coupling ||
          rationale.risky_coupling,
      ),
    (rationale) => rationale.component_id,
  );
}

function architectureEvidenceGaps(params: {
  readonly components: readonly BrainEntity[];
  readonly flows: readonly BrainEntity[];
  readonly flowsByComponent: ReadonlyMap<string, readonly BrainEntity[]>;
  readonly relationships: readonly BrainRelationship[];
}): ArchitectureEvidenceGap[] {
  const gaps: ArchitectureEvidenceGap[] = [];
  for (const component of params.components) {
    const componentFlows = params.flowsByComponent.get(component.id) ?? [];
    const tests = stringArrayData(component, 'tests');
    const componentEvidenceIds = evidenceIdsForComponent(component).slice(0, 12);
    if (componentEvidenceIds.length === 0) {
      gaps.push({
        gap_id: `gap:${safeText(component.id)}:evidence`,
        entity_id: safeText(component.id),
        gap: safeText(`${component.id} has no direct architecture evidence IDs.`),
        severity: 'high',
        evidence_ids: [],
        rules: ['evidence_ids:0'],
      });
    }
    if (componentFlows.length === 0) {
      gaps.push({
        gap_id: `gap:${safeText(component.id)}:flow`,
        entity_id: safeText(component.id),
        gap: safeText(`${component.id} has no reconstructed flow coverage.`),
        severity: 'medium',
        evidence_ids: componentEvidenceIds,
        rules: ['flow_links:0'],
      });
    }
    if (tests.length === 0 && stringData(component, 'criticality') !== 'low') {
      gaps.push({
        gap_id: `gap:${safeText(component.id)}:tests`,
        entity_id: safeText(component.id),
        gap: safeText(`${component.id} is medium/high criticality without local test evidence.`),
        severity: 'high',
        evidence_ids: componentEvidenceIds,
        rules: [`criticality:${stringData(component, 'criticality') ?? 'unknown'}`, 'tests:0'],
      });
    }
  }
  for (const flow of params.flows.filter((item) => item.confidence !== 'verified')) {
    gaps.push({
      gap_id: `gap:${safeText(flow.id)}:runtime-verification`,
      entity_id: safeText(flow.id),
      gap: safeText(`${flow.id} is reconstructed from static evidence but not runtime verified.`),
      severity: flowStringArray(flow, 'components').length > 1 ? 'high' : 'medium',
      evidence_ids: evidenceIdsForFlow(flow).slice(0, 12),
      rules: [
        `confidence:${flow.confidence}`,
        `components:${flowStringArray(flow, 'components').length}`,
      ],
    });
  }
  const relationshipsWithoutEvidence = params.relationships.filter(
    (relationship) => relationship.evidence_ids.length === 0,
  );
  for (const relationship of relationshipsWithoutEvidence.slice(0, 20)) {
    gaps.push({
      gap_id: `gap:${stableSlug(`${relationship.from}-${relationship.relation}-${relationship.to}`)}:relationship-evidence`,
      entity_id: safeText(relationship.from),
      gap: safeText(
        `${relationship.from} ${relationship.relation} ${relationship.to} has no direct evidence ID.`,
      ),
      severity: 'medium',
      evidence_ids: [],
      rules: ['relationship_evidence:0'],
    });
  }
  return sorted(gaps, (gap) => gap.gap_id);
}

function architectureAssumptionConfidenceSummary(
  assumptions: readonly ArchitectureAssumption[],
): Record<string, unknown> {
  const counts = countByConfidence(assumptions.map((assumption) => assumption.confidence));
  const averageScore = averageConfidenceScore(
    assumptions.map((assumption) => assumption.confidence_score),
  );
  return {
    assumption_count: assumptions.length,
    average_score: averageScore,
    confidence_counts: counts,
    low_confidence_assumptions: assumptions
      .filter(
        (assumption) => assumption.confidence !== 'verified' || assumption.unknowns.length > 0,
      )
      .map((assumption) => assumption.assumption_id)
      .slice(0, 20),
    calibration_rule:
      'Assumption confidence combines component confidence, linked flow confidence, direct evidence IDs, and explicit unknowns.',
  };
}

function buildArchitectureReasoningArtifact(params: {
  readonly projectName: string;
  readonly now: string;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
  readonly changedFiles: readonly string[];
}): Record<string, unknown> {
  const projectId = entityId('project', params.projectName);
  const flows = params.buckets.flows.filter((flow) => flow.latest_status !== 'stale');
  const components = params.buckets.components.filter(
    (component) => component.latest_status !== 'stale',
  );
  const changedFileSet = new Set(params.changedFiles);
  const flowsByComponent = new Map<string, BrainEntity[]>();
  for (const flow of flows) {
    for (const componentId of flowStringArray(flow, 'components')) {
      const existing = flowsByComponent.get(componentId) ?? [];
      flowsByComponent.set(componentId, [...existing, flow]);
    }
  }
  const boundaryCandidates = components
    .map((component) => {
      const componentFlows = flowsByComponent.get(component.id) ?? [];
      const inboundCount = params.relationships.filter(
        (relationship) => relationship.to === component.id && relationship.relation !== 'owns',
      ).length;
      const outboundCount = params.relationships.filter(
        (relationship) => relationship.from === component.id && relationship.relation !== 'owns',
      ).length;
      const coupling = componentCouplingRecord(component);
      return {
        component_id: safeText(component.id),
        name: safeText(component.name),
        boundary_type: stringData(component, 'boundary_type') ?? 'unknown',
        criticality: stringData(component, 'criticality') ?? 'unknown',
        blast_radius: stringData(component, 'blast_radius') ?? 'unknown',
        flow_count: componentFlows.length,
        inbound_count: inboundCount,
        outbound_count: outboundCount,
        coupling_level: coupling.level,
        coupling_score: coupling.score,
        confidence: weakestConfidence([
          component.confidence,
          ...componentFlows.map((flow) => flow.confidence),
        ]),
        evidence_ids: unique([
          ...component.evidence_ids,
          ...componentFlows.flatMap((flow) => flow.evidence_ids),
        ]).slice(0, 12),
      };
    })
    .sort(
      (a, b) =>
        b.flow_count - a.flow_count ||
        b.coupling_score - a.coupling_score ||
        b.inbound_count + b.outbound_count - (a.inbound_count + a.outbound_count) ||
        a.component_id.localeCompare(b.component_id),
    );
  const couplingHotspots = components
    .map((component) => {
      const coupling = componentCouplingRecord(component);
      const importRelationships = params.relationships.filter(
        (relationship) => relationship.from === component.id && relationship.relation === 'imports',
      );
      return {
        component_id: safeText(component.id),
        coupling_level: coupling.level,
        coupling_score: coupling.score,
        static_import_count: coupling.static_import_count,
        internal_imports: unique([
          ...coupling.internal_imports,
          ...importRelationships.map((relationship) => relationship.to),
        ]).map(safeText),
        external_imports: coupling.external_imports.map(safeText),
        reasons: coupling.reasons.map(safeText),
        evidence_ids: unique([
          ...component.evidence_ids,
          ...importRelationships.flatMap((relationship) => relationship.evidence_ids),
        ]).slice(0, 12),
      };
    })
    .filter((item) => item.coupling_score > 0 || item.internal_imports.length > 0)
    .sort(
      (a, b) => b.coupling_score - a.coupling_score || a.component_id.localeCompare(b.component_id),
    )
    .slice(0, 20);
  const criticalPaths = components
    .filter(
      (component) =>
        stringData(component, 'criticality') === 'high' ||
        stringData(component, 'blast_radius') === 'broad',
    )
    .map((component) => ({
      component_id: safeText(component.id),
      criticality: stringData(component, 'criticality') ?? 'unknown',
      criticality_score: numberData(component, 'criticality_score') ?? 0,
      blast_radius: stringData(component, 'blast_radius') ?? 'unknown',
      flow_ids: (flowsByComponent.get(component.id) ?? []).map((flow) => safeText(flow.id)),
      tests: stringArrayData(component, 'tests').map(safeText),
      read_first: stringArrayData(component, 'read_first').map(safeText),
      evidence_ids: component.evidence_ids.map(safeText),
    }))
    .sort(
      (a, b) =>
        b.criticality_score - a.criticality_score || a.component_id.localeCompare(b.component_id),
    )
    .slice(0, 20);
  const riskySeams = components
    .flatMap((component) =>
      stringArrayData(component, 'risky_seams').map((seam) => ({
        component_id: safeText(component.id),
        seam: safeText(seam),
        coupling_level: componentCouplingRecord(component).level,
        blast_radius: stringData(component, 'blast_radius') ?? 'unknown',
        evidence_ids: component.evidence_ids.map(safeText),
      })),
    )
    .slice(0, 30);
  const tradeoffMatrix = components
    .map((component) => ({
      component_id: safeText(component.id),
      boundary_type: stringData(component, 'boundary_type') ?? 'unknown',
      criticality: stringData(component, 'criticality') ?? 'unknown',
      coupling_level: componentCouplingRecord(component).level,
      blast_radius: stringData(component, 'blast_radius') ?? 'unknown',
      tradeoffs: stringArrayData(component, 'tradeoffs').map(safeText),
      failure_modes: stringArrayData(component, 'failure_modes').map(safeText),
    }))
    .filter((item) => item.tradeoffs.length > 0 || item.failure_modes.length > 0)
    .slice(0, 30);
  const whatBreaks = components
    .map((component) => ({
      component_id: safeText(component.id),
      blast_radius: stringData(component, 'blast_radius') ?? 'unknown',
      impacts: stringArrayData(component, 'what_breaks_if_removed').map(safeText),
      tests: stringArrayData(component, 'tests').map(safeText),
      evidence_ids: component.evidence_ids.map(safeText),
    }))
    .filter((item) => item.impacts.length > 0)
    .slice(0, 30);
  const crossComponentFlows = flows
    .filter((flow) => flowStringArray(flow, 'components').length > 1)
    .map((flow) => ({
      flow_id: safeText(flow.id),
      name: safeText(flow.name),
      kind: flowKind(flow),
      components: flowStringArray(flow, 'components').map(safeText),
      files: flowStringArray(flow, 'files').map(safeText),
      risks: flowRisks(flow).length,
      confidence: flow.confidence,
      evidence_ids: flow.evidence_ids.map(safeText),
    }));
  const riskConcentrations = [
    ...components.map((component) => ({
      entity_id: safeText(component.id),
      kind: 'component',
      risk_count: stringArrayData(component, 'known_risks').length,
      changed_recently: component.source_files.some((file) => changedFileSet.has(file)),
      evidence_ids: component.evidence_ids.map(safeText),
    })),
    ...flows.map((flow) => ({
      entity_id: safeText(flow.id),
      kind: 'flow',
      risk_count: flowRisks(flow).length,
      changed_recently: flowStringArray(flow, 'files').some((file) => changedFileSet.has(file)),
      evidence_ids: flow.evidence_ids.map(safeText),
    })),
  ]
    .filter((item) => item.risk_count > 0 || item.changed_recently)
    .sort(
      (a, b) =>
        Number(b.changed_recently) - Number(a.changed_recently) ||
        b.risk_count - a.risk_count ||
        a.entity_id.localeCompare(b.entity_id),
    )
    .slice(0, 20);
  const changedFlows = flows.filter((flow) =>
    flowStringArray(flow, 'files').some((file) => changedFileSet.has(file)),
  );
  const lowConfidenceFlows = flows.filter((flow) => flow.confidence !== 'verified');
  const reviewHints: Array<Record<string, unknown>> = [];
  if (changedFlows.length > 0) {
    reviewHints.push({
      reason: 'Changed files overlap reconstructed flows.',
      affected_flows: changedFlows.map((flow) => safeText(flow.id)),
      suggested_tests: unique(changedFlows.flatMap((flow) => flowStringArray(flow, 'tests'))).map(
        safeText,
      ),
      confidence: 'inferred',
    });
  }
  if (crossComponentFlows.length > 0) {
    reviewHints.push({
      reason: 'Some reconstructed flows cross component boundaries.',
      affected_flows: crossComponentFlows.map((flow) => flow.flow_id),
      suggested_tests: unique(
        flows
          .filter((flow) => flowStringArray(flow, 'components').length > 1)
          .flatMap((flow) => flowStringArray(flow, 'tests')),
      ).map(safeText),
      confidence: 'inferred',
    });
  }
  if (couplingHotspots.length > 0) {
    reviewHints.push({
      reason: 'Coupling hotspots need import/export review before interface changes.',
      affected_components: couplingHotspots.map((hotspot) => hotspot.component_id),
      suggested_tests: unique(
        couplingHotspots.flatMap((hotspot) => {
          const component = components.find((item) => item.id === hotspot.component_id);
          return component === undefined ? [] : stringArrayData(component, 'tests');
        }),
      ).map(safeText),
      confidence: 'inferred',
    });
  }
  if (riskySeams.length > 0) {
    reviewHints.push({
      reason: 'Risky architecture seams were detected from local static evidence.',
      affected_components: unique(riskySeams.map((seam) => seam.component_id)),
      suggested_tests: unique(
        riskySeams.flatMap((seam) => {
          const component = components.find((item) => item.id === seam.component_id);
          return component === undefined ? [] : stringArrayData(component, 'tests');
        }),
      ).map(safeText),
      confidence: 'inferred',
    });
  }
  if (lowConfidenceFlows.length > 0) {
    reviewHints.push({
      reason:
        'Low-confidence flows need evidence review before architectural decisions rely on them.',
      affected_flows: lowConfidenceFlows.map((flow) => safeText(flow.id)),
      suggested_tests: unique(
        lowConfidenceFlows.flatMap((flow) => flowStringArray(flow, 'tests')),
      ).map(safeText),
      confidence: 'inferred',
    });
  }
  const componentsWithoutFlows = components.filter(
    (component) => (flowsByComponent.get(component.id) ?? []).length === 0,
  );
  const relationshipsWithoutEvidence = params.relationships.filter(
    (relationship) => relationship.evidence_ids.length === 0,
  );
  const architectureAssumptions = architectureAssumptionRecords({
    components,
    flowsByComponent,
    relationships: params.relationships,
  });
  const designPressures = architectureDesignPressures({ components, flowsByComponent });
  const boundaryRationale = architectureBoundaryRationale({
    components,
    flowsByComponent,
    relationships: params.relationships,
  });
  const couplingRationale = architectureCouplingRationale({
    components,
    flowsByComponent,
    relationships: params.relationships,
  });
  const evidenceGaps = architectureEvidenceGaps({
    components,
    flows,
    flowsByComponent,
    relationships: params.relationships,
  });
  const highPressures = designPressures.filter((pressure) => pressure.strength === 'high');
  const riskyCouplings = couplingRationale.filter((rationale) => rationale.risky_coupling);
  const intentionalCouplings = couplingRationale.filter(
    (rationale) => rationale.intentional_coupling,
  );
  return {
    generated_at: params.now,
    project_id: projectId,
    boundary_candidates: boundaryCandidates,
    coupling_hotspots: couplingHotspots,
    critical_paths: criticalPaths,
    risky_seams: riskySeams,
    tradeoff_matrix: tradeoffMatrix,
    what_breaks: whatBreaks,
    cross_component_flows: crossComponentFlows,
    risk_concentrations: riskConcentrations,
    review_hints: reviewHints,
    architecture_assumptions: architectureAssumptions,
    design_pressures: designPressures,
    boundary_rationale: boundaryRationale,
    coupling_rationale: couplingRationale,
    risk_tradeoff_summary: {
      assumption_count: architectureAssumptions.length,
      high_pressure_count: highPressures.length,
      intentional_coupling_count: intentionalCouplings.length,
      risky_coupling_count: riskyCouplings.length,
      evidence_gap_count: evidenceGaps.length,
      top_design_pressures: highPressures.slice(0, 10).map((pressure) => pressure.pressure_id),
      top_risky_couplings: riskyCouplings.slice(0, 10).map((rationale) => rationale.component_id),
      summary:
        'Architecture reasoning is deterministic static inference; risky/intentional coupling reflects import, flow, config, dependency, and test evidence.',
    },
    assumption_confidence: architectureAssumptionConfidenceSummary(architectureAssumptions),
    evidence_gaps: evidenceGaps,
    unknowns: unique([
      ...(flows.length === 0 ? ['No reconstructed flows are available yet.'] : []),
      ...(componentsWithoutFlows.length > 0
        ? [
            `${componentsWithoutFlows.length} component(s) are not covered by reconstructed flows yet.`,
          ]
        : []),
      ...(relationshipsWithoutEvidence.length > 0
        ? [
            `${relationshipsWithoutEvidence.length} relationship(s) do not have direct evidence IDs yet.`,
          ]
        : []),
      ...(lowConfidenceFlows.length > 0
        ? [`${lowConfidenceFlows.length} reconstructed flow(s) are not verified yet.`]
        : []),
      ...(crossComponentFlows.length === 0 && flows.length > 0
        ? ['No cross-component flows were reconstructed from static evidence yet.']
        : []),
    ]),
  };
}

function confidenceScoreForValue(confidence: Confidence): number {
  if (confidence === 'verified') return 1;
  if (confidence === 'inferred') return 0.65;
  return 0.35;
}

function averageConfidenceScore(scores: readonly number[]): number {
  if (scores.length === 0) return 0;
  return Number((scores.reduce((total, score) => total + score, 0) / scores.length).toFixed(4));
}

function componentConfidenceScore(component: BrainEntity): number {
  const ownership = component.data?.ownership_confidence;
  const ownershipScore =
    isRecord(ownership) && typeof ownership.score === 'number' ? ownership.score : undefined;
  if (ownershipScore === undefined) return confidenceScoreForValue(component.confidence);
  return Number(
    (
      (confidenceScoreForValue(component.confidence) + Math.max(0, Math.min(1, ownershipScore))) /
      2
    ).toFixed(4),
  );
}

function fieldEvidenceIds(entity: BrainEntity): string[] {
  return unique(Object.values(recordStringArrayData(entity, 'field_evidence')).flat());
}

function traceRedactedEvidenceCount(params: {
  readonly claim: string;
  readonly evidenceIds: readonly string[];
  readonly rules: readonly string[];
  readonly unknowns: readonly string[];
}): number {
  return redactedReferenceCount(
    safeResearchValue({
      claim: params.claim,
      evidence_ids: params.evidenceIds,
      rules: params.rules,
      unknowns: params.unknowns,
    }),
  );
}

function reasoningTrace(params: {
  readonly entityId: string;
  readonly reasoningType: ReasoningType;
  readonly suffix?: string;
  readonly claim: string;
  readonly evidenceIds: readonly string[];
  readonly confidence: Confidence;
  readonly confidenceScore: number;
  readonly rules: readonly string[];
  readonly unknowns: readonly string[];
}): ReasoningTrace {
  const safeEntityId = safeText(params.entityId);
  const safeClaim = safeText(params.claim);
  const evidenceIds = unique(params.evidenceIds.map(safeText)).slice(0, 12);
  const rules = unique(params.rules.map(safeText)).slice(0, 8);
  const unknowns = unique(params.unknowns.map(safeText)).slice(0, 8);
  const suffix = params.suffix === undefined ? '' : `:${stableSlug(safeText(params.suffix))}`;
  return {
    trace_id: `trace:${params.reasoningType}:${stableSlug(safeEntityId)}${suffix}`,
    entity_id: safeEntityId,
    reasoning_type: params.reasoningType,
    claim: safeClaim,
    evidence_ids: evidenceIds,
    confidence: params.confidence,
    confidence_score: Number(params.confidenceScore.toFixed(4)),
    rules,
    unknowns,
    redacted_evidence_count: traceRedactedEvidenceCount({
      claim: safeClaim,
      evidenceIds,
      rules,
      unknowns,
    }),
  };
}

function evidenceIdsForComponent(component: BrainEntity): string[] {
  return unique([...component.evidence_ids, ...fieldEvidenceIds(component)]);
}

function evidenceIdsForFlow(flow: BrainEntity): string[] {
  return unique([
    ...flow.evidence_ids,
    ...fieldEvidenceIds(flow),
    ...flowEntrypoints(flow).flatMap((entrypoint) => entrypoint.evidence),
    ...flowSteps(flow).flatMap((step) => step.evidence),
    ...flowRisks(flow).flatMap((risk) => risk.evidence),
  ]);
}

function buildReasoningTracesArtifact(params: {
  readonly projectName: string;
  readonly now: string;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
  readonly changedFiles: readonly string[];
}): {
  readonly generated_at: string;
  readonly deterministic: boolean;
  readonly provider_calls_required: boolean;
  readonly trace_count: number;
  readonly trace_counts_by_type: Record<string, number>;
  readonly traces: readonly ReasoningTrace[];
} {
  const projectId = entityId('project', params.projectName);
  const changedFileSet = new Set(params.changedFiles);
  const components = params.buckets.components.filter(
    (component) => component.latest_status !== 'stale',
  );
  const flows = params.buckets.flows.filter((flow) => flow.latest_status !== 'stale');
  const flowsByComponent = new Map<string, BrainEntity[]>();
  for (const flow of flows) {
    for (const componentId of flowStringArray(flow, 'components')) {
      const existing = flowsByComponent.get(componentId) ?? [];
      flowsByComponent.set(componentId, [...existing, flow]);
    }
  }

  const componentTraces = components.map((component) => {
    const boundaryType = stringData(component, 'boundary_type') ?? 'unknown';
    const componentFlows = flowsByComponent.get(component.id) ?? [];
    const tests = stringArrayData(component, 'tests');
    const evidenceIds = evidenceIdsForComponent(component);
    return reasoningTrace({
      entityId: component.id,
      reasoningType: 'component',
      claim: `Component ${component.id} is classified as ${boundaryType} from local structure, declared interfaces, evidence-backed fields, and flow links.`,
      evidenceIds,
      confidence: component.confidence,
      confidenceScore: componentConfidenceScore(component),
      rules: [
        `boundary_type:${boundaryType}`,
        `field_evidence:${fieldEvidenceIds(component).length}`,
        `flow_links:${componentFlows.length}`,
        `test_links:${tests.length}`,
      ],
      unknowns: [
        ...stringArrayData(component, 'unknowns'),
        ...(evidenceIds.length === 0 ? ['No direct component evidence IDs were found.'] : []),
        ...(componentFlows.length === 0
          ? ['No reconstructed flow currently reaches this component.']
          : []),
      ],
    });
  });

  const flowTraces = flows.map((flow) => {
    const kind = flowKind(flow);
    const steps = flowSteps(flow);
    const tests = flowStringArray(flow, 'tests');
    const evidenceIds = evidenceIdsForFlow(flow);
    return reasoningTrace({
      entityId: flow.id,
      reasoningType: 'flow',
      claim: `Flow ${flow.id} is reconstructed as ${kind} from entrypoint, step, component, test, and config evidence.`,
      evidenceIds,
      confidence: flow.confidence,
      confidenceScore: asFlowConfidenceScore(flow),
      rules: [
        `kind:${kind}`,
        `entrypoints:${flowEntrypoints(flow).length}`,
        `steps:${steps.length}`,
        `components:${flowStringArray(flow, 'components').length}`,
        `test_links:${tests.length}`,
      ],
      unknowns: [
        ...stringArrayData(flow, 'unknowns'),
        ...(flow.confidence === 'verified' ? [] : [flowConfidenceReason(flow)]),
        ...(evidenceIds.length === 0 ? ['No direct flow evidence IDs were found.'] : []),
      ],
    });
  });

  const architectureTraces = components
    .filter((component) => {
      const coupling = componentCouplingRecord(component);
      return (
        (flowsByComponent.get(component.id) ?? []).length > 0 ||
        coupling.score > 0 ||
        stringData(component, 'blast_radius') === 'broad' ||
        stringData(component, 'criticality') === 'high'
      );
    })
    .map((component) => {
      const componentFlows = flowsByComponent.get(component.id) ?? [];
      const coupling = componentCouplingRecord(component);
      const architectureConfidence = weakestConfidence([
        component.confidence,
        ...componentFlows.map((flow) => flow.confidence),
      ]);
      const evidenceIds = unique([
        ...evidenceIdsForComponent(component),
        ...componentFlows.flatMap(evidenceIdsForFlow),
        ...params.relationships
          .filter(
            (relationship) =>
              relationship.from === component.id || relationship.to === component.id,
          )
          .flatMap((relationship) => relationship.evidence_ids),
      ]);
      return reasoningTrace({
        entityId: component.id,
        reasoningType: 'architecture',
        suffix: 'component-boundary',
        claim: `Architecture reasoning for ${component.id} combines boundary type, coupling, blast radius, flow coverage, and relationship evidence.`,
        evidenceIds,
        confidence: architectureConfidence,
        confidenceScore: averageConfidenceScore([
          componentConfidenceScore(component),
          ...componentFlows.map(asFlowConfidenceScore),
        ]),
        rules: [
          `coupling:${coupling.level}`,
          `static_imports:${coupling.static_import_count}`,
          `blast_radius:${stringData(component, 'blast_radius') ?? 'unknown'}`,
          `flow_links:${componentFlows.length}`,
        ],
        unknowns: [
          ...stringArrayData(component, 'unknowns'),
          ...(componentFlows.filter((flow) => flow.confidence !== 'verified').length > 0
            ? ['One or more linked flows are reconstructed rather than runtime verified.']
            : []),
        ],
      });
    });

  const architectureAssumptionTraces = architectureAssumptionRecords({
    components,
    flowsByComponent,
    relationships: params.relationships,
  }).map((assumption) =>
    reasoningTrace({
      entityId: assumption.entity_id,
      reasoningType: 'architecture',
      suffix: assumption.assumption_id,
      claim: `Architecture assumption ${assumption.assumption_id}: ${assumption.assumption}`,
      evidenceIds: assumption.evidence_ids,
      confidence: assumption.confidence,
      confidenceScore: assumption.confidence_score,
      rules: ['architecture_assumption', ...assumption.rules],
      unknowns: assumption.unknowns,
    }),
  );

  const projectArchitectureTrace = reasoningTrace({
    entityId: projectId,
    reasoningType: 'architecture',
    suffix: 'project-summary',
    claim: `Project architecture confidence is calibrated from ${components.length} component(s), ${flows.length} flow(s), and ${params.relationships.length} relationship claim(s).`,
    evidenceIds: unique([
      ...components.flatMap(evidenceIdsForComponent),
      ...flows.flatMap(evidenceIdsForFlow),
      ...params.relationships.flatMap((relationship) => relationship.evidence_ids),
    ]),
    confidence: weakestConfidence([...components, ...flows].map((entity) => entity.confidence)),
    confidenceScore: averageConfidenceScore([
      ...components.map(componentConfidenceScore),
      ...flows.map(asFlowConfidenceScore),
    ]),
    rules: [
      `components:${components.length}`,
      `flows:${flows.length}`,
      `relationships:${params.relationships.length}`,
      `relationship_evidence:${params.relationships.filter((relationship) => relationship.evidence_ids.length > 0).length}`,
    ],
    unknowns: [
      ...(flows.length === 0 ? ['No reconstructed flows are available yet.'] : []),
      ...(flows.filter((flow) => flow.confidence !== 'verified').length > 0
        ? [
            `${flows.filter((flow) => flow.confidence !== 'verified').length} reconstructed flow(s) are not verified yet.`,
          ]
        : []),
    ],
  });

  const changedFlows = flows.filter((flow) =>
    flowStringArray(flow, 'files').some((file) => changedFileSet.has(file)),
  );
  const changedComponents = components.filter((component) =>
    component.source_files.some((file) => changedFileSet.has(file)),
  );
  const reviewTraces = [
    ...changedFlows.map((flow) =>
      reasoningTrace({
        entityId: flow.id,
        reasoningType: 'review',
        suffix: 'changed-flow',
        claim: `Review confidence includes ${flow.id} because changed files overlap reconstructed flow evidence.`,
        evidenceIds: evidenceIdsForFlow(flow),
        confidence: flow.confidence,
        confidenceScore: asFlowConfidenceScore(flow),
        rules: [
          'changed_files_overlap_flow',
          `tests:${flowStringArray(flow, 'tests').length}`,
          `risks:${flowRisks(flow).length}`,
        ],
        unknowns: flow.confidence === 'verified' ? [] : [flowConfidenceReason(flow)],
      }),
    ),
    ...changedComponents.map((component) =>
      reasoningTrace({
        entityId: component.id,
        reasoningType: 'review',
        suffix: 'changed-component',
        claim: `Review confidence includes ${component.id} because changed files overlap component ownership evidence.`,
        evidenceIds: evidenceIdsForComponent(component),
        confidence: component.confidence,
        confidenceScore: componentConfidenceScore(component),
        rules: [
          'changed_files_overlap_component',
          `criticality:${stringData(component, 'criticality') ?? 'unknown'}`,
          `blast_radius:${stringData(component, 'blast_radius') ?? 'unknown'}`,
        ],
        unknowns: stringArrayData(component, 'unknowns'),
      }),
    ),
  ];

  const traces = sorted(
    [
      ...componentTraces,
      ...flowTraces,
      ...architectureTraces,
      ...architectureAssumptionTraces,
      projectArchitectureTrace,
      ...reviewTraces,
    ],
    (trace) => trace.trace_id,
  );
  return {
    generated_at: params.now,
    deterministic: true,
    provider_calls_required: false,
    trace_count: traces.length,
    trace_counts_by_type: countByValue(traces.map((trace) => trace.reasoning_type)),
    traces,
  };
}

function completeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return ratio(numerator, denominator);
}

function buildBenchmarkReadyArtifact(params: {
  readonly projectName: string;
  readonly now: string;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
}): Record<string, unknown> {
  const entities = allBucketEntities(params.buckets);
  const components = params.buckets.components.filter(
    (component) => component.latest_status !== 'stale',
  );
  const flows = params.buckets.flows.filter((flow) => flow.latest_status !== 'stale');
  const flowsByComponent = new Map<string, BrainEntity[]>();
  for (const flow of flows) {
    for (const componentId of flowStringArray(flow, 'components')) {
      const existing = flowsByComponent.get(componentId) ?? [];
      flowsByComponent.set(componentId, [...existing, flow]);
    }
  }

  const componentsWithEvidence = components.filter(
    (component) => component.evidence_ids.length > 0,
  );
  const componentsWithTests = components.filter(
    (component) => stringArrayData(component, 'tests').length > 0,
  );
  const componentsWithFlows = components.filter(
    (component) => (flowsByComponent.get(component.id) ?? []).length > 0,
  );
  const componentsWithCoverage = components.filter(
    (component) =>
      component.evidence_ids.length > 0 &&
      stringData(component, 'boundary_type') !== undefined &&
      (flowsByComponent.get(component.id) ?? []).length > 0,
  );

  const flowsWithEntrypoints = flows.filter((flow) => {
    const entrypoints = flow.data?.entrypoints;
    return Array.isArray(entrypoints) && entrypoints.length > 0;
  });
  const flowsWithSteps = flows.filter((flow) => flowSteps(flow).length > 0);
  const flowsWithEvidence = flows.filter((flow) => flow.evidence_ids.length > 0);
  const flowsWithTests = flows.filter((flow) => flowStringArray(flow, 'tests').length > 0);
  const flowsWithCoverage = flows.filter((flow) => {
    const entrypoints = flow.data?.entrypoints;
    return (
      Array.isArray(entrypoints) &&
      entrypoints.length > 0 &&
      flowSteps(flow).length > 0 &&
      flow.evidence_ids.length > 0
    );
  });

  const relationshipsWithEvidence = params.relationships.filter(
    (relationship) => relationship.evidence_ids.length > 0,
  );
  const entitiesWithEvidence = entities.filter((entity) => entity.evidence_ids.length > 0);
  const evidenceClaimCount = entities.length + params.relationships.length;
  const evidenceBackedClaimCount = entitiesWithEvidence.length + relationshipsWithEvidence.length;
  const knownEvidenceIds = new Set(params.buckets.evidence.map((entity) => entity.id));
  const referencedEvidenceIds = unique([
    ...entities.flatMap((entity) => entity.evidence_ids),
    ...params.relationships.flatMap((relationship) => relationship.evidence_ids),
  ]);
  const missingEvidenceReferences = referencedEvidenceIds.filter((id) => !knownEvidenceIds.has(id));

  const unknownItems = [
    ...components.flatMap((component) =>
      stringArrayData(component, 'unknowns').map((description) => ({
        kind: 'component',
        entity_id: component.id,
        description,
        evidence_ids: component.evidence_ids,
      })),
    ),
    ...flows.flatMap((flow) =>
      stringArrayData(flow, 'unknowns').map((description) => ({
        kind: 'flow',
        entity_id: flow.id,
        description,
        evidence_ids: flow.evidence_ids,
      })),
    ),
    ...params.buckets.risks
      .filter((risk) => risk.confidence !== 'verified')
      .map((risk) => ({
        kind: 'risk',
        entity_id: risk.id,
        description: risk.description,
        evidence_ids: risk.evidence_ids,
      })),
  ];
  const unknownsWithEvidence = unknownItems.filter((item) => item.evidence_ids.length > 0);
  const componentCoverageRatio = ratio(componentsWithCoverage.length, components.length);
  const flowCoverageRatio = ratio(flowsWithCoverage.length, flows.length);
  const evidenceCoverageRatio = ratio(evidenceBackedClaimCount, evidenceClaimCount);
  const unknownCoverageRatio = completeRatio(unknownsWithEvidence.length, unknownItems.length);
  const readinessScore = Math.round(
    ((componentCoverageRatio + flowCoverageRatio + evidenceCoverageRatio + unknownCoverageRatio) /
      4) *
      100,
  );
  const blockingGaps = [
    ...(components.length > 0 && componentsWithCoverage.length === 0
      ? ['No component has benchmark coverage across boundary, flow, and evidence signals.']
      : []),
    ...(flows.length > 0 && flowsWithCoverage.length === 0
      ? ['No flow has benchmark coverage across entrypoint, steps, and evidence signals.']
      : []),
    ...(missingEvidenceReferences.length > 0
      ? [`${missingEvidenceReferences.length} evidence reference(s) are missing.`]
      : []),
  ];

  return {
    schema_version: 1,
    generated_at: params.now,
    benchmark_suite: 'pi-bench-seed',
    project_id: entityId('project', params.projectName),
    project_name: params.projectName,
    deterministic: true,
    provider_calls_required: false,
    network_required: false,
    coverage: {
      component: {
        total: components.length,
        covered: componentsWithCoverage.length,
        coverage_ratio: componentCoverageRatio,
        with_evidence: componentsWithEvidence.length,
        with_tests: componentsWithTests.length,
        with_flows: componentsWithFlows.length,
        uncovered_component_ids: components
          .filter((component) => !componentsWithCoverage.includes(component))
          .map((component) => component.id),
      },
      flow: {
        total: flows.length,
        covered: flowsWithCoverage.length,
        coverage_ratio: flowCoverageRatio,
        with_entrypoints: flowsWithEntrypoints.length,
        with_steps: flowsWithSteps.length,
        with_evidence: flowsWithEvidence.length,
        with_tests: flowsWithTests.length,
        uncovered_flow_ids: flows
          .filter((flow) => !flowsWithCoverage.includes(flow))
          .map((flow) => flow.id),
      },
      evidence: {
        records: params.buckets.evidence.length,
        claims: evidenceClaimCount,
        claims_with_evidence: evidenceBackedClaimCount,
        coverage_ratio: evidenceCoverageRatio,
        referenced_evidence_ids: referencedEvidenceIds.length,
        missing_references: missingEvidenceReferences,
      },
      unknown: {
        total: unknownItems.length,
        covered: unknownsWithEvidence.length,
        coverage_ratio: unknownCoverageRatio,
        components_with_unknowns: components.filter(
          (component) => stringArrayData(component, 'unknowns').length > 0,
        ).length,
        flows_with_unknowns: flows.filter((flow) => stringArrayData(flow, 'unknowns').length > 0)
          .length,
        confidence_gap_risks: params.buckets.risks.filter((risk) => risk.confidence !== 'verified')
          .length,
        items: unknownItems.slice(0, 25),
      },
    },
    readiness: {
      is_ready: blockingGaps.length === 0,
      score: readinessScore,
      blocking_gaps: blockingGaps,
      notes: [
        'Benchmark readiness is computed from deterministic local brain facts only.',
        'Coverage ratios track component, flow, evidence, and known-unknown surfaces for PI-Bench seed fixtures.',
      ],
    },
  };
}

function boundedScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreBand(score: number): string {
  if (score >= 85) return 'strong';
  if (score >= 70) return 'usable';
  if (score >= 45) return 'weak';
  return 'not ready';
}

function recordNumber(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const item = value[key];
  return typeof item === 'number' ? item : 0;
}

function recordArray(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value)) return [];
  const item = value[key];
  return Array.isArray(item) ? item : [];
}

function readinessScore(value: unknown): number {
  if (!isRecord(value)) return 0;
  const readiness = value.readiness;
  if (!isRecord(readiness)) return 0;
  return typeof readiness.score === 'number' ? readiness.score : 0;
}

function readFirstPointers(components: readonly BrainEntity[]): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return [...components]
    .sort((a, b) => {
      const aScore = numberData(a, 'criticality_score') ?? 0;
      const bScore = numberData(b, 'criticality_score') ?? 0;
      return bScore - aScore || a.name.localeCompare(b.name);
    })
    .flatMap((component) =>
      stringArrayData(component, 'read_first').map((path) => ({
        path: safeText(path),
        component_id: safeText(component.id),
        reason: `${stringData(component, 'criticality') ?? 'unknown'} criticality; ${
          stringData(component, 'boundary_type') ?? 'unknown'
        } boundary.`,
        evidence_ids: component.evidence_ids.map(safeText),
      })),
    )
    .filter((pointer) => {
      const path = typeof pointer.path === 'string' ? pointer.path : '';
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    })
    .slice(0, 8);
}

function topUnknowns(params: {
  readonly buckets: BrainBuckets;
  readonly architectureReasoning: unknown;
  readonly evidenceQuality: unknown;
}): string[] {
  const componentUnknowns = params.buckets.components.flatMap((component) =>
    stringArrayData(component, 'unknowns').map(
      (unknown) => `${component.id}: ${safeText(unknown)}`,
    ),
  );
  const flowUnknowns = params.buckets.flows.flatMap((flow) =>
    stringArrayData(flow, 'unknowns').map((unknown) => `${flow.id}: ${safeText(unknown)}`),
  );
  const architectureUnknowns = asStringArray(
    isRecord(params.architectureReasoning) ? params.architectureReasoning.unknowns : undefined,
  );
  const evidenceGaps = recordArray(params.evidenceQuality, 'top_evidence_gaps')
    .filter(isRecord)
    .map((gap) => {
      const id = typeof gap.id === 'string' ? gap.id : 'unknown claim';
      const reason = typeof gap.reason === 'string' ? gap.reason : 'Evidence gap recorded.';
      return `${safeText(id)}: ${safeText(reason)}`;
    });
  return unique([...componentUnknowns, ...flowUnknowns, ...architectureUnknowns, ...evidenceGaps])
    .slice(0, 10)
    .map(safeText);
}

function dimensionRecord(params: {
  readonly score: number;
  readonly summary: string;
  readonly signals: readonly string[];
  readonly weakSpots: readonly string[];
}): Record<string, unknown> {
  const score = boundedScore(params.score);
  return {
    score,
    status: scoreBand(score),
    summary: safeText(params.summary),
    signals: params.signals.map(safeText),
    weak_spots: params.weakSpots.map(safeText),
  };
}

function buildUnderstandingScoreArtifact(params: {
  readonly projectName: string;
  readonly now: string;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
  readonly incrementalMetrics: IncrementalUnderstandingMetrics;
  readonly componentIntelligence: unknown;
  readonly evidenceQuality: unknown;
  readonly architectureReasoning: unknown;
  readonly benchmarkReady: unknown;
}): Record<string, unknown> {
  const components = params.buckets.components.filter(
    (component) => component.latest_status !== 'stale',
  );
  const flows = params.buckets.flows.filter((flow) => flow.latest_status !== 'stale');
  const flowsWithSteps = flows.filter((flow) => flowSteps(flow).length > 0);
  const flowsWithEvidence = flows.filter((flow) => flow.evidence_ids.length > 0);
  const flowsWithTests = flows.filter((flow) => flowStringArray(flow, 'tests').length > 0);
  const averageFlowConfidence =
    flows.length === 0
      ? 0
      : flows.reduce((total, flow) => total + asFlowConfidenceScore(flow), 0) / flows.length;
  const flowScore = boundedScore(
    scorePercent(flowsWithSteps.length, flows.length) * 0.3 +
      scorePercent(flowsWithEvidence.length, flows.length) * 0.25 +
      scorePercent(flowsWithTests.length, flows.length) * 0.2 +
      averageFlowConfidence * 100 * 0.25,
  );
  const knownBoundaryComponents = components.filter(
    (component) => stringData(component, 'boundary_type') !== 'unknown',
  );
  const architectureUnknowns = asStringArray(
    isRecord(params.architectureReasoning) ? params.architectureReasoning.unknowns : undefined,
  );
  const architectureScore = boundedScore(
    scorePercent(knownBoundaryComponents.length, components.length) * 0.4 +
      scorePercent(
        components.filter((component) => componentCouplingRecord(component).reasons.length > 0)
          .length,
        components.length,
      ) *
        0.25 +
      Math.max(0, 100 - architectureUnknowns.length * 12) * 0.35,
  );
  const incrementalScore = boundedScore(
    Math.max(0, 100 - params.incrementalMetrics.stale_fact_count * 12) * 0.45 +
      params.incrementalMetrics.scan_efficiency_score * 0.35 +
      Math.round(params.incrementalMetrics.file_reuse_ratio * 100) * 0.2,
  );
  const unknownItems = topUnknowns({
    buckets: params.buckets,
    architectureReasoning: params.architectureReasoning,
    evidenceQuality: params.evidenceQuality,
  });
  const unknownScore = boundedScore(Math.max(0, 100 - unknownItems.length * 8));
  const componentScore = recordNumber(
    params.componentIntelligence,
    'component_understanding_score',
  );
  const evidenceScore = recordNumber(params.evidenceQuality, 'overall_score');
  const reviewReadinessScore = readinessScore(params.benchmarkReady);
  const dimensions = {
    components: dimensionRecord({
      score: componentScore,
      summary: `${components.length} component(s), ${recordNumber(
        params.componentIntelligence,
        'flow_coverage_score',
      )}/100 flow coverage.`,
      signals: [
        `${recordNumber(params.componentIntelligence, 'field_coverage_score')}/100 field coverage`,
        `${recordNumber(
          params.componentIntelligence,
          'evidence_backed_field_score',
        )}/100 evidence-backed fields`,
      ],
      weakSpots: asStringArray(
        isRecord(params.componentIntelligence)
          ? params.componentIntelligence.high_criticality_without_tests
          : undefined,
      ),
    }),
    flows: dimensionRecord({
      score: flowScore,
      summary: `${flows.length} reconstructed flow(s), ${flowsWithTests.length} with tests.`,
      signals: [
        `${flowsWithSteps.length} flow(s) with steps`,
        `${flowsWithEvidence.length} flow(s) with evidence`,
      ],
      weakSpots: flows
        .filter((flow) => flow.confidence !== 'verified')
        .slice(0, 6)
        .map((flow) => flow.id),
    }),
    architecture: dimensionRecord({
      score: architectureScore,
      summary: `${knownBoundaryComponents.length}/${components.length} component boundary type(s) known.`,
      signals: [
        `${recordArray(params.architectureReasoning, 'coupling_hotspots').length} coupling hotspot(s)`,
        `${recordArray(params.architectureReasoning, 'critical_paths').length} critical path(s)`,
      ],
      weakSpots: architectureUnknowns,
    }),
    evidence: dimensionRecord({
      score: evidenceScore,
      summary: `${recordNumber(params.evidenceQuality, 'claims_with_evidence')} evidence-backed claim(s).`,
      signals: [
        `${recordNumber(params.evidenceQuality, 'evidence_coverage_score')}/100 evidence coverage`,
        `${recordNumber(params.evidenceQuality, 'redaction_safety_score')}/100 redaction safety`,
      ],
      weakSpots: topUnknowns({
        buckets: { ...params.buckets, components: [], flows: [] },
        architectureReasoning: {},
        evidenceQuality: params.evidenceQuality,
      }).slice(0, 6),
    }),
    incremental_status: dimensionRecord({
      score: incrementalScore,
      summary: `${params.incrementalMetrics.changed_file_count} changed file(s), ${params.incrementalMetrics.changed_entity_count} changed entity/entities.`,
      signals: [
        `${params.incrementalMetrics.reused_understanding_count} reused understanding item(s)`,
        `${params.incrementalMetrics.scan_efficiency_score}/100 scan efficiency`,
      ],
      weakSpots: params.incrementalMetrics.stale_fact_candidates.slice(0, 6),
    }),
    review_readiness: dimensionRecord({
      score: reviewReadinessScore,
      summary: `${readinessScore(params.benchmarkReady)}/100 deterministic review readiness.`,
      signals: [
        `${components.filter((component) => stringArrayData(component, 'tests').length > 0).length} component(s) with tests`,
        `${flowsWithTests.length} flow(s) with tests`,
      ],
      weakSpots: asStringArray(
        isRecord(params.benchmarkReady) && isRecord(params.benchmarkReady.readiness)
          ? params.benchmarkReady.readiness.blocking_gaps
          : undefined,
      ),
    }),
    unknowns: dimensionRecord({
      score: unknownScore,
      summary: `${unknownItems.length} top unknown(s) need confirmation.`,
      signals: [
        `${components.filter((component) => stringArrayData(component, 'unknowns').length > 0).length} component(s) with unknowns`,
        `${flows.filter((flow) => stringArrayData(flow, 'unknowns').length > 0).length} flow(s) with unknowns`,
      ],
      weakSpots: unknownItems,
    }),
  };
  const dimensionScores = Object.values(dimensions).map((dimension) =>
    recordNumber(dimension, 'score'),
  );
  const overallScore = boundedScore(
    recordNumber(dimensions.components, 'score') * 0.2 +
      recordNumber(dimensions.flows, 'score') * 0.16 +
      recordNumber(dimensions.architecture, 'score') * 0.16 +
      recordNumber(dimensions.evidence, 'score') * 0.18 +
      recordNumber(dimensions.incremental_status, 'score') * 0.1 +
      recordNumber(dimensions.review_readiness, 'score') * 0.12 +
      recordNumber(dimensions.unknowns, 'score') * 0.08,
  );

  return {
    schema_version: 1,
    generated_at: params.now,
    project_id: entityId('project', params.projectName),
    project_name: safeText(params.projectName),
    overall_score: overallScore,
    score_band: scoreBand(overallScore),
    dimension_count: dimensionScores.length,
    dimensions,
    top_unknowns: unknownItems,
    read_first: readFirstPointers(components),
    changed: {
      changed_file_count: params.incrementalMetrics.changed_file_count,
      changed_entity_count: params.incrementalMetrics.changed_entity_count,
      affected_flows: params.incrementalMetrics.affected_flows.map(safeText),
      stale_fact_count: params.incrementalMetrics.stale_fact_count,
      scan_efficiency_score: params.incrementalMetrics.scan_efficiency_score,
    },
    review_readiness: {
      score: reviewReadinessScore,
      status: scoreBand(reviewReadinessScore),
      required_attention: asStringArray(
        isRecord(params.benchmarkReady) && isRecord(params.benchmarkReady.readiness)
          ? params.benchmarkReady.readiness.blocking_gaps
          : undefined,
      ),
    },
    redaction_safety: {
      redaction_safety_score: recordNumber(params.evidenceQuality, 'redaction_safety_score'),
      unsafe_sensitive_reference_count: recordNumber(
        params.evidenceQuality,
        'unsafe_sensitive_reference_count',
      ),
    },
    scoring_notes: [
      'Understanding score is deterministic and derived only from local brain, research, and incremental artifacts.',
      'Scores reflect static project intelligence coverage; they do not claim runtime execution certainty.',
      'Secret safety is part of evidence scoring so sensitive fixture paths or tokens do not improve the score by leaking.',
    ],
  };
}

function buildIncrementalUnderstandingMetrics(params: {
  readonly now: string;
  readonly files: readonly FileFact[];
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
  readonly changedFiles: readonly string[];
  readonly staleFiles: readonly string[];
  readonly previous: PreviousUnderstandingState;
}): IncrementalUnderstandingMetrics {
  const changedFiles = unique(params.changedFiles);
  const staleFiles = unique(params.staleFiles);
  const activeFileEntities = params.buckets.files.filter((file) => file.latest_status !== 'stale');
  const currentFiles = activeFileEntities.filter((file) => file.latest_status === 'current');
  const newFiles = activeFileEntities.filter((file) => file.latest_status === 'new');
  const filesByStatus = countByValue(params.buckets.files.map((file) => file.latest_status));
  const changedFileSet = new Set(changedFiles);
  const changedFlows = params.buckets.flows.filter((flow) =>
    flowStringArray(flow, 'files').some((file) => changedFileSet.has(file)),
  );
  const previousEntities = filterUnderstandingEntities(params.previous.entities);
  const currentEntities = filterUnderstandingEntities(allBucketEntities(params.buckets));
  const previousEntityById = new Map(previousEntities.map((entity) => [entity.id, entity]));
  const currentEntityById = new Map(currentEntities.map((entity) => [entity.id, entity]));
  const addedEntities = currentEntities.filter((entity) => !previousEntityById.has(entity.id));
  const removedEntities = previousEntities.filter((entity) => !currentEntityById.has(entity.id));
  const changedEntities = currentEntities.filter((entity) => {
    const previous = previousEntityById.get(entity.id);
    return previous !== undefined && entitySemanticHash(previous) !== entitySemanticHash(entity);
  });
  const stableEntityCount = currentEntities.filter((entity) => {
    const previous = previousEntityById.get(entity.id);
    return previous !== undefined && entitySemanticHash(previous) === entitySemanticHash(entity);
  }).length;
  const relationshipDelta = buildRelationshipDelta(
    params.previous.relationships,
    params.relationships,
  );
  const evidenceDelta = buildEvidenceDelta(previousEntities, currentEntities);
  const staleFactCandidates = unique([
    ...staleFiles.map((file) => entityId('file', file)),
    ...currentEntities
      .filter((entity) => entity.latest_status === 'stale')
      .map((entity) => entity.id),
  ]);
  const recomputedUnderstandingCount =
    addedEntities.length + changedEntities.length + relationshipDelta.added_count;
  const efficiencyDenominator =
    stableEntityCount + recomputedUnderstandingCount + staleFactCandidates.length;

  return {
    generated_at: params.now,
    previous_brain_fingerprint: params.previous.fingerprint,
    current_brain_fingerprint: brainFingerprint(currentEntities, params.relationships),
    scanned_files: params.files.length,
    changed_files: changedFiles,
    changed_file_count: changedFiles.length,
    stale_files: staleFiles,
    stale_file_count: staleFiles.length,
    file_status_counts: filesByStatus,
    reused_files: currentFiles.length,
    recomputed_files: changedFiles.length,
    file_reuse_ratio: ratio(currentFiles.length, params.files.length),
    current_files: currentFiles.map((file) => file.name).sort((a, b) => a.localeCompare(b)),
    new_files: newFiles.map((file) => file.name).sort((a, b) => a.localeCompare(b)),
    affected_flows: changedFlows.map((flow) => flow.id),
    previous_entity_count: previousEntities.length,
    current_entity_count: currentEntities.length,
    added_entity_count: addedEntities.length,
    removed_entity_count: removedEntities.length,
    changed_entity_count: changedEntities.length,
    stable_entity_count: stableEntityCount,
    added_entities: sorted(addedEntities.map(incrementalEntityDelta), (entity) => entity.id),
    removed_entities: sorted(removedEntities.map(incrementalEntityDelta), (entity) => entity.id),
    changed_entities: sorted(changedEntities.map(incrementalEntityDelta), (entity) => entity.id),
    relationship_delta: relationshipDelta,
    evidence_delta: evidenceDelta,
    reused_understanding_count: stableEntityCount,
    recomputed_understanding_count: recomputedUnderstandingCount,
    stale_fact_count: staleFactCandidates.length,
    stale_fact_candidates: staleFactCandidates,
    scan_efficiency_score: scorePercent(stableEntityCount, efficiencyDenominator),
  };
}

function buildRelationshipDelta(
  previousRelationships: readonly BrainRelationship[],
  currentRelationships: readonly BrainRelationship[],
): IncrementalRelationshipDelta {
  const previousByKey = new Map(
    previousRelationships.map((rel) => [relationshipDeltaKey(rel), rel]),
  );
  const currentByKey = new Map(currentRelationships.map((rel) => [relationshipDeltaKey(rel), rel]));
  const added = currentRelationships.filter((relationship) => {
    return !previousByKey.has(relationshipDeltaKey(relationship));
  });
  const removed = previousRelationships.filter((relationship) => {
    return !currentByKey.has(relationshipDeltaKey(relationship));
  });
  const changed = currentRelationships.filter((relationship) => {
    const previous = previousByKey.get(relationshipDeltaKey(relationship));
    return (
      previous !== undefined &&
      relationshipSemanticHash(previous) !== relationshipSemanticHash(relationship)
    );
  });

  return {
    previous_count: previousRelationships.length,
    current_count: currentRelationships.length,
    added_count: added.length,
    removed_count: removed.length,
    changed_count: changed.length,
    added: sorted(added.map(relationshipDeltaItem), relationshipDeltaKey),
    removed: sorted(removed.map(relationshipDeltaItem), relationshipDeltaKey),
    changed: sorted(changed.map(relationshipDeltaItem), relationshipDeltaKey),
  };
}

function buildEvidenceDelta(
  previousEntities: readonly BrainEntity[],
  currentEntities: readonly BrainEntity[],
): IncrementalEvidenceDelta {
  const previousEvidence = previousEntities.filter((entity) => entity.type === 'evidence');
  const currentEvidence = currentEntities.filter((entity) => entity.type === 'evidence');
  const previousById = new Map(previousEvidence.map((entity) => [entity.id, entity]));
  const currentById = new Map(currentEvidence.map((entity) => [entity.id, entity]));
  const added = currentEvidence.filter((entity) => !previousById.has(entity.id));
  const removed = previousEvidence.filter((entity) => !currentById.has(entity.id));
  const changed = currentEvidence.filter((entity) => {
    const previous = previousById.get(entity.id);
    return previous !== undefined && entitySemanticHash(previous) !== entitySemanticHash(entity);
  });

  return {
    previous_count: previousEvidence.length,
    current_count: currentEvidence.length,
    added_count: added.length,
    removed_count: removed.length,
    changed_count: changed.length,
    added: added.map((entity) => entity.id).sort((a, b) => a.localeCompare(b)),
    removed: removed.map((entity) => entity.id).sort((a, b) => a.localeCompare(b)),
    changed: changed.map((entity) => entity.id).sort((a, b) => a.localeCompare(b)),
  };
}

function buildResearchArtifacts(params: {
  readonly projectName: string;
  readonly now: string;
  readonly files: readonly FileFact[];
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
  readonly stack: readonly string[];
  readonly packageManager: string;
  readonly changedFiles: readonly string[];
  readonly staleFiles: readonly string[];
  readonly incrementalMetrics: IncrementalUnderstandingMetrics;
}): Record<keyof typeof RESEARCH_ARTIFACT_FILES, unknown> {
  const entities = allBucketEntities(params.buckets);
  const entityCounts = Object.fromEntries(
    ENTITY_FILES.map(([bucket, , entityType]) => [entityType, params.buckets[bucket].length]),
  );
  const activeFileEntities = params.buckets.files.filter((file) => file.latest_status !== 'stale');
  const filesByStatus = countByValue(params.buckets.files.map((file) => file.latest_status));
  const changedFiles = unique(params.changedFiles);
  const staleFiles = unique(params.staleFiles);
  const componentSourceFiles = new Set(
    params.buckets.components.flatMap((component) => component.source_files),
  );
  const mappedActiveFiles = activeFileEntities.filter((file) =>
    componentSourceFiles.has(file.name),
  );
  const flows = params.buckets.flows;
  const flowStepCount = flows.reduce((count, flow) => count + flowSteps(flow).length, 0);
  const flowRiskCount = flows.reduce((count, flow) => count + flowRisks(flow).length, 0);
  const flowsWithTests = flows.filter((flow) => flowStringArray(flow, 'tests').length > 0);
  const flowsWithoutTests = flows.filter((flow) => flowStringArray(flow, 'tests').length === 0);
  const lowConfidenceFlows = flows.filter((flow) => flow.confidence !== 'verified');
  const flowsWithContracts = flows.filter(
    (flow) =>
      flowStringArray(flow, 'entry_contract').length > 0 &&
      flowStringArray(flow, 'exit_contract').length > 0,
  );
  const flowCoveredFiles = new Set(flows.flatMap((flow) => flowStringArray(flow, 'files')));
  const activeSourceFiles = activeFileEntities.filter((file) => isSourceFile(file.name));
  const activeTestFiles = activeFileEntities.filter((file) => isTestPath(file.name));
  const activeConfigFiles = activeFileEntities.filter((file) => isConfigPath(file.name));
  const entrypoints = flows.flatMap(flowEntrypoints);
  const entrypointsWithComponents = entrypoints.filter(
    (entrypoint) => entrypoint.component_id !== undefined && entrypoint.component_id !== null,
  );
  const changedFileSet = new Set(changedFiles);
  const changedFlows = flows.filter((flow) =>
    flowStringArray(flow, 'files').some((file) => changedFileSet.has(file)),
  );
  const averageFlowConfidence =
    flows.length === 0
      ? 0
      : Number(
          (
            flows.reduce((total, flow) => total + asFlowConfidenceScore(flow), 0) / flows.length
          ).toFixed(4),
        );
  const componentIntelligence = buildComponentIntelligenceArtifact({
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
  });
  const evidenceQuality = buildEvidenceQualityArtifact({
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
  });
  const reasoningTraces = buildReasoningTracesArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
    changedFiles,
  });
  const architectureReasoning = buildArchitectureReasoningArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
    changedFiles,
  });
  const benchmarkReady = buildBenchmarkReadyArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
  });
  const understandingScore = buildUnderstandingScoreArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
    incrementalMetrics: params.incrementalMetrics,
    componentIntelligence,
    evidenceQuality,
    architectureReasoning,
    benchmarkReady,
  });
  const referencedEvidenceIds = unique([
    ...entities.flatMap((entity) => entity.evidence_ids),
    ...params.relationships.flatMap((relationship) => relationship.evidence_ids),
  ]);
  const knownEvidenceIds = new Set(params.buckets.evidence.map((entity) => entity.id));
  const missingEvidenceReferences = referencedEvidenceIds.filter((id) => !knownEvidenceIds.has(id));
  const componentUnknownCount = params.buckets.components.reduce(
    (count, component) => count + stringArrayData(component, 'unknowns').length,
    0,
  );
  const flowUnknownCount = flows.reduce(
    (count, flow) => count + stringArrayData(flow, 'unknowns').length,
    0,
  );
  const reviewTraces = reasoningTraces.traces.filter((trace) => trace.reasoning_type === 'review');

  return {
    metrics: {
      generated_at: params.now,
      project_id: entityId('project', params.projectName),
      project_name: params.projectName,
      scanned_files: params.files.length,
      active_file_entities: activeFileEntities.length,
      stale_file_entities: staleFiles.length,
      changed_files: changedFiles.length,
      components: params.buckets.components.length,
      flows: flows.length,
      flow_steps: flowStepCount,
      flow_risks: flowRiskCount,
      commands: params.buckets.commands.length,
      tests: params.buckets.tests.length,
      evidence_records: params.buckets.evidence.length,
      relationships: params.relationships.length,
      unknown_areas: {
        confidence_gaps: params.buckets.risks.filter((risk) => risk.confidence !== 'verified')
          .length,
        components_without_tests: params.buckets.components.filter(
          (component) => stringArrayData(component, 'tests').length === 0,
        ).length,
        components_without_consumers: params.buckets.components.filter(
          (component) => stringArrayData(component, 'consumers').length === 0,
        ).length,
      },
      entity_counts: entityCounts,
      relationship_counts: countByValue(
        params.relationships.map((relationship) => relationship.relation),
      ),
      tech_stack: params.stack,
      package_manager: params.packageManager,
    },
    coverage: {
      generated_at: params.now,
      scanned_files: params.files.length,
      active_file_entities: activeFileEntities.length,
      files_by_kind: countByValue(params.files.map(classifySourceKind)),
      files_by_status: filesByStatus,
      files_with_evidence: activeFileEntities.filter((file) => file.evidence_ids.length > 0).length,
      files_mapped_to_components: mappedActiveFiles.length,
      component_file_coverage_ratio: ratio(mappedActiveFiles.length, activeFileEntities.length),
      components_with_tests: params.buckets.components.filter(
        (component) => stringArrayData(component, 'tests').length > 0,
      ).length,
      components_with_configs: params.buckets.components.filter(
        (component) => stringArrayData(component, 'configs').length > 0,
      ).length,
      flows_with_tests: flowsWithTests.length,
      flows_with_configs: flows.filter((flow) => flowStringArray(flow, 'configs').length > 0)
        .length,
      flows_with_evidence: flows.filter((flow) => flow.evidence_ids.length > 0).length,
      source_files_covered_by_flows: activeSourceFiles.filter((file) =>
        flowCoveredFiles.has(file.name),
      ).length,
      test_files_covered_by_flows: activeTestFiles.filter((file) => flowCoveredFiles.has(file.name))
        .length,
      config_files_covered_by_flows: activeConfigFiles.filter((file) =>
        flowCoveredFiles.has(file.name),
      ).length,
      source_flow_coverage_ratio: ratio(
        activeSourceFiles.filter((file) => flowCoveredFiles.has(file.name)).length,
        activeSourceFiles.length,
      ),
      flow_coverage: flows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        kind: stringData(flow, 'kind') ?? 'unknown',
        framework: stringData(flow, 'framework'),
        route_path: stringData(flow, 'route_path'),
        route_type: stringData(flow, 'route_type'),
        files: flowStringArray(flow, 'files').length,
        components: flowStringArray(flow, 'components').length,
        tests: flowStringArray(flow, 'tests'),
        configs: flowStringArray(flow, 'configs'),
        evidence_ids: flow.evidence_ids.length,
        confidence: flow.confidence,
      })),
      component_coverage: params.buckets.components.map((component) => ({
        id: component.id,
        name: component.name,
        source_files: component.source_files.length,
        evidence_ids: component.evidence_ids.length,
        tests: stringArrayData(component, 'tests'),
        configs: stringArrayData(component, 'configs'),
        dependencies: stringArrayData(component, 'dependencies'),
        confidence: component.confidence,
      })),
    },
    confidence: {
      generated_at: params.now,
      entity_confidence_counts: countByConfidence(entities.map((entity) => entity.confidence)),
      relationship_confidence_counts: countByConfidence(
        params.relationships.map((relationship) => relationship.confidence),
      ),
      surface_calibration: {
        component: {
          total: params.buckets.components.length,
          confidence_counts: countByConfidence(
            params.buckets.components.map((component) => component.confidence),
          ),
          average_score: averageConfidenceScore(
            params.buckets.components.map(componentConfidenceScore),
          ),
          evidence_backed: params.buckets.components.filter(
            (component) => component.evidence_ids.length > 0,
          ).length,
          unknowns: componentUnknownCount,
        },
        flow: {
          total: flows.length,
          confidence_counts: countByConfidence(flows.map((flow) => flow.confidence)),
          average_score: averageFlowConfidence,
          evidence_backed: flows.filter((flow) => evidenceIdsForFlow(flow).length > 0).length,
          unknowns: flowUnknownCount,
        },
        architecture: {
          total: reasoningTraces.traces.filter((trace) => trace.reasoning_type === 'architecture')
            .length,
          confidence_counts: countByConfidence(
            reasoningTraces.traces
              .filter((trace) => trace.reasoning_type === 'architecture')
              .map((trace) => trace.confidence),
          ),
          average_score: averageConfidenceScore(
            reasoningTraces.traces
              .filter((trace) => trace.reasoning_type === 'architecture')
              .map((trace) => trace.confidence_score),
          ),
          evidence_backed: reasoningTraces.traces.filter(
            (trace) => trace.reasoning_type === 'architecture' && trace.evidence_ids.length > 0,
          ).length,
          unknowns: reasoningTraces.traces
            .filter((trace) => trace.reasoning_type === 'architecture')
            .reduce((count, trace) => count + trace.unknowns.length, 0),
        },
        evidence: {
          total: params.buckets.evidence.length,
          confidence_counts: countByConfidence(
            params.buckets.evidence.map((entity) => entity.confidence),
          ),
          average_score: averageConfidenceScore(
            params.buckets.evidence.map((entity) => confidenceScoreForValue(entity.confidence)),
          ),
          evidence_backed: referencedEvidenceIds.length,
          unknowns: missingEvidenceReferences.length,
        },
        review: {
          total: reviewTraces.length,
          confidence_counts: countByConfidence(reviewTraces.map((trace) => trace.confidence)),
          average_score: averageConfidenceScore(
            reviewTraces.map((trace) => trace.confidence_score),
          ),
          evidence_backed: reviewTraces.filter((trace) => trace.evidence_ids.length > 0).length,
          unknowns: reviewTraces.reduce((count, trace) => count + trace.unknowns.length, 0),
        },
        unknowns: {
          total: componentUnknownCount + flowUnknownCount + missingEvidenceReferences.length,
          evidence_backed: reasoningTraces.traces.filter(
            (trace) => trace.unknowns.length > 0 && trace.evidence_ids.length > 0,
          ).length,
          confidence_counts: countByConfidence(
            reasoningTraces.traces
              .filter((trace) => trace.unknowns.length > 0)
              .map((trace) => trace.confidence),
          ),
        },
      },
      component_confidence: params.buckets.components.map((component) => ({
        id: component.id,
        name: component.name,
        confidence: component.confidence,
        criticality: stringData(component, 'criticality') ?? 'unknown',
        evidence_ids: component.evidence_ids,
        source_files: component.source_files,
      })),
      flow_confidence: flows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        kind: stringData(flow, 'kind') ?? 'unknown',
        confidence: flow.confidence,
        score: asFlowConfidenceScore(flow),
        evidence_ids: flow.evidence_ids,
        unknowns: stringArrayData(flow, 'unknowns'),
      })),
      confidence_gaps: params.buckets.risks
        .filter((risk) => risk.confidence !== 'verified')
        .map((risk) => ({
          id: risk.id,
          confidence: risk.confidence,
          description: risk.description,
          evidence_ids: risk.evidence_ids,
        })),
    },
    componentIntelligence,
    evidenceQuality,
    reasoningTraces,
    incrementalUpdate: params.incrementalMetrics,
    flowUnderstanding: {
      generated_at: params.now,
      total_flows: flows.length,
      flows_by_kind: countByValue(flows.map((flow) => stringData(flow, 'kind') ?? 'unknown')),
      flows_with_tests: flowsWithTests.length,
      flows_without_tests: flowsWithoutTests.length,
      flows_with_contracts: flowsWithContracts.length,
      flow_steps: flowStepCount,
      mapped_components: unique(flows.flatMap((flow) => flowStringArray(flow, 'components')))
        .length,
      mapped_files: flowCoveredFiles.size,
      entrypoints: entrypoints.length,
      entrypoints_mapped_to_components: entrypointsWithComponents.length,
      average_confidence: averageFlowConfidence,
      low_confidence_flows: lowConfidenceFlows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        route_path: stringData(flow, 'route_path'),
        route_type: stringData(flow, 'route_type'),
        confidence: flow.confidence,
        reason: flowConfidenceReason(flow),
      })),
      contracts: flows.map((flow) => ({
        id: flow.id,
        framework: stringData(flow, 'framework'),
        route_path: stringData(flow, 'route_path'),
        route_type: stringData(flow, 'route_type'),
        entry_contract: flowStringArray(flow, 'entry_contract'),
        exit_contract: flowStringArray(flow, 'exit_contract'),
        inputs: flowStringArray(flow, 'inputs'),
        outputs: flowStringArray(flow, 'outputs'),
        side_effects: flowStringArray(flow, 'side_effects'),
        state_transitions: flowStringArray(flow, 'state_transitions'),
        failure_modes: flowStringArray(flow, 'failure_modes'),
        required_tests: flowStringArray(flow, 'required_tests'),
        confidence_reasons: flowStringArray(flow, 'confidence_reasons'),
      })),
      orphan_entrypoints: flows
        .filter((flow) => flowStringArray(flow, 'components').length === 0)
        .map((flow) => flow.id),
      incremental_update: {
        previous_total_flows: flows.length,
        current_total_flows: flows.length,
        added: [],
        removed: [],
        changed: changedFlows.map((flow) => flow.id),
      },
    },
    flowCoverage: {
      generated_at: params.now,
      total_flows: flows.length,
      entrypoint_coverage_ratio: ratio(
        flows.filter((flow) => {
          const entrypoints = flow.data?.entrypoints;
          return Array.isArray(entrypoints) && entrypoints.length > 0;
        }).length,
        flows.length,
      ),
      entrypoint_component_coverage_ratio: ratio(
        entrypointsWithComponents.length,
        entrypoints.length,
      ),
      test_backed_flow_ratio: ratio(flowsWithTests.length, flows.length),
      config_backed_flow_ratio: ratio(
        flows.filter((flow) => flowStringArray(flow, 'configs').length > 0).length,
        flows.length,
      ),
      contract_backed_flow_ratio: ratio(flowsWithContracts.length, flows.length),
      source_file_coverage_ratio: ratio(
        activeSourceFiles.filter((file) => flowCoveredFiles.has(file.name)).length,
        activeSourceFiles.length,
      ),
      test_file_coverage_ratio: ratio(
        activeTestFiles.filter((file) => flowCoveredFiles.has(file.name)).length,
        activeTestFiles.length,
      ),
      config_file_coverage_ratio: ratio(
        activeConfigFiles.filter((file) => flowCoveredFiles.has(file.name)).length,
        activeConfigFiles.length,
      ),
      components_covered_by_flows: unique(
        flows.flatMap((flow) => flowStringArray(flow, 'components')),
      ),
      files_covered_by_flows: unique(flows.flatMap((flow) => flowStringArray(flow, 'files'))),
      flows: flows.map((flow) => ({
        id: flow.id,
        kind: stringData(flow, 'kind') ?? 'unknown',
        files: flowStringArray(flow, 'files').length,
        components: flowStringArray(flow, 'components').length,
        tests: flowStringArray(flow, 'tests').length,
        configs: flowStringArray(flow, 'configs').length,
        entry_contract: flowStringArray(flow, 'entry_contract').length,
        exit_contract: flowStringArray(flow, 'exit_contract').length,
        inputs: flowStringArray(flow, 'inputs').length,
        outputs: flowStringArray(flow, 'outputs').length,
        side_effects: flowStringArray(flow, 'side_effects').length,
        state_transitions: flowStringArray(flow, 'state_transitions').length,
        required_tests: flowStringArray(flow, 'required_tests').length,
        risks: flowRisks(flow).length,
        confidence: flow.confidence,
      })),
    },
    flowConfidence: {
      generated_at: params.now,
      average_confidence: averageFlowConfidence,
      flow_confidence_counts: countByConfidence(flows.map((flow) => flow.confidence)),
      low_confidence_flows: lowConfidenceFlows.map((flow) => ({
        id: flow.id,
        confidence: flow.confidence,
        score: asFlowConfidenceScore(flow),
        unknowns: stringArrayData(flow, 'unknowns'),
      })),
      flows: flows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        confidence: flow.confidence,
        score: asFlowConfidenceScore(flow),
        steps: flowSteps(flow).map((step) => ({
          step_id: step.step_id,
          order: step.order,
          evidence_ids: step.evidence,
        })),
      })),
    },
    architectureReasoning,
    benchmarkReady,
    understandingScore,
  };
}

async function writeResearchArtifacts(
  researchDir: string,
  artifacts: Record<keyof typeof RESEARCH_ARTIFACT_FILES, unknown>,
): Promise<void> {
  for (const [key, fileName] of Object.entries(RESEARCH_ARTIFACT_FILES)) {
    await writeVerifiedFile(
      join(researchDir, fileName),
      jsonString(safeResearchValue(artifacts[key as keyof typeof RESEARCH_ARTIFACT_FILES])),
    );
  }
}

function flowMirrorFileName(flow: BrainEntity): string {
  return `${stableSlug(flow.id)}.json`;
}

async function writeFlowMirrors(
  flowDir: string,
  generatedAt: string,
  flows: readonly BrainEntity[],
): Promise<void> {
  await rm(flowDir, { recursive: true, force: true });
  await mkdir(flowDir, { recursive: true });
  const sortedFlows = sorted(flows, (flow) => flow.id);
  const index = {
    generated_at: generatedAt,
    flows: sortedFlows.map((flow) => ({
      id: flow.id,
      name: flow.name,
      kind: stringData(flow, 'kind') ?? 'unknown',
      framework: stringData(flow, 'framework'),
      route_path: stringData(flow, 'route_path'),
      route_type: stringData(flow, 'route_type'),
      file: `.rizz/brain/flows/${flowMirrorFileName(flow)}`,
      entrypoints: Array.isArray(flow.data?.entrypoints) ? flow.data.entrypoints : [],
      components: flowStringArray(flow, 'components').length,
      files: flowStringArray(flow, 'files').length,
      tests: flowStringArray(flow, 'tests').length,
      risks: flowRisks(flow).length,
      steps: flowSteps(flow).length,
      confidence: flow.confidence,
      latest_status: flow.latest_status,
      score: asFlowConfidenceScore(flow),
      evidence_ids: flow.evidence_ids,
    })),
  };
  await writeVerifiedFile(join(flowDir, 'index.json'), jsonString(safeBrainValue(index)));
  for (const flow of sortedFlows) {
    await writeVerifiedFile(
      join(flowDir, flowMirrorFileName(flow)),
      jsonString(safeBrainValue(flow)),
    );
  }
}

function buildLatest(params: {
  readonly projectName: string;
  readonly now: string;
  readonly stack: readonly string[];
  readonly packageManager: string;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
  readonly changedFiles: readonly string[];
  readonly staleFiles: readonly string[];
  readonly incrementalMetrics: IncrementalUnderstandingMetrics;
}): Record<string, unknown> {
  const componentMap = params.buckets.components.map((component) => ({
    id: component.id,
    name: component.name,
    description: component.description,
    confidence: component.confidence,
    source_files: component.source_files,
    purpose: stringData(component, 'purpose'),
    boundary_type: stringData(component, 'boundary_type'),
    responsibilities: stringArrayData(component, 'responsibilities'),
    interfaces: stringArrayData(component, 'interfaces'),
    entry_points: stringArrayData(component, 'entry_points'),
    consumers: stringArrayData(component, 'consumers'),
    dependencies: stringArrayData(component, 'dependencies'),
    dependency_roles: stringArrayData(component, 'dependency_roles'),
    exposed_apis: stringArrayData(component, 'exposed_apis'),
    tests: stringArrayData(component, 'tests'),
    configs: stringArrayData(component, 'configs'),
    coupling: isRecord(component.data?.coupling) ? component.data.coupling : undefined,
    criticality: stringData(component, 'criticality'),
    criticality_score: numberData(component, 'criticality_score'),
    blast_radius: stringData(component, 'blast_radius'),
    ownership_confidence: isRecord(component.data?.ownership_confidence)
      ? component.data.ownership_confidence
      : undefined,
    tradeoffs: stringArrayData(component, 'tradeoffs'),
    failure_modes: stringArrayData(component, 'failure_modes'),
    what_breaks_if_removed: stringArrayData(component, 'what_breaks_if_removed'),
    risky_seams: stringArrayData(component, 'risky_seams'),
    important_files: stringArrayData(component, 'important_files'),
    read_first: stringArrayData(component, 'read_first'),
    known_risks: stringArrayData(component, 'known_risks'),
    unknowns: stringArrayData(component, 'unknowns'),
  }));
  const flowMap = params.buckets.flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    kind: stringData(flow, 'kind') ?? 'unknown',
    framework: stringData(flow, 'framework'),
    route_path: stringData(flow, 'route_path'),
    route_type: stringData(flow, 'route_type'),
    entrypoints: Array.isArray(flow.data?.entrypoints) ? flow.data.entrypoints : [],
    component_count: flowStringArray(flow, 'components').length,
    file_count: flowStringArray(flow, 'files').length,
    test_count: flowStringArray(flow, 'tests').length,
    risk_count: flowRisks(flow).length,
    entry_contract: flowStringArray(flow, 'entry_contract'),
    exit_contract: flowStringArray(flow, 'exit_contract'),
    inputs: flowStringArray(flow, 'inputs'),
    outputs: flowStringArray(flow, 'outputs'),
    side_effects: flowStringArray(flow, 'side_effects'),
    state_transitions: flowStringArray(flow, 'state_transitions'),
    failure_modes: flowStringArray(flow, 'failure_modes'),
    required_tests: flowStringArray(flow, 'required_tests'),
    confidence_reasons: flowStringArray(flow, 'confidence_reasons'),
    confidence: flow.confidence,
    score: asFlowConfidenceScore(flow),
    evidence_ids: flow.evidence_ids,
  }));
  const risks = params.buckets.risks.map((risk) => ({
    id: risk.id,
    name: risk.name,
    description: risk.description,
    confidence: risk.confidence,
    evidence_ids: risk.evidence_ids,
  }));
  const architectureReasoning = buildArchitectureReasoningArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
    changedFiles: params.changedFiles,
  });
  const evidenceQuality = buildEvidenceQualityArtifact({
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
  });
  const componentIntelligence = buildComponentIntelligenceArtifact({
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
  });
  const benchmarkReady = buildBenchmarkReadyArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
  });
  const understandingScore = buildUnderstandingScoreArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
    incrementalMetrics: params.incrementalMetrics,
    componentIntelligence,
    evidenceQuality,
    architectureReasoning,
    benchmarkReady,
  });
  const confidenceGaps = params.buckets.risks
    .filter((risk) => risk.confidence !== 'verified')
    .map((risk) => risk.description);

  return {
    generated_at: params.now,
    project_id: entityId('project', params.projectName),
    latest_architecture_summary:
      params.buckets.components.length === 0
        ? 'No durable component map has been inferred yet.'
        : `${params.projectName} has ${params.buckets.components.length} inferred component(s), ${params.buckets.flows.length} reconstructed flow(s), ${params.buckets.commands.length} command(s), and ${params.buckets.tests.length} test artifact(s).`,
    latest_component_map: componentMap,
    latest_flow_map: flowMap,
    latest_architecture_reasoning: architectureReasoning,
    latest_evidence_quality: evidenceQuality,
    latest_understanding_score: understandingScore,
    latest_incremental_update: {
      previous_brain_fingerprint: params.incrementalMetrics.previous_brain_fingerprint,
      current_brain_fingerprint: params.incrementalMetrics.current_brain_fingerprint,
      changed_file_count: params.incrementalMetrics.changed_file_count,
      changed_entity_count: params.incrementalMetrics.changed_entity_count,
      stable_entity_count: params.incrementalMetrics.stable_entity_count,
      added_entity_count: params.incrementalMetrics.added_entity_count,
      removed_entity_count: params.incrementalMetrics.removed_entity_count,
      reused_understanding_count: params.incrementalMetrics.reused_understanding_count,
      recomputed_understanding_count: params.incrementalMetrics.recomputed_understanding_count,
      stale_fact_count: params.incrementalMetrics.stale_fact_count,
      stale_fact_candidates: params.incrementalMetrics.stale_fact_candidates.slice(0, 25),
      scan_efficiency_score: params.incrementalMetrics.scan_efficiency_score,
      relationship_delta: {
        added_count: params.incrementalMetrics.relationship_delta.added_count,
        removed_count: params.incrementalMetrics.relationship_delta.removed_count,
        changed_count: params.incrementalMetrics.relationship_delta.changed_count,
      },
      evidence_delta: {
        added_count: params.incrementalMetrics.evidence_delta.added_count,
        removed_count: params.incrementalMetrics.evidence_delta.removed_count,
        changed_count: params.incrementalMetrics.evidence_delta.changed_count,
      },
    },
    latest_risks: risks,
    latest_review_status: {
      status: 'not_run',
      note: 'rizz review has not produced a first-class review entity in this brain yet.',
    },
    latest_open_questions: [
      'Which inferred components are true product boundaries versus folder organization?',
      'Which flows are business-critical and need deeper evidence?',
      'Which generated facts should be promoted from inferred to verified?',
    ],
    latest_agent_handoffs: params.buckets.handoffs,
    latest_confidence_gaps: confidenceGaps,
    latest_recommended_next_actions: [
      'Review .rizz/brain/latest.json before reading source files.',
      'Open .rizz/reports/index.html for the local intelligence portal.',
      'Run rizz brain after meaningful file changes to refresh stale facts.',
      'Use component purpose, criticality, and breaks-if-removed fields to orient before editing.',
      'Promote important human decisions into .rizz/brain/entities/decisions.json.',
    ],
    project_state: {
      tech_stack: params.stack,
      package_manager: params.packageManager,
      changed_files: params.changedFiles,
      stale_files: params.staleFiles,
      relationship_count: params.relationships.length,
    },
  };
}

function stringData(entity: BrainEntity, key: string): string | undefined {
  const value = entity.data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberData(entity: BrainEntity, key: string): number | undefined {
  const value = entity.data?.[key];
  return typeof value === 'number' ? value : undefined;
}

function stringArrayData(entity: BrainEntity, key: string): string[] {
  const value = entity.data?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function recordStringArrayData(
  entity: BrainEntity,
  key: string,
): Readonly<Record<string, readonly string[]>> {
  const value = entity.data?.[key];
  if (!isRecord(value)) return {};
  const entries: Array<[string, readonly string[]]> = [];
  for (const [field, items] of Object.entries(value)) {
    const strings = Array.isArray(items)
      ? items.filter((item): item is string => typeof item === 'string')
      : [];
    if (strings.length > 0) entries.push([field, strings]);
  }
  return Object.fromEntries(entries) as Record<string, readonly string[]>;
}

function htmlEscape(value: string): string {
  return safeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fragmentId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function evidenceLabel(evidenceId: string, evidenceById: ReadonlyMap<string, BrainEntity>): string {
  const evidence = evidenceById.get(evidenceId);
  const path = evidence === undefined ? undefined : stringData(evidence, 'path');
  return path ?? evidence?.name ?? evidenceId;
}

function renderEvidenceLinks(
  evidenceIds: readonly string[],
  evidenceById: ReadonlyMap<string, BrainEntity>,
): string {
  const uniqueIds = unique(evidenceIds);
  if (uniqueIds.length === 0) return '<p class="muted">No direct evidence recorded yet.</p>';
  return `<ul class="evidence-links">${uniqueIds
    .map((id) => {
      const label = evidenceLabel(id, evidenceById);
      return `<li><a href="#${htmlEscape(fragmentId(id))}">${htmlEscape(label)}</a></li>`;
    })
    .join('')}</ul>`;
}

function renderList(items: readonly string[]): string {
  if (items.length === 0) return '<p class="muted">None detected yet.</p>';
  return `<ul>${items.map((item) => `<li>${htmlEscape(item)}</li>`).join('')}</ul>`;
}

function renderListWithEvidence(
  items: readonly string[],
  evidenceIds: readonly string[],
  evidenceById: ReadonlyMap<string, BrainEntity>,
): string {
  return `${renderList(items)}
    <div class="evidence-block">
      <p class="muted">Evidence</p>
      ${renderEvidenceLinks(evidenceIds, evidenceById)}
    </div>`;
}

function renderEntityCards(entities: readonly BrainEntity[]): string {
  if (entities.length === 0) return '<p class="muted">None detected yet.</p>';
  return entities
    .map(
      (entity) => `<article class="card" data-search="${htmlEscape(
        `${entity.id} ${entity.name} ${entity.description} ${entity.confidence}`,
      )}">
        <div class="badge">${htmlEscape(entity.confidence)}</div>
        <h3>${htmlEscape(entity.name)}</h3>
        <p>${htmlEscape(entity.description)}</p>
        <p class="muted">${htmlEscape(entity.id)}</p>
      </article>`,
    )
    .join('');
}

function renderRiskCards(
  risks: readonly BrainEntity[],
  evidenceById: ReadonlyMap<string, BrainEntity>,
): string {
  if (risks.length === 0) {
    return '<p class="muted">No risk records detected yet. This does not mean the project is risk-free.</p>';
  }
  return risks
    .map(
      (risk) => `<article class="card" data-search="${htmlEscape(
        `${risk.id} ${risk.name} ${risk.description} ${risk.confidence} ${risk.source_files.join(' ')}`,
      )}" data-kind="risk" data-confidence="${htmlEscape(risk.confidence)}">
        <div class="badge">${htmlEscape(risk.confidence)}</div>
        <h3>${htmlEscape(risk.name)}</h3>
        <p>${htmlEscape(risk.description)}</p>
        <p class="muted">Evidence count: ${risk.evidence_ids.length}</p>
        ${renderEvidenceLinks(risk.evidence_ids, evidenceById)}
      </article>`,
    )
    .join('');
}

function renderComponentCards(
  components: readonly BrainEntity[],
  evidenceById: ReadonlyMap<string, BrainEntity>,
): string {
  if (components.length === 0) return '<p class="muted">None detected yet.</p>';
  return components
    .map((component) => {
      const purpose = stringData(component, 'purpose') ?? component.description;
      const boundaryType = stringData(component, 'boundary_type') ?? 'unknown';
      const criticality = stringData(component, 'criticality') ?? 'unknown';
      const blastRadius = stringData(component, 'blast_radius') ?? 'unknown';
      const coupling = componentCouplingRecord(component);
      const score = numberData(component, 'criticality_score');
      const scoreText = score === undefined ? '' : ` · ${score}/10`;
      const ownershipConfidence = isRecord(component.data?.ownership_confidence)
        ? component.data.ownership_confidence
        : {};
      const ownershipScore =
        typeof ownershipConfidence.score === 'number'
          ? ` · ownership ${Math.round(ownershipConfidence.score * 100)}%`
          : '';
      const fieldEvidence = recordStringArrayData(component, 'field_evidence');
      return `<article class="card" data-search="${htmlEscape(
        `${component.id} ${component.name} ${purpose} ${boundaryType} ${criticality} ${blastRadius} ${coupling.level} ${component.confidence} ${component.source_files.join(' ')}`,
      )}" data-kind="component" data-confidence="${htmlEscape(
        component.confidence,
      )}" data-criticality="${htmlEscape(criticality)}">
        <div class="badge">${htmlEscape(component.confidence)} · ${htmlEscape(boundaryType)} · ${htmlEscape(criticality)}${htmlEscape(scoreText)} · ${htmlEscape(blastRadius)} radius · ${htmlEscape(coupling.level)} coupling${htmlEscape(ownershipScore)}</div>
        <h3>${htmlEscape(component.name)}</h3>
        <p class="muted">Explain this: <code>rizz explain ${htmlEscape(component.name)}</code></p>
        <p>${htmlEscape(purpose)}</p>
        <h4>Responsibilities</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'responsibilities'),
          fieldEvidence.responsibilities ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Interfaces</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'interfaces'),
          fieldEvidence.interfaces ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Entry Points</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'entry_points'),
          fieldEvidence.entry_points ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Consumers</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'consumers'),
          fieldEvidence.consumers ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Dependencies</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'dependencies'),
          fieldEvidence.dependencies ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Dependency Roles</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'dependency_roles'),
          fieldEvidence.dependency_roles ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Coupling</h4>
        ${renderListWithEvidence(
          [
            `level: ${coupling.level}`,
            `score: ${coupling.score}/10`,
            `static imports: ${coupling.static_import_count}`,
            ...coupling.reasons,
            ...coupling.internal_imports.map((item) => `internal: ${item}`),
            ...coupling.external_imports.map((item) => `external: ${item}`),
          ],
          fieldEvidence.coupling ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Read First</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'read_first'),
          fieldEvidence.read_first ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Important Files</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'important_files'),
          fieldEvidence.important_files ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>If Removed</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'what_breaks_if_removed'),
          fieldEvidence.what_breaks_if_removed ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Risky Seams</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'risky_seams'),
          fieldEvidence.risky_seams ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Tradeoffs</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'tradeoffs'),
          fieldEvidence.tradeoffs ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Failure Modes</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'failure_modes'),
          fieldEvidence.failure_modes ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Known Risks</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'known_risks'),
          fieldEvidence.known_risks ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Unknowns</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'unknowns'),
          fieldEvidence.unknowns ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Evidence</h4>
        ${renderEvidenceLinks(component.evidence_ids, evidenceById)}
        <p class="muted">${htmlEscape(component.id)}</p>
      </article>`;
    })
    .join('');
}

function renderFlowCards(
  flows: readonly BrainEntity[],
  evidenceById: ReadonlyMap<string, BrainEntity>,
): string {
  if (flows.length === 0) {
    return '<p class="muted">No reconstructed flows detected yet.</p>';
  }
  return flows
    .map((flow) => {
      const kind = stringData(flow, 'kind') ?? 'unknown';
      const steps = flowSteps(flow);
      const risks = flowRisks(flow);
      const fieldEvidence = recordStringArrayData(flow, 'field_evidence');
      const entrypoints = Array.isArray(flow.data?.entrypoints)
        ? flow.data.entrypoints.filter(isRecord).map((entrypoint) => {
            const type = typeof entrypoint.type === 'string' ? entrypoint.type : 'entrypoint';
            const path = typeof entrypoint.path === 'string' ? entrypoint.path : 'unknown';
            const symbol = typeof entrypoint.symbol === 'string' ? `#${entrypoint.symbol}` : '';
            const component =
              typeof entrypoint.component_id === 'string' ? ` -> ${entrypoint.component_id}` : '';
            return `${type}: ${path}${symbol}${component}`;
          })
        : [];
      const stepLabels = steps.map((step) => `${step.order}. ${step.type}: ${step.path}`);
      return `<article class="card" data-search="${htmlEscape(
        `${flow.id} ${flow.name} ${kind} ${flow.confidence} ${flow.source_files.join(' ')}`,
      )}" data-kind="flow" data-confidence="${htmlEscape(flow.confidence)}">
        <div class="badge">${htmlEscape(flow.confidence)} · ${htmlEscape(kind)} · ${htmlEscape(
          String(asFlowConfidenceScore(flow)),
        )}</div>
        <h3>${htmlEscape(flow.name)}</h3>
        <p class="muted">${htmlEscape(flow.id)}</p>
        <p>${htmlEscape(flow.description)}</p>
        <h4>Entrypoints</h4>
        ${renderListWithEvidence(entrypoints, flow.evidence_ids, evidenceById)}
        <h4>Steps</h4>
        ${renderListWithEvidence(stepLabels, unique(steps.flatMap((step) => step.evidence)), evidenceById)}
        <h4>Entry Contract</h4>
        ${renderListWithEvidence(
          stringArrayData(flow, 'entry_contract'),
          fieldEvidence.entry_contract ?? flow.evidence_ids,
          evidenceById,
        )}
        <h4>Exit Contract</h4>
        ${renderListWithEvidence(
          stringArrayData(flow, 'exit_contract'),
          fieldEvidence.exit_contract ?? flow.evidence_ids,
          evidenceById,
        )}
        <h4>Inputs</h4>
        ${renderListWithEvidence(
          stringArrayData(flow, 'inputs'),
          fieldEvidence.inputs ?? flow.evidence_ids,
          evidenceById,
        )}
        <h4>Outputs</h4>
        ${renderListWithEvidence(
          stringArrayData(flow, 'outputs'),
          fieldEvidence.outputs ?? flow.evidence_ids,
          evidenceById,
        )}
        <h4>Side Effects</h4>
        ${renderListWithEvidence(
          stringArrayData(flow, 'side_effects'),
          fieldEvidence.side_effects ?? flow.evidence_ids,
          evidenceById,
        )}
        <h4>State Transitions</h4>
        ${renderListWithEvidence(
          stringArrayData(flow, 'state_transitions'),
          fieldEvidence.state_transitions ?? flow.evidence_ids,
          evidenceById,
        )}
        <h4>Coverage</h4>
        ${renderList([
          `${flowStringArray(flow, 'components').length} component(s)`,
          `${flowStringArray(flow, 'files').length} file(s)`,
          `${flowStringArray(flow, 'tests').length} test artifact(s)`,
          `${risks.length} risk(s)`,
        ])}
        <h4>Risks</h4>
        ${renderListWithEvidence(
          risks.map((risk) => `${risk.kind}: ${risk.description}`),
          unique(risks.flatMap((risk) => risk.evidence)),
          evidenceById,
        )}
        <h4>Required Tests</h4>
        ${renderListWithEvidence(
          stringArrayData(flow, 'required_tests'),
          fieldEvidence.required_tests ?? flow.evidence_ids,
          evidenceById,
        )}
        <h4>Confidence Reasons</h4>
        ${renderListWithEvidence(
          stringArrayData(flow, 'confidence_reasons'),
          fieldEvidence.confidence_reasons ?? flow.evidence_ids,
          evidenceById,
        )}
      </article>`;
    })
    .join('');
}

function renderStartHere(
  components: readonly BrainEntity[],
  evidenceById: ReadonlyMap<string, BrainEntity>,
): string {
  const ranked = [...components].sort((a, b) => {
    const aScore = numberData(a, 'criticality_score') ?? 0;
    const bScore = numberData(b, 'criticality_score') ?? 0;
    return bScore - aScore || a.name.localeCompare(b.name);
  });
  if (ranked.length === 0) return '<p class="muted">No component entry points detected yet.</p>';
  return ranked
    .slice(0, 5)
    .map((component) => {
      const entryPoints = stringArrayData(component, 'entry_points').slice(0, 3);
      return `<article class="card compact" data-search="${htmlEscape(
        `${component.id} ${component.name} ${component.description}`,
      )}" data-kind="component" data-confidence="${htmlEscape(
        component.confidence,
      )}" data-criticality="${htmlEscape(stringData(component, 'criticality') ?? 'unknown')}">
        <div class="badge">${htmlEscape(component.confidence)} · ${htmlEscape(
          stringData(component, 'criticality') ?? 'unknown',
        )}</div>
        <h3>${htmlEscape(component.name)}</h3>
        <p>${htmlEscape(stringData(component, 'purpose') ?? component.description)}</p>
        <h4>Where to enter</h4>
        ${renderListWithEvidence(entryPoints, component.evidence_ids, evidenceById)}
      </article>`;
    })
    .join('');
}

function renderUnknowns(params: {
  readonly latest: Record<string, unknown>;
  readonly components: readonly BrainEntity[];
}): string {
  const openQuestions = Array.isArray(params.latest.latest_open_questions)
    ? params.latest.latest_open_questions.filter((item): item is string => typeof item === 'string')
    : [];
  const confidenceGaps = Array.isArray(params.latest.latest_confidence_gaps)
    ? params.latest.latest_confidence_gaps.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const inferredComponents = params.components
    .filter((component) => component.confidence !== 'verified')
    .slice(0, 5)
    .map((component) => `Confirm whether ${component.name} is a true product boundary.`);
  const unknowns = unique([...openQuestions, ...confidenceGaps, ...inferredComponents]);
  if (unknowns.length === 0) return '<p class="muted">No open unknowns detected yet.</p>';
  return unknowns
    .map(
      (unknown) => `<article class="card" data-search="${htmlEscape(
        unknown,
      )}" data-kind="unknown" data-confidence="uncertain">
        <div class="badge">needs confirmation</div>
        <h3>${htmlEscape(unknown)}</h3>
        <p class="muted">Unknowns are work queues for better project intelligence. Verify with evidence before relying on inferred facts.</p>
      </article>`,
    )
    .join('');
}

function renderLatestReview(latest: Record<string, unknown>): string {
  const status = latest.latest_review_status;
  if (!isRecord(status)) {
    return '<p class="muted">No review status found. Run <code>rizz review</code> to add one.</p>';
  }
  const rows = Object.entries(status)
    .map(
      ([key, value]) =>
        `<tr><th>${htmlEscape(key)}</th><td>${renderReviewStatusValue(value)}</td></tr>`,
    )
    .join('');
  return `<table><tbody>${rows}</tbody></table>`;
}

function renderReviewStatusValue(value: unknown): string {
  if (Array.isArray(value)) {
    const labels = value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'number' || typeof item === 'boolean') return String(item);
        return undefined;
      })
      .filter((item): item is string => item !== undefined);
    return renderList(labels);
  }
  if (isRecord(value)) {
    const labels = Object.entries(value).map(([key, item]) => {
      if (Array.isArray(item)) return `${key}: ${item.length}`;
      return `${key}: ${String(item)}`;
    });
    return renderList(labels);
  }
  return htmlEscape(String(value));
}

function renderArchitectureReasoning(value: unknown): string {
  if (!isRecord(value)) {
    return '<p class="muted">No architecture reasoning artifact is available yet. Run <code>rizz brain</code> to refresh.</p>';
  }
  const boundaryCandidates = Array.isArray(value.boundary_candidates)
    ? value.boundary_candidates.filter(isRecord)
    : [];
  const couplingHotspots = Array.isArray(value.coupling_hotspots)
    ? value.coupling_hotspots.filter(isRecord)
    : [];
  const criticalPaths = Array.isArray(value.critical_paths)
    ? value.critical_paths.filter(isRecord)
    : [];
  const riskySeams = Array.isArray(value.risky_seams) ? value.risky_seams.filter(isRecord) : [];
  const tradeoffMatrix = Array.isArray(value.tradeoff_matrix)
    ? value.tradeoff_matrix.filter(isRecord)
    : [];
  const whatBreaks = Array.isArray(value.what_breaks) ? value.what_breaks.filter(isRecord) : [];
  const crossComponentFlows = Array.isArray(value.cross_component_flows)
    ? value.cross_component_flows.filter(isRecord)
    : [];
  const riskConcentrations = Array.isArray(value.risk_concentrations)
    ? value.risk_concentrations.filter(isRecord)
    : [];
  const reviewHints = Array.isArray(value.review_hints) ? value.review_hints.filter(isRecord) : [];
  const architectureAssumptions = Array.isArray(value.architecture_assumptions)
    ? value.architecture_assumptions.filter(isRecord)
    : [];
  const designPressures = Array.isArray(value.design_pressures)
    ? value.design_pressures.filter(isRecord)
    : [];
  const couplingRationale = Array.isArray(value.coupling_rationale)
    ? value.coupling_rationale.filter(isRecord)
    : [];
  const evidenceGaps = Array.isArray(value.evidence_gaps)
    ? value.evidence_gaps.filter(isRecord)
    : [];
  const unknowns = asStringArray(value.unknowns);
  const assumptionLabels = architectureAssumptions.slice(0, 5).map((assumption) => {
    const assumptionId =
      typeof assumption.assumption_id === 'string' ? assumption.assumption_id : 'unknown';
    const claim =
      typeof assumption.assumption === 'string' ? assumption.assumption : 'Assumption recorded.';
    const confidence =
      typeof assumption.confidence === 'string' ? assumption.confidence : 'unknown confidence';
    return `${assumptionId}: ${claim} (${confidence})`;
  });
  const pressureLabels = designPressures.slice(0, 5).map((pressure) => {
    const pressureId = typeof pressure.pressure_id === 'string' ? pressure.pressure_id : 'unknown';
    const label =
      typeof pressure.pressure === 'string' ? pressure.pressure : 'Design pressure recorded.';
    const strength = typeof pressure.strength === 'string' ? pressure.strength : 'unknown';
    return `${pressureId}: ${strength} - ${label}`;
  });
  const couplingRationaleLabels = couplingRationale.slice(0, 5).map((rationale) => {
    const componentId =
      typeof rationale.component_id === 'string' ? rationale.component_id : 'unknown component';
    const label =
      typeof rationale.rationale === 'string'
        ? rationale.rationale
        : 'Coupling rationale recorded.';
    const intentional = rationale.intentional_coupling === true ? 'intentional' : 'inferred';
    const risky = rationale.risky_coupling === true ? 'risky' : 'not marked risky';
    return `${componentId}: ${intentional}, ${risky}. ${label}`;
  });
  const gapLabels = evidenceGaps.slice(0, 5).map((gap) => {
    const gapId = typeof gap.gap_id === 'string' ? gap.gap_id : 'unknown gap';
    const label = typeof gap.gap === 'string' ? gap.gap : 'Evidence gap recorded.';
    const severity = typeof gap.severity === 'string' ? gap.severity : 'unknown';
    return `${gapId}: ${severity} - ${label}`;
  });
  const boundaryLabels = boundaryCandidates.slice(0, 5).map((candidate) => {
    const componentId =
      typeof candidate.component_id === 'string' ? candidate.component_id : 'unknown component';
    const flowCount = typeof candidate.flow_count === 'number' ? candidate.flow_count : 0;
    const inboundCount = typeof candidate.inbound_count === 'number' ? candidate.inbound_count : 0;
    const outboundCount =
      typeof candidate.outbound_count === 'number' ? candidate.outbound_count : 0;
    const confidence =
      typeof candidate.confidence === 'string' ? candidate.confidence : 'unknown confidence';
    const criticality =
      typeof candidate.criticality === 'string' ? candidate.criticality : 'unknown criticality';
    const coupling =
      typeof candidate.coupling_level === 'string' ? candidate.coupling_level : 'unknown coupling';
    return `${componentId}: ${flowCount} flow(s), ${inboundCount} inbound, ${outboundCount} outbound, ${criticality}, ${coupling} coupling, ${confidence}`;
  });
  const couplingLabels = couplingHotspots.slice(0, 5).map((hotspot) => {
    const componentId =
      typeof hotspot.component_id === 'string' ? hotspot.component_id : 'unknown component';
    const level = typeof hotspot.coupling_level === 'string' ? hotspot.coupling_level : 'unknown';
    const score = typeof hotspot.coupling_score === 'number' ? hotspot.coupling_score : 0;
    const internalImports = Array.isArray(hotspot.internal_imports)
      ? hotspot.internal_imports.filter((item): item is string => typeof item === 'string')
      : [];
    return `${componentId}: ${level} (${score}/10), ${internalImports.length} internal import target(s)`;
  });
  const criticalPathLabels = criticalPaths.slice(0, 5).map((path) => {
    const componentId =
      typeof path.component_id === 'string' ? path.component_id : 'unknown component';
    const score = typeof path.criticality_score === 'number' ? path.criticality_score : 0;
    const blastRadius = typeof path.blast_radius === 'string' ? path.blast_radius : 'unknown';
    const flows = Array.isArray(path.flow_ids)
      ? path.flow_ids.filter((item): item is string => typeof item === 'string').length
      : 0;
    return `${componentId}: ${score}/10 criticality, ${blastRadius} radius, ${flows} flow(s)`;
  });
  const seamLabels = riskySeams.slice(0, 6).map((seam) => {
    const componentId =
      typeof seam.component_id === 'string' ? seam.component_id : 'unknown component';
    const label = typeof seam.seam === 'string' ? seam.seam : 'unknown seam';
    return `${componentId}: ${label}`;
  });
  const tradeoffLabels = tradeoffMatrix.slice(0, 5).map((item) => {
    const componentId =
      typeof item.component_id === 'string' ? item.component_id : 'unknown component';
    const boundaryType =
      typeof item.boundary_type === 'string' ? item.boundary_type : 'unknown boundary';
    const blastRadius = typeof item.blast_radius === 'string' ? item.blast_radius : 'unknown';
    const tradeoffs = Array.isArray(item.tradeoffs)
      ? item.tradeoffs.filter((entry): entry is string => typeof entry === 'string').length
      : 0;
    return `${componentId}: ${boundaryType}, ${blastRadius} radius, ${tradeoffs} tradeoff(s)`;
  });
  const whatBreaksLabels = whatBreaks.slice(0, 5).map((item) => {
    const componentId =
      typeof item.component_id === 'string' ? item.component_id : 'unknown component';
    const blastRadius = typeof item.blast_radius === 'string' ? item.blast_radius : 'unknown';
    const impacts = Array.isArray(item.impacts)
      ? item.impacts.filter((impact): impact is string => typeof impact === 'string').length
      : 0;
    return `${componentId}: ${blastRadius} radius, ${impacts} removal/change impact(s)`;
  });
  const flowLabels = crossComponentFlows.slice(0, 5).map((flow) => {
    const flowId = typeof flow.flow_id === 'string' ? flow.flow_id : 'unknown flow';
    const components = Array.isArray(flow.components)
      ? flow.components.filter((item): item is string => typeof item === 'string')
      : [];
    return `${flowId}: ${components.length} component(s)`;
  });
  const riskLabels = riskConcentrations.slice(0, 5).map((risk) => {
    const entityId = typeof risk.entity_id === 'string' ? risk.entity_id : 'unknown entity';
    const riskCount = typeof risk.risk_count === 'number' ? risk.risk_count : 0;
    const changedRecently = risk.changed_recently === true ? 'changed recently' : 'not changed';
    return `${entityId}: ${riskCount} risk signal(s), ${changedRecently}`;
  });
  const hintLabels = reviewHints.slice(0, 5).map((hint) => {
    const reason = typeof hint.reason === 'string' ? hint.reason : 'Review architecture evidence.';
    const affectedFlows = Array.isArray(hint.affected_flows)
      ? hint.affected_flows.filter((item): item is string => typeof item === 'string').length
      : 0;
    return `${reason} (${affectedFlows} affected flow(s))`;
  });
  return `<div class="grid">
    <article class="card"><h3>Architecture Assumptions</h3>${renderList(assumptionLabels)}</article>
    <article class="card"><h3>Design Pressures</h3>${renderList(pressureLabels)}</article>
    <article class="card"><h3>Coupling Rationale</h3>${renderList(couplingRationaleLabels)}</article>
    <article class="card"><h3>Evidence Gaps</h3>${renderList(gapLabels)}</article>
    <article class="card"><h3>Boundary Candidates</h3>${renderList(boundaryLabels)}</article>
    <article class="card"><h3>Coupling Hotspots</h3>${renderList(couplingLabels)}</article>
    <article class="card"><h3>Critical Paths</h3>${renderList(criticalPathLabels)}</article>
    <article class="card"><h3>Risky Seams</h3>${renderList(seamLabels)}</article>
    <article class="card"><h3>Tradeoff Matrix</h3>${renderList(tradeoffLabels)}</article>
    <article class="card"><h3>What Breaks</h3>${renderList(whatBreaksLabels)}</article>
    <article class="card"><h3>Cross-Component Flows</h3>${renderList(flowLabels)}</article>
    <article class="card"><h3>Risk Concentrations</h3>${renderList(riskLabels)}</article>
    <article class="card"><h3>Review Hints</h3>${renderList(hintLabels)}</article>
    <article class="card"><h3>Unknowns</h3>${renderList(unknowns)}</article>
  </div>`;
}

function renderEvidenceQuality(value: unknown): string {
  if (!isRecord(value)) {
    return '<p class="muted">No evidence quality artifact is available yet. Run <code>rizz brain</code> to refresh.</p>';
  }
  const score = typeof value.overall_score === 'number' ? value.overall_score : 0;
  const band = typeof value.quality_band === 'string' ? value.quality_band : 'unknown';
  const redactedCount =
    typeof value.redacted_evidence_count === 'number' ? value.redacted_evidence_count : 0;
  const redactedReferences =
    typeof value.redacted_reference_count === 'number' ? value.redacted_reference_count : 0;
  const coverage =
    typeof value.evidence_coverage_score === 'number' ? value.evidence_coverage_score : 0;
  const safety =
    typeof value.redaction_safety_score === 'number' ? value.redaction_safety_score : 0;
  const unsupported = typeof value.unsupported_claims === 'number' ? value.unsupported_claims : 0;
  const weak = typeof value.weak_evidence_claims === 'number' ? value.weak_evidence_claims : 0;
  const gaps = typeof value.evidence_gap_count === 'number' ? value.evidence_gap_count : 0;
  const distribution = isRecord(value.confidence_distribution)
    ? [
        `verified: ${String(value.confidence_distribution.verified ?? 0)}`,
        `inferred: ${String(value.confidence_distribution.inferred ?? 0)}`,
        `uncertain: ${String(value.confidence_distribution.uncertain ?? 0)}`,
      ]
    : [];
  const topGaps = Array.isArray(value.top_evidence_gaps)
    ? value.top_evidence_gaps
        .filter(isRecord)
        .slice(0, 6)
        .map((gap) => {
          const id = typeof gap.id === 'string' ? gap.id : 'unknown claim';
          const field = typeof gap.field === 'string' ? `.${gap.field}` : '';
          const reason = typeof gap.reason === 'string' ? gap.reason : 'Evidence gap recorded.';
          return `${id}${field}: ${reason}`;
        })
    : [];
  const uncertainAreas = asStringArray(value.top_uncertain_areas).slice(0, 8);
  return `<div class="grid">
    <article class="card"><h3>Evidence Quality Score</h3><p>${score}/100 · ${htmlEscape(band)}</p></article>
    <article class="card"><h3>Calibration</h3>${renderList([
      `unsupported claims: ${unsupported}`,
      `weak evidence claims: ${weak}`,
      `evidence gaps: ${gaps}`,
    ])}</article>
    <article class="card"><h3>Redacted Sensitive Evidence</h3>${renderList([
      `${redactedCount} evidence record(s)`,
      `${redactedReferences} redacted reference(s)`,
    ])}</article>
    <article class="card"><h3>Coverage & Safety</h3>${renderList([
      `evidence coverage: ${coverage}/100`,
      `redaction safety: ${safety}/100`,
    ])}</article>
    <article class="card"><h3>Confidence Distribution</h3>${renderList(distribution)}</article>
    <article class="card"><h3>Top Evidence Gaps</h3>${renderList(topGaps)}</article>
    <article class="card"><h3>Unknown / Uncertain Areas</h3>${renderList(uncertainAreas)}</article>
  </div>`;
}

function renderIncrementalUnderstanding(value: unknown): string {
  if (!isRecord(value)) {
    return '<p class="muted">No incremental understanding summary is available yet. Run <code>rizz brain</code> to refresh.</p>';
  }
  const changedFiles = typeof value.changed_file_count === 'number' ? value.changed_file_count : 0;
  const changedEntities =
    typeof value.changed_entity_count === 'number' ? value.changed_entity_count : 0;
  const addedEntities = typeof value.added_entity_count === 'number' ? value.added_entity_count : 0;
  const removedEntities =
    typeof value.removed_entity_count === 'number' ? value.removed_entity_count : 0;
  const stableEntities =
    typeof value.stable_entity_count === 'number' ? value.stable_entity_count : 0;
  const reusedUnderstanding =
    typeof value.reused_understanding_count === 'number'
      ? value.reused_understanding_count
      : stableEntities;
  const recomputedUnderstanding =
    typeof value.recomputed_understanding_count === 'number'
      ? value.recomputed_understanding_count
      : changedEntities + addedEntities;
  const staleFacts = typeof value.stale_fact_count === 'number' ? value.stale_fact_count : 0;
  const scanEfficiency =
    typeof value.scan_efficiency_score === 'number' ? value.scan_efficiency_score : 0;
  const staleCandidates = asStringArray(value.stale_fact_candidates).slice(0, 8);
  const relationshipDelta = isRecord(value.relationship_delta) ? value.relationship_delta : {};
  const evidenceDelta = isRecord(value.evidence_delta) ? value.evidence_delta : {};
  const relationshipLabels = [
    `added: ${String(relationshipDelta.added_count ?? 0)}`,
    `removed: ${String(relationshipDelta.removed_count ?? 0)}`,
    `changed: ${String(relationshipDelta.changed_count ?? 0)}`,
  ];
  const evidenceLabels = [
    `added: ${String(evidenceDelta.added_count ?? 0)}`,
    `removed: ${String(evidenceDelta.removed_count ?? 0)}`,
    `changed: ${String(evidenceDelta.changed_count ?? 0)}`,
  ];
  return `<div class="grid">
    <article class="card"><h3>Changed Understanding</h3>${renderList([
      `${changedFiles} changed file(s)`,
      `${changedEntities} changed entity/entities`,
      `${addedEntities} added entity/entities`,
      `${removedEntities} removed entity/entities`,
    ])}</article>
    <article class="card"><h3>Reuse</h3>${renderList([
      `${reusedUnderstanding} reused understanding item(s)`,
      `${recomputedUnderstanding} recomputed understanding item(s)`,
      `${stableEntities} stable entity/entities`,
    ])}</article>
    <article class="card"><h3>Stale Candidates</h3>${renderList([
      `${staleFacts} stale fact candidate(s)`,
      ...staleCandidates,
    ])}</article>
    <article class="card"><h3>Scan Efficiency</h3><p>${scanEfficiency}/100</p></article>
    <article class="card"><h3>Relationship Delta</h3>${renderList(relationshipLabels)}</article>
    <article class="card"><h3>Evidence Delta</h3>${renderList(evidenceLabels)}</article>
  </div>`;
}

function qualityBandFromScore(score: number): 'weak' | 'usable' | 'strong' {
  if (score >= 80) return 'strong';
  if (score >= 50) return 'usable';
  return 'weak';
}

function metricCard(params: {
  readonly label: string;
  readonly value: string;
  readonly posture: string;
  readonly summary: string;
}): string {
  return `<article class="metric ${htmlEscape(params.posture)}">
    <p class="metric-label">${htmlEscape(params.label)}</p>
    <p class="metric-value">${htmlEscape(params.value)}</p>
    <p class="metric-posture">${htmlEscape(params.posture)}</p>
    <p class="muted">${htmlEscape(params.summary)}</p>
  </article>`;
}

function metricSummaryFromScore(score: number): string {
  const posture = qualityBandFromScore(score);
  if (posture === 'strong') return 'Direct evidence is good enough for review orientation.';
  if (posture === 'usable') return 'Usable for orientation; verify before relying on it.';
  return 'Weak data. Treat this report as a starting point, not a decision record.';
}

function reviewReadinessMetric(score: unknown): {
  readonly value: number;
  readonly posture: string;
} {
  if (!isRecord(score) || !isRecord(score.dimensions)) {
    return { value: 0, posture: 'weak' };
  }
  const review = score.dimensions.review_readiness;
  if (!isRecord(review)) return { value: 0, posture: 'weak' };
  const value = recordNumber(review, 'score');
  return { value, posture: qualityBandFromScore(value) };
}

function evidenceQualityMetric(value: unknown): {
  readonly value: number;
  readonly posture: string;
} {
  if (!isRecord(value)) return { value: 0, posture: 'weak' };
  const score = typeof value.overall_score === 'number' ? value.overall_score : 0;
  const posture =
    typeof value.quality_band === 'string' ? value.quality_band : qualityBandFromScore(score);
  return { value: score, posture };
}

function unknownRiskMetric(unknownCount: number): {
  readonly value: string;
  readonly posture: string;
} {
  if (unknownCount <= 2) return { value: String(unknownCount), posture: 'strong' };
  if (unknownCount <= 8) return { value: String(unknownCount), posture: 'usable' };
  return { value: String(unknownCount), posture: 'weak' };
}

function renderArtifactLinks(): string {
  const artifacts = [
    '.rizz/brain/latest.json',
    '.rizz/brain/graph.json',
    '.rizz/brain/entities/components.json',
    '.rizz/brain/entities/flows.json',
    '.rizz/brain/entities/evidence.json',
    '.rizz/research/evidence_quality.json',
    '.rizz/research/understanding_score.json',
    '.rizz/research/architecture_reasoning.json',
  ];
  return `<ul class="artifact-links">${artifacts
    .map((artifact) => `<li><code>${htmlEscape(artifact)}</code></li>`)
    .join('')}</ul>`;
}

function renderObjectDetails(params: {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly count?: number;
  readonly posture?: string;
}): string {
  const count = params.count === undefined ? '' : `<span>${params.count}</span>`;
  const posture = params.posture === undefined ? '' : `<span>${htmlEscape(params.posture)}</span>`;
  return `<details class="object">
    <summary>
      <span>${htmlEscape(params.title)}</span>
      <span class="summary-meta">${count}${posture}</span>
    </summary>
    <p class="muted">${htmlEscape(params.summary)}</p>
    ${params.body}
  </details>`;
}

function renderDimensionCards(score: unknown): string {
  if (!isRecord(score) || !isRecord(score.dimensions)) {
    return '<p class="muted">No understanding score is available yet.</p>';
  }
  const dimensions = score.dimensions;
  const labels: ReadonlyArray<readonly [string, string]> = [
    ['components', 'Components'],
    ['flows', 'Flows'],
    ['architecture', 'Architecture'],
    ['evidence', 'Evidence'],
    ['incremental_status', 'Incremental Status'],
    ['review_readiness', 'Review Readiness'],
    ['unknowns', 'Unknowns'],
  ];
  return labels
    .map(([key, label]) => {
      const dimension = dimensions[key];
      if (!isRecord(dimension)) {
        return `<article class="card compact"><h3>${htmlEscape(label)}</h3><p class="muted">No score.</p></article>`;
      }
      const value = recordNumber(dimension, 'score');
      const status = typeof dimension.status === 'string' ? dimension.status : scoreBand(value);
      const summary = typeof dimension.summary === 'string' ? dimension.summary : '';
      const weakSpots = asStringArray(dimension.weak_spots).slice(0, 3);
      return `<article class="card compact" data-search="${htmlEscape(
        `${label} ${status} ${summary} ${weakSpots.join(' ')}`,
      )}" data-kind="${htmlEscape(key === 'unknowns' ? 'unknown' : 'score')}">
        <div class="badge">${value}/100 · ${htmlEscape(status)}</div>
        <h3>${htmlEscape(label)}</h3>
        <p>${htmlEscape(summary)}</p>
        <h4>Weak</h4>
        ${renderList(weakSpots)}
      </article>`;
    })
    .join('');
}

function renderReadFirstPointers(score: unknown): string {
  const pointers = recordArray(score, 'read_first').filter(isRecord).slice(0, 6);
  if (pointers.length === 0) return '<p class="muted">No read-first pointers recorded yet.</p>';
  return pointers
    .map((pointer) => {
      const path = typeof pointer.path === 'string' ? pointer.path : 'unknown path';
      const componentId =
        typeof pointer.component_id === 'string' ? pointer.component_id : 'unknown component';
      const reason = typeof pointer.reason === 'string' ? pointer.reason : 'Read first.';
      return `<article class="card compact" data-search="${htmlEscape(
        `${path} ${componentId} ${reason}`,
      )}">
        <h3>${htmlEscape(path)}</h3>
        <p>${htmlEscape(reason)}</p>
        <p class="muted">${htmlEscape(componentId)}</p>
      </article>`;
    })
    .join('');
}

function renderUnderstandingDashboard(score: unknown): string {
  if (!isRecord(score)) {
    return '<section><h2>Project Intelligence</h2><p class="muted">No understanding score is available yet.</p></section>';
  }
  const overallScore = recordNumber(score, 'overall_score');
  const band = typeof score.score_band === 'string' ? score.score_band : scoreBand(overallScore);
  const unknowns = asStringArray(score.top_unknowns).slice(0, 6);
  const changed = isRecord(score.changed) ? score.changed : {};
  const changedLabels = [
    `${String(changed.changed_file_count ?? 0)} changed file(s)`,
    `${String(changed.changed_entity_count ?? 0)} changed entity/entities`,
    `${String(changed.stale_fact_count ?? 0)} stale fact candidate(s)`,
    `${String(changed.scan_efficiency_score ?? 0)}/100 scan efficiency`,
  ];
  return `<section class="intelligence-summary">
    <h2>Project Intelligence</h2>
    <div class="scoreline">
      <article class="card scorecard" data-search="${htmlEscape(
        `understanding score ${overallScore} ${band}`,
      )}">
        <p class="muted">Understanding Score</p>
        <p class="score">${overallScore}</p>
        <p>${htmlEscape(band)}</p>
      </article>
      <article class="card" data-kind="unknown" data-search="${htmlEscape(
        `top unknowns ${unknowns.join(' ')}`,
      )}">
        <h3>Top Unknowns</h3>
        ${renderList(unknowns)}
      </article>
      <article class="card" data-search="${htmlEscape(`changed ${changedLabels.join(' ')}`)}">
        <h3>What Changed</h3>
        ${renderList(changedLabels)}
      </article>
    </div>
    <div class="grid">${renderDimensionCards(score)}</div>
    <h3>Read First</h3>
    <div class="grid">${renderReadFirstPointers(score)}</div>
  </section>`;
}

function renderEvidenceIndex(evidence: readonly BrainEntity[]): string {
  if (evidence.length === 0) return '<p class="muted">No evidence records detected yet.</p>';
  return evidence
    .map((entity) => {
      const path = stringData(entity, 'path') ?? entity.name;
      const kind = stringData(entity, 'kind') ?? 'evidence';
      const hash = stringData(entity, 'hash')?.slice(0, 12) ?? '';
      const size = numberData(entity, 'size');
      return `<article class="card compact" id="${htmlEscape(fragmentId(entity.id))}" data-search="${htmlEscape(
        `${entity.id} ${path} ${kind} ${hash}`,
      )}">
        <div class="badge">${htmlEscape(entity.confidence)} · ${htmlEscape(kind)}</div>
        <h3>${htmlEscape(path)}</h3>
        <p class="muted">Explain this: <code>rizz explain ${htmlEscape(path)}</code></p>
        <p class="muted">${htmlEscape(entity.id)}</p>
        <p>hash: <code>${htmlEscape(hash)}</code>${size === undefined ? '' : ` · size: ${size}`}</p>
      </article>`;
    })
    .join('');
}

function renderReport(params: {
  readonly projectName: string;
  readonly latest: Record<string, unknown>;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
  readonly packageManager: string;
  readonly stack: readonly string[];
}): string {
  const evidenceById = new Map(params.buckets.evidence.map((entity) => [entity.id, entity]));
  const commands = params.buckets.commands
    .map((command) => `${command.name}: ${String(command.data?.command ?? '')}`)
    .filter((line) => line.trim() !== '');
  const testCommands = commands.filter((command) => command.toLowerCase().includes('test'));
  const recommendedActions = Array.isArray(params.latest.latest_recommended_next_actions)
    ? params.latest.latest_recommended_next_actions.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const openQuestions = Array.isArray(params.latest.latest_open_questions)
    ? params.latest.latest_open_questions.filter((item): item is string => typeof item === 'string')
    : [];
  const confidenceGaps = Array.isArray(params.latest.latest_confidence_gaps)
    ? params.latest.latest_confidence_gaps.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const unknownCount =
    openQuestions.length +
    confidenceGaps.length +
    params.buckets.components.filter((component) => component.confidence !== 'verified').length;
  const generatedAt = String(params.latest.generated_at ?? 'unknown');
  const incrementalUpdate = isRecord(params.latest.latest_incremental_update)
    ? params.latest.latest_incremental_update
    : {};
  const changedUnderstanding =
    typeof incrementalUpdate.changed_entity_count === 'number'
      ? incrementalUpdate.changed_entity_count
      : 0;
  const scanEfficiency =
    typeof incrementalUpdate.scan_efficiency_score === 'number'
      ? incrementalUpdate.scan_efficiency_score
      : 0;
  const understandingScore = isRecord(params.latest.latest_understanding_score)
    ? params.latest.latest_understanding_score
    : {};
  const overallUnderstanding = recordNumber(understandingScore, 'overall_score');
  const understandingPosture = qualityBandFromScore(overallUnderstanding);
  const evidenceQuality = evidenceQualityMetric(params.latest.latest_evidence_quality);
  const reviewReadiness = reviewReadinessMetric(understandingScore);
  const unknownRisk = unknownRiskMetric(unknownCount);
  const componentObject = renderObjectDetails({
    title: 'Components',
    summary:
      'Product and code boundaries reconstructed from manifests, source files, imports, tests, and local evidence.',
    count: params.buckets.components.length,
    posture: params.buckets.components.length === 0 ? 'weak' : 'usable',
    body: `<div class="grid">${renderComponentCards(params.buckets.components, evidenceById)}</div>`,
  });
  const flowObject = renderObjectDetails({
    title: 'Flows',
    summary:
      'Static local flow maps. Use them for review orientation, then confirm important paths in source.',
    count: params.buckets.flows.length,
    posture: params.buckets.flows.length === 0 ? 'weak' : 'usable',
    body: `<div class="grid">${renderFlowCards(params.buckets.flows, evidenceById)}</div>`,
  });
  const architectureObject = renderObjectDetails({
    title: 'Architecture',
    summary:
      'Reasoning from relationships, component pressure, coupling, boundaries, and evidence gaps.',
    posture: understandingPosture,
    body: `<p>${htmlEscape(String(params.latest.latest_architecture_summary ?? ''))}</p>
      ${renderArchitectureReasoning(params.latest.latest_architecture_reasoning)}`,
  });
  const reviewObject = renderObjectDetails({
    title: 'Review Blast Radius',
    summary: 'Latest review posture from the current git diff and project brain.',
    posture: reviewReadiness.posture,
    body: `${renderLatestReview(params.latest)}
      <h3>Risk Areas</h3>
      <div class="grid">${renderRiskCards(params.buckets.risks, evidenceById)}</div>`,
  });
  const evidenceObject = renderObjectDetails({
    title: 'Evidence',
    summary: 'Raw local evidence records and artifact paths. Keep these links visible for audit.',
    count: params.buckets.evidence.length,
    posture: evidenceQuality.posture,
    body: `<h3>Quality</h3>
      ${renderEvidenceQuality(params.latest.latest_evidence_quality)}
      <h3>Raw Artifacts</h3>
      ${renderArtifactLinks()}
      <h3>Evidence Records</h3>
      <div class="grid">${renderEvidenceIndex(params.buckets.evidence)}</div>`,
  });
  const unknownObject = renderObjectDetails({
    title: 'Unknowns',
    summary: 'Open questions and low-confidence areas. Weak data stays visible as weak data.',
    count: unknownCount,
    posture: unknownRisk.posture,
    body: `<div class="grid">${renderUnknowns({
      latest: params.latest,
      components: params.buckets.components,
    })}</div>`,
  });
  const readFirstObject = renderObjectDetails({
    title: 'Read First',
    summary: 'Smallest useful entry points before changing or reviewing the project.',
    body: `<h2>Start Here</h2>
      <div class="grid">${renderReadFirstPointers(understandingScore)}</div>
      <h3>Entry Points</h3>
      <div class="grid">${renderStartHere(params.buckets.components, evidenceById)}</div>
      <h3>Recommended Next Actions</h3>
      ${renderList(recommendedActions.slice(0, 5))}`,
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mission Control · ${htmlEscape(params.projectName)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #101114; --panel: #17191f; --text: #f2efe7; --muted: #aaa59a; --line: #30333b; --accent: #e3b341; --ok: #5fb3a1; --warn: #fbbf24; --danger: #d98a7a; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1120px; margin: 0 auto; padding: 28px 18px 56px; }
    header { border-bottom: 1px solid var(--line); margin-bottom: 24px; padding-bottom: 18px; }
    h1 { font-size: 34px; margin: 0 0 8px; letter-spacing: 0; }
    h2 { margin-top: 28px; }
    h3 { margin-bottom: 8px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 22px 0; }
    .metric, .card, details { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .metric.strong { border-color: color-mix(in srgb, var(--ok) 55%, var(--line)); }
    .metric.usable { border-color: color-mix(in srgb, var(--warn) 55%, var(--line)); }
    .metric.weak { border-color: color-mix(in srgb, var(--danger) 55%, var(--line)); }
    .metric-label { color: var(--muted); margin: 0 0 8px; }
    .metric-value { font-size: 42px; line-height: 1; margin: 0; font-weight: 750; }
    .metric-posture { margin: 8px 0; text-transform: lowercase; color: var(--accent); }
    .compact { padding: 12px; }
    .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; color: var(--accent); padding: 2px 8px; font-size: 12px; }
    .badge.warn { color: var(--warn); }
    .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .objects { display: grid; gap: 12px; margin-top: 18px; }
    .object { padding: 0; overflow: hidden; }
    .object > summary { display: flex; justify-content: space-between; gap: 12px; padding: 16px; cursor: pointer; font-weight: 750; }
    .object > summary::-webkit-details-marker { display: none; }
    .object > summary::before { content: "+"; color: var(--accent); margin-right: 8px; }
    .object[open] > summary::before { content: "-"; }
    .object > :not(summary) { margin-left: 16px; margin-right: 16px; }
    .object > :last-child { margin-bottom: 16px; }
    .summary-meta { display: flex; gap: 8px; color: var(--muted); font-weight: 500; }
    .muted { color: var(--muted); }
    .evidence-block { border-left: 2px solid var(--line); margin-top: 8px; padding-left: 10px; }
    .evidence-links { padding-left: 18px; }
    .artifact-links { columns: 2; }
    a { color: var(--accent); overflow-wrap: anywhere; }
    h4 { margin: 16px 0 6px; }
    code { background: #05070a; border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; }
    summary { cursor: pointer; font-weight: 700; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
    @media (max-width: 900px) { .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .artifact-links { columns: 1; } }
    @media (max-width: 560px) { main { padding: 20px 12px 48px; } h1 { font-size: 28px; } .metrics { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; } .metric-value { font-size: 36px; } }
    @media print { body { background: #fff; color: #000; } .card, details, .metric { break-inside: avoid; border-color: #999; } a { color: #000; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="badge">local project intelligence</p>
      <h1>Mission Control · ${htmlEscape(params.projectName)}</h1>
      <p class="muted">Static local view generated from <code>.rizz/brain</code>. No server. No network. No model call.</p>
      <p>${htmlEscape(String(params.latest.latest_architecture_summary ?? ''))}</p>
      <p class="muted">Generated ${htmlEscape(generatedAt)} · Project Intelligence Store · <code>.rizz/brain/latest.json</code> · <code>.rizz/reports/index.html</code></p>
      <div class="metrics" aria-label="Mission Control scorecard">
        ${metricCard({
          label: 'Understanding Score',
          value: `${overallUnderstanding}/100`,
          posture: understandingPosture,
          summary: metricSummaryFromScore(overallUnderstanding),
        })}
        ${metricCard({
          label: 'Evidence Quality',
          value: `${evidenceQuality.value}/100`,
          posture: evidenceQuality.posture,
          summary: metricSummaryFromScore(evidenceQuality.value),
        })}
        ${metricCard({
          label: 'Review Readiness',
          value: `${reviewReadiness.value}/100`,
          posture: reviewReadiness.posture,
          summary: metricSummaryFromScore(reviewReadiness.value),
        })}
        ${metricCard({
          label: 'Unknown Risk',
          value: unknownRisk.value,
          posture: unknownRisk.posture,
          summary:
            unknownCount === 0
              ? 'No open unknowns recorded.'
              : 'Open unknowns need source confirmation.',
        })}
      </div>
      <div class="stats">
        <span class="badge">${params.buckets.components.length} components</span>
        <span class="badge">${params.buckets.flows.length} flows</span>
        <span class="badge warn">${params.buckets.risks.length} risks</span>
        <span class="badge warn">${unknownCount} unknowns</span>
        <span class="badge">${params.buckets.evidence.length} evidence records</span>
        <span class="badge">${params.relationships.length} relationships</span>
        <span class="badge">${changedUnderstanding} changed understanding</span>
        <span class="badge">${scanEfficiency}/100 scan efficiency</span>
      </div>
    </header>
    <section class="objects" aria-label="Mission Control objects">
      ${componentObject}
      ${flowObject}
      ${architectureObject}
      ${reviewObject}
      ${evidenceObject}
      ${unknownObject}
      ${readFirstObject}
    </section>
    <details class="object">
      <summary><span>Runbook</span><span class="summary-meta"><span>local</span></span></summary>
      <h3>Overview</h3>
      <div class="grid">
        <article class="card"><h3>Tech Stack</h3>${renderList(params.stack)}</article>
        <article class="card"><h3>Package Manager</h3><p>${htmlEscape(params.packageManager)}</p></article>
        <article class="card"><h3>Relationships</h3><p>${params.relationships.length}</p></article>
      </div>
      <h3>How To Run Locally</h3>
      ${renderList(commands)}
      <h3>How To Test</h3>
      ${renderList(testCommands)}
      <h3>Incremental Understanding</h3>
      ${renderIncrementalUnderstanding(params.latest.latest_incremental_update)}
      <h3>Dependency Graph</h3>
      <table id="relationships"><thead><tr><th>From</th><th>Relation</th><th>To</th><th>Confidence</th><th>Evidence</th></tr></thead><tbody>
        ${params.relationships
          .map(
            (rel) =>
              `<tr data-search="${htmlEscape(
                `${rel.from} ${rel.relation} ${rel.to} ${rel.confidence}`,
              )}" data-kind="relationship" data-confidence="${htmlEscape(rel.confidence)}"><td>${htmlEscape(rel.from)}</td><td>${htmlEscape(rel.relation)}</td><td>${htmlEscape(rel.to)}</td><td>${htmlEscape(rel.confidence)}</td><td>${renderEvidenceLinks(rel.evidence_ids, evidenceById)}</td></tr>`,
          )
          .join('')}
      </tbody></table>
      <h3>Configuration & Environment</h3>
      <div class="grid">${renderEntityCards(params.buckets.configs)}</div>
      <h3>Confidence Guide</h3>
      <div class="grid">
        <article class="card"><h3>strong</h3><p>Direct evidence is good enough for review orientation.</p></article>
        <article class="card"><h3>usable</h3><p>Useful for navigation; confirm before relying on it.</p></article>
        <article class="card"><h3>weak</h3><p>Incomplete or unsupported. Treat as a queue for evidence work.</p></article>
      </div>
    </details>
  </main>
</body>
</html>
`;
}

async function writeEntityFile(
  entitiesDir: string,
  fileName: string,
  entityType: EntityType,
  generatedAt: string,
  entities: readonly BrainEntity[],
): Promise<void> {
  await writeVerifiedFile(
    join(entitiesDir, fileName),
    jsonString(
      safeBrainValue({
        generated_at: generatedAt,
        entity_type: entityType,
        entities: sorted(entities, (entity) => entity.id),
      }),
    ),
  );
}

function addRelation(
  relationships: BrainRelationship[],
  from: string,
  relation: BrainRelationship['relation'],
  to: string,
  evidenceIds: readonly string[],
  confidence: Confidence = 'verified',
): void {
  relationships.push({ from, relation, to, evidence_ids: unique(evidenceIds), confidence });
}

function buildBrain(params: {
  readonly rootDir: string;
  readonly projectName: string;
  readonly now: string;
  readonly files: readonly FileFact[];
  readonly previousFiles: ReadonlyMap<string, PreviousFileFact>;
  readonly previousFlows: ReadonlyMap<string, BrainEntity>;
  readonly packageFacts: readonly PackageJsonFact[];
}): {
  readonly buckets: BrainBuckets;
  readonly relationships: BrainRelationship[];
  readonly stack: readonly string[];
  readonly packageManager: string;
  readonly changedFiles: readonly string[];
  readonly staleFiles: readonly string[];
} {
  const buckets = emptyBuckets();
  const relationships: BrainRelationship[] = [];
  const projectId = entityId('project', params.projectName);
  const packageManager = detectPackageManager(params.files);
  const stack = detectTechStack(params.files, params.packageFacts);
  const currentPaths = new Set(params.files.map((file) => sensitiveIdentityKey(file.relativePath)));
  const changedFiles: string[] = [];
  const staleFiles: string[] = [];
  const inferredComponentPaths = componentPaths(params.files);

  buckets.projects.push(
    makeEntity({
      id: projectId,
      type: 'project',
      name: params.projectName,
      description: `Project brain for ${params.projectName}.`,
      now: params.now,
      confidence: 'verified',
      data: { rootDir: params.rootDir, packageManager, techStack: stack },
    }),
  );

  for (const file of params.files) {
    const pathKey = sensitiveIdentityKey(file.relativePath);
    const previous = params.previousFiles.get(pathKey);
    const status: LatestStatus =
      previous === undefined ? 'new' : previous.hash === file.hash ? 'current' : 'changed';
    if (status === 'changed' || status === 'new') changedFiles.push(file.relativePath);
    const fileId = entityId('file', file.relativePath);
    const evId = evidenceId(file.relativePath);
    buckets.evidence.push(
      makeEntity({
        id: evId,
        type: 'evidence',
        name: safeText(file.relativePath),
        description: `File evidence from ${safeText(file.relativePath)}.`,
        now: params.now,
        ...(previous !== undefined ? { createdAt: previous.createdAt } : {}),
        confidence: 'verified',
        sourceFiles: [file.relativePath],
        data: {
          path_key: pathKey,
          kind: classifySourceKind(file),
          path: file.relativePath,
          hash: file.hash,
          size: file.size,
        },
      }),
    );
    buckets.files.push(
      makeEntity({
        id: fileId,
        type: 'file',
        name: safeText(file.relativePath),
        description: `${classifySourceKind(file)} file at ${safeText(file.relativePath)}.`,
        now: params.now,
        ...(previous !== undefined ? { createdAt: previous.createdAt } : {}),
        evidenceIds: [evId],
        sourceFiles: [file.relativePath],
        latestStatus: status,
        data: {
          path_key: pathKey,
          relativePath: file.relativePath,
          extension: file.extension,
          size: file.size,
          hash: file.hash,
        },
      }),
    );
    const parentFolder = dirname(file.relativePath).split(sep).join('/');
    const folderId = entityId('folder', parentFolder === '.' ? '.' : parentFolder);
    addRelation(relationships, folderId, 'owns', fileId, [evId]);
  }

  for (const [previousPathKey, previous] of params.previousFiles.entries()) {
    if (currentPaths.has(previousPathKey)) continue;
    staleFiles.push(previous.relativePath);
    buckets.files.push(
      makeEntity({
        id: previous.id,
        type: 'file',
        name: safeText(previous.relativePath),
        description: `Previously known file ${safeText(previous.relativePath)} was not found in this scan.`,
        now: params.now,
        createdAt: previous.createdAt,
        confidence: 'verified',
        sourceFiles: [previous.relativePath],
        latestStatus: 'stale',
        data: { relativePath: previous.relativePath, hash: previous.hash },
      }),
    );
  }

  for (const folder of folderPaths(params.files)) {
    const folderId = entityId('folder', folder);
    const sourceFiles = params.files
      .filter((file) => folder === '.' || file.relativePath.startsWith(`${folder}/`))
      .map((file) => file.relativePath);
    buckets.folders.push(
      makeEntity({
        id: folderId,
        type: 'folder',
        name: safeText(folder),
        description:
          folder === '.' ? 'Project root folder.' : `Folder inferred from ${safeText(folder)}.`,
        now: params.now,
        confidence: 'verified',
        sourceFiles,
        data: { path: folder, fileCount: sourceFiles.length },
      }),
    );
    if (folder !== '.') addRelation(relationships, projectId, 'owns', folderId, [], 'verified');
  }

  for (const componentPath of inferredComponentPaths) {
    const componentFiles = filesForComponent(params.files, componentPath);
    const sourceFiles = componentFiles.map((file) => file.relativePath);
    const intelligence = inferComponentIntelligence(
      params.rootDir,
      componentPath,
      componentFiles,
      params.packageFacts,
      inferredComponentPaths,
    );
    const componentId = entityId('component', componentPath);
    const componentEvidenceIds = sourceFiles.slice(0, 12).map(evidenceId);
    const componentConfidence = confidenceForComponent(intelligence);
    const knownFileSet = new Set(sourceFiles);
    buckets.components.push(
      makeEntity({
        id: componentId,
        type: 'component',
        name: safeText(componentPath),
        description: intelligence.purpose,
        now: params.now,
        confidence: componentConfidence,
        evidenceIds: componentEvidenceIds,
        sourceFiles,
        data: { ...intelligence },
      }),
    );
    addRelation(
      relationships,
      projectId,
      'owns',
      componentId,
      componentEvidenceIds,
      componentConfidence,
    );
    for (const file of componentFiles.slice(0, 20)) {
      addRelation(relationships, componentId, 'owns', entityId('file', file.relativePath), [
        evidenceId(file.relativePath),
      ]);
    }
    for (const dependency of intelligence.dependencies) {
      addRelation(
        relationships,
        componentId,
        'depends_on',
        entityId('dependency', dependency),
        componentEvidenceIds,
        'inferred',
      );
    }
    for (const importedComponentId of intelligence.coupling.internal_imports) {
      addRelation(
        relationships,
        componentId,
        'imports',
        importedComponentId,
        intelligence.field_evidence.coupling ?? componentEvidenceIds,
        'inferred',
      );
    }
    for (const configPath of intelligence.configs) {
      addRelation(relationships, componentId, 'configures', entityId('config', configPath), [
        evidenceId(configPath),
      ]);
    }
    for (const testPath of intelligence.tests) {
      addRelation(relationships, entityId('test', testPath), 'tests', componentId, [
        evidenceId(testPath),
      ]);
    }
    for (const exposedApi of intelligence.exposed_apis) {
      const sourceFile = sourceFileFromSignal(exposedApi, knownFileSet);
      const apiId = entityId('api', `${componentPath}:${exposedApi}`);
      buckets.apis.push(
        makeEntity({
          id: apiId,
          type: 'api',
          name: exposedApi,
          description: `Exposed API or module surface inferred for ${safeText(componentPath)}.`,
          now: params.now,
          confidence: 'inferred',
          evidenceIds: sourceFile === undefined ? componentEvidenceIds : [evidenceId(sourceFile)],
          sourceFiles: sourceFile === undefined ? [] : [sourceFile],
          relatedEntityIds: [componentId],
        }),
      );
      addRelation(
        relationships,
        componentId,
        'exposes',
        apiId,
        sourceFile === undefined ? componentEvidenceIds : [evidenceId(sourceFile)],
        'inferred',
      );
    }
  }

  for (const config of configFiles(params.files)) {
    const configId = entityId('config', config.relativePath);
    buckets.configs.push(
      makeEntity({
        id: configId,
        type: 'config',
        name: safeText(config.relativePath),
        description: `Configuration artifact detected at ${safeText(config.relativePath)}.`,
        now: params.now,
        confidence: 'verified',
        evidenceIds: [evidenceId(config.relativePath)],
        sourceFiles: [config.relativePath],
      }),
    );
    addRelation(relationships, projectId, 'configures', configId, [
      evidenceId(config.relativePath),
    ]);
  }

  for (const pkg of params.packageFacts) {
    const pkgEvidence = evidenceId(pkg.relativePath);
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const depId = entityId('dependency', name);
      buckets.dependencies.push(
        makeEntity({
          id: depId,
          type: 'dependency',
          name: safeText(name),
          description: `Dependency ${safeText(name)} declared in ${safeText(pkg.relativePath)}.`,
          now: params.now,
          confidence: 'verified',
          evidenceIds: [pkgEvidence],
          sourceFiles: [pkg.relativePath],
          data: { version, manifest: pkg.relativePath },
        }),
      );
      addRelation(relationships, projectId, 'depends_on', depId, [pkgEvidence]);
    }
    for (const [scriptName, command] of Object.entries(pkg.scripts)) {
      const commandId = entityId('command', `${pkg.relativePath}:${scriptName}`);
      const safeCommand = safeText(command);
      buckets.commands.push(
        makeEntity({
          id: commandId,
          type: 'command',
          name: safeText(scriptName),
          description: `Command ${safeText(scriptName)} from ${safeText(pkg.relativePath)}.`,
          now: params.now,
          confidence: 'verified',
          evidenceIds: [pkgEvidence],
          sourceFiles: [pkg.relativePath],
          data: {
            command: safeCommand,
            manifest: pkg.relativePath,
            redacted: safeCommand !== command,
          },
        }),
      );
      addRelation(relationships, projectId, 'exposes', commandId, [pkgEvidence]);
    }
  }

  for (const test of testFiles(params.files)) {
    const testId = entityId('test', test.relativePath);
    buckets.tests.push(
      makeEntity({
        id: testId,
        type: 'test',
        name: test.relativePath,
        description: `Test artifact detected at ${test.relativePath}.`,
        now: params.now,
        confidence: 'verified',
        evidenceIds: [evidenceId(test.relativePath)],
        sourceFiles: [test.relativePath],
      }),
    );
    addRelation(relationships, testId, 'tests', projectId, [evidenceId(test.relativePath)]);
  }

  reconstructFlows({
    rootDir: params.rootDir,
    now: params.now,
    files: params.files,
    packageFacts: params.packageFacts,
    buckets,
    relationships,
    changedFiles,
    previousFlows: params.previousFlows,
  });

  if (!buckets.commands.some((command) => command.name.includes('test'))) {
    buckets.risks.push(
      makeEntity({
        id: entityId('risk', 'missing-test-command'),
        type: 'risk',
        name: 'missing test command',
        description: 'No test command was detected in package manifests.',
        now: params.now,
        confidence: 'inferred',
        latestStatus: 'open',
      }),
    );
  }
  if (staleFiles.length > 0) {
    buckets.risks.push(
      makeEntity({
        id: entityId('risk', 'stale-brain-facts'),
        type: 'risk',
        name: 'stale brain facts',
        description: `${staleFiles.length} previously known file(s) are no longer present.`,
        now: params.now,
        confidence: 'verified',
        sourceFiles: staleFiles,
        latestStatus: 'open',
      }),
    );
  }

  buckets.agents.push(
    makeEntity({
      id: entityId('agent', 'rizz-brain-scanner'),
      type: 'agent',
      name: 'rizz brain scanner',
      description:
        'Deterministic local scanner that produces the project brain without model calls.',
      now: params.now,
      confidence: 'verified',
    }),
  );
  buckets.sessions.push(
    makeEntity({
      id: entityId('session', params.now),
      type: 'session',
      name: `brain scan ${params.now}`,
      description: `Scanned ${params.files.length} file(s) and refreshed latest project state.`,
      now: params.now,
      confidence: 'verified',
      relatedEntityIds: [projectId, entityId('agent', 'rizz-brain-scanner')],
      latestStatus: 'completed',
      data: { changedFiles, staleFiles },
    }),
  );
  buckets.status.push(
    makeEntity({
      id: entityId('status', 'latest'),
      type: 'status',
      name: 'latest project state',
      description: `Latest scan completed with ${changedFiles.length} changed/new file(s) and ${staleFiles.length} stale file(s).`,
      now: params.now,
      confidence: 'verified',
      relatedEntityIds: [projectId],
      data: { changedFiles, staleFiles, scannedFiles: params.files.length },
    }),
  );

  return { buckets, relationships, stack, packageManager, changedFiles, staleFiles };
}

export async function generateProjectBrain(
  options: GenerateProjectBrainOptions,
): Promise<GenerateProjectBrainResult> {
  try {
    const rootDir = options.rootDir;
    const now = (options.now ?? new Date()).toISOString();
    const projectName = basename(rootDir);
    const brainDir = join(rootDir, '.rizz', 'brain');
    const entitiesDir = join(brainDir, 'entities');
    const flowDir = join(brainDir, 'flows');
    const snapshotsDir = join(brainDir, 'snapshots');
    const researchDir = join(rootDir, '.rizz', 'research');
    const reportsDir = join(rootDir, '.rizz', 'reports');
    await mkdir(entitiesDir, { recursive: true });
    await mkdir(snapshotsDir, { recursive: true });
    await mkdir(researchDir, { recursive: true });
    await mkdir(reportsDir, { recursive: true });

    const previous = await readJsonFile<{ readonly entities?: readonly BrainEntity[] }>(
      join(entitiesDir, 'files.json'),
    );
    const previousFlowFile = await readJsonFile<{ readonly entities?: readonly BrainEntity[] }>(
      join(entitiesDir, 'flows.json'),
    );
    const previousUnderstanding = await readPreviousUnderstandingState(
      entitiesDir,
      join(brainDir, 'graph.json'),
    );
    const ignorePatterns = await readRizzIgnore(rootDir);
    const previousFiles = previousFileFacts(previous?.entities);
    const previousFlows = previousEntityMap(previousFlowFile?.entities);
    for (const relativePath of previousFiles.keys()) {
      if (shouldSkipRelativePath(relativePath, ignorePatterns)) previousFiles.delete(relativePath);
    }
    const files = await scanFiles(rootDir, options.maxFiles ?? 5_000, ignorePatterns);
    const packageFacts = await readPackageJsonFacts(rootDir, files);
    const built = buildBrain({
      rootDir,
      projectName,
      now,
      files,
      previousFiles,
      previousFlows,
      packageFacts,
    });
    const graph = {
      generated_at: now,
      relationships: sorted(built.relationships, (rel) => `${rel.from}:${rel.relation}:${rel.to}`),
    };
    const incrementalMetrics = buildIncrementalUnderstandingMetrics({
      now,
      files,
      buckets: built.buckets,
      relationships: graph.relationships,
      changedFiles: built.changedFiles,
      staleFiles: built.staleFiles,
      previous: previousUnderstanding,
    });
    const latest = buildLatest({
      projectName,
      now,
      stack: built.stack,
      packageManager: built.packageManager,
      buckets: built.buckets,
      relationships: graph.relationships,
      changedFiles: built.changedFiles,
      staleFiles: built.staleFiles,
      incrementalMetrics,
    });
    const index = {
      generated_at: now,
      project_id: entityId('project', projectName),
      project_name: projectName,
      summary: latest.latest_architecture_summary,
      brain_version: 1,
      entity_counts: Object.fromEntries(
        ENTITY_FILES.map(([bucket, , entityType]) => [entityType, built.buckets[bucket].length]),
      ),
      latest_path: '.rizz/brain/latest.json',
      graph_path: '.rizz/brain/graph.json',
      flow_index_path: '.rizz/brain/flows/index.json',
      report_path: '.rizz/reports/index.html',
      research_paths: {
        metrics: '.rizz/research/metrics.json',
        coverage: '.rizz/research/coverage.json',
        confidence: '.rizz/research/confidence.json',
        reasoning_traces: '.rizz/research/reasoning_traces.json',
        component_intelligence: '.rizz/research/component_intelligence.json',
        evidence_quality: '.rizz/research/evidence_quality.json',
        incremental_update: '.rizz/research/incremental_update.json',
        flow_understanding: '.rizz/research/flow_understanding.json',
        flow_coverage: '.rizz/research/flow_coverage.json',
        flow_confidence: '.rizz/research/flow_confidence.json',
        architecture_reasoning: '.rizz/research/architecture_reasoning.json',
        benchmark_ready: '.rizz/research/benchmark_ready.json',
        understanding_score: '.rizz/research/understanding_score.json',
      },
    };
    const researchArtifacts = buildResearchArtifacts({
      projectName,
      now,
      files,
      buckets: built.buckets,
      relationships: graph.relationships,
      stack: built.stack,
      packageManager: built.packageManager,
      changedFiles: built.changedFiles,
      staleFiles: built.staleFiles,
      incrementalMetrics,
    });
    const report = renderReport({
      projectName,
      latest,
      buckets: built.buckets,
      relationships: graph.relationships,
      packageManager: built.packageManager,
      stack: built.stack,
    });
    const changelogPath = join(brainDir, 'changelog.json');
    const existingChangelog = await readJsonFile<{
      readonly entries?: readonly Record<string, unknown>[];
    }>(changelogPath);
    const changelog = {
      entries: [
        ...(existingChangelog?.entries ?? []),
        {
          at: now,
          scanned_files: files.length,
          changed_files: built.changedFiles,
          stale_files: built.staleFiles,
          summary: latest.latest_architecture_summary,
        },
      ],
    };
    const snapshotName = `${now.replace(/:/g, '-')}.json`;
    const snapshot = { index, latest, graph };

    await writeVerifiedFile(join(brainDir, 'index.json'), jsonString(safeBrainValue(index)));
    await writeVerifiedFile(join(brainDir, 'graph.json'), jsonString(safeBrainValue(graph)));
    await writeVerifiedFile(join(brainDir, 'latest.json'), jsonString(safeBrainValue(latest)));
    await writeVerifiedFile(changelogPath, jsonString(safeBrainValue(changelog)));
    await writeVerifiedFile(join(snapshotsDir, snapshotName), jsonString(safeBrainValue(snapshot)));
    for (const [bucket, fileName, entityType] of ENTITY_FILES) {
      await writeEntityFile(entitiesDir, fileName, entityType, now, built.buckets[bucket]);
    }
    await writeFlowMirrors(flowDir, now, built.buckets.flows);
    await writeResearchArtifacts(researchDir, researchArtifacts);
    await writeVerifiedFile(join(reportsDir, 'index.html'), report);

    return {
      ok: true,
      value: {
        rootDir,
        brainDir,
        researchDir,
        latestPath: join(brainDir, 'latest.json'),
        reportPath: join(reportsDir, 'index.html'),
        scannedFiles: files.length,
        changedFiles: built.changedFiles.length,
        staleFiles: built.staleFiles.length,
        components: built.buckets.components.length,
        flows: built.buckets.flows.length,
        commands: built.buckets.commands.length,
        tests: built.buckets.tests.length,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'BRAIN_GENERATION_FAILED', message } };
  }
}

export async function hasProjectBrain(rootDir: string): Promise<boolean> {
  return exists(join(rootDir, '.rizz', 'brain', 'latest.json'));
}

export async function reviewProjectChanges(
  options: ReviewProjectChangesOptions,
): Promise<ReviewProjectChangesResult> {
  try {
    const rootDir = options.rootDir;
    if (!(await hasProjectBrain(rootDir))) {
      const generated = await generateProjectBrain({
        rootDir,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      if (!generated.ok) return generated;
    }

    const brainDir = join(rootDir, '.rizz', 'brain');
    const entitiesDir = join(brainDir, 'entities');
    const reportsDir = join(rootDir, '.rizz', 'reports');
    await mkdir(entitiesDir, { recursive: true });
    await mkdir(reportsDir, { recursive: true });

    const schemaErrors = await validateBrainSchema(rootDir);
    if (schemaErrors.length > 0) {
      return {
        ok: false,
        error: {
          code: 'BRAIN_SCHEMA_INVALID',
          message: schemaErrors.slice(0, 4).join('; '),
        },
      };
    }

    const now = (options.now ?? new Date()).toISOString();
    const latestPath = join(brainDir, 'latest.json');
    const graphPath = join(brainDir, 'graph.json');
    const latest = (await readJsonFile<Record<string, unknown>>(latestPath)) ?? {};
    const graph =
      (await readJsonFile<{ readonly relationships?: readonly BrainRelationship[] }>(graphPath)) ??
      {};
    const entitySets = await readReviewEntitySets(entitiesDir);
    const gitChanges = readGitChanges(rootDir);
    if (!gitChanges.ok) return { ok: false, error: gitChanges.error };

    const review = buildReview({
      rootDir,
      now,
      latest,
      relationships: graph.relationships ?? [],
      entitySets,
      changedFiles: gitChanges.value.changedFiles,
      diffText: gitChanges.value.diffText,
    });

    const reviewEntity = makeEntity({
      id: review.id,
      type: 'review',
      name: `git diff review ${now}`,
      description: `Review produced ${review.findings.length} finding(s), overall risk ${review.overall_risk}.`,
      now,
      confidence: review.findings.length === 0 ? 'verified' : 'inferred',
      evidenceIds: review.findings.flatMap((finding) => finding.evidence_ids),
      relatedEntityIds: review.affected_entities,
      sourceFiles: review.changed_files,
      latestStatus: 'completed',
      data: review as unknown as Record<string, unknown>,
    });
    const findingEntities = review.findings.map((finding) =>
      makeEntity({
        id: finding.id,
        type: 'finding',
        name: finding.title,
        description: finding.description,
        now,
        confidence: finding.confidence,
        evidenceIds: finding.evidence_ids,
        relatedEntityIds: finding.affected_entities,
        sourceFiles: finding.affected_files,
        latestStatus: review.recommended_action === 'approve' ? 'completed' : 'open',
        data: finding as unknown as Record<string, unknown>,
      }),
    );

    const existingReviews = await readEntityFile(entitiesDir, 'reviews.json');
    const existingFindings = await readEntityFile(entitiesDir, 'findings.json');
    await writeEntityFile(entitiesDir, 'reviews.json', 'review', now, [
      ...dropEntityById(existingReviews, reviewEntity.id),
      reviewEntity,
    ]);
    await writeEntityFile(entitiesDir, 'findings.json', 'finding', now, [
      ...dropEntitiesByIds(existingFindings, new Set(findingEntities.map((finding) => finding.id))),
      ...findingEntities,
    ]);

    const updatedLatest = {
      ...latest,
      generated_at: now,
      latest_review_status: {
        status: review.recommended_action,
        review_id: review.id,
        overall_risk: review.overall_risk,
        surgicality_score: review.surgicality_score,
        blast_radius: review.blast_radius,
        blast_radius_reasons: review.blast_radius_reasons,
        findings: review.findings.length,
        changed_files: review.changed_files,
        direct_affected_components: review.direct_affected_components.map(
          (component) => component.id,
        ),
        dependent_components: review.dependent_components.map((component) => component.id),
        affected_flows: review.affected_flows.map((flow) => flow.id),
        review_evidence_summary: review.review_evidence_summary,
      },
      latest_risks: mergeLatestRisks(latest.latest_risks, review.findings),
      latest_open_questions: mergeStrings(latest.latest_open_questions, [
        ...review.findings
          .filter((finding) => finding.confidence !== 'verified')
          .map((finding) => `Review uncertainty: ${finding.title}`),
      ]),
      latest_recommended_next_actions: mergeStrings(latest.latest_recommended_next_actions, [
        ...review.required_tests.map((command) => `Run ${command}`),
        `Reviewer focus: ${review.suggested_reviewer_focus_areas.join(', ')}`,
      ]),
      project_state: {
        ...(isRecord(latest.project_state) ? latest.project_state : {}),
        last_reviewed_files: review.changed_files,
        last_reviewed_flows: review.affected_flows.map((flow) => flow.id),
        last_review_risk: review.overall_risk,
      },
    };
    await writeVerifiedFile(latestPath, jsonString(safeBrainValue(updatedLatest)));

    const reviewReport = renderReviewReport(review);
    const reportPath = join(reportsDir, 'review.html');
    await writeVerifiedFile(reportPath, reviewReport);

    return {
      ok: true,
      value: {
        rootDir,
        reviewPath: join(entitiesDir, 'reviews.json'),
        latestPath,
        reportPath,
        changedFiles: review.changed_files.length,
        affectedComponents: review.affected_components.length,
        affectedFlows: review.affected_flows.length,
        findings: review.findings.length,
        overallRisk: review.overall_risk,
        surgicalityScore: review.surgicality_score,
        blastRadius: review.blast_radius,
        recommendedAction: review.recommended_action,
        review,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'REVIEW_FAILED', message } };
  }
}

export async function explainProjectTarget(
  options: ExplainProjectTargetOptions,
): Promise<ExplainProjectTargetResult> {
  try {
    const rootDir = options.rootDir;
    if (!(await hasProjectBrain(rootDir))) {
      return {
        ok: false,
        error: {
          code: 'BRAIN_MISSING',
          message: 'Project brain not found. Run rizz brain, then rerun rizz explain.',
        },
      };
    }

    const schemaErrors = await validateBrainSchema(rootDir);
    if (schemaErrors.length > 0) {
      return {
        ok: false,
        error: {
          code: 'BRAIN_SCHEMA_INVALID',
          message: `${schemaErrors.slice(0, 4).join('; ')}. Run rizz brain to refresh.`,
        },
      };
    }

    const brainDir = join(rootDir, '.rizz', 'brain');
    const entitiesDir = join(brainDir, 'entities');

    const latestPath = join(brainDir, 'latest.json');
    const graphPath = join(brainDir, 'graph.json');
    const latest = (await readJsonFile<Record<string, unknown>>(latestPath)) ?? {};
    const graph =
      (await readJsonFile<{ readonly relationships?: readonly BrainRelationship[] }>(graphPath)) ??
      {};
    const entitySets = await readExplainEntitySets(entitiesDir);
    const explainableEntities = [
      ...entitySets.components,
      ...entitySets.flows,
      ...entitySets.files,
      ...entitySets.folders,
    ];
    const resolved = resolveExplainTarget(options.target, explainableEntities);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const now = (options.now ?? new Date()).toISOString();
    const explanation = buildExplanation({
      now,
      query: options.target,
      target: resolved.value,
      latest,
      relationships: graph.relationships ?? [],
      entitySets,
    });
    const reportsDir = join(rootDir, '.rizz', 'reports');
    await mkdir(reportsDir, { recursive: true });
    const reportPath = join(reportsDir, 'explain.html');
    await writeVerifiedFile(reportPath, renderExplainReport(explanation, entitySets.evidence));

    return {
      ok: true,
      value: {
        rootDir,
        latestPath,
        reportPath,
        targetId: explanation.resolved_entity_id,
        confidence: explanation.confidence,
        explanation,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'EXPLAIN_FAILED', message } };
  }
}

async function readExplainEntitySets(entitiesDir: string): Promise<{
  readonly files: readonly BrainEntity[];
  readonly folders: readonly BrainEntity[];
  readonly components: readonly BrainEntity[];
  readonly flows: readonly BrainEntity[];
  readonly configs: readonly BrainEntity[];
  readonly commands: readonly BrainEntity[];
  readonly tests: readonly BrainEntity[];
  readonly dependencies: readonly BrainEntity[];
  readonly risks: readonly BrainEntity[];
  readonly evidence: readonly BrainEntity[];
}> {
  const [
    files,
    folders,
    components,
    flows,
    configs,
    commands,
    tests,
    dependencies,
    risks,
    evidence,
  ] = await Promise.all([
    readEntityFile(entitiesDir, 'files.json'),
    readEntityFile(entitiesDir, 'folders.json'),
    readEntityFile(entitiesDir, 'components.json'),
    readEntityFile(entitiesDir, 'flows.json'),
    readEntityFile(entitiesDir, 'configs.json'),
    readEntityFile(entitiesDir, 'commands.json'),
    readEntityFile(entitiesDir, 'tests.json'),
    readEntityFile(entitiesDir, 'dependencies.json'),
    readEntityFile(entitiesDir, 'risks.json'),
    readEntityFile(entitiesDir, 'evidence.json'),
  ]);
  return {
    files,
    folders,
    components,
    flows,
    configs,
    commands,
    tests,
    dependencies,
    risks,
    evidence,
  };
}

function resolveExplainTarget(
  target: string,
  entities: readonly BrainEntity[],
):
  | { readonly ok: true; readonly value: BrainEntity }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const query = normalizeExplainQuery(target);
  if (query === '') {
    return {
      ok: false,
      error: {
        code: 'EXPLAIN_TARGET_REQUIRED',
        message: 'Usage: rizz explain <component-or-file>',
      },
    };
  }

  const scored = entities
    .map((entity) => ({ entity, score: explainMatchScore(query, entity) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id));
  if (scored.length === 0) {
    return {
      ok: false,
      error: {
        code: 'EXPLAIN_TARGET_NOT_FOUND',
        message: `Could not resolve "${safeText(target)}" from the project brain. Run rizz brain if the repo changed.`,
      },
    };
  }

  const bestScore = scored[0]?.score ?? 0;
  const best = scored.filter((match) => match.score === bestScore).slice(0, 8);
  if (best.length > 1) {
    const candidates = best.map((match) => `${match.entity.id} (${match.entity.name})`).join(', ');
    return {
      ok: false,
      error: {
        code: 'EXPLAIN_TARGET_AMBIGUOUS',
        message: `Target "${safeText(target)}" is ambiguous. Try one of: ${safeText(candidates)}`,
      },
    };
  }

  const resolved = scored[0];
  if (resolved === undefined) {
    return {
      ok: false,
      error: {
        code: 'EXPLAIN_TARGET_NOT_FOUND',
        message: `Could not resolve "${safeText(target)}" from the project brain.`,
      },
    };
  }
  return { ok: true, value: resolved.entity };
}

function normalizeExplainQuery(value: string): string {
  const cleaned = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '');
  const classification = classifySensitivePath(cleaned);
  return (classification.isSensitive ? classification.redactedId : cleaned).toLowerCase();
}

function explainMatchScore(query: string, entity: BrainEntity): number {
  const name = normalizeExplainQuery(entity.name);
  const id = normalizeExplainQuery(entity.id);
  const relativePath = normalizeExplainQuery(stringData(entity, 'relativePath') ?? '');
  const sources = entity.source_files.map(normalizeExplainQuery);
  const slug = stableSlug(query);
  const typeBonus = entity.type === 'component' ? 5 : entity.type === 'folder' ? 4 : 3;

  if (id === query || id === `${entity.type}:${slug}`) return 100 + typeBonus;
  if (name === query || relativePath === query) return 90 + typeBonus;
  if (sources.includes(query)) return 85 + typeBonus;
  if (name.endsWith(`/${query}`) || relativePath.endsWith(`/${query}`)) return 75 + typeBonus;
  if (
    id.includes(query) ||
    id.includes(slug) ||
    name.includes(query) ||
    relativePath.includes(query)
  ) {
    return 50 + typeBonus;
  }
  if (sources.some((source) => source.includes(query))) return 45 + typeBonus;
  return 0;
}

function buildExplanation(params: {
  readonly now: string;
  readonly query: string;
  readonly target: BrainEntity;
  readonly latest: Record<string, unknown>;
  readonly relationships: readonly BrainRelationship[];
  readonly entitySets: Awaited<ReturnType<typeof readExplainEntitySets>>;
}): ExplainSummaryData {
  const target = params.target;
  if (target.type === 'flow') return buildFlowExplanation(params);

  const relatedComponents = relatedComponentContext(target, params.entitySets.components);
  const primaryComponent = target.type === 'component' ? target : relatedComponents[0];
  const relationshipContext = explainRelationshipContext(target, params.relationships);
  const componentData = primaryComponent?.data ?? {};
  const targetData = target.data ?? {};
  const purpose =
    stringData(target, 'purpose') ??
    (typeof componentData.purpose === 'string' ? componentData.purpose : undefined) ??
    target.description;
  const responsibilities = explainArray(
    targetData.responsibilities,
    componentData.responsibilities,
  );
  const dependencies = unique([
    ...explainArray(targetData.dependencies, componentData.dependencies),
    ...relationshipContext.dependsOn,
  ]);
  const dependencyRoles = explainArray(targetData.dependency_roles, componentData.dependency_roles);
  const consumers = unique([
    ...explainArray(targetData.consumers, componentData.consumers),
    ...relationshipContext.dependedOnBy,
  ]);
  const importantFiles = unique([
    ...explainArray(targetData.important_files, componentData.important_files),
    ...target.source_files,
  ]).slice(0, 12);
  const entryPoints = explainArray(targetData.entry_points, componentData.entry_points).slice(
    0,
    12,
  );
  const tests = unique([
    ...explainArray(targetData.tests, componentData.tests),
    ...relatedTestPaths(target, params.entitySets.tests),
  ]);
  const configs = unique([
    ...explainArray(targetData.configs, componentData.configs),
    ...relatedConfigPaths(target, params.entitySets.configs),
  ]);
  const breaksIfChanged = unique([
    ...explainArray(targetData.what_breaks_if_removed, componentData.what_breaks_if_removed),
    ...relationshipContext.dependedOnBy.map((item) => `Dependent entity may need review: ${item}.`),
  ]);
  const tradeoffs = explainArray(targetData.tradeoffs, componentData.tradeoffs);
  const failureModes = explainArray(targetData.failure_modes, componentData.failure_modes);
  const risks = unique([
    ...explainArray(targetData.known_risks, componentData.known_risks),
    ...failureModes,
    ...relatedRisks(target, relatedComponents, params.entitySets.risks),
  ]);
  const readFirst = unique([
    ...explainArray(targetData.read_first, componentData.read_first),
    ...entryPoints,
    ...importantFiles,
    ...target.source_files,
  ]).slice(0, 8);
  const evidenceIds = unique([
    ...target.evidence_ids,
    ...(primaryComponent?.evidence_ids ?? []),
    ...relationshipContext.evidenceIds,
  ]);
  const confidence = weakestConfidence([
    target.confidence,
    ...(primaryComponent === undefined ? [] : [primaryComponent.confidence]),
  ]);
  const unknowns = explainUnknowns({
    target,
    confidence,
    responsibilities,
    dependencies,
    consumers,
    tests,
    risks,
    latest: params.latest,
  });
  const componentCriticalityScore =
    primaryComponent === undefined ? undefined : numberData(primaryComponent, 'criticality_score');

  return {
    generated_at: params.now,
    target: safeText(params.query),
    resolved_entity_id: safeText(target.id),
    entity_type: target.type,
    summary: safeText(target.description),
    purpose: safeText(purpose),
    responsibilities: responsibilities.map(safeText),
    dependencies: dependencies.map(safeText),
    dependency_roles: dependencyRoles.map(safeText),
    consumers: consumers.map(safeText),
    important_files: importantFiles.map(safeText),
    entry_points: entryPoints.map(safeText),
    tests: tests.map(safeText),
    configs: configs.map(safeText),
    tradeoffs: tradeoffs.map(safeText),
    failure_modes: failureModes.map(safeText),
    breaks_if_changed: breaksIfChanged.map(safeText),
    risks: risks.map(safeText),
    read_first: readFirst.map(safeText),
    evidence_ids: evidenceIds.map(safeText),
    depends_on: relationshipContext.dependsOn.map(safeText),
    depended_on_by: relationshipContext.dependedOnBy.map(safeText),
    confidence,
    unknowns: unique([
      ...unknowns,
      ...explainArray(targetData.unknowns, componentData.unknowns),
    ]).map(safeText),
    ...(primaryComponent !== undefined
      ? {
          component: {
            boundary_type: safeText(stringData(primaryComponent, 'boundary_type') ?? 'unknown'),
            criticality: safeText(stringData(primaryComponent, 'criticality') ?? 'unknown'),
            ...(componentCriticalityScore !== undefined
              ? { criticality_score: componentCriticalityScore }
              : {}),
            ...(isRecord(primaryComponent.data?.ownership_confidence)
              ? {
                  ownership_confidence: primaryComponent.data.ownership_confidence as {
                    readonly score?: number;
                    readonly reason?: string;
                    readonly signals?: readonly string[];
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function buildFlowExplanation(params: {
  readonly now: string;
  readonly query: string;
  readonly target: BrainEntity;
  readonly latest: Record<string, unknown>;
  readonly relationships: readonly BrainRelationship[];
  readonly entitySets: Awaited<ReturnType<typeof readExplainEntitySets>>;
}): ExplainSummaryData {
  const target = params.target;
  const relationshipContext = explainRelationshipContext(target, params.relationships);
  const entrypoints = safeFlowEntrypoints(target);
  const steps = safeFlowSteps(target);
  const flowRisksForTarget = safeFlowRisks(target);
  const components = flowStringArray(target, 'components').map(safeText);
  const files = unique([...flowStringArray(target, 'files'), ...target.source_files]).map(safeText);
  const dependencies = flowStringArray(target, 'dependencies').map(safeText);
  const configs = flowStringArray(target, 'configs').map(safeText);
  const tests = flowStringArray(target, 'tests').map(safeText);
  const entryContract = flowStringArray(target, 'entry_contract').map(safeText);
  const exitContract = flowStringArray(target, 'exit_contract').map(safeText);
  const inputs = flowStringArray(target, 'inputs').map(safeText);
  const outputs = flowStringArray(target, 'outputs').map(safeText);
  const sideEffects = flowStringArray(target, 'side_effects').map(safeText);
  const stateTransitions = flowStringArray(target, 'state_transitions').map(safeText);
  const contractFailureModes = flowStringArray(target, 'failure_modes').map(safeText);
  const requiredTests = flowStringArray(target, 'required_tests').map(safeText);
  const confidenceReasons = flowStringArray(target, 'confidence_reasons').map(safeText);
  const framework = stringData(target, 'framework');
  const routePath = stringData(target, 'route_path');
  const routeType = stringData(target, 'route_type');
  const entrypointLabels = entrypoints.map(formatFlowEntrypoint);
  const stepLabels = steps.map(formatFlowStep);
  const riskLabels = flowRisksForTarget.map(formatFlowRisk);
  const confidenceScore = asFlowConfidenceScore(target);
  const confidenceReason = safeText(flowConfidenceReason(target));
  const evidenceIds = unique([
    ...target.evidence_ids,
    ...entrypoints.flatMap((entrypoint) => entrypoint.evidence),
    ...steps.flatMap((step) => step.evidence),
    ...flowRisksForTarget.flatMap((risk) => risk.evidence),
    ...relationshipContext.evidenceIds,
  ]).map(safeText);
  const flowUnknowns = unique([
    ...stringArrayData(target, 'unknowns'),
    ...(target.latest_status === 'stale'
      ? ['Brain marks this flow stale. Run rizz brain before relying on it.']
      : []),
    ...(target.confidence === 'verified' ? [] : [`Flow confidence reason: ${confidenceReason}`]),
    ...explainUnknowns({
      target,
      confidence: target.confidence,
      responsibilities: stepLabels,
      dependencies,
      consumers: relationshipContext.dependedOnBy,
      tests,
      risks: riskLabels,
      latest: params.latest,
    }),
  ]);
  const readFirst = unique([
    ...entrypoints.map((entrypoint) => entrypoint.path),
    ...steps.map((step) => step.path),
    ...files,
  ]).slice(0, 10);

  return {
    generated_at: params.now,
    target: safeText(params.query),
    resolved_entity_id: safeText(target.id),
    entity_type: target.type,
    summary: safeText(target.description),
    purpose: `${safeText(target.name)} is a ${flowKind(
      target,
    )} flow reconstructed from local static evidence. It is not a runtime trace.`,
    responsibilities: unique([
      `Connects ${entrypoints.length} entrypoint(s) to ${steps.length} evidence-backed step(s).`,
      `Covers ${components.length} component(s), ${files.length} file(s), ${tests.length} test artifact(s), and ${configs.length} config artifact(s).`,
      ...entryContract.slice(0, 4),
      ...stepLabels.slice(0, 6),
    ]).map(safeText),
    dependencies,
    dependency_roles: [],
    consumers: relationshipContext.dependedOnBy.map(safeText),
    important_files: files.slice(0, 12),
    entry_points: entrypointLabels.map(safeText),
    tests,
    configs,
    tradeoffs: [
      'Flow maps are deterministic static reconstructions, so they improve orientation without proving runtime reachability.',
      ...(components.length > 1
        ? [
            'Cross-component flows improve traceability but deserve extra review when shared boundaries move.',
          ]
        : []),
    ].map(safeText),
    failure_modes: unique([
      ...(entrypoints.length === 0 ? ['No flow entrypoint was recorded.'] : []),
      ...(steps.length === 0 ? ['No flow steps were reconstructed.'] : []),
      ...(tests.length === 0 ? ['No directly linked tests were detected for this flow.'] : []),
      ...(configs.length === 0 ? ['No directly linked configs were detected for this flow.'] : []),
      ...contractFailureModes,
      ...riskLabels,
    ]).map(safeText),
    breaks_if_changed: [
      `Review this flow when any mapped file changes: ${files.slice(0, 8).join(', ') || 'none recorded'}.`,
      ...relationshipContext.dependedOnBy.map(
        (item) => `Dependent entity may need review: ${item}.`,
      ),
    ].map(safeText),
    risks: riskLabels.map(safeText),
    read_first: readFirst.map(safeText),
    evidence_ids: evidenceIds,
    depends_on: relationshipContext.dependsOn.map(safeText),
    depended_on_by: relationshipContext.dependedOnBy.map(safeText),
    confidence: target.confidence,
    unknowns: flowUnknowns.map(safeText),
    flow: {
      kind: flowKind(target),
      ...(framework !== undefined ? { framework: safeText(framework) } : {}),
      ...(routePath !== undefined ? { route_path: safeText(routePath) } : {}),
      ...(routeType !== undefined ? { route_type: safeText(routeType) } : {}),
      entrypoints,
      steps,
      components,
      files,
      dependencies,
      tests,
      configs,
      risks: flowRisksForTarget,
      entry_contract: entryContract,
      exit_contract: exitContract,
      inputs,
      outputs,
      side_effects: sideEffects,
      state_transitions: stateTransitions,
      failure_modes: contractFailureModes,
      required_tests: requiredTests,
      confidence_reasons: confidenceReasons,
      confidence_score: confidenceScore,
      confidence_reason: confidenceReason,
    },
  };
}

function formatFlowEntrypoint(entrypoint: FlowEntrypoint): string {
  const symbol = entrypoint.symbol === null ? '' : `#${entrypoint.symbol}`;
  const component =
    entrypoint.component_id === undefined || entrypoint.component_id === null
      ? ''
      : ` -> ${entrypoint.component_id}`;
  return `${entrypoint.type}: ${entrypoint.path}${symbol}${component}`;
}

function formatFlowStep(step: FlowStep): string {
  return `${step.order}. ${step.type}: ${step.path} - ${step.description}`;
}

function formatFlowRisk(risk: FlowRisk): string {
  return `${risk.kind}: ${risk.description}`;
}

function explainArray(...values: readonly unknown[]): string[] {
  return unique(values.flatMap(asStringArray));
}

function relatedComponentContext(
  target: BrainEntity,
  components: readonly BrainEntity[],
): readonly BrainEntity[] {
  if (target.type === 'component') return [target];
  const relativePath = stringData(target, 'relativePath') ?? target.name;
  const sourceFiles = new Set([relativePath, ...target.source_files]);
  return components.filter((component) =>
    component.source_files.some((file) => {
      if (sourceFiles.has(file)) return true;
      if (target.type === 'folder') return file.startsWith(`${target.name}/`);
      return false;
    }),
  );
}

function explainRelationshipContext(
  target: BrainEntity,
  relationships: readonly BrainRelationship[],
): {
  readonly dependsOn: readonly string[];
  readonly dependedOnBy: readonly string[];
  readonly evidenceIds: readonly string[];
} {
  const dependencyRelations = new Set(['depends_on', 'calls', 'imports', 'configures']);
  const outbound = relationships.filter(
    (rel) => rel.from === target.id && dependencyRelations.has(rel.relation),
  );
  const inbound = relationships.filter(
    (rel) => rel.to === target.id && dependencyRelations.has(rel.relation),
  );
  return {
    dependsOn: unique(outbound.map((rel) => `${rel.relation}: ${rel.to}`)),
    dependedOnBy: unique(inbound.map((rel) => `${rel.relation}: ${rel.from}`)),
    evidenceIds: unique([...outbound, ...inbound].flatMap((rel) => rel.evidence_ids)),
  };
}

function relatedTestPaths(target: BrainEntity, tests: readonly BrainEntity[]): string[] {
  const sourceFiles = new Set(target.source_files);
  return tests
    .filter((test) => test.source_files.some((file) => sourceFiles.has(file)))
    .flatMap((test) => test.source_files);
}

function relatedConfigPaths(target: BrainEntity, configs: readonly BrainEntity[]): string[] {
  const sourceFiles = new Set(target.source_files);
  return configs
    .filter((config) => config.source_files.some((file) => sourceFiles.has(file)))
    .flatMap((config) => config.source_files);
}

function relatedRisks(
  target: BrainEntity,
  components: readonly BrainEntity[],
  risks: readonly BrainEntity[],
): string[] {
  const relatedIds = new Set([target.id, ...components.map((component) => component.id)]);
  const sourceFiles = new Set([
    ...target.source_files,
    ...components.flatMap((item) => item.source_files),
  ]);
  return risks
    .filter(
      (risk) =>
        risk.related_entity_ids.some((id) => relatedIds.has(id)) ||
        risk.source_files.some((file) => sourceFiles.has(file)),
    )
    .map((risk) => risk.description);
}

function weakestConfidence(confidences: readonly Confidence[]): Confidence {
  if (confidences.includes('uncertain')) return 'uncertain';
  if (confidences.includes('inferred')) return 'inferred';
  return 'verified';
}

function explainUnknowns(params: {
  readonly target: BrainEntity;
  readonly confidence: Confidence;
  readonly responsibilities: readonly string[];
  readonly dependencies: readonly string[];
  readonly consumers: readonly string[];
  readonly tests: readonly string[];
  readonly risks: readonly string[];
  readonly latest: Record<string, unknown>;
}): string[] {
  const unknowns: string[] = [];
  if (params.confidence !== 'verified') {
    unknowns.push(
      `Target confidence is ${params.confidence}; confirm with source evidence before relying on it.`,
    );
  }
  if (params.target.latest_status === 'stale')
    unknowns.push('Brain marks this target stale. Run rizz brain.');
  if (params.responsibilities.length === 0) unknowns.push('No responsibilities are recorded yet.');
  if (params.dependencies.length === 0) unknowns.push('No dependencies are recorded yet.');
  if (params.consumers.length === 0) unknowns.push('No consumers are recorded yet.');
  if (params.tests.length === 0) unknowns.push('No directly related tests are recorded yet.');
  if (params.risks.length === 0) unknowns.push('No target-specific risks are recorded yet.');
  const latestGaps = Array.isArray(params.latest.latest_confidence_gaps)
    ? params.latest.latest_confidence_gaps.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  return unique([...unknowns, ...latestGaps.slice(0, 5)]).slice(0, 10);
}

function renderExplainReport(
  explanation: ExplainSummaryData,
  evidence: readonly BrainEntity[],
): string {
  const evidenceById = new Map(evidence.map((entity) => [entity.id, entity]));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>rizz explain · ${htmlEscape(explanation.resolved_entity_id)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f1115; --panel: #171b22; --text: #f4f6fb; --muted: #a7b0c0; --line: #2b3340; --accent: #6ee7b7; --warn: #fbbf24; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
    header { border-bottom: 1px solid var(--line); margin-bottom: 24px; padding-bottom: 18px; }
    h1 { font-size: clamp(32px, 6vw, 56px); margin: 0 0 8px; letter-spacing: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; color: var(--accent); padding: 2px 8px; font-size: 12px; }
    .muted { color: var(--muted); }
    code { background: #05070a; border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
    a { color: var(--accent); overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="badge">rizz explain</p>
      <h1>${htmlEscape(explanation.resolved_entity_id)}</h1>
      <p>${htmlEscape(explanation.summary)}</p>
      <p class="muted">${htmlEscape(explanation.entity_type)} · ${htmlEscape(explanation.confidence)} · latest explain report · generated ${htmlEscape(explanation.generated_at)}</p>
    </header>
    <section class="card"><h2>What This Is</h2><p>${htmlEscape(explanation.purpose)}</p></section>
    <section class="grid">
	      <article class="card"><h2>Responsibilities</h2>${renderList(explanation.responsibilities)}</article>
	      <article class="card"><h2>Entry Points</h2>${renderList(explanation.entry_points)}</article>
	      ${renderComponentExplanationCards(explanation)}
	      ${renderFlowExplanationCards(explanation)}
	      <article class="card"><h2>Important Files</h2>${renderList(explanation.important_files)}</article>
	      <article class="card"><h2>Dependencies</h2>${renderList(explanation.dependencies)}</article>
	      <article class="card"><h2>Dependency Roles</h2>${renderList(explanation.dependency_roles)}</article>
	      <article class="card"><h2>Consumers</h2>${renderList(explanation.consumers)}</article>
	      <article class="card"><h2>Tests</h2>${renderList(explanation.tests)}</article>
	      <article class="card"><h2>Configs</h2>${renderList(explanation.configs)}</article>
	      <article class="card"><h2>Tradeoffs</h2>${renderList(explanation.tradeoffs)}</article>
	      <article class="card"><h2>Failure Modes</h2>${renderList(explanation.failure_modes)}</article>
	      <article class="card"><h2>What Breaks If Changed</h2>${renderList(explanation.breaks_if_changed)}</article>
	      <article class="card"><h2>Risks</h2>${renderList(explanation.risks)}</article>
      <article class="card"><h2>Read First</h2>${renderList(explanation.read_first)}</article>
      <article class="card"><h2>Unknowns</h2>${renderList(explanation.unknowns)}</article>
      <article class="card"><h2>Evidence</h2>${renderEvidenceLinks(explanation.evidence_ids, evidenceById)}</article>
    </section>
  </main>
</body>
</html>
	`;
}

function renderComponentExplanationCards(explanation: ExplainSummaryData): string {
  if (explanation.component === undefined) return '';
  const details = [
    `Boundary type: ${explanation.component.boundary_type}`,
    `Criticality: ${explanation.component.criticality}`,
  ];
  if (explanation.component.criticality_score !== undefined) {
    details.push(`Criticality score: ${explanation.component.criticality_score}`);
  }
  if (explanation.component.ownership_confidence?.score !== undefined) {
    details.push(`Ownership confidence: ${explanation.component.ownership_confidence.score}`);
  }
  if (explanation.component.ownership_confidence?.reason !== undefined) {
    details.push(`Ownership basis: ${explanation.component.ownership_confidence.reason}`);
  }
  for (const signal of explanation.component.ownership_confidence?.signals ?? []) {
    details.push(`Signal: ${signal}`);
  }
  return `<article class="card"><h2>Component Boundary</h2>${renderList(details)}</article>`;
}

function renderFlowExplanationCards(explanation: ExplainSummaryData): string {
  if (explanation.flow === undefined) return '';
  return `<article class="card"><h2>Entry Contract</h2>${renderList(
    explanation.flow.entry_contract,
  )}</article>
      <article class="card"><h2>Exit Contract</h2>${renderList(
        explanation.flow.exit_contract,
      )}</article>
      <article class="card"><h2>Inputs</h2>${renderList(explanation.flow.inputs)}</article>
      <article class="card"><h2>Outputs</h2>${renderList(explanation.flow.outputs)}</article>
      <article class="card"><h2>Side Effects</h2>${renderList(
        explanation.flow.side_effects,
      )}</article>
      <article class="card"><h2>State Transitions</h2>${renderList(
        explanation.flow.state_transitions,
      )}</article>
      <article class="card"><h2>Required Tests</h2>${renderList(
        explanation.flow.required_tests,
      )}</article>
      <article class="card"><h2>Confidence Reasons</h2>${renderList(
        explanation.flow.confidence_reasons,
      )}</article>
      <article class="card"><h2>Flow Steps</h2>${renderList(
        explanation.flow.steps.map(formatFlowStep),
      )}</article>
      <article class="card"><h2>Flow Components</h2>${renderList(
        explanation.flow.components,
      )}</article>
      <article class="card"><h2>Flow Confidence</h2>${renderList([
        `${explanation.flow.confidence_score}: ${explanation.flow.confidence_reason}`,
      ])}</article>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readEntityFile(entitiesDir: string, fileName: string): Promise<readonly BrainEntity[]> {
  return readJsonFile<{ readonly entities?: readonly BrainEntity[] }>(
    join(entitiesDir, fileName),
  ).then((file) => file?.entities ?? []);
}

async function readReviewEntitySets(entitiesDir: string): Promise<{
  readonly files: readonly BrainEntity[];
  readonly components: readonly BrainEntity[];
  readonly flows: readonly BrainEntity[];
  readonly configs: readonly BrainEntity[];
  readonly commands: readonly BrainEntity[];
  readonly tests: readonly BrainEntity[];
  readonly dependencies: readonly BrainEntity[];
  readonly risks: readonly BrainEntity[];
}> {
  const [files, components, flows, configs, commands, tests, dependencies, risks] =
    await Promise.all([
      readEntityFile(entitiesDir, 'files.json'),
      readEntityFile(entitiesDir, 'components.json'),
      readEntityFile(entitiesDir, 'flows.json'),
      readEntityFile(entitiesDir, 'configs.json'),
      readEntityFile(entitiesDir, 'commands.json'),
      readEntityFile(entitiesDir, 'tests.json'),
      readEntityFile(entitiesDir, 'dependencies.json'),
      readEntityFile(entitiesDir, 'risks.json'),
    ]);
  return { files, components, flows, configs, commands, tests, dependencies, risks };
}

function dropEntityById(entities: readonly BrainEntity[], id: string): BrainEntity[] {
  return entities.filter((entity) => entity.id !== id);
}

function dropEntitiesByIds(
  entities: readonly BrainEntity[],
  ids: ReadonlySet<string>,
): BrainEntity[] {
  return entities.filter((entity) => !ids.has(entity.id));
}

function runGit(
  rootDir: string,
  args: readonly string[],
): { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly error: string } {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 5_000_000,
  });
  if (result.status === 0) return { ok: true, stdout: result.stdout };
  return { ok: false, error: result.stderr.trim() || result.stdout.trim() || 'git command failed' };
}

function readGitChanges(rootDir: string):
  | {
      readonly ok: true;
      readonly value: { readonly changedFiles: readonly string[]; readonly diffText: string };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const inside = runGit(rootDir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return {
      ok: false,
      error: { code: 'GIT_REQUIRED', message: 'rizz review needs to run inside a git worktree.' },
    };
  }

  const worktreeFiles = runGit(rootDir, ['diff', '--name-only', 'HEAD', '--']);
  if (!worktreeFiles.ok) {
    return { ok: false, error: { code: 'GIT_DIFF_FAILED', message: worktreeFiles.error } };
  }
  const untrackedFiles = runGit(rootDir, ['ls-files', '--others', '--exclude-standard']);
  const worktreeChanged = unique(
    [
      ...worktreeFiles.stdout.split(/\r?\n/),
      ...(untrackedFiles.ok ? untrackedFiles.stdout.split(/\r?\n/) : []),
    ].filter((line) => line.trim() !== ''),
  );
  if (worktreeChanged.length > 0) {
    const diff = runGit(rootDir, ['diff', '--no-ext-diff', '--find-renames', 'HEAD', '--']);
    const untrackedDiffText = untrackedFiles.ok
      ? readUntrackedFileText(rootDir, untrackedFiles.stdout)
      : '';
    return {
      ok: true,
      value: {
        changedFiles: worktreeChanged,
        diffText: `${diff.ok ? diff.stdout : ''}\n${untrackedDiffText}`,
      },
    };
  }

  const base = runGit(rootDir, ['merge-base', 'HEAD', 'origin/develop']);
  if (base.ok && base.stdout.trim() !== '') {
    const baseSha = base.stdout.trim();
    const branchFiles = runGit(rootDir, ['diff', '--name-only', baseSha, 'HEAD', '--']);
    if (!branchFiles.ok) {
      return { ok: false, error: { code: 'GIT_DIFF_FAILED', message: branchFiles.error } };
    }
    const branchChanged = unique(
      branchFiles.stdout.split(/\r?\n/).filter((line) => line.trim() !== ''),
    );
    const diff = runGit(rootDir, [
      'diff',
      '--no-ext-diff',
      '--find-renames',
      baseSha,
      'HEAD',
      '--',
    ]);
    return {
      ok: true,
      value: { changedFiles: branchChanged, diffText: diff.ok ? diff.stdout : '' },
    };
  }

  return { ok: true, value: { changedFiles: [], diffText: '' } };
}

function readUntrackedFileText(rootDir: string, stdout: string): string {
  const chunks: string[] = [];
  const files = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !shouldSkipRelativePath(line, []));
  for (const file of files) {
    try {
      const absolutePath = join(rootDir, file);
      const fileStat = statSync(absolutePath);
      if (!fileStat.isFile() || fileStat.size > 1_000_000) continue;
      chunks.push(readFileSync(absolutePath, 'utf8'));
    } catch {}
  }
  return chunks.join('\n');
}

function buildReview(params: {
  readonly rootDir: string;
  readonly now: string;
  readonly latest: Record<string, unknown>;
  readonly relationships: readonly BrainRelationship[];
  readonly entitySets: Awaited<ReturnType<typeof readReviewEntitySets>>;
  readonly changedFiles: readonly string[];
  readonly diffText: string;
}): ReviewSummaryData {
  const changedFiles = params.changedFiles.filter((file) => !shouldSkipRelativePath(file, []));
  const changedFileSet = new Set(changedFiles);
  const publicChangedFiles = changedFiles.map(safeText);
  const changedSourceFiles = changedFiles.filter((file) => isSourceFile(file));
  const changedTestFiles = changedFiles.filter((file) => isTestPath(file));
  const changedConfigFiles = changedFiles.filter((file) => isConfigPath(file));
  const changedDependencyFiles = changedFiles.filter((file) => isDependencyPath(file));
  const affectedComponents = affectedComponentEntities(changedFiles, params.entitySets.components);
  const affectedComponentIds = affectedComponents.map((component) => component.id);
  const dependentComponents = dependentComponentEntities(
    affectedComponentIds,
    params.relationships,
    params.entitySets.components,
  );
  const dependentComponentIds = dependentComponents.map((component) => component.id);
  const allAffectedComponents = uniqueEntities([...affectedComponents, ...dependentComponents]);
  const affectedFlows = affectedFlowEntities(
    changedFiles,
    allAffectedComponents,
    params.entitySets.flows,
  );
  const affectedFlowIds = affectedFlows.map((flow) => flow.id);
  const directlyAffectedEntities = unique([
    ...changedFiles.map((file) => entityId('file', file)),
    ...affectedComponentIds,
    ...affectedFlowIds,
    ...params.entitySets.configs
      .filter((config) => config.source_files.some((file) => changedFileSet.has(file)))
      .map((config) => config.id),
    ...params.entitySets.tests
      .filter((test) => test.source_files.some((file) => changedFileSet.has(file)))
      .map((test) => test.id),
  ]);
  const affectedEntitySeed = unique([
    ...directlyAffectedEntities,
    ...dependentComponentIds,
    ...affectedFlowIds,
  ]);
  const affectedRelationships = affectedReviewRelationships(
    params.relationships,
    affectedEntitySeed,
  );
  const graphAffectedEntities = unique([
    ...affectedEntitySeed,
    ...params.relationships
      .filter((rel) => affectedEntitySeed.includes(rel.from) || affectedEntitySeed.includes(rel.to))
      .flatMap((rel) => [rel.from, rel.to]),
  ]);
  const directAffectedComponentData = reviewAffectedComponents({
    components: affectedComponents,
    changedFiles,
    affectedFlows,
    relationships: params.relationships,
    reasonFor: () => 'Changed file maps directly to this component boundary.',
  });
  const dependentComponentData = reviewAffectedComponents({
    components: dependentComponents,
    changedFiles,
    affectedFlows,
    relationships: params.relationships,
    reasonFor: (component) =>
      dependentComponentReason(component.id, affectedComponentIds, params.relationships),
  });
  const affectedTests = unique([
    ...affectedFlows.flatMap((flow) => flow.tests),
    ...allAffectedComponents.flatMap((component) => stringArrayData(component, 'tests')),
    ...changedTestFiles,
  ]).map(safeText);
  const affectedConfigs = unique([
    ...affectedFlows.flatMap((flow) => flow.configs),
    ...allAffectedComponents.flatMap((component) => stringArrayData(component, 'configs')),
    ...changedConfigFiles,
    ...changedDependencyFiles,
  ]).map(safeText);
  const reviewEvidenceIds = unique([
    ...allAffectedComponents.flatMap((component) => component.evidence_ids),
    ...affectedFlows.flatMap((flow) => flow.evidence_ids),
    ...affectedRelationships.flatMap((relationship) => relationship.evidence_ids),
    ...changedFiles.map(evidenceId),
  ]).map(safeText);
  const blastRadius = classifyReviewBlastRadius({
    fileCount: changedFiles.length,
    directComponentCount: affectedComponents.length,
    dependentComponentCount: dependentComponents.length,
    flowCount: affectedFlows.length,
    relationshipCount: affectedRelationships.length,
  });
  const blastRadiusReasons = blastRadiusReasonLines({
    changedFiles,
    directComponents: affectedComponents,
    dependentComponents,
    affectedFlows,
    affectedRelationships,
    affectedTests,
    affectedConfigs,
  });

  const findings: ReviewFindingData[] = [];
  const addFinding = (
    params: Omit<ReviewFindingData, 'id' | 'evidence_ids'> & {
      readonly slug: string;
      readonly evidenceIds?: readonly string[];
    },
  ): void => {
    findings.push({
      id: entityId('finding', `review-${params.slug}-${findings.length + 1}`),
      severity: params.severity,
      category: params.category,
      title: safeText(params.title),
      description: safeText(params.description),
      affected_files: unique(params.affected_files.map(safeText)),
      affected_entities: unique(params.affected_entities.map(safeText)),
      evidence_ids: unique(params.evidenceIds ?? params.affected_files.map(evidenceId)).map(
        safeText,
      ),
      confidence: params.confidence,
      recommendation: safeText(params.recommendation),
      ...(params.safer_alternative !== undefined
        ? { safer_alternative: safeText(params.safer_alternative) }
        : {}),
    });
  };

  if (changedFiles.length === 0) {
    addFinding({
      slug: 'no-diff',
      severity: 'low',
      category: 'Correctness',
      title: 'No git diff detected',
      description: 'No working tree or branch diff was found against origin/develop.',
      affected_files: [],
      affected_entities: [],
      confidence: 'verified',
      recommendation: 'Run rizz review on a branch or with local changes before merge review.',
    });
  }

  const isBroad = changedFiles.length > 8 || affectedComponents.length > 3;
  if (isBroad || blastRadius === 'broad') {
    addFinding({
      slug: 'broad-change',
      severity:
        changedFiles.length > 20 || affectedComponents.length > 5 || dependentComponents.length > 3
          ? 'high'
          : 'medium',
      category: 'Regression risk',
      title: 'Broad change crosses multiple brain boundaries',
      description: safeText(
        `The diff touches ${changedFiles.length} file(s), ${affectedComponents.length} direct component(s), ${dependentComponents.length} dependent component(s), and ${affectedFlows.length} flow(s). ${blastRadiusReasons[0] ?? ''}`,
      ),
      affected_files: publicChangedFiles,
      affected_entities: graphAffectedEntities,
      confidence: 'inferred',
      recommendation:
        'Split unrelated changes or make the PR narrative explicitly map each touched component to test evidence.',
      safer_alternative:
        'Land mechanical/docs/config changes separately from runtime behavior changes.',
    });
  }

  if (dependentComponents.length > 0) {
    addFinding({
      slug: 'dependent-components',
      severity: dependentComponents.length > 2 ? 'medium' : 'low',
      category: 'Hidden coupling',
      title: 'Consumer components depend on changed components',
      description: safeText(
        `${dependentComponents.length} component(s) import, call, or depend on directly changed component(s): ${dependentComponents
          .map((component) => component.name)
          .slice(0, 5)
          .join(', ')}.`,
      ),
      affected_files: unique(dependentComponents.flatMap((component) => component.source_files)),
      affected_entities: unique([...affectedComponentIds, ...dependentComponentIds]),
      evidenceIds: unique(
        params.relationships
          .filter(
            (rel) =>
              dependentComponentIds.includes(rel.from) && affectedComponentIds.includes(rel.to),
          )
          .flatMap((rel) => rel.evidence_ids),
      ),
      confidence: 'inferred',
      recommendation:
        'Review changed exports/contracts against consumer components before treating this as isolated.',
    });
  }

  if (changedSourceFiles.length > 0 && changedTestFiles.length === 0) {
    addFinding({
      slug: 'missing-tests',
      severity: changedSourceFiles.length > 4 ? 'high' : 'medium',
      category: 'Missing tests',
      title: 'Runtime files changed without test artifacts in the diff',
      description: safeText(
        `${changedSourceFiles.length} source file(s) changed, but no test file changed with them. Existing linked test evidence: ${affectedTests.slice(0, 5).join(', ') || 'none detected'}.`,
      ),
      affected_files: changedSourceFiles.map(safeText),
      affected_entities: graphAffectedEntities,
      confidence: 'verified',
      recommendation:
        'Run the existing quality gate and add focused tests for the changed behavior or document why existing coverage is sufficient.',
    });
  }

  if (changedConfigFiles.length > 0 || changedDependencyFiles.length > 0) {
    addFinding({
      slug: 'config-dependency-change',
      severity: changedDependencyFiles.length > 0 ? 'medium' : 'low',
      category: changedDependencyFiles.length > 0 ? 'Backward compatibility' : 'Architecture drift',
      title: 'Configuration or dependency surface changed',
      description: 'The diff touches setup, package, build, CI, or dependency metadata.',
      affected_files: unique([...changedConfigFiles, ...changedDependencyFiles]),
      affected_entities: graphAffectedEntities,
      confidence: 'verified',
      recommendation: 'Verify install, build, and public package contents before merge.',
      safer_alternative:
        'Keep package/config movement in a separate PR unless the runtime change depends on it.',
    });
  }

  const secretRiskFiles = changedFiles.filter((file) =>
    /auth|secret|token|keychain|credential|provider|login|env/i.test(file),
  );
  if (secretRiskFiles.length > 0 || containsSecretLikeValue(params.diffText)) {
    addFinding({
      slug: 'secret-sensitive-surface',
      severity: containsSecretLikeValue(params.diffText) ? 'critical' : 'medium',
      category: 'Security',
      title: 'Security-sensitive surface changed',
      description: containsSecretLikeValue(params.diffText)
        ? 'The diff includes a secret-like string pattern and must be cleaned before merge.'
        : 'The diff touches auth, provider, keychain, credential, or environment handling.',
      affected_files:
        secretRiskFiles.length > 0 ? secretRiskFiles.map(safeText) : publicChangedFiles,
      affected_entities: graphAffectedEntities,
      confidence: containsSecretLikeValue(params.diffText) ? 'verified' : 'inferred',
      recommendation:
        'Audit redaction, storage boundaries, logs, and setup output. Never merge real keys or tokens.',
    });
  }

  if (affectedFlows.length > 0) {
    addFinding({
      slug: 'affected-flows',
      severity: affectedFlows.length > 3 ? 'medium' : 'low',
      category: 'Hidden coupling',
      title: 'Known flows overlap the diff',
      description: safeText(
        `The diff touches ${affectedFlows.length} reconstructed flow(s): ${affectedFlows
          .map((flow) => flow.name)
          .slice(0, 5)
          .join(', ')}. Linked tests/configs: ${
          unique([
            ...affectedFlows.flatMap((flow) => flow.tests),
            ...affectedFlows.flatMap((flow) => flow.configs),
          ])
            .slice(0, 6)
            .join(', ') || 'none detected'
        }.`,
      ),
      affected_files: unique(affectedFlows.flatMap((flow) => flow.changed_files)),
      affected_entities: graphAffectedEntities,
      evidenceIds: unique(affectedFlows.flatMap((flow) => flow.evidence_ids)),
      confidence: 'inferred',
      recommendation:
        'Open the affected flow explanation and verify linked tests before relying on the change.',
    });
  }

  const publicCliFiles = changedFiles.filter(
    (file) =>
      file === 'packages/cli/src/index.ts' || file === 'README.md' || file.startsWith('runbooks/'),
  );
  if (publicCliFiles.length > 0) {
    addFinding({
      slug: 'public-contract',
      severity: 'medium',
      category: 'Backward compatibility',
      title: 'Public CLI or documentation contract changed',
      description: 'The diff touches user-facing commands, docs, or install/runbook surfaces.',
      affected_files: publicCliFiles,
      affected_entities: graphAffectedEntities,
      confidence: 'verified',
      recommendation:
        'Run CLI smoke tests and verify README/runbook examples still match the shipped command behavior.',
    });
  }

  if (changedFiles.some((file) => file.includes('brain')) && affectedComponents.length > 1) {
    addFinding({
      slug: 'brain-contract-drift',
      severity: 'medium',
      category: 'Architecture drift',
      title: 'Project brain contract may be drifting across package boundaries',
      description:
        'Brain-related changes touch additional inferred components, increasing interoperability risk for future agents.',
      affected_files: changedFiles
        .filter((file) => file.includes('brain') || file.includes('cli'))
        .map(safeText),
      affected_entities: graphAffectedEntities,
      confidence: 'inferred',
      recommendation:
        'Keep the brain schema stable and update tests for latest.json, graph.json, reviews.json, and evidence records.',
    });
  }

  const overengineeringRisk = changedFiles.length > 12 && changedTestFiles.length < 2;
  if (overengineeringRisk) {
    addFinding({
      slug: 'large-low-test-diff',
      severity: 'medium',
      category: 'Overengineering',
      title: 'Large diff has little visible test movement',
      description:
        'The change may be carrying too much product surface for the amount of verification in the diff.',
      affected_files: publicChangedFiles,
      affected_entities: graphAffectedEntities,
      confidence: 'inferred',
      recommendation:
        'Cut the PR to the smallest reviewable product slice or add stronger focused tests.',
      safer_alternative: 'Ship schema/artifact writing first, then UX/reporting in the next PR.',
    });
  }

  const requiredTests = requiredTestCommands(params.entitySets.commands, changedFiles);
  const surgicalityScore = scoreSurgicality(
    changedFiles.length,
    affectedComponents.length + dependentComponents.length,
    findings,
  );
  const overallRisk = classifyOverallRisk(findings, blastRadius);
  return {
    id: entityId('review', `${params.now}-git-diff`),
    generated_at: params.now,
    changed_files: publicChangedFiles,
    direct_affected_components: directAffectedComponentData,
    dependent_components: dependentComponentData,
    affected_components: unique([...affectedComponentIds, ...dependentComponentIds]),
    affected_flows: affectedFlows,
    affected_relationships: affectedRelationships,
    affected_entities: graphAffectedEntities,
    blast_radius_reasons: blastRadiusReasons,
    review_evidence_summary: {
      changed_files: changedFiles.length,
      direct_components: affectedComponents.length,
      dependent_components: dependentComponents.length,
      affected_flows: affectedFlows.length,
      affected_tests: affectedTests,
      affected_configs: affectedConfigs,
      evidence_ids: reviewEvidenceIds.slice(0, 40),
    },
    findings,
    overall_risk: overallRisk,
    surgicality_score: surgicalityScore,
    blast_radius: blastRadius,
    required_tests: requiredTests,
    suggested_reviewer_focus_areas: suggestedFocusAreas(
      findings,
      changedFiles,
      affectedComponents,
      dependentComponents,
      affectedFlows,
      blastRadiusReasons,
    ),
    recommended_action: recommendAction(overallRisk, findings),
  };
}

function isSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php)$/.test(path) && !isTestPath(path);
}

function isTestPath(path: string): boolean {
  return /(__tests__|\.test\.|\.spec\.)/.test(path);
}

function isConfigPath(path: string): boolean {
  return (
    path.startsWith('.github/') ||
    CONFIG_FILES.has(basename(path)) ||
    /(^|\/)(Dockerfile|Makefile|.*config\.(ts|js|mjs|cjs|json|yml|yaml))$/.test(path)
  );
}

function isDependencyPath(path: string): boolean {
  return /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/.test(
    path,
  );
}

function affectedComponentEntities(
  changedFiles: readonly string[],
  components: readonly BrainEntity[],
): BrainEntity[] {
  return components.filter((component) => {
    const componentPath =
      typeof component.data?.purpose === 'string' ? component.name : component.name;
    return changedFiles.some(
      (file) => file === componentPath || file.startsWith(`${componentPath}/`),
    );
  });
}

function uniqueEntities(entities: readonly BrainEntity[]): BrainEntity[] {
  const byId = new Map<string, BrainEntity>();
  for (const entity of entities) {
    if (!byId.has(entity.id)) byId.set(entity.id, entity);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function dependentComponentEntities(
  directComponentIds: readonly string[],
  relationships: readonly BrainRelationship[],
  components: readonly BrainEntity[],
): BrainEntity[] {
  const directIds = new Set(directComponentIds);
  const componentsById = new Map(components.map((component) => [component.id, component]));
  const dependentIds = new Set<string>();
  for (const rel of relationships) {
    if (rel.relation === 'imports' || rel.relation === 'calls' || rel.relation === 'depends_on') {
      if (directIds.has(rel.to) && componentsById.has(rel.from) && !directIds.has(rel.from)) {
        dependentIds.add(rel.from);
      }
      continue;
    }
    if (rel.relation === 'used_by') {
      if (directIds.has(rel.from) && componentsById.has(rel.to) && !directIds.has(rel.to)) {
        dependentIds.add(rel.to);
      }
    }
  }
  return [...dependentIds]
    .map((id) => componentsById.get(id))
    .filter((component): component is BrainEntity => component !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function dependentComponentReason(
  componentId: string,
  directComponentIds: readonly string[],
  relationships: readonly BrainRelationship[],
): string {
  const directIds = new Set(directComponentIds);
  const reasons = relationships
    .filter((rel) => rel.from === componentId && directIds.has(rel.to))
    .map((rel) => `${componentId} ${rel.relation} ${rel.to}`);
  if (reasons.length > 0) return `Consumer relationship: ${reasons.slice(0, 3).join(', ')}.`;
  const usedByReasons = relationships
    .filter(
      (rel) => rel.relation === 'used_by' && rel.to === componentId && directIds.has(rel.from),
    )
    .map((rel) => `${rel.from} ${rel.relation} ${componentId}`);
  if (usedByReasons.length > 0) {
    return `Consumer relationship: ${usedByReasons.slice(0, 3).join(', ')}.`;
  }
  return 'Graph marks this component as a downstream consumer of the changed boundary.';
}

function affectedReviewRelationships(
  relationships: readonly BrainRelationship[],
  affectedEntityIds: readonly string[],
): ReviewAffectedRelationshipData[] {
  const affectedIds = new Set(affectedEntityIds);
  return relationships
    .filter((rel) => affectedIds.has(rel.from) || affectedIds.has(rel.to))
    .slice(0, 80)
    .map((rel) => ({
      from: safeText(rel.from),
      relation: rel.relation,
      to: safeText(rel.to),
      confidence: rel.confidence,
      evidence_ids: rel.evidence_ids.map(safeText),
    }))
    .sort((a, b) =>
      `${a.from}:${a.relation}:${a.to}`.localeCompare(`${b.from}:${b.relation}:${b.to}`),
    );
}

function reviewAffectedComponents(params: {
  readonly components: readonly BrainEntity[];
  readonly changedFiles: readonly string[];
  readonly affectedFlows: readonly AffectedFlowData[];
  readonly relationships: readonly BrainRelationship[];
  readonly reasonFor: (component: BrainEntity) => string;
}): ReviewAffectedComponentData[] {
  return params.components.map((component) => {
    const componentFiles = new Set(component.source_files);
    const componentFlows = params.affectedFlows.filter((flow) =>
      flow.components.includes(component.id),
    );
    const relationshipEvidence = params.relationships
      .filter((rel) => rel.from === component.id || rel.to === component.id)
      .flatMap((rel) => rel.evidence_ids);
    return {
      id: safeText(component.id),
      name: safeText(component.name),
      boundary_type: safeText(stringData(component, 'boundary_type') ?? 'unknown'),
      criticality: safeText(stringData(component, 'criticality') ?? 'unknown'),
      blast_radius: safeText(stringData(component, 'blast_radius') ?? 'unknown'),
      changed_files: params.changedFiles
        .filter((file) => componentFiles.has(file) || file.startsWith(`${component.name}/`))
        .map(safeText),
      affected_flows: componentFlows.map((flow) => flow.id),
      tests: unique([
        ...stringArrayData(component, 'tests'),
        ...componentFlows.flatMap((flow) => flow.tests),
      ]).map(safeText),
      configs: unique([
        ...stringArrayData(component, 'configs'),
        ...componentFlows.flatMap((flow) => flow.configs),
      ]).map(safeText),
      evidence_ids: unique([
        ...component.evidence_ids,
        ...componentFlows.flatMap((flow) => flow.evidence_ids),
        ...relationshipEvidence,
      ])
        .map(safeText)
        .slice(0, 20),
      reason: safeText(params.reasonFor(component)),
    };
  });
}

function affectedFlowEntities(
  changedFiles: readonly string[],
  affectedComponents: readonly BrainEntity[],
  flows: readonly BrainEntity[],
): AffectedFlowData[] {
  const affectedComponentIds = new Set(affectedComponents.map((component) => component.id));
  const affectedComponentFiles = new Set(
    affectedComponents.flatMap((component) => component.source_files),
  );
  const affectedFlows = flows.flatMap((flow): AffectedFlowData[] => {
    if (flow.latest_status === 'stale') return [];
    const flowFiles = unique([
      ...flowStringArray(flow, 'files'),
      ...flowStringArray(flow, 'configs'),
      ...flowStringArray(flow, 'tests'),
      ...flow.source_files,
    ]);
    const flowComponents = flowStringArray(flow, 'components');
    const directChangedFiles = changedFiles.filter((file) => flowFiles.includes(file));
    const componentChangedFiles = flowComponents.some((componentId) =>
      affectedComponentIds.has(componentId),
    )
      ? changedFiles.filter((file) => affectedComponentFiles.has(file))
      : [];
    const matchedChangedFiles = unique([...directChangedFiles, ...componentChangedFiles]);
    if (matchedChangedFiles.length === 0) return [];
    return [
      {
        id: safeText(flow.id),
        name: safeText(flow.name),
        kind: flowKind(flow),
        confidence: flow.confidence,
        score: asFlowConfidenceScore(flow),
        changed_files: matchedChangedFiles.map(safeText),
        components: flowComponents.map(safeText),
        tests: flowStringArray(flow, 'tests').map(safeText),
        configs: flowStringArray(flow, 'configs').map(safeText),
        risks: flowRisks(flow).length,
        evidence_ids: flow.evidence_ids.map(safeText),
      },
    ];
  });
  return [...affectedFlows].sort((a, b) => a.id.localeCompare(b.id));
}

function containsSecretLikeValue(value: string): boolean {
  return safeText(value) !== value;
}

function requiredTestCommands(
  commands: readonly BrainEntity[],
  changedFiles: readonly string[],
): string[] {
  const commandTexts = commands
    .map((command) => {
      const text = typeof command.data?.command === 'string' ? command.data.command : undefined;
      return text === undefined ? undefined : safeText(`${command.name}: ${text}`);
    })
    .filter((command): command is string => command !== undefined);
  const quality = commandTexts.filter((command) =>
    /test|check|lint|typecheck|vitest/i.test(command),
  );
  if (quality.length > 0) return quality.slice(0, 5);
  if (changedFiles.some(isSourceFile))
    return ['Run the project test command; none was detected in the brain.'];
  return ['Review-only change: verify docs/report output manually.'];
}

function classifyBlastRadius(fileCount: number, componentCount: number): BlastRadius {
  if (fileCount > 12 || componentCount > 4) return 'broad';
  if (fileCount > 4 || componentCount > 1) return 'moderate';
  return 'narrow';
}

function classifyReviewBlastRadius(params: {
  readonly fileCount: number;
  readonly directComponentCount: number;
  readonly dependentComponentCount: number;
  readonly flowCount: number;
  readonly relationshipCount: number;
}): BlastRadius {
  if (
    params.fileCount > 12 ||
    params.directComponentCount > 4 ||
    params.dependentComponentCount > 3 ||
    params.flowCount > 5 ||
    params.relationshipCount > 80
  ) {
    return 'broad';
  }
  if (
    params.fileCount > 4 ||
    params.directComponentCount > 1 ||
    params.dependentComponentCount > 0 ||
    params.flowCount > 1 ||
    params.relationshipCount > 40
  ) {
    return 'moderate';
  }
  return 'narrow';
}

function blastRadiusReasonLines(params: {
  readonly changedFiles: readonly string[];
  readonly directComponents: readonly BrainEntity[];
  readonly dependentComponents: readonly BrainEntity[];
  readonly affectedFlows: readonly AffectedFlowData[];
  readonly affectedRelationships: readonly ReviewAffectedRelationshipData[];
  readonly affectedTests: readonly string[];
  readonly affectedConfigs: readonly string[];
}): string[] {
  const directNames = params.directComponents.map((component) => component.name);
  const dependentNames = params.dependentComponents.map((component) => component.name);
  return [
    `${params.changedFiles.length} changed file(s) map to ${params.directComponents.length} direct component(s): ${directNames.slice(0, 5).join(', ') || 'none'}.`,
    params.dependentComponents.length === 0
      ? 'No dependent consumer components were found from import/call/dependency graph edges.'
      : `${params.dependentComponents.length} dependent consumer component(s) require review: ${dependentNames.slice(0, 5).join(', ')}.`,
    `${params.affectedFlows.length} affected flow(s) link the change to ${params.affectedTests.length} test artifact(s) and ${params.affectedConfigs.length} config artifact(s).`,
    `${params.affectedRelationships.length} graph relationship(s) touch the review blast radius.`,
  ].map(safeText);
}

function scoreSurgicality(
  fileCount: number,
  componentCount: number,
  findings: readonly ReviewFindingData[],
): number {
  const severityPenalty = findings.reduce((score, finding) => {
    if (finding.severity === 'critical') return score + 5;
    if (finding.severity === 'high') return score + 3;
    if (finding.severity === 'medium') return score + 2;
    return score + 1;
  }, 0);
  return Math.max(
    1,
    Math.min(10, 11 - Math.ceil(fileCount / 3) - componentCount - severityPenalty),
  );
}

function classifyOverallRisk(
  findings: readonly ReviewFindingData[],
  blastRadius: BlastRadius,
): OverallRisk {
  if (findings.some((finding) => finding.severity === 'critical')) return 'critical';
  if (findings.some((finding) => finding.severity === 'high')) return 'high';
  if (blastRadius === 'broad' || findings.some((finding) => finding.severity === 'medium')) {
    return 'medium';
  }
  return 'low';
}

function recommendAction(
  risk: OverallRisk,
  findings: readonly ReviewFindingData[],
): RecommendedAction {
  if (risk === 'critical' || risk === 'high') return 'request changes';
  if (findings.some((finding) => finding.category === 'Missing tests')) return 'investigate';
  if (risk === 'medium') return 'investigate';
  return 'approve';
}

function suggestedFocusAreas(
  findings: readonly ReviewFindingData[],
  changedFiles: readonly string[],
  components: readonly BrainEntity[],
  dependentComponents: readonly BrainEntity[],
  affectedFlows: readonly AffectedFlowData[],
  blastRadiusReasons: readonly string[],
): string[] {
  const categories = findings.map((finding) => finding.category);
  const componentNames = components.map((component) => component.name);
  const dependentNames = dependentComponents.map((component) => component.name);
  return unique([
    ...categories,
    ...componentNames.map((name) => `component: ${name}`),
    ...dependentNames.map((name) => `dependent component: ${name}`),
    ...affectedFlows.map((flow) => `flow: ${flow.name}`),
    ...blastRadiusReasons.slice(0, 2),
    ...(changedFiles.some(isDependencyPath) ? ['install/package behavior'] : []),
    ...(changedFiles.some(isConfigPath) ? ['configuration and CI behavior'] : []),
  ]).slice(0, 8);
}

function mergeStrings(value: unknown, additions: readonly string[]): string[] {
  return unique([...asStringArray(value), ...additions.filter((item) => item.trim() !== '')]).slice(
    0,
    20,
  );
}

function mergeLatestRisks(value: unknown, findings: readonly ReviewFindingData[]): unknown[] {
  const existing = Array.isArray(value)
    ? value.filter((item): item is unknown => item !== null)
    : [];
  const reviewRisks = findings
    .filter((finding) => finding.severity !== 'low')
    .map((finding) => ({
      id: finding.id,
      name: finding.title,
      description: finding.description,
      confidence: finding.confidence,
      evidence_ids: finding.evidence_ids,
    }));
  return [...existing, ...reviewRisks].slice(-20);
}

function renderAffectedFlowRows(flows: readonly AffectedFlowData[]): string {
  if (flows.length === 0) {
    return '<p class="muted">No reconstructed flows overlap this diff.</p>';
  }
  return `<table><thead><tr><th>Flow</th><th>Changed Files</th><th>Components</th><th>Tests</th><th>Configs</th><th>Confidence</th></tr></thead><tbody>${flows
    .map(
      (flow) => `<tr>
        <td><strong>${htmlEscape(flow.name)}</strong><br><span class="muted">${htmlEscape(flow.id)} · ${htmlEscape(flow.kind)}</span></td>
        <td>${renderList(flow.changed_files)}</td>
        <td>${renderList(flow.components)}</td>
        <td>${renderList(flow.tests)}</td>
        <td>${renderList(flow.configs)}</td>
        <td>${htmlEscape(flow.confidence)} · ${flow.score}</td>
      </tr>`,
    )
    .join('')}</tbody></table>`;
}

function renderAffectedComponentRows(
  components: readonly ReviewAffectedComponentData[],
  emptyLabel: string,
): string {
  if (components.length === 0) return `<p class="muted">${htmlEscape(emptyLabel)}</p>`;
  return `<table><thead><tr><th>Component</th><th>Reason</th><th>Files</th><th>Flows</th><th>Tests / Configs</th></tr></thead><tbody>${components
    .map(
      (component) => `<tr>
        <td><strong>${htmlEscape(component.name)}</strong><br><span class="muted">${htmlEscape(component.id)} · ${htmlEscape(component.boundary_type)} · ${htmlEscape(component.criticality)} · ${htmlEscape(component.blast_radius)} radius</span></td>
        <td>${htmlEscape(component.reason)}</td>
        <td>${renderList(component.changed_files)}</td>
        <td>${renderList(component.affected_flows)}</td>
        <td>${renderList([...component.tests, ...component.configs])}</td>
      </tr>`,
    )
    .join('')}</tbody></table>`;
}

function renderAffectedRelationshipRows(
  relationships: readonly ReviewAffectedRelationshipData[],
): string {
  if (relationships.length === 0) {
    return '<p class="muted">No graph relationships touch this review blast radius.</p>';
  }
  return `<table><thead><tr><th>From</th><th>Relation</th><th>To</th><th>Confidence</th></tr></thead><tbody>${relationships
    .slice(0, 20)
    .map(
      (relationship) => `<tr>
        <td>${htmlEscape(relationship.from)}</td>
        <td>${htmlEscape(relationship.relation)}</td>
        <td>${htmlEscape(relationship.to)}</td>
        <td>${htmlEscape(relationship.confidence)}</td>
      </tr>`,
    )
    .join('')}</tbody></table>`;
}

function renderReviewReport(review: ReviewSummaryData): string {
  const findingRows = review.findings
    .map(
      (finding) => `<tr>
        <td>${htmlEscape(finding.severity)}</td>
        <td>${htmlEscape(finding.category)}</td>
        <td><strong>${htmlEscape(finding.title)}</strong><br><span class="muted">${htmlEscape(finding.description)}</span></td>
        <td>${renderList(finding.affected_files)}</td>
        <td>${htmlEscape(finding.recommendation)}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>rizz review</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f1115; --panel: #171b22; --text: #f4f6fb; --muted: #a7b0c0; --line: #2b3340; --accent: #6ee7b7; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 64px; }
    header { border-bottom: 1px solid var(--line); margin-bottom: 24px; padding-bottom: 18px; }
    h1 { font-size: clamp(32px, 6vw, 64px); margin: 0 0 8px; letter-spacing: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; color: var(--accent); padding: 2px 8px; font-size: 12px; }
    .muted { color: var(--muted); }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; }
    ul { margin: 0; padding-left: 18px; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="badge">rizz review</p>
      <h1>${htmlEscape(review.overall_risk)} risk · ${htmlEscape(review.blast_radius)} blast radius</h1>
      <p class="muted">${htmlEscape(review.id)} · ${htmlEscape(review.generated_at)}</p>
    </header>
    <section class="grid">
      <article class="card"><h2>Action</h2><p>${htmlEscape(review.recommended_action)}</p></article>
      <article class="card"><h2>Surgicality</h2><p>${review.surgicality_score}/10</p></article>
      <article class="card"><h2>Files</h2><p>${review.changed_files.length}</p></article>
      <article class="card"><h2>Affected Flows</h2><p>${review.affected_flows.length}</p></article>
      <article class="card"><h2>Findings</h2><p>${review.findings.length}</p></article>
    </section>
    <section>
      <h2>Blast Radius Evidence</h2>
      <div class="grid">
        <article class="card"><h2>Direct Components</h2><p>${review.direct_affected_components.length}</p></article>
        <article class="card"><h2>Dependent Components</h2><p>${review.dependent_components.length}</p></article>
        <article class="card"><h2>Relationships</h2><p>${review.affected_relationships.length}</p></article>
        <article class="card"><h2>Evidence Records</h2><p>${review.review_evidence_summary.evidence_ids.length}</p></article>
      </div>
      ${renderList(review.blast_radius_reasons)}
    </section>
    <section>
      <h2>Direct Components</h2>
      ${renderAffectedComponentRows(review.direct_affected_components, 'No direct component boundary was mapped for this diff.')}
    </section>
    <section>
      <h2>Dependent Components</h2>
      ${renderAffectedComponentRows(review.dependent_components, 'No dependent consumer components were found.')}
    </section>
    <section>
      <h2>Affected Flows</h2>
      ${renderAffectedFlowRows(review.affected_flows)}
    </section>
    <section>
      <h2>Affected Relationships</h2>
      ${renderAffectedRelationshipRows(review.affected_relationships)}
    </section>
    <section>
      <h2>Required Tests</h2>
      ${renderList(review.required_tests)}
    </section>
    <section>
      <h2>Reviewer Focus</h2>
      ${renderList(review.suggested_reviewer_focus_areas)}
    </section>
    <section>
      <h2>Findings</h2>
      <table><thead><tr><th>Severity</th><th>Category</th><th>Finding</th><th>Files</th><th>Recommendation</th></tr></thead><tbody>${findingRows}</tbody></table>
    </section>
  </main>
</body>
</html>
`;
}

async function validateBrainSchema(rootDir: string): Promise<string[]> {
  const brainDir = join(rootDir, '.rizz', 'brain');
  const entitiesDir = join(brainDir, 'entities');
  const errors: string[] = [];
  const latest = await readJsonFile<unknown>(join(brainDir, 'latest.json'));
  if (!isRecord(latest)) {
    errors.push('latest.json must be an object');
  } else {
    if (typeof latest.generated_at !== 'string') errors.push('latest.json missing generated_at');
    if (!Array.isArray(latest.latest_component_map)) {
      errors.push('latest.json missing latest_component_map array');
    }
    if (!Array.isArray(latest.latest_flow_map)) {
      errors.push('latest.json missing latest_flow_map array');
    }
  }

  const graph = await readJsonFile<unknown>(join(brainDir, 'graph.json'));
  if (!isRecord(graph) || !Array.isArray(graph.relationships)) {
    errors.push('graph.json missing relationships array');
  } else {
    for (const [index, rel] of graph.relationships.entries()) {
      if (!isRecord(rel) || typeof rel.from !== 'string' || typeof rel.to !== 'string') {
        errors.push(`graph.json relationship ${index} is invalid`);
        break;
      }
    }
  }

  const flowIndex = await readJsonFile<unknown>(join(brainDir, 'flows', 'index.json'));
  if (!isRecord(flowIndex) || !Array.isArray(flowIndex.flows)) {
    errors.push('flows/index.json missing flows array');
  }

  for (const fileName of ['components.json', 'files.json', 'folders.json', 'flows.json']) {
    const path = join(entitiesDir, fileName);
    if (!(await exists(path))) {
      errors.push(`${fileName} missing entities array`);
      continue;
    }
    const file = await readJsonFile<unknown>(path);
    if (!isRecord(file) || !Array.isArray(file.entities)) {
      errors.push(`${fileName} missing entities array`);
      continue;
    }
    for (const [index, entity] of file.entities.entries()) {
      if (!isBrainEntityShape(entity)) {
        errors.push(`${fileName} entity ${index} is invalid`);
        break;
      }
    }
  }

  for (const fileName of ['evidence.json', 'reviews.json']) {
    const path = join(entitiesDir, fileName);
    if (!(await exists(path))) continue;
    const file = await readJsonFile<unknown>(path);
    if (!isRecord(file) || !Array.isArray(file.entities)) {
      errors.push(`${fileName} missing entities array`);
      continue;
    }
    for (const [index, entity] of file.entities.entries()) {
      if (!isBrainEntityShape(entity)) {
        errors.push(`${fileName} entity ${index} is invalid`);
        break;
      }
    }
  }

  return errors;
}

function isBrainEntityShape(value: unknown): value is BrainEntity {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string' &&
    (value.confidence === 'verified' ||
      value.confidence === 'inferred' ||
      value.confidence === 'uncertain') &&
    Array.isArray(value.evidence_ids) &&
    Array.isArray(value.related_entity_ids) &&
    Array.isArray(value.source_files) &&
    typeof value.latest_status === 'string'
  );
}
