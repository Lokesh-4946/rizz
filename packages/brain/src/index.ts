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

type ReasoningType = 'component' | 'flow' | 'architecture' | 'review' | 'service';

type BenchmarkTaskCategory =
  | 'component-explanation'
  | 'flow-explanation'
  | 'architecture-impact'
  | 'review-blast-radius'
  | 'evidence-unknown-coverage';

const BENCHMARK_TASK_CATEGORIES: readonly BenchmarkTaskCategory[] = [
  'component-explanation',
  'flow-explanation',
  'architecture-impact',
  'review-blast-radius',
  'evidence-unknown-coverage',
];

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

interface BenchmarkTaskEvidence {
  readonly evidence_ids: readonly string[];
  readonly redacted_evidence_markers: readonly string[];
  readonly redacted_evidence_count: number;
}

interface BenchmarkTaskCandidate {
  readonly id: string;
  readonly category: BenchmarkTaskCategory;
  readonly prompt: string;
  readonly target: {
    readonly entity_id: string;
    readonly entity_type: EntityType | 'architecture_surface' | 'coverage_surface';
    readonly name: string;
    readonly surface: string;
  };
  readonly evidence_ids: readonly string[];
  readonly redacted_evidence_markers: readonly string[];
  readonly redacted_evidence_count: number;
  readonly confidence: Confidence;
  readonly confidence_score: number;
  readonly expected_artifact: string;
  readonly expected_check_fields: readonly string[];
  readonly why_it_matters: string;
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

interface ArchitectureUnsupportedAssumption {
  readonly assumption_id: string;
  readonly entity_id: string;
  readonly reason: string;
  readonly evidence_gap_ids: readonly string[];
  readonly confidence: Confidence;
  readonly confidence_score: number;
}

interface ArchitectureInferredTradeoff {
  readonly entity_id: string;
  readonly source: 'component' | 'route';
  readonly tradeoff: string;
  readonly reason: string;
  readonly confidence: Confidence;
}

interface ArchitectureLowConfidenceArea {
  readonly area_id: string;
  readonly entity_id: string;
  readonly area_type: 'assumption' | 'boundary' | 'evidence_gap' | 'route';
  readonly reason: string;
  readonly confidence: Confidence;
  readonly confidence_score: number;
  readonly evidence_gap_ids: readonly string[];
}

interface ArchitectureConfidenceDebt {
  readonly debt_level: ArchitecturePressureStrength;
  readonly debt_count: number;
  readonly unsupported_assumption_count: number;
  readonly inferred_tradeoff_count: number;
  readonly low_confidence_area_count: number;
  readonly blocking_unknown_count: number;
  readonly unsupported_assumptions: readonly ArchitectureUnsupportedAssumption[];
  readonly inferred_tradeoffs: readonly ArchitectureInferredTradeoff[];
  readonly low_confidence_areas: readonly ArchitectureLowConfidenceArea[];
  readonly blocking_unknowns: readonly string[];
  readonly summary: string;
  readonly calibration_rule: string;
}

type ArchitectureImpactSurfaceType = 'component' | 'route';
type ArchitectureImpactRiskLevel = 'low' | 'medium' | 'high';

interface ArchitectureServiceCausalityReasoning {
  readonly total_paths: number;
  readonly affected_flows: readonly string[];
  readonly affected_services: readonly string[];
  readonly effect_count: number;
  readonly effects: readonly string[];
  readonly effect_categories: readonly string[];
  readonly route_impacts: readonly {
    readonly flow_id: string;
    readonly route_path: string;
    readonly service_id: string;
    readonly effects: readonly string[];
    readonly what_breaks: readonly string[];
    readonly evidence_ids: readonly string[];
    readonly confidence: Confidence;
  }[];
  readonly missing_effect_paths: readonly string[];
  readonly missing_step_link_paths: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly confidence_distribution: Record<Confidence, number>;
  readonly top_risky_effects: readonly string[];
  readonly unknowns: readonly string[];
  readonly calibration_rule: string;
}

interface ArchitectureImpactEntry {
  readonly impact_id: string;
  readonly surface_type: ArchitectureImpactSurfaceType;
  readonly entity_id: string;
  readonly name: string;
  readonly route_path?: string;
  readonly route_type?: string;
  readonly affected_flows: readonly string[];
  readonly affected_components: readonly string[];
  readonly affected_files: readonly string[];
  readonly affected_tests: readonly string[];
  readonly affected_configs: readonly string[];
  readonly service_causality?: readonly FlowServiceCausality[];
  readonly dependent_components: readonly string[];
  readonly coupling_level: ComponentIntelligence['coupling']['level'];
  readonly coupling_score: number;
  readonly confidence: Confidence;
  readonly confidence_score: number;
  readonly evidence_ids: readonly string[];
  readonly evidence_gap_ids: readonly string[];
  readonly what_breaks: readonly string[];
  readonly risk_reasoning: ArchitectureImpactRiskReasoning;
  readonly reasons: readonly string[];
}

interface ArchitectureImpactRiskReasoning {
  readonly risk_level: ArchitectureImpactRiskLevel;
  readonly risk_score: number;
  readonly criticality: string;
  readonly coupling_level: ComponentIntelligence['coupling']['level'];
  readonly tradeoffs: readonly string[];
  readonly risky_surfaces: readonly string[];
  readonly review_focus: readonly string[];
  readonly reasons: readonly string[];
}

interface ArchitectureImpactMap {
  readonly summary: {
    readonly total_surfaces: number;
    readonly component_surfaces: number;
    readonly route_surfaces: number;
    readonly high_coupling_surfaces: number;
    readonly test_backed_surfaces: number;
    readonly config_backed_surfaces: number;
    readonly service_causality_paths: number;
    readonly service_causality_effect_count: number;
    readonly service_causality_backed_surfaces: number;
    readonly service_causality_unknown_count: number;
    readonly top_impacted_surfaces: readonly string[];
  };
  readonly entries: readonly ArchitectureImpactEntry[];
  readonly calibration_rule: string;
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

type HttpRouteMethod = 'ALL' | 'DELETE' | 'GET' | 'HEAD' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT';

type HttpRouteFramework = 'express-fastify-http' | 'fastapi' | 'hono';

type FlowStepType =
  | 'route'
  | 'handler'
  | 'service'
  | 'function'
  | 'config'
  | 'dependency'
  | 'test'
  | 'external';

type JourneyStepType =
  | 'trigger'
  | 'validation_auth'
  | 'read_write_storage'
  | 'business_logic'
  | 'external_service_call'
  | 'rendering_response'
  | 'background_job_async'
  | 'runtime_config'
  | 'test_coverage';

type FlowRiskKind =
  | 'missing_test'
  | 'missing_config'
  | 'weak_evidence'
  | 'orphan_step'
  | 'changed_hotspot'
  | 'deployment_storage'
  | 'deployment_auth'
  | 'deployment_cors';

type FlowDataDependencyKind =
  | 'database'
  | 'cache'
  | 'filesystem'
  | 'object_storage'
  | 'vector_store'
  | 'orm'
  | 'schema'
  | 'state_module';

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

interface FlowJourneySummary {
  readonly name: string;
  readonly category: string;
  readonly confidence: Confidence;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly missing_evidence: readonly string[];
}

interface FlowJourneyStep {
  readonly step_id: string;
  readonly order: number;
  readonly type: JourneyStepType;
  readonly label: string;
  readonly description: string;
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly routes: readonly string[];
  readonly runtime_surfaces: readonly string[];
  readonly configs: readonly string[];
  readonly tests: readonly string[];
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly missing_evidence: readonly string[];
}

interface FlowServiceCausality {
  readonly service_id: string;
  readonly service_name: string;
  readonly service_root: string;
  readonly files: readonly string[];
  readonly step_ids: readonly string[];
  readonly cause: string;
  readonly effects: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly confidence: Confidence;
  readonly unknowns: readonly string[];
}

interface FlowDataDependency {
  readonly dependency_id: string;
  readonly kind: FlowDataDependencyKind;
  readonly label: string;
  readonly files: readonly string[];
  readonly operations: readonly string[];
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly missing_evidence: readonly string[];
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

interface HttpRouteDeclaration {
  readonly framework: HttpRouteFramework;
  readonly receiver: string;
  readonly method: HttpRouteMethod;
  readonly routePath: string;
  readonly line: number;
  readonly source: string;
}

interface FlowIntelligence {
  readonly flow_id: string;
  readonly name: string;
  readonly kind: FlowKind;
  readonly framework?: string;
  readonly route_path?: string;
  readonly route_type?: string;
  readonly entrypoints: readonly FlowEntrypoint[];
  readonly steps: readonly FlowStep[];
  readonly components: readonly string[];
  readonly files: readonly string[];
  readonly dependencies: readonly string[];
  readonly runtime_surfaces: readonly string[];
  readonly services?: readonly string[];
  readonly service_causality?: readonly FlowServiceCausality[];
  readonly data_dependencies?: readonly FlowDataDependency[];
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
  readonly journey?: FlowJourneySummary;
  readonly journey_steps?: readonly FlowJourneyStep[];
}

type ServiceRuntime = 'node' | 'python' | 'unknown';

interface ServiceIntelligence {
  readonly service_id: string;
  readonly name: string;
  readonly runtime: ServiceRuntime;
  readonly framework: string;
  readonly service_root: string;
  readonly files: readonly string[];
  readonly entrypoints: readonly string[];
  readonly routes: readonly string[];
  readonly jobs: readonly string[];
  readonly storage_dependencies: readonly string[];
  readonly environment_variables: readonly string[];
  readonly external_services: readonly string[];
  readonly deployment_configs: readonly string[];
  readonly related_flows: readonly string[];
  readonly related_components: readonly string[];
  readonly risks: readonly string[];
  readonly confidence: Confidence;
  readonly confidence_score: number;
  readonly evidence_ids: readonly string[];
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
  readonly service_count: number;
  readonly service_changed: number;
  readonly service_stale: number;
  readonly service_reused: number;
  readonly service_recomputed: number;
  readonly service_incremental_health: IncrementalEntityTypeHealth;
  readonly flow_count: number;
  readonly flow_changed: number;
  readonly flow_stale: number;
  readonly flow_reused: number;
  readonly flow_recomputed: number;
  readonly flow_incremental_health: IncrementalEntityTypeHealth;
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
  readonly service_causality_delta: IncrementalServiceCausalityDelta;
  readonly reused_understanding_count: number;
  readonly recomputed_understanding_count: number;
  readonly stale_fact_count: number;
  readonly stale_fact_candidates: readonly string[];
  readonly scan_efficiency_score: number;
  readonly understanding_deltas: IncrementalUnderstandingDeltas;
}

interface IncrementalEntityDelta {
  readonly id: string;
  readonly type: EntityType;
  readonly name: string;
}

interface IncrementalEntityTypeHealth {
  readonly entity_type: 'service' | 'flow';
  readonly total: number;
  readonly changed: number;
  readonly new: number;
  readonly stale: number;
  readonly reused: number;
  readonly recomputed: number;
  readonly status_counts: Readonly<Record<string, number>>;
  readonly changed_ids: readonly string[];
  readonly reused_ids: readonly string[];
  readonly recomputed_ids: readonly string[];
  readonly stale_ids: readonly string[];
  readonly source_changed_ids: readonly string[];
}

type IncrementalUnderstandingSurfaceType =
  | 'architecture'
  | 'component'
  | 'evidence'
  | 'flow'
  | 'service'
  | 'unknown';

type IncrementalUnderstandingSurfaceStatus = 'changed' | 'new' | 'stable' | 'stale';

interface IncrementalUnderstandingSurface {
  readonly surface_id: string;
  readonly surface_type: IncrementalUnderstandingSurfaceType;
  readonly name: string;
  readonly status: IncrementalUnderstandingSurfaceStatus;
  readonly previous_score: number | null;
  readonly current_score: number | null;
  readonly score_delta: number | null;
  readonly evidence_ids: readonly string[];
  readonly reasons: readonly string[];
}

interface IncrementalUnderstandingSurfaceCounts {
  readonly changed: number;
  readonly new: number;
  readonly stable: number;
  readonly stale: number;
}

interface IncrementalUnderstandingScoreDelta {
  readonly surface_id: string;
  readonly surface_type: IncrementalUnderstandingSurfaceType;
  readonly name: string;
  readonly previous_score: number;
  readonly current_score: number;
  readonly delta: number;
}

interface IncrementalUnderstandingDeltas {
  readonly schema_version: number;
  readonly previous_scan_available: boolean;
  readonly changed_surface_count: number;
  readonly new_surface_count: number;
  readonly stable_surface_count: number;
  readonly stale_surface_count: number;
  readonly changed_surfaces: readonly IncrementalUnderstandingSurface[];
  readonly new_surfaces: readonly IncrementalUnderstandingSurface[];
  readonly stable_surfaces: readonly IncrementalUnderstandingSurface[];
  readonly stale_surfaces: readonly IncrementalUnderstandingSurface[];
  readonly by_surface_type: Readonly<
    Record<IncrementalUnderstandingSurfaceType, IncrementalUnderstandingSurfaceCounts>
  >;
  readonly score_deltas: readonly IncrementalUnderstandingScoreDelta[];
  readonly summary: string;
  readonly calibration_rule: string;
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

type IncrementalServiceCausalityPathStatus = 'stable' | 'recomputed' | 'drifted' | 'new' | 'stale';

interface IncrementalServiceCausalityDelta {
  readonly schema_version: number;
  readonly previous_path_count: number;
  readonly current_path_count: number;
  readonly total_path_count: number;
  readonly stable_path_count: number;
  readonly recomputed_path_count: number;
  readonly drifted_path_count: number;
  readonly new_path_count: number;
  readonly stale_path_count: number;
  readonly evidence_changed_path_count: number;
  readonly affected_flow_count: number;
  readonly affected_service_count: number;
  readonly affected_flows: readonly string[];
  readonly affected_services: readonly string[];
  readonly changed_evidence_ids: readonly string[];
  readonly freshness_score: number;
  readonly path_deltas: readonly IncrementalServiceCausalityPathDelta[];
  readonly summary: string;
  readonly calibration_rule: string;
}

interface IncrementalServiceCausalityPathDelta {
  readonly path_id: string;
  readonly flow_id: string;
  readonly service_id: string;
  readonly service_name: string;
  readonly status: IncrementalServiceCausalityPathStatus;
  readonly previous_hash: string | null;
  readonly current_hash: string | null;
  readonly changed_files: readonly string[];
  readonly changed_evidence_ids: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly reasons: readonly string[];
}

interface ServiceCausalitySnapshot {
  readonly path_id: string;
  readonly flow_id: string;
  readonly flow_name: string;
  readonly service_id: string;
  readonly service_name: string;
  readonly files: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly semantic_hash: string;
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

const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ['low', 'medium', 'high', 'critical'];

const REVIEW_CATEGORIES: readonly ReviewCategory[] = [
  'Correctness',
  'Regression risk',
  'Architecture drift',
  'Hidden coupling',
  'Missing tests',
  'Security',
  'Performance',
  'Maintainability',
  'Backward compatibility',
  'Overengineering',
];

type OverallRisk = 'low' | 'medium' | 'high' | 'critical';

type BlastRadius = 'narrow' | 'moderate' | 'broad';

type RecommendedAction = 'approve' | 'request changes' | 'investigate';

export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'unknown';

export interface VerificationEvidenceItem {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly status: VerificationStatus;
  readonly timestamp: string;
  readonly output_summary?: string;
  readonly affected_confidence_areas: readonly string[];
}

export interface VerificationEvidenceArtifactData {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly project_name: string;
  readonly items: readonly VerificationEvidenceItem[];
  readonly status_counts: Record<VerificationStatus, number>;
  readonly local_checks_passed: readonly string[];
  readonly local_checks_failed: readonly string[];
  readonly production_checks_passed: readonly string[];
  readonly production_checks_failed: readonly string[];
  readonly risks_reduced: readonly string[];
  readonly remaining_unknowns: readonly string[];
}

interface ReviewVerificationStatusData {
  readonly artifact_path: string;
  readonly total_checks: number;
  readonly passed_checks: readonly string[];
  readonly failed_checks: readonly string[];
  readonly local_checks_passed: readonly string[];
  readonly production_checks_passed: readonly string[];
  readonly production_checks_failed: readonly string[];
  readonly risks_reduced: readonly string[];
  readonly remaining_unknowns: readonly string[];
  readonly calibration_note: string;
}

type ReviewVerificationPriority = 'required' | 'recommended' | 'optional';

type ReviewVerificationType =
  | 'test'
  | 'smoke'
  | 'contract'
  | 'data'
  | 'state'
  | 'dependency'
  | 'service-causality'
  | 'manual';

interface ReviewVerificationPlanItemData {
  readonly id: string;
  readonly priority: ReviewVerificationPriority;
  readonly verification_type: ReviewVerificationType;
  readonly reason: string;
  readonly commands: readonly string[];
  readonly manual_checks: readonly string[];
  readonly linked_findings: readonly string[];
  readonly linked_flows: readonly string[];
  readonly linked_components: readonly string[];
  readonly linked_files: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly confidence: Confidence;
}

type ReviewClaimEvidenceSurface =
  | 'blast_radius_reason'
  | 'finding'
  | 'affected_flow'
  | 'verification_plan';

interface ReviewClaimEvidenceData {
  readonly claim_id: string;
  readonly surface: ReviewClaimEvidenceSurface;
  readonly claim: string;
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly source_files: readonly string[];
  readonly affected_entities: readonly string[];
  readonly rules: readonly string[];
  readonly unknowns: readonly string[];
  readonly redacted_evidence_count: number;
}

interface ReviewArchitectureImpactClaimEvidenceData {
  readonly claim_id: string;
  readonly impact_id: string;
  readonly surface_type: ArchitectureImpactSurfaceType;
  readonly claim: string;
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly source_files: readonly string[];
  readonly affected_entities: readonly string[];
  readonly matched_components: readonly string[];
  readonly matched_flows: readonly string[];
  readonly affected_flows: readonly string[];
  readonly affected_tests: readonly string[];
  readonly affected_configs: readonly string[];
  readonly what_breaks: readonly string[];
  readonly review_focus: readonly string[];
  readonly rules: readonly string[];
  readonly unknowns: readonly string[];
  readonly redacted_evidence_count: number;
}

interface ReviewClaimEvidenceArtifactData {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly review_id: string;
  readonly basis: {
    readonly source: 'pre_change_project_brain_plus_git_diff';
    readonly description: string;
    readonly review_fields: readonly string[];
  };
  readonly changed_files: readonly string[];
  readonly deterministic: boolean;
  readonly provider_calls_required: boolean;
  readonly network_required: boolean;
  readonly total_claims: number;
  readonly architecture_impact_claim_count: number;
  readonly claim_counts: {
    readonly total: number;
    readonly generic_claims: number;
    readonly architecture_impact_claims: number;
    readonly with_evidence: number;
    readonly without_evidence: number;
  };
  readonly claims_by_surface: Record<ReviewClaimEvidenceSurface, number>;
  readonly claims_by_confidence: Record<Confidence, number>;
  readonly redacted_evidence_count: number;
  readonly secret_safety: {
    readonly redacted_reference_count: number;
    readonly unsafe_sensitive_reference_count: number;
    readonly output_secret_safe: boolean;
  };
  readonly claims: readonly ReviewClaimEvidenceData[];
  readonly architecture_impact_claims: readonly ReviewArchitectureImpactClaimEvidenceData[];
}

interface ReviewEvalArtifactData {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly review_id: string;
  readonly deterministic: boolean;
  readonly provider_calls_required: boolean;
  readonly network_required: boolean;
  readonly total_findings: number;
  readonly findings_by_severity: Record<ReviewSeverity, number>;
  readonly findings_by_category: Record<ReviewCategory, number>;
  readonly generated_artifact_count: number;
  readonly test_evidence_change_count: number;
  readonly affected_component_count: number;
  readonly affected_service_count: number;
  readonly direct_affected_component_count: number;
  readonly dependent_component_count: number;
  readonly affected_flow_count: number;
  readonly dependency_runtime_impact_count: number;
  readonly dependency_runtime_changed_file_count: number;
  readonly dependency_runtime_surface_count: number;
  readonly dependency_runtime_verification_focus_count: number;
  readonly service_causality_path_count: number;
  readonly service_causality_effect_count: number;
  readonly affected_journey_count: number;
  readonly affected_journey_step_count: number;
  readonly affected_data_dependency_count: number;
  readonly affected_state_operation_count: number;
  readonly user_visible_failure_mode_count: number;
  readonly journey_missing_evidence_count: number;
  readonly affected_relationship_count: number;
  readonly architecture_impact_surface_count: number;
  readonly architecture_impact_component_surface_count: number;
  readonly architecture_impact_route_surface_count: number;
  readonly architecture_what_breaks_note_count: number;
  readonly architecture_risk_reasoning_count: number;
  readonly architecture_evidence_gap_count: number;
  readonly architecture_confidence_gap_count: number;
  readonly verification_evidence_count: number;
  readonly verification_passed_count: number;
  readonly verification_failed_count: number;
  readonly verification_plan_count: number;
  readonly verification_plan_required_count: number;
  readonly verification_plan_recommended_count: number;
  readonly verification_plan_optional_count: number;
  readonly architecture_affected_test_count: number;
  readonly architecture_affected_config_count: number;
  readonly required_test_count: number;
  readonly evidence_id_count: number;
  readonly blast_radius: BlastRadius;
  readonly overall_risk: OverallRisk;
  readonly surgicality_score: number;
  readonly review_readiness_score: number;
  readonly secret_safety: {
    readonly redaction_applied: boolean;
    readonly redacted_reference_count: number;
    readonly unsafe_sensitive_reference_count: number;
    readonly output_secret_safe: boolean;
  };
  readonly redaction: {
    readonly redacted_reference_count: number;
    readonly unsafe_sensitive_reference_count: number;
    readonly note: string;
  };
  readonly scoring_notes: readonly string[];
}

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
  readonly journey_name?: string;
  readonly journey_confidence?: Confidence;
  readonly kind: string;
  readonly framework?: string;
  readonly route_path?: string;
  readonly route_type?: string;
  readonly confidence: Confidence;
  readonly score: number;
  readonly entrypoints: readonly string[];
  readonly affected_steps: readonly FlowJourneyStep[];
  readonly runtime_surfaces: readonly string[];
  readonly data_dependencies: readonly FlowDataDependency[];
  readonly user_visible_failure_modes: readonly string[];
  readonly missing_evidence: readonly string[];
  readonly changed_files: readonly string[];
  readonly components: readonly string[];
  readonly services: readonly string[];
  readonly service_causality: readonly FlowServiceCausality[];
  readonly tests: readonly string[];
  readonly configs: readonly string[];
  readonly risks: number;
  readonly evidence_ids: readonly string[];
  readonly reasons: readonly string[];
}

interface ReviewAffectedServiceData {
  readonly id: string;
  readonly name: string;
  readonly runtime: string;
  readonly framework: string;
  readonly changed_files: readonly string[];
  readonly entrypoints: readonly string[];
  readonly routes: readonly string[];
  readonly jobs: readonly string[];
  readonly storage_dependencies: readonly string[];
  readonly environment_variables: readonly string[];
  readonly external_services: readonly string[];
  readonly deployment_configs: readonly string[];
  readonly affected_flows: readonly string[];
  readonly tests: readonly string[];
  readonly configs: readonly string[];
  readonly risks: readonly string[];
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly reasons: readonly string[];
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

type ReviewPackageScriptCategory =
  | 'build'
  | 'test'
  | 'typecheck'
  | 'lint'
  | 'pack'
  | 'start'
  | 'deploy'
  | 'runtime'
  | 'other';

interface ReviewPackageScriptData {
  readonly manifest: string;
  readonly name: string;
  readonly command: string;
  readonly category: ReviewPackageScriptCategory;
}

interface ReviewDependencyRuntimeImpactData {
  readonly changed_files: readonly string[];
  readonly package_manifests: readonly string[];
  readonly lockfiles: readonly string[];
  readonly config_files: readonly string[];
  readonly dependency_entities: readonly string[];
  readonly package_scripts: readonly ReviewPackageScriptData[];
  readonly runtime_surfaces: readonly string[];
  readonly affected_components: readonly string[];
  readonly affected_services: readonly string[];
  readonly affected_flows: readonly string[];
  readonly affected_tests: readonly string[];
  readonly affected_configs: readonly string[];
  readonly verification_focus: readonly string[];
  readonly reasons: readonly string[];
  readonly confidence: Confidence;
}

interface ReviewEvidenceSummaryData {
  readonly changed_files: number;
  readonly generated_artifacts: readonly string[];
  readonly test_evidence_changes: readonly string[];
  readonly direct_components: number;
  readonly affected_services: number;
  readonly dependent_components: number;
  readonly affected_flows: number;
  readonly dependency_runtime_impacts: number;
  readonly dependency_runtime_changed_files: readonly string[];
  readonly dependency_runtime_surfaces: readonly string[];
  readonly dependency_runtime_verification_focus: readonly string[];
  readonly service_causality_paths: number;
  readonly service_causality_effects: readonly string[];
  readonly affected_journeys: readonly string[];
  readonly affected_journey_steps: number;
  readonly affected_data_dependencies: readonly string[];
  readonly affected_state_operations: readonly string[];
  readonly user_visible_failure_modes: readonly string[];
  readonly journey_missing_evidence: readonly string[];
  readonly architecture_impact_surfaces: number;
  readonly architecture_confidence_gaps: readonly string[];
  readonly architecture_evidence_gap_ids: readonly string[];
  readonly architecture_what_breaks: readonly string[];
  readonly architecture_risk_reasoning: readonly string[];
  readonly affected_tests: readonly string[];
  readonly affected_configs: readonly string[];
  readonly verification_evidence_ids: readonly string[];
  readonly evidence_ids: readonly string[];
}

interface ReviewArchitectureImpactData {
  readonly impact_id: string;
  readonly surface_type: ArchitectureImpactSurfaceType;
  readonly entity_id: string;
  readonly name: string;
  readonly route_path?: string;
  readonly route_type?: string;
  readonly matched_changed_files: readonly string[];
  readonly matched_components: readonly string[];
  readonly matched_flows: readonly string[];
  readonly affected_flows: readonly string[];
  readonly affected_files: readonly string[];
  readonly affected_tests: readonly string[];
  readonly affected_configs: readonly string[];
  readonly dependent_components: readonly string[];
  readonly coupling_level: ComponentIntelligence['coupling']['level'];
  readonly coupling_score: number;
  readonly confidence: Confidence;
  readonly confidence_score: number;
  readonly evidence_ids: readonly string[];
  readonly evidence_gap_ids: readonly string[];
  readonly what_breaks: readonly string[];
  readonly risk_reasoning: ArchitectureImpactRiskReasoning;
  readonly reasons: readonly string[];
}

interface ReviewSummaryData {
  readonly id: string;
  readonly generated_at: string;
  readonly changed_files: readonly string[];
  readonly direct_affected_components: readonly ReviewAffectedComponentData[];
  readonly affected_services: readonly ReviewAffectedServiceData[];
  readonly dependent_components: readonly ReviewAffectedComponentData[];
  readonly affected_components: readonly string[];
  readonly affected_flows: readonly AffectedFlowData[];
  readonly affected_relationships: readonly ReviewAffectedRelationshipData[];
  readonly architecture_impact_map: readonly ReviewArchitectureImpactData[];
  readonly dependency_runtime_impact: ReviewDependencyRuntimeImpactData | null;
  readonly affected_entities: readonly string[];
  readonly blast_radius_reasons: readonly string[];
  readonly review_evidence_summary: ReviewEvidenceSummaryData;
  readonly verification_status: ReviewVerificationStatusData;
  readonly verification_plan: readonly ReviewVerificationPlanItemData[];
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
  readonly confidence_basis: readonly string[];
  readonly unknowns: readonly string[];
  readonly evidence_summary: {
    readonly evidence_count: number;
    readonly direct_evidence_ids: readonly string[];
    readonly field_evidence: readonly string[];
    readonly records: readonly {
      readonly id: string;
      readonly label: string;
      readonly description: string;
      readonly confidence: Confidence;
      readonly source_files: readonly string[];
      readonly kind?: string;
    }[];
    readonly redacted_evidence_count: number;
  };
  readonly evidence_gaps: readonly string[];
  readonly related_components: readonly string[];
  readonly related_flows: readonly string[];
  readonly benchmark_task_hints: readonly {
    readonly id: string;
    readonly category: BenchmarkTaskCategory;
    readonly prompt: string;
    readonly expected_artifact: string;
    readonly expected_check_fields: readonly string[];
    readonly confidence: Confidence;
    readonly why_it_matters: string;
  }[];
  readonly research_artifacts: {
    readonly proving: readonly string[];
    readonly limiting: readonly string[];
  };
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
  readonly service?: {
    readonly runtime: string;
    readonly framework: string;
    readonly service_root: string;
    readonly entrypoints: readonly string[];
    readonly routes: readonly string[];
    readonly jobs: readonly string[];
    readonly storage_dependencies: readonly string[];
    readonly environment_variables: readonly string[];
    readonly external_services: readonly string[];
    readonly deployment_configs: readonly string[];
    readonly related_flows: readonly string[];
    readonly related_components: readonly string[];
    readonly confidence_score: number;
  };
  readonly flow?: {
    readonly kind: FlowKind;
    readonly journey?: FlowJourneySummary;
    readonly journey_steps: readonly FlowJourneyStep[];
    readonly framework?: string;
    readonly route_path?: string;
    readonly route_type?: string;
    readonly entrypoints: readonly FlowEntrypoint[];
    readonly steps: readonly FlowStep[];
    readonly components: readonly string[];
    readonly services: readonly string[];
    readonly service_causality: readonly FlowServiceCausality[];
    readonly data_dependencies: readonly FlowDataDependency[];
    readonly files: readonly string[];
    readonly dependencies: readonly string[];
    readonly runtime_surfaces: readonly string[];
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

export interface AddVerificationEvidenceOptions {
  readonly rootDir: string;
  readonly name: string;
  readonly command: string;
  readonly status: VerificationStatus;
  readonly now?: Date;
  readonly outputSummary?: string;
  readonly affectedConfidenceAreas?: readonly string[];
}

export interface AddVerificationEvidenceSummary {
  readonly rootDir: string;
  readonly researchDir: string;
  readonly artifactPath: string;
  readonly item: VerificationEvidenceItem;
  readonly artifact: VerificationEvidenceArtifactData;
}

export type AddVerificationEvidenceResult =
  | { readonly ok: true; readonly value: AddVerificationEvidenceSummary }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface ReviewProjectChangesSummary {
  readonly rootDir: string;
  readonly reviewPath: string;
  readonly reviewEvalPath: string;
  readonly reviewClaimEvidencePath: string;
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
  readonly reviewEval: ReviewEvalArtifactData;
  readonly reviewClaimEvidence: ReviewClaimEvidenceArtifactData;
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

type AskQuestionIntent =
  | 'read_first'
  | 'breaks_if_changed'
  | 'dependents'
  | 'why_exists'
  | 'evidence';

type AskAnswerStatus = 'answered' | 'limited' | 'blocked';

interface AskReadinessSummary {
  readonly status: 'ready' | 'limited' | 'blocked';
  readonly score: number;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly next_required_improvements: readonly string[];
}

export interface AskProjectQuestionOptions {
  readonly rootDir: string;
  readonly question: string;
  readonly now?: Date;
}

export interface AskProjectQuestionAnswer {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly question: string;
  readonly intent: AskQuestionIntent;
  readonly status: AskAnswerStatus;
  readonly answer: string;
  readonly answer_items: readonly string[];
  readonly confidence: Confidence;
  readonly readiness: AskReadinessSummary;
  readonly evidence_ids: readonly string[];
  readonly evidence_summary: {
    readonly evidence_count: number;
    readonly records: readonly {
      readonly id: string;
      readonly description: string;
      readonly confidence: Confidence;
      readonly source_files: readonly string[];
    }[];
    readonly redacted_evidence_count: number;
  };
  readonly unknowns: readonly string[];
  readonly related_entities: readonly string[];
  readonly research_artifacts: readonly string[];
  readonly deterministic: true;
  readonly provider_calls_required: false;
  readonly network_required: false;
}

export interface AskProjectQuestionSummary {
  readonly rootDir: string;
  readonly latestPath: string;
  readonly reportPath: string;
  readonly answer: AskProjectQuestionAnswer;
}

export type AskProjectQuestionResult =
  | { readonly ok: true; readonly value: AskProjectQuestionSummary }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface ExplainResearchArtifacts {
  readonly evidenceQuality: Record<string, unknown> | undefined;
  readonly benchmarkReady: Record<string, unknown> | undefined;
  readonly benchmarkTasks: Record<string, unknown> | undefined;
  readonly availablePaths: readonly string[];
}

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
  serviceIntelligence: 'service_intelligence.json',
  evidenceQuality: 'evidence_quality.json',
  incrementalUpdate: 'incremental_update.json',
  flowUnderstanding: 'flow_understanding.json',
  flowCoverage: 'flow_coverage.json',
  flowConfidence: 'flow_confidence.json',
  architectureReasoning: 'architecture_reasoning.json',
  benchmarkReady: 'benchmark_ready.json',
  benchmarkTasks: 'benchmark_tasks.json',
  understandingScore: 'understanding_score.json',
  pieAcceptance: 'pie_acceptance.json',
  verificationEvidence: 'verification_evidence.json',
} as const;

const IGNORED_DIRS = new Set([
  '.agents',
  '.cache',
  '.claude',
  '.codex',
  '.git',
  '.idea',
  '.pytest_cache',
  '.rizz',
  '.next',
  '.turbo',
  '.vercel',
  '.vscode',
  '__pycache__',
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
  'Procfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'fly.toml',
  'netlify.toml',
  'package.json',
  'pnpm-lock.yaml',
  'pyproject.toml',
  'railway.json',
  'render.yaml',
  'render.yml',
  'requirements.txt',
  'serverless.yml',
  'serverless.yaml',
  'vercel.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'tsconfig.json',
  'vite.config.ts',
  'wrangler.toml',
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

function uniqueBy<T>(items: readonly T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function uniqueInOrder(items: readonly string[]): string[] {
  return [...new Set(items)];
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

function verificationEvidenceArtifactPath(rootDir: string): string {
  return join(rootDir, '.rizz', 'research', RESEARCH_ARTIFACT_FILES.verificationEvidence);
}

function reviewClaimEvidenceArtifactPath(rootDir: string): string {
  return join(rootDir, '.rizz', 'research', 'review_claim_evidence.json');
}

function emptyVerificationEvidenceArtifact(
  projectName: string,
  generatedAt: string,
): VerificationEvidenceArtifactData {
  return buildVerificationEvidenceArtifact({
    projectName,
    generatedAt,
    items: [],
  });
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return value === 'passed' || value === 'failed' || value === 'skipped' || value === 'unknown';
}

function verificationItemFromRecord(value: unknown): VerificationEvidenceItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === 'string' ? safeText(value.id) : undefined;
  const name = typeof value.name === 'string' ? safeText(value.name) : undefined;
  const command = typeof value.command === 'string' ? safeText(value.command) : undefined;
  const timestamp = typeof value.timestamp === 'string' ? safeText(value.timestamp) : undefined;
  if (
    id === undefined ||
    name === undefined ||
    command === undefined ||
    timestamp === undefined ||
    !isVerificationStatus(value.status)
  ) {
    return undefined;
  }
  const outputSummary =
    typeof value.output_summary === 'string' ? safeText(value.output_summary) : undefined;
  return {
    id,
    name,
    command,
    status: value.status,
    timestamp,
    ...(outputSummary !== undefined && outputSummary !== ''
      ? { output_summary: outputSummary }
      : {}),
    affected_confidence_areas: asStringArray(value.affected_confidence_areas).map(safeText),
  };
}

async function readVerificationEvidenceArtifact(
  rootDir: string,
  generatedAt: string,
): Promise<VerificationEvidenceArtifactData> {
  const existing = await readJsonFile<{ readonly items?: readonly unknown[] }>(
    verificationEvidenceArtifactPath(rootDir),
  );
  const items = (existing?.items ?? [])
    .map(verificationItemFromRecord)
    .filter((item): item is VerificationEvidenceItem => item !== undefined);
  return buildVerificationEvidenceArtifact({ projectName: basename(rootDir), generatedAt, items });
}

function verificationStatusCounts(
  items: readonly VerificationEvidenceItem[],
): Record<VerificationStatus, number> {
  return {
    passed: items.filter((item) => item.status === 'passed').length,
    failed: items.filter((item) => item.status === 'failed').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    unknown: items.filter((item) => item.status === 'unknown').length,
  };
}

function verificationLabel(item: VerificationEvidenceItem): string {
  return `${item.name}: ${item.command}`;
}

function commandLooksLocal(command: string): boolean {
  return /(^|\s)(npm|pnpm|yarn|bun|pytest|vitest|jest|tsc|ruff|eslint|cargo|go)\b|lint|typecheck|build|test/i.test(
    command,
  );
}

function commandLooksProduction(command: string): boolean {
  return /https?:\/\/|curl|vercel|prod|production|deploy|smoke/i.test(command);
}

function buildVerificationEvidenceArtifact(params: {
  readonly projectName: string;
  readonly generatedAt: string;
  readonly items: readonly VerificationEvidenceItem[];
}): VerificationEvidenceArtifactData {
  const items = sorted(params.items, (item) => `${item.timestamp}:${item.id}`);
  const localPassed = items.filter(
    (item) =>
      item.status === 'passed' &&
      (item.affected_confidence_areas.includes('local') || commandLooksLocal(item.command)),
  );
  const localFailed = items.filter(
    (item) =>
      item.status === 'failed' &&
      (item.affected_confidence_areas.includes('local') || commandLooksLocal(item.command)),
  );
  const productionPassed = items.filter(
    (item) =>
      item.status === 'passed' &&
      (item.affected_confidence_areas.includes('production') ||
        commandLooksProduction(item.command)),
  );
  const productionFailed = items.filter(
    (item) =>
      item.status === 'failed' &&
      (item.affected_confidence_areas.includes('production') ||
        commandLooksProduction(item.command)),
  );
  const risksReduced = unique([
    ...(localPassed.length > 0
      ? ['Local syntax/build/test regression risk reduced by recorded passed checks.']
      : []),
    ...(productionPassed.length > 0
      ? ['Production reachability risk reduced by recorded smoke checks.']
      : []),
  ]);
  return {
    schema_version: 1,
    generated_at: params.generatedAt,
    project_name: params.projectName,
    items,
    status_counts: verificationStatusCounts(items),
    local_checks_passed: localPassed.map(verificationLabel),
    local_checks_failed: localFailed.map(verificationLabel),
    production_checks_passed: productionPassed.map(verificationLabel),
    production_checks_failed: productionFailed.map(verificationLabel),
    risks_reduced: risksReduced,
    remaining_unknowns: unique([
      ...(items.length === 0 ? ['No runtime verification evidence has been recorded yet.'] : []),
      ...(productionPassed.length === 0 && productionFailed.length === 0
        ? ['No production or deployment smoke evidence has been recorded yet.']
        : []),
      ...(localFailed.length > 0 ? ['At least one local verification check failed.'] : []),
      ...(productionFailed.length > 0 ? ['At least one production smoke check failed.'] : []),
    ]),
  };
}

function reviewVerificationStatus(
  artifact: VerificationEvidenceArtifactData,
): ReviewVerificationStatusData {
  const passedChecks = artifact.items
    .filter((item) => item.status === 'passed')
    .map(verificationLabel);
  const failedChecks = artifact.items
    .filter((item) => item.status === 'failed')
    .map(verificationLabel);
  return {
    artifact_path: `.rizz/research/${RESEARCH_ARTIFACT_FILES.verificationEvidence}`,
    total_checks: artifact.items.length,
    passed_checks: passedChecks,
    failed_checks: failedChecks,
    local_checks_passed: artifact.local_checks_passed,
    production_checks_passed: artifact.production_checks_passed,
    production_checks_failed: artifact.production_checks_failed,
    risks_reduced: artifact.risks_reduced,
    remaining_unknowns: artifact.remaining_unknowns,
    calibration_note:
      artifact.local_checks_passed.length > 0
        ? 'Recorded verification evidence can reduce local regression risk, but production risk stays separate until deployment smoke evidence exists.'
        : 'No local verification evidence has been recorded, so review risk remains based on static brain evidence.',
  };
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
    /^\s*from\s+([A-Za-z_][\w.]+)\s+import\s+/gm,
    /^\s*import\s+([A-Za-z_][\w.]+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined && specifier.trim() !== '') specifiers.add(safeText(specifier));
    }
  }
  return [...specifiers].sort((a, b) => a.localeCompare(b));
}

interface ImportBinding {
  readonly specifier: string;
  readonly local_names: readonly string[];
}

function importBindingsFromText(text: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const match of text.matchAll(/import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = match[1]?.trim();
    const specifier = match[2]?.trim();
    if (clause === undefined || specifier === undefined || specifier === '') continue;
    const localNames = importClauseLocalNames(clause);
    if (localNames.length > 0) {
      bindings.push({ specifier: safeText(specifier), local_names: localNames });
    }
  }
  for (const match of text.matchAll(
    /(?:const|let|var)\s+(.+?)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    const clause = match[1]?.trim();
    const specifier = match[2]?.trim();
    if (clause === undefined || specifier === undefined || specifier === '') continue;
    const localNames = requireClauseLocalNames(clause);
    if (localNames.length > 0) {
      bindings.push({ specifier: safeText(specifier), local_names: localNames });
    }
  }
  for (const match of text.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+([^\n#]+)/gm)) {
    const specifier = match[1]?.trim();
    const clause = match[2]?.trim();
    if (specifier === undefined || specifier === '' || clause === undefined) continue;
    const localNames = pythonImportClauseLocalNames(clause);
    if (localNames.length > 0) {
      bindings.push({ specifier: safeText(specifier), local_names: localNames });
    }
  }
  for (const match of text.matchAll(
    /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?/gm,
  )) {
    const specifier = match[1]?.trim();
    const alias = match[2]?.trim();
    if (specifier === undefined || specifier === '') continue;
    const tailName = specifier.split('.').at(-1);
    const localName = alias === undefined || alias === '' ? tailName : alias;
    if (localName !== undefined && /^[A-Za-z_]\w*$/.test(localName)) {
      bindings.push({ specifier: safeText(specifier), local_names: [safeText(localName)] });
    }
  }
  return bindings;
}

function importClauseLocalNames(clause: string): string[] {
  const names: string[] = [];
  const trimmed = clause.trim();
  if (trimmed.startsWith('*')) {
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(trimmed)?.[1];
    return namespace === undefined ? [] : [safeText(namespace)];
  }
  const namedStart = trimmed.indexOf('{');
  if (namedStart > 0) {
    const defaultName = trimmed.slice(0, namedStart).replace(/,$/, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(defaultName)) names.push(safeText(defaultName));
  } else if (!trimmed.startsWith('{')) {
    const defaultName = trimmed.split(',')[0]?.trim();
    if (defaultName !== undefined && /^[A-Za-z_$][\w$]*$/.test(defaultName)) {
      names.push(safeText(defaultName));
    }
  }
  const named = /\{([^}]+)\}/.exec(trimmed)?.[1];
  if (named !== undefined) {
    for (const item of named.split(',')) {
      const [rawName, alias] = item.split(/\s+as\s+/);
      const localName = (alias ?? rawName)?.trim();
      if (localName !== undefined && /^[A-Za-z_$][\w$]*$/.test(localName)) {
        names.push(safeText(localName));
      }
    }
  }
  return unique(names);
}

function requireClauseLocalNames(clause: string): string[] {
  const trimmed = clause.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return [safeText(trimmed)];
  const named = /^\{([^}]+)\}$/.exec(trimmed)?.[1];
  if (named === undefined) return [];
  return unique(
    named
      .split(',')
      .map((item) => {
        const [, alias] = item.split(':');
        const localName = (alias ?? item).trim();
        return /^[A-Za-z_$][\w$]*$/.test(localName) ? safeText(localName) : undefined;
      })
      .filter((item): item is string => item !== undefined),
  );
}

function pythonImportClauseLocalNames(clause: string): string[] {
  return unique(
    clause
      .split(',')
      .map((item) => {
        const [rawName, alias] = item.trim().split(/\s+as\s+/);
        const localName = (alias ?? rawName)?.trim();
        return localName !== undefined && /^[A-Za-z_]\w*$/.test(localName)
          ? safeText(localName)
          : undefined;
      })
      .filter((item): item is string => item !== undefined),
  );
}

const RESOLVABLE_SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
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

function isDeployLikeScript(scriptName: string, command: string): boolean {
  return /(^|[^a-z])(deploy|release|publish|vercel|netlify|flyctl|railway|render|wrangler|serverless|docker\s+push|kubectl|helm)([^a-z]|$)/i.test(
    `${scriptName} ${command}`,
  );
}

function isDeploymentConfigPath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = basename(lower);
  return (
    lower.startsWith('.github/workflows/') ||
    name === 'vercel.json' ||
    name === 'netlify.toml' ||
    name === 'fly.toml' ||
    name === 'railway.json' ||
    name === 'render.yaml' ||
    name === 'render.yml' ||
    name === 'wrangler.toml' ||
    name === 'serverless.yml' ||
    name === 'serverless.yaml' ||
    name === 'procfile' ||
    name === 'dockerfile' ||
    name === 'docker-compose.yml' ||
    name === 'docker-compose.yaml'
  );
}

function deploymentConfigFilesForPackage(
  files: readonly FileFact[],
  pkg: PackageJsonFact,
): FileFact[] {
  const componentPath = packageComponentPath(pkg);
  const deploymentConfigs = files.filter((file) => isDeploymentConfigPath(file.relativePath));
  if (componentPath === undefined) {
    return uniqueFileFacts(
      deploymentConfigs.filter(
        (file) => !file.relativePath.includes('/') || file.relativePath.startsWith('.github/'),
      ),
    );
  }
  return uniqueFileFacts(
    deploymentConfigs.filter(
      (file) =>
        file.relativePath.startsWith(`${componentPath}/`) ||
        !file.relativePath.includes('/') ||
        file.relativePath.startsWith('.github/'),
    ),
  );
}

function deploymentRisksForConfigs(params: {
  readonly rootDir: string;
  readonly flowId: string;
  readonly configs: readonly string[];
}): FlowRisk[] {
  const risks: FlowRisk[] = [];
  for (const config of params.configs.filter(isDeploymentConfigPath)) {
    const text = readTextIfAvailable(params.rootDir, config) ?? '';
    const evidence = [evidenceId(config)];
    if (/\/tmp\b|tmp\/|sqlite|\.db\b|local\s+file|filesystem/i.test(text)) {
      risks.push({
        risk_id: `${params.flowId}:deployment-storage:${stableSlug(config)}`,
        kind: 'deployment_storage',
        description:
          'Deployment config or runtime settings suggest filesystem, SQLite, or temporary storage that may be ephemeral in serverless production.',
        evidence,
      });
    }
    if (/AUTH_ENABLED["']?\s*[:=]\s*["']?false|auth\s*[:=]\s*false/i.test(text)) {
      risks.push({
        risk_id: `${params.flowId}:deployment-auth:${stableSlug(config)}`,
        kind: 'deployment_auth',
        description:
          'Deployment config appears to disable authentication; acceptable for demos, risky for production surfaces.',
        evidence,
      });
    }
    if (/CORS_ORIGINS["']?\s*[:=]\s*["']?\*|Access-Control-Allow-Origin.*\*/i.test(text)) {
      risks.push({
        risk_id: `${params.flowId}:deployment-cors:${stableSlug(config)}`,
        kind: 'deployment_cors',
        description:
          'Deployment config appears to allow broad CORS access; production usage should confirm intended origins.',
        evidence,
      });
    }
  }
  return risks;
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

function resolveDottedImportFiles(files: readonly FileFact[], specifier: string): FileFact[] {
  if (!/^[A-Za-z_][\w.]+$/.test(specifier) || !specifier.includes('.')) return [];
  return filesForPathHint(files, specifier.replace(/\./g, '/'));
}

function importContextForFiles(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
  readonly entryFiles: readonly FileFact[];
}): {
  readonly importedSpecifiers: readonly string[];
  readonly resolvedImportSpecifiers: readonly string[];
  readonly importedFiles: readonly FileFact[];
  readonly importEvidence: readonly FlowEvidence[];
} {
  const importedSpecifiers = new Set<string>();
  const resolvedImportSpecifiers = new Set<string>();
  const importedFiles: FileFact[] = [];
  const importEvidence: FlowEvidence[] = [];
  const aliases = importAliasContextForConfigs(params);
  const queue = params.entryFiles.map((file) => ({ file, depth: 0 }));
  const visited = new Set<string>();
  const maxImportDepth = 4;
  for (let index = 0; index < queue.length; index += 1) {
    const { file, depth } = queue[index] ?? { file: undefined, depth: 0 };
    if (file === undefined) continue;
    if (visited.has(file.relativePath)) continue;
    visited.add(file.relativePath);
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
      const relativeImports = resolveRelativeImportFiles(
        params.files,
        file.relativePath,
        specifier,
      );
      const aliasImports = resolveAliasImportFiles(params.files, specifier, aliases);
      const dottedImports = resolveDottedImportFiles(params.files, specifier);
      if (relativeImports.length > 0 || aliasImports.length > 0 || dottedImports.length > 0) {
        resolvedImportSpecifiers.add(specifier);
      }
      const resolvedFiles = uniqueFileFacts([
        ...relativeImports,
        ...aliasImports,
        ...dottedImports,
      ]);
      importedFiles.push(...resolvedFiles);
      if (depth >= maxImportDepth) continue;
      for (const importedFile of resolvedFiles) {
        if (!visited.has(importedFile.relativePath)) {
          queue.push({ file: importedFile, depth: depth + 1 });
        }
      }
    }
  }
  return {
    importedSpecifiers: [...importedSpecifiers].sort((a, b) => a.localeCompare(b)),
    resolvedImportSpecifiers: [...resolvedImportSpecifiers].sort((a, b) => a.localeCompare(b)),
    importedFiles: uniqueFileFacts(importedFiles),
    importEvidence: uniqueFlowEvidence(importEvidence),
  };
}

function externalImportSpecifiers(importContext: {
  readonly importedSpecifiers: readonly string[];
  readonly resolvedImportSpecifiers: readonly string[];
}): string[] {
  const resolved = new Set(importContext.resolvedImportSpecifiers);
  return importContext.importedSpecifiers.filter(
    (specifier) => !specifier.startsWith('.') && !resolved.has(specifier),
  );
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

function commandRuntimeSurfaces(command: string): string[] {
  const lower = command.toLowerCase();
  return unique([
    ...(lower.includes('node ') || lower.startsWith('node') ? ['runtime:node'] : []),
    ...(lower.includes('tsx ') || lower.startsWith('tsx') || lower.includes('ts-node')
      ? ['runtime:typescript-node']
      : []),
    ...(lower.includes('vitest') || lower.includes('jest') || lower.includes('pytest')
      ? ['runtime:test-runner']
      : []),
    ...(lower.includes('next ') || lower.startsWith('next') ? ['runtime:nextjs'] : []),
    ...(lower.includes('vite') ? ['runtime:vite'] : []),
  ]);
}

function flowRuntimeSurfaces(params: {
  readonly kind: FlowKind;
  readonly framework?: string;
  readonly routePath?: string;
  readonly routeType?: string;
  readonly scriptName?: string;
  readonly command?: string;
  readonly configs: readonly string[];
  readonly serviceIds: readonly string[];
  readonly services: readonly BrainEntity[];
}): string[] {
  let routeSurface: string | undefined;
  if (params.routePath !== undefined) {
    routeSurface =
      params.routeType === undefined ? params.routePath : `${params.routeType} ${params.routePath}`;
  }
  const serviceSurfaces = params.serviceIds.flatMap((serviceId) => {
    const service = params.services.find((item) => item.id === serviceId);
    if (service === undefined) return [];
    const runtime = stringData(service, 'runtime') ?? 'unknown';
    const root = stringData(service, 'service_root') ?? service.name;
    return [`service runtime:${runtime} ${root}`];
  });
  return unique([
    `flow kind:${params.kind}`,
    ...(params.framework === undefined ? [] : [`framework:${params.framework}`]),
    ...(routeSurface === undefined ? [] : [`route:${routeSurface}`]),
    ...(params.scriptName === undefined ? [] : [`package script:${params.scriptName}`]),
    ...(params.command === undefined ? [] : commandRuntimeSurfaces(params.command)),
    ...params.configs.map((config) => `config:${config}`),
    ...serviceSurfaces,
  ]);
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
  const isDeploymentFlow = params.signals.includes('deployment');
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
    ...(isDeploymentFlow
      ? [
          'Deployment entrypoint is inferred from a deploy-like package script and deployment config evidence.',
        ]
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
    ...(isDeploymentFlow
      ? ['Exits when the deployment provider/build command accepts or rejects the release.']
      : []),
    ...(outputEvidence.length > 0 ? ['Source evidence includes a return or response output.'] : []),
    ...(params.tests.length > 0
      ? [`Expected behavior is test-backed by ${params.tests.slice(0, 4).join(', ')}.`]
      : []),
  ]);
  const inputs = unique([
    ...commandInput,
    ...(isDeploymentFlow ? ['Deployment provider environment and build-time configuration.'] : []),
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
    ...(isDeploymentFlow
      ? [
          'May publish a build artifact, serverless function, container, or static output to a deployment provider.',
        ]
      : []),
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
    ...(isDeploymentFlow
      ? [
          'Deployment can succeed locally while production storage, auth, CORS, or runtime env remain unverified.',
        ]
      : []),
  ]);
  const requiredTests = unique([
    ...params.tests,
    ...(validationEvidence.length > 0 ? ['validation failure coverage'] : []),
    ...(sideEffectEvidence.length > 0 ? ['state/session/cache/database side-effect coverage'] : []),
    ...(outputEvidence.length > 0 ? ['response/output contract coverage'] : []),
    ...(isDeploymentFlow ? ['production smoke check'] : []),
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
    ...(isDeploymentFlow ? ['Deployment config evidence is recorded.'] : []),
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
      ...(isDeploymentFlow
        ? { side_effects: unique([...sideEffectEvidence, ...baseEvidence]) }
        : {}),
      ...(params.routeContract !== undefined && sideEffectEvidence.length === 0
        ? { side_effects: baseEvidence }
        : {}),
      state_transitions: unique([...sideEffectEvidence, ...validationEvidence]),
      failure_modes: unique([
        ...params.risks.flatMap((risk) => risk.evidence),
        ...failureEvidence,
        ...validationEvidence,
        ...(params.routeContract !== undefined ? baseEvidence : []),
        ...(isDeploymentFlow ? params.configs.map(evidenceId) : []),
      ]),
      required_tests: unique([
        ...params.tests.map(evidenceId),
        ...validationEvidence,
        ...sideEffectEvidence,
        ...(isDeploymentFlow ? params.configs.map(evidenceId) : []),
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

function flowJourneySummaryData(entity: BrainEntity): FlowJourneySummary | undefined {
  const value = entity.data?.journey;
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === 'string' ? safeText(value.name) : undefined;
  if (name === undefined) return undefined;
  return {
    name,
    category: typeof value.category === 'string' ? safeText(value.category) : 'unknown',
    confidence: parseConfidence(value.confidence),
    score: typeof value.score === 'number' ? value.score : 0,
    reasons: asStringArray(value.reasons).map(safeText),
    evidence_ids: asStringArray(value.evidence_ids).map(safeText),
    missing_evidence: asStringArray(value.missing_evidence).map(safeText),
  };
}

function safeFlowJourneySteps(entity: BrainEntity): FlowJourneyStep[] {
  const steps = entity.data?.journey_steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((step): step is FlowJourneyStep => {
      if (!isRecord(step)) return false;
      return (
        typeof step.step_id === 'string' &&
        typeof step.order === 'number' &&
        typeof step.type === 'string' &&
        typeof step.label === 'string' &&
        typeof step.description === 'string'
      );
    })
    .map((step) => ({
      step_id: safeText(step.step_id),
      order: step.order,
      type: journeyStepType(step.type),
      label: safeText(step.label),
      description: safeText(step.description),
      files: asStringArray(step.files).map(safeText),
      symbols: asStringArray(step.symbols).map(safeText),
      routes: asStringArray(step.routes).map(safeText),
      runtime_surfaces: asStringArray(step.runtime_surfaces).map(safeText),
      configs: asStringArray(step.configs).map(safeText),
      tests: asStringArray(step.tests).map(safeText),
      confidence: parseConfidence(step.confidence),
      evidence_ids: asStringArray(step.evidence_ids).map(safeText),
      missing_evidence: asStringArray(step.missing_evidence).map(safeText),
    }));
}

function journeyStepType(value: unknown): JourneyStepType {
  if (
    value === 'trigger' ||
    value === 'validation_auth' ||
    value === 'read_write_storage' ||
    value === 'business_logic' ||
    value === 'external_service_call' ||
    value === 'rendering_response' ||
    value === 'background_job_async' ||
    value === 'runtime_config' ||
    value === 'test_coverage'
  ) {
    return value;
  }
  return 'business_logic';
}

function textTokens(value: string): string[] {
  return unique(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
}

function titleWords(tokens: readonly string[]): string {
  return tokens
    .filter((token) => !['api', 'src', 'app', 'route', 'routes', 'page', 'handler'].includes(token))
    .slice(0, 3)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function flowJourneyText(intelligence: FlowIntelligence): string {
  return [
    intelligence.name,
    intelligence.kind,
    intelligence.framework ?? '',
    intelligence.route_path ?? '',
    intelligence.route_type ?? '',
    ...intelligence.entrypoints.flatMap((entrypoint) => [
      entrypoint.path,
      entrypoint.symbol ?? '',
      entrypoint.type,
    ]),
    ...intelligence.steps.flatMap((step) => [
      step.path,
      step.symbol ?? '',
      step.description,
      step.type,
    ]),
    ...intelligence.files,
    ...intelligence.configs,
    ...intelligence.tests,
    ...intelligence.runtime_surfaces,
    ...intelligence.signals,
  ].join(' ');
}

function journeyMatch(
  text: string,
  patterns: readonly RegExp[],
): { readonly matched: boolean; readonly matchedTerms: readonly string[] } {
  const matchedTerms = patterns
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source.replace(/\\b|\(|\)|\||\?/g, ' ').trim())
    .filter((term) => term.length > 0);
  return { matched: matchedTerms.length > 0, matchedTerms };
}

function inferFlowJourneySummary(intelligence: FlowIntelligence): FlowJourneySummary {
  const text = flowJourneyText(intelligence);
  const normalized = text.toLowerCase();
  const evidenceIds = unique([
    ...intelligence.entrypoints.flatMap((entrypoint) => entrypoint.evidence),
    ...intelligence.steps.flatMap((step) => step.evidence),
    ...intelligence.configs.map(evidenceId),
    ...intelligence.tests.map(evidenceId),
  ]).slice(0, 12);
  const routeOrName =
    intelligence.route_path !== undefined
      ? titleWords(textTokens(intelligence.route_path))
      : titleWords(textTokens(intelligence.name));
  const cases: readonly {
    readonly category: string;
    readonly label: string;
    readonly noun: string;
    readonly patterns: readonly RegExp[];
  }[] = [
    {
      category: 'auth_login',
      label: 'User login journey',
      noun: 'login',
      patterns: [/\bauth\b/i, /\blogin\b/i, /\bsignin\b/i, /\bsession\b/i, /\btoken\b/i],
    },
    {
      category: 'checkout_payment',
      label: 'Checkout payment journey',
      noun: 'checkout',
      patterns: [/\bcheckout\b/i, /\bpayment\b/i, /\bbilling\b/i, /\bcart\b/i, /\border(s)?\b/i],
    },
    {
      category: 'upload_ingestion',
      label: /admin/i.test(normalized)
        ? 'Admin upload and processing flow'
        : 'Upload ingestion journey',
      noun: 'upload',
      patterns: [/\bupload\b/i, /\bingest/i, /\bingestion\b/i, /\bmultipart\b/i, /\bfileupload\b/i],
    },
    {
      category: 'search_retrieval',
      label: 'Search query retrieval journey',
      noun: 'search',
      patterns: [/\bsearch\b/i, /\bquery\b/i, /\bretriev/i, /\blookup\b/i, /\bfind\b/i],
    },
    {
      category: 'webhook_background',
      label: /webhook/i.test(normalized)
        ? 'Webhook event processing flow'
        : 'Background job processing workflow',
      noun: 'webhook',
      patterns: [/\bwebhook\b/i, /\bevent\b/i, /\bqueue\b/i, /\bworker\b/i, /\bjob\b/i],
    },
    {
      category: 'report_generation',
      label: 'Report generation workflow',
      noun: 'report',
      patterns: [/\breport\b/i, /\bexport\b/i, /\bpdf\b/i, /\bgenerate\b/i],
    },
    {
      category: 'deployment_runtime',
      label: 'Deployment and runtime availability flow',
      noun: 'deployment',
      patterns: [/\bdeploy\b/i, /\brelease\b/i, /\bvercel\b/i, /\bdocker\b/i, /\bruntime\b/i],
    },
    {
      category: 'rendering',
      label: routeOrName.length > 0 ? `${routeOrName} rendering journey` : 'Page rendering journey',
      noun: 'rendering',
      patterns: [/\brender\b/i, /\bpage\b/i, /\blayout\b/i, /\bmetadata\b/i],
    },
  ];
  const matched = cases.find((item) => journeyMatch(normalized, item.patterns).matched);
  const fallbackName =
    intelligence.kind === 'api'
      ? routeOrName.length > 0
        ? `${routeOrName} request journey`
        : 'API request journey'
      : intelligence.kind === 'job'
        ? 'Background job workflow'
        : intelligence.kind === 'cli'
          ? `${titleWords(textTokens(intelligence.name)) || 'Command'} execution workflow`
          : `${titleWords(textTokens(intelligence.name)) || 'Application'} workflow`;
  const name = matched?.label ?? fallbackName;
  const matchedTerms =
    matched === undefined ? [] : journeyMatch(normalized, matched.patterns).matchedTerms;
  const reasons = unique([
    ...(intelligence.route_path !== undefined
      ? [`Route path ${safeText(intelligence.route_path)} contributed to journey naming.`]
      : []),
    ...(intelligence.entrypoints.length > 0
      ? [`${intelligence.entrypoints.length} entrypoint(s) contributed to journey naming.`]
      : []),
    ...(matched !== undefined
      ? [`Matched ${matched.noun} journey signals from local names, paths, commands, or tests.`]
      : ['No strong product-domain keyword matched; name stays generic and lower confidence.']),
    ...(matchedTerms.length > 0 ? [`Matched terms: ${matchedTerms.slice(0, 4).join(', ')}.`] : []),
    ...(intelligence.tests.length > 0 ? ['Linked tests improve journey confidence.'] : []),
    ...(intelligence.configs.length > 0 ? ['Linked configs improve runtime confidence.'] : []),
  ]);
  const missingEvidence = unique([
    ...(matched === undefined
      ? ['No strong route, handler, test, or file keyword named a product journey.']
      : []),
    ...(intelligence.tests.length === 0
      ? ['No directly linked test artifact for this journey.']
      : []),
    ...(intelligence.configs.length === 0
      ? ['No directly linked config artifact for this journey.']
      : []),
    ...(evidenceIds.length === 0
      ? ['No direct evidence IDs were recorded for journey naming.']
      : []),
  ]);
  const score = Math.min(
    1,
    Number(
      (
        0.35 +
        (matched === undefined ? 0 : 0.25) +
        Math.min(0.2, evidenceIds.length * 0.025) +
        (intelligence.tests.length > 0 ? 0.1 : 0) +
        (intelligence.configs.length > 0 ? 0.1 : 0)
      ).toFixed(2),
    ),
  );
  return {
    name: safeText(name),
    category: matched?.category ?? 'generic_workflow',
    confidence: score >= 0.75 ? 'verified' : score >= 0.5 ? 'inferred' : 'uncertain',
    score,
    reasons: reasons.map(safeText),
    evidence_ids: evidenceIds.map(safeText),
    missing_evidence: missingEvidence.map(safeText),
  };
}

function inferJourneyStepType(step: FlowStep, journey: FlowJourneySummary): JourneyStepType {
  const text =
    `${step.type} ${step.path} ${step.symbol ?? ''} ${step.description} ${journey.category}`.toLowerCase();
  if (step.type === 'test' || isTestPath(step.path)) return 'test_coverage';
  if (step.type === 'config' || isConfigPath(step.path)) return 'runtime_config';
  if (
    /db|database|repo|repository|model|schema|prisma|sql|store|storage|cache|redis|write|read/.test(
      text,
    )
  ) {
    return 'read_write_storage';
  }
  if (/auth|login|session|token|password|permission|role|guard|middleware/.test(text)) {
    return 'validation_auth';
  }
  if (/webhook|queue|worker|job|event|cron|background|async/.test(text)) {
    return 'background_job_async';
  }
  if (/fetch|axios|stripe|s3|openai|api client|external|email|sendgrid|twilio|slack/.test(text)) {
    return 'external_service_call';
  }
  if (/render|response|json|send|page|layout|metadata|return|view/.test(text)) {
    return 'rendering_response';
  }
  return 'business_logic';
}

function journeyStepLabel(type: JourneyStepType): string {
  switch (type) {
    case 'trigger':
      return 'Trigger';
    case 'validation_auth':
      return 'Validation/auth';
    case 'read_write_storage':
      return 'Read/write storage';
    case 'business_logic':
      return 'Business logic';
    case 'external_service_call':
      return 'External service call';
    case 'rendering_response':
      return 'Rendering/response';
    case 'background_job_async':
      return 'Background job / async continuation';
    case 'runtime_config':
      return 'Runtime config';
    case 'test_coverage':
      return 'Test coverage';
  }
}

function journeyStepConfidence(params: {
  readonly evidenceIds: readonly string[];
  readonly tests: readonly string[];
  readonly configs: readonly string[];
  readonly type: JourneyStepType;
}): Confidence {
  if (params.evidenceIds.length === 0) return 'uncertain';
  if (params.type === 'test_coverage' || params.type === 'runtime_config') return 'verified';
  if (params.tests.length > 0 || params.configs.length > 0) return 'verified';
  return 'inferred';
}

function inferFlowJourneySteps(
  intelligence: FlowIntelligence,
  journey: FlowJourneySummary,
): FlowJourneyStep[] {
  const route = intelligence.route_path === undefined ? [] : [safeText(intelligence.route_path)];
  const steps: FlowJourneyStep[] = [];
  const addStep = (step: FlowJourneyStep): void => {
    steps.push({ ...step, order: steps.length + 1 });
  };
  const triggerEvidence = unique(
    intelligence.entrypoints.flatMap((entrypoint) => entrypoint.evidence),
  );
  addStep({
    step_id: `${intelligence.flow_id}:journey:trigger`,
    order: 1,
    type: 'trigger',
    label: journeyStepLabel('trigger'),
    description: `${journey.name} starts from ${intelligence.entrypoints.map(formatFlowEntrypoint).slice(0, 3).join(', ') || 'a reconstructed entrypoint'}.`,
    files: unique(intelligence.entrypoints.map((entrypoint) => entrypoint.path)),
    symbols: unique(
      intelligence.entrypoints.flatMap((entrypoint) =>
        entrypoint.symbol === null ? [] : [entrypoint.symbol],
      ),
    ),
    routes: route,
    runtime_surfaces: intelligence.runtime_surfaces.slice(0, 8).map(safeText),
    configs: intelligence.configs.map(safeText),
    tests: intelligence.tests.map(safeText),
    confidence: triggerEvidence.length > 0 ? 'verified' : 'uncertain',
    evidence_ids: triggerEvidence.map(safeText),
    missing_evidence:
      triggerEvidence.length === 0 ? ['No direct trigger evidence IDs were recorded.'] : [],
  });
  for (const step of intelligence.steps) {
    const type = inferJourneyStepType(step, journey);
    const evidenceIds = unique(step.evidence);
    addStep({
      step_id: `${step.step_id}:journey`,
      order: steps.length + 1,
      type,
      label: journeyStepLabel(type),
      description: step.description,
      files: [safeText(step.path)],
      symbols: step.symbol === null ? [] : [safeText(step.symbol)],
      routes: route,
      runtime_surfaces:
        type === 'runtime_config' || type === 'trigger'
          ? intelligence.runtime_surfaces.slice(0, 8).map(safeText)
          : [],
      configs:
        type === 'runtime_config' || step.type === 'config'
          ? unique([step.path, ...intelligence.configs]).map(safeText)
          : [],
      tests:
        type === 'test_coverage' || step.type === 'test'
          ? unique([step.path, ...intelligence.tests]).map(safeText)
          : intelligence.tests.map(safeText),
      confidence: journeyStepConfidence({
        evidenceIds,
        tests: intelligence.tests,
        configs: intelligence.configs,
        type,
      }),
      evidence_ids: evidenceIds.map(safeText),
      missing_evidence: unique([
        ...(evidenceIds.length === 0 ? ['No direct step evidence IDs were recorded.'] : []),
        ...(type !== 'test_coverage' && intelligence.tests.length === 0
          ? ['No linked test verifies this journey step.']
          : []),
        ...(type === 'runtime_config' && intelligence.configs.length === 0
          ? ['No linked config artifact explains runtime behavior.']
          : []),
      ]).map(safeText),
    });
  }
  if (intelligence.configs.length > 0 && !steps.some((step) => step.type === 'runtime_config')) {
    addStep({
      step_id: `${intelligence.flow_id}:journey:runtime-config`,
      order: steps.length + 1,
      type: 'runtime_config',
      label: journeyStepLabel('runtime_config'),
      description: `${journey.name} depends on local runtime configuration evidence.`,
      files: intelligence.configs.map(safeText),
      symbols: [],
      routes: route,
      runtime_surfaces: intelligence.runtime_surfaces.slice(0, 8).map(safeText),
      configs: intelligence.configs.map(safeText),
      tests: intelligence.tests.map(safeText),
      confidence: 'verified',
      evidence_ids: intelligence.configs.map(evidenceId).map(safeText),
      missing_evidence: [],
    });
  }
  if (intelligence.tests.length > 0 && !steps.some((step) => step.type === 'test_coverage')) {
    addStep({
      step_id: `${intelligence.flow_id}:journey:test-coverage`,
      order: steps.length + 1,
      type: 'test_coverage',
      label: journeyStepLabel('test_coverage'),
      description: `${journey.name} has linked test evidence for confidence calibration.`,
      files: intelligence.tests.map(safeText),
      symbols: [],
      routes: route,
      runtime_surfaces: [],
      configs: intelligence.configs.map(safeText),
      tests: intelligence.tests.map(safeText),
      confidence: 'verified',
      evidence_ids: intelligence.tests.map(evidenceId).map(safeText),
      missing_evidence: [],
    });
  }
  if (
    !steps.some((step) => step.type === 'rendering_response') &&
    (intelligence.outputs.length > 0 || intelligence.exit_contract.length > 0)
  ) {
    const evidenceIds = unique([
      ...(intelligence.field_evidence.outputs ?? []),
      ...(intelligence.field_evidence.exit_contract ?? []),
    ]);
    addStep({
      step_id: `${intelligence.flow_id}:journey:response`,
      order: steps.length + 1,
      type: 'rendering_response',
      label: journeyStepLabel('rendering_response'),
      description: `${journey.name} returns or renders ${intelligence.outputs.slice(0, 3).join(', ') || 'a response'}.`,
      files: intelligence.files.slice(0, 4).map(safeText),
      symbols: [],
      routes: route,
      runtime_surfaces: [],
      configs: [],
      tests: intelligence.tests.map(safeText),
      confidence: evidenceIds.length > 0 ? 'inferred' : 'uncertain',
      evidence_ids: evidenceIds.map(safeText),
      missing_evidence:
        evidenceIds.length === 0 ? ['No direct output evidence IDs were recorded.'] : [],
    });
  }
  return steps.slice(0, 16);
}

function enrichFlowWithJourney(intelligence: FlowIntelligence): FlowIntelligence {
  const journey = inferFlowJourneySummary(intelligence);
  return {
    ...intelligence,
    journey,
    journey_steps: inferFlowJourneySteps(intelligence, journey),
  };
}

function safeFlowRisks(entity: BrainEntity): FlowRisk[] {
  return flowRisks(entity).map((risk) => ({
    risk_id: safeText(risk.risk_id),
    kind: risk.kind,
    description: safeText(risk.description),
    evidence: risk.evidence.map(safeText),
  }));
}

function safeFlowServiceCausality(entity: BrainEntity): FlowServiceCausality[] {
  const entries = entity.data?.service_causality;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry): entry is FlowServiceCausality => {
      if (!isRecord(entry)) return false;
      return (
        typeof entry.service_id === 'string' &&
        typeof entry.service_name === 'string' &&
        typeof entry.service_root === 'string' &&
        Array.isArray(entry.files) &&
        entry.files.every((item) => typeof item === 'string') &&
        Array.isArray(entry.step_ids) &&
        entry.step_ids.every((item) => typeof item === 'string') &&
        typeof entry.cause === 'string' &&
        Array.isArray(entry.effects) &&
        entry.effects.every((item) => typeof item === 'string') &&
        Array.isArray(entry.evidence_ids) &&
        entry.evidence_ids.every((item) => typeof item === 'string') &&
        (entry.confidence === 'verified' ||
          entry.confidence === 'inferred' ||
          entry.confidence === 'uncertain') &&
        Array.isArray(entry.unknowns) &&
        entry.unknowns.every((item) => typeof item === 'string')
      );
    })
    .map((entry) => ({
      service_id: safeText(entry.service_id),
      service_name: safeText(entry.service_name),
      service_root: safeText(entry.service_root),
      files: entry.files.map(safeText),
      step_ids: entry.step_ids.map(safeText),
      cause: safeText(entry.cause),
      effects: entry.effects.map(safeText),
      evidence_ids: entry.evidence_ids.map(safeText),
      confidence: entry.confidence,
      unknowns: entry.unknowns.map(safeText),
    }));
}

function safeFlowDataDependencies(entity: BrainEntity): FlowDataDependency[] {
  const entries = entity.data?.data_dependencies;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry): entry is FlowDataDependency => {
      if (!isRecord(entry)) return false;
      return (
        typeof entry.dependency_id === 'string' &&
        typeof entry.kind === 'string' &&
        typeof entry.label === 'string' &&
        Array.isArray(entry.files) &&
        entry.files.every((item) => typeof item === 'string') &&
        Array.isArray(entry.operations) &&
        entry.operations.every((item) => typeof item === 'string') &&
        Array.isArray(entry.evidence_ids) &&
        entry.evidence_ids.every((item) => typeof item === 'string') &&
        (entry.confidence === 'verified' ||
          entry.confidence === 'inferred' ||
          entry.confidence === 'uncertain') &&
        Array.isArray(entry.missing_evidence) &&
        entry.missing_evidence.every((item) => typeof item === 'string')
      );
    })
    .map((entry) => ({
      dependency_id: safeText(entry.dependency_id),
      kind: dataDependencyKind(entry.kind),
      label: safeText(entry.label),
      files: entry.files.map(safeText),
      operations: entry.operations.map(safeText),
      confidence: entry.confidence,
      evidence_ids: entry.evidence_ids.map(safeText),
      missing_evidence: entry.missing_evidence.map(safeText),
    }));
}

function dataDependencyKind(value: unknown): FlowDataDependencyKind {
  if (
    value === 'database' ||
    value === 'cache' ||
    value === 'filesystem' ||
    value === 'object_storage' ||
    value === 'vector_store' ||
    value === 'orm' ||
    value === 'schema' ||
    value === 'state_module'
  ) {
    return value;
  }
  return 'state_module';
}

function dataDependencyKindForLabel(label: string): FlowDataDependencyKind {
  const lower = label.toLowerCase();
  if (/redis|cache|session/.test(lower)) return 'cache';
  if (/filesystem|file|temporary/.test(lower)) return 'filesystem';
  if (/object-storage|s3|blob/.test(lower)) return 'object_storage';
  if (/vector/.test(lower)) return 'vector_store';
  if (/orm|prisma|typeorm|mongoose|sequelize/.test(lower)) return 'orm';
  if (/schema|migration|model|table/.test(lower)) return 'schema';
  if (/database|postgres|sqlite|sql/.test(lower)) return 'database';
  return 'state_module';
}

function stateOperationsFromText(text: string): string[] {
  const operations = new Set<string>();
  const checks: ReadonlyArray<readonly [RegExp, string]> = [
    [/select|findMany|findUnique|findFirst|\bfind\b|\bget\b|read|query|search|lookup/i, 'read'],
    [/insert|create|save|write|setItem|set\(|append|push/i, 'write'],
    [/update|upsert|mutate|patch|replace/i, 'update'],
    [/delete|remove|destroy|drop|truncate/i, 'delete'],
    [/schema|model|table|migration|migrate|prisma|zod|interface|type\s+\w+/i, 'schema'],
    [/redis|cache|ttl|expire|session/i, 'cache/session'],
    [/transaction|commit|rollback/i, 'transaction'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) operations.add(label);
  }
  return [...operations].sort((a, b) => a.localeCompare(b));
}

function isDataDependencySourceFile(path: string): boolean {
  if (isTestPath(path) || isConfigPath(path) || isTypeOnlySupportFile(path)) return false;
  const lower = path.toLowerCase();
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|sql|prisma)$/i.test(lower);
}

function isTypeOnlySupportFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name.endsWith('.d.ts') || /(^|[-_.])(types?|interfaces?)(\.[cm]?[jt]sx?)?$/.test(name);
}

function isGeneratedArtifactPath(path: string): boolean {
  if (isDependencyPath(path) || isConfigPath(path)) return false;
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  if (
    parts.some((part) =>
      [
        '__generated__',
        '__snapshots__',
        'generated',
        'gen',
        'vendor',
        'vendors',
        'third_party',
        'third-party',
      ].includes(part),
    )
  ) {
    return true;
  }
  const name = basename(lower);
  return (
    /\.generated\.[cm]?[jt]sx?$/.test(name) ||
    /\.gen\.[cm]?[jt]sx?$/.test(name) ||
    /\.snap$/.test(name) ||
    /^generated[-_.]/.test(name) ||
    /[-_.]generated\./.test(name)
  );
}

function pathStateDependencyLabels(path: string): string[] {
  const lower = path.toLowerCase();
  const name = basename(lower);
  return unique([
    ...(lower.endsWith('schema.prisma') ? ['prisma schema'] : []),
    ...(lower.includes('/migrations/') || lower.endsWith('.sql')
      ? ['database migration/schema']
      : []),
    ...(/(^|\/)(models?|schema|schemas)\//i.test(path) ||
    /schema|model|table/.test(name) ||
    /(^|\/)db\//i.test(path)
      ? ['data schema/model']
      : []),
    ...(/(^|\/)(repositories?|repos?|store|stores|dao|db)\//i.test(path) ||
    /repository|repo|store|dao/.test(name)
      ? ['state repository/module']
      : []),
    ...(/(^|\/)(cache|redis|session|sessions)\//i.test(path) ? ['cache/session state'] : []),
  ]);
}

function inferFlowDataDependencies(params: {
  readonly rootDir: string;
  readonly intelligence: FlowIntelligence;
}): FlowDataDependency[] {
  const grouped = new Map<
    string,
    {
      readonly label: string;
      readonly files: Set<string>;
      readonly operations: Set<string>;
      readonly evidenceIds: Set<string>;
    }
  >();
  const add = (label: string, file: string, operations: readonly string[]): void => {
    const key = stableSlug(label);
    const existing = grouped.get(key) ?? {
      label,
      files: new Set<string>(),
      operations: new Set<string>(),
      evidenceIds: new Set<string>(),
    };
    existing.files.add(safeText(file));
    existing.evidenceIds.add(evidenceId(file));
    for (const operation of operations) existing.operations.add(safeText(operation));
    grouped.set(key, existing);
  };

  for (const file of params.intelligence.files) {
    if (!isDataDependencySourceFile(file)) continue;
    const text = readTextIfAvailable(params.rootDir, file) ?? '';
    const operations = stateOperationsFromText(`${file}\n${text}`);
    const labels = unique([
      ...storageDependenciesFromText(text),
      ...pathStateDependencyLabels(file),
    ]);
    for (const label of labels) {
      add(label, file, operations.length > 0 ? operations : ['state dependency']);
    }
  }

  return [...grouped.values()]
    .map((entry) => {
      const files = [...entry.files].sort((a, b) => a.localeCompare(b));
      const operations = [...entry.operations].sort((a, b) => a.localeCompare(b));
      const evidenceIds = [...entry.evidenceIds].sort((a, b) => a.localeCompare(b));
      const confidence: Confidence =
        evidenceIds.length > 0 && operations.length > 0
          ? 'verified'
          : evidenceIds.length > 0
            ? 'inferred'
            : 'uncertain';
      return {
        dependency_id: `${params.intelligence.flow_id}:data:${stableSlug(entry.label)}`,
        kind: dataDependencyKindForLabel(entry.label),
        label: safeText(entry.label),
        files,
        operations,
        confidence,
        evidence_ids: evidenceIds,
        missing_evidence: unique([
          ...(operations.length === 0
            ? ['No read/write/update/delete/schema operation was detected for this data surface.']
            : []),
          ...(params.intelligence.tests.length === 0
            ? ['No linked test verifies this data/state dependency.']
            : []),
        ]).map(safeText),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(0, 12);
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
  readonly services: readonly BrainEntity[];
  readonly changedFiles: ReadonlySet<string>;
}): FlowIntelligence {
  const ownerPath = packageComponentPath(params.packageFact);
  const ownerComponentId = ownerPath === undefined ? undefined : entityId('component', ownerPath);
  const ownerFiles = sourceFilesForPackage(params.files, params.packageFact);
  const commandFiles = filesReferencedByCommand(params.files, params.command, ownerPath);
  const isDeploymentScript = isDeployLikeScript(params.scriptName, params.command);
  const deploymentConfigs = isDeploymentScript
    ? deploymentConfigFilesForPackage(params.files, params.packageFact)
    : [];
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
    ...deploymentConfigs.map((file) => file.relativePath),
    ...entryFiles.map((file) => file.relativePath),
    ...importContext.importedFiles.map((file) => file.relativePath),
    ...relatedComponents.flatMap((component) => stringArrayData(component, 'important_files')),
    ...relatedComponents.flatMap((component) => component.source_files.slice(0, 3)),
  ]).slice(0, 30);
  const serviceIds = serviceIdsForFiles(files, params.services);
  const configs = unique([
    params.packageFact.relativePath,
    ...deploymentConfigs.map((file) => file.relativePath),
    ...relatedComponents.flatMap((component) => stringArrayData(component, 'configs')),
  ]);
  const tests = unique(
    relatedComponents.flatMap((component) => stringArrayData(component, 'tests')),
  );
  const dependencies = unique([
    ...Object.keys(params.packageFact.dependencies),
    ...Object.keys(params.packageFact.devDependencies),
    ...[...importedSpecifiers].filter(
      (specifier) =>
        !specifier.startsWith('.') && !importContext.resolvedImportSpecifiers.includes(specifier),
    ),
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
    ...(isDeploymentScript ? ['deployment'] : []),
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
    ...(isDeploymentScript
      ? [
          'Deployment flow is inferred from static script/config evidence; production reachability is not verified until smoke evidence is recorded.',
        ]
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
  risks.push(
    ...deploymentRisksForConfigs({
      rootDir: params.rootDir,
      flowId,
      configs,
    }),
  );
  if (files.some((file) => params.changedFiles.has(file))) {
    risks.push({
      risk_id: `${flowId}:changed-hotspot`,
      kind: 'changed_hotspot',
      description: 'A file in this flow changed in the latest scan.',
      evidence: files.filter((file) => params.changedFiles.has(file)).map(evidenceId),
    });
  }
  const baseConfidence = flowConfidenceFor({ tests, signals, unknowns });
  const serviceCausality = flowServiceCausality({
    frameworkLabel: 'Command',
    entryLabel: params.scriptName,
    serviceIds,
    services: params.services,
    files,
    steps,
  });
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
  const runtimeSurfaces = flowRuntimeSurfaces({
    kind,
    scriptName: params.scriptName,
    command: params.command,
    configs,
    serviceIds,
    services: params.services,
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
    runtime_surfaces: runtimeSurfaces,
    services: serviceIds,
    service_causality: serviceCausality,
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
      ...deploymentConfigs.map((file) =>
        flowEvidenceForNeedle({
          rootDir: params.rootDir,
          path: file.relativePath,
          needle: basename(file.relativePath),
          reason: `Deployment config ${file.relativePath} is linked to deploy-like script ${params.scriptName}.`,
        }),
      ),
    ]),
    field_evidence: {
      entrypoints: [scriptEvidenceId],
      steps: unique(steps.flatMap((step) => step.evidence)),
      components: unique(relatedComponents.flatMap((component) => component.evidence_ids)),
      files: files.map(evidenceId),
      dependencies: [scriptEvidenceId],
      runtime_surfaces: unique([
        scriptEvidenceId,
        ...configs.map(evidenceId),
        ...serviceIds.flatMap(
          (id) => params.services.find((service) => service.id === id)?.evidence_ids ?? [],
        ),
      ]),
      services: serviceIds.flatMap(
        (id) => params.services.find((service) => service.id === id)?.evidence_ids ?? [],
      ),
      service_causality: unique(serviceCausality.flatMap((item) => item.evidence_ids)),
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
    lower.includes('/routers/') ||
    name === 'route.ts' ||
    name === 'route.js' ||
    name.includes('controller') ||
    name.includes('router')
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
  readonly services: readonly BrainEntity[];
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
  const serviceIds = serviceIdsForFiles(
    allScannedFiles.map((file) => file.relativePath),
    params.services,
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
    externalImportSpecifiers(importContext).map((dependency) => entityId('dependency', dependency)),
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
  const serviceCausality = flowServiceCausality({
    frameworkLabel: 'Next.js',
    entryLabel: `${params.routeType} ${params.routePath}`,
    serviceIds,
    services: params.services,
    files,
    steps,
  });
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
  const runtimeSurfaces = flowRuntimeSurfaces({
    kind,
    framework: 'nextjs-app-router',
    routePath: params.routePath,
    routeType: params.routeType,
    configs,
    serviceIds,
    services: params.services,
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
    runtime_surfaces: runtimeSurfaces,
    services: serviceIds,
    service_causality: serviceCausality,
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
      runtime_surfaces: unique([
        evId,
        ...configs.map(evidenceId),
        ...serviceIds.flatMap(
          (id) => params.services.find((service) => service.id === id)?.evidence_ids ?? [],
        ),
      ]),
      services: serviceIds.flatMap(
        (id) => params.services.find((service) => service.id === id)?.evidence_ids ?? [],
      ),
      service_causality: unique(serviceCausality.flatMap((item) => item.evidence_ids)),
      configs: configs.map(evidenceId),
      tests: relatedTests.map(evidenceId),
      risks: risks.flatMap((risk) => risk.evidence),
      ...contracts.field_evidence,
    },
    unknowns,
    signals,
  };
}

const HTTP_ROUTE_DECLARATION_PATTERN =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|del|head|options|all)\s*\(\s*(['"`])([^'"`${}]+)\3/g;

const HONO_APP_DECLARATION_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Hono\b/g;

const FASTAPI_ROUTE_DECLARATION_PATTERN =
  /@\s*([A-Za-z_][\w]*)\s*\.\s*(get|post|put|patch|delete|head|options|api_route|route)\s*\(\s*(['"])([^'"]+)\3/g;

function maskCommentsForStaticScan(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ' '))
    .replace(/\/\/.*$/gm, (match) => ' '.repeat(match.length));
}

function lineNumberAtOffset(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function isHttpRouteReceiver(receiver: string): boolean {
  const lower = receiver.toLowerCase();
  return (
    lower === 'app' ||
    lower === 'router' ||
    lower === 'server' ||
    lower === 'fastify' ||
    lower.endsWith('app') ||
    lower.endsWith('router') ||
    lower.endsWith('server')
  );
}

function honoRouteReceivers(text: string): ReadonlySet<string> {
  const receivers = new Set<string>();
  for (const match of text.matchAll(HONO_APP_DECLARATION_PATTERN)) {
    const receiver = match[1];
    if (receiver !== undefined) receivers.add(receiver);
  }
  return receivers;
}

function httpRouteFrameworkLabel(framework: HttpRouteFramework): string {
  if (framework === 'fastapi') return 'FastAPI';
  if (framework === 'hono') return 'Hono';
  return 'HTTP';
}

function httpRouteMethod(method: string): HttpRouteMethod {
  if (method.toLowerCase() === 'api_route' || method.toLowerCase() === 'route') return 'ALL';
  if (method.toLowerCase() === 'del') return 'DELETE';
  return method.toUpperCase() as HttpRouteMethod;
}

function normalizeHttpRoutePath(routePath: string): string | undefined {
  const trimmed = routePath.trim();
  if (trimmed === '') return undefined;
  if (containsSensitiveReference(trimmed)) return undefined;
  return trimmed.startsWith('/') || trimmed === '*' ? trimmed : `/${trimmed}`;
}

function isHttpRouteSourceFile(file: FileFact): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i.test(file.relativePath) && !isTestPath(file.relativePath);
}

function httpRouteDeclarationsForFile(params: {
  readonly rootDir: string;
  readonly file: FileFact;
}): HttpRouteDeclaration[] {
  if (!isHttpRouteSourceFile(params.file)) return [];
  const text = readTextIfAvailable(params.rootDir, params.file.relativePath);
  if (text === undefined) return [];
  const masked = maskCommentsForStaticScan(text);
  const isFastApiPythonFile =
    params.file.relativePath.endsWith('.py') && /FastAPI|APIRouter|fastapi/i.test(masked);
  const honoReceivers = honoRouteReceivers(masked);
  const declarations = new Map<string, HttpRouteDeclaration>();
  if (!isFastApiPythonFile) {
    for (const match of masked.matchAll(HTTP_ROUTE_DECLARATION_PATTERN)) {
      const receiver = match[1];
      const rawMethod = match[2];
      const rawRoutePath = match[4];
      if (receiver === undefined || rawMethod === undefined || rawRoutePath === undefined) {
        continue;
      }
      const framework = honoReceivers.has(receiver) ? 'hono' : 'express-fastify-http';
      if (framework !== 'hono' && !isHttpRouteReceiver(receiver)) continue;
      const routePath = normalizeHttpRoutePath(rawRoutePath);
      if (routePath === undefined) continue;
      const method = httpRouteMethod(rawMethod);
      const line = lineNumberAtOffset(masked, match.index ?? 0);
      const source = `${receiver}.${rawMethod}`;
      declarations.set(`${framework}:${method}:${routePath}:${line}:${source}`, {
        framework,
        receiver,
        method,
        routePath,
        line,
        source,
      });
    }
  }
  if (isFastApiPythonFile) {
    for (const match of masked.matchAll(FASTAPI_ROUTE_DECLARATION_PATTERN)) {
      const receiver = match[1];
      const rawMethod = match[2];
      const rawRoutePath = match[4];
      if (receiver === undefined || rawMethod === undefined || rawRoutePath === undefined) {
        continue;
      }
      const routePath = normalizeHttpRoutePath(rawRoutePath);
      if (routePath === undefined) continue;
      const method = httpRouteMethod(rawMethod);
      const line = lineNumberAtOffset(masked, match.index ?? 0);
      const source = `@${receiver}.${rawMethod}`;
      declarations.set(`fastapi:${method}:${routePath}:${line}:${source}`, {
        framework: 'fastapi',
        receiver,
        method,
        routePath,
        line,
        source,
      });
    }
  }
  return sorted(
    [...declarations.values()],
    (declaration) =>
      `${declaration.method}:${declaration.routePath}:${declaration.line}:${declaration.source}`,
  );
}

function offsetForLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let currentLine = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    currentLine += 1;
    if (currentLine === line) return index + 1;
  }
  return text.length;
}

function httpRouteHandlerText(params: {
  readonly text: string;
  readonly declaration: HttpRouteDeclaration;
}): string | undefined {
  const start = offsetForLine(params.text, params.declaration.line);
  const callStart = params.text.indexOf('(', start);
  if (callStart < 0) return undefined;
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  for (let index = callStart; index < params.text.length; index += 1) {
    const char = params.text[index];
    if (char === undefined) continue;
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char !== ')') continue;
    depth -= 1;
    if (depth === 0) return params.text.slice(callStart, index + 1);
  }
  return params.text.slice(callStart, Math.min(params.text.length, callStart + 2000));
}

function pythonRouteHandlerText(params: {
  readonly text: string;
  readonly declaration: HttpRouteDeclaration;
}): string | undefined {
  const start = offsetForLine(params.text, params.declaration.line);
  const lines = params.text.slice(start).split(/\r?\n/);
  const defIndex = lines.findIndex((line) =>
    /^\s*(?:async\s+def|def)\s+[A-Za-z_]\w*\s*\(/.test(line),
  );
  if (defIndex < 0) return undefined;
  const defLine = lines[defIndex];
  const defIndent = defLine?.match(/^\s*/)?.[0].length ?? 0;
  const handlerLines: string[] = [];
  for (let index = defIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (index > defIndex && line.trim() !== '') {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      const startsNextTopLevelBlock =
        indent <= defIndent && /^\s*(?:@|async\s+def\b|def\b|class\b)/.test(line);
      const startsNextPeerStatement = indent <= defIndent && !/^\s/.test(line);
      if (startsNextTopLevelBlock || startsNextPeerStatement) break;
    }
    handlerLines.push(line);
  }
  return handlerLines.join('\n');
}

function routeHandlerTextForDeclaration(params: {
  readonly text: string;
  readonly routeFile: FileFact;
  readonly declaration: HttpRouteDeclaration;
}): string | undefined {
  if (params.declaration.framework === 'fastapi' || params.routeFile.relativePath.endsWith('.py')) {
    return pythonRouteHandlerText(params);
  }
  return httpRouteHandlerText(params);
}

function textContainsIdentifier(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`).test(text);
}

function reachableHttpRouteImportedFiles(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
  readonly routeFile: FileFact;
  readonly declaration: HttpRouteDeclaration;
  readonly importContext: {
    readonly importedFiles: readonly FileFact[];
  };
}): FileFact[] {
  const text = readTextIfAvailable(params.rootDir, params.routeFile.relativePath);
  if (text === undefined) return [...params.importContext.importedFiles];
  const handlerText = routeHandlerTextForDeclaration({
    text,
    routeFile: params.routeFile,
    declaration: params.declaration,
  });
  if (handlerText === undefined) return [...params.importContext.importedFiles];
  const aliases = importAliasContextForConfigs({ rootDir: params.rootDir, files: params.files });
  const bindings = importBindingsFromText(text);
  if (bindings.length === 0) return [...params.importContext.importedFiles];
  const reachableFiles = bindings.flatMap((binding) => {
    if (!binding.local_names.some((name) => textContainsIdentifier(handlerText, name))) return [];
    return [
      ...resolveRelativeImportFiles(params.files, params.routeFile.relativePath, binding.specifier),
      ...resolveAliasImportFiles(params.files, binding.specifier, aliases),
      ...resolveDottedImportFiles(params.files, binding.specifier),
    ];
  });
  return uniqueFileFacts(reachableFiles);
}

function owningPackageFactForFile(
  packageFacts: readonly PackageJsonFact[],
  filePath: string,
): PackageJsonFact | undefined {
  let owner: PackageJsonFact | undefined;
  let ownerDirLength = -1;
  for (const pkg of packageFacts) {
    const dir = dirname(pkg.relativePath).split(sep).join('/');
    if (dir !== '.' && filePath !== dir && !filePath.startsWith(`${dir}/`)) continue;
    if (dir.length <= ownerDirLength) continue;
    owner = pkg;
    ownerDirLength = dir.length;
  }
  return owner;
}

function packageScopeDir(pkg: PackageJsonFact | undefined): string | undefined {
  if (pkg === undefined) return undefined;
  return dirname(pkg.relativePath).split(sep).join('/');
}

function fileIsInPackageScope(filePath: string, packageDir: string | undefined): boolean {
  if (packageDir === undefined) return false;
  return packageDir === '.' || filePath === packageDir || filePath.startsWith(`${packageDir}/`);
}

function httpRouteConfigs(params: {
  readonly files: readonly FileFact[];
  readonly packageFacts: readonly PackageJsonFact[];
  readonly routeFile: FileFact;
  readonly relatedComponents: readonly BrainEntity[];
}): string[] {
  const ownerPackage = owningPackageFactForFile(params.packageFacts, params.routeFile.relativePath);
  const packageDir = packageScopeDir(ownerPackage);
  return unique([
    ...(ownerPackage === undefined ? [] : [ownerPackage.relativePath]),
    ...params.files
      .filter(
        (file) =>
          file.relativePath !== ownerPackage?.relativePath &&
          isConfigPath(file.relativePath) &&
          fileIsInPackageScope(file.relativePath, packageDir),
      )
      .map((file) => file.relativePath),
    ...params.relatedComponents.flatMap((component) => stringArrayData(component, 'configs')),
  ]).slice(0, 12);
}

function httpRouteTestPaths(params: {
  readonly routeFile: FileFact;
  readonly declaration: HttpRouteDeclaration;
  readonly componentIds: readonly string[];
  readonly tests: readonly BrainEntity[];
}): string[] {
  const fileStem = basename(params.routeFile.relativePath).replace(
    /\.(ts|tsx|js|jsx|mjs|cjs)$/i,
    '',
  );
  const routeNeedles = params.declaration.routePath
    .split('/')
    .map((segment) => segment.replace(/^:/, '').toLowerCase())
    .filter((segment) => segment !== '' && segment !== '*');
  const componentPathNeedles = params.componentIds.map(componentPathFromId);
  return unique(
    params.tests
      .filter((test) =>
        test.source_files.some((file) => {
          const lower = file.toLowerCase();
          return (
            lower.includes(fileStem.toLowerCase()) ||
            lower.includes(params.declaration.method.toLowerCase()) ||
            routeNeedles.some((needle) => lower.includes(needle)) ||
            componentPathNeedles.some((componentPath) => file.startsWith(`${componentPath}/`))
          );
        }),
      )
      .flatMap((test) => test.source_files),
  );
}

function httpRouteDeclarationEvidence(params: {
  readonly file: FileFact;
  readonly declaration: HttpRouteDeclaration;
}): FlowEvidence {
  return {
    path: safeText(params.file.relativePath),
    line_start: params.declaration.line,
    line_end: params.declaration.line,
    reason: safeText(
      `${httpRouteFrameworkLabel(params.declaration.framework)} ${params.declaration.method} ${params.declaration.routePath} route declaration is the flow entrypoint evidence.`,
    ),
  };
}

function inferHttpRouteDeclarationFlow(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
  readonly packageFacts: readonly PackageJsonFact[];
  readonly file: FileFact;
  readonly declaration: HttpRouteDeclaration;
  readonly components: readonly BrainEntity[];
  readonly services: readonly BrainEntity[];
  readonly tests: readonly BrainEntity[];
  readonly changedFiles: ReadonlySet<string>;
}): FlowIntelligence {
  const importContext = importContextForFiles({
    rootDir: params.rootDir,
    files: params.files,
    entryFiles: [params.file],
  });
  const reachableImportedFiles = reachableHttpRouteImportedFiles({
    rootDir: params.rootDir,
    files: params.files,
    routeFile: params.file,
    declaration: params.declaration,
    importContext,
  });
  const reachableImportContext = importContextForFiles({
    rootDir: params.rootDir,
    files: params.files,
    entryFiles: reachableImportedFiles,
  });
  const flowImportedFiles = uniqueFileFacts([
    ...reachableImportedFiles,
    ...reachableImportContext.importedFiles,
  ]);
  const flowImportedSpecifiers = unique([
    ...importContext.importedSpecifiers,
    ...reachableImportContext.importedSpecifiers,
  ]);
  const flowResolvedImportSpecifiers = unique([
    ...importContext.resolvedImportSpecifiers,
    ...reachableImportContext.resolvedImportSpecifiers,
  ]);
  const allScannedFiles = [params.file, ...flowImportedFiles];
  const componentIds = componentIdsForFiles(
    allScannedFiles.map((file) => file.relativePath),
    params.components,
  );
  const relatedComponents = params.components.filter((component) =>
    componentIds.includes(component.id),
  );
  const serviceIds = serviceIdsForFiles(
    allScannedFiles.map((file) => file.relativePath),
    params.services,
  );
  const relatedTests = httpRouteTestPaths({
    routeFile: params.file,
    declaration: params.declaration,
    componentIds,
    tests: params.tests,
  });
  const configs = httpRouteConfigs({
    files: params.files,
    packageFacts: params.packageFacts,
    routeFile: params.file,
    relatedComponents,
  });
  const dependencies = unique(
    externalImportSpecifiers({
      importedSpecifiers: flowImportedSpecifiers,
      resolvedImportSpecifiers: flowResolvedImportSpecifiers,
    }).map((dependency) => entityId('dependency', dependency)),
  );
  const flowId = entityId(
    'flow',
    `${params.declaration.framework === 'hono' ? 'hono' : 'http'}/${params.declaration.method}/${params.declaration.routePath}/${params.file.relativePath}`,
  );
  const evId = evidenceId(params.file.relativePath);
  const frameworkLabel = httpRouteFrameworkLabel(params.declaration.framework);
  const risks: FlowRisk[] = [];
  if (relatedTests.length === 0) {
    risks.push({
      risk_id: `${flowId}:missing-test`,
      kind: 'missing_test',
      description: `No directly linked test artifact was detected for ${frameworkLabel} ${params.declaration.method} ${params.declaration.routePath}.`,
      evidence: [evId],
    });
  }
  if (configs.length === 0) {
    risks.push({
      risk_id: `${flowId}:missing-config`,
      kind: 'missing_config',
      description: `No package or config artifact was detected for this ${frameworkLabel} route flow.`,
      evidence: [evId],
    });
  }
  if (params.changedFiles.has(params.file.relativePath)) {
    risks.push({
      risk_id: `${flowId}:changed-hotspot`,
      kind: 'changed_hotspot',
      description: `The ${frameworkLabel} route declaration file changed in the latest scan.`,
      evidence: [evId],
    });
  }
  const steps: FlowStep[] = [
    {
      step_id: flowStepId(flowId, 1),
      order: 1,
      type: 'route',
      path: safeText(params.file.relativePath),
      symbol: safeText(`${params.declaration.method} ${params.declaration.routePath}`),
      description: `${frameworkLabel} ${params.declaration.method} ${safeText(
        params.declaration.routePath,
      )} route enters ${safeText(params.file.relativePath)} via ${safeText(
        params.declaration.source,
      )}().`,
      evidence: [evId],
    },
    ...flowImportedFiles.slice(0, 8).map((file, index) => ({
      step_id: flowStepId(flowId, index + 2),
      order: index + 2,
      type: 'service' as const,
      path: safeText(file.relativePath),
      symbol: null,
      description: `${frameworkLabel} route statically imports ${safeText(file.relativePath)}.`,
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
      description: `${frameworkLabel} route behavior can be configured by ${safeText(config)}.`,
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
      description: `Related test artifact for this ${frameworkLabel} route flow.`,
      evidence: [evidenceId(test)],
    });
    order += 1;
  }
  const signals = unique([
    ...(params.declaration.framework === 'hono' ? ['hono route app'] : []),
    'http route declaration',
    'route file',
    `${params.declaration.method.toLowerCase()} route`,
    ...(flowImportedSpecifiers.length > 0 ? ['static import'] : []),
    ...(flowImportedFiles.length > 0 ? ['reachable relative import'] : []),
    ...(relatedTests.length > 0 ? ['test artifact'] : []),
    ...(configs.length > 0 ? ['configuration'] : []),
  ]);
  const unknowns = unique([
    ...(componentIds.length === 0
      ? ['No owning component was detected for this HTTP route declaration.']
      : []),
    ...(readTextIfAvailable(params.rootDir, params.file.relativePath)?.includes('import(')
      ? ['Dynamic import is static evidence only; runtime reachability is not traced.']
      : []),
  ]);
  const baseConfidence = flowConfidenceFor({ tests: relatedTests, signals, unknowns });
  const entrypoints: FlowEntrypoint[] = [
    {
      type: 'route',
      path: safeText(params.file.relativePath),
      symbol: safeText(`${params.declaration.method} ${params.declaration.routePath}`),
      component_id: componentIds[0] ?? null,
      evidence: [evId],
    },
  ];
  const files = unique([
    params.file.relativePath,
    ...flowImportedFiles.map((file) => file.relativePath),
  ]);
  const serviceCausality = flowServiceCausality({
    frameworkLabel,
    entryLabel: `${params.declaration.method} ${params.declaration.routePath}`,
    serviceIds,
    services: params.services,
    files,
    steps,
  });
  const contracts = inferFlowContracts({
    rootDir: params.rootDir,
    kind: 'api',
    entrypoints,
    steps,
    files,
    configs,
    tests: relatedTests,
    risks,
    signals,
    confidenceReason: baseConfidence.reason,
  });
  const runtimeSurfaces = flowRuntimeSurfaces({
    kind: 'api',
    framework: params.declaration.framework,
    routePath: params.declaration.routePath,
    routeType: params.declaration.method,
    configs,
    serviceIds,
    services: params.services,
  });
  const routeEvidence = httpRouteDeclarationEvidence({
    file: params.file,
    declaration: params.declaration,
  });
  return {
    flow_id: flowId,
    name: `${params.declaration.method} ${safeText(params.declaration.routePath)} ${frameworkLabel} route`,
    kind: 'api',
    framework: params.declaration.framework,
    route_path: safeText(params.declaration.routePath),
    route_type: params.declaration.method,
    entrypoints,
    steps,
    components: componentIds,
    files,
    dependencies,
    runtime_surfaces: runtimeSurfaces,
    services: serviceIds,
    service_causality: serviceCausality,
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
    evidence: uniqueFlowEvidence([
      routeEvidence,
      ...(flowImportedFiles.length > 0
        ? [...importContext.importEvidence, ...reachableImportContext.importEvidence]
        : []),
    ]),
    field_evidence: {
      entrypoints: [evId],
      steps: unique(steps.flatMap((step) => step.evidence)),
      components: componentIds.flatMap(
        (id) => params.components.find((item) => item.id === id)?.evidence_ids ?? [],
      ),
      files: unique([evId, ...flowImportedFiles.map((file) => evidenceId(file.relativePath))]),
      dependencies: flowImportedSpecifiers.length > 0 ? [evId] : [],
      runtime_surfaces: unique([
        evId,
        ...configs.map(evidenceId),
        ...serviceIds.flatMap(
          (id) => params.services.find((service) => service.id === id)?.evidence_ids ?? [],
        ),
      ]),
      services: serviceIds.flatMap(
        (id) => params.services.find((service) => service.id === id)?.evidence_ids ?? [],
      ),
      service_causality: unique(serviceCausality.flatMap((item) => item.evidence_ids)),
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
  readonly services: readonly BrainEntity[];
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
  const serviceIds = serviceIdsForFiles(
    allScannedFiles.map((file) => file.relativePath),
    params.services,
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
    externalImportSpecifiers(importContext).map((dependency) => entityId('dependency', dependency)),
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
  const serviceCausality = flowServiceCausality({
    frameworkLabel: 'API',
    entryLabel: params.file.relativePath,
    serviceIds,
    services: params.services,
    files,
    steps,
  });
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
  const runtimeSurfaces = flowRuntimeSurfaces({
    kind: 'api',
    configs,
    serviceIds,
    services: params.services,
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
    runtime_surfaces: runtimeSurfaces,
    services: serviceIds,
    service_causality: serviceCausality,
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
      runtime_surfaces: unique([
        evId,
        ...configs.map(evidenceId),
        ...serviceIds.flatMap(
          (id) => params.services.find((service) => service.id === id)?.evidence_ids ?? [],
        ),
      ]),
      services: serviceIds.flatMap(
        (id) => params.services.find((service) => service.id === id)?.evidence_ids ?? [],
      ),
      service_causality: unique(serviceCausality.flatMap((item) => item.evidence_ids)),
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
  rootDir: string,
  now: string,
  createdAt?: string,
): BrainEntity {
  const withDataDependencies: FlowIntelligence = {
    ...intelligence,
    data_dependencies: inferFlowDataDependencies({ rootDir, intelligence }),
  };
  const enriched = enrichFlowWithJourney(withDataDependencies);
  const confidence = flowConfidenceFor({
    tests: enriched.tests,
    signals: enriched.signals,
    unknowns: enriched.unknowns,
  });
  return makeEntity({
    id: enriched.flow_id,
    type: 'flow',
    name: enriched.name,
    description: `${enriched.journey?.name ?? enriched.kind} reconstructed from local evidence.`,
    now,
    ...(createdAt !== undefined ? { createdAt } : {}),
    confidence: confidence.confidence,
    evidenceIds: unique([
      ...enriched.entrypoints.flatMap((entrypoint) => entrypoint.evidence),
      ...enriched.steps.flatMap((step) => step.evidence),
      ...(enriched.service_causality ?? []).flatMap((item) => item.evidence_ids),
      ...(enriched.data_dependencies ?? []).flatMap((item) => item.evidence_ids),
      ...enriched.risks.flatMap((risk) => risk.evidence),
      ...(enriched.journey?.evidence_ids ?? []),
      ...(enriched.journey_steps ?? []).flatMap((step) => step.evidence_ids),
    ]),
    relatedEntityIds: unique([
      ...enriched.components,
      ...(enriched.services ?? []),
      ...enriched.dependencies,
      ...enriched.configs.map((config) => entityId('config', config)),
      ...enriched.tests.map((test) => entityId('test', test)),
    ]),
    sourceFiles: enriched.files,
    data: { ...enriched, confidence: { ...enriched.confidence, score: confidence.score } },
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
          services: params.buckets.services,
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
        services: params.buckets.services,
        tests: params.buckets.tests,
        changedFiles: changedFileSet,
      }),
    );
  }
  const httpRouteDeclarations = new Map<string, readonly HttpRouteDeclaration[]>();
  for (const file of params.files.filter(
    (item) => isHttpRouteSourceFile(item) && !nextAppRouteFilePaths.has(item.relativePath),
  )) {
    const declarations = httpRouteDeclarationsForFile({
      rootDir: params.rootDir,
      file,
    });
    if (declarations.length === 0) continue;
    httpRouteDeclarations.set(file.relativePath, declarations);
    for (const declaration of declarations) {
      flowIntelligence.push(
        inferHttpRouteDeclarationFlow({
          rootDir: params.rootDir,
          files: params.files,
          packageFacts: params.packageFacts,
          file,
          declaration,
          components: params.buckets.components,
          services: params.buckets.services,
          tests: params.buckets.tests,
          changedFiles: changedFileSet,
        }),
      );
    }
  }
  for (const file of params.files.filter(
    (item) =>
      isRouteLikeFile(item) &&
      !nextAppRouteFilePaths.has(item.relativePath) &&
      !httpRouteDeclarations.has(item.relativePath),
  )) {
    flowIntelligence.push(
      inferRouteFlow({
        rootDir: params.rootDir,
        files: params.files,
        file,
        components: params.buckets.components,
        services: params.buckets.services,
        tests: params.buckets.tests,
        changedFiles: changedFileSet,
      }),
    );
  }

  const byId = new Map<string, FlowIntelligence>();
  for (const flow of flowIntelligence) byId.set(flow.flow_id, flow);

  for (const flow of sorted([...byId.values()], (item) => item.flow_id)) {
    const previous = params.previousFlows.get(flow.flow_id);
    const entity = buildFlowEntity(flow, params.rootDir, params.now, previous?.created_at);
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
    for (const serviceId of flow.services ?? []) {
      const service = params.buckets.services.find((item) => item.id === serviceId);
      addRelation(
        params.relationships,
        flow.flow_id,
        'calls',
        serviceId,
        flow.field_evidence.services ?? service?.evidence_ids ?? entity.evidence_ids,
        entity.confidence,
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
  readonly from_entity_id?: string;
  readonly to_entity_id?: string;
}

interface EvidenceConfidenceDelta {
  readonly priority: number;
  readonly gap_kind: string;
  readonly target_id: string;
  readonly current_confidence: Confidence;
  readonly target_confidence: Confidence;
  readonly current_score: number;
  readonly target_score: number;
  readonly confidence_delta: number;
  readonly reason: string;
  readonly verification_actions: readonly string[];
  readonly read_first_files: readonly string[];
  readonly evidence_ids: readonly string[];
}

interface ServiceCausalityQualitySummary {
  readonly total_claims: number;
  readonly evidence_backed_claims: number;
  readonly unsupported_claims: number;
  readonly weak_evidence_claims: number;
  readonly uncertain_claims: number;
  readonly missing_evidence_claims: number;
  readonly missing_effect_claims: number;
  readonly missing_step_link_claims: number;
  readonly evidence_coverage_score: number;
  readonly confidence_mix: Record<Confidence, number>;
  readonly claim_examples: readonly {
    readonly flow_id: string;
    readonly service_id: string;
    readonly evidence_ids: number;
    readonly effects: number;
    readonly step_ids: number;
    readonly confidence: Confidence;
  }[];
}

interface EvidenceCalibrationClaimSet {
  readonly name: string;
  readonly claims: readonly BrainEntity[];
}

interface EvidenceCalibrationSurface {
  readonly surface: string;
  readonly total_claims: number;
  readonly evidence_backed_claims: number;
  readonly unsupported_claims: number;
  readonly weak_evidence_claims: number;
  readonly evidence_coverage_score: number;
  readonly confidence_mix: Record<Confidence, number>;
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
  'runtime_surfaces',
  'service_causality',
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

function serviceCausalityQualitySummary(
  flows: readonly BrainEntity[],
): ServiceCausalityQualitySummary {
  const claims = flows.flatMap((flow) =>
    safeFlowServiceCausality(flow).map((claim) => ({ flow, claim })),
  );
  const evidenceBackedClaims = claims.filter(({ claim }) => claim.evidence_ids.length > 0);
  const weakEvidenceClaims = evidenceBackedClaims.filter(
    ({ claim }) => claim.confidence !== 'verified',
  );
  const missingEvidenceClaims = claims.filter(({ claim }) => claim.evidence_ids.length === 0);
  const missingEffectClaims = claims.filter(({ claim }) => claim.effects.length === 0);
  const missingStepLinkClaims = claims.filter(({ claim }) => claim.step_ids.length === 0);
  const confidenceMix = countByConfidence(claims.map(({ claim }) => claim.confidence));
  return {
    total_claims: claims.length,
    evidence_backed_claims: evidenceBackedClaims.length,
    unsupported_claims: missingEvidenceClaims.length,
    weak_evidence_claims: weakEvidenceClaims.length,
    uncertain_claims: confidenceMix.uncertain,
    missing_evidence_claims: missingEvidenceClaims.length,
    missing_effect_claims: missingEffectClaims.length,
    missing_step_link_claims: missingStepLinkClaims.length,
    evidence_coverage_score: scorePercent(evidenceBackedClaims.length, claims.length),
    confidence_mix: confidenceMix,
    claim_examples: claims.slice(0, 8).map(({ flow, claim }) => ({
      flow_id: safeText(flow.id),
      service_id: safeText(claim.service_id),
      evidence_ids: claim.evidence_ids.length,
      effects: claim.effects.length,
      step_ids: claim.step_ids.length,
      confidence: claim.confidence,
    })),
  };
}

function serviceCausalityEvidenceGapRecords(flows: readonly BrainEntity[]): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  for (const flow of flows) {
    for (const claim of safeFlowServiceCausality(flow)) {
      const id = `${safeText(flow.id)} service_causality ${safeText(claim.service_id)}`;
      if (claim.evidence_ids.length === 0) {
        gaps.push({
          kind: 'unsupported_service_causality',
          id,
          entity_type: 'flow',
          field: 'service_causality',
          severity: 'high',
          confidence: claim.confidence,
          reason:
            'Service causality claim has no evidence_ids; static reachability cannot be inspected.',
        });
      }
      if (claim.effects.length === 0) {
        gaps.push({
          kind: 'uncertain_service_causality_effect',
          id,
          entity_type: 'flow',
          field: 'service_causality',
          severity: 'medium',
          confidence: claim.confidence,
          reason: 'Service causality claim has no recorded effects, so impact is uncertain.',
        });
      }
      if (claim.step_ids.length === 0) {
        gaps.push({
          kind: 'uncertain_service_causality_step',
          id,
          entity_type: 'flow',
          field: 'service_causality',
          severity: 'medium',
          confidence: claim.confidence,
          reason:
            'Service causality claim is not linked to a reconstructed flow step; treat static-import reachability as uncertain.',
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
  readonly serviceCausalityGaps: readonly EvidenceGap[];
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
      from_entity_id: safeText(relationship.from),
      to_entity_id: safeText(relationship.to),
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
    ...params.serviceCausalityGaps,
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

function evidenceCalibrationSurface(params: {
  readonly surface: string;
  readonly claims: readonly BrainEntity[];
}): EvidenceCalibrationSurface {
  const evidenceBackedClaims = params.claims.filter((claim) => claim.evidence_ids.length > 0);
  const unsupportedClaims = params.claims.length - evidenceBackedClaims.length;
  const weakEvidenceClaims = evidenceBackedClaims.filter(
    (claim) => claim.confidence !== 'verified',
  ).length;
  return {
    surface: safeText(params.surface),
    total_claims: params.claims.length,
    evidence_backed_claims: evidenceBackedClaims.length,
    unsupported_claims: unsupportedClaims,
    weak_evidence_claims: weakEvidenceClaims,
    evidence_coverage_score: scorePercent(evidenceBackedClaims.length, params.claims.length),
    confidence_mix: countByConfidence(params.claims.map((claim) => claim.confidence)),
  };
}

function relationshipCalibrationSurface(
  relationships: readonly BrainRelationship[],
): EvidenceCalibrationSurface {
  const evidenceBackedClaims = relationships.filter(
    (relationship) => relationship.evidence_ids.length > 0,
  );
  const weakEvidenceClaims = evidenceBackedClaims.filter(
    (relationship) => relationship.confidence !== 'verified',
  ).length;
  return {
    surface: 'relationship',
    total_claims: relationships.length,
    evidence_backed_claims: evidenceBackedClaims.length,
    unsupported_claims: relationships.length - evidenceBackedClaims.length,
    weak_evidence_claims: weakEvidenceClaims,
    evidence_coverage_score: scorePercent(evidenceBackedClaims.length, relationships.length),
    confidence_mix: countByConfidence(relationships.map((relationship) => relationship.confidence)),
  };
}

function fieldCalibrationSurface(params: {
  readonly surface: 'component_fields' | 'flow_fields';
  readonly coverage: FieldCoverageSummary;
}): EvidenceCalibrationSurface {
  const confidenceMix: Record<Confidence, number> = {
    verified: params.coverage.fields_with_evidence - params.coverage.weak_evidence_fields,
    inferred: params.coverage.weak_evidence_fields,
    uncertain: params.coverage.unsupported_fields,
  };
  return {
    surface: params.surface,
    total_claims: params.coverage.fields_with_values,
    evidence_backed_claims: params.coverage.fields_with_evidence,
    unsupported_claims: params.coverage.unsupported_fields,
    weak_evidence_claims: params.coverage.weak_evidence_fields,
    evidence_coverage_score: scorePercent(
      params.coverage.fields_with_evidence,
      params.coverage.fields_with_values,
    ),
    confidence_mix: confidenceMix,
  };
}

function evidenceWeakAreaSeverity(params: {
  readonly unsupportedClaims: number;
  readonly weakEvidenceClaims: number;
}): EvidenceGap['severity'] {
  if (params.unsupportedClaims > 0) return 'high';
  if (params.weakEvidenceClaims >= 5) return 'medium';
  return 'low';
}

function evidenceWeakAreaReason(surface: EvidenceCalibrationSurface): string {
  if (surface.unsupported_claims > 0) {
    return `${surface.unsupported_claims} claim(s) have no evidence reference.`;
  }
  if (surface.weak_evidence_claims > 0) {
    return `${surface.weak_evidence_claims} evidence-backed claim(s) are inferred or uncertain.`;
  }
  return 'No weak evidence area detected.';
}

function topEvidenceWeakAreas(
  surfaces: readonly EvidenceCalibrationSurface[],
): Array<Record<string, unknown>> {
  return surfaces
    .filter((surface) => surface.unsupported_claims > 0 || surface.weak_evidence_claims > 0)
    .map((surface) => ({
      surface: surface.surface,
      severity: evidenceWeakAreaSeverity({
        unsupportedClaims: surface.unsupported_claims,
        weakEvidenceClaims: surface.weak_evidence_claims,
      }),
      unsupported_claims: surface.unsupported_claims,
      weak_evidence_claims: surface.weak_evidence_claims,
      evidence_coverage_score: surface.evidence_coverage_score,
      reason: evidenceWeakAreaReason(surface),
    }))
    .sort((a, b) => {
      const aUnsupported = typeof a.unsupported_claims === 'number' ? a.unsupported_claims : 0;
      const bUnsupported = typeof b.unsupported_claims === 'number' ? b.unsupported_claims : 0;
      const aWeak = typeof a.weak_evidence_claims === 'number' ? a.weak_evidence_claims : 0;
      const bWeak = typeof b.weak_evidence_claims === 'number' ? b.weak_evidence_claims : 0;
      const aCoverage =
        typeof a.evidence_coverage_score === 'number' ? a.evidence_coverage_score : 0;
      const bCoverage =
        typeof b.evidence_coverage_score === 'number' ? b.evidence_coverage_score : 0;
      const aSurface = typeof a.surface === 'string' ? a.surface : '';
      const bSurface = typeof b.surface === 'string' ? b.surface : '';
      return (
        bUnsupported - aUnsupported ||
        bWeak - aWeak ||
        aCoverage - bCoverage ||
        aSurface.localeCompare(bSurface)
      );
    })
    .slice(0, 8);
}

function evidenceInspectHint(gap: EvidenceGap): string {
  if (gap.kind === 'missing_reference') {
    return 'Find the claim that references this evidence id and confirm the evidence record exists.';
  }
  if (gap.kind === 'unsupported_relationship') {
    return 'Inspect the relationship source and add or verify direct evidence for the link.';
  }
  if (gap.kind === 'unsupported_field') {
    return 'Inspect the field-specific evidence map for this component or flow.';
  }
  if (gap.kind === 'unsupported_service_causality') {
    return 'Inspect the flow service_causality entry and attach direct source evidence for the service reachability claim.';
  }
  if (
    gap.kind === 'uncertain_service_causality_effect' ||
    gap.kind === 'uncertain_service_causality_step'
  ) {
    return 'Inspect the service_causality effects and step_ids before relying on service impact claims.';
  }
  return 'Inspect the entity evidence_ids and source files before relying on this claim.';
}

function inspectFirstEvidenceGaps(gaps: readonly EvidenceGap[]): Array<Record<string, unknown>> {
  return gaps.slice(0, 8).map((gap, index) => ({
    priority: index + 1,
    kind: safeText(gap.kind),
    id: safeText(gap.id),
    ...(gap.field === undefined ? {} : { field: safeText(gap.field) }),
    severity: gap.severity,
    reason: safeText(gap.reason),
    inspect_hint: evidenceInspectHint(gap),
  }));
}

function evidenceRedactionImpact(params: {
  readonly redactedEvidenceCount: number;
  readonly redactedReferenceCount: number;
  readonly unsafeSensitiveReferenceCount: number;
  readonly confidenceDowngradeCount: number;
  readonly redactionSafetyScore: number;
}): Record<string, unknown> {
  let impact = 'none';
  if (params.unsafeSensitiveReferenceCount > 0) impact = 'unsafe';
  if (
    params.unsafeSensitiveReferenceCount === 0 &&
    (params.redactedEvidenceCount > 0 || params.redactedReferenceCount > 0)
  ) {
    impact = 'contained';
  }
  return {
    impact,
    redaction_safety_score: params.redactionSafetyScore,
    redacted_evidence_count: params.redactedEvidenceCount,
    redacted_reference_count: params.redactedReferenceCount,
    unsafe_sensitive_reference_count: params.unsafeSensitiveReferenceCount,
    confidence_downgrades: params.confidenceDowngradeCount,
    note:
      impact === 'unsafe'
        ? 'Unsafe sensitive references remain and should be fixed before sharing artifacts.'
        : 'Sensitive evidence is represented through redacted ids and does not expose raw secrets.',
  };
}

function buildEvidenceCalibrationBreakdown(params: {
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
  readonly fieldCoverage: Record<'component' | 'flow', FieldCoverageSummary>;
  readonly serviceCausalityQuality: ServiceCausalityQualitySummary;
  readonly topGaps: readonly EvidenceGap[];
  readonly redactedEvidenceCount: number;
  readonly redactedReferenceCount: number;
  readonly unsafeSensitiveReferenceCount: number;
  readonly confidenceDowngradeCount: number;
  readonly evidenceCoverageScore: number;
  readonly redactionSafetyScore: number;
  readonly referenceIntegrityScore: number;
  readonly fieldEvidenceScore: number;
}): Record<string, unknown> {
  const claimSets: readonly EvidenceCalibrationClaimSet[] = [
    {
      name: 'project_map',
      claims: [
        ...params.buckets.projects,
        ...params.buckets.files,
        ...params.buckets.folders,
        ...params.buckets.configs,
        ...params.buckets.dependencies,
      ],
    },
    {
      name: 'architecture_surface',
      claims: [
        ...params.buckets.components,
        ...params.buckets.services,
        ...params.buckets.apis,
        ...params.buckets.databaseTables,
        ...params.buckets.flows,
      ],
    },
    {
      name: 'execution_surface',
      claims: [...params.buckets.commands, ...params.buckets.tests],
    },
    {
      name: 'review_surface',
      claims: [
        ...params.buckets.decisions,
        ...params.buckets.risks,
        ...params.buckets.reviews,
        ...params.buckets.findings,
        ...params.buckets.status,
      ],
    },
    {
      name: 'workspace_surface',
      claims: [
        ...params.buckets.agents,
        ...params.buckets.tasks,
        ...params.buckets.sessions,
        ...params.buckets.handoffs,
      ],
    },
    { name: 'evidence_records', claims: params.buckets.evidence },
  ];
  const categorySurfaces = claimSets.map((claimSet) =>
    evidenceCalibrationSurface({ surface: claimSet.name, claims: claimSet.claims }),
  );
  const surfaceMix = [
    evidenceCalibrationSurface({ surface: 'component', claims: params.buckets.components }),
    evidenceCalibrationSurface({ surface: 'flow', claims: params.buckets.flows }),
    relationshipCalibrationSurface(params.relationships),
    fieldCalibrationSurface({
      surface: 'component_fields',
      coverage: params.fieldCoverage.component,
    }),
    fieldCalibrationSurface({ surface: 'flow_fields', coverage: params.fieldCoverage.flow }),
    {
      surface: 'service_causality',
      total_claims: params.serviceCausalityQuality.total_claims,
      evidence_backed_claims: params.serviceCausalityQuality.evidence_backed_claims,
      unsupported_claims: params.serviceCausalityQuality.unsupported_claims,
      weak_evidence_claims: params.serviceCausalityQuality.weak_evidence_claims,
      evidence_coverage_score: params.serviceCausalityQuality.evidence_coverage_score,
      confidence_mix: params.serviceCausalityQuality.confidence_mix,
    },
  ];
  const allSurfaces = [...categorySurfaces, ...surfaceMix];
  const weakAreas = topEvidenceWeakAreas(allSurfaces);
  return {
    calibration_version: 1,
    scoring_inputs: {
      evidence_coverage_score: params.evidenceCoverageScore,
      redaction_safety_score: params.redactionSafetyScore,
      reference_integrity_score: params.referenceIntegrityScore,
      field_evidence_score: params.fieldEvidenceScore,
    },
    claim_categories: categorySurfaces,
    surface_confidence_mix: surfaceMix,
    weak_evidence_areas: weakAreas,
    redaction_impact: evidenceRedactionImpact({
      redactedEvidenceCount: params.redactedEvidenceCount,
      redactedReferenceCount: params.redactedReferenceCount,
      unsafeSensitiveReferenceCount: params.unsafeSensitiveReferenceCount,
      confidenceDowngradeCount: params.confidenceDowngradeCount,
      redactionSafetyScore: params.redactionSafetyScore,
    }),
    inspect_first: inspectFirstEvidenceGaps(params.topGaps),
    summary: `${weakAreas.length} weak evidence area(s); ${params.topGaps.length} prioritized evidence gap(s).`,
  };
}

function unbackedClaimGroups(params: {
  readonly claimEntitiesWithoutEvidence: readonly BrainEntity[];
  readonly relationshipsWithoutEvidence: readonly BrainRelationship[];
  readonly fieldCoverage: Record<'component' | 'flow', FieldCoverageSummary>;
  readonly serviceCausalityQuality: ServiceCausalityQualitySummary;
}): Array<Record<string, unknown>> {
  const entityGroups = Object.entries(
    countByValue(params.claimEntitiesWithoutEvidence.map((entity) => entity.type)),
  ).map(([type, claimCount]) => {
    const examples = params.claimEntitiesWithoutEvidence
      .filter((entity) => entity.type === type)
      .map((entity) => safeText(entity.id))
      .slice(0, 5);
    return {
      group: `${safeText(type)} claims`,
      claim_count: claimCount,
      example_ids: examples,
      inspect_hint: `Inspect ${safeText(type)} entities and add direct evidence_ids for claims users may rely on.`,
    };
  });
  const relationshipGroup =
    params.relationshipsWithoutEvidence.length === 0
      ? []
      : [
          {
            group: 'relationship claims',
            claim_count: params.relationshipsWithoutEvidence.length,
            example_ids: params.relationshipsWithoutEvidence
              .slice(0, 5)
              .map(
                (relationship) =>
                  `${safeText(relationship.from)} ${relationship.relation} ${safeText(
                    relationship.to,
                  )}`,
              ),
            inspect_hint:
              'Inspect dependency and ownership edges first; unsupported links can mislead review blast-radius decisions.',
          },
        ];
  const fieldGroups = [
    {
      group: 'component field claims',
      claim_count: params.fieldCoverage.component.unsupported_fields,
      example_ids: [],
      inspect_hint:
        'Inspect component field_evidence maps for populated fields that lack field-specific evidence.',
    },
    {
      group: 'flow field claims',
      claim_count: params.fieldCoverage.flow.unsupported_fields,
      example_ids: [],
      inspect_hint:
        'Inspect flow field_evidence maps for populated flow steps, tests, contracts, or risks without evidence.',
    },
  ].filter((group) => group.claim_count > 0);
  const serviceCausalityGroup =
    params.serviceCausalityQuality.unsupported_claims === 0
      ? []
      : [
          {
            group: 'service causality claims',
            claim_count: params.serviceCausalityQuality.unsupported_claims,
            example_ids: params.serviceCausalityQuality.claim_examples
              .filter((claim) => claim.evidence_ids === 0)
              .map((claim) => `${claim.flow_id} -> ${claim.service_id}`)
              .slice(0, 5),
            inspect_hint:
              'Inspect flow service_causality entries and add direct evidence_ids for static service reachability claims.',
          },
        ];
  return [...entityGroups, ...relationshipGroup, ...fieldGroups, ...serviceCausalityGroup]
    .sort((a, b) => {
      const aCount = typeof a.claim_count === 'number' ? a.claim_count : 0;
      const bCount = typeof b.claim_count === 'number' ? b.claim_count : 0;
      const aGroup = typeof a.group === 'string' ? a.group : '';
      const bGroup = typeof b.group === 'string' ? b.group : '';
      return bCount - aCount || aGroup.localeCompare(bGroup);
    })
    .slice(0, 10);
}

function lowConfidenceClaimAreas(params: {
  readonly claimEntitiesWithWeakEvidence: readonly BrainEntity[];
  readonly relationshipsWithWeakEvidence: readonly BrainRelationship[];
  readonly fieldCoverage: Record<'component' | 'flow', FieldCoverageSummary>;
  readonly serviceCausalityQuality: ServiceCausalityQualitySummary;
}): Array<Record<string, unknown>> {
  const entityGroups = Object.entries(
    countByValue(params.claimEntitiesWithWeakEvidence.map((entity) => entity.type)),
  ).map(([type, claimCount]) => {
    const entities = params.claimEntitiesWithWeakEvidence.filter((entity) => entity.type === type);
    return {
      area: `${safeText(type)} evidence-backed claims`,
      claim_count: claimCount,
      confidence_mix: countByConfidence(entities.map((entity) => entity.confidence)),
      example_ids: entities.map((entity) => safeText(entity.id)).slice(0, 5),
      inspect_hint: `Confirm ${safeText(type)} evidence in source before treating inferred claims as verified.`,
    };
  });
  const relationshipArea =
    params.relationshipsWithWeakEvidence.length === 0
      ? []
      : [
          {
            area: 'relationship evidence-backed claims',
            claim_count: params.relationshipsWithWeakEvidence.length,
            confidence_mix: countByConfidence(
              params.relationshipsWithWeakEvidence.map((relationship) => relationship.confidence),
            ),
            example_ids: params.relationshipsWithWeakEvidence
              .slice(0, 5)
              .map(
                (relationship) =>
                  `${safeText(relationship.from)} ${relationship.relation} ${safeText(
                    relationship.to,
                  )}`,
              ),
            inspect_hint:
              'Confirm inferred relationships against source imports, manifests, or tests before using them for review scope.',
          },
        ];
  const fieldAreas = [
    {
      area: 'component field evidence',
      claim_count: params.fieldCoverage.component.weak_evidence_fields,
      confidence_mix: {
        verified:
          params.fieldCoverage.component.fields_with_evidence -
          params.fieldCoverage.component.weak_evidence_fields,
        inferred: params.fieldCoverage.component.weak_evidence_fields,
        uncertain: params.fieldCoverage.component.unsupported_fields,
      },
      example_ids: [],
      inspect_hint:
        'Confirm component fields backed by inferred component evidence before promoting them to verified.',
    },
    {
      area: 'flow field evidence',
      claim_count: params.fieldCoverage.flow.weak_evidence_fields,
      confidence_mix: {
        verified:
          params.fieldCoverage.flow.fields_with_evidence -
          params.fieldCoverage.flow.weak_evidence_fields,
        inferred: params.fieldCoverage.flow.weak_evidence_fields,
        uncertain: params.fieldCoverage.flow.unsupported_fields,
      },
      example_ids: [],
      inspect_hint:
        'Confirm flow fields backed by inferred flow evidence before using them as execution certainty.',
    },
  ].filter((area) => area.claim_count > 0);
  const serviceCausalityArea =
    params.serviceCausalityQuality.weak_evidence_claims === 0
      ? []
      : [
          {
            area: 'service causality evidence-backed claims',
            claim_count: params.serviceCausalityQuality.weak_evidence_claims,
            confidence_mix: params.serviceCausalityQuality.confidence_mix,
            example_ids: params.serviceCausalityQuality.claim_examples
              .map((claim) => `${claim.flow_id} -> ${claim.service_id}`)
              .slice(0, 5),
            inspect_hint:
              'Treat static-import service causality as inferred until runtime traces, smoke checks, or direct behavior tests verify it.',
          },
        ];
  return [...entityGroups, ...relationshipArea, ...fieldAreas, ...serviceCausalityArea]
    .sort((a, b) => {
      const aCount = typeof a.claim_count === 'number' ? a.claim_count : 0;
      const bCount = typeof b.claim_count === 'number' ? b.claim_count : 0;
      const aArea = typeof a.area === 'string' ? a.area : '';
      const bArea = typeof b.area === 'string' ? b.area : '';
      return bCount - aCount || aArea.localeCompare(bArea);
    })
    .slice(0, 10);
}

function readFirstEntityTargets(params: {
  readonly gap: EvidenceGap;
  readonly entitiesById: ReadonlyMap<string, BrainEntity>;
}): BrainEntity[] {
  const targetIds = unique([
    params.gap.id,
    ...(params.gap.from_entity_id === undefined ? [] : [params.gap.from_entity_id]),
    ...(params.gap.to_entity_id === undefined ? [] : [params.gap.to_entity_id]),
  ]);
  return targetIds
    .map((id) => params.entitiesById.get(id))
    .filter((entity): entity is BrainEntity => entity !== undefined);
}

function readFirstFilesForEntity(entity: BrainEntity): string[] {
  return unique([
    ...entity.source_files,
    ...stringArrayData(entity, 'read_first'),
    ...stringArrayData(entity, 'important_files'),
    ...stringArrayData(entity, 'files'),
  ])
    .map(safeText)
    .slice(0, 5);
}

function uniqueById(entities: readonly BrainEntity[]): BrainEntity[] {
  const byId = new Map<string, BrainEntity>();
  for (const entity of entities) byId.set(entity.id, entity);
  return [...byId.values()];
}

function suggestedReadFirstForEvidenceGaps(params: {
  readonly topGaps: readonly EvidenceGap[];
  readonly entitiesById: ReadonlyMap<string, BrainEntity>;
}): Array<Record<string, unknown>> {
  return params.topGaps.slice(0, 8).map((gap, index) => {
    const targets = readFirstEntityTargets({ gap, entitiesById: params.entitiesById });
    const files = unique(targets.flatMap(readFirstFilesForEntity)).slice(0, 6);
    return {
      priority: index + 1,
      gap_kind: safeText(gap.kind),
      target_id: safeText(gap.id),
      ...(gap.field === undefined ? {} : { field: safeText(gap.field) }),
      target_entities: targets.map((entity) => safeText(entity.id)).slice(0, 5),
      read_first_files: files,
      evidence_ids: unique(targets.flatMap((entity) => entity.evidence_ids.map(safeText))).slice(
        0,
        8,
      ),
      confidence: gap.confidence ?? 'uncertain',
      reason: safeText(gap.reason),
      inspect_hint: evidenceInspectHint(gap),
    };
  });
}

function confidenceDeltaTargetForGap(gap: EvidenceGap): Confidence {
  if (gap.confidence === 'verified') return 'verified';
  if (
    gap.kind === 'missing_reference' ||
    gap.kind === 'unsupported_relationship' ||
    gap.kind === 'unsupported_service_causality'
  ) {
    return 'verified';
  }
  return 'inferred';
}

function serviceCausalityFlowIdFromGap(gap: EvidenceGap): string | undefined {
  const marker = ' service_causality ';
  if (!gap.id.includes(marker)) return undefined;
  const flowId = gap.id.slice(0, gap.id.indexOf(marker));
  return flowId === '' ? undefined : flowId;
}

function evidenceVerificationActionsForGap(params: {
  readonly gap: EvidenceGap;
  readonly targetEntities: readonly BrainEntity[];
}): string[] {
  const explainTargets = params.targetEntities
    .map((entity) => {
      if (entity.type === 'flow') return `rizz explain ${entity.id}`;
      if (entity.source_files.length > 0) return `rizz explain ${entity.source_files[0]}`;
      return `rizz explain ${entity.id}`;
    })
    .slice(0, 3);
  return uniqueInOrder([
    evidenceInspectHint(params.gap),
    ...explainTargets,
    ...(params.gap.kind === 'unsupported_relationship'
      ? ['Confirm the relationship against imports, manifests, tests, or direct source evidence.']
      : []),
    ...(params.gap.kind === 'unsupported_field'
      ? ['Add field-specific evidence_ids before using this field as review guidance.']
      : []),
    ...(params.gap.kind.includes('service_causality')
      ? ['Run or inspect the route/service behavior before upgrading service-causality confidence.']
      : []),
  ]).map(safeText);
}

function evidenceConfidenceDeltasForGaps(params: {
  readonly topGaps: readonly EvidenceGap[];
  readonly entitiesById: ReadonlyMap<string, BrainEntity>;
}): EvidenceConfidenceDelta[] {
  return params.topGaps.slice(0, 10).map((gap, index) => {
    const serviceFlowId = serviceCausalityFlowIdFromGap(gap);
    const directTargets = readFirstEntityTargets({ gap, entitiesById: params.entitiesById });
    const serviceFlow =
      serviceFlowId === undefined ? undefined : params.entitiesById.get(serviceFlowId);
    const targetEntities = uniqueById([
      ...directTargets,
      ...(serviceFlow === undefined ? [] : [serviceFlow]),
    ]);
    const currentConfidence = gap.confidence ?? 'uncertain';
    const targetConfidence = confidenceDeltaTargetForGap(gap);
    const currentScore = confidenceScoreForValue(currentConfidence);
    const targetScore = confidenceScoreForValue(targetConfidence);
    return {
      priority: index + 1,
      gap_kind: safeText(gap.kind),
      target_id: safeText(gap.id),
      current_confidence: currentConfidence,
      target_confidence: targetConfidence,
      current_score: Number(currentScore.toFixed(2)),
      target_score: Number(targetScore.toFixed(2)),
      confidence_delta: Math.max(0, Math.round((targetScore - currentScore) * 100)),
      reason: safeText(gap.reason),
      verification_actions: evidenceVerificationActionsForGap({ gap, targetEntities }),
      read_first_files: unique(targetEntities.flatMap(readFirstFilesForEntity)).slice(0, 6),
      evidence_ids: unique(
        targetEntities.flatMap((entity) => entity.evidence_ids.map(safeText)),
      ).slice(0, 8),
    };
  });
}

function redactionHiddenEvidenceSummary(params: {
  readonly redactedEvidenceCount: number;
  readonly redactedReferenceCount: number;
  readonly unsafeSensitiveReferenceCount: number;
  readonly confidenceDowngradeCount: number;
  readonly redactionSafetyScore: number;
}): Record<string, unknown> {
  const hiddenCount = params.redactedEvidenceCount + params.redactedReferenceCount;
  let impact = 'none';
  if (params.unsafeSensitiveReferenceCount > 0) impact = 'unsafe';
  if (params.unsafeSensitiveReferenceCount === 0 && hiddenCount > 0) impact = 'contained';
  return {
    hidden_evidence_count: hiddenCount,
    redacted_evidence_count: params.redactedEvidenceCount,
    redacted_reference_count: params.redactedReferenceCount,
    unsafe_sensitive_reference_count: params.unsafeSensitiveReferenceCount,
    confidence_downgrades: params.confidenceDowngradeCount,
    redaction_safety_score: params.redactionSafetyScore,
    impact,
    user_impact:
      impact === 'contained'
        ? 'Some evidence is intentionally hidden behind redacted ids; inspect nearby non-sensitive files or rerun in a trusted local context before upgrading confidence.'
        : 'No redaction-hidden evidence is limiting confidence.',
  };
}

function calibrationSummary(params: {
  readonly overallScore: number;
  readonly qualityBand: string;
  readonly evidenceCoverageScore: number;
  readonly fieldEvidenceScore: number;
  readonly referenceIntegrityScore: number;
  readonly redactionSafetyScore: number;
  readonly unsupportedClaims: number;
  readonly weakEvidenceClaims: number;
  readonly evidenceGapCount: number;
  readonly confidenceDistribution: Record<Confidence, number>;
}): Record<string, unknown> {
  return {
    overall_score: params.overallScore,
    quality_band: safeText(params.qualityBand),
    evidence_coverage_score: params.evidenceCoverageScore,
    field_evidence_score: params.fieldEvidenceScore,
    reference_integrity_score: params.referenceIntegrityScore,
    redaction_safety_score: params.redactionSafetyScore,
    unsupported_claims: params.unsupportedClaims,
    weak_evidence_claims: params.weakEvidenceClaims,
    evidence_gap_count: params.evidenceGapCount,
    confidence_distribution: params.confidenceDistribution,
    summary: `${params.unsupportedClaims} unsupported claim(s), ${params.weakEvidenceClaims} weak evidence claim(s), and ${params.evidenceGapCount} total actionability gap(s) limit confidence.`,
    calibration_rule:
      'Evidence confidence is calibrated from direct evidence coverage, field-specific evidence, missing references, claim confidence, and secret-safe redaction impact.',
  };
}

function buildEvidenceQualityArtifact(params: {
  readonly now: string;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
}): Record<string, unknown> {
  const entities = allBucketEntities(params.buckets);
  const claimEntities = entities.filter((entity) => entity.type !== 'evidence');
  const fieldEvidenceEntries = [
    ...params.buckets.components.flatMap((component) =>
      Object.values(recordStringArrayData(component, 'field_evidence')),
    ),
    ...params.buckets.flows.flatMap((flow) =>
      Object.values(recordStringArrayData(flow, 'field_evidence')),
    ),
  ];
  const fieldEvidenceIds = unique(fieldEvidenceEntries.flat());
  const referencedEvidenceIds = unique([
    ...entities.flatMap((entity) => entity.evidence_ids),
    ...params.relationships.flatMap((relationship) => relationship.evidence_ids),
    ...fieldEvidenceIds,
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
  const serviceCausalityQuality = serviceCausalityQualitySummary(params.buckets.flows);
  const serviceCausalityGaps = serviceCausalityEvidenceGapRecords(params.buckets.flows);
  const unsupportedFieldClaims =
    fieldCoverage.component.unsupported_fields + fieldCoverage.flow.unsupported_fields;
  const weakEvidenceFieldClaims =
    fieldCoverage.component.weak_evidence_fields + fieldCoverage.flow.weak_evidence_fields;
  const unsupportedClaims =
    claimEntitiesWithoutEvidence.length +
    relationshipsWithoutEvidence.length +
    unsupportedFieldClaims +
    serviceCausalityQuality.unsupported_claims;
  const weakEvidenceClaims =
    claimEntitiesWithWeakEvidence.length +
    relationshipsWithWeakEvidence.length +
    weakEvidenceFieldClaims +
    serviceCausalityQuality.weak_evidence_claims;
  const evidenceGapCount =
    missingEvidenceReferences.length +
    unsupportedClaims +
    weakEvidenceClaims +
    serviceCausalityQuality.missing_effect_claims +
    serviceCausalityQuality.missing_step_link_claims;
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
    ...serviceCausalityGaps.slice(0, 8).map((gap) => `service causality: ${gap.id} (${gap.kind})`),
    ...missingEvidenceReferences.slice(0, 8).map((id) => `missing evidence: ${id}`),
  ]).slice(0, 12);
  const topGaps = topEvidenceGaps({
    entitiesWithoutEvidence,
    relationshipsWithoutEvidence,
    missingEvidenceReferences,
    fieldGaps,
    serviceCausalityGaps,
  });
  const evidenceCalibration = buildEvidenceCalibrationBreakdown({
    buckets: params.buckets,
    relationships: params.relationships,
    fieldCoverage,
    serviceCausalityQuality,
    topGaps,
    redactedEvidenceCount,
    redactedReferenceCount,
    unsafeSensitiveReferenceCount,
    confidenceDowngradeCount,
    evidenceCoverageScore,
    redactionSafetyScore,
    referenceIntegrityScore,
    fieldEvidenceScore,
  });
  const qualityBand = evidenceQualityBand(overallScore, redactionSafetyScore);
  const unbackedGroups = unbackedClaimGroups({
    claimEntitiesWithoutEvidence,
    relationshipsWithoutEvidence,
    fieldCoverage,
    serviceCausalityQuality,
  });
  const lowConfidenceAreas = lowConfidenceClaimAreas({
    claimEntitiesWithWeakEvidence,
    relationshipsWithWeakEvidence,
    fieldCoverage,
    serviceCausalityQuality,
  });
  const redactionHiddenEvidence = redactionHiddenEvidenceSummary({
    redactedEvidenceCount,
    redactedReferenceCount,
    unsafeSensitiveReferenceCount,
    confidenceDowngradeCount,
    redactionSafetyScore,
  });
  const evidenceCalibrationSummary = calibrationSummary({
    overallScore,
    qualityBand,
    evidenceCoverageScore,
    fieldEvidenceScore,
    referenceIntegrityScore,
    redactionSafetyScore,
    unsupportedClaims,
    weakEvidenceClaims,
    evidenceGapCount,
    confidenceDistribution,
  });
  const suggestedReadFirst = suggestedReadFirstForEvidenceGaps({
    topGaps,
    entitiesById: entityById(entities),
  });
  const evidenceConfidenceDeltas = evidenceConfidenceDeltasForGaps({
    topGaps,
    entitiesById: entityById(entities),
  });
  const actionabilitySummary =
    evidenceGapCount === 0
      ? 'No evidence actionability gaps were detected in local research artifacts.'
      : `${topGaps.length} prioritized evidence gap(s), ${unbackedGroups.length} unbacked claim group(s), and ${lowConfidenceAreas.length} low-confidence area(s) need inspection.`;

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
    service_causality_quality: serviceCausalityQuality,
    service_causality_claim_count: serviceCausalityQuality.total_claims,
    service_causality_evidence_backed_claims: serviceCausalityQuality.evidence_backed_claims,
    service_causality_uncertain_claims: serviceCausalityQuality.uncertain_claims,
    service_causality_missing_evidence_claims: serviceCausalityQuality.missing_evidence_claims,
    service_causality_missing_effect_claims: serviceCausalityQuality.missing_effect_claims,
    service_causality_missing_step_link_claims: serviceCausalityQuality.missing_step_link_claims,
    service_causality_coverage_score: serviceCausalityQuality.evidence_coverage_score,
    evidence_calibration: evidenceCalibration,
    actionability: {
      summary: actionabilitySummary,
      top_evidence_gaps: topGaps,
      unbacked_claim_groups: unbackedGroups,
      low_confidence_claim_areas: lowConfidenceAreas,
      redaction_hidden_evidence: redactionHiddenEvidence,
      suggested_read_first: suggestedReadFirst,
      evidence_confidence_deltas: evidenceConfidenceDeltas,
      calibration_summary: evidenceCalibrationSummary,
    },
    unbacked_claim_groups: unbackedGroups,
    low_confidence_claim_areas: lowConfidenceAreas,
    redaction_hidden_evidence: redactionHiddenEvidence,
    suggested_read_first: suggestedReadFirst,
    evidence_confidence_deltas: evidenceConfidenceDeltas,
    calibration_summary: evidenceCalibrationSummary,
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
    quality_band: qualityBand,
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
  const services = params.buckets.services.filter((service) => service.latest_status !== 'stale');
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

function buildServiceIntelligenceArtifact(params: {
  readonly now: string;
  readonly buckets: BrainBuckets;
}): Record<string, unknown> {
  const services = params.buckets.services.filter((service) => service.latest_status !== 'stale');
  const flows = params.buckets.flows.filter((flow) => flow.latest_status !== 'stale');
  const servicesWithFlows = services.filter(
    (service) => serviceDataStringArray(service, 'related_flows').length > 0,
  );
  const servicesWithRoutes = services.filter(
    (service) => serviceDataStringArray(service, 'routes').length > 0,
  );
  const servicesWithStorage = services.filter(
    (service) => serviceDataStringArray(service, 'storage_dependencies').length > 0,
  );
  const servicesWithExternalApis = services.filter(
    (service) => serviceDataStringArray(service, 'external_services').length > 0,
  );
  const servicesWithEvidence = services.filter((service) => service.evidence_ids.length > 0);
  const confidenceDistribution = countByConfidence(services.map((service) => service.confidence));
  const fieldSlots = services.length * 8;
  const coveredFieldSlots = services.reduce(
    (count, service) =>
      count +
      [
        'entrypoints',
        'routes',
        'jobs',
        'storage_dependencies',
        'environment_variables',
        'external_services',
        'deployment_configs',
        'related_flows',
      ].filter((field) => serviceDataStringArray(service, field).length > 0).length,
    0,
  );
  const serviceUnderstandingScore = boundedScore(
    scorePercent(coveredFieldSlots, fieldSlots) * 0.45 +
      scorePercent(servicesWithEvidence.length, services.length) * 0.25 +
      scorePercent(servicesWithFlows.length, services.length) * 0.3,
  );

  return {
    schema_version: 1,
    generated_at: params.now,
    total_services: services.length,
    service_understanding_score: serviceUnderstandingScore,
    services_with_routes: servicesWithRoutes.length,
    services_with_storage: servicesWithStorage.length,
    services_with_external_apis: servicesWithExternalApis.length,
    services_with_related_flows: servicesWithFlows.length,
    confidence_distribution: confidenceDistribution,
    flow_links: flows.map((flow) => ({
      flow_id: flow.id,
      service_ids: flowStringArray(flow, 'services'),
      evidence_ids: flow.evidence_ids,
    })),
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      runtime: stringData(service, 'runtime') ?? 'unknown',
      framework: stringData(service, 'framework') ?? 'unknown',
      service_root: stringData(service, 'service_root') ?? service.name,
      entrypoints: serviceDataStringArray(service, 'entrypoints'),
      routes: serviceDataStringArray(service, 'routes'),
      jobs: serviceDataStringArray(service, 'jobs'),
      storage_dependencies: serviceDataStringArray(service, 'storage_dependencies'),
      environment_variables: serviceDataStringArray(service, 'environment_variables'),
      external_services: serviceDataStringArray(service, 'external_services'),
      deployment_configs: serviceDataStringArray(service, 'deployment_configs'),
      related_flows: serviceDataStringArray(service, 'related_flows'),
      related_components: serviceDataStringArray(service, 'related_components'),
      risks: serviceDataStringArray(service, 'risks'),
      unknowns: serviceDataStringArray(service, 'unknowns'),
      confidence: service.confidence,
      confidence_score:
        numberData(service, 'confidence_score') ?? confidenceScoreForValue(service.confidence),
      evidence_ids: service.evidence_ids,
      field_evidence: recordStringArrayData(service, 'field_evidence'),
    })),
    unknowns: unique(
      services.flatMap((service) =>
        serviceDataStringArray(service, 'unknowns').map((unknown) => `${service.id}: ${unknown}`),
      ),
    ).slice(0, 12),
    scoring_notes: [
      'Service Intelligence is deterministic static inference from service-like files, routes, jobs, storage/API/env evidence, deployment configs, and flow links.',
      'Runtime reachability is not executed; weak or missing evidence remains visible as unknowns.',
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

function isNextAppRouterFlow(flow: BrainEntity): boolean {
  return stringData(flow, 'framework') === 'nextjs-app-router';
}

function isArchitectureRouteFlow(flow: BrainEntity): boolean {
  return stringData(flow, 'route_path') !== undefined;
}

function routePathForFlow(flow: BrainEntity): string {
  return stringData(flow, 'route_path') ?? 'unknown route';
}

function routeTypeForFlow(flow: BrainEntity): string {
  return stringData(flow, 'route_type') ?? 'unknown';
}

function routeFlowEntryLabels(flow: BrainEntity): string[] {
  return safeFlowEntrypoints(flow).map((entrypoint) => safeText(formatFlowEntrypoint(entrypoint)));
}

function routeArchitectureConfidence(flow: BrainEntity): Confidence {
  return weakestConfidence([
    flow.confidence,
    flowStringArray(flow, 'tests').length > 0 ? 'verified' : 'inferred',
    flowStringArray(flow, 'configs').length > 0 ? 'verified' : 'inferred',
  ]);
}

function routeArchitectureScore(flow: BrainEntity): number {
  const testAdjustment = flowStringArray(flow, 'tests').length > 0 ? 0 : 0.12;
  const configAdjustment = flowStringArray(flow, 'configs').length > 0 ? 0 : 0.08;
  return Math.max(
    0.1,
    Number((asFlowConfidenceScore(flow) - testAdjustment - configAdjustment).toFixed(2)),
  );
}

function routeArchitectureGapIds(flow: BrainEntity): string[] {
  const gapIds: string[] = [];
  if (flowStringArray(flow, 'tests').length === 0) {
    gapIds.push(`gap:${safeText(flow.id)}:route-tests`);
  }
  if (flowStringArray(flow, 'configs').length === 0) {
    gapIds.push(`gap:${safeText(flow.id)}:route-config`);
  }
  if (flow.confidence !== 'verified') {
    gapIds.push(`gap:${safeText(flow.id)}:runtime-verification`);
  }
  return gapIds;
}

function routeArchitectureAssumptions(flows: readonly BrainEntity[]): ArchitectureAssumption[] {
  return sorted(
    flows.filter(isNextAppRouterFlow).map((flow) => {
      const routePath = routePathForFlow(flow);
      const routeType = routeTypeForFlow(flow);
      const components = flowStringArray(flow, 'components');
      const configs = flowStringArray(flow, 'configs');
      const tests = flowStringArray(flow, 'tests');
      const files = flowStringArray(flow, 'files');
      const confidence = routeArchitectureConfidence(flow);
      return {
        assumption_id: `assumption:${safeText(flow.id)}:route-architecture`,
        entity_id: safeText(flow.id),
        assumption: safeText(
          `${routePath} is treated as a Next.js ${routeType} architecture surface because the app-router entrypoint, imports, configs, tests, and confidence evidence reconstruct a route flow.`,
        ),
        inferred_from: unique([
          'nextjs app router',
          `route_path:${routePath}`,
          `route_type:${routeType}`,
          `entrypoints:${safeFlowEntrypoints(flow).length}`,
          `components:${components.length}`,
          `configs:${configs.length}`,
          `tests:${tests.length}`,
        ]).map(safeText),
        evidence_ids: evidenceIdsForFlow(flow).slice(0, 12),
        evidence_gap_ids: routeArchitectureGapIds(flow),
        confidence,
        confidence_score: routeArchitectureScore(flow),
        rules: [
          'framework:nextjs-app-router',
          `route_type:${safeText(routeType)}`,
          `components:${components.length}`,
          `files:${files.length}`,
          `configs:${configs.length}`,
          `tests:${tests.length}`,
        ],
        unknowns: unique([
          ...(tests.length === 0
            ? [`No directly linked test artifact was detected for route ${routePath}.`]
            : []),
          ...(configs.length === 0
            ? [`No config or manifest artifact was linked to route ${routePath}.`]
            : []),
          ...(flow.confidence === 'verified'
            ? []
            : [`Route ${routePath} is statically reconstructed and not runtime verified.`]),
        ]).map(safeText),
      };
    }),
    (assumption) => assumption.assumption_id,
  );
}

function routeArchitectureRecords(flows: readonly BrainEntity[]): Array<Record<string, unknown>> {
  return sorted(
    flows.filter(isNextAppRouterFlow).map((flow) => {
      const routePath = routePathForFlow(flow);
      const routeType = routeTypeForFlow(flow);
      const components = flowStringArray(flow, 'components');
      const files = flowStringArray(flow, 'files');
      const configs = flowStringArray(flow, 'configs');
      const tests = flowStringArray(flow, 'tests');
      const risks = flowRisks(flow);
      const serviceCausality = safeFlowServiceCausality(flow);
      const sharedFiles = files.filter(
        (file) =>
          !file.includes('/app/') &&
          (file.includes('/components/') ||
            file.includes('/content/') ||
            file.includes('/lib/') ||
            file.includes('/config/')),
      );
      return {
        flow_id: safeText(flow.id),
        route_path: safeText(routePath),
        route_type: safeText(routeType),
        framework: 'nextjs-app-router',
        entrypoints: routeFlowEntryLabels(flow),
        components: components.map(safeText),
        files: files.map(safeText),
        configs: configs.map(safeText),
        tests: tests.map(safeText),
        service_causality: serviceCausality,
        confidence: routeArchitectureConfidence(flow),
        confidence_score: routeArchitectureScore(flow),
        assumptions: [
          `Route ${routePath} is an architecture surface because ${routeType} entrypoint evidence is present.`,
          `Route ${routePath} behavior depends on ${components.length} component(s), ${configs.length} config artifact(s), and ${tests.length} test artifact(s).`,
        ].map(safeText),
        tradeoffs: unique([
          'Framework-native routes make ownership easier to find, but route behavior can be split across layouts, components, content modules, and config.',
          ...(configs.length > 0
            ? ['Route behavior can change when shared Next.js or TypeScript configuration changes.']
            : []),
          ...(sharedFiles.length > 0
            ? [
                'Shared component/content imports improve reuse but widen review scope beyond the route file.',
              ]
            : []),
        ]).map(safeText),
        what_breaks: unique([
          `Changing the route entrypoint can alter ${routePath} rendering, request handling, metadata, or navigation behavior.`,
          ...(configs.length > 0
            ? [
                `Changing linked config can affect route ${routePath} build, routing, or typing behavior.`,
              ]
            : []),
          ...(sharedFiles.length > 0
            ? [
                `Changing shared files used by ${routePath} can affect the route without touching its app-router entrypoint.`,
              ]
            : []),
          ...(tests.length === 0
            ? [`Route ${routePath} has no directly linked test, so regressions are easier to miss.`]
            : []),
          ...serviceCausality.flatMap((item) =>
            item.effects.map(
              (effect) =>
                `Changing ${item.service_id} can affect route ${routePath} through ${effect}.`,
            ),
          ),
        ]).map(safeText),
        shared_files: sharedFiles.map(safeText),
        risks: risks.map(formatFlowRisk).map(safeText),
        evidence_ids: evidenceIdsForFlow(flow).slice(0, 12),
        evidence_gap_ids: routeArchitectureGapIds(flow),
        rules: [
          'framework:nextjs-app-router',
          `route_type:${safeText(routeType)}`,
          `components:${components.length}`,
          `configs:${configs.length}`,
          `tests:${tests.length}`,
          `shared_files:${sharedFiles.length}`,
        ],
      };
    }),
    (record) => String(record.flow_id ?? ''),
  );
}

function routeArchitectureDesignPressures(
  flows: readonly BrainEntity[],
): ArchitectureDesignPressure[] {
  const pressures: ArchitectureDesignPressure[] = [];
  for (const flow of flows.filter(isNextAppRouterFlow)) {
    const routePath = routePathForFlow(flow);
    const routeType = routeTypeForFlow(flow);
    const configs = flowStringArray(flow, 'configs');
    const tests = flowStringArray(flow, 'tests');
    const files = flowStringArray(flow, 'files');
    const sharedFiles = files.filter((file) => !file.includes('/app/'));
    pressures.push({
      pressure_id: `pressure:${safeText(flow.id)}:route-entrypoint`,
      entity_id: safeText(flow.id),
      pressure_type: 'flow',
      pressure: safeText(
        `${routePath} is a Next.js ${routeType} entrypoint, so route-file changes can affect user-visible navigation, rendering, metadata, or API behavior.`,
      ),
      strength: routeType === 'api' || routeType === 'page' ? 'high' : 'medium',
      evidence_ids: evidenceIdsForFlow(flow).slice(0, 12),
      rules: ['framework:nextjs-app-router', `route_type:${safeText(routeType)}`],
    });
    if (configs.length > 0) {
      pressures.push({
        pressure_id: `pressure:${safeText(flow.id)}:route-config`,
        entity_id: safeText(flow.id),
        pressure_type: 'config',
        pressure: safeText(
          `${routePath} is coupled to ${configs.length} config/manifest artifact(s), so config changes should be reviewed against this route.`,
        ),
        strength: pressureStrengthFromCount(configs.length),
        evidence_ids: configs.map(evidenceId).slice(0, 12),
        rules: [`configs:${configs.length}`],
      });
    }
    if (sharedFiles.length > 0) {
      pressures.push({
        pressure_id: `pressure:${safeText(flow.id)}:route-shared-files`,
        entity_id: safeText(flow.id),
        pressure_type: 'coupling',
        pressure: safeText(
          `${routePath} reaches ${sharedFiles.length} shared file(s), so component/content changes can move through this route.`,
        ),
        strength: pressureStrengthFromCount(sharedFiles.length),
        evidence_ids: sharedFiles.map(evidenceId).slice(0, 12),
        rules: [`shared_files:${sharedFiles.length}`],
      });
    }
    if (tests.length === 0) {
      pressures.push({
        pressure_id: `pressure:${safeText(flow.id)}:route-test-gap`,
        entity_id: safeText(flow.id),
        pressure_type: 'flow',
        pressure: safeText(`${routePath} has no directly linked test artifact.`),
        strength: 'high',
        evidence_ids: evidenceIdsForFlow(flow).slice(0, 12),
        rules: ['tests:0'],
      });
    }
  }
  return sorted(pressures, (pressure) => pressure.pressure_id);
}

function routeArchitectureWhatBreaks(
  flows: readonly BrainEntity[],
): Array<Record<string, unknown>> {
  return sorted(
    flows.filter(isNextAppRouterFlow).map((flow) => {
      const routePath = routePathForFlow(flow);
      const routeType = routeTypeForFlow(flow);
      const tests = flowStringArray(flow, 'tests');
      return {
        flow_id: safeText(flow.id),
        route_path: safeText(routePath),
        route_type: safeText(routeType),
        impacts: unique([
          `The ${routePath} ${routeType} route can stop rendering, handling requests, producing metadata, or matching expected navigation.`,
          ...flowStringArray(flow, 'configs').map(
            (config) => `${config} changes can alter build, route typing, or runtime behavior.`,
          ),
          ...flowStringArray(flow, 'components').map(
            (component) => `${component} changes can propagate into route ${routePath}.`,
          ),
          ...(tests.length === 0
            ? ['No directly linked route test was found to catch this failure mode.']
            : []),
        ]).map(safeText),
        tests: tests.map(safeText),
        evidence_ids: evidenceIdsForFlow(flow).slice(0, 12),
      };
    }),
    (record) => String(record.flow_id ?? ''),
  );
}

function architectureAssumptionRecords(params: {
  readonly components: readonly BrainEntity[];
  readonly flowsByComponent: ReadonlyMap<string, readonly BrainEntity[]>;
  readonly relationships: readonly BrainRelationship[];
  readonly flows: readonly BrainEntity[];
}): ArchitectureAssumption[] {
  const assumptions: ArchitectureAssumption[] = [...routeArchitectureAssumptions(params.flows)];
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

function architectureSeverityRank(severity: string): number {
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

function architectureConfidenceDebtLevel(params: {
  readonly unsupportedAssumptions: number;
  readonly lowConfidenceAreas: number;
  readonly blockingUnknowns: number;
}): ArchitecturePressureStrength {
  if (
    params.blockingUnknowns >= 5 ||
    params.unsupportedAssumptions >= 5 ||
    params.lowConfidenceAreas >= 8
  ) {
    return 'high';
  }
  if (
    params.blockingUnknowns > 0 ||
    params.unsupportedAssumptions > 0 ||
    params.lowConfidenceAreas > 0
  ) {
    return 'medium';
  }
  return 'low';
}

function architectureUnsupportedAssumptions(params: {
  readonly assumptions: readonly ArchitectureAssumption[];
  readonly evidenceGaps: readonly ArchitectureEvidenceGap[];
}): ArchitectureUnsupportedAssumption[] {
  const gapSeverityById = new Map(
    params.evidenceGaps.map((gap) => [gap.gap_id, gap.severity] as const),
  );
  return [...params.assumptions]
    .filter(
      (assumption) =>
        assumption.evidence_ids.length === 0 || assumption.evidence_gap_ids.length > 0,
    )
    .map((assumption) => {
      const gapSeverities = assumption.evidence_gap_ids.map(
        (gapId) => gapSeverityById.get(gapId) ?? 'medium',
      );
      const strongestSeverity = gapSeverities.sort(
        (a, b) => architectureSeverityRank(b) - architectureSeverityRank(a),
      )[0];
      const reason =
        assumption.evidence_ids.length === 0
          ? 'No direct evidence IDs support this architecture assumption.'
          : `Evidence gap(s) keep this architecture assumption at ${strongestSeverity ?? 'medium'} confidence debt.`;
      return {
        assumption_id: safeText(assumption.assumption_id),
        entity_id: safeText(assumption.entity_id),
        reason: safeText(reason),
        evidence_gap_ids: assumption.evidence_gap_ids.map(safeText),
        confidence: assumption.confidence,
        confidence_score: assumption.confidence_score,
      };
    })
    .sort(
      (a, b) =>
        a.confidence_score - b.confidence_score ||
        b.evidence_gap_ids.length - a.evidence_gap_ids.length ||
        a.assumption_id.localeCompare(b.assumption_id),
    )
    .slice(0, 20);
}

function architectureInferredTradeoffs(params: {
  readonly tradeoffMatrix: readonly Record<string, unknown>[];
  readonly routeArchitecture: readonly Record<string, unknown>[];
}): ArchitectureInferredTradeoff[] {
  const componentTradeoffs = params.tradeoffMatrix.flatMap((item) => {
    const entityId = typeof item.component_id === 'string' ? item.component_id : 'unknown';
    const tradeoffs = asStringArray(item.tradeoffs);
    return tradeoffs.map((tradeoff) => ({
      entity_id: safeText(entityId),
      source: 'component' as const,
      tradeoff: safeText(tradeoff),
      reason: 'Component tradeoff is inferred from static local component intelligence.',
      confidence: 'inferred' as const,
    }));
  });
  const routeTradeoffs = params.routeArchitecture.flatMap((item) => {
    const entityId = typeof item.flow_id === 'string' ? item.flow_id : 'unknown';
    const tradeoffs = asStringArray(item.tradeoffs);
    return tradeoffs.map((tradeoff) => ({
      entity_id: safeText(entityId),
      source: 'route' as const,
      tradeoff: safeText(tradeoff),
      reason:
        'Route tradeoff is inferred from app-router entrypoint, config, import, and test signals.',
      confidence: 'inferred' as const,
    }));
  });
  return [...componentTradeoffs, ...routeTradeoffs]
    .sort(
      (a, b) =>
        a.entity_id.localeCompare(b.entity_id) ||
        a.source.localeCompare(b.source) ||
        a.tradeoff.localeCompare(b.tradeoff),
    )
    .slice(0, 20);
}

function architectureLowConfidenceAreas(params: {
  readonly assumptions: readonly ArchitectureAssumption[];
  readonly boundaryRationale: readonly ArchitectureBoundaryRationale[];
  readonly evidenceGaps: readonly ArchitectureEvidenceGap[];
  readonly routeArchitecture: readonly Record<string, unknown>[];
}): ArchitectureLowConfidenceArea[] {
  const areas: ArchitectureLowConfidenceArea[] = [];
  for (const assumption of params.assumptions) {
    if (assumption.confidence === 'verified' && assumption.unknowns.length === 0) continue;
    areas.push({
      area_id: `area:${safeText(assumption.assumption_id)}`,
      entity_id: safeText(assumption.entity_id),
      area_type: 'assumption',
      reason: safeText(`Architecture assumption remains ${assumption.confidence}.`),
      confidence: assumption.confidence,
      confidence_score: assumption.confidence_score,
      evidence_gap_ids: assumption.evidence_gap_ids.map(safeText),
    });
  }
  for (const rationale of params.boundaryRationale) {
    if (rationale.confidence === 'verified' && rationale.unknowns.length === 0) continue;
    areas.push({
      area_id: `area:${safeText(rationale.component_id)}:boundary`,
      entity_id: safeText(rationale.component_id),
      area_type: 'boundary',
      reason: safeText(`Boundary rationale remains ${rationale.confidence}.`),
      confidence: rationale.confidence,
      confidence_score: confidenceScoreForValue(rationale.confidence),
      evidence_gap_ids: [],
    });
  }
  for (const gap of params.evidenceGaps.filter((item) => item.severity === 'high')) {
    areas.push({
      area_id: `area:${safeText(gap.gap_id)}`,
      entity_id: safeText(gap.entity_id),
      area_type: 'evidence_gap',
      reason: safeText(gap.gap),
      confidence: 'uncertain',
      confidence_score: confidenceScoreForValue('uncertain'),
      evidence_gap_ids: [safeText(gap.gap_id)],
    });
  }
  for (const route of params.routeArchitecture) {
    const confidence = route.confidence === 'verified' ? 'verified' : 'inferred';
    if (confidence === 'verified') continue;
    const flowId = typeof route.flow_id === 'string' ? route.flow_id : 'unknown';
    const routePath = typeof route.route_path === 'string' ? route.route_path : 'unknown route';
    areas.push({
      area_id: `area:${safeText(flowId)}:route`,
      entity_id: safeText(flowId),
      area_type: 'route',
      reason: safeText(`Route ${routePath} is statically reconstructed, not runtime verified.`),
      confidence,
      confidence_score: typeof route.confidence_score === 'number' ? route.confidence_score : 0.65,
      evidence_gap_ids: asStringArray(route.evidence_gap_ids).map(safeText),
    });
  }
  const byAreaId = new Map<string, ArchitectureLowConfidenceArea>();
  for (const area of areas) {
    const existing = byAreaId.get(area.area_id);
    if (existing === undefined || area.confidence_score < existing.confidence_score) {
      byAreaId.set(area.area_id, area);
    }
  }
  return [...byAreaId.values()]
    .sort(
      (a, b) =>
        a.confidence_score - b.confidence_score ||
        b.evidence_gap_ids.length - a.evidence_gap_ids.length ||
        a.area_id.localeCompare(b.area_id),
    )
    .slice(0, 25);
}

function architectureBlockingUnknowns(params: {
  readonly artifactUnknowns: readonly string[];
  readonly assumptions: readonly ArchitectureAssumption[];
  readonly evidenceGaps: readonly ArchitectureEvidenceGap[];
}): string[] {
  return unique([
    ...params.artifactUnknowns,
    ...params.assumptions.flatMap((assumption) => assumption.unknowns),
    ...params.evidenceGaps
      .filter((gap) => gap.severity === 'high')
      .map((gap) => `High-severity evidence gap: ${gap.gap}`),
  ])
    .map(safeText)
    .slice(0, 25);
}

function buildArchitectureConfidenceDebt(params: {
  readonly assumptions: readonly ArchitectureAssumption[];
  readonly tradeoffMatrix: readonly Record<string, unknown>[];
  readonly routeArchitecture: readonly Record<string, unknown>[];
  readonly boundaryRationale: readonly ArchitectureBoundaryRationale[];
  readonly evidenceGaps: readonly ArchitectureEvidenceGap[];
  readonly unknowns: readonly string[];
}): ArchitectureConfidenceDebt {
  const unsupportedAssumptions = architectureUnsupportedAssumptions({
    assumptions: params.assumptions,
    evidenceGaps: params.evidenceGaps,
  });
  const inferredTradeoffs = architectureInferredTradeoffs({
    tradeoffMatrix: params.tradeoffMatrix,
    routeArchitecture: params.routeArchitecture,
  });
  const lowConfidenceAreas = architectureLowConfidenceAreas({
    assumptions: params.assumptions,
    boundaryRationale: params.boundaryRationale,
    evidenceGaps: params.evidenceGaps,
    routeArchitecture: params.routeArchitecture,
  });
  const blockingUnknowns = architectureBlockingUnknowns({
    artifactUnknowns: params.unknowns,
    assumptions: params.assumptions,
    evidenceGaps: params.evidenceGaps,
  });
  const debtCount =
    unsupportedAssumptions.length +
    inferredTradeoffs.length +
    lowConfidenceAreas.length +
    blockingUnknowns.length;
  const debtLevel = architectureConfidenceDebtLevel({
    unsupportedAssumptions: unsupportedAssumptions.length,
    lowConfidenceAreas: lowConfidenceAreas.length,
    blockingUnknowns: blockingUnknowns.length,
  });
  return {
    debt_level: debtLevel,
    debt_count: debtCount,
    unsupported_assumption_count: unsupportedAssumptions.length,
    inferred_tradeoff_count: inferredTradeoffs.length,
    low_confidence_area_count: lowConfidenceAreas.length,
    blocking_unknown_count: blockingUnknowns.length,
    unsupported_assumptions: unsupportedAssumptions,
    inferred_tradeoffs: inferredTradeoffs,
    low_confidence_areas: lowConfidenceAreas,
    blocking_unknowns: blockingUnknowns,
    summary: safeText(
      `${unsupportedAssumptions.length} unsupported assumption(s), ${inferredTradeoffs.length} inferred tradeoff(s), ${lowConfidenceAreas.length} low-confidence area(s), and ${blockingUnknowns.length} blocking unknown(s).`,
    ),
    calibration_rule:
      'Confidence debt is derived only from local architecture assumptions, tradeoffs, evidence gaps, confidence scores, and unknowns.',
  };
}

function directDependentComponents(params: {
  readonly componentId: string;
  readonly components: readonly BrainEntity[];
  readonly relationships: readonly BrainRelationship[];
}): string[] {
  const componentIds = new Set(params.components.map((component) => component.id));
  return unique(
    params.relationships
      .filter(
        (relationship) =>
          relationship.to === params.componentId &&
          relationship.from !== params.componentId &&
          componentIds.has(relationship.from),
      )
      .map((relationship) => relationship.from),
  ).map(safeText);
}

function architectureImpactRiskLevel(score: number): ArchitectureImpactRiskLevel {
  if (score >= 8) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function architectureImpactRiskReasoning(params: {
  readonly entityId: string;
  readonly criticality: string;
  readonly criticalityScore: number;
  readonly couplingLevel: ComponentIntelligence['coupling']['level'];
  readonly couplingScore: number;
  readonly affectedFlows: readonly string[];
  readonly affectedTests: readonly string[];
  readonly affectedConfigs: readonly string[];
  readonly dependentComponents: readonly string[];
  readonly confidence: Confidence;
  readonly evidenceGapIds: readonly string[];
  readonly tradeoffs: readonly string[];
  readonly riskySeams: readonly string[];
  readonly serviceCausality: readonly FlowServiceCausality[];
}): ArchitectureImpactRiskReasoning {
  const serviceEffectCount = unique(params.serviceCausality.flatMap((item) => item.effects)).length;
  const rawScore =
    params.couplingScore +
    Math.min(3, Math.floor(params.criticalityScore / 3)) +
    Math.min(2, params.dependentComponents.length) +
    Math.min(2, params.affectedConfigs.length) +
    Math.min(2, serviceEffectCount) +
    (params.affectedTests.length === 0 ? 2 : 0) +
    (params.confidence !== 'verified' ? 1 : 0) +
    (params.evidenceGapIds.length > 0 ? 1 : 0);
  const riskScore = Math.min(10, rawScore);
  const riskySurfaces = unique([
    ...(params.criticality === 'high' ? ['high-criticality surface'] : []),
    ...(params.couplingLevel === 'high' ? ['high-coupling surface'] : []),
    ...(params.affectedTests.length === 0 ? ['untested surface'] : []),
    ...(params.affectedConfigs.length > 0 ? ['configuration-backed surface'] : []),
    ...(params.dependentComponents.length > 0 ? ['consumer-dependent surface'] : []),
    ...(params.confidence !== 'verified' ? ['confidence-gap surface'] : []),
    ...(params.evidenceGapIds.length > 0 ? ['evidence-gap surface'] : []),
    ...(serviceEffectCount > 0 ? ['service-side-effect surface'] : []),
    ...params.riskySeams,
  ]).map(safeText);
  const reviewFocus = unique([
    ...(params.dependentComponents.length > 0
      ? [`Review ${params.dependentComponents.length} dependent component(s).`]
      : []),
    ...(params.affectedFlows.length > 0
      ? [`Verify ${params.affectedFlows.length} reconstructed flow(s).`]
      : []),
    ...(params.affectedTests.length > 0
      ? [`Run or inspect ${params.affectedTests.length} linked test artifact(s).`]
      : ['Add or justify focused test evidence for this surface.']),
    ...(params.affectedConfigs.length > 0
      ? [`Inspect ${params.affectedConfigs.length} linked config/dependency artifact(s).`]
      : []),
    ...(params.evidenceGapIds.length > 0
      ? [`Close ${params.evidenceGapIds.length} architecture evidence gap(s).`]
      : []),
    ...(serviceEffectCount > 0
      ? [`Check ${serviceEffectCount} service side-effect signal(s).`]
      : []),
  ]).map(safeText);
  return {
    risk_level: architectureImpactRiskLevel(riskScore),
    risk_score: riskScore,
    criticality: safeText(params.criticality),
    coupling_level: params.couplingLevel,
    tradeoffs: params.tradeoffs.map(safeText).slice(0, 8),
    risky_surfaces: riskySurfaces.slice(0, 10),
    review_focus: reviewFocus.slice(0, 10),
    reasons: unique([
      `entity:${safeText(params.entityId)}`,
      `criticality:${safeText(params.criticality)}`,
      `coupling:${params.couplingLevel}`,
      `flows:${params.affectedFlows.length}`,
      `tests:${params.affectedTests.length}`,
      `configs:${params.affectedConfigs.length}`,
      `dependent_components:${params.dependentComponents.length}`,
      `confidence:${params.confidence}`,
      `evidence_gaps:${params.evidenceGapIds.length}`,
      `service_effects:${serviceEffectCount}`,
    ]).map(safeText),
  };
}

function componentImpactEntry(params: {
  readonly component: BrainEntity;
  readonly components: readonly BrainEntity[];
  readonly componentFlows: readonly BrainEntity[];
  readonly relationships: readonly BrainRelationship[];
}): ArchitectureImpactEntry {
  const coupling = componentCouplingRecord(params.component);
  const affectedFlows = params.componentFlows.map((flow) => safeText(flow.id));
  const affectedFiles = unique([
    ...params.component.source_files,
    ...stringArrayData(params.component, 'important_files'),
    ...params.componentFlows.flatMap((flow) => flowStringArray(flow, 'files')),
  ]).map(safeText);
  const affectedTests = unique([
    ...stringArrayData(params.component, 'tests'),
    ...params.componentFlows.flatMap((flow) => flowStringArray(flow, 'tests')),
  ]).map(safeText);
  const affectedConfigs = unique([
    ...stringArrayData(params.component, 'configs'),
    ...params.componentFlows.flatMap((flow) => flowStringArray(flow, 'configs')),
  ]).map(safeText);
  const evidenceIds = architectureEvidenceIdsForComponent({
    component: params.component,
    componentFlows: params.componentFlows,
    relationships: params.relationships,
  });
  const evidenceGapIds = architectureAssumptionGapIds({
    entityId: params.component.id,
    evidenceIds,
    componentFlows: params.componentFlows,
  });
  const dependentComponents = directDependentComponents({
    componentId: params.component.id,
    components: params.components,
    relationships: params.relationships,
  });
  const confidence = architectureAssumptionConfidence({
    component: params.component,
    componentFlows: params.componentFlows,
  });
  const confidenceScore = architectureAssumptionScore({
    component: params.component,
    componentFlows: params.componentFlows,
  });
  const criticality = stringData(params.component, 'criticality') ?? 'unknown';
  const criticalityScore = numberData(params.component, 'criticality_score') ?? 0;
  const tradeoffs = stringArrayData(params.component, 'tradeoffs');
  const riskySeams = stringArrayData(params.component, 'risky_seams');
  const whatBreaks = unique([
    ...stringArrayData(params.component, 'what_breaks_if_removed'),
    ...stringArrayData(params.component, 'failure_modes'),
    ...(affectedFlows.length > 0
      ? [`${params.component.id} changes can affect ${affectedFlows.length} reconstructed flow(s).`]
      : []),
    ...(affectedTests.length === 0
      ? [`${params.component.id} has no directly linked test artifact in the impact map.`]
      : []),
    ...(dependentComponents.length > 0
      ? [
          `${dependentComponents.length} dependent component(s) can break when ${params.component.id} changes.`,
        ]
      : []),
  ]).map(safeText);
  const riskReasoning = architectureImpactRiskReasoning({
    entityId: params.component.id,
    criticality,
    criticalityScore,
    couplingLevel: coupling.level,
    couplingScore: coupling.score,
    affectedFlows,
    affectedTests,
    affectedConfigs,
    dependentComponents,
    confidence,
    evidenceGapIds,
    tradeoffs,
    riskySeams,
    serviceCausality: [],
  });
  return {
    impact_id: `impact:${safeText(params.component.id)}`,
    surface_type: 'component',
    entity_id: safeText(params.component.id),
    name: safeText(params.component.name),
    affected_flows: affectedFlows,
    affected_components: [safeText(params.component.id)],
    affected_files: affectedFiles,
    affected_tests: affectedTests,
    affected_configs: affectedConfigs,
    dependent_components: dependentComponents,
    coupling_level: coupling.level,
    coupling_score: coupling.score,
    confidence,
    confidence_score: confidenceScore,
    evidence_ids: evidenceIds,
    evidence_gap_ids: evidenceGapIds,
    what_breaks: whatBreaks,
    risk_reasoning: riskReasoning,
    reasons: unique([
      `boundary_type:${stringData(params.component, 'boundary_type') ?? 'unknown'}`,
      `flow_links:${affectedFlows.length}`,
      `tests:${affectedTests.length}`,
      `configs:${affectedConfigs.length}`,
      `dependent_components:${dependentComponents.length}`,
      `coupling:${coupling.level}`,
    ]).map(safeText),
  };
}

function tradeoffsForRouteImpact(flow: BrainEntity): string[] {
  const configs = flowStringArray(flow, 'configs');
  const components = flowStringArray(flow, 'components');
  const serviceCausality = safeFlowServiceCausality(flow);
  return unique([
    'Explicit route mapping makes handler ownership visible, but behavior can still depend on imported components, services, and config.',
    ...(configs.length > 0
      ? ['Config-backed routes are easier to audit, but config changes can alter runtime behavior.']
      : []),
    ...(components.length > 1
      ? [
          'Cross-component routes improve reuse, but widen review scope across component boundaries.',
        ]
      : []),
    ...(serviceCausality.length > 0
      ? [
          'Service causality makes side effects visible, but side-effect changes can break route behavior.',
        ]
      : []),
  ]).map(safeText);
}

function routeCouplingLevel(flow: BrainEntity): ComponentIntelligence['coupling']['level'] {
  const componentCount = flowStringArray(flow, 'components').length;
  const fileCount = flowStringArray(flow, 'files').length;
  const configCount = flowStringArray(flow, 'configs').length;
  const score = Math.min(10, componentCount * 2 + fileCount + configCount);
  if (score >= 8) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function routeCouplingScore(flow: BrainEntity): number {
  const componentCount = flowStringArray(flow, 'components').length;
  const fileCount = flowStringArray(flow, 'files').length;
  const configCount = flowStringArray(flow, 'configs').length;
  return Math.min(10, componentCount * 2 + fileCount + configCount);
}

function routeImpactEntry(flow: BrainEntity): ArchitectureImpactEntry {
  const routePath = routePathForFlow(flow);
  const routeType = routeTypeForFlow(flow);
  const framework = stringData(flow, 'framework') ?? 'route-flow';
  const isNextRoute = isNextAppRouterFlow(flow);
  const routeBreaks = isNextRoute
    ? `Changing route ${routePath} can alter ${routeType} rendering, request handling, metadata, or navigation behavior.`
    : `Changing route ${routePath} can alter ${routeType} request handling, handler inputs, outputs, or API response behavior.`;
  const files = flowStringArray(flow, 'files').map(safeText);
  const components = flowStringArray(flow, 'components').map(safeText);
  const tests = flowStringArray(flow, 'tests').map(safeText);
  const configs = flowStringArray(flow, 'configs').map(safeText);
  const serviceCausality = safeFlowServiceCausality(flow);
  const couplingLevel = routeCouplingLevel(flow);
  const couplingScore = routeCouplingScore(flow);
  const confidence = routeArchitectureConfidence(flow);
  const confidenceScore = routeArchitectureScore(flow);
  const evidenceGapIds = routeArchitectureGapIds(flow);
  const riskReasoning = architectureImpactRiskReasoning({
    entityId: flow.id,
    criticality: serviceCausality.length > 0 || couplingLevel === 'high' ? 'high' : 'medium',
    criticalityScore: serviceCausality.length > 0 || couplingLevel === 'high' ? 8 : 5,
    couplingLevel,
    couplingScore,
    affectedFlows: [safeText(flow.id)],
    affectedTests: tests,
    affectedConfigs: configs,
    dependentComponents: [],
    confidence,
    evidenceGapIds,
    tradeoffs: tradeoffsForRouteImpact(flow),
    riskySeams: [],
    serviceCausality,
  });
  return {
    impact_id: `impact:${safeText(flow.id)}`,
    surface_type: 'route',
    entity_id: safeText(flow.id),
    name: safeText(flow.name),
    route_path: safeText(routePath),
    route_type: safeText(routeType),
    affected_flows: [safeText(flow.id)],
    affected_components: components,
    affected_files: files,
    affected_tests: tests,
    affected_configs: configs,
    service_causality: serviceCausality,
    dependent_components: [],
    coupling_level: couplingLevel,
    coupling_score: couplingScore,
    confidence,
    confidence_score: confidenceScore,
    evidence_ids: evidenceIdsForFlow(flow).slice(0, 12),
    evidence_gap_ids: evidenceGapIds,
    what_breaks: unique([
      routeBreaks,
      ...configs.map(
        (config) => `${config} can affect route ${routePath} build or runtime behavior.`,
      ),
      ...components.map(
        (component) => `${component} changes can propagate into route ${routePath}.`,
      ),
      ...(tests.length === 0
        ? [`Route ${routePath} has no directly linked test artifact in the impact map.`]
        : []),
      ...serviceCausality.flatMap((item) =>
        item.effects.map(
          (effect) => `${item.service_id} can affect route ${routePath} through ${effect}.`,
        ),
      ),
      ...serviceCausality
        .filter((item) => item.effects.length === 0)
        .map(
          (item) =>
            `${item.service_id} reaches route ${routePath}, but no service side effect is recorded; blast radius remains uncertain.`,
        ),
      ...serviceCausality
        .filter((item) => item.step_ids.length === 0)
        .map(
          (item) =>
            `${item.service_id} reaches route ${routePath} without a linked flow step; inspect reachability before relying on this impact.`,
        ),
    ]).map(safeText),
    risk_reasoning: riskReasoning,
    reasons: [
      `framework:${safeText(framework)}`,
      `route_type:${safeText(routeType)}`,
      `components:${components.length}`,
      `files:${files.length}`,
      `tests:${tests.length}`,
      `configs:${configs.length}`,
      `service_causality:${serviceCausality.length}`,
      `coupling:${couplingLevel}`,
    ],
  };
}

function serviceCausalityEffectCategory(effect: string): string {
  const [category] = effect.split(':');
  if (category === undefined || category.trim() === '') return 'unknown';
  return safeText(category);
}

function buildArchitectureServiceCausalityReasoning(
  flows: readonly BrainEntity[],
): ArchitectureServiceCausalityReasoning {
  const claims = flows.flatMap((flow) =>
    safeFlowServiceCausality(flow).map((claim) => ({ flow, claim })),
  );
  const effects = unique(claims.flatMap(({ claim }) => claim.effects)).map(safeText);
  const missingEffectPaths = claims
    .filter(({ claim }) => claim.effects.length === 0)
    .map(({ flow, claim }) => `${safeText(flow.id)} -> ${safeText(claim.service_id)}`);
  const missingStepLinkPaths = claims
    .filter(({ claim }) => claim.step_ids.length === 0)
    .map(({ flow, claim }) => `${safeText(flow.id)} -> ${safeText(claim.service_id)}`);
  const routeImpacts = claims
    .filter(({ flow }) => isArchitectureRouteFlow(flow))
    .map(({ flow, claim }) => {
      const routePath = safeText(routePathForFlow(flow));
      const whatBreaks =
        claim.effects.length === 0
          ? [
              `${safeText(claim.service_id)} reaches route ${routePath}, but no side effect is recorded yet.`,
            ]
          : claim.effects.map(
              (effect) =>
                `${safeText(claim.service_id)} can change route ${routePath} behavior through ${safeText(effect)}.`,
            );
      return {
        flow_id: safeText(flow.id),
        route_path: routePath,
        service_id: safeText(claim.service_id),
        effects: claim.effects.map(safeText),
        what_breaks: whatBreaks.map(safeText),
        evidence_ids: claim.evidence_ids.map(safeText),
        confidence: claim.confidence,
      };
    });
  const unknowns = unique([
    ...(claims.length === 0
      ? ['No service causality paths were reconstructed for architecture reasoning yet.']
      : []),
    ...missingEffectPaths.map((path) => `${path} has no recorded service effect.`),
    ...missingStepLinkPaths.map((path) => `${path} is not linked to a reconstructed flow step.`),
    ...claims.flatMap(({ claim }) => claim.unknowns),
  ]).map(safeText);
  return {
    total_paths: claims.length,
    affected_flows: unique(claims.map(({ flow }) => flow.id)).map(safeText),
    affected_services: unique(claims.map(({ claim }) => claim.service_id)).map(safeText),
    effect_count: effects.length,
    effects,
    effect_categories: unique(effects.map(serviceCausalityEffectCategory)),
    route_impacts: routeImpacts,
    missing_effect_paths: missingEffectPaths.map(safeText),
    missing_step_link_paths: missingStepLinkPaths.map(safeText),
    evidence_ids: unique(claims.flatMap(({ claim }) => claim.evidence_ids)).map(safeText),
    confidence_distribution: countByConfidence(claims.map(({ claim }) => claim.confidence)),
    top_risky_effects: effects
      .filter((effect) =>
        /env|secret|token|credential|storage|db|database|external|api/i.test(effect),
      )
      .slice(0, 10),
    unknowns: unknowns.slice(0, 20),
    calibration_rule:
      'Service causality reasoning is deterministic static inference from flow steps, service ownership, side-effect signals, evidence IDs, and confidence.',
  };
}

function buildArchitectureImpactMap(params: {
  readonly components: readonly BrainEntity[];
  readonly flows: readonly BrainEntity[];
  readonly flowsByComponent: ReadonlyMap<string, readonly BrainEntity[]>;
  readonly relationships: readonly BrainRelationship[];
}): ArchitectureImpactMap {
  const componentEntries = params.components.map((component) =>
    componentImpactEntry({
      component,
      components: params.components,
      componentFlows: params.flowsByComponent.get(component.id) ?? [],
      relationships: params.relationships,
    }),
  );
  const routeEntries = params.flows.filter(isArchitectureRouteFlow).map(routeImpactEntry);
  const entries = [...componentEntries, ...routeEntries]
    .sort(
      (a, b) =>
        b.affected_flows.length - a.affected_flows.length ||
        b.dependent_components.length - a.dependent_components.length ||
        b.coupling_score - a.coupling_score ||
        a.impact_id.localeCompare(b.impact_id),
    )
    .slice(0, 50);
  const serviceCausality = entries.flatMap((entry) => entry.service_causality ?? []);
  const serviceCausalityEffects = unique(serviceCausality.flatMap((item) => item.effects));
  return {
    summary: {
      total_surfaces: entries.length,
      component_surfaces: entries.filter((entry) => entry.surface_type === 'component').length,
      route_surfaces: entries.filter((entry) => entry.surface_type === 'route').length,
      high_coupling_surfaces: entries.filter((entry) => entry.coupling_level === 'high').length,
      test_backed_surfaces: entries.filter((entry) => entry.affected_tests.length > 0).length,
      config_backed_surfaces: entries.filter((entry) => entry.affected_configs.length > 0).length,
      service_causality_paths: serviceCausality.length,
      service_causality_effect_count: serviceCausalityEffects.length,
      service_causality_backed_surfaces: entries.filter(
        (entry) => (entry.service_causality ?? []).length > 0,
      ).length,
      service_causality_unknown_count: serviceCausality.filter(
        (item) => item.effects.length === 0 || item.step_ids.length === 0,
      ).length,
      top_impacted_surfaces: entries.slice(0, 5).map((entry) => entry.impact_id),
    },
    entries,
    calibration_rule:
      'Impact map is deterministic static inference from component boundaries, route metadata, flows, graph relationships, tests, configs, coupling, and evidence IDs.',
  };
}

function isDeploymentFlow(flow: BrainEntity): boolean {
  return flowStringArray(flow, 'signals').includes('deployment');
}

function buildDeploymentIntelligence(flows: readonly BrainEntity[]): Record<string, unknown> {
  const deploymentFlows = flows.filter(isDeploymentFlow);
  const entries = deploymentFlows.map((flow) => {
    const risks = flowRisks(flow).filter((risk) => risk.kind.startsWith('deployment_'));
    const configs = flowStringArray(flow, 'configs').filter(isDeploymentConfigPath);
    const requiredTests = flowStringArray(flow, 'required_tests');
    return {
      flow_id: safeText(flow.id),
      name: safeText(flow.name),
      configs: configs.map(safeText),
      required_tests: requiredTests.map(safeText),
      production_risk_count: risks.length,
      production_risks: risks.map((risk) => safeText(risk.description)),
      smoke_required: requiredTests.includes('production smoke check'),
      confidence: flow.confidence,
      confidence_score: asFlowConfidenceScore(flow),
      evidence_ids: unique([...flow.evidence_ids, ...configs.map(evidenceId)]).slice(0, 12),
    };
  });
  const productionRiskCount = entries.reduce(
    (count, entry) => count + Number(entry.production_risk_count),
    0,
  );
  const configCount = unique(entries.flatMap((entry) => entry.configs)).length;
  return {
    summary: {
      deployment_flow_count: entries.length,
      deployment_config_count: configCount,
      production_risk_count: productionRiskCount,
      smoke_required_count: entries.filter((entry) => entry.smoke_required).length,
      posture: deploymentPosture(entries.length, productionRiskCount),
    },
    flows: entries,
    unknowns: unique([
      ...(entries.length === 0
        ? ['No deployment flow was reconstructed from local evidence.']
        : []),
      ...(entries.some((entry) => entry.smoke_required)
        ? [
            'Deployment flows need recorded production smoke evidence before production confidence improves.',
          ]
        : []),
      ...(productionRiskCount > 0
        ? ['Deployment configuration includes production risks that require explicit review.']
        : []),
    ]),
    calibration_rule:
      'Deployment intelligence is deterministic static inference from deploy-like package scripts, deployment configs, flow contracts, and recorded risk evidence.',
  };
}

function buildServiceArchitectureIntelligence(
  services: readonly BrainEntity[],
): Record<string, unknown> {
  const entries = services.map((service) => {
    const risks = serviceDataStringArray(service, 'risks');
    const relatedFlows = serviceDataStringArray(service, 'related_flows');
    const storage = serviceDataStringArray(service, 'storage_dependencies');
    const envVars = serviceDataStringArray(service, 'environment_variables');
    const externalServices = serviceDataStringArray(service, 'external_services');
    const deploymentConfigs = serviceDataStringArray(service, 'deployment_configs');
    return {
      service_id: safeText(service.id),
      name: safeText(service.name),
      runtime: stringData(service, 'runtime') ?? 'unknown',
      framework: stringData(service, 'framework') ?? 'unknown',
      related_flows: relatedFlows,
      related_components: serviceDataStringArray(service, 'related_components'),
      route_count: serviceDataStringArray(service, 'routes').length,
      job_count: serviceDataStringArray(service, 'jobs').length,
      storage_dependencies: storage,
      environment_variables: envVars,
      external_services: externalServices,
      deployment_configs: deploymentConfigs,
      risk_count: risks.length,
      risks,
      confidence: service.confidence,
      confidence_score:
        numberData(service, 'confidence_score') ?? confidenceScoreForValue(service.confidence),
      evidence_ids: service.evidence_ids.map(safeText),
      unknowns: serviceDataStringArray(service, 'unknowns'),
    };
  });
  const riskyServices = entries.filter(
    (entry) =>
      entry.risk_count > 0 ||
      entry.storage_dependencies.length > 0 ||
      entry.deployment_configs.length > 0,
  );
  return {
    summary: {
      service_count: entries.length,
      services_with_flows: entries.filter((entry) => entry.related_flows.length > 0).length,
      services_with_storage: entries.filter((entry) => entry.storage_dependencies.length > 0)
        .length,
      services_with_external_apis: entries.filter((entry) => entry.external_services.length > 0)
        .length,
      risky_service_count: riskyServices.length,
    },
    services: entries,
    unknowns: unique(
      services.flatMap((service) =>
        serviceDataStringArray(service, 'unknowns').map((unknown) => `${service.id}: ${unknown}`),
      ),
    ).slice(0, 12),
    calibration_rule:
      'Service architecture intelligence is deterministic static inference from first-class service entities, flow links, storage/API/env evidence, deployment configs, and known unknowns.',
  };
}

function deploymentPosture(deploymentFlowCount: number, productionRiskCount: number): string {
  if (deploymentFlowCount === 0) return 'no deployment evidence';
  if (productionRiskCount > 0) return 'risky until verified';
  return 'needs smoke evidence';
}

function isServiceLikeSourceFile(file: FileFact): boolean {
  if (!isSourceFile(file.relativePath)) return false;
  const lower = file.relativePath.toLowerCase();
  const name = basename(lower);
  return (
    /(^|\/)(services?|adapters?|repositories?|workers?|jobs?|integrations?)\//i.test(lower) ||
    /(^|[-_.])(service|adapter|repository|worker|job|ingest|processor|client)([-_.]|$)/i.test(name)
  );
}

function serviceRootForFile(path: string): string {
  const parts = path.split('/');
  const serviceIndex = parts.findIndex((part) =>
    /^(services?|adapters?|repositories?|workers?|jobs?|integrations?)$/i.test(part),
  );
  if (serviceIndex >= 0) return parts.slice(0, serviceIndex + 1).join('/');
  return dirname(path).split(sep).join('/');
}

function runtimeForService(files: readonly FileFact[]): ServiceRuntime {
  if (files.some((file) => file.relativePath.endsWith('.py'))) return 'python';
  if (files.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file.relativePath))) return 'node';
  return 'unknown';
}

function frameworkForService(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
  readonly packageFacts: readonly PackageJsonFact[];
}): string {
  const text = params.files
    .map((file) => readTextIfAvailable(params.rootDir, file.relativePath) ?? '')
    .join('\n');
  const manifestText = params.packageFacts
    .map((pkg) => JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies }))
    .join('\n');
  if (/FastAPI|APIRouter|fastapi/i.test(text)) return 'fastapi';
  if (/Flask|flask/i.test(text)) return 'flask';
  if (/Django|django/i.test(text)) return 'django';
  if (/new\s+Hono\b|from\s+['"]hono['"]|hono/i.test(`${text}\n${manifestText}`)) return 'hono';
  if (/express|fastify/i.test(`${text}\n${manifestText}`)) return 'express-fastify-http';
  if (/next/i.test(manifestText)) return 'nextjs';
  return 'unknown';
}

function envVarsFromText(text: string): string[] {
  const vars = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
    /getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) vars.add(safeText(name));
    }
  }
  return [...vars].sort((a, b) => a.localeCompare(b));
}

function storageDependenciesFromText(text: string): string[] {
  const storage = new Set<string>();
  const checks: ReadonlyArray<readonly [RegExp, string]> = [
    [/sqlite|\.db\b|SQLAlchemy|create_engine/i, 'sqlite/database'],
    [/postgres|pg\.|psycopg|DATABASE_URL/i, 'postgres/database'],
    [/redis|ioredis/i, 'redis/cache'],
    [/prisma|typeorm|mongoose|sequelize/i, 'orm/database'],
    [/chroma|pinecone|qdrant|weaviate|vector/i, 'vector/search store'],
    [/\/tmp\b|tmp\/|tempfile|NamedTemporaryFile/i, 'temporary filesystem'],
    [/writeFile|appendFile|fs\.|open\(|Path\(|pathlib/i, 'filesystem'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) storage.add(label);
  }
  return [...storage].sort((a, b) => a.localeCompare(b));
}

function externalServicesFromText(text: string, imports: readonly string[]): string[] {
  const services = new Set<string>();
  for (const item of imports) {
    if (!item.startsWith('.') && !/^[A-Za-z_][\w.]+$/.test(item)) services.add(safeText(item));
  }
  const checks: ReadonlyArray<readonly [RegExp, string]> = [
    [/youtube|yt-dlp|pytube/i, 'youtube'],
    [/openai|anthropic|cohere/i, 'llm/api'],
    [/stripe/i, 'stripe'],
    [/yfinance|alpaca|polygon|binance/i, 'market-data-api'],
    [/requests\.|httpx|fetch\(|axios/i, 'http-client'],
    [/s3|boto3|blob/i, 'object-storage'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) services.add(label);
  }
  return [...services].sort((a, b) => a.localeCompare(b)).slice(0, 12);
}

function serviceRoutesForFiles(params: {
  readonly rootDir: string;
  readonly files: readonly FileFact[];
}): string[] {
  return unique(
    params.files.flatMap((file) =>
      httpRouteDeclarationsForFile({ rootDir: params.rootDir, file }).map(
        (route) => `${route.method} ${route.routePath} (${file.relativePath})`,
      ),
    ),
  );
}

function serviceJobsForRoot(params: {
  readonly root: string;
  readonly files: readonly FileFact[];
  readonly packageFacts: readonly PackageJsonFact[];
}): string[] {
  const rootFiles = new Set(params.files.map((file) => file.relativePath));
  const fileJobs = params.files
    .filter((file) => /(^|\/)(jobs?|workers?|scripts?)\//i.test(file.relativePath))
    .map((file) => file.relativePath);
  const scriptJobs = params.packageFacts.flatMap((pkg) => {
    const pkgDir = packageComponentPath(pkg) ?? '.';
    return Object.entries(pkg.scripts)
      .filter(([name, command]) =>
        /job|worker|cron|ingest|sync|generate|build|deploy/i.test(`${name} ${command}`),
      )
      .flatMap(([name, command]) => {
        const referenced = filesReferencedByCommand(
          params.files,
          command,
          pkgDir === '.' ? undefined : pkgDir,
        );
        return referenced.some((file) => rootFiles.has(file.relativePath))
          ? [`${pkg.relativePath}:${name}`]
          : [];
      });
  });
  return unique([...fileJobs, ...scriptJobs]).slice(0, 12);
}

function serviceDeploymentConfigs(params: {
  readonly root: string;
  readonly files: readonly FileFact[];
}): string[] {
  return unique(
    params.files
      .filter((file) => {
        if (!isDeploymentConfigPath(file.relativePath)) return false;
        return (
          file.relativePath.startsWith(`${params.root}/`) ||
          !file.relativePath.includes('/') ||
          file.relativePath.startsWith('.github/')
        );
      })
      .map((file) => file.relativePath),
  ).slice(0, 12);
}

function serviceConfidence(params: {
  readonly entrypoints: readonly string[];
  readonly routes: readonly string[];
  readonly jobs: readonly string[];
  readonly storageDependencies: readonly string[];
  readonly externalServices: readonly string[];
  readonly unknowns: readonly string[];
}): { readonly confidence: Confidence; readonly score: number } {
  let score = 0.35;
  if (params.entrypoints.length > 0) score += 0.2;
  if (params.routes.length > 0) score += 0.15;
  if (params.jobs.length > 0) score += 0.1;
  if (params.storageDependencies.length > 0) score += 0.1;
  if (params.externalServices.length > 0) score += 0.05;
  if (params.unknowns.length > 0) score -= 0.1;
  const bounded = Math.max(0.1, Math.min(0.9, Number(score.toFixed(2))));
  if (bounded >= 0.8 && params.unknowns.length === 0) {
    return { confidence: 'verified', score: bounded };
  }
  if (bounded >= 0.5) return { confidence: 'inferred', score: bounded };
  return { confidence: 'uncertain', score: bounded };
}

function inferServices(params: {
  readonly rootDir: string;
  readonly now: string;
  readonly files: readonly FileFact[];
  readonly packageFacts: readonly PackageJsonFact[];
  readonly components: readonly BrainEntity[];
  readonly tests: readonly BrainEntity[];
  readonly configs: readonly BrainEntity[];
}): BrainEntity[] {
  const serviceFilesByRoot = new Map<string, FileFact[]>();
  for (const file of params.files.filter(isServiceLikeSourceFile)) {
    const root = serviceRootForFile(file.relativePath);
    serviceFilesByRoot.set(root, [...(serviceFilesByRoot.get(root) ?? []), file]);
  }
  const services: BrainEntity[] = [];
  for (const [root, rawFiles] of serviceFilesByRoot.entries()) {
    const files = uniqueFileFacts(rawFiles);
    const textByFile = new Map(
      files.map((file) => [
        file.relativePath,
        readTextIfAvailable(params.rootDir, file.relativePath) ?? '',
      ]),
    );
    const allText = [...textByFile.values()].join('\n');
    const importContext = importContextForFiles({
      rootDir: params.rootDir,
      files: params.files,
      entryFiles: files,
    });
    const componentIds = componentIdsForFiles(
      files.map((file) => file.relativePath),
      params.components,
    );
    const testPaths = params.tests
      .filter((test) =>
        test.source_files.some(
          (file) => file.startsWith(`${root}/`) || basename(file).includes(basename(root)),
        ),
      )
      .flatMap((test) => test.source_files);
    const configPaths = params.configs
      .filter((config) => config.source_files.some((file) => file.startsWith(`${root}/`)))
      .flatMap((config) => config.source_files);
    const entrypoints = unique([
      ...files
        .filter((file) =>
          /(^|\/)(index|main|app|server|worker|job|ingest|processor)\.(ts|tsx|js|jsx|mjs|cjs|py)$/i.test(
            file.relativePath,
          ),
        )
        .map((file) => file.relativePath),
      ...files.slice(0, 3).map((file) => file.relativePath),
    ]).slice(0, 8);
    const routes = serviceRoutesForFiles({ rootDir: params.rootDir, files });
    const jobs = serviceJobsForRoot({
      root,
      files,
      packageFacts: params.packageFacts,
    });
    const envVars = envVarsFromText(allText);
    const storageDependencies = storageDependenciesFromText(allText);
    const externalServices = externalServicesFromText(allText, importContext.importedSpecifiers);
    const deploymentConfigs = serviceDeploymentConfigs({ root, files: params.files });
    const risks = unique([
      ...(testPaths.length === 0
        ? ['No directly linked test artifact was detected for this service.']
        : []),
      ...(storageDependencies.some((item) => /temporary|sqlite|filesystem/i.test(item))
        ? [
            'Storage depends on local filesystem, temporary files, or SQLite-like evidence; verify production durability.',
          ]
        : []),
      ...(envVars.length > 0 && configPaths.length === 0
        ? ['Environment variables are read but no service-local config artifact was linked.']
        : []),
    ]);
    const unknowns = unique([
      ...(routes.length === 0
        ? ['No API route evidence was linked directly to this service.']
        : []),
      ...(jobs.length === 0
        ? ['No background job or script evidence was linked directly to this service.']
        : []),
      ...(storageDependencies.length === 0
        ? ['No storage dependency was detected from static source evidence.']
        : []),
    ]);
    const confidence = serviceConfidence({
      entrypoints,
      routes,
      jobs,
      storageDependencies,
      externalServices,
      unknowns,
    });
    const evidenceIds = unique(files.map((file) => evidenceId(file.relativePath)));
    const serviceId = entityId('service', root);
    const fieldEvidence = {
      entrypoints: entrypoints.map(evidenceId),
      routes: files
        .filter(
          (file) => httpRouteDeclarationsForFile({ rootDir: params.rootDir, file }).length > 0,
        )
        .map((file) => evidenceId(file.relativePath)),
      jobs: jobs.flatMap((job) => {
        const manifest = job.split(':')[0] ?? '';
        return manifest.endsWith('package.json') ? [evidenceId(manifest)] : [];
      }),
      storage_dependencies: files
        .filter(
          (file) => storageDependenciesFromText(textByFile.get(file.relativePath) ?? '').length > 0,
        )
        .map((file) => evidenceId(file.relativePath)),
      environment_variables: files
        .filter((file) => envVarsFromText(textByFile.get(file.relativePath) ?? '').length > 0)
        .map((file) => evidenceId(file.relativePath)),
      external_services: unique([
        ...files
          .filter(
            (file) =>
              externalServicesFromText(
                textByFile.get(file.relativePath) ?? '',
                importSpecifiersFromText(textByFile.get(file.relativePath) ?? ''),
              ).length > 0,
          )
          .map((file) => evidenceId(file.relativePath)),
        ...importContext.importEvidence.map((evidence) => evidenceId(evidence.path)),
      ]),
      deployment_configs: deploymentConfigs.map(evidenceId),
      risks: evidenceIds,
      unknowns: evidenceIds,
    };
    const intelligence: ServiceIntelligence = {
      service_id: serviceId,
      name: safeText(root),
      runtime: runtimeForService(files),
      framework: frameworkForService({
        rootDir: params.rootDir,
        files,
        packageFacts: params.packageFacts,
      }),
      service_root: safeText(root),
      files: files.map((file) => safeText(file.relativePath)),
      entrypoints: entrypoints.map(safeText),
      routes: routes.map(safeText),
      jobs: jobs.map(safeText),
      storage_dependencies: storageDependencies.map(safeText),
      environment_variables: envVars.map(safeText),
      external_services: externalServices.map(safeText),
      deployment_configs: deploymentConfigs.map(safeText),
      related_flows: [],
      related_components: componentIds.map(safeText),
      risks: risks.map(safeText),
      confidence: confidence.confidence,
      confidence_score: confidence.score,
      evidence_ids: evidenceIds.map(safeText),
      field_evidence: fieldEvidence,
      unknowns: unknowns.map(safeText),
      signals: unique([
        'service-like path',
        ...(routes.length > 0 ? ['route evidence'] : []),
        ...(jobs.length > 0 ? ['job evidence'] : []),
        ...(storageDependencies.length > 0 ? ['storage evidence'] : []),
        ...(envVars.length > 0 ? ['environment evidence'] : []),
        ...(externalServices.length > 0 ? ['external API evidence'] : []),
      ]),
    };
    services.push(
      makeEntity({
        id: serviceId,
        type: 'service',
        name: safeText(root),
        description: `${safeText(root)} service inferred from local source evidence.`,
        now: params.now,
        confidence: confidence.confidence,
        evidenceIds,
        relatedEntityIds: componentIds,
        sourceFiles: files.map((file) => file.relativePath),
        data: intelligence as unknown as Record<string, unknown>,
      }),
    );
  }
  return sorted(services, (service) => service.id);
}

function serviceIdsForFiles(files: readonly string[], services: readonly BrainEntity[]): string[] {
  return unique(
    services
      .filter((service) =>
        service.source_files.some((source) =>
          files.some((file) => file === source || source.startsWith(`${file}/`)),
        ),
      )
      .map((service) => service.id),
  );
}

function flowServiceCausality(params: {
  readonly frameworkLabel: string;
  readonly entryLabel: string;
  readonly serviceIds: readonly string[];
  readonly services: readonly BrainEntity[];
  readonly files: readonly string[];
  readonly steps: readonly FlowStep[];
}): FlowServiceCausality[] {
  return params.serviceIds.flatMap((serviceId): FlowServiceCausality[] => {
    const service = params.services.find((item) => item.id === serviceId);
    if (service === undefined) return [];
    const serviceFiles = service.source_files.filter((file) => params.files.includes(file));
    const serviceSteps = params.steps.filter(
      (step) => step.type === 'service' && service.source_files.includes(step.path),
    );
    const storage = serviceDataStringArray(service, 'storage_dependencies');
    const envVars = serviceDataStringArray(service, 'environment_variables');
    const externalServices = serviceDataStringArray(service, 'external_services');
    const jobs = serviceDataStringArray(service, 'jobs');
    const routes = serviceDataStringArray(service, 'routes');
    const effects = unique([
      ...storage.map((item) => `storage:${item}`),
      ...envVars.map((item) => `env:${item}`),
      ...externalServices.map((item) => `external:${item}`),
      ...jobs.map((item) => `job:${item}`),
      ...routes.map((item) => `route:${item}`),
    ]);
    const evidenceIds = unique([
      ...service.evidence_ids,
      ...serviceSteps.flatMap((step) => step.evidence),
      ...serviceFiles.map(evidenceId),
    ]);
    return [
      {
        service_id: safeText(service.id),
        service_name: safeText(service.name),
        service_root: safeText(stringData(service, 'service_root') ?? service.name),
        files: serviceFiles.map(safeText),
        step_ids: serviceSteps.map((step) => safeText(step.step_id)),
        cause: safeText(
          `${params.frameworkLabel} ${params.entryLabel} reaches ${service.id} through static import evidence.`,
        ),
        effects: effects.map(safeText),
        evidence_ids: evidenceIds.map(safeText),
        confidence: weakestConfidence([
          service.confidence,
          serviceSteps.length > 0 ? 'inferred' : 'uncertain',
        ]),
        unknowns: serviceDataStringArray(service, 'unknowns'),
      },
    ];
  });
}

function enrichServicesWithFlows(
  services: readonly BrainEntity[],
  flows: readonly BrainEntity[],
): BrainEntity[] {
  return services.map((service) => {
    const relatedFlows = flows.filter((flow) =>
      flowStringArray(flow, 'services').includes(service.id),
    );
    const relatedFlowIds = relatedFlows.map((flow) => flow.id);
    const relatedComponentIds = unique([
      ...stringArrayData(service, 'related_components'),
      ...relatedFlows.flatMap((flow) => flowStringArray(flow, 'components')),
    ]);
    return {
      ...service,
      related_entity_ids: unique([
        ...service.related_entity_ids,
        ...relatedFlowIds,
        ...relatedComponentIds,
      ]),
      data: {
        ...(service.data ?? {}),
        related_flows: relatedFlowIds.map(safeText),
        related_components: relatedComponentIds.map(safeText),
      },
    };
  });
}

function serviceDataStringArray(service: BrainEntity, key: string): string[] {
  return stringArrayData(service, key).map(safeText);
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
  const services = params.buckets.services.filter((service) => service.latest_status !== 'stale');
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
  const routeArchitecture = routeArchitectureRecords(flows);
  const routeWhatBreaks = routeArchitectureWhatBreaks(flows);
  const deploymentIntelligence = buildDeploymentIntelligence(flows);
  const serviceIntelligence = buildServiceArchitectureIntelligence(services);
  const deploymentFlowIds = recordArray(deploymentIntelligence, 'flows')
    .filter(isRecord)
    .map((flow) => String(flow.flow_id ?? ''))
    .filter((id) => id !== '');
  if (deploymentFlowIds.length > 0) {
    reviewHints.push({
      reason:
        'Deployment flows should be reviewed with deployment config, smoke checks, storage, auth, and CORS evidence.',
      affected_flows: deploymentFlowIds,
      suggested_tests: ['production smoke check'],
      confidence: 'inferred',
    });
  }
  if (routeArchitecture.length > 0) {
    reviewHints.push({
      reason: 'Next.js app-router surfaces should be reviewed as route-level architecture.',
      affected_flows: routeArchitecture.map((route) => String(route.flow_id ?? '')),
      affected_routes: routeArchitecture.map((route) => String(route.route_path ?? '')),
      suggested_tests: unique(
        flows.filter(isNextAppRouterFlow).flatMap((flow) => flowStringArray(flow, 'tests')),
      ).map(safeText),
      confidence: 'inferred',
    });
  }
  if (services.length > 0) {
    reviewHints.push({
      reason:
        'Service-level changes should be reviewed with routes, flows, storage, env vars, external APIs, deployment configs, and smoke checks.',
      affected_services: services.map((service) => safeText(service.id)),
      affected_flows: unique(
        services.flatMap((service) => serviceDataStringArray(service, 'related_flows')),
      ),
      suggested_tests: unique(
        services
          .flatMap((service) => serviceDataStringArray(service, 'related_flows'))
          .flatMap((flowId) => {
            const flow = flows.find((item) => item.id === flowId);
            return flow === undefined ? [] : flowStringArray(flow, 'tests');
          }),
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
    flows,
  });
  const designPressures = sorted(
    [
      ...architectureDesignPressures({ components, flowsByComponent }),
      ...routeArchitectureDesignPressures(flows),
    ],
    (pressure) => pressure.pressure_id,
  );
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
  const impactMap = buildArchitectureImpactMap({
    components,
    flows,
    flowsByComponent,
    relationships: params.relationships,
  });
  const serviceCausalityReasoning = buildArchitectureServiceCausalityReasoning(flows);
  const architectureUnknowns = unique([
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
    ...serviceCausalityReasoning.unknowns,
  ]).map(safeText);
  const confidenceDebt = buildArchitectureConfidenceDebt({
    assumptions: architectureAssumptions,
    tradeoffMatrix,
    routeArchitecture,
    boundaryRationale,
    evidenceGaps,
    unknowns: architectureUnknowns,
  });
  return {
    generated_at: params.now,
    project_id: projectId,
    boundary_candidates: boundaryCandidates,
    coupling_hotspots: couplingHotspots,
    critical_paths: criticalPaths,
    risky_seams: riskySeams,
    tradeoff_matrix: tradeoffMatrix,
    what_breaks: whatBreaks,
    route_architecture: routeArchitecture,
    route_what_breaks: routeWhatBreaks,
    deployment_intelligence: deploymentIntelligence,
    service_intelligence: serviceIntelligence,
    service_causality_reasoning: serviceCausalityReasoning,
    impact_map: impactMap,
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
      service_causality_path_count: serviceCausalityReasoning.total_paths,
      service_causality_unknown_count: serviceCausalityReasoning.unknowns.length,
      evidence_gap_count: evidenceGaps.length,
      top_design_pressures: highPressures.slice(0, 10).map((pressure) => pressure.pressure_id),
      top_risky_couplings: riskyCouplings.slice(0, 10).map((rationale) => rationale.component_id),
      summary:
        'Architecture reasoning is deterministic static inference; risky/intentional coupling reflects import, flow, config, dependency, and test evidence.',
    },
    assumption_confidence: architectureAssumptionConfidenceSummary(architectureAssumptions),
    confidence_debt: confidenceDebt,
    evidence_gaps: evidenceGaps,
    unknowns: architectureUnknowns,
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
    flows,
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

type AskReadinessStatus = 'ready' | 'limited' | 'blocked';

type PieAcceptanceStatus = 'pass' | 'limited' | 'blocking';

interface AskReadinessGate {
  readonly key: string;
  readonly label: string;
  readonly status: AskReadinessStatus;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly next_required_improvements: readonly string[];
}

function askGateStatus(score: number, isBlocked: boolean): AskReadinessStatus {
  if (isBlocked || score < 45) return 'blocked';
  if (score < 80) return 'limited';
  return 'ready';
}

function askGate(params: {
  readonly key: string;
  readonly label: string;
  readonly score: number;
  readonly isBlocked: boolean;
  readonly readyReason: string;
  readonly limitedReason: string;
  readonly blockedReason: string;
  readonly nextRequiredImprovement: string;
}): AskReadinessGate {
  const score = boundedScore(params.score);
  const status = askGateStatus(score, params.isBlocked);
  let reason = params.readyReason;
  if (status === 'limited') {
    reason = params.limitedReason;
  } else if (status === 'blocked') {
    reason = params.blockedReason;
  }
  const nextRequiredImprovements =
    status === 'ready' ? [] : [safeText(params.nextRequiredImprovement)];
  return {
    key: params.key,
    label: params.label,
    status,
    score,
    reasons: [safeText(reason)],
    next_required_improvements: nextRequiredImprovements,
  };
}

function askReadinessOverallStatus(gates: readonly AskReadinessGate[]): AskReadinessStatus {
  if (gates.some((gate) => gate.status === 'blocked')) return 'blocked';
  if (gates.some((gate) => gate.status === 'limited')) return 'limited';
  return 'ready';
}

function askReadinessSummary(status: AskReadinessStatus, score: number): string {
  if (status === 'ready') {
    return `${score}/100 local readiness for future broader repo questions.`;
  }
  if (status === 'limited') {
    return `${score}/100 local readiness; future broader repo questions need more evidence before answers can be trusted broadly.`;
  }
  return `${score}/100 local readiness; future broader repo questions are blocked until the weak gates improve.`;
}

function buildBenchmarkReadyArtifact(params: {
  readonly projectName: string;
  readonly now: string;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
  readonly changedFiles: readonly string[];
  readonly staleFiles: readonly string[];
  readonly incrementalMetrics: IncrementalUnderstandingMetrics;
  readonly architectureReasoning: unknown;
  readonly evidenceQuality: unknown;
}): Record<string, unknown> {
  const entities = allBucketEntities(params.buckets);
  const activeEntities = entities.filter((entity) => entity.latest_status !== 'stale');
  const activeFileEntities = params.buckets.files.filter((file) => file.latest_status !== 'stale');
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
  const benchmarkTaskCandidates = sorted(
    [
      ...benchmarkTasksFromComponents(params.buckets.components),
      ...benchmarkTasksFromFlows(params.buckets.flows),
      ...benchmarkTasksFromArchitectureImpact(params.architectureReasoning),
      ...benchmarkTasksFromReviewHints({
        architectureReasoning: params.architectureReasoning,
        buckets: params.buckets,
      }),
      ...benchmarkTasksFromEvidenceUnknowns({
        evidenceQuality: params.evidenceQuality,
        architectureReasoning: params.architectureReasoning,
        buckets: params.buckets,
      }),
    ],
    (task) => task.id,
  );
  const rawBenchmarkTaskCounts = countByValue(benchmarkTaskCandidates.map((task) => task.category));
  const benchmarkTaskCounts = Object.fromEntries(
    BENCHMARK_TASK_CATEGORIES.map((category) => [category, rawBenchmarkTaskCounts[category] ?? 0]),
  );
  const coveredBenchmarkTaskCategories = BENCHMARK_TASK_CATEGORIES.filter(
    (category) => (rawBenchmarkTaskCounts[category] ?? 0) > 0,
  );
  const missingBenchmarkTaskCategories = BENCHMARK_TASK_CATEGORIES.filter(
    (category) => (rawBenchmarkTaskCounts[category] ?? 0) === 0,
  );
  const benchmarkTaskCategoryRatio = ratio(
    coveredBenchmarkTaskCategories.length,
    BENCHMARK_TASK_CATEGORIES.length,
  );
  const architectureImpactMap = isRecord(params.architectureReasoning)
    ? params.architectureReasoning.impact_map
    : undefined;
  const architectureImpactSummaryRecord =
    isRecord(architectureImpactMap) && isRecord(architectureImpactMap.summary)
      ? architectureImpactMap.summary
      : {};
  const architectureImpactEntries = isRecord(architectureImpactMap)
    ? recordArray(architectureImpactMap, 'entries').filter(isRecord)
    : [];
  const totalArchitectureImpactSurfaces = recordNumber(
    architectureImpactSummaryRecord,
    'total_surfaces',
  );
  const architectureImpactEntriesWithEvidence = architectureImpactEntries.filter(
    (entry) =>
      recordArray(entry, 'evidence_ids').length > 0 && recordArray(entry, 'what_breaks').length > 0,
  ).length;
  const architectureImpactCoverageRatio =
    totalArchitectureImpactSurfaces === 0
      ? 0
      : ratio(architectureImpactEntriesWithEvidence, totalArchitectureImpactSurfaces);
  const architectureImpactScore = boundedScore(architectureImpactCoverageRatio * 100);
  const confidenceScores = activeEntities.map((entity) =>
    confidenceScoreForValue(entity.confidence),
  );
  const confidenceCalibrationScore = boundedScore(averageConfidenceScore(confidenceScores) * 100);
  const activeFileRatio = completeRatio(activeFileEntities.length, params.buckets.files.length);
  const evidenceReferenceRatio = missingEvidenceReferences.length === 0 ? 1 : 0;
  const scanPresenceRatio = activeFileEntities.length > 0 ? 1 : 0;
  const localScanScore = boundedScore(
    ((scanPresenceRatio + activeFileRatio + evidenceReferenceRatio) / 3) * 100,
  );
  const readinessDimensionScores = [
    boundedScore(componentCoverageRatio * 100),
    boundedScore(flowCoverageRatio * 100),
    boundedScore(evidenceCoverageRatio * 100),
    boundedScore(unknownCoverageRatio * 100),
    confidenceCalibrationScore,
    boundedScore(benchmarkTaskCategoryRatio * 100),
    localScanScore,
  ];
  const calibrationScore = boundedScore(
    readinessDimensionScores.reduce((total, score) => total + score, 0) /
      readinessDimensionScores.length,
  );
  const evidenceQualityScore = recordNumber(params.evidenceQuality, 'overall_score');
  const evidenceGapCount = recordNumber(params.evidenceQuality, 'evidence_gap_count');
  const redactionSafetyScore = recordNumber(params.evidenceQuality, 'redaction_safety_score');
  const redactedEvidenceCount = recordNumber(params.evidenceQuality, 'redacted_evidence_count');
  const redactedReferenceCount = recordNumber(params.evidenceQuality, 'redacted_reference_count');
  const unsafeSensitiveReferenceCount = recordNumber(
    params.evidenceQuality,
    'unsafe_sensitive_reference_count',
  );
  const unknownCoverageScore =
    unknownItems.length > unknownsWithEvidence.length
      ? Math.min(boundedScore(unknownCoverageRatio * 100), 79)
      : boundedScore(unknownCoverageRatio * 100);
  const incrementalFreshnessScore = boundedScore(
    Math.max(0, 100 - params.incrementalMetrics.stale_fact_count * 15) * 0.45 +
      params.incrementalMetrics.scan_efficiency_score * 0.35 +
      boundedScore(activeFileRatio * 100) * 0.2,
  );
  const askGates = [
    askGate({
      key: 'component_coverage',
      label: 'Component coverage',
      score: componentCoverageRatio * 100,
      isBlocked: components.length > 0 && componentsWithCoverage.length === 0,
      readyReason: `${componentsWithCoverage.length}/${components.length} component(s) have boundary, flow, and evidence signals.`,
      limitedReason:
        'Some components are missing boundary, flow, or evidence signals needed for broad repo questions.',
      blockedReason:
        'No component has the boundary, flow, and evidence coverage needed for broad repo questions.',
      nextRequiredImprovement:
        'Add or refresh component evidence until important components have boundary, flow, and evidence signals.',
    }),
    askGate({
      key: 'flow_coverage',
      label: 'Flow coverage',
      score: flowCoverageRatio * 100,
      isBlocked: flows.length === 0 || (flows.length > 0 && flowsWithCoverage.length === 0),
      readyReason: `${flowsWithCoverage.length}/${flows.length} flow(s) have entrypoint, step, and evidence signals.`,
      limitedReason:
        'Some flows are missing entrypoint, step, or evidence signals needed for future broader questions.',
      blockedReason: 'No usable flow coverage is available for future broader repo questions.',
      nextRequiredImprovement:
        'Add route, command, test, or source evidence that lets Rizz reconstruct at least one evidence-backed flow.',
    }),
    askGate({
      key: 'architecture_impact_coverage',
      label: 'Architecture impact coverage',
      score: architectureImpactScore,
      isBlocked:
        (components.length > 0 || flows.length > 0) && totalArchitectureImpactSurfaces === 0,
      readyReason: `${architectureImpactEntriesWithEvidence}/${totalArchitectureImpactSurfaces} architecture impact surface(s) have evidence and what-breaks notes.`,
      limitedReason:
        'Architecture impact exists but does not yet cover every mapped surface with evidence and what-breaks notes.',
      blockedReason:
        'No architecture impact surface is mapped, so future broader questions cannot explain blast radius reliably.',
      nextRequiredImprovement:
        'Refresh architecture reasoning until components or routes have evidence-backed impact surfaces and what-breaks notes.',
    }),
    askGate({
      key: 'evidence_quality',
      label: 'Evidence quality',
      score: evidenceQualityScore,
      isBlocked: evidenceClaimCount > 0 && evidenceBackedClaimCount === 0,
      readyReason: `${evidenceQualityScore}/100 evidence quality with ${evidenceGapCount} evidence gap(s).`,
      limitedReason:
        'Evidence quality has gaps, so broad answers should stay qualified until claims are better supported.',
      blockedReason:
        'Evidence claims are not backed strongly enough to support future broader repo questions.',
      nextRequiredImprovement:
        'Attach direct evidence to weak component, flow, relationship, and field claims.',
    }),
    askGate({
      key: 'unknown_coverage',
      label: 'Unknown coverage',
      score: unknownCoverageScore,
      isBlocked: unknownItems.length > 0 && unknownsWithEvidence.length === 0,
      readyReason: `${unknownsWithEvidence.length}/${unknownItems.length} known unknown(s) have evidence pointers.`,
      limitedReason:
        'Some known unknowns lack evidence pointers, so broad answers need visible caveats.',
      blockedReason:
        'Known unknowns exist without evidence pointers, which blocks trustworthy broad answers.',
      nextRequiredImprovement:
        'Link each important unknown to source, test, risk, or architecture evidence.',
    }),
    askGate({
      key: 'review_readiness',
      label: 'Review readiness',
      score: readinessScore,
      isBlocked: blockingGaps.length > 0 && readinessScore < 45,
      readyReason: `${readinessScore}/100 deterministic review readiness with no blocking benchmark gaps.`,
      limitedReason:
        'Review readiness has benchmark gaps that should be resolved before broad answers guide decisions.',
      blockedReason:
        'Review readiness is blocked by benchmark gaps in component, flow, or evidence coverage.',
      nextRequiredImprovement:
        'Clear benchmark readiness blocking gaps before relying on broad repo answers.',
    }),
    askGate({
      key: 'benchmark_task_coverage',
      label: 'Benchmark task coverage',
      score: benchmarkTaskCategoryRatio * 100,
      isBlocked: coveredBenchmarkTaskCategories.length === 0,
      readyReason: `${coveredBenchmarkTaskCategories.length}/${BENCHMARK_TASK_CATEGORIES.length} benchmark task categories are covered.`,
      limitedReason:
        'Some benchmark task categories are missing, so future broad questions cannot be evaluated across all expected surfaces.',
      blockedReason:
        'No benchmark task categories are covered for evaluating future broad repo questions.',
      nextRequiredImprovement:
        'Emit benchmark tasks for component, flow, architecture impact, review, and evidence/unknown coverage.',
    }),
    askGate({
      key: 'incremental_freshness',
      label: 'Incremental freshness',
      score: incrementalFreshnessScore,
      isBlocked: activeFileEntities.length === 0 || missingEvidenceReferences.length > 0,
      readyReason: `${activeFileEntities.length} active file entity/entities with ${params.incrementalMetrics.stale_fact_count} stale fact candidate(s).`,
      limitedReason:
        'Incremental freshness is usable but stale facts or low scan reuse should keep future broad answers cautious.',
      blockedReason:
        'Incremental freshness is blocked by missing active files or dangling evidence references.',
      nextRequiredImprovement:
        'Run a fresh local brain scan and resolve dangling evidence references before broad answers are trusted.',
    }),
    askGate({
      key: 'redaction_safety',
      label: 'Redaction safety',
      score: redactionSafetyScore,
      isBlocked: unsafeSensitiveReferenceCount > 0,
      readyReason:
        redactedEvidenceCount + redactedReferenceCount > 0
          ? 'Sensitive references are represented with redacted identifiers and no unsafe references remain.'
          : 'No unsafe sensitive references were detected in generated research artifacts.',
      limitedReason:
        'Sensitive references were handled, but redaction safety is below the ready threshold.',
      blockedReason: 'Unsafe sensitive references remain in generated research artifacts.',
      nextRequiredImprovement:
        'Redact or omit unsafe secret, token, credential, and private path references before sharing artifacts.',
    }),
  ];
  const askReadinessStatus = askReadinessOverallStatus(askGates);
  const askReadinessScore = boundedScore(
    askGates.reduce((total, gate) => total + gate.score, 0) / askGates.length,
  );
  const askReadinessReasons = askGates
    .filter((gate) => gate.status !== 'ready')
    .flatMap((gate) => gate.reasons)
    .slice(0, 12);
  const askReadinessNextRequiredImprovements = unique(
    askGates.flatMap((gate) => gate.next_required_improvements),
  ).slice(0, 12);
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
    readiness_calibration: {
      schema_version: 1,
      deterministic: true,
      provider_calls_required: false,
      network_required: false,
      redaction_safe: true,
      overall_score: calibrationScore,
      calibration_rule:
        'Readiness calibration averages deterministic local component, flow, evidence, unknown, confidence, benchmark-task, and scan-readiness scores.',
      dimensions: {
        component_coverage: {
          score: boundedScore(componentCoverageRatio * 100),
          total: components.length,
          covered: componentsWithCoverage.length,
          coverage_ratio: componentCoverageRatio,
          required_signals: ['boundary_type', 'flow_coverage', 'evidence_ids'],
          uncovered_component_ids: components
            .filter((component) => !componentsWithCoverage.includes(component))
            .map((component) => component.id),
        },
        flow_coverage: {
          score: boundedScore(flowCoverageRatio * 100),
          total: flows.length,
          covered: flowsWithCoverage.length,
          coverage_ratio: flowCoverageRatio,
          required_signals: ['entrypoints', 'steps', 'evidence_ids'],
          uncovered_flow_ids: flows
            .filter((flow) => !flowsWithCoverage.includes(flow))
            .map((flow) => flow.id),
        },
        evidence_coverage: {
          score: boundedScore(evidenceCoverageRatio * 100),
          records: params.buckets.evidence.length,
          claims: evidenceClaimCount,
          claims_with_evidence: evidenceBackedClaimCount,
          coverage_ratio: evidenceCoverageRatio,
          missing_references: missingEvidenceReferences,
        },
        unknown_coverage: {
          score: boundedScore(unknownCoverageRatio * 100),
          total: unknownItems.length,
          covered: unknownsWithEvidence.length,
          coverage_ratio: unknownCoverageRatio,
          uncovered_count: unknownItems.length - unknownsWithEvidence.length,
        },
        confidence_calibration: {
          score: confidenceCalibrationScore,
          entity_count: activeEntities.length,
          confidence_distribution: countByConfidence(
            activeEntities.map((entity) => entity.confidence),
          ),
          low_confidence_entity_count: activeEntities.filter(
            (entity) => entity.confidence !== 'verified',
          ).length,
          calibration_rule:
            'Confidence calibration is the average deterministic confidence score for active local brain entities.',
        },
        benchmark_task_category_coverage: {
          score: boundedScore(benchmarkTaskCategoryRatio * 100),
          task_count: benchmarkTaskCandidates.length,
          required_categories: BENCHMARK_TASK_CATEGORIES,
          covered_categories: coveredBenchmarkTaskCategories,
          missing_categories: missingBenchmarkTaskCategories,
          coverage_ratio: benchmarkTaskCategoryRatio,
          task_categories: benchmarkTaskCounts,
          calibration_rule:
            'Benchmark task category coverage reuses the deterministic benchmark task candidate builders.',
        },
        local_scan_readiness_summary: {
          score: localScanScore,
          active_file_entities: activeFileEntities.length,
          stale_file_entities: params.staleFiles.length,
          changed_file_count: params.changedFiles.length,
          scan_efficiency_score: params.incrementalMetrics.scan_efficiency_score,
          missing_evidence_reference_count: missingEvidenceReferences.length,
          ready: activeFileEntities.length > 0 && missingEvidenceReferences.length === 0,
          calibration_rule:
            'Local scan readiness requires at least one active file entity and no dangling evidence references; incremental scan efficiency is reported separately.',
        },
      },
    },
    readiness: {
      is_ready: blockingGaps.length === 0,
      score: readinessScore,
      calibration_score: calibrationScore,
      blocking_gaps: blockingGaps,
      notes: [
        'Benchmark readiness is computed from deterministic local brain facts only.',
        'Coverage ratios track component, flow, evidence, and known-unknown surfaces for PI-Bench seed fixtures.',
      ],
    },
    ask_readiness: {
      schema_version: 1,
      status: askReadinessStatus,
      score: askReadinessScore,
      summary: askReadinessSummary(askReadinessStatus, askReadinessScore),
      deterministic: true,
      provider_calls_required: false,
      network_required: false,
      scope:
        'Readiness gate for future broader repo questions; this does not provide a generic chat surface.',
      gates: askGates,
      reasons: askReadinessReasons,
      next_required_improvements: askReadinessNextRequiredImprovements,
      redaction_safety: {
        status: unsafeSensitiveReferenceCount === 0 ? 'ready' : 'blocked',
        redaction_applied: redactedEvidenceCount + redactedReferenceCount > 0,
        redaction_safety_score: redactionSafetyScore,
        redacted_evidence_count: redactedEvidenceCount,
        redacted_reference_count: redactedReferenceCount,
        unsafe_sensitive_reference_count: unsafeSensitiveReferenceCount,
        output_share_safe: unsafeSensitiveReferenceCount === 0,
      },
      notes: [
        'Ask readiness is deterministic and local-first; it only scores whether future broader questions have enough project intelligence support.',
        'A ready gate does not create a chat surface or provider-backed question-answer surface.',
      ],
    },
  };
}

function benchmarkTaskEvidence(evidenceIds: readonly string[]): BenchmarkTaskEvidence {
  const safeIds = unique(evidenceIds.map(safeText));
  const redacted_evidence_markers = safeIds.filter((id) => containsSensitiveReference(id));
  return {
    evidence_ids: safeIds.filter((id) => !containsSensitiveReference(id)),
    redacted_evidence_markers,
    redacted_evidence_count: redactedReferenceCount(redacted_evidence_markers),
  };
}

function benchmarkTaskCandidate(params: {
  readonly id: string;
  readonly category: BenchmarkTaskCategory;
  readonly prompt: string;
  readonly target: BenchmarkTaskCandidate['target'];
  readonly evidenceIds: readonly string[];
  readonly confidence: Confidence;
  readonly confidenceScore: number;
  readonly expectedArtifact: string;
  readonly expectedCheckFields: readonly string[];
  readonly whyItMatters: string;
}): BenchmarkTaskCandidate {
  const evidence = benchmarkTaskEvidence(params.evidenceIds);
  return {
    id: params.id,
    category: params.category,
    prompt: safeText(params.prompt),
    target: {
      entity_id: safeText(params.target.entity_id),
      entity_type: params.target.entity_type,
      name: safeText(params.target.name),
      surface: safeText(params.target.surface),
    },
    evidence_ids: evidence.evidence_ids,
    redacted_evidence_markers: evidence.redacted_evidence_markers,
    redacted_evidence_count: evidence.redacted_evidence_count,
    confidence: params.confidence,
    confidence_score: Number(params.confidenceScore.toFixed(4)),
    expected_artifact: params.expectedArtifact,
    expected_check_fields: params.expectedCheckFields.map(safeText),
    why_it_matters: safeText(params.whyItMatters),
  };
}

function confidenceFromValue(value: unknown): Confidence {
  if (value === 'verified' || value === 'inferred' || value === 'uncertain') return value;
  return 'inferred';
}

function benchmarkTasksFromComponents(
  components: readonly BrainEntity[],
): BenchmarkTaskCandidate[] {
  return sorted(
    components.filter((component) => component.latest_status !== 'stale'),
    (component) => component.id,
  )
    .slice(0, 5)
    .map((component) =>
      benchmarkTaskCandidate({
        id: `task:component-explanation:${stableSlug(component.id)}`,
        category: 'component-explanation',
        prompt: `Explain what ${component.name} owns, where to read first, what depends on it, and what can break if it changes.`,
        target: {
          entity_id: component.id,
          entity_type: 'component',
          name: component.name,
          surface: stringData(component, 'boundary_type') ?? 'component',
        },
        evidenceIds: evidenceIdsForComponent(component),
        confidence: component.confidence,
        confidenceScore: componentConfidenceScore(component),
        expectedArtifact: '.rizz/research/component_intelligence.json',
        expectedCheckFields: [
          'components[].purpose',
          'components[].field_evidence',
          'components[].flow_count',
          'components[].coupling',
          'components[].failure_modes',
        ],
        whyItMatters:
          'Component explanation tasks turn the project map into a benchmarkable first-read path for understanding any repo in 10 minutes instead of 2 days.',
      }),
    );
}

function benchmarkTasksFromFlows(flows: readonly BrainEntity[]): BenchmarkTaskCandidate[] {
  return sorted(
    flows.filter((flow) => flow.latest_status !== 'stale'),
    (flow) => flow.id,
  )
    .slice(0, 5)
    .map((flow) =>
      benchmarkTaskCandidate({
        id: `task:flow-explanation:${stableSlug(flow.id)}`,
        category: 'flow-explanation',
        prompt: `Explain the ${flow.name} flow from entrypoint through steps, touched components, tests, risks, and confidence gaps.`,
        target: {
          entity_id: flow.id,
          entity_type: 'flow',
          name: flow.name,
          surface: flowKind(flow),
        },
        evidenceIds: evidenceIdsForFlow(flow),
        confidence: flow.confidence,
        confidenceScore: asFlowConfidenceScore(flow),
        expectedArtifact: '.rizz/research/flow_understanding.json',
        expectedCheckFields: [
          'contracts[].entry_contract',
          'contracts[].exit_contract',
          'contracts[].failure_modes',
          'low_confidence_flows',
          'flow_coverage.flows[]',
        ],
        whyItMatters:
          'Flow explanation tasks prove Rizz can reconstruct how work moves through the repo without making a user manually inspect fixtures for two days.',
      }),
    );
}

function benchmarkTasksFromArchitectureImpact(
  architectureReasoning: unknown,
): BenchmarkTaskCandidate[] {
  const impactMap = isRecord(architectureReasoning) ? architectureReasoning.impact_map : undefined;
  const impactEntries = isRecord(impactMap) ? recordArray(impactMap, 'entries') : [];
  return impactEntries
    .filter(isRecord)
    .slice(0, 5)
    .map((entry) => {
      const entityId = typeof entry.entity_id === 'string' ? entry.entity_id : 'project';
      const name = typeof entry.name === 'string' ? entry.name : entityId;
      const surfaceType =
        typeof entry.surface_type === 'string' ? entry.surface_type : 'architecture_surface';
      const confidence = confidenceFromValue(entry.confidence);
      const confidenceScore =
        typeof entry.confidence_score === 'number' ? entry.confidence_score : 0.65;
      return benchmarkTaskCandidate({
        id: `task:architecture-impact:${stableSlug(entityId)}`,
        category: 'architecture-impact',
        prompt: `Assess the architecture impact of changing ${name}: affected flows, components, files, tests, configs, and what breaks.`,
        target: {
          entity_id: entityId,
          entity_type: 'architecture_surface',
          name,
          surface: surfaceType,
        },
        evidenceIds: asStringArray(entry.evidence_ids),
        confidence,
        confidenceScore,
        expectedArtifact: '.rizz/research/architecture_reasoning.json',
        expectedCheckFields: [
          'impact_map.entries[].affected_flows',
          'impact_map.entries[].affected_components',
          'impact_map.entries[].affected_tests',
          'impact_map.entries[].what_breaks',
          'confidence_debt.low_confidence_areas',
        ],
        whyItMatters:
          'Architecture impact tasks benchmark whether local scans can explain blast radius before a user spends days tracing dependencies by hand.',
      });
    });
}

function entityById(entities: readonly BrainEntity[]): ReadonlyMap<string, BrainEntity> {
  return new Map(entities.map((entity) => [entity.id, entity]));
}

function benchmarkTasksFromReviewHints(params: {
  readonly architectureReasoning: unknown;
  readonly buckets: BrainBuckets;
}): BenchmarkTaskCandidate[] {
  const entities = entityById(allBucketEntities(params.buckets));
  const hints = isRecord(params.architectureReasoning)
    ? recordArray(params.architectureReasoning, 'review_hints')
    : [];
  return hints
    .filter(isRecord)
    .slice(0, 5)
    .map((hint, index) => {
      const affectedIds = unique([
        ...asStringArray(hint.affected_components),
        ...asStringArray(hint.affected_flows),
      ]);
      const targetId = affectedIds[0] ?? entityId('review', `hint-${index + 1}`);
      const target = entities.get(targetId);
      const reason =
        typeof hint.reason === 'string' ? hint.reason : 'Review local blast-radius evidence.';
      const confidence = confidenceFromValue(hint.confidence);
      return benchmarkTaskCandidate({
        id: `task:review-blast-radius:${stableSlug(targetId)}:${index + 1}`,
        category: 'review-blast-radius',
        prompt: `${reason} Identify affected surfaces, suggested tests, and evidence that should constrain review scope.`,
        target: {
          entity_id: targetId,
          entity_type: target?.type ?? 'review',
          name: target?.name ?? `review hint ${index + 1}`,
          surface: 'review-blast-radius',
        },
        evidenceIds: affectedIds.flatMap((id) => entities.get(id)?.evidence_ids ?? []),
        confidence,
        confidenceScore: confidenceScoreForValue(confidence),
        expectedArtifact: '.rizz/research/architecture_reasoning.json',
        expectedCheckFields: [
          'review_hints[].affected_components',
          'review_hints[].affected_flows',
          'review_hints[].suggested_tests',
          'risk_concentrations',
          'impact_map.entries[]',
        ],
        whyItMatters:
          'Review blast-radius tasks make local scans benchmark-ready for the moment a user asks what changed and what must be checked.',
      });
    });
}

function benchmarkTasksFromEvidenceUnknowns(params: {
  readonly evidenceQuality: unknown;
  readonly architectureReasoning: unknown;
  readonly buckets: BrainBuckets;
}): BenchmarkTaskCandidate[] {
  const topGaps = isRecord(params.evidenceQuality)
    ? recordArray(params.evidenceQuality, 'top_evidence_gaps')
    : [];
  const gapTasks = topGaps
    .filter(isRecord)
    .slice(0, 5)
    .map((gap, index) => {
      const id = typeof gap.id === 'string' ? gap.id : `evidence-gap-${index + 1}`;
      const reason = typeof gap.reason === 'string' ? gap.reason : 'Evidence gap recorded.';
      const field = typeof gap.field === 'string' ? gap.field : 'evidence';
      return benchmarkTaskCandidate({
        id: `task:evidence-unknown-coverage:${stableSlug(id)}:${stableSlug(field)}`,
        category: 'evidence-unknown-coverage',
        prompt: `Identify the evidence or unknown coverage gap for ${id}: ${reason}`,
        target: {
          entity_id: id,
          entity_type: 'coverage_surface',
          name: field,
          surface: 'evidence-unknown-coverage',
        },
        evidenceIds: [],
        confidence: 'uncertain',
        confidenceScore: 0.35,
        expectedArtifact: '.rizz/research/evidence_quality.json',
        expectedCheckFields: [
          'top_evidence_gaps[].reason',
          'evidence_calibration.inspect_first',
          'redaction_safety_score',
          'missing_evidence_references',
          'unknowns_from_redaction',
        ],
        whyItMatters:
          'Evidence and unknown coverage tasks prevent benchmark answers from sounding certain when local evidence is weak or redacted.',
      });
    });
  if (gapTasks.length > 0) return gapTasks;

  return topUnknowns({
    buckets: params.buckets,
    architectureReasoning: params.architectureReasoning,
    evidenceQuality: params.evidenceQuality,
  })
    .slice(0, 5)
    .map((unknown, index) =>
      benchmarkTaskCandidate({
        id: `task:evidence-unknown-coverage:unknown-${index + 1}`,
        category: 'evidence-unknown-coverage',
        prompt: `Explain what remains unknown and which local artifact should limit confidence: ${unknown}`,
        target: {
          entity_id: `unknown:${index + 1}`,
          entity_type: 'coverage_surface',
          name: `unknown ${index + 1}`,
          surface: 'known-unknown',
        },
        evidenceIds: [],
        confidence: 'uncertain',
        confidenceScore: 0.35,
        expectedArtifact: '.rizz/research/architecture_reasoning.json',
        expectedCheckFields: ['unknowns', 'confidence_debt.blocking_unknowns', 'evidence_gaps'],
        whyItMatters:
          'Known-unknown tasks keep the 10-minute repo understanding claim honest by showing where confidence must stop.',
      }),
    );
}

function buildBenchmarkTasksArtifact(params: {
  readonly projectName: string;
  readonly now: string;
  readonly buckets: BrainBuckets;
  readonly architectureReasoning: unknown;
  readonly evidenceQuality: unknown;
  readonly benchmarkReady: unknown;
  readonly understandingScore: unknown;
}): Record<string, unknown> {
  const tasks = sorted(
    [
      ...benchmarkTasksFromComponents(params.buckets.components),
      ...benchmarkTasksFromFlows(params.buckets.flows),
      ...benchmarkTasksFromArchitectureImpact(params.architectureReasoning),
      ...benchmarkTasksFromReviewHints({
        architectureReasoning: params.architectureReasoning,
        buckets: params.buckets,
      }),
      ...benchmarkTasksFromEvidenceUnknowns({
        evidenceQuality: params.evidenceQuality,
        architectureReasoning: params.architectureReasoning,
        buckets: params.buckets,
      }),
    ],
    (task) => task.id,
  );
  const rawCategoryCounts = countByValue(tasks.map((task) => task.category));
  const categoryCounts = Object.fromEntries(
    BENCHMARK_TASK_CATEGORIES.map((category) => [category, rawCategoryCounts[category] ?? 0]),
  );
  const readiness = isRecord(params.benchmarkReady) ? params.benchmarkReady.readiness : undefined;
  const score = isRecord(readiness) && typeof readiness.score === 'number' ? readiness.score : 0;
  const understandingLevel = isRecord(params.understandingScore)
    ? params.understandingScore.score_band
    : undefined;

  return {
    schema_version: 1,
    generated_at: params.now,
    project_id: entityId('project', params.projectName),
    project_name: safeText(params.projectName),
    deterministic: true,
    provider_calls_required: false,
    network_required: false,
    task_count: tasks.length,
    task_categories: categoryCounts,
    research_pointer: {
      latest: '.rizz/brain/latest.json',
      index: '.rizz/brain/index.json',
      mission_control: '.rizz/reports/index.html',
      summary: `Mission Control links ${tasks.length} benchmark task candidate(s) to local research artifacts with readiness ${score}/100.`,
    },
    understanding_goal:
      'Understand any repo in 10 minutes instead of 2 days by turning local brain facts into deterministic benchmark prompts.',
    understanding_level:
      typeof understandingLevel === 'string'
        ? understandingLevel
        : scoreBand(readinessScore(params.benchmarkReady)),
    tasks,
  };
}

function pieAcceptanceStatus(score: number, isBlocking: boolean): PieAcceptanceStatus {
  if (isBlocking || score < 45) return 'blocking';
  if (score < 80) return 'limited';
  return 'pass';
}

function pieAcceptanceStatusFromAsk(status: string, score: number): PieAcceptanceStatus {
  if (status === 'blocked') return 'blocking';
  if (status === 'limited') return 'limited';
  return pieAcceptanceStatus(score, false);
}

function pieAcceptanceDimension(params: {
  readonly key: string;
  readonly label: string;
  readonly score: number;
  readonly isBlocking?: boolean;
  readonly evidenceBasis: readonly string[];
  readonly artifactPointers: readonly string[];
  readonly weakSpots?: readonly string[];
  readonly nextRequiredImprovements?: readonly string[];
}): Record<string, unknown> {
  const score = boundedScore(params.score);
  const status = pieAcceptanceStatus(score, params.isBlocking === true);
  const weakSpots = unique((params.weakSpots ?? []).filter((item) => item.trim() !== '')).slice(
    0,
    8,
  );
  const nextRequiredImprovements = unique(
    (params.nextRequiredImprovements ?? weakSpots).filter((item) => item.trim() !== ''),
  ).slice(0, 8);
  return {
    key: params.key,
    label: params.label,
    status,
    score,
    evidence_basis: unique(params.evidenceBasis).slice(0, 8),
    artifact_pointers: unique(params.artifactPointers),
    blocking_gaps: status === 'blocking' ? weakSpots : [],
    next_required_improvements: status === 'pass' ? [] : nextRequiredImprovements,
  };
}

function dimensionWeakSpots(value: unknown): string[] {
  return asStringArray(recordArray(value, 'weak_spots'));
}

function dimensionScore(value: unknown): number {
  return recordNumber(value, 'score');
}

function dimensionStatus(value: unknown, score: number): string {
  return recordString(value, 'status', scoreBand(score));
}

function buildPieAcceptanceArtifact(params: {
  readonly projectName: string;
  readonly now: string;
  readonly buckets: BrainBuckets;
  readonly architectureReasoning: unknown;
  readonly evidenceQuality: unknown;
  readonly benchmarkReady: unknown;
  readonly benchmarkTasks: unknown;
  readonly understandingScore: unknown;
  readonly incrementalMetrics: IncrementalUnderstandingMetrics;
}): Record<string, unknown> {
  const understandingDimensions = nestedRecord(params.understandingScore, 'dimensions');
  const componentUnderstanding = nestedRecord(understandingDimensions, 'components');
  const flowUnderstanding = nestedRecord(understandingDimensions, 'flows');
  const architectureUnderstanding = nestedRecord(understandingDimensions, 'architecture');
  const evidenceUnderstanding = nestedRecord(understandingDimensions, 'evidence');
  const incrementalUnderstanding = nestedRecord(understandingDimensions, 'incremental_status');
  const reviewUnderstanding = nestedRecord(understandingDimensions, 'review_readiness');
  const calibration = nestedRecord(params.benchmarkReady, 'readiness_calibration');
  const calibrationDimensions = nestedRecord(calibration, 'dimensions');
  const benchmarkTaskCoverage = nestedRecord(
    calibrationDimensions,
    'benchmark_task_category_coverage',
  );
  const askReadiness = nestedRecord(params.benchmarkReady, 'ask_readiness');
  const askReadinessScore = recordNumber(askReadiness, 'score');
  const askReadinessStatus = recordString(askReadiness, 'status', scoreBand(askReadinessScore));
  const redactionSafety = nestedRecord(askReadiness, 'redaction_safety');
  const redactionSafetyScore = recordNumber(redactionSafety, 'redaction_safety_score');
  const redactedEvidenceCount = recordNumber(redactionSafety, 'redacted_evidence_count');
  const redactedReferenceCount = recordNumber(redactionSafety, 'redacted_reference_count');
  const unsafeSensitiveReferenceCount = recordNumber(
    redactionSafety,
    'unsafe_sensitive_reference_count',
  );
  const benchmarkTaskCount = recordNumber(params.benchmarkTasks, 'task_count');
  const taskCategoryCounts = nestedRecord(params.benchmarkTasks, 'task_categories');
  const benchmarkCategories = Object.entries(taskCategoryCounts)
    .map(([category, count]) => `${category}: ${String(count)}`)
    .sort((a, b) => a.localeCompare(b));
  const evidenceActionability = nestedRecord(params.evidenceQuality, 'actionability');
  const actionabilitySummary = recordString(
    evidenceActionability,
    'summary',
    'Evidence actionability has not been summarized yet.',
  );
  const architectureConfidenceDebt = nestedRecord(params.architectureReasoning, 'confidence_debt');
  const architectureBlockingUnknowns = recordNumber(
    architectureConfidenceDebt,
    'blocking_unknown_count',
  );
  const missionControlScore = benchmarkTaskCount > 0 ? 100 : 40;
  const explainQualityScore = boundedScore(
    (dimensionScore(componentUnderstanding) +
      dimensionScore(flowUnderstanding) +
      dimensionScore(evidenceUnderstanding)) /
      3,
  );
  const dimensions = [
    pieAcceptanceDimension({
      key: 'component_understanding',
      label: 'Component understanding',
      score: dimensionScore(componentUnderstanding),
      evidenceBasis: [
        dimensionStatus(componentUnderstanding, dimensionScore(componentUnderstanding)),
        `${params.buckets.components.length} component(s) mapped`,
      ],
      artifactPointers: [
        '.rizz/research/component_intelligence.json',
        '.rizz/research/understanding_score.json',
        '.rizz/brain/entities/components.json',
      ],
      weakSpots: dimensionWeakSpots(componentUnderstanding),
    }),
    pieAcceptanceDimension({
      key: 'flow_understanding',
      label: 'Flow understanding',
      score: dimensionScore(flowUnderstanding),
      evidenceBasis: [
        dimensionStatus(flowUnderstanding, dimensionScore(flowUnderstanding)),
        `${params.buckets.flows.length} reconstructed flow(s)`,
      ],
      artifactPointers: [
        '.rizz/research/flow_understanding.json',
        '.rizz/research/flow_coverage.json',
        '.rizz/brain/entities/flows.json',
      ],
      weakSpots: dimensionWeakSpots(flowUnderstanding),
    }),
    pieAcceptanceDimension({
      key: 'architecture_reasoning',
      label: 'Architecture reasoning',
      score: dimensionScore(architectureUnderstanding),
      isBlocking:
        architectureBlockingUnknowns > 0 && dimensionScore(architectureUnderstanding) < 45,
      evidenceBasis: [
        dimensionStatus(architectureUnderstanding, dimensionScore(architectureUnderstanding)),
        `${recordNumber(architectureConfidenceDebt, 'debt_count')} confidence debt item(s)`,
      ],
      artifactPointers: [
        '.rizz/research/architecture_reasoning.json',
        '.rizz/research/reasoning_traces.json',
      ],
      weakSpots: [
        ...dimensionWeakSpots(architectureUnderstanding),
        ...asStringArray(architectureConfidenceDebt.blocking_unknowns),
      ],
    }),
    pieAcceptanceDimension({
      key: 'evidence_quality_actionability',
      label: 'Evidence quality/actionability',
      score: dimensionScore(evidenceUnderstanding),
      evidenceBasis: [
        dimensionStatus(evidenceUnderstanding, dimensionScore(evidenceUnderstanding)),
        actionabilitySummary,
      ],
      artifactPointers: ['.rizz/research/evidence_quality.json', '.rizz/research/confidence.json'],
      weakSpots: dimensionWeakSpots(evidenceUnderstanding),
    }),
    pieAcceptanceDimension({
      key: 'incremental_understanding',
      label: 'Incremental understanding',
      score: dimensionScore(incrementalUnderstanding),
      evidenceBasis: [
        dimensionStatus(incrementalUnderstanding, dimensionScore(incrementalUnderstanding)),
        `${params.incrementalMetrics.changed_entity_count} changed understanding item(s)`,
        `${params.incrementalMetrics.stable_entity_count} stable understanding item(s)`,
      ],
      artifactPointers: [
        '.rizz/research/incremental_update.json',
        '.rizz/research/understanding_score.json',
      ],
      weakSpots: dimensionWeakSpots(incrementalUnderstanding),
    }),
    pieAcceptanceDimension({
      key: 'review_intelligence_blast_radius',
      label: 'Review intelligence/blast radius',
      score: dimensionScore(reviewUnderstanding),
      evidenceBasis: [
        dimensionStatus(reviewUnderstanding, dimensionScore(reviewUnderstanding)),
        `${params.buckets.risks.length} risk area(s) mapped`,
      ],
      artifactPointers: [
        '.rizz/research/architecture_reasoning.json',
        '.rizz/research/benchmark_ready.json',
      ],
      weakSpots: dimensionWeakSpots(reviewUnderstanding),
    }),
    pieAcceptanceDimension({
      key: 'benchmark_task_coverage',
      label: 'Benchmark task coverage',
      score: recordNumber(benchmarkTaskCoverage, 'score'),
      evidenceBasis: [`${benchmarkTaskCount} benchmark task candidate(s)`, ...benchmarkCategories],
      artifactPointers: [
        '.rizz/research/benchmark_tasks.json',
        '.rizz/research/benchmark_ready.json',
      ],
      weakSpots: asStringArray(benchmarkTaskCoverage.missing_categories).map(
        (category) => `Missing benchmark category: ${category}`,
      ),
      nextRequiredImprovements: [
        'Emit benchmark tasks for component, flow, architecture impact, review, and evidence/unknown coverage.',
      ],
    }),
    pieAcceptanceDimension({
      key: 'explain_quality',
      label: 'Explain quality',
      score: explainQualityScore,
      evidenceBasis: [
        'Explain quality is inferred from component, flow, and evidence dimensions used by rizz explain.',
        `${benchmarkTaskCount} benchmark task hint source(s) available`,
      ],
      artifactPointers: [
        '.rizz/research/component_intelligence.json',
        '.rizz/research/flow_understanding.json',
        '.rizz/research/evidence_quality.json',
        '.rizz/research/benchmark_tasks.json',
      ],
      weakSpots: unique([
        ...dimensionWeakSpots(componentUnderstanding),
        ...dimensionWeakSpots(flowUnderstanding),
        ...dimensionWeakSpots(evidenceUnderstanding),
      ]),
    }),
    pieAcceptanceDimension({
      key: 'ask_readiness',
      label: 'Ask readiness',
      score: askReadinessScore,
      isBlocking: askReadinessStatus === 'blocked',
      evidenceBasis: [
        recordString(
          askReadiness,
          'summary',
          'Future broader repo question readiness has not been summarized yet.',
        ),
      ],
      artifactPointers: ['.rizz/research/benchmark_ready.json', '.rizz/brain/latest.json'],
      weakSpots: asStringArray(askReadiness.reasons),
      nextRequiredImprovements: asStringArray(askReadiness.next_required_improvements),
    }),
    pieAcceptanceDimension({
      key: 'secret_safe_reliability',
      label: 'Secret-safe reliability',
      score: redactionSafetyScore,
      isBlocking: unsafeSensitiveReferenceCount > 0,
      evidenceBasis: [
        `${redactionSafetyScore}/100 redaction safety`,
        `${unsafeSensitiveReferenceCount} unsafe sensitive reference(s)`,
      ],
      artifactPointers: [
        '.rizz/research/evidence_quality.json',
        '.rizz/research/benchmark_ready.json',
      ],
      weakSpots:
        unsafeSensitiveReferenceCount > 0
          ? ['Unsafe sensitive references remain in generated artifacts.']
          : [],
      nextRequiredImprovements: [
        'Redact or omit unsafe secret, token, credential, and private path references before sharing artifacts.',
      ],
    }),
    pieAcceptanceDimension({
      key: 'mission_control_coverage',
      label: 'Mission Control coverage',
      score: missionControlScore,
      evidenceBasis: [
        'Mission Control links brain and research artifacts without requiring a server.',
        '.rizz/reports/index.html is the compact local report surface.',
      ],
      artifactPointers: [
        '.rizz/reports/index.html',
        '.rizz/brain/latest.json',
        '.rizz/research/pie_acceptance.json',
      ],
      weakSpots:
        benchmarkTaskCount > 0
          ? []
          : ['Mission Control has no benchmark task inventory to link yet.'],
      nextRequiredImprovements: [
        'Link PIE acceptance, benchmark readiness, and task inventory from Mission Control.',
      ],
    }),
  ];
  const statuses = dimensions.map((dimension) => recordString(dimension, 'status', 'limited'));
  let overallStatus: PieAcceptanceStatus = 'pass';
  if (statuses.includes('blocking')) {
    overallStatus = 'blocking';
  } else if (statuses.includes('limited')) {
    overallStatus = 'limited';
  }
  const overallScore = boundedScore(
    dimensions.reduce((total, dimension) => total + recordNumber(dimension, 'score'), 0) /
      dimensions.length,
  );
  const benchmarkReadiness = nestedRecord(params.benchmarkReady, 'readiness');
  const blockingGaps = unique([
    ...asStringArray(benchmarkReadiness.blocking_gaps),
    ...dimensions.flatMap((dimension) => asStringArray(dimension.blocking_gaps)),
  ]).slice(0, 12);
  const nextRequiredImprovements = unique(
    dimensions.flatMap((dimension) => asStringArray(dimension.next_required_improvements)),
  ).slice(0, 12);

  return {
    schema_version: 1,
    generated_at: params.now,
    project_id: entityId('project', params.projectName),
    project_name: safeText(params.projectName),
    deterministic: true,
    provider_calls_required: false,
    network_required: false,
    goal: 'Understand any repo in 10 minutes instead of 2 days.',
    overall_status: overallStatus,
    overall_score: overallScore,
    dimensions,
    blocking_gaps: blockingGaps,
    next_required_improvements: nextRequiredImprovements,
    artifact_pointers: {
      latest: '.rizz/brain/latest.json',
      index: '.rizz/brain/index.json',
      mission_control: '.rizz/reports/index.html',
      pie_acceptance: '.rizz/research/pie_acceptance.json',
      benchmark_ready: '.rizz/research/benchmark_ready.json',
      benchmark_tasks: '.rizz/research/benchmark_tasks.json',
      understanding_score: '.rizz/research/understanding_score.json',
      evidence_quality: '.rizz/research/evidence_quality.json',
      architecture_reasoning: '.rizz/research/architecture_reasoning.json',
      incremental_update: '.rizz/research/incremental_update.json',
    },
    confidence: {
      status: pieAcceptanceStatusFromAsk(askReadinessStatus, askReadinessScore),
      score: boundedScore(
        (recordNumber(calibration, 'overall_score') +
          recordNumber(params.understandingScore, 'overall_score') +
          redactionSafetyScore) /
          3,
      ),
      evidence_basis: [
        'Deterministic local brain entities, relationships, research metrics, benchmark readiness gates, and Mission Control artifact links.',
        `${params.buckets.evidence.length} local evidence record(s)`,
        `${params.buckets.components.length} component(s)`,
        `${params.buckets.flows.length} flow(s)`,
        `${benchmarkTaskCount} benchmark task(s)`,
      ],
      redaction_safety: {
        score: redactionSafetyScore,
        redacted_evidence_count: redactedEvidenceCount,
        redacted_reference_count: redactedReferenceCount,
        unsafe_sensitive_reference_count: unsafeSensitiveReferenceCount,
        output_share_safe: unsafeSensitiveReferenceCount === 0,
      },
    },
    evidence_basis: [
      '.rizz/research/benchmark_ready.json',
      '.rizz/research/benchmark_tasks.json',
      '.rizz/research/understanding_score.json',
      '.rizz/research/evidence_quality.json',
      '.rizz/reports/index.html',
    ],
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

function architectureImpactSummary(value: unknown): string {
  if (!isRecord(value)) return 'No deterministic architecture impact map is available yet.';
  const impactMap = isRecord(value.impact_map) ? value.impact_map : undefined;
  const summary = impactMap !== undefined && isRecord(impactMap.summary) ? impactMap.summary : {};
  const totalSurfaces = recordNumber(summary, 'total_surfaces');
  const componentSurfaces = recordNumber(summary, 'component_surfaces');
  const routeSurfaces = recordNumber(summary, 'route_surfaces');
  const highCouplingSurfaces = recordNumber(summary, 'high_coupling_surfaces');
  if (totalSurfaces === 0) return 'No deterministic architecture impact surfaces were mapped yet.';
  return `${totalSurfaces} impact surface(s): ${componentSurfaces} component(s), ${routeSurfaces} route(s), ${highCouplingSurfaces} high-coupling surface(s).`;
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
  readonly serviceIntelligence: unknown;
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
  const serviceScore = recordNumber(params.serviceIntelligence, 'service_understanding_score');
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
    services: dimensionRecord({
      score: serviceScore,
      summary: `${params.buckets.services.length} service(s), ${recordNumber(
        params.serviceIntelligence,
        'services_with_related_flows',
      )} linked to flows.`,
      signals: [
        `${recordNumber(params.serviceIntelligence, 'services_with_routes')} service(s) with routes`,
        `${recordNumber(params.serviceIntelligence, 'services_with_storage')} service(s) with storage evidence`,
        `${recordNumber(params.serviceIntelligence, 'services_with_external_apis')} service(s) with external API evidence`,
      ],
      weakSpots: recordArray(params.serviceIntelligence, 'unknowns')
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 6),
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
      recordNumber(dimensions.flows, 'score') * 0.14 +
      recordNumber(dimensions.services, 'score') * 0.1 +
      recordNumber(dimensions.architecture, 'score') * 0.14 +
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
  const serviceIncrementalHealth = buildEntityTypeIncrementalHealth({
    entityType: 'service',
    previousEntities,
    currentEntities,
    changedFileSet,
  });
  const flowIncrementalHealth = buildEntityTypeIncrementalHealth({
    entityType: 'flow',
    previousEntities,
    currentEntities,
    changedFileSet,
  });
  const serviceCausalityDelta = buildServiceCausalityDelta({
    previousEntities,
    currentEntities,
    changedFiles,
    evidenceDelta,
    serviceIncrementalHealth,
    flowIncrementalHealth,
  });
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
  const understandingDeltas = buildUnderstandingDeltas({
    previousFingerprint: params.previous.fingerprint,
    previousEntities,
    currentEntities,
    previousRelationships: params.previous.relationships,
    currentRelationships: params.relationships,
    relationshipDelta,
    changedFiles,
  });

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
    service_count: serviceIncrementalHealth.total,
    service_changed: serviceIncrementalHealth.changed,
    service_stale: serviceIncrementalHealth.stale,
    service_reused: serviceIncrementalHealth.reused,
    service_recomputed: serviceIncrementalHealth.recomputed,
    service_incremental_health: serviceIncrementalHealth,
    flow_count: flowIncrementalHealth.total,
    flow_changed: flowIncrementalHealth.changed,
    flow_stale: flowIncrementalHealth.stale,
    flow_reused: flowIncrementalHealth.reused,
    flow_recomputed: flowIncrementalHealth.recomputed,
    flow_incremental_health: flowIncrementalHealth,
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
    service_causality_delta: serviceCausalityDelta,
    reused_understanding_count: stableEntityCount,
    recomputed_understanding_count: recomputedUnderstandingCount,
    stale_fact_count: staleFactCandidates.length,
    stale_fact_candidates: staleFactCandidates,
    scan_efficiency_score: scorePercent(stableEntityCount, efficiencyDenominator),
    understanding_deltas: understandingDeltas,
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

function buildEntityTypeIncrementalHealth(params: {
  readonly entityType: 'service' | 'flow';
  readonly previousEntities: readonly BrainEntity[];
  readonly currentEntities: readonly BrainEntity[];
  readonly changedFileSet: ReadonlySet<string>;
}): IncrementalEntityTypeHealth {
  const previousById = new Map(
    params.previousEntities
      .filter((entity) => entity.type === params.entityType)
      .map((entity) => [entity.id, entity]),
  );
  const currentEntities = params.currentEntities.filter(
    (entity) => entity.type === params.entityType,
  );
  const currentById = new Map(currentEntities.map((entity) => [entity.id, entity]));
  const changedIds: string[] = [];
  const newIds: string[] = [];
  const reusedIds: string[] = [];
  const recomputedIds: string[] = [];
  const staleIds: string[] = [];
  const sourceChangedIds: string[] = [];

  for (const current of currentEntities) {
    const previous = previousById.get(current.id);
    const isNew = previous === undefined;
    const isStale = current.latest_status === 'stale';
    const isSemanticChanged =
      previous !== undefined && entitySemanticHash(previous) !== entitySemanticHash(current);
    const isSourceChanged = entityIncrementalFiles(current).some((file) =>
      params.changedFileSet.has(file),
    );

    if (isSourceChanged) sourceChangedIds.push(current.id);
    if (isNew) newIds.push(current.id);
    if (isStale) {
      staleIds.push(current.id);
      continue;
    }
    if (isNew || isSemanticChanged || isSourceChanged || current.latest_status === 'changed') {
      changedIds.push(current.id);
      recomputedIds.push(current.id);
      continue;
    }
    if (previous !== undefined) reusedIds.push(current.id);
  }

  for (const previous of previousById.values()) {
    if (!currentById.has(previous.id)) staleIds.push(previous.id);
  }

  return {
    entity_type: params.entityType,
    total: currentEntities.length,
    changed: changedIds.length,
    new: newIds.length,
    stale: unique(staleIds).length,
    reused: reusedIds.length,
    recomputed: recomputedIds.length,
    status_counts: countByValue(currentEntities.map((entity) => entity.latest_status)),
    changed_ids: unique(changedIds),
    reused_ids: unique(reusedIds),
    recomputed_ids: unique(recomputedIds),
    stale_ids: unique(staleIds),
    source_changed_ids: unique(sourceChangedIds),
  };
}

function entityIncrementalFiles(entity: BrainEntity): string[] {
  if (entity.type === 'flow') {
    return unique([
      ...stringArrayData(entity, 'files'),
      ...stringArrayData(entity, 'tests'),
      ...stringArrayData(entity, 'configs'),
    ]);
  }
  return unique([
    ...entity.source_files,
    ...stringArrayData(entity, 'files'),
    ...stringArrayData(entity, 'tests'),
    ...stringArrayData(entity, 'configs'),
    ...stringArrayData(entity, 'entrypoints'),
    ...stringArrayData(entity, 'deployment_configs'),
  ]);
}

function buildServiceCausalityDelta(params: {
  readonly previousEntities: readonly BrainEntity[];
  readonly currentEntities: readonly BrainEntity[];
  readonly changedFiles: readonly string[];
  readonly evidenceDelta: IncrementalEvidenceDelta;
  readonly serviceIncrementalHealth: IncrementalEntityTypeHealth;
  readonly flowIncrementalHealth: IncrementalEntityTypeHealth;
}): IncrementalServiceCausalityDelta {
  const previousPaths = serviceCausalitySnapshots(params.previousEntities);
  const currentPaths = serviceCausalitySnapshots(params.currentEntities);
  const previousById = new Map(previousPaths.map((path) => [path.path_id, path]));
  const currentById = new Map(currentPaths.map((path) => [path.path_id, path]));
  const changedFileSet = new Set(params.changedFiles);
  const changedEvidenceSet = new Set([
    ...params.evidenceDelta.added,
    ...params.evidenceDelta.removed,
    ...params.evidenceDelta.changed,
    ...params.changedFiles.map(evidenceId),
  ]);
  const recomputedFlowSet = new Set([
    ...params.flowIncrementalHealth.recomputed_ids,
    ...params.flowIncrementalHealth.source_changed_ids,
  ]);
  const recomputedServiceSet = new Set([
    ...params.serviceIncrementalHealth.recomputed_ids,
    ...params.serviceIncrementalHealth.source_changed_ids,
  ]);
  const pathDeltas: IncrementalServiceCausalityPathDelta[] = [];

  for (const current of currentPaths) {
    const previous = previousById.get(current.path_id);
    pathDeltas.push(
      serviceCausalityPathDelta({
        previous,
        current,
        changedFileSet,
        changedEvidenceSet,
        recomputedFlowSet,
        recomputedServiceSet,
      }),
    );
  }

  for (const previous of previousPaths) {
    if (currentById.has(previous.path_id)) continue;
    pathDeltas.push(
      serviceCausalityPathDelta({
        previous,
        current: undefined,
        changedFileSet,
        changedEvidenceSet,
        recomputedFlowSet,
        recomputedServiceSet,
      }),
    );
  }

  const sortedPathDeltas = sorted(pathDeltas, (path) => path.path_id);
  const stablePathCount = sortedPathDeltas.filter((path) => path.status === 'stable').length;
  const recomputedPathCount = sortedPathDeltas.filter(
    (path) => path.status === 'recomputed' || path.status === 'new',
  ).length;
  const driftedPathCount = sortedPathDeltas.filter((path) => path.status === 'drifted').length;
  const newPathCount = sortedPathDeltas.filter((path) => path.status === 'new').length;
  const stalePathCount = sortedPathDeltas.filter((path) => path.status === 'stale').length;
  const evidenceChangedPaths = sortedPathDeltas.filter(
    (path) => path.changed_evidence_ids.length > 0,
  );
  const affectedPaths = sortedPathDeltas.filter((path) => path.status !== 'stable');
  const changedEvidenceIds = unique(sortedPathDeltas.flatMap((path) => path.changed_evidence_ids));
  const freshnessDenominator = currentPaths.length + stalePathCount;
  const freshnessNumerator = Math.max(0, currentPaths.length - driftedPathCount - stalePathCount);

  return {
    schema_version: 1,
    previous_path_count: previousPaths.length,
    current_path_count: currentPaths.length,
    total_path_count: sortedPathDeltas.length,
    stable_path_count: stablePathCount,
    recomputed_path_count: recomputedPathCount,
    drifted_path_count: driftedPathCount,
    new_path_count: newPathCount,
    stale_path_count: stalePathCount,
    evidence_changed_path_count: evidenceChangedPaths.length,
    affected_flow_count: unique(affectedPaths.map((path) => path.flow_id)).length,
    affected_service_count: unique(affectedPaths.map((path) => path.service_id)).length,
    affected_flows: unique(affectedPaths.map((path) => path.flow_id)),
    affected_services: unique(affectedPaths.map((path) => path.service_id)),
    changed_evidence_ids: changedEvidenceIds,
    freshness_score: scorePercent(freshnessNumerator, freshnessDenominator),
    path_deltas: sortedPathDeltas,
    summary: safeText(
      `${stablePathCount} stable, ${recomputedPathCount} recomputed/new, ${driftedPathCount} drifted, and ${stalePathCount} stale service causality path(s).`,
    ),
    calibration_rule:
      'Service causality freshness compares flow-to-service path fingerprints and linked evidence ids across scans; drift means a causality claim stayed structurally identical while linked service, flow, or evidence files changed.',
  };
}

function serviceCausalitySnapshots(entities: readonly BrainEntity[]): ServiceCausalitySnapshot[] {
  return sorted(
    entities
      .filter((entity) => entity.type === 'flow')
      .flatMap((flow) =>
        safeFlowServiceCausality(flow).map((service) => {
          const files = unique(service.files);
          const evidenceIds = unique(service.evidence_ids);
          const pathId = serviceCausalityPathId(flow.id, service.service_id);
          return {
            path_id: pathId,
            flow_id: safeText(flow.id),
            flow_name: safeText(flow.name),
            service_id: safeText(service.service_id),
            service_name: safeText(service.service_name),
            files,
            evidence_ids: evidenceIds,
            semantic_hash: stableHash({
              flow_id: safeText(flow.id),
              service_id: safeText(service.service_id),
              service_name: safeText(service.service_name),
              service_root: safeText(service.service_root),
              files,
              step_ids: unique(service.step_ids),
              cause: safeText(service.cause),
              effects: unique(service.effects),
              evidence_ids: evidenceIds,
              confidence: service.confidence,
              unknowns: unique(service.unknowns),
            }),
          };
        }),
      ),
    (path) => path.path_id,
  );
}

function serviceCausalityPathId(flowId: string, serviceId: string): string {
  return `service-causality:${safeText(flowId)}->${safeText(serviceId)}`;
}

function serviceCausalityPathDelta(params: {
  readonly previous: ServiceCausalitySnapshot | undefined;
  readonly current: ServiceCausalitySnapshot | undefined;
  readonly changedFileSet: ReadonlySet<string>;
  readonly changedEvidenceSet: ReadonlySet<string>;
  readonly recomputedFlowSet: ReadonlySet<string>;
  readonly recomputedServiceSet: ReadonlySet<string>;
}): IncrementalServiceCausalityPathDelta {
  const path = params.current ?? params.previous;
  if (path === undefined) {
    throw new Error('service causality delta requires a previous or current path');
  }
  const evidenceIds = unique([...(params.current ?? path).evidence_ids]);
  const changedEvidenceIds = unique(
    [...evidenceIds, ...(params.previous?.evidence_ids ?? [])].filter((id) =>
      params.changedEvidenceSet.has(id),
    ),
  );
  const changedFiles = unique(
    [...(params.current?.files ?? []), ...(params.previous?.files ?? [])].filter((file) =>
      params.changedFileSet.has(file),
    ),
  );
  const isFlowRecomputed = params.recomputedFlowSet.has(path.flow_id);
  const isServiceRecomputed = params.recomputedServiceSet.has(path.service_id);
  const hasEvidenceChange = changedEvidenceIds.length > 0;
  const hasSourceChange = changedFiles.length > 0;
  const hasAffectedBase =
    hasEvidenceChange || hasSourceChange || isFlowRecomputed || isServiceRecomputed;
  const isSemanticChanged =
    params.previous !== undefined &&
    params.current !== undefined &&
    params.previous.semantic_hash !== params.current.semantic_hash;
  let status: IncrementalServiceCausalityPathStatus = 'stable';
  if (params.current === undefined) {
    status = 'stale';
  } else if (params.previous === undefined) {
    status = 'new';
  } else if (isSemanticChanged) {
    status = 'recomputed';
  } else if (hasAffectedBase) {
    status = 'drifted';
  }

  return {
    path_id: path.path_id,
    flow_id: path.flow_id,
    service_id: path.service_id,
    service_name: path.service_name,
    status,
    previous_hash: params.previous?.semantic_hash ?? null,
    current_hash: params.current?.semantic_hash ?? null,
    changed_files: changedFiles,
    changed_evidence_ids: changedEvidenceIds,
    evidence_ids: evidenceIds,
    reasons: serviceCausalityDeltaReasons({
      status,
      hasEvidenceChange,
      hasSourceChange,
      isSemanticChanged,
      isFlowRecomputed,
      isServiceRecomputed,
    }),
  };
}

function serviceCausalityDeltaReasons(params: {
  readonly status: IncrementalServiceCausalityPathStatus;
  readonly hasEvidenceChange: boolean;
  readonly hasSourceChange: boolean;
  readonly isSemanticChanged: boolean;
  readonly isFlowRecomputed: boolean;
  readonly isServiceRecomputed: boolean;
}): string[] {
  const reasons: string[] = [];
  if (params.status === 'new') reasons.push('new flow-service causality path');
  if (params.status === 'stale')
    reasons.push('previous flow-service causality path is no longer current');
  if (params.isSemanticChanged) reasons.push('causality fingerprint changed');
  if (params.hasEvidenceChange) reasons.push('linked evidence changed');
  if (params.hasSourceChange) reasons.push('linked source file changed');
  if (params.isFlowRecomputed) reasons.push('owning flow was recomputed');
  if (params.isServiceRecomputed) reasons.push('target service was recomputed');
  if (params.status === 'stable')
    reasons.push('causality fingerprint and linked evidence are stable');
  if (params.status === 'drifted') {
    reasons.push('causality fingerprint stayed stable while linked evidence changed');
  }
  return reasons.map(safeText);
}

function buildUnderstandingDeltas(params: {
  readonly previousFingerprint: string | null;
  readonly previousEntities: readonly BrainEntity[];
  readonly currentEntities: readonly BrainEntity[];
  readonly previousRelationships: readonly BrainRelationship[];
  readonly currentRelationships: readonly BrainRelationship[];
  readonly relationshipDelta: IncrementalRelationshipDelta;
  readonly changedFiles: readonly string[];
}): IncrementalUnderstandingDeltas {
  const entitySurfaces = buildEntityUnderstandingSurfaces(
    params.previousEntities,
    params.currentEntities,
    new Set(params.changedFiles),
  );
  const unknownSurfaces = buildUnknownUnderstandingSurfaces(
    params.previousEntities,
    params.currentEntities,
  );
  const architectureSurface = buildArchitectureUnderstandingSurface({
    previousRelationships: params.previousRelationships,
    currentRelationships: params.currentRelationships,
    relationshipDelta: params.relationshipDelta,
  });
  const surfaces = sorted(
    [...entitySurfaces, ...unknownSurfaces, architectureSurface],
    understandingSurfaceKey,
  );
  const changedSurfaces = surfaces.filter((surface) => surface.status === 'changed');
  const newSurfaces = surfaces.filter((surface) => surface.status === 'new');
  const stableSurfaces = surfaces.filter((surface) => surface.status === 'stable');
  const staleSurfaces = surfaces.filter((surface) => surface.status === 'stale');
  const scoreDeltas = surfaces
    .filter(
      (surface) =>
        surface.previous_score !== null &&
        surface.current_score !== null &&
        surface.previous_score !== surface.current_score,
    )
    .map((surface) => {
      if (surface.previous_score === null || surface.current_score === null) {
        throw new Error('score delta requires previous and current scores');
      }
      return {
        surface_id: surface.surface_id,
        surface_type: surface.surface_type,
        name: surface.name,
        previous_score: surface.previous_score,
        current_score: surface.current_score,
        delta: surface.current_score - surface.previous_score,
      };
    });

  return {
    schema_version: 1,
    previous_scan_available: params.previousFingerprint !== null,
    changed_surface_count: changedSurfaces.length,
    new_surface_count: newSurfaces.length,
    stable_surface_count: stableSurfaces.length,
    stale_surface_count: staleSurfaces.length,
    changed_surfaces: changedSurfaces,
    new_surfaces: newSurfaces,
    stable_surfaces: stableSurfaces,
    stale_surfaces: staleSurfaces,
    by_surface_type: understandingSurfaceCounts(surfaces),
    score_deltas: sorted(scoreDeltas, (delta) => delta.surface_id),
    summary: safeText(
      `${changedSurfaces.length} changed, ${newSurfaces.length} new, ${stableSurfaces.length} stable, and ${staleSurfaces.length} stale understanding surface(s).`,
    ),
    calibration_rule:
      'Understanding deltas are deterministic local comparisons of component, service, flow, architecture, evidence, unknown, and confidence-score surfaces across scans.',
  };
}

function buildEntityUnderstandingSurfaces(
  previousEntities: readonly BrainEntity[],
  currentEntities: readonly BrainEntity[],
  changedFileSet: ReadonlySet<string>,
): IncrementalUnderstandingSurface[] {
  const previousById = new Map(
    previousEntities.filter(isDeltaEntitySurface).map((entity) => [entity.id, entity]),
  );
  const currentById = new Map(
    currentEntities.filter(isDeltaEntitySurface).map((entity) => [entity.id, entity]),
  );
  const surfaces: IncrementalUnderstandingSurface[] = [];
  for (const current of currentById.values()) {
    const previous = previousById.get(current.id);
    const status = entitySurfaceStatus(previous, current, changedFileSet);
    surfaces.push(entityUnderstandingSurface({ previous, current, status }));
  }
  for (const previous of previousById.values()) {
    if (currentById.has(previous.id)) continue;
    surfaces.push(entityUnderstandingSurface({ previous, current: undefined, status: 'stale' }));
  }
  return surfaces;
}

function buildUnknownUnderstandingSurfaces(
  previousEntities: readonly BrainEntity[],
  currentEntities: readonly BrainEntity[],
): IncrementalUnderstandingSurface[] {
  const previousById = unknownSurfaceEntityMap(previousEntities);
  const currentById = unknownSurfaceEntityMap(currentEntities);
  const surfaces: IncrementalUnderstandingSurface[] = [];
  for (const [surfaceId, current] of currentById.entries()) {
    const previous = previousById.get(surfaceId);
    surfaces.push(unknownUnderstandingSurface({ previous, current }));
  }
  for (const [surfaceId, previous] of previousById.entries()) {
    if (currentById.has(surfaceId)) continue;
    surfaces.push(unknownUnderstandingSurface({ previous, current: undefined }));
  }
  return surfaces;
}

function buildArchitectureUnderstandingSurface(params: {
  readonly previousRelationships: readonly BrainRelationship[];
  readonly currentRelationships: readonly BrainRelationship[];
  readonly relationshipDelta: IncrementalRelationshipDelta;
}): IncrementalUnderstandingSurface {
  const previousScore =
    params.previousRelationships.length === 0
      ? null
      : boundedScore(
          averageConfidenceScore(
            params.previousRelationships.map((relationship) =>
              confidenceScoreForValue(relationship.confidence),
            ),
          ) * 100,
        );
  const currentScore =
    params.currentRelationships.length === 0
      ? null
      : boundedScore(
          averageConfidenceScore(
            params.currentRelationships.map((relationship) =>
              confidenceScoreForValue(relationship.confidence),
            ),
          ) * 100,
        );
  const hasChangedRelationships =
    params.relationshipDelta.added_count > 0 ||
    params.relationshipDelta.removed_count > 0 ||
    params.relationshipDelta.changed_count > 0;
  let status: IncrementalUnderstandingSurfaceStatus = 'stable';
  if (params.previousRelationships.length === 0 && params.currentRelationships.length > 0) {
    status = 'new';
  } else if (params.currentRelationships.length === 0 && params.previousRelationships.length > 0) {
    status = 'stale';
  } else if (hasChangedRelationships) {
    status = 'changed';
  }

  return {
    surface_id: 'architecture:relationship-map',
    surface_type: 'architecture',
    name: 'Architecture relationship map',
    status,
    previous_score: previousScore,
    current_score: currentScore,
    score_delta: scoreDelta(previousScore, currentScore),
    evidence_ids: unique(
      params.currentRelationships.flatMap((relationship) => relationship.evidence_ids),
    ),
    reasons: [
      `${params.currentRelationships.length} current relationship claim(s)`,
      `${params.relationshipDelta.added_count} added relationship(s)`,
      `${params.relationshipDelta.removed_count} removed relationship(s)`,
      `${params.relationshipDelta.changed_count} changed relationship(s)`,
    ].map(safeText),
  };
}

function isDeltaEntitySurface(entity: BrainEntity): boolean {
  return (
    entity.type === 'component' ||
    entity.type === 'flow' ||
    entity.type === 'service' ||
    entity.type === 'evidence'
  );
}

function entitySurfaceType(entity: BrainEntity): IncrementalUnderstandingSurfaceType {
  if (entity.type === 'component') return 'component';
  if (entity.type === 'flow') return 'flow';
  if (entity.type === 'service') return 'service';
  return 'evidence';
}

function entitySurfaceStatus(
  previous: BrainEntity | undefined,
  current: BrainEntity,
  changedFileSet: ReadonlySet<string>,
): IncrementalUnderstandingSurfaceStatus {
  if (previous === undefined) return 'new';
  if (entitySemanticHash(previous) !== entitySemanticHash(current)) return 'changed';
  if (
    (current.type === 'flow' || current.type === 'service') &&
    entityIncrementalFiles(current).some((file) => changedFileSet.has(file))
  ) {
    return 'changed';
  }
  return 'stable';
}

function entityUnderstandingSurface(params: {
  readonly previous: BrainEntity | undefined;
  readonly current: BrainEntity | undefined;
  readonly status: IncrementalUnderstandingSurfaceStatus;
}): IncrementalUnderstandingSurface {
  const entity = params.current ?? params.previous;
  if (entity === undefined) {
    throw new Error('understanding surface requires a previous or current entity');
  }
  const previousScore =
    params.previous === undefined ? null : understandingEntityScore(params.previous);
  const currentScore =
    params.current === undefined ? null : understandingEntityScore(params.current);
  return {
    surface_id: entity.id,
    surface_type: entitySurfaceType(entity),
    name: safeText(entity.name),
    status: params.status,
    previous_score: previousScore,
    current_score: currentScore,
    score_delta: scoreDelta(previousScore, currentScore),
    evidence_ids: unique([...(params.current ?? entity).evidence_ids]).map(safeText),
    reasons: entitySurfaceReasons(params.previous, params.current).map(safeText),
  };
}

function unknownSurfaceEntityMap(
  entities: readonly BrainEntity[],
): Map<string, { readonly entity: BrainEntity; readonly unknown: string }> {
  const out = new Map<string, { readonly entity: BrainEntity; readonly unknown: string }>();
  for (const entity of entities.filter(
    (item) => item.type === 'component' || item.type === 'flow' || item.type === 'service',
  )) {
    for (const unknown of stringArrayData(entity, 'unknowns')) {
      const surfaceId = `unknown:${entity.id}:${stableSlug(safeText(unknown))}`;
      out.set(surfaceId, { entity, unknown });
    }
  }
  return out;
}

function unknownUnderstandingSurface(params: {
  readonly previous: { readonly entity: BrainEntity; readonly unknown: string } | undefined;
  readonly current: { readonly entity: BrainEntity; readonly unknown: string } | undefined;
}): IncrementalUnderstandingSurface {
  const item = params.current ?? params.previous;
  if (item === undefined) throw new Error('unknown surface requires previous or current data');
  const previousScore =
    params.previous === undefined ? null : understandingEntityScore(params.previous.entity);
  const currentScore =
    params.current === undefined ? null : understandingEntityScore(params.current.entity);
  let status: IncrementalUnderstandingSurfaceStatus = 'stable';
  if (params.previous === undefined) {
    status = 'new';
  } else if (params.current === undefined) {
    status = 'stale';
  }
  return {
    surface_id: `unknown:${item.entity.id}:${stableSlug(safeText(item.unknown))}`,
    surface_type: 'unknown',
    name: safeText(item.unknown),
    status,
    previous_score: previousScore,
    current_score: currentScore,
    score_delta: scoreDelta(previousScore, currentScore),
    evidence_ids: unique([...(params.current?.entity ?? item.entity).evidence_ids]).map(safeText),
    reasons: [`Known unknown attached to ${safeText(item.entity.id)}.`],
  };
}

function understandingEntityScore(entity: BrainEntity): number {
  if (entity.type === 'component') return boundedScore(componentConfidenceScore(entity) * 100);
  if (entity.type === 'flow') return boundedScore(asFlowConfidenceScore(entity) * 100);
  if (entity.type === 'service') {
    return boundedScore(
      (numberData(entity, 'confidence_score') ?? confidenceScoreForValue(entity.confidence)) * 100,
    );
  }
  return boundedScore(confidenceScoreForValue(entity.confidence) * 100);
}

function entitySurfaceReasons(
  previous: BrainEntity | undefined,
  current: BrainEntity | undefined,
): string[] {
  const entity = current ?? previous;
  if (entity === undefined) return [];
  const reasons: string[] = [
    `${entity.evidence_ids.length} evidence record(s)`,
    `${entity.source_files.length} source file(s)`,
    `confidence:${entity.confidence}`,
  ];
  if (previous !== undefined && current !== undefined) {
    const previousHash = entitySemanticHash(previous);
    const currentHash = entitySemanticHash(current);
    if (previousHash !== currentHash) reasons.push('semantic fingerprint changed');
  }
  return reasons;
}

function scoreDelta(previousScore: number | null, currentScore: number | null): number | null {
  if (previousScore === null || currentScore === null) return null;
  return currentScore - previousScore;
}

function understandingSurfaceCounts(
  surfaces: readonly IncrementalUnderstandingSurface[],
): Record<IncrementalUnderstandingSurfaceType, IncrementalUnderstandingSurfaceCounts> {
  const counts: Record<IncrementalUnderstandingSurfaceType, IncrementalUnderstandingSurfaceCounts> =
    {
      architecture: { changed: 0, new: 0, stable: 0, stale: 0 },
      component: { changed: 0, new: 0, stable: 0, stale: 0 },
      evidence: { changed: 0, new: 0, stable: 0, stale: 0 },
      flow: { changed: 0, new: 0, stable: 0, stale: 0 },
      service: { changed: 0, new: 0, stable: 0, stale: 0 },
      unknown: { changed: 0, new: 0, stable: 0, stale: 0 },
    };
  for (const surface of surfaces) {
    const current = counts[surface.surface_type];
    counts[surface.surface_type] = {
      ...current,
      [surface.status]: current[surface.status] + 1,
    };
  }
  return counts;
}

function understandingSurfaceKey(surface: IncrementalUnderstandingSurface): string {
  return `${surface.surface_type}:${surface.surface_id}`;
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
  const flowsWithRuntimeSurfaces = flows.filter(
    (flow) => flowStringArray(flow, 'runtime_surfaces').length > 0,
  );
  const flowJourneySummaries = flows
    .map((flow) => ({ flow, journey: flowJourneySummaryData(flow) }))
    .filter(
      (item): item is { readonly flow: BrainEntity; readonly journey: FlowJourneySummary } =>
        item.journey !== undefined,
    );
  const flowJourneySteps = flows.flatMap(safeFlowJourneySteps);
  const flowDataDependencies = flows.flatMap(safeFlowDataDependencies);
  const flowsWithDataDependencies = flows.filter(
    (flow) => safeFlowDataDependencies(flow).length > 0,
  );
  const statefulFlowFiles = new Set(flowDataDependencies.flatMap((item) => item.files));
  const runtimeSurfacesCoveredByFlows = unique(
    flows.flatMap((flow) => flowStringArray(flow, 'runtime_surfaces')),
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
  const serviceIntelligence = buildServiceIntelligenceArtifact({
    now: params.now,
    buckets: params.buckets,
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
    changedFiles: params.changedFiles,
    staleFiles: params.staleFiles,
    incrementalMetrics: params.incrementalMetrics,
    architectureReasoning,
    evidenceQuality,
  });
  const understandingScore = buildUnderstandingScoreArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
    incrementalMetrics: params.incrementalMetrics,
    componentIntelligence,
    serviceIntelligence,
    evidenceQuality,
    architectureReasoning,
    benchmarkReady,
  });
  const benchmarkTasks = buildBenchmarkTasksArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    architectureReasoning,
    evidenceQuality,
    benchmarkReady,
    understandingScore,
  });
  const pieAcceptance = buildPieAcceptanceArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    architectureReasoning,
    evidenceQuality,
    benchmarkReady,
    benchmarkTasks,
    understandingScore,
    incrementalMetrics: params.incrementalMetrics,
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
      flow_data_dependencies: flowDataDependencies.length,
      stateful_flows: flowsWithDataDependencies.length,
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
      flows_with_data_dependencies: flowsWithDataDependencies.length,
      stateful_files_covered_by_flows: activeSourceFiles.filter((file) =>
        statefulFlowFiles.has(file.name),
      ).length,
      stateful_flow_coverage_ratio: ratio(flowsWithDataDependencies.length, flows.length),
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
        runtime_surfaces: flowStringArray(flow, 'runtime_surfaces'),
        data_dependencies: safeFlowDataDependencies(flow).map((dependency) => ({
          label: dependency.label,
          kind: dependency.kind,
          operations: dependency.operations,
          confidence: dependency.confidence,
        })),
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
    serviceIntelligence,
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
      flows_with_runtime_surfaces: flowsWithRuntimeSurfaces.length,
      flows_with_journey_names: flowJourneySummaries.length,
      flows_with_data_dependencies: flowsWithDataDependencies.length,
      data_dependencies: flowDataDependencies.length,
      journey_steps: flowJourneySteps.length,
      flow_steps: flowStepCount,
      mapped_components: unique(flows.flatMap((flow) => flowStringArray(flow, 'components')))
        .length,
      mapped_services: unique(flows.flatMap((flow) => flowStringArray(flow, 'services'))).length,
      mapped_files: flowCoveredFiles.size,
      runtime_surface_count: runtimeSurfacesCoveredByFlows.length,
      runtime_surfaces: runtimeSurfacesCoveredByFlows,
      data_dependencies_by_kind: countByValue(flowDataDependencies.map((item) => item.kind)),
      state_operations_by_type: countByValue(
        flowDataDependencies.flatMap((item) => item.operations),
      ),
      data_dependency_flows: flowsWithDataDependencies.map((flow) => ({
        id: flow.id,
        journey_name: flowJourneySummaryData(flow)?.name,
        dependencies: safeFlowDataDependencies(flow).map((dependency) => ({
          label: dependency.label,
          kind: dependency.kind,
          operations: dependency.operations,
          files: dependency.files,
          confidence: dependency.confidence,
          missing_evidence: dependency.missing_evidence,
        })),
      })),
      journeys: flowJourneySummaries.map(({ flow, journey }) => ({
        id: flow.id,
        flow_name: flow.name,
        journey_name: journey.name,
        category: journey.category,
        confidence: journey.confidence,
        score: journey.score,
        evidence_ids: journey.evidence_ids,
        missing_evidence: journey.missing_evidence,
        reasons: journey.reasons,
        step_count: safeFlowJourneySteps(flow).length,
        runtime_surfaces: flowStringArray(flow, 'runtime_surfaces'),
        tests: flowStringArray(flow, 'tests'),
        configs: flowStringArray(flow, 'configs'),
      })),
      journey_steps_by_type: countByValue(flowJourneySteps.map((step) => step.type)),
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
        journey_name: flowJourneySummaryData(flow)?.name,
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
        runtime_surfaces: flowStringArray(flow, 'runtime_surfaces'),
        data_dependencies: safeFlowDataDependencies(flow).map((dependency) => ({
          label: dependency.label,
          kind: dependency.kind,
          operations: dependency.operations,
          confidence: dependency.confidence,
        })),
        services: flowStringArray(flow, 'services'),
        service_causality: safeFlowServiceCausality(flow),
        journey_steps: safeFlowJourneySteps(flow).map((step) => ({
          step_id: step.step_id,
          type: step.type,
          label: step.label,
          files: step.files,
          runtime_surfaces: step.runtime_surfaces,
          configs: step.configs,
          tests: step.tests,
          confidence: step.confidence,
          missing_evidence: step.missing_evidence,
        })),
        confidence_reasons: flowStringArray(flow, 'confidence_reasons'),
      })),
      orphan_entrypoints: flows
        .filter((flow) => flowStringArray(flow, 'components').length === 0)
        .map((flow) => flow.id),
      incremental_update: {
        previous_total_flows:
          params.incrementalMetrics.flow_count -
          params.incrementalMetrics.flow_incremental_health.new +
          params.incrementalMetrics.flow_stale,
        current_total_flows: params.incrementalMetrics.flow_count,
        changed: params.incrementalMetrics.flow_incremental_health.changed_ids,
        reused: params.incrementalMetrics.flow_incremental_health.reused_ids,
        recomputed: params.incrementalMetrics.flow_incremental_health.recomputed_ids,
        stale: params.incrementalMetrics.flow_incremental_health.stale_ids,
        changed_count: params.incrementalMetrics.flow_changed,
        reused_count: params.incrementalMetrics.flow_reused,
        recomputed_count: params.incrementalMetrics.flow_recomputed,
        stale_count: params.incrementalMetrics.flow_stale,
        source_changed: params.incrementalMetrics.flow_incremental_health.source_changed_ids,
        affected_by_changed_files: changedFlows.map((flow) => flow.id),
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
      runtime_surface_coverage_ratio: ratio(flowsWithRuntimeSurfaces.length, flows.length),
      data_dependency_coverage_ratio: ratio(flowsWithDataDependencies.length, flows.length),
      journey_named_flow_ratio: ratio(flowJourneySummaries.length, flows.length),
      journey_step_coverage_ratio: ratio(
        flows.filter((flow) => safeFlowJourneySteps(flow).length > 0).length,
        flows.length,
      ),
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
      runtime_surfaces_covered_by_flows: runtimeSurfacesCoveredByFlows,
      flows: flows.map((flow) => ({
        id: flow.id,
        kind: stringData(flow, 'kind') ?? 'unknown',
        journey_name: flowJourneySummaryData(flow)?.name,
        journey_confidence: flowJourneySummaryData(flow)?.confidence,
        journey_steps: safeFlowJourneySteps(flow).length,
        files: flowStringArray(flow, 'files').length,
        components: flowStringArray(flow, 'components').length,
        runtime_surfaces: flowStringArray(flow, 'runtime_surfaces').length,
        data_dependencies: safeFlowDataDependencies(flow).length,
        state_operations: unique(
          safeFlowDataDependencies(flow).flatMap((dependency) => dependency.operations),
        ).length,
        services: flowStringArray(flow, 'services').length,
        service_causality: safeFlowServiceCausality(flow).length,
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
    benchmarkTasks,
    understandingScore,
    pieAcceptance,
    verificationEvidence: emptyVerificationEvidenceArtifact(params.projectName, params.now),
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
      runtime_surfaces: flowStringArray(flow, 'runtime_surfaces'),
      components: flowStringArray(flow, 'components').length,
      services: flowStringArray(flow, 'services').length,
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
    service_count: flowStringArray(flow, 'services').length,
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
    runtime_surfaces: flowStringArray(flow, 'runtime_surfaces'),
    confidence_reasons: flowStringArray(flow, 'confidence_reasons'),
    services: flowStringArray(flow, 'services'),
    confidence: flow.confidence,
    score: asFlowConfidenceScore(flow),
    evidence_ids: flow.evidence_ids,
  }));
  const serviceMap = params.buckets.services.map((service) => ({
    id: service.id,
    name: service.name,
    runtime: stringData(service, 'runtime') ?? 'unknown',
    framework: stringData(service, 'framework') ?? 'unknown',
    service_root: stringData(service, 'service_root') ?? service.name,
    entrypoints: serviceDataStringArray(service, 'entrypoints'),
    routes: serviceDataStringArray(service, 'routes'),
    jobs: serviceDataStringArray(service, 'jobs'),
    storage_dependencies: serviceDataStringArray(service, 'storage_dependencies'),
    environment_variables: serviceDataStringArray(service, 'environment_variables'),
    external_services: serviceDataStringArray(service, 'external_services'),
    deployment_configs: serviceDataStringArray(service, 'deployment_configs'),
    related_flows: serviceDataStringArray(service, 'related_flows'),
    related_components: serviceDataStringArray(service, 'related_components'),
    risks: serviceDataStringArray(service, 'risks'),
    confidence: service.confidence,
    confidence_score: numberData(service, 'confidence_score'),
    evidence_ids: service.evidence_ids,
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
  const serviceIntelligence = buildServiceIntelligenceArtifact({
    now: params.now,
    buckets: params.buckets,
  });
  const benchmarkReady = buildBenchmarkReadyArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
    changedFiles: params.changedFiles,
    staleFiles: params.staleFiles,
    incrementalMetrics: params.incrementalMetrics,
    architectureReasoning,
    evidenceQuality,
  });
  const understandingScore = buildUnderstandingScoreArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    relationships: params.relationships,
    incrementalMetrics: params.incrementalMetrics,
    componentIntelligence,
    serviceIntelligence,
    evidenceQuality,
    architectureReasoning,
    benchmarkReady,
  });
  const benchmarkTasks = buildBenchmarkTasksArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    architectureReasoning,
    evidenceQuality,
    benchmarkReady,
    understandingScore,
  });
  const pieAcceptance = buildPieAcceptanceArtifact({
    projectName: params.projectName,
    now: params.now,
    buckets: params.buckets,
    architectureReasoning,
    evidenceQuality,
    benchmarkReady,
    benchmarkTasks,
    understandingScore,
    incrementalMetrics: params.incrementalMetrics,
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
    latest_architecture_impact_summary: architectureImpactSummary(architectureReasoning),
    latest_component_map: componentMap,
    latest_service_map: serviceMap,
    latest_flow_map: flowMap,
    latest_architecture_reasoning: architectureReasoning,
    latest_service_intelligence: serviceIntelligence,
    latest_evidence_quality: evidenceQuality,
    latest_understanding_score: understandingScore,
    latest_pie_acceptance: {
      path: '.rizz/research/pie_acceptance.json',
      overall_status: recordString(pieAcceptance, 'overall_status', 'limited'),
      overall_score: recordNumber(pieAcceptance, 'overall_score'),
      blocking_gaps: recordArray(pieAcceptance, 'blocking_gaps').slice(0, 8),
      next_required_improvements: recordArray(pieAcceptance, 'next_required_improvements').slice(
        0,
        8,
      ),
      mission_control: '.rizz/reports/index.html',
      summary: `${recordNumber(pieAcceptance, 'overall_score')}/100 PIE acceptance readiness is ${recordString(
        pieAcceptance,
        'overall_status',
        'limited',
      )}.`,
    },
    latest_ask_readiness: isRecord(benchmarkReady.ask_readiness)
      ? benchmarkReady.ask_readiness
      : undefined,
    latest_benchmark_tasks: {
      path: '.rizz/research/benchmark_tasks.json',
      pie_acceptance: {
        path: '.rizz/research/pie_acceptance.json',
        overall_status: recordString(pieAcceptance, 'overall_status', 'limited'),
        overall_score: recordNumber(pieAcceptance, 'overall_score'),
      },
      task_count: recordNumber(benchmarkTasks, 'task_count'),
      task_categories: isRecord(benchmarkTasks.task_categories)
        ? benchmarkTasks.task_categories
        : {},
      mission_control: '.rizz/reports/index.html',
      summary: isRecord(benchmarkTasks.research_pointer)
        ? benchmarkTasks.research_pointer.summary
        : 'Benchmark task candidates are emitted from local research artifacts.',
    },
    latest_incremental_update: {
      previous_brain_fingerprint: params.incrementalMetrics.previous_brain_fingerprint,
      current_brain_fingerprint: params.incrementalMetrics.current_brain_fingerprint,
      changed_file_count: params.incrementalMetrics.changed_file_count,
      changed_entity_count: params.incrementalMetrics.changed_entity_count,
      stable_entity_count: params.incrementalMetrics.stable_entity_count,
      added_entity_count: params.incrementalMetrics.added_entity_count,
      removed_entity_count: params.incrementalMetrics.removed_entity_count,
      service_count: params.incrementalMetrics.service_count,
      service_changed: params.incrementalMetrics.service_changed,
      service_stale: params.incrementalMetrics.service_stale,
      service_reused: params.incrementalMetrics.service_reused,
      service_recomputed: params.incrementalMetrics.service_recomputed,
      service_incremental_health: params.incrementalMetrics.service_incremental_health,
      flow_count: params.incrementalMetrics.flow_count,
      flow_changed: params.incrementalMetrics.flow_changed,
      flow_stale: params.incrementalMetrics.flow_stale,
      flow_reused: params.incrementalMetrics.flow_reused,
      flow_recomputed: params.incrementalMetrics.flow_recomputed,
      flow_incremental_health: params.incrementalMetrics.flow_incremental_health,
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
      service_causality_delta: {
        schema_version: params.incrementalMetrics.service_causality_delta.schema_version,
        previous_path_count: params.incrementalMetrics.service_causality_delta.previous_path_count,
        current_path_count: params.incrementalMetrics.service_causality_delta.current_path_count,
        stable_path_count: params.incrementalMetrics.service_causality_delta.stable_path_count,
        recomputed_path_count:
          params.incrementalMetrics.service_causality_delta.recomputed_path_count,
        drifted_path_count: params.incrementalMetrics.service_causality_delta.drifted_path_count,
        new_path_count: params.incrementalMetrics.service_causality_delta.new_path_count,
        stale_path_count: params.incrementalMetrics.service_causality_delta.stale_path_count,
        evidence_changed_path_count:
          params.incrementalMetrics.service_causality_delta.evidence_changed_path_count,
        affected_flow_count: params.incrementalMetrics.service_causality_delta.affected_flow_count,
        affected_service_count:
          params.incrementalMetrics.service_causality_delta.affected_service_count,
        affected_flows: params.incrementalMetrics.service_causality_delta.affected_flows.slice(
          0,
          12,
        ),
        affected_services:
          params.incrementalMetrics.service_causality_delta.affected_services.slice(0, 12),
        changed_evidence_ids:
          params.incrementalMetrics.service_causality_delta.changed_evidence_ids.slice(0, 20),
        freshness_score: params.incrementalMetrics.service_causality_delta.freshness_score,
        path_deltas: params.incrementalMetrics.service_causality_delta.path_deltas.slice(0, 12),
        summary: params.incrementalMetrics.service_causality_delta.summary,
        calibration_rule: params.incrementalMetrics.service_causality_delta.calibration_rule,
      },
      understanding_deltas: {
        schema_version: params.incrementalMetrics.understanding_deltas.schema_version,
        previous_scan_available:
          params.incrementalMetrics.understanding_deltas.previous_scan_available,
        changed_surface_count: params.incrementalMetrics.understanding_deltas.changed_surface_count,
        new_surface_count: params.incrementalMetrics.understanding_deltas.new_surface_count,
        stable_surface_count: params.incrementalMetrics.understanding_deltas.stable_surface_count,
        stale_surface_count: params.incrementalMetrics.understanding_deltas.stale_surface_count,
        changed_surfaces: params.incrementalMetrics.understanding_deltas.changed_surfaces.slice(
          0,
          12,
        ),
        new_surfaces: params.incrementalMetrics.understanding_deltas.new_surfaces.slice(0, 12),
        stable_surfaces: params.incrementalMetrics.understanding_deltas.stable_surfaces.slice(
          0,
          12,
        ),
        stale_surfaces: params.incrementalMetrics.understanding_deltas.stale_surfaces.slice(0, 12),
        by_surface_type: params.incrementalMetrics.understanding_deltas.by_surface_type,
        score_deltas: params.incrementalMetrics.understanding_deltas.score_deltas.slice(0, 12),
        summary: params.incrementalMetrics.understanding_deltas.summary,
        calibration_rule: params.incrementalMetrics.understanding_deltas.calibration_rule,
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
      incremental_health: {
        services: params.incrementalMetrics.service_incremental_health,
        flows: params.incrementalMetrics.flow_incremental_health,
        service_causality: params.incrementalMetrics.service_causality_delta,
      },
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
      const routeContext = flowRouteContextLabels(flow);
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
        `${flow.id} ${flow.name} ${kind} ${routeContext.join(' ')} ${entrypoints.join(' ')} ${flow.confidence} ${flow.source_files.join(' ')}`,
      )}" data-kind="flow" data-confidence="${htmlEscape(flow.confidence)}">
        <div class="badge">${htmlEscape(flow.confidence)} · ${htmlEscape(kind)} · ${htmlEscape(
          String(asFlowConfidenceScore(flow)),
        )}</div>
        <h3>${htmlEscape(flow.name)}</h3>
        <p class="muted">${htmlEscape(flow.id)}</p>
        <p>${htmlEscape(flow.description)}</p>
        ${renderFlowRouteContext(routeContext, flow.evidence_ids, evidenceById)}
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
          `${flowStringArray(flow, 'services').length} service(s)`,
          `${flowStringArray(flow, 'files').length} file(s)`,
          `${flowStringArray(flow, 'tests').length} test artifact(s)`,
          `${risks.length} risk(s)`,
        ])}
        <h4>Services</h4>
        ${renderListWithEvidence(
          flowStringArray(flow, 'services'),
          fieldEvidence.services ?? flow.evidence_ids,
          evidenceById,
        )}
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

function renderJourneyIntelligence(
  flows: readonly BrainEntity[],
  latest: Record<string, unknown>,
): string {
  const journeys = flows
    .flatMap((flow) => {
      const journey = flowJourneySummaryData(flow);
      if (journey === undefined) return [];
      return [{ flow, journey, steps: safeFlowJourneySteps(flow) }];
    })
    .sort(
      (a, b) =>
        b.journey.score - a.journey.score ||
        confidenceRank(b.journey.confidence) - confidenceRank(a.journey.confidence) ||
        a.journey.name.localeCompare(b.journey.name),
    );
  if (journeys.length === 0) {
    return '<p class="muted">No journey-aware flows detected yet.</p>';
  }
  const highestRisk =
    [...journeys].sort((a, b) => {
      const aRisk =
        flowRisks(a.flow).length + a.journey.missing_evidence.length + weakStepCount(a.steps);
      const bRisk =
        flowRisks(b.flow).length + b.journey.missing_evidence.length + weakStepCount(b.steps);
      return bRisk - aRisk || a.journey.name.localeCompare(b.journey.name);
    })[0] ?? journeys[0];
  if (highestRisk === undefined) {
    return '<p class="muted">No journey-aware flows detected yet.</p>';
  }
  const reviewSummary = latestReviewEvidenceSummary(latest);
  const affectedJourneys = asStringArray(reviewSummary.affected_journeys);
  const affectedDataDependencies = asStringArray(reviewSummary.affected_data_dependencies);
  const affectedStateOperations = asStringArray(reviewSummary.affected_state_operations);
  const failureModes = asStringArray(reviewSummary.user_visible_failure_modes);
  const journeyMissingEvidence = asStringArray(reviewSummary.journey_missing_evidence);
  const affectedStepCount = recordNumber(reviewSummary, 'affected_journey_steps');
  const journeyDataDependencies = journeys.flatMap((item) => safeFlowDataDependencies(item.flow));

  return `<div class="grid">
    <article class="card compact">
      <div class="badge">${journeys.length} journey(s)</div>
      <h3>Top Journeys</h3>
      ${renderList(
        journeys.slice(0, 5).map((item) => {
          const surfaces = flowStringArray(item.flow, 'runtime_surfaces').slice(0, 2).join(', ');
          const dataSignals = safeFlowDataDependencies(item.flow)
            .map((dependency) => dependency.label)
            .slice(0, 2)
            .join(', ');
          const suffix = [surfaces, dataSignals]
            .filter((value) => value.length > 0)
            .map((value) => ` · ${value}`)
            .join('');
          return `${item.journey.name} (${item.journey.confidence}, ${item.steps.length} step(s))${suffix}`;
        }),
      )}
    </article>
    <article class="card compact">
      <div class="badge">${htmlEscape(highestRisk.journey.confidence)}</div>
      <h3>Highest Risk Journey</h3>
      <p>${htmlEscape(highestRisk.journey.name)}</p>
      <h4>Evidence Gaps</h4>
      ${renderList(highestRisk.journey.missing_evidence.slice(0, 4))}
      <h4>Runtime Surfaces</h4>
      ${renderList(flowStringArray(highestRisk.flow, 'runtime_surfaces').slice(0, 5))}
      <h4>State/Data</h4>
      ${renderList(
        safeFlowDataDependencies(highestRisk.flow).slice(0, 4).map(formatDataDependencyForReview),
      )}
    </article>
    <article class="card compact">
      <div class="badge">${journeyEvidenceHealth(journeys)}/100</div>
      <h3>Evidence Health</h3>
      ${renderList([
        `${journeys.filter((item) => item.journey.confidence === 'verified').length} verified journey name(s)`,
        `${journeys.filter((item) => item.journey.confidence === 'inferred').length} inferred journey name(s)`,
        `${journeyDataDependencies.length} state/data dependency signal(s)`,
        `${journeys.flatMap((item) => item.journey.missing_evidence).length} missing evidence note(s)`,
        `${journeys.flatMap((item) => item.steps).filter((step) => step.tests.length > 0).length} step(s) with tests`,
      ])}
    </article>
    <article class="card compact">
      <div class="badge">${affectedJourneys.length} affected</div>
      <h3>Latest Review Impact</h3>
      ${renderList([
        ...(affectedJourneys.length === 0
          ? ['No affected journeys recorded by the latest review.']
          : affectedJourneys.slice(0, 4).map((journey) => `Affected: ${journey}`)),
        `${affectedStepCount} affected journey step(s)`,
        ...affectedDataDependencies.slice(0, 3).map((item) => `State/data: ${item}`),
        ...affectedStateOperations.slice(0, 3).map((item) => `Operation: ${item}`),
        ...failureModes.slice(0, 3),
        ...journeyMissingEvidence.slice(0, 3).map((gap) => `Gap: ${gap}`),
      ])}
    </article>
  </div>`;
}

function confidenceRank(confidence: Confidence): number {
  if (confidence === 'verified') return 3;
  if (confidence === 'inferred') return 2;
  return 1;
}

function weakStepCount(steps: readonly FlowJourneyStep[]): number {
  return steps.filter((step) => step.confidence !== 'verified').length;
}

function journeyEvidenceHealth(
  journeys: readonly {
    readonly journey: FlowJourneySummary;
    readonly steps: readonly FlowJourneyStep[];
  }[],
): number {
  const possible = journeys.length * 3 + journeys.flatMap((item) => item.steps).length;
  if (possible === 0) return 0;
  const verifiedNames =
    journeys.filter((item) => item.journey.confidence === 'verified').length * 3;
  const inferredNames =
    journeys.filter((item) => item.journey.confidence === 'inferred').length * 2;
  const verifiedSteps = journeys
    .flatMap((item) => item.steps)
    .filter((step) => step.confidence === 'verified').length;
  return Math.round(((verifiedNames + inferredNames + verifiedSteps) / possible) * 100);
}

function latestReviewEvidenceSummary(latest: Record<string, unknown>): Record<string, unknown> {
  const status = latest.latest_review_status;
  if (!isRecord(status)) return {};
  return isRecord(status.review_evidence_summary) ? status.review_evidence_summary : {};
}

function renderServiceCards(
  services: readonly BrainEntity[],
  evidenceById: ReadonlyMap<string, BrainEntity>,
): string {
  if (services.length === 0) {
    return '<p class="muted">No service intelligence detected yet.</p>';
  }
  return services
    .map((service) => {
      const runtime = stringData(service, 'runtime') ?? 'unknown';
      const framework = stringData(service, 'framework') ?? 'unknown';
      const fieldEvidence = recordStringArrayData(service, 'field_evidence');
      const relatedFlows = serviceDataStringArray(service, 'related_flows');
      const risks = serviceDataStringArray(service, 'risks');
      return `<article class="card" data-search="${htmlEscape(
        `${service.id} ${service.name} ${runtime} ${framework} ${service.source_files.join(' ')}`,
      )}" data-kind="service" data-confidence="${htmlEscape(service.confidence)}">
        <div class="badge">${htmlEscape(service.confidence)} · ${htmlEscape(runtime)} · ${htmlEscape(
          framework,
        )}</div>
        <h3>${htmlEscape(service.name)}</h3>
        <p class="muted">Explain this: <code>rizz explain service ${htmlEscape(service.name)}</code></p>
        <p>${htmlEscape(service.description)}</p>
        <h4>Routes</h4>
        ${renderListWithEvidence(
          serviceDataStringArray(service, 'routes'),
          fieldEvidence.routes ?? service.evidence_ids,
          evidenceById,
        )}
        <h4>Jobs</h4>
        ${renderListWithEvidence(
          serviceDataStringArray(service, 'jobs'),
          fieldEvidence.jobs ?? service.evidence_ids,
          evidenceById,
        )}
        <h4>Storage</h4>
        ${renderListWithEvidence(
          serviceDataStringArray(service, 'storage_dependencies'),
          fieldEvidence.storage_dependencies ?? service.evidence_ids,
          evidenceById,
        )}
        <h4>Environment</h4>
        ${renderListWithEvidence(
          serviceDataStringArray(service, 'environment_variables'),
          fieldEvidence.environment_variables ?? service.evidence_ids,
          evidenceById,
        )}
        <h4>External APIs</h4>
        ${renderListWithEvidence(
          serviceDataStringArray(service, 'external_services'),
          fieldEvidence.external_services ?? service.evidence_ids,
          evidenceById,
        )}
        <h4>Deployment Configs</h4>
        ${renderListWithEvidence(
          serviceDataStringArray(service, 'deployment_configs'),
          fieldEvidence.deployment_configs ?? service.evidence_ids,
          evidenceById,
        )}
        <h4>Related Flows</h4>
        ${renderListWithEvidence(relatedFlows, service.evidence_ids, evidenceById)}
        <h4>Risks</h4>
        ${renderListWithEvidence(risks, fieldEvidence.risks ?? service.evidence_ids, evidenceById)}
        <h4>Unknowns</h4>
        ${renderListWithEvidence(
          serviceDataStringArray(service, 'unknowns'),
          fieldEvidence.unknowns ?? service.evidence_ids,
          evidenceById,
        )}
      </article>`;
    })
    .join('');
}

function flowRouteContextLabels(flow: BrainEntity): string[] {
  const labels = [
    stringData(flow, 'framework') === undefined
      ? undefined
      : `Framework: ${stringData(flow, 'framework')}`,
    stringData(flow, 'route_path') === undefined
      ? undefined
      : `Route path: ${stringData(flow, 'route_path')}`,
    stringData(flow, 'route_type') === undefined
      ? undefined
      : `Route type: ${stringData(flow, 'route_type')}`,
  ].filter((label): label is string => label !== undefined);
  return labels.map(safeText);
}

function renderFlowRouteContext(
  labels: readonly string[],
  evidenceIds: readonly string[],
  evidenceById: ReadonlyMap<string, BrainEntity>,
): string {
  if (labels.length === 0) return '';
  return `<h4>Route Context</h4>
        ${renderListWithEvidence(labels, evidenceIds, evidenceById)}`;
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
    if (labels.length === 0 && value.length > 0) return renderList([`${value.length} item(s)`]);
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

function renderLatestVerificationPlan(latest: Record<string, unknown>): string {
  const status = latest.latest_review_status;
  if (!isRecord(status)) {
    return '<p class="muted">No review status found. Run <code>rizz review</code> to add one.</p>';
  }
  const plan = recordArray(status, 'verification_plan').filter(isRecord);
  if (plan.length === 0) {
    return '<p class="muted">No targeted verification plan was recorded by the latest review.</p>';
  }
  const required = plan.filter((item) => recordString(item, 'priority', '') === 'required');
  const recommended = plan.filter((item) => recordString(item, 'priority', '') === 'recommended');
  const topItems = [...required, ...recommended, ...plan].slice(0, 5);
  return `<div class="grid">
    <article class="card compact">
      <div class="badge">${required.length} required</div>
      <h3>Verification Summary</h3>
      ${renderList([
        `${plan.length} targeted check(s)`,
        `${required.length} required`,
        `${recommended.length} recommended`,
      ])}
    </article>
    <article class="card compact">
      <h3>Top Checks</h3>
      ${renderList(
        topItems.map((item) => {
          const priority = recordString(item, 'priority', 'recommended');
          const type = recordString(item, 'verification_type', 'manual');
          const reason = recordString(item, 'reason', 'Verify affected behavior.');
          return `${priority} ${type}: ${reason}`;
        }),
      )}
    </article>
  </div>`;
}

function renderLatestReviewRouteFlows(
  latest: Record<string, unknown>,
  flows: readonly BrainEntity[],
  evidenceById: ReadonlyMap<string, BrainEntity>,
): string {
  const status = latest.latest_review_status;
  if (!isRecord(status)) {
    return '<p class="muted">No review status found. Run <code>rizz review</code> to add one.</p>';
  }
  const affectedFlowIds = new Set(asStringArray(status.affected_flows));
  if (affectedFlowIds.size === 0) {
    return '<p class="muted">No affected flows recorded by the latest review.</p>';
  }
  const affectedRouteFlows = flows.filter(
    (flow) => affectedFlowIds.has(flow.id) && flowRouteContextLabels(flow).length > 0,
  );
  if (affectedRouteFlows.length === 0) {
    return '<p class="muted">No affected route flows recorded by the latest review.</p>';
  }
  return `<div class="grid">${affectedRouteFlows
    .map((flow) => {
      const routePath = stringData(flow, 'route_path') ?? flow.name;
      const routeType = stringData(flow, 'route_type') ?? flowKind(flow);
      const entrypoints = flowEntrypoints(flow).map(formatFlowEntrypoint);
      return `<article class="card compact" data-search="${htmlEscape(
        `${flow.id} ${routePath} ${routeType} ${entrypoints.join(' ')}`,
      )}" data-kind="flow" data-confidence="${htmlEscape(flow.confidence)}">
        <div class="badge">${htmlEscape(flow.confidence)} · ${htmlEscape(routeType)}</div>
        <h3>${htmlEscape(routePath)}</h3>
        <p class="muted">${htmlEscape(flow.id)}</p>
        <h4>Route Context</h4>
        ${renderListWithEvidence(flowRouteContextLabels(flow), flow.evidence_ids, evidenceById)}
        <h4>Entrypoints</h4>
        ${renderListWithEvidence(entrypoints, flow.evidence_ids, evidenceById)}
      </article>`;
    })
    .join('')}</div>`;
}

function renderMissionControlDependencyRuntimeImpact(latest: Record<string, unknown>): string {
  const status = latest.latest_review_status;
  if (!isRecord(status)) {
    return '<p class="muted">No review status found. Run <code>rizz review</code> to add one.</p>';
  }
  const impact = status.dependency_runtime_impact;
  if (!isRecord(impact)) {
    return '<p class="muted">No dependency or runtime package/config impact was detected by the latest review.</p>';
  }
  const changedFiles = asStringArray(impact.changed_files);
  const runtimeSurfaces = asStringArray(impact.runtime_surfaces);
  const affected = [
    ...asStringArray(impact.affected_components),
    ...asStringArray(impact.affected_services),
    ...asStringArray(impact.affected_flows),
  ];
  const packageScripts = recordArray(impact, 'package_scripts')
    .filter(isRecord)
    .slice(0, 12)
    .map((script) => {
      const manifest = recordString(script, 'manifest', 'unknown manifest');
      const name = recordString(script, 'name', 'unknown');
      const category = recordString(script, 'category', 'unknown');
      const command = recordString(script, 'command', '');
      return `${manifest}#${name} (${category}): ${command}`;
    });
  const verificationFocus = asStringArray(impact.verification_focus);
  const reasons = asStringArray(impact.reasons);
  return `<div class="grid">
    <article class="card compact">
      <h3>Changed Package / Config</h3>
      ${renderList(changedFiles)}
    </article>
    <article class="card compact">
      <h3>Runtime Surfaces</h3>
      ${renderList(runtimeSurfaces)}
    </article>
    <article class="card compact">
      <h3>Components / Services / Flows</h3>
      ${renderList(affected)}
    </article>
    <article class="card compact">
      <h3>Package Scripts</h3>
      ${renderList(packageScripts)}
    </article>
    <article class="card compact">
      <h3>Focused Verification</h3>
      ${renderList(verificationFocus)}
    </article>
    <article class="card compact">
      <h3>Impact Reasons</h3>
      ${renderList(reasons)}
    </article>
    <article class="card compact">
      <h3>Review Artifacts</h3>
      ${renderArtifactLinks([
        '.rizz/reports/review.html',
        '.rizz/research/review_eval.json',
        '.rizz/research/review_claim_evidence.json',
        '.rizz/research/verification_evidence.json',
        '.rizz/brain/latest.json',
      ])}
    </article>
  </div>`;
}

function renderArchitectureConfidenceDebt(value: unknown): string {
  if (!isRecord(value)) {
    return renderList(['No confidence debt summary is available yet.']);
  }
  const summary =
    typeof value.summary === 'string' ? value.summary : 'No confidence debt summary recorded.';
  const debtLevel = typeof value.debt_level === 'string' ? value.debt_level : 'unknown';
  const unsupportedCount = recordNumber(value, 'unsupported_assumption_count');
  const inferredTradeoffCount = recordNumber(value, 'inferred_tradeoff_count');
  const lowConfidenceCount = recordNumber(value, 'low_confidence_area_count');
  const blockingUnknownCount = recordNumber(value, 'blocking_unknown_count');
  const unsupportedAssumptions = recordArray(value, 'unsupported_assumptions')
    .filter(isRecord)
    .slice(0, 3)
    .map((assumption) => {
      const assumptionId =
        typeof assumption.assumption_id === 'string' ? assumption.assumption_id : 'unknown';
      const reason =
        typeof assumption.reason === 'string'
          ? assumption.reason
          : 'Unsupported architecture assumption recorded.';
      return `${assumptionId}: ${reason}`;
    });
  const lowConfidenceAreas = recordArray(value, 'low_confidence_areas')
    .filter(isRecord)
    .slice(0, 3)
    .map((area) => {
      const areaId = typeof area.area_id === 'string' ? area.area_id : 'unknown area';
      const reason =
        typeof area.reason === 'string' ? area.reason : 'Low-confidence area recorded.';
      return `${areaId}: ${reason}`;
    });
  const blockingUnknowns = asStringArray(value.blocking_unknowns).slice(0, 4);
  return renderList([
    `${debtLevel} confidence debt: ${summary}`,
    `${unsupportedCount} unsupported assumption(s)`,
    `${inferredTradeoffCount} inferred tradeoff(s)`,
    `${lowConfidenceCount} low-confidence area(s)`,
    `${blockingUnknownCount} blocking unknown(s)`,
    ...unsupportedAssumptions,
    ...lowConfidenceAreas,
    ...blockingUnknowns,
  ]);
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
  const impactMap = isRecord(value.impact_map) ? value.impact_map : {};
  const impactEntries = Array.isArray(impactMap.entries) ? impactMap.entries.filter(isRecord) : [];
  const deploymentIntelligence = isRecord(value.deployment_intelligence)
    ? value.deployment_intelligence
    : {};
  const deploymentSummary = isRecord(deploymentIntelligence.summary)
    ? deploymentIntelligence.summary
    : {};
  const deploymentFlows = recordArray(deploymentIntelligence, 'flows').filter(isRecord);
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
  const confidenceDebt = isRecord(value.confidence_debt) ? value.confidence_debt : {};
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
  const impactLabels = impactEntries.slice(0, 5).map((impact) => {
    const impactId = typeof impact.impact_id === 'string' ? impact.impact_id : 'unknown impact';
    const surfaceType =
      typeof impact.surface_type === 'string' ? impact.surface_type : 'unknown surface';
    const affectedFlows = Array.isArray(impact.affected_flows)
      ? impact.affected_flows.filter((item): item is string => typeof item === 'string').length
      : 0;
    const affectedTests = Array.isArray(impact.affected_tests)
      ? impact.affected_tests.filter((item): item is string => typeof item === 'string').length
      : 0;
    const affectedConfigs = Array.isArray(impact.affected_configs)
      ? impact.affected_configs.filter((item): item is string => typeof item === 'string').length
      : 0;
    const coupling =
      typeof impact.coupling_level === 'string' ? impact.coupling_level : 'unknown coupling';
    const riskReasoning = isRecord(impact.risk_reasoning) ? impact.risk_reasoning : {};
    const riskLevel =
      typeof riskReasoning.risk_level === 'string' ? riskReasoning.risk_level : 'unknown';
    const riskScore =
      typeof riskReasoning.risk_score === 'number' ? `${riskReasoning.risk_score}/10` : 'n/a';
    return `${impactId}: ${surfaceType}, ${affectedFlows} flow(s), ${affectedTests} test(s), ${affectedConfigs} config(s), ${coupling} coupling, ${riskLevel} risk (${riskScore})`;
  });
  const deploymentLabels = [
    `flows: ${String(deploymentSummary.deployment_flow_count ?? 0)}`,
    `configs: ${String(deploymentSummary.deployment_config_count ?? 0)}`,
    `production risks: ${String(deploymentSummary.production_risk_count ?? 0)}`,
    `posture: ${String(deploymentSummary.posture ?? 'unknown')}`,
    ...deploymentFlows.slice(0, 4).map((flow) => {
      const flowId = typeof flow.flow_id === 'string' ? flow.flow_id : 'unknown flow';
      const risks = typeof flow.production_risk_count === 'number' ? flow.production_risk_count : 0;
      const configs = Array.isArray(flow.configs)
        ? flow.configs.filter((item): item is string => typeof item === 'string').length
        : 0;
      return `${flowId}: ${configs} deploy config(s), ${risks} production risk(s)`;
    }),
    ...asStringArray(deploymentIntelligence.unknowns).slice(0, 4),
  ];
  return `<div class="grid">
    <article class="card"><h3>Confidence Debt</h3>${renderArchitectureConfidenceDebt(confidenceDebt)}</article>
    <article class="card"><h3>Deployment Intelligence</h3>${renderList(deploymentLabels)}</article>
    <article class="card"><h3>Impact Map</h3>${renderList([
      architectureImpactSummary(value),
      ...impactLabels,
    ])}</article>
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

function renderEvidenceCalibration(value: unknown): string {
  if (!isRecord(value)) return '';
  const surfaceMix = recordArray(value, 'surface_confidence_mix')
    .filter(isRecord)
    .slice(0, 5)
    .map((surface) => {
      const name = typeof surface.surface === 'string' ? surface.surface : 'unknown';
      const coverage =
        typeof surface.evidence_coverage_score === 'number' ? surface.evidence_coverage_score : 0;
      const mix = isRecord(surface.confidence_mix) ? surface.confidence_mix : {};
      return `${name}: ${String(mix.verified ?? 0)} verified, ${String(
        mix.inferred ?? 0,
      )} inferred, ${String(mix.uncertain ?? 0)} uncertain; ${coverage}/100 coverage`;
    });
  const weakAreas = recordArray(value, 'weak_evidence_areas')
    .filter(isRecord)
    .slice(0, 4)
    .map((area) => {
      const surface = typeof area.surface === 'string' ? area.surface : 'unknown';
      const reason = typeof area.reason === 'string' ? area.reason : 'Weak evidence recorded.';
      return `${surface}: ${reason}`;
    });
  const inspectFirst = recordArray(value, 'inspect_first')
    .filter(isRecord)
    .slice(0, 4)
    .map((gap) => {
      const priority = typeof gap.priority === 'number' ? gap.priority : 0;
      const id = typeof gap.id === 'string' ? gap.id : 'unknown claim';
      const hint =
        typeof gap.inspect_hint === 'string' ? gap.inspect_hint : 'Inspect this evidence gap.';
      return `P${priority} ${id}: ${hint}`;
    });
  const redactionImpact = isRecord(value.redaction_impact) ? value.redaction_impact : {};
  const impact = typeof redactionImpact.impact === 'string' ? redactionImpact.impact : 'unknown';
  const downgrades =
    typeof redactionImpact.confidence_downgrades === 'number'
      ? redactionImpact.confidence_downgrades
      : 0;
  return `<article class="card"><h3>Evidence Calibration</h3>${renderList([
    `redaction impact: ${impact}`,
    `redaction confidence downgrades: ${downgrades}`,
    ...surfaceMix,
  ])}</article>
  <article class="card"><h3>Weak Evidence Areas</h3>${renderList(weakAreas)}</article>
  <article class="card"><h3>Inspect First</h3>${renderList(inspectFirst)}</article>`;
}

function renderEvidenceActionability(value: unknown): string {
  if (!isRecord(value)) return '';
  const actionability = isRecord(value.actionability) ? value.actionability : {};
  let calibration: Record<string, unknown> = {};
  if (isRecord(actionability.calibration_summary)) {
    calibration = actionability.calibration_summary;
  } else if (isRecord(value.calibration_summary)) {
    calibration = value.calibration_summary;
  }
  let redaction: Record<string, unknown> = {};
  if (isRecord(actionability.redaction_hidden_evidence)) {
    redaction = actionability.redaction_hidden_evidence;
  } else if (isRecord(value.redaction_hidden_evidence)) {
    redaction = value.redaction_hidden_evidence;
  }
  let summary = 'Evidence actionability has not been summarized yet.';
  if (typeof actionability.summary === 'string') {
    summary = actionability.summary;
  } else if (typeof calibration.summary === 'string') {
    summary = calibration.summary;
  }
  const unbackedGroups = recordArray(actionability, 'unbacked_claim_groups')
    .filter(isRecord)
    .slice(0, 4)
    .map((group) => {
      const name = typeof group.group === 'string' ? group.group : 'claim group';
      const count = typeof group.claim_count === 'number' ? group.claim_count : 0;
      const hint = typeof group.inspect_hint === 'string' ? group.inspect_hint : '';
      return `${name}: ${count} unbacked claim(s)${hint === '' ? '' : ` - ${hint}`}`;
    });
  const lowConfidenceAreas = recordArray(actionability, 'low_confidence_claim_areas')
    .filter(isRecord)
    .slice(0, 4)
    .map((area) => {
      const name = typeof area.area === 'string' ? area.area : 'low-confidence area';
      const count = typeof area.claim_count === 'number' ? area.claim_count : 0;
      const hint = typeof area.inspect_hint === 'string' ? area.inspect_hint : '';
      return `${name}: ${count} claim(s)${hint === '' ? '' : ` - ${hint}`}`;
    });
  const readFirst = recordArray(actionability, 'suggested_read_first')
    .filter(isRecord)
    .slice(0, 4)
    .map((item) => {
      const priority = typeof item.priority === 'number' ? item.priority : 0;
      const target = typeof item.target_id === 'string' ? item.target_id : 'unknown target';
      const files = asStringArray(item.read_first_files).slice(0, 3);
      const fileLabel = files.length === 0 ? 'inspect entity evidence' : files.join(', ');
      return `P${priority} ${target}: ${fileLabel}`;
    });
  const confidenceDeltas = recordArray(actionability, 'evidence_confidence_deltas')
    .filter(isRecord)
    .slice(0, 4)
    .map((item) => {
      const priority = typeof item.priority === 'number' ? item.priority : 0;
      const target = typeof item.target_id === 'string' ? item.target_id : 'unknown target';
      const current =
        typeof item.current_confidence === 'string' ? item.current_confidence : 'uncertain';
      const next = typeof item.target_confidence === 'string' ? item.target_confidence : 'inferred';
      const delta = typeof item.confidence_delta === 'number' ? item.confidence_delta : 0;
      const actions = asStringArray(item.verification_actions).slice(0, 1);
      return `P${priority} ${target}: ${current} -> ${next} (+${delta})${actions.length === 0 ? '' : ` - ${actions[0]}`}`;
    });
  const redactionImpact = typeof redaction.impact === 'string' ? redaction.impact : 'none';
  const hiddenCount =
    typeof redaction.hidden_evidence_count === 'number' ? redaction.hidden_evidence_count : 0;
  const downgrades =
    typeof redaction.confidence_downgrades === 'number' ? redaction.confidence_downgrades : 0;
  const coverage =
    typeof calibration.evidence_coverage_score === 'number'
      ? calibration.evidence_coverage_score
      : 0;
  const fieldCoverage =
    typeof calibration.field_evidence_score === 'number' ? calibration.field_evidence_score : 0;
  return `<article class="card"><h3>Evidence Actionability</h3>${renderList([
    summary,
    `evidence coverage: ${coverage}/100`,
    `field evidence: ${fieldCoverage}/100`,
  ])}</article>
    <article class="card"><h3>Read First To Improve Confidence</h3>${renderList(readFirst)}</article>
    <article class="card"><h3>Confidence Upgrade Queue</h3>${renderList(confidenceDeltas)}</article>
    <article class="card"><h3>Unbacked Claim Groups</h3>${renderList(unbackedGroups)}</article>
    <article class="card"><h3>Low-Confidence Claim Areas</h3>${renderList(lowConfidenceAreas)}</article>
    <article class="card"><h3>Redaction-Hidden Evidence</h3>${renderList([
      `${hiddenCount} hidden evidence/reference(s)`,
      `impact: ${redactionImpact}`,
      `confidence downgrades: ${downgrades}`,
    ])}</article>`;
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
  const evidenceCalibration = renderEvidenceCalibration(value.evidence_calibration);
  const evidenceActionability = renderEvidenceActionability(value);
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
    ${evidenceCalibration}
    ${evidenceActionability}
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
  const understandingDeltas = isRecord(value.understanding_deltas)
    ? value.understanding_deltas
    : {};
  const changedSurfaceCount =
    typeof understandingDeltas.changed_surface_count === 'number'
      ? understandingDeltas.changed_surface_count
      : changedEntities;
  const newSurfaceCount =
    typeof understandingDeltas.new_surface_count === 'number'
      ? understandingDeltas.new_surface_count
      : addedEntities;
  const stableSurfaceCount =
    typeof understandingDeltas.stable_surface_count === 'number'
      ? understandingDeltas.stable_surface_count
      : stableEntities;
  const staleSurfaceCount =
    typeof understandingDeltas.stale_surface_count === 'number'
      ? understandingDeltas.stale_surface_count
      : staleFacts;
  const changedSurfaceLabels = renderUnderstandingSurfaceLabels(
    Array.isArray(understandingDeltas.changed_surfaces) ? understandingDeltas.changed_surfaces : [],
  );
  const newSurfaceLabels = renderUnderstandingSurfaceLabels(
    Array.isArray(understandingDeltas.new_surfaces) ? understandingDeltas.new_surfaces : [],
  );
  const stableSurfaceLabels = renderUnderstandingSurfaceLabels(
    Array.isArray(understandingDeltas.stable_surfaces) ? understandingDeltas.stable_surfaces : [],
  );
  const staleSurfaceLabels = renderUnderstandingSurfaceLabels(
    Array.isArray(understandingDeltas.stale_surfaces) ? understandingDeltas.stale_surfaces : [],
  );
  return `<div class="grid">
    <article class="card"><h3>Changed Understanding Surfaces</h3>${renderList([
      `${changedSurfaceCount} changed surface(s)`,
      `${newSurfaceCount} new surface(s)`,
      ...changedSurfaceLabels,
      ...newSurfaceLabels,
    ])}</article>
    <article class="card"><h3>Stable Understanding Surfaces</h3>${renderList([
      `${stableSurfaceCount} stable surface(s)`,
      ...stableSurfaceLabels,
    ])}</article>
    <article class="card"><h3>Stale Understanding Surfaces</h3>${renderList([
      `${staleSurfaceCount} stale surface(s)`,
      `${staleFacts} stale fact candidate(s)`,
      ...staleSurfaceLabels,
      ...staleCandidates,
    ])}</article>
    <article class="card"><h3>Scan Efficiency</h3>${renderList([
      `${scanEfficiency}/100`,
      `${changedFiles} changed file(s)`,
      `${reusedUnderstanding} reused understanding item(s)`,
      `${recomputedUnderstanding} recomputed understanding item(s)`,
    ])}</article>
    <article class="card"><h3>Relationship Delta</h3>${renderList(relationshipLabels)}</article>
    <article class="card"><h3>Evidence Delta</h3>${renderList(evidenceLabels)}</article>
  </div>`;
}

function renderUnderstandingSurfaceLabels(surfaces: readonly unknown[]): string[] {
  return surfaces
    .filter(isRecord)
    .slice(0, 6)
    .map((surface) => {
      const name = typeof surface.name === 'string' ? surface.name : 'unknown surface';
      const type = typeof surface.surface_type === 'string' ? surface.surface_type : 'unknown';
      let delta = '';
      if (typeof surface.score_delta === 'number' && surface.score_delta !== 0) {
        const sign = surface.score_delta > 0 ? '+' : '';
        delta = ` (${sign}${surface.score_delta})`;
      }
      return `${type}: ${name}${delta}`;
    });
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

function reportArtifactHref(artifactPath: string): string {
  if (artifactPath.startsWith('.rizz/brain/')) {
    return `../brain/${artifactPath.slice('.rizz/brain/'.length)}`;
  }
  if (artifactPath.startsWith('.rizz/research/')) {
    return `../research/${artifactPath.slice('.rizz/research/'.length)}`;
  }
  if (artifactPath.startsWith('.rizz/reports/')) {
    return artifactPath.slice('.rizz/reports/'.length);
  }
  return artifactPath;
}

function renderArtifactLinks(artifactPaths?: readonly string[]): string {
  const artifacts = artifactPaths ?? [
    '.rizz/brain/latest.json',
    '.rizz/brain/index.json',
    '.rizz/brain/graph.json',
    '.rizz/brain/entities/components.json',
    '.rizz/brain/entities/services.json',
    '.rizz/brain/entities/flows.json',
    '.rizz/brain/entities/evidence.json',
    '.rizz/research/evidence_quality.json',
    '.rizz/research/understanding_score.json',
    '.rizz/research/service_intelligence.json',
    '.rizz/research/architecture_reasoning.json',
    '.rizz/research/benchmark_tasks.json',
    '.rizz/research/pie_acceptance.json',
  ];
  return `<ul class="artifact-links">${artifacts
    .map(
      (artifact) =>
        `<li><a href="${htmlEscape(reportArtifactHref(artifact))}"><code>${htmlEscape(
          artifact,
        )}</code></a></li>`,
    )
    .join('')}</ul>`;
}

function renderObjectDetails(params: {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly count?: number;
  readonly posture?: string;
  readonly open?: boolean;
}): string {
  const count = params.count === undefined ? '' : `<span>${params.count}</span>`;
  const posture = params.posture === undefined ? '' : `<span>${htmlEscape(params.posture)}</span>`;
  const open = params.open === true ? ' open' : '';
  return `<details class="object" data-object="${htmlEscape(stableSlug(params.title))}"${open}>
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
    ['services', 'Services'],
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

function recordString(value: unknown, key: string, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const item = value[key];
  return typeof item === 'string' ? item : fallback;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const item = value[key];
  return isRecord(item) ? item : {};
}

function renderAskReadinessLine(value: unknown): string {
  if (!isRecord(value)) {
    return '<article class="card compact"><h3>Ask readiness</h3><p class="muted">No future-question readiness gate is available yet.</p></article>';
  }
  const score = recordNumber(value, 'score');
  const status = recordString(value, 'status', scoreBand(score));
  const summary = recordString(
    value,
    'summary',
    'Local readiness for future broader repo questions has not been summarized yet.',
  );
  const improvements = recordArray(value, 'next_required_improvements')
    .filter((item): item is string => typeof item === 'string')
    .slice(0, 3);
  return `<article class="card compact" data-search="${htmlEscape(
    `ask readiness future broader repo questions ${score} ${status} ${summary} ${improvements.join(' ')}`,
  )}">
    <h3>Ask readiness</h3>
    <p><strong>${score}/100 · ${htmlEscape(status)}</strong></p>
    <p>${htmlEscape(summary)}</p>
    <h4>Next</h4>
    ${renderList(improvements)}
  </article>`;
}

function incrementalHealthFromLatest(latest: Record<string, unknown>): {
  readonly services: Record<string, unknown>;
  readonly flows: Record<string, unknown>;
} {
  const projectState = nestedRecord(latest, 'project_state');
  const projectHealth = nestedRecord(projectState, 'incremental_health');
  const latestIncremental = nestedRecord(latest, 'latest_incremental_update');
  const services = nestedRecord(projectHealth, 'services');
  const flows = nestedRecord(projectHealth, 'flows');
  return {
    services:
      Object.keys(services).length > 0
        ? services
        : nestedRecord(latestIncremental, 'service_incremental_health'),
    flows:
      Object.keys(flows).length > 0
        ? flows
        : nestedRecord(latestIncremental, 'flow_incremental_health'),
  };
}

function incrementalHealthLine(label: string, health: Record<string, unknown>): string {
  const total = recordNumber(health, 'total');
  const changed = recordNumber(health, 'changed');
  const reused = recordNumber(health, 'reused');
  const recomputed = recordNumber(health, 'recomputed');
  const stale = recordNumber(health, 'stale');
  return `${label}: ${changed} changed, ${reused} reused, ${recomputed} recomputed, ${stale} stale of ${total}`;
}

function renderIncrementalHealthCard(latest: Record<string, unknown>): string {
  const health = incrementalHealthFromLatest(latest);
  const serviceSourceChanged = asStringArray(health.services.source_changed_ids).length;
  const flowSourceChanged = asStringArray(health.flows.source_changed_ids).length;
  return `<article class="card compact">
    <h3>Incremental Health</h3>
    ${renderList([
      incrementalHealthLine('services', health.services),
      incrementalHealthLine('flows', health.flows),
      `${serviceSourceChanged} source-changed service(s)`,
      `${flowSourceChanged} source-changed flow(s)`,
    ])}
  </article>`;
}

interface FlowServiceCausalityRow {
  readonly flowId: string;
  readonly flowName: string;
  readonly service: FlowServiceCausality;
}

function flowServiceCausalityRows(flows: readonly BrainEntity[]): FlowServiceCausalityRow[] {
  return flows.flatMap((flow) =>
    safeFlowServiceCausality(flow).map((service) => ({
      flowId: flow.id,
      flowName: flow.name,
      service,
    })),
  );
}

function renderServiceCausalityCard(flows: readonly BrainEntity[]): string {
  const rows = flowServiceCausalityRows(flows);
  const flowCount = new Set(rows.map((row) => row.flowId)).size;
  const serviceCount = new Set(rows.map((row) => row.service.service_id)).size;
  const topRows = rows
    .slice(0, 4)
    .map(
      (row) =>
        `${row.flowName} -> ${row.service.service_name}: ${row.service.effects.length} effect(s), ${row.service.confidence}`,
    );
  return `<article class="card compact">
    <h3>Service Causality</h3>
    ${renderList([
      `${rows.length} flow-service causality link(s)`,
      `${flowCount} flow(s) with service evidence`,
      `${serviceCount} linked service(s)`,
      ...topRows,
    ])}
  </article>`;
}

interface ServiceReachabilityQuality {
  readonly score: number;
  readonly posture: string;
  readonly pathCount: number;
  readonly evidenceCoverage: number;
  readonly freshnessScore: number;
  readonly uncertainCount: number;
  readonly unknownCount: number;
  readonly missingEvidenceCount: number;
  readonly missingEffectCount: number;
  readonly missingStepLinkCount: number;
  readonly driftedPathCount: number;
  readonly stalePathCount: number;
  readonly summary: string;
}

function serviceReachabilityQualityFromLatest(
  latest: Record<string, unknown>,
): ServiceReachabilityQuality {
  const architectureReasoning = nestedRecord(latest, 'latest_architecture_reasoning');
  const causalityReasoning = nestedRecord(architectureReasoning, 'service_causality_reasoning');
  const evidenceQuality = nestedRecord(latest, 'latest_evidence_quality');
  const quality = nestedRecord(evidenceQuality, 'service_causality_quality');
  const incrementalUpdate = nestedRecord(latest, 'latest_incremental_update');
  const delta = nestedRecord(incrementalUpdate, 'service_causality_delta');
  const confidenceDistribution = nestedRecord(causalityReasoning, 'confidence_distribution');

  const pathCount = recordNumber(causalityReasoning, 'total_paths');
  const totalClaims = recordNumber(quality, 'total_claims');
  const evidenceCoverage =
    totalClaims > 0
      ? recordNumber(quality, 'evidence_coverage_score')
      : recordNumber(evidenceQuality, 'service_causality_coverage_score');
  const freshnessScore = recordNumber(delta, 'freshness_score');
  const uncertainCount = Math.max(
    recordNumber(confidenceDistribution, 'uncertain'),
    recordNumber(evidenceQuality, 'service_causality_uncertain_claims'),
  );
  const unknownCount =
    asStringArray(causalityReasoning.unknowns).length +
    asStringArray(causalityReasoning.missing_effect_paths).length +
    asStringArray(causalityReasoning.missing_step_link_paths).length;
  const missingEvidenceCount = recordNumber(
    evidenceQuality,
    'service_causality_missing_evidence_claims',
  );
  const missingEffectCount = recordNumber(
    evidenceQuality,
    'service_causality_missing_effect_claims',
  );
  const missingStepLinkCount = recordNumber(
    evidenceQuality,
    'service_causality_missing_step_link_claims',
  );
  const driftedPathCount = recordNumber(delta, 'drifted_path_count');
  const stalePathCount = recordNumber(delta, 'stale_path_count');
  const baseScore = pathCount === 0 ? 0 : Math.round((evidenceCoverage + freshnessScore) / 2);
  const qualityPenalty =
    Math.min(25, uncertainCount * 4) +
    Math.min(20, missingEvidenceCount * 8) +
    Math.min(15, missingEffectCount * 5) +
    Math.min(15, missingStepLinkCount * 5) +
    Math.min(20, driftedPathCount * 4 + stalePathCount * 6);
  const score = Math.max(0, Math.min(100, baseScore - qualityPenalty));
  const posture = qualityBandFromScore(score);
  const summary =
    pathCount === 0
      ? 'No flow-service reachability paths are reconstructed yet.'
      : `${pathCount} static reachability path(s); ${uncertainCount} uncertain/static-import-only, ${unknownCount} unknown, ${freshnessScore}/100 fresh.`;

  return {
    score,
    posture,
    pathCount,
    evidenceCoverage,
    freshnessScore,
    uncertainCount,
    unknownCount,
    missingEvidenceCount,
    missingEffectCount,
    missingStepLinkCount,
    driftedPathCount,
    stalePathCount,
    summary,
  };
}

function renderFlagshipSummary(params: {
  readonly understandingScore: unknown;
  readonly askReadiness: unknown;
  readonly evidenceQuality: unknown;
  readonly incrementalUpdate: unknown;
  readonly architectureReasoning: unknown;
  readonly latest: Record<string, unknown>;
  readonly flows: readonly BrainEntity[];
  readonly flowCount: number;
  readonly evidenceCount: number;
  readonly reviewReadiness: { readonly value: number; readonly posture: string };
  readonly evidenceMetric: { readonly value: number; readonly posture: string };
}): string {
  const overallUnderstanding = recordNumber(params.understandingScore, 'overall_score');
  const understandingBand = recordString(
    params.understandingScore,
    'score_band',
    scoreBand(overallUnderstanding),
  );
  const dimensions = nestedRecord(params.understandingScore, 'dimensions');
  const flowDimension = nestedRecord(dimensions, 'flows');
  const evidenceCalibration = nestedRecord(params.evidenceQuality, 'evidence_calibration');
  const redactionImpact = nestedRecord(evidenceCalibration, 'redaction_impact');
  const confidenceDebt = nestedRecord(params.architectureReasoning, 'confidence_debt');
  const changedFiles = recordNumber(params.incrementalUpdate, 'changed_file_count');
  const changedEntities = recordNumber(params.incrementalUpdate, 'changed_entity_count');
  const stableEntities = recordNumber(params.incrementalUpdate, 'stable_entity_count');
  const reusedUnderstanding = recordNumber(params.incrementalUpdate, 'reused_understanding_count');
  const recomputedUnderstanding = recordNumber(
    params.incrementalUpdate,
    'recomputed_understanding_count',
  );
  const scanEfficiency = recordNumber(params.incrementalUpdate, 'scan_efficiency_score');
  const flowScore = recordNumber(flowDimension, 'score');
  const flowStatus = recordString(flowDimension, 'status', scoreBand(flowScore));
  const debtLevel = recordString(confidenceDebt, 'debt_level', 'unknown');
  const debtCount = recordNumber(confidenceDebt, 'debt_count');
  const unsupportedAssumptions = recordNumber(confidenceDebt, 'unsupported_assumption_count');
  const blockingUnknowns = recordNumber(confidenceDebt, 'blocking_unknown_count');
  const redactionImpactLabel = recordString(redactionImpact, 'impact', 'unknown');
  const redactionSafety = recordNumber(params.evidenceQuality, 'redaction_safety_score');
  const weakEvidenceClaims = recordNumber(params.evidenceQuality, 'weak_evidence_claims');
  const unsupportedClaims = recordNumber(params.evidenceQuality, 'unsupported_claims');
  const evidenceGaps = recordNumber(params.evidenceQuality, 'evidence_gap_count');
  const reviewAttention = isRecord(params.understandingScore)
    ? recordArray(params.understandingScore.review_readiness, 'required_attention')
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 3)
    : [];

  return `<section class="flagship-summary">
    <h3>Flagship Summary</h3>
    <p class="muted">Fast local answer to what Rizz understands, what changed, what to inspect first, and where confidence is weak.</p>
    <div class="flagship-grid">
      <article class="card compact">
        <h3>Understanding Level</h3>
        ${renderList([
          `${overallUnderstanding}/100 overall`,
          `${understandingBand} posture`,
          metricSummaryFromScore(overallUnderstanding),
        ])}
      </article>
      <article class="card compact">
        <h3>Evidence Quality Calibration</h3>
        ${renderList([
          `${params.evidenceMetric.value}/100 evidence quality`,
          `${params.evidenceMetric.posture} posture`,
          `${unsupportedClaims} unsupported claim(s)`,
          `${weakEvidenceClaims} weak evidence claim(s)`,
          `${evidenceGaps} evidence gap(s)`,
          `redaction impact: ${redactionImpactLabel}`,
          `redaction safety: ${redactionSafety}/100`,
        ])}
      </article>
      <article class="card compact">
        <h3>Flow Coverage</h3>
        ${renderList([
          `${params.flowCount} reconstructed flow(s)`,
          `${flowScore}/100 flow score`,
          `${flowStatus} flow posture`,
        ])}
      </article>
      ${renderServiceCausalityCard(params.flows)}
      ${renderIncrementalHealthCard(params.latest)}
      <article class="card compact">
        <h3>Architecture Confidence Debt</h3>
        ${renderList([
          `${debtLevel} debt level`,
          `${debtCount} debt item(s)`,
          `${unsupportedAssumptions} unsupported assumption(s)`,
          `${blockingUnknowns} blocking unknown(s)`,
        ])}
      </article>
      <article class="card compact">
        <h3>Review Readiness</h3>
        ${renderList([
          `${params.reviewReadiness.value}/100 review readiness`,
          `${params.reviewReadiness.posture} posture`,
          ...reviewAttention,
        ])}
      </article>
      ${renderAskReadinessLine(params.askReadiness)}
      <article class="card compact">
        <h3>Incremental Changed / Stable</h3>
        ${renderList([
          `${changedFiles} changed file(s)`,
          `${changedEntities} changed understanding item(s)`,
          `${stableEntities} stable understanding item(s)`,
          `${reusedUnderstanding} reused understanding item(s)`,
          `${recomputedUnderstanding} recomputed understanding item(s)`,
          `${scanEfficiency}/100 scan efficiency`,
        ])}
      </article>
      <article class="card compact read-first-card">
        <h3>Read First Pointers</h3>
        ${renderReadFirstPointers(params.understandingScore)}
      </article>
      <article class="card compact">
        <h3>Research Artifacts</h3>
        ${renderArtifactLinks([
          '.rizz/brain/latest.json',
          '.rizz/brain/index.json',
          '.rizz/research/understanding_score.json',
          '.rizz/research/service_intelligence.json',
          '.rizz/research/evidence_quality.json',
          '.rizz/research/flow_coverage.json',
          '.rizz/research/architecture_reasoning.json',
          '.rizz/research/benchmark_ready.json',
          '.rizz/research/benchmark_tasks.json',
          '.rizz/research/pie_acceptance.json',
          '.rizz/research/incremental_update.json',
        ])}
        <p class="muted">${params.evidenceCount} local evidence record(s).</p>
      </article>
    </div>
  </section>`;
}

function renderIncrementalHealthDetails(latest: Record<string, unknown>): string {
  const health = incrementalHealthFromLatest(latest);
  const rows: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['Services', health.services],
    ['Flows', health.flows],
  ];
  return `<table><thead><tr><th>Surface</th><th>Summary</th><th>Changed</th><th>Reused</th><th>Recomputed</th><th>Stale</th><th>Source Changed</th></tr></thead><tbody>${rows
    .map(([label, item]) => {
      const changed = asStringArray(item.changed_ids);
      const reused = asStringArray(item.reused_ids);
      const recomputed = asStringArray(item.recomputed_ids);
      const stale = asStringArray(item.stale_ids);
      const sourceChanged = asStringArray(item.source_changed_ids);
      return `<tr>
        <td><strong>${htmlEscape(label)}</strong></td>
        <td>${htmlEscape(incrementalHealthLine(label.toLowerCase(), item))}</td>
        <td>${renderList(changed.slice(0, 8))}</td>
        <td>${renderList(reused.slice(0, 8))}</td>
        <td>${renderList(recomputed.slice(0, 8))}</td>
        <td>${renderList(stale.slice(0, 8))}</td>
        <td>${renderList(sourceChanged.slice(0, 8))}</td>
      </tr>`;
    })
    .join('')}</tbody></table>`;
}

function renderServiceCausalityDetails(
  flows: readonly BrainEntity[],
  evidenceById: ReadonlyMap<string, BrainEntity>,
  latest: Record<string, unknown>,
): string {
  const rows = flowServiceCausalityRows(flows);
  const reachability = serviceReachabilityQualityFromLatest(latest);
  const architectureReasoning = nestedRecord(latest, 'latest_architecture_reasoning');
  const causalityReasoning = nestedRecord(architectureReasoning, 'service_causality_reasoning');
  const incrementalUpdate = nestedRecord(latest, 'latest_incremental_update');
  const delta = nestedRecord(incrementalUpdate, 'service_causality_delta');
  const routeImpacts = recordArray(causalityReasoning, 'route_impacts').filter(isRecord);
  const pathDeltas = recordArray(delta, 'path_deltas').filter(isRecord);
  const effects = asStringArray(causalityReasoning.effects).slice(0, 8);
  const unknowns = asStringArray(causalityReasoning.unknowns).slice(0, 6);
  const missingEffectPaths = asStringArray(causalityReasoning.missing_effect_paths).slice(0, 6);
  const missingStepLinkPaths = asStringArray(causalityReasoning.missing_step_link_paths).slice(
    0,
    6,
  );
  const qualityCards = `<div class="grid">
    <article class="card compact">
      <div class="badge">${reachability.score}/100 · ${htmlEscape(reachability.posture)}</div>
      <h3>Reachability Quality</h3>
      ${renderList([
        reachability.summary,
        `${reachability.evidenceCoverage}/100 evidence coverage`,
        `${reachability.uncertainCount} uncertain/static-import-only claim(s)`,
        `${reachability.missingEvidenceCount} missing evidence claim(s)`,
      ])}
    </article>
    <article class="card compact">
      <h3>Effects & Unknowns</h3>
      ${renderList([
        `${recordNumber(causalityReasoning, 'effect_count')} distinct effect(s)`,
        `${reachability.missingEffectCount} missing effect claim(s)`,
        `${reachability.missingStepLinkCount} missing step-link claim(s)`,
        ...effects,
        ...unknowns,
        ...missingEffectPaths,
        ...missingStepLinkPaths,
      ])}
    </article>
    <article class="card compact">
      <h3>Freshness</h3>
      ${renderList([
        `${reachability.freshnessScore}/100 freshness`,
        `${recordNumber(delta, 'stable_path_count')} stable path(s)`,
        `${recordNumber(delta, 'recomputed_path_count')} recomputed/new path(s)`,
        `${reachability.driftedPathCount} drifted path(s)`,
        `${reachability.stalePathCount} stale path(s)`,
        ...asStringArray(delta.affected_flows)
          .slice(0, 3)
          .map((flow) => `affected flow: ${flow}`),
        ...asStringArray(delta.affected_services)
          .slice(0, 3)
          .map((service) => `affected service: ${service}`),
      ])}
    </article>
    <article class="card compact">
      <h3>Artifacts</h3>
      ${renderArtifactLinks([
        '.rizz/research/architecture_reasoning.json',
        '.rizz/research/evidence_quality.json',
        '.rizz/research/incremental_update.json',
      ])}
    </article>
  </div>`;
  if (rows.length === 0) {
    return `${qualityCards}<p class="muted">No service causality links detected yet.</p>`;
  }
  const pathCards = rows
    .slice(0, 8)
    .map((row) => {
      const routeImpact = routeImpacts.find(
        (impact) => impact.flow_id === row.flowId && impact.service_id === row.service.service_id,
      );
      const pathDelta = pathDeltas.find(
        (deltaItem) =>
          deltaItem.flow_id === row.flowId && deltaItem.service_id === row.service.service_id,
      );
      const routePath = recordString(routeImpact, 'route_path', row.flowName);
      const deltaStatus = recordString(pathDelta, 'status', 'unknown freshness');
      const whatBreaks = asStringArray(routeImpact?.what_breaks).slice(0, 3);
      const reasons = asStringArray(pathDelta?.reasons).slice(0, 3);
      return `<article class="card compact" data-search="${htmlEscape(
        `${row.flowId} ${row.flowName} ${row.service.service_id} ${row.service.cause} ${row.service.effects.join(' ')}`,
      )}">
        <div class="badge">${htmlEscape(row.service.confidence)} · ${htmlEscape(deltaStatus)}</div>
        <h3>${htmlEscape(routePath)} -> ${htmlEscape(row.service.service_name)}</h3>
        <p class="muted">${htmlEscape(row.flowId)} · ${htmlEscape(row.service.service_id)}</p>
        <p>${htmlEscape(row.service.cause)}</p>
        <h4>Effects</h4>
        ${renderList(row.service.effects)}
        <h4>What Breaks</h4>
        ${renderList(whatBreaks)}
        <h4>Unknowns</h4>
        ${renderList(row.service.unknowns)}
        <h4>Freshness Reasons</h4>
        ${renderList(reasons)}
        <h4>Evidence</h4>
        ${renderEvidenceLinks(row.service.evidence_ids, evidenceById)}
      </article>`;
    })
    .join('');
  return `${qualityCards}<h3>Reachability Paths</h3><div class="grid">${pathCards}</div>`;
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

function renderPieAcceptanceCard(value: unknown): string {
  if (!isRecord(value)) {
    return `<article class="card compact">
      <h3>PIE Acceptance</h3>
      <p class="muted">No PIE acceptance artifact is available yet.</p>
    </article>`;
  }
  const path = recordString(value, 'path', '.rizz/research/pie_acceptance.json');
  const score = recordNumber(value, 'overall_score');
  const status = recordString(value, 'overall_status', scoreBand(score));
  return `<article class="card compact" data-search="${htmlEscape(
    `PIE acceptance readiness ${score} ${status} ${path}`,
  )}">
    <h3>PIE Acceptance</h3>
    ${renderList([`${score}/100`, `${status} status`])}
    ${renderArtifactLinks([path])}
  </article>`;
}

function renderBenchmarkTasks(value: unknown): string {
  if (!isRecord(value)) {
    return '<p class="muted">No benchmark task artifact is available yet.</p>';
  }
  const taskCount = recordNumber(value, 'task_count');
  const summary = recordString(
    value,
    'summary',
    'Benchmark task candidates are emitted from local research artifacts.',
  );
  const taskCategories = isRecord(value.task_categories) ? value.task_categories : {};
  const categoryLabels = Object.entries(taskCategories)
    .map(([category, count]) => `${category}: ${String(count)}`)
    .sort((a, b) => a.localeCompare(b));
  const path = recordString(value, 'path', '.rizz/research/benchmark_tasks.json');
  const missionControl = recordString(value, 'mission_control', '.rizz/reports/index.html');
  const pieAcceptance = isRecord(value.pie_acceptance) ? value.pie_acceptance : undefined;

  return `<div class="grid">
    ${renderPieAcceptanceCard(pieAcceptance)}
    <article class="card compact">
      <h3>Task Inventory</h3>
      ${renderList([`${taskCount} benchmark task(s)`, summary])}
    </article>
    <article class="card compact">
      <h3>Categories</h3>
      ${renderList(categoryLabels)}
    </article>
    <article class="card compact">
      <h3>Benchmark Artifacts</h3>
      ${renderArtifactLinks([
        path,
        '.rizz/research/benchmark_ready.json',
        '.rizz/research/pie_acceptance.json',
        '.rizz/research/understanding_score.json',
        '.rizz/research/service_intelligence.json',
        '.rizz/brain/latest.json',
        '.rizz/brain/index.json',
        missionControl,
      ])}
    </article>
  </div>`;
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
  const askReadiness = params.latest.latest_ask_readiness;
  const flagshipSummary = renderFlagshipSummary({
    understandingScore,
    askReadiness,
    evidenceQuality: params.latest.latest_evidence_quality,
    incrementalUpdate,
    architectureReasoning: params.latest.latest_architecture_reasoning,
    latest: params.latest,
    flows: params.buckets.flows,
    flowCount: params.buckets.flows.length,
    evidenceCount: params.buckets.evidence.length,
    reviewReadiness,
    evidenceMetric: evidenceQuality,
  });
  const understandingObject = renderObjectDetails({
    title: 'Understanding',
    summary:
      'The local answer to what Rizz understands, what changed, and which files or artifacts to inspect first.',
    posture: understandingPosture,
    open: true,
    body: `${flagshipSummary}
      ${renderUnderstandingDashboard(understandingScore)}
      <h3><span>Read First</span></h3>
      <h2>Start Here</h2>
      <div class="grid">${renderReadFirstPointers(understandingScore)}</div>
      <h3>Entry Points</h3>
      <div class="grid">${renderStartHere(params.buckets.components, evidenceById)}</div>
      <h3>Recommended Next Actions</h3>
      ${renderList(recommendedActions.slice(0, 5))}
      <h3>Incremental Understanding</h3>
      ${renderIncrementalUnderstanding(params.latest.latest_incremental_update)}`,
  });
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
  const serviceObject = renderObjectDetails({
    title: 'Service Intelligence',
    summary:
      'Runtime services reconstructed from service-like files, routes, jobs, storage, env vars, external APIs, deployment configs, and related flows.',
    count: params.buckets.services.length,
    posture: params.buckets.services.length === 0 ? 'weak' : 'usable',
    body: `<div class="grid">${renderServiceCards(params.buckets.services, evidenceById)}</div>`,
  });
  const serviceCausalityRows = flowServiceCausalityRows(params.buckets.flows);
  const serviceReachability = serviceReachabilityQualityFromLatest(params.latest);
  const serviceCausalityObject = renderObjectDetails({
    title: 'Service Causality',
    summary: `Reachability ${serviceReachability.score}/100: ${serviceReachability.summary}`,
    count: serviceCausalityRows.length,
    posture: serviceCausalityRows.length === 0 ? 'weak' : serviceReachability.posture,
    body: renderServiceCausalityDetails(params.buckets.flows, evidenceById, params.latest),
  });
  const journeyObject = renderObjectDetails({
    title: 'Journey Intelligence',
    summary:
      'Product and user journeys inferred from routes, handlers, files, configs, tests, commands, runtime surfaces, and review impact.',
    count: params.buckets.flows.filter((flow) => flowJourneySummaryData(flow) !== undefined).length,
    posture:
      params.buckets.flows.filter((flow) => flowJourneySummaryData(flow) !== undefined).length === 0
        ? 'weak'
        : 'usable',
    body: renderJourneyIntelligence(params.buckets.flows, params.latest),
  });
  const incrementalHealthObject = renderObjectDetails({
    title: 'Incremental Health',
    summary:
      'Service and flow reuse, recompute, source-change, and stale-state health from latest project state.',
    posture: scanEfficiency >= 70 ? 'strong' : scanEfficiency >= 40 ? 'usable' : 'weak',
    body: renderIncrementalHealthDetails(params.latest),
  });
  const architectureObject = renderObjectDetails({
    title: 'Architecture',
    summary:
      'Reasoning from relationships, component pressure, coupling, boundaries, and evidence gaps.',
    posture: understandingPosture,
    body: `<p>${htmlEscape(String(params.latest.latest_architecture_summary ?? ''))}</p>
      ${renderArchitectureReasoning(params.latest.latest_architecture_reasoning)}
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
      <h3>How To Run Locally</h3>
      ${renderList(commands)}
      <h3>How To Test</h3>
      ${renderList(testCommands)}
      <h3>Confidence Guide</h3>
      <div class="grid">
        <article class="card"><h3>strong</h3><p>Direct evidence is good enough for review orientation.</p></article>
        <article class="card"><h3>usable</h3><p>Useful for navigation; confirm before relying on it.</p></article>
        <article class="card"><h3>weak</h3><p>Incomplete or unsupported. Treat as a queue for evidence work.</p></article>
      </div>`,
  });
  const reviewObject = renderObjectDetails({
    title: 'Review Readiness',
    summary: 'Latest review posture, affected flows, risk areas, and attention queue.',
    posture: reviewReadiness.posture,
    body: `<h3><span>Review Blast Radius</span></h3>
      ${renderLatestReview(params.latest)}
      <h3>Targeted Verification</h3>
      ${renderLatestVerificationPlan(params.latest)}
      <h3>Affected Route Flows</h3>
      ${renderLatestReviewRouteFlows(params.latest, params.buckets.flows, evidenceById)}
      <h3>Risk Areas</h3>
      <div class="grid">${renderRiskCards(params.buckets.risks, evidenceById)}</div>
      <h3>Required Attention</h3>
      ${renderList(
        isRecord(understandingScore)
          ? recordArray(understandingScore.review_readiness, 'required_attention')
              .filter((item): item is string => typeof item === 'string')
              .slice(0, 6)
          : [],
      )}`,
  });
  const evidenceQualityObject = renderObjectDetails({
    title: 'Evidence Quality',
    summary: 'Evidence scores, calibration, redaction safety, actionability, and gaps.',
    posture: evidenceQuality.posture,
    body: `<h3>Evidence Quality Inspect</h3>
      ${renderEvidenceQuality(params.latest.latest_evidence_quality)}
      <h3>Evidence Quality Artifacts</h3>
      ${renderArtifactLinks([
        '.rizz/research/evidence_quality.json',
        '.rizz/research/understanding_score.json',
        '.rizz/brain/latest.json',
        '.rizz/brain/entities/evidence.json',
      ])}`,
  });
  const dependencyRuntimeObject = renderObjectDetails({
    title: 'Review Dependency Runtime Impact',
    summary: 'Latest review dependency/package/config runtime impact and verification focus.',
    posture: reviewReadiness.posture,
    body: `<h3>Review/Dependency Runtime Impact</h3>
      <h3>Dependency Runtime Inspect</h3>
      ${renderMissionControlDependencyRuntimeImpact(params.latest)}`,
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
  const benchmarkObject = renderObjectDetails({
    title: 'Benchmark Tasks',
    summary:
      'Deterministic evaluation tasks that point back to local brain and research artifacts.',
    posture:
      recordNumber(params.latest.latest_benchmark_tasks, 'task_count') === 0 ? 'weak' : 'usable',
    body: renderBenchmarkTasks(params.latest.latest_benchmark_tasks),
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
    .flagship { margin: 18px 0; }
    .flagship-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin: 0 16px 16px; }
    .read-first-card { grid-column: 1 / -1; }
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
    @media (max-width: 900px) { .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .flagship-grid { grid-template-columns: 1fr; } .artifact-links { columns: 1; } }
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
      ${renderAskReadinessLine(askReadiness)}
      <div class="stats">
        <span class="badge">${params.buckets.components.length} components</span>
        <span class="badge">${params.buckets.services.length} services</span>
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
      ${understandingObject}
      ${componentObject}
      ${serviceObject}
      ${serviceCausalityObject}
      ${journeyObject}
      ${flowObject}
      ${incrementalHealthObject}
      ${architectureObject}
      ${evidenceQualityObject}
      ${evidenceObject}
      ${unknownObject}
      ${dependencyRuntimeObject}
      ${reviewObject}
      ${benchmarkObject}
    </section>
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

  buckets.services.push(
    ...inferServices({
      rootDir: params.rootDir,
      now: params.now,
      files: params.files,
      packageFacts: params.packageFacts,
      components: buckets.components,
      tests: buckets.tests,
      configs: buckets.configs,
    }),
  );
  for (const service of buckets.services) {
    addRelation(
      relationships,
      projectId,
      'owns',
      service.id,
      service.evidence_ids,
      service.confidence,
    );
    for (const file of service.source_files.slice(0, 20)) {
      addRelation(relationships, service.id, 'owns', entityId('file', file), [evidenceId(file)]);
    }
    for (const componentId of serviceDataStringArray(service, 'related_components')) {
      addRelation(
        relationships,
        service.id,
        'depends_on',
        componentId,
        service.evidence_ids,
        'inferred',
      );
    }
    for (const config of serviceDataStringArray(service, 'deployment_configs')) {
      addRelation(relationships, service.id, 'configures', entityId('config', config), [
        evidenceId(config),
      ]);
    }
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
  buckets.services.splice(
    0,
    buckets.services.length,
    ...enrichServicesWithFlows(buckets.services, buckets.flows),
  );

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
        service_intelligence: '.rizz/research/service_intelligence.json',
        evidence_quality: '.rizz/research/evidence_quality.json',
        incremental_update: '.rizz/research/incremental_update.json',
        flow_understanding: '.rizz/research/flow_understanding.json',
        flow_coverage: '.rizz/research/flow_coverage.json',
        flow_confidence: '.rizz/research/flow_confidence.json',
        architecture_reasoning: '.rizz/research/architecture_reasoning.json',
        benchmark_ready: '.rizz/research/benchmark_ready.json',
        benchmark_tasks: '.rizz/research/benchmark_tasks.json',
        understanding_score: '.rizz/research/understanding_score.json',
        pie_acceptance: '.rizz/research/pie_acceptance.json',
        verification_evidence: '.rizz/research/verification_evidence.json',
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

export async function addVerificationEvidence(
  options: AddVerificationEvidenceOptions,
): Promise<AddVerificationEvidenceResult> {
  try {
    const name = options.name.trim();
    const command = options.command.trim();
    if (name === '') {
      return {
        ok: false,
        error: { code: 'VERIFY_NAME_REQUIRED', message: 'Verification evidence needs a name.' },
      };
    }
    if (command === '') {
      return {
        ok: false,
        error: {
          code: 'VERIFY_COMMAND_REQUIRED',
          message: 'Verification evidence needs the command that was run.',
        },
      };
    }
    const rootDir = options.rootDir;
    const now = (options.now ?? new Date()).toISOString();
    const researchDir = join(rootDir, '.rizz', 'research');
    await mkdir(researchDir, { recursive: true });
    const existing = await readVerificationEvidenceArtifact(rootDir, now);
    const item: VerificationEvidenceItem = {
      id: `verification:${stableSlug(name)}:${createHash('sha256')
        .update(`${name}\0${command}\0${now}`)
        .digest('hex')
        .slice(0, 12)}`,
      name: safeText(name),
      command: safeText(command),
      status: options.status,
      timestamp: now,
      ...(options.outputSummary !== undefined && options.outputSummary.trim() !== ''
        ? { output_summary: safeText(options.outputSummary.trim()) }
        : {}),
      affected_confidence_areas: unique([
        ...(options.affectedConfidenceAreas ?? []).map(safeText),
        ...(commandLooksProduction(command) ? ['production'] : []),
        ...(commandLooksLocal(command) ? ['local'] : []),
      ]),
    };
    const artifact = buildVerificationEvidenceArtifact({
      projectName: basename(rootDir),
      generatedAt: now,
      items: [...existing.items, item],
    });
    const artifactPath = verificationEvidenceArtifactPath(rootDir);
    await writeVerifiedFile(artifactPath, jsonString(safeResearchValue(artifact)));
    if (await hasProjectBrain(rootDir)) {
      const brainDir = join(rootDir, '.rizz', 'brain');
      const latestPath = join(brainDir, 'latest.json');
      const latest = (await readJsonFile<Record<string, unknown>>(latestPath)) ?? {};
      await writeVerifiedFile(
        latestPath,
        jsonString(
          safeBrainValue({
            ...latest,
            latest_verification_evidence: {
              artifact_path: '.rizz/research/verification_evidence.json',
              total_checks: artifact.items.length,
              status_counts: artifact.status_counts,
              latest_item_id: item.id,
              latest_status: item.status,
              updated_at: now,
            },
            latest_research_artifacts: {
              ...(isRecord(latest.latest_research_artifacts)
                ? latest.latest_research_artifacts
                : {}),
              verification_evidence: '.rizz/research/verification_evidence.json',
            },
          }),
        ),
      );
      await updateBrainIndexVerificationEvidencePath(join(brainDir, 'index.json'));
    }
    return { ok: true, value: { rootDir, researchDir, artifactPath, item, artifact } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'VERIFY_EVIDENCE_FAILED', message } };
  }
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
    const researchDir = join(rootDir, '.rizz', 'research');
    const reportsDir = join(rootDir, '.rizz', 'reports');
    await mkdir(entitiesDir, { recursive: true });
    await mkdir(researchDir, { recursive: true });
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
    const verificationEvidence = await readVerificationEvidenceArtifact(rootDir, now);

    const review = buildReview({
      rootDir,
      now,
      latest,
      relationships: graph.relationships ?? [],
      entitySets,
      changedFiles: gitChanges.value.changedFiles,
      diffText: gitChanges.value.diffText,
      verificationEvidence,
    });
    const reviewEval = buildReviewEvalArtifact(review);
    const reviewClaimEvidence = buildReviewClaimEvidenceArtifact(review);

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
        affected_services: review.affected_services.map((service) => service.id),
        affected_flows: review.affected_flows.map((flow) => flow.id),
        service_causality_paths: review.review_evidence_summary.service_causality_paths,
        service_causality_effects: review.review_evidence_summary.service_causality_effects,
        architecture_impact_surfaces: review.architecture_impact_map.map(
          (entry) => entry.impact_id,
        ),
        dependency_runtime_impact: review.dependency_runtime_impact,
        review_evidence_summary: review.review_evidence_summary,
        verification_status: review.verification_status,
        verification_plan: review.verification_plan,
        verification_plan_summary: verificationPlanSummary(review.verification_plan),
        research_artifacts: {
          review_eval: '.rizz/research/review_eval.json',
          review_claim_evidence: '.rizz/research/review_claim_evidence.json',
          verification_evidence: '.rizz/research/verification_evidence.json',
        },
      },
      latest_research_artifacts: {
        ...(isRecord(latest.latest_research_artifacts) ? latest.latest_research_artifacts : {}),
        review_eval: '.rizz/research/review_eval.json',
        review_claim_evidence: '.rizz/research/review_claim_evidence.json',
        verification_evidence: '.rizz/research/verification_evidence.json',
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
        last_reviewed_services: review.affected_services.map((service) => service.id),
        last_reviewed_flows: review.affected_flows.map((flow) => flow.id),
        last_review_risk: review.overall_risk,
      },
    };
    await writeVerifiedFile(latestPath, jsonString(safeBrainValue(updatedLatest)));
    await writeVerifiedFile(join(researchDir, 'review_eval.json'), jsonString(reviewEval));
    await writeVerifiedFile(
      reviewClaimEvidenceArtifactPath(rootDir),
      jsonString(reviewClaimEvidence),
    );
    await writeVerifiedFile(
      verificationEvidenceArtifactPath(rootDir),
      jsonString(safeResearchValue(verificationEvidence)),
    );
    await updateBrainIndexReviewArtifactPaths(join(brainDir, 'index.json'));

    const reviewReport = renderReviewReport(review);
    const reportPath = join(reportsDir, 'review.html');
    await writeVerifiedFile(reportPath, reviewReport);
    const reportBuckets = await readBrainBuckets(entitiesDir);
    const projectStateValue: unknown = updatedLatest.project_state;
    const projectState: Record<string, unknown> = isRecord(projectStateValue)
      ? projectStateValue
      : {};
    const reportPackageManager =
      typeof projectState.package_manager === 'string' ? projectState.package_manager : 'unknown';
    const reportStack = asStringArray(projectState.tech_stack);
    const missionControlReport = renderReport({
      projectName: basename(rootDir),
      latest: updatedLatest,
      buckets: reportBuckets,
      relationships: graph.relationships ?? [],
      packageManager: reportPackageManager,
      stack: reportStack,
    });
    await writeVerifiedFile(join(reportsDir, 'index.html'), missionControlReport);

    return {
      ok: true,
      value: {
        rootDir,
        reviewPath: join(entitiesDir, 'reviews.json'),
        reviewEvalPath: join(researchDir, 'review_eval.json'),
        reviewClaimEvidencePath: reviewClaimEvidenceArtifactPath(rootDir),
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
        reviewEval,
        reviewClaimEvidence,
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
    const research = await readExplainResearchArtifacts(rootDir);
    const explainableEntities = [
      ...entitySets.components,
      ...entitySets.services,
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
      research,
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

export async function askProjectQuestion(
  options: AskProjectQuestionOptions,
): Promise<AskProjectQuestionResult> {
  try {
    const rootDir = options.rootDir;
    const parsed = parseAskQuestion(options.question);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    if (!(await hasProjectBrain(rootDir))) {
      return {
        ok: false,
        error: {
          code: 'BRAIN_MISSING',
          message: 'Project brain not found. Run rizz brain, then rerun rizz ask.',
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
    const research = await readExplainResearchArtifacts(rootDir);
    const readiness = askReadinessFromBenchmark(research.benchmarkReady);
    const now = (options.now ?? new Date()).toISOString();

    const answer =
      readiness.status === 'blocked'
        ? buildBlockedAskAnswer({
            now,
            question: options.question,
            intent: parsed.value.intent,
            readiness,
          })
        : buildAskAnswer({
            now,
            question: options.question,
            parsed: parsed.value,
            readiness,
            latest,
            relationships: graph.relationships ?? [],
            entitySets,
            research,
          });
    if (!answer.ok) return { ok: false, error: answer.error };

    const reportsDir = join(rootDir, '.rizz', 'reports');
    await mkdir(reportsDir, { recursive: true });
    const reportPath = join(reportsDir, 'ask.html');
    await writeVerifiedFile(reportPath, renderAskReport(answer.value));

    return {
      ok: true,
      value: {
        rootDir,
        latestPath,
        reportPath,
        answer: safeBrainValue(answer.value) as AskProjectQuestionAnswer,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'ASK_FAILED', message } };
  }
}

type ParsedAskQuestion =
  | { readonly intent: 'read_first' }
  | { readonly intent: 'breaks_if_changed'; readonly target: string }
  | { readonly intent: 'dependents'; readonly target: string }
  | { readonly intent: 'why_exists'; readonly target: string }
  | { readonly intent: 'evidence'; readonly target: string };

function parseAskQuestion(
  question: string,
):
  | { readonly ok: true; readonly value: ParsedAskQuestion }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const trimmed = question.trim();
  if (trimmed === '') {
    return {
      ok: false,
      error: {
        code: 'ASK_QUESTION_REQUIRED',
        message: 'Usage: rizz ask <project-intelligence-question>',
      },
    };
  }

  const normalized = trimmed
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?!.]+$/g, '')
    .trim();
  if (
    normalized === 'what should i read first' ||
    normalized === 'what do i read first' ||
    normalized === 'where should i start' ||
    normalized === 'what should i inspect first'
  ) {
    return { ok: true, value: { intent: 'read_first' } };
  }

  const breaksTarget = askTargetAfterPrefix(normalized, ['what breaks if ', 'what breaks when ']);
  if (breaksTarget !== undefined) {
    const target = stripAskTargetSuffix(breaksTarget, [
      ' is changed',
      ' changes',
      ' changed',
      ' is removed',
      ' removed',
      ' moves',
      ' moved',
    ]);
    return askTargetResult('breaks_if_changed', target);
  }

  const dependentsTarget = askTargetAfterPrefix(normalized, [
    'who depends on ',
    'what depends on ',
    'who uses ',
    'what uses ',
  ]);
  if (dependentsTarget !== undefined) return askTargetResult('dependents', dependentsTarget);

  const whyTarget = askTargetBetween(normalized, 'why does ', ' exist');
  if (whyTarget !== undefined) return askTargetResult('why_exists', whyTarget);
  const whyHereTarget = askTargetBetween(normalized, 'why is ', ' here');
  if (whyHereTarget !== undefined) return askTargetResult('why_exists', whyHereTarget);

  const evidenceTarget = askTargetAfterPrefix(normalized, [
    'what evidence backs ',
    'what evidence supports ',
    'what evidence proves ',
    'evidence for ',
  ]);
  if (evidenceTarget !== undefined) return askTargetResult('evidence', evidenceTarget);

  return {
    ok: false,
    error: {
      code: 'ASK_UNSUPPORTED_QUESTION',
      message:
        'rizz ask only answers Project Intelligence questions over .rizz/brain and .rizz/research. Supported forms: what should I read first; what breaks if <target> changes; who depends on <target>; why does <target> exist; what evidence backs <target>.',
    },
  };
}

function askTargetAfterPrefix(value: string, prefixes: readonly string[]): string | undefined {
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) return value.slice(prefix.length).trim();
  }
  return undefined;
}

function askTargetBetween(value: string, prefix: string, suffix: string): string | undefined {
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return undefined;
  return value.slice(prefix.length, value.length - suffix.length).trim();
}

function stripAskTargetSuffix(value: string, suffixes: readonly string[]): string {
  for (const suffix of suffixes) {
    if (value.endsWith(suffix)) return value.slice(0, value.length - suffix.length).trim();
  }
  return value.trim();
}

function askTargetResult(
  intent: Exclude<AskQuestionIntent, 'read_first'>,
  target: string,
):
  | { readonly ok: true; readonly value: ParsedAskQuestion }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const cleaned = target.trim();
  if (
    cleaned === '' ||
    cleaned === 'this' ||
    cleaned === 'this component' ||
    cleaned === 'this file' ||
    cleaned === 'this flow'
  ) {
    return {
      ok: false,
      error: {
        code: 'ASK_TARGET_REQUIRED',
        message: 'This ask intent needs an explicit component, file, folder, or flow target.',
      },
    };
  }
  return { ok: true, value: { intent, target: cleaned } };
}

function askReadinessFromBenchmark(
  benchmarkReady: Record<string, unknown> | undefined,
): AskReadinessSummary {
  const askReadiness = isRecord(benchmarkReady?.ask_readiness) ? benchmarkReady.ask_readiness : {};
  const rawStatus = recordString(askReadiness, 'status', 'blocked');
  const status = rawStatus === 'ready' || rawStatus === 'limited' ? rawStatus : 'blocked';
  const score = recordNumber(askReadiness, 'score');
  const summary = recordString(
    askReadiness,
    'summary',
    'Ask readiness is missing. Run rizz brain to refresh local Project Intelligence artifacts.',
  );
  const reasons = recordArray(askReadiness, 'reasons')
    .filter((item): item is string => typeof item === 'string')
    .map(safeText);
  const improvements = recordArray(askReadiness, 'next_required_improvements')
    .filter((item): item is string => typeof item === 'string')
    .map(safeText);
  return {
    status,
    score,
    summary: safeText(summary),
    reasons:
      reasons.length > 0
        ? reasons
        : ['Ask readiness is unavailable or blocked by missing local research artifacts.'],
    next_required_improvements:
      improvements.length > 0
        ? improvements
        : ['Run rizz brain and inspect .rizz/research/benchmark_ready.json.'],
  };
}

function buildBlockedAskAnswer(params: {
  readonly now: string;
  readonly question: string;
  readonly intent: AskQuestionIntent;
  readonly readiness: AskReadinessSummary;
}): { readonly ok: true; readonly value: AskProjectQuestionAnswer } {
  return {
    ok: true,
    value: {
      schema_version: 1,
      generated_at: params.now,
      question: safeText(params.question),
      intent: params.intent,
      status: 'blocked',
      answer:
        'Local Project Intelligence ask is blocked by readiness gates, so no repo answer was produced.',
      answer_items: params.readiness.reasons.slice(0, 6),
      confidence: 'uncertain',
      readiness: params.readiness,
      evidence_ids: [],
      evidence_summary: {
        evidence_count: 0,
        records: [],
        redacted_evidence_count: 0,
      },
      unknowns: unique([
        ...params.readiness.reasons,
        ...params.readiness.next_required_improvements,
      ]).slice(0, 10),
      related_entities: [],
      research_artifacts: ['.rizz/research/benchmark_ready.json'],
      deterministic: true,
      provider_calls_required: false,
      network_required: false,
    },
  };
}

function buildAskAnswer(params: {
  readonly now: string;
  readonly question: string;
  readonly parsed: ParsedAskQuestion;
  readonly readiness: AskReadinessSummary;
  readonly latest: Record<string, unknown>;
  readonly relationships: readonly BrainRelationship[];
  readonly entitySets: Awaited<ReturnType<typeof readExplainEntitySets>>;
  readonly research: ExplainResearchArtifacts;
}):
  | { readonly ok: true; readonly value: AskProjectQuestionAnswer }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (params.parsed.intent === 'read_first') {
    return {
      ok: true,
      value: buildReadFirstAskAnswer({
        now: params.now,
        question: params.question,
        readiness: params.readiness,
        latest: params.latest,
        entitySets: params.entitySets,
      }),
    };
  }

  const explainableEntities = [
    ...params.entitySets.components,
    ...params.entitySets.services,
    ...params.entitySets.flows,
    ...params.entitySets.files,
    ...params.entitySets.folders,
  ];
  const resolved = resolveExplainTarget(params.parsed.target, explainableEntities);
  if (!resolved.ok) {
    return {
      ok: false,
      error: {
        code: resolved.error.code.replace('EXPLAIN_', 'ASK_'),
        message: resolved.error.message,
      },
    };
  }
  const explanation = buildExplanation({
    now: params.now,
    query: params.parsed.target,
    target: resolved.value,
    latest: params.latest,
    relationships: params.relationships,
    entitySets: params.entitySets,
    research: params.research,
  });
  return {
    ok: true,
    value: buildTargetAskAnswer({
      now: params.now,
      question: params.question,
      intent: params.parsed.intent,
      readiness: params.readiness,
      explanation,
    }),
  };
}

function buildReadFirstAskAnswer(params: {
  readonly now: string;
  readonly question: string;
  readonly readiness: AskReadinessSummary;
  readonly latest: Record<string, unknown>;
  readonly entitySets: Awaited<ReturnType<typeof readExplainEntitySets>>;
}): AskProjectQuestionAnswer {
  const understandingScore = isRecord(params.latest.latest_understanding_score)
    ? params.latest.latest_understanding_score
    : {};
  const readFirstPointers = recordArray(understandingScore, 'read_first')
    .filter(isRecord)
    .slice(0, 8);
  const pointerItems = readFirstPointers.map((pointer) => {
    const path = recordString(pointer, 'path', 'unknown path');
    const reason = recordString(pointer, 'reason', 'Read this first.');
    const componentId = recordString(pointer, 'component_id', 'unknown component');
    return `${path} - ${reason} (${componentId})`;
  });
  const fallbackItems = params.entitySets.components
    .flatMap((component) => stringArrayData(component, 'read_first'))
    .slice(0, 8);
  const answerItems = unique(pointerItems.length > 0 ? pointerItems : fallbackItems).slice(0, 8);
  const relatedEntities = unique(
    readFirstPointers
      .map((pointer) => recordString(pointer, 'component_id', ''))
      .filter((item) => item !== ''),
  );
  const relatedComponents =
    relatedEntities.length > 0
      ? params.entitySets.components.filter((component) => relatedEntities.includes(component.id))
      : params.entitySets.components.slice(0, 4);
  const evidenceIds = unique(relatedComponents.flatMap((component) => component.evidence_ids));
  const evidenceSummary = askEvidenceSummary({
    evidenceIds,
    evidence: params.entitySets.evidence,
  });
  const unknowns = [
    ...(answerItems.length === 0
      ? ['No read-first pointers are recorded yet. Run rizz brain after adding source evidence.']
      : []),
    ...(params.readiness.status === 'limited' ? params.readiness.reasons.slice(0, 4) : []),
  ];
  return {
    schema_version: 1,
    generated_at: params.now,
    question: safeText(params.question),
    intent: 'read_first',
    status: params.readiness.status === 'limited' ? 'limited' : 'answered',
    answer:
      answerItems.length === 0
        ? 'No deterministic read-first answer is available yet.'
        : 'Read these local Project Intelligence pointers first.',
    answer_items: answerItems.map(safeText),
    confidence: askConfidence(
      answerItems.length === 0
        ? 'uncertain'
        : relatedComponents.length > 0
          ? 'inferred'
          : 'uncertain',
      params.readiness.status,
    ),
    readiness: params.readiness,
    evidence_ids: evidenceIds.map(safeText),
    evidence_summary: evidenceSummary,
    unknowns: unique(unknowns).slice(0, 10).map(safeText),
    related_entities: relatedEntities.map(safeText),
    research_artifacts: [
      '.rizz/brain/latest.json',
      '.rizz/research/understanding_score.json',
      '.rizz/research/evidence_quality.json',
      '.rizz/research/benchmark_ready.json',
    ],
    deterministic: true,
    provider_calls_required: false,
    network_required: false,
  };
}

function buildTargetAskAnswer(params: {
  readonly now: string;
  readonly question: string;
  readonly intent: Exclude<AskQuestionIntent, 'read_first'>;
  readonly readiness: AskReadinessSummary;
  readonly explanation: ExplainSummaryData;
}): AskProjectQuestionAnswer {
  const explanation = params.explanation;
  const answerItems = targetAskAnswerItems(params.intent, explanation);
  const unknowns = unique([
    ...(answerItems.length === 0
      ? [`No ${params.intent} facts are recorded for this target.`]
      : []),
    ...explanation.unknowns,
    ...explanation.evidence_gaps,
    ...(params.readiness.status === 'limited' ? params.readiness.reasons.slice(0, 4) : []),
  ]).slice(0, 12);
  const relatedEntities = unique([
    explanation.resolved_entity_id,
    ...explanation.related_components,
    ...explanation.related_flows,
    ...explanation.depends_on.map((item) => relationshipEntityLabel(item)),
    ...explanation.depended_on_by.map((item) => relationshipEntityLabel(item)),
  ]).filter((item) => item !== '');
  return {
    schema_version: 1,
    generated_at: params.now,
    question: safeText(params.question),
    intent: params.intent,
    status: params.readiness.status === 'limited' ? 'limited' : 'answered',
    answer: targetAskAnswerSummary(params.intent, explanation, answerItems.length),
    answer_items: answerItems.map(safeText),
    confidence: askConfidence(explanation.confidence, params.readiness.status),
    readiness: params.readiness,
    evidence_ids: explanation.evidence_ids.map(safeText),
    evidence_summary: {
      evidence_count: explanation.evidence_summary.evidence_count,
      records: explanation.evidence_summary.records.map((record) => ({
        id: safeText(record.id),
        description: safeText(record.description),
        confidence: record.confidence,
        source_files: record.source_files.map(safeText),
      })),
      redacted_evidence_count: explanation.evidence_summary.redacted_evidence_count,
    },
    unknowns: unknowns.map(safeText),
    related_entities: relatedEntities.map(safeText),
    research_artifacts: unique([
      '.rizz/brain/latest.json',
      '.rizz/brain/graph.json',
      '.rizz/research/benchmark_ready.json',
      ...explanation.research_artifacts.proving,
      ...explanation.research_artifacts.limiting,
      ...(params.intent === 'breaks_if_changed' || params.intent === 'dependents'
        ? ['.rizz/research/architecture_reasoning.json']
        : []),
    ]),
    deterministic: true,
    provider_calls_required: false,
    network_required: false,
  };
}

function targetAskAnswerItems(
  intent: Exclude<AskQuestionIntent, 'read_first'>,
  explanation: ExplainSummaryData,
): readonly string[] {
  switch (intent) {
    case 'breaks_if_changed':
      return explanation.breaks_if_changed;
    case 'dependents':
      return unique([...explanation.consumers, ...explanation.depended_on_by]);
    case 'why_exists':
      return unique([
        explanation.purpose,
        ...explanation.responsibilities.slice(0, 5),
        ...explanation.tradeoffs.slice(0, 3),
      ]);
    case 'evidence':
      return explanation.evidence_summary.records.map(
        (record) => `${record.id}: ${record.description}`,
      );
  }
}

function targetAskAnswerSummary(
  intent: Exclude<AskQuestionIntent, 'read_first'>,
  explanation: ExplainSummaryData,
  itemCount: number,
): string {
  if (itemCount === 0) {
    return `No deterministic ${intent} answer is recorded for ${explanation.resolved_entity_id}.`;
  }
  switch (intent) {
    case 'breaks_if_changed':
      return `Changing ${explanation.resolved_entity_id} may affect the recorded breakage surfaces below.`;
    case 'dependents':
      return `These recorded consumers or inbound dependency edges depend on ${explanation.resolved_entity_id}.`;
    case 'why_exists':
      return `${explanation.resolved_entity_id} exists for the purpose and responsibilities below.`;
    case 'evidence':
      return `These local evidence records back ${explanation.resolved_entity_id}.`;
  }
}

function relationshipEntityLabel(label: string): string {
  const marker = ': ';
  const index = label.indexOf(marker);
  return index === -1 ? label : label.slice(index + marker.length);
}

function askConfidence(
  base: Confidence,
  readinessStatus: AskReadinessSummary['status'],
): Confidence {
  if (readinessStatus === 'blocked') return 'uncertain';
  if (readinessStatus === 'limited' && base === 'verified') return 'inferred';
  return base;
}

function askEvidenceSummary(params: {
  readonly evidenceIds: readonly string[];
  readonly evidence: readonly BrainEntity[];
}): AskProjectQuestionAnswer['evidence_summary'] {
  const evidenceById = new Map(params.evidence.map((entity) => [entity.id, entity]));
  const safeEvidenceIds = unique(params.evidenceIds.map(safeText));
  return {
    evidence_count: safeEvidenceIds.length,
    records: safeEvidenceIds.slice(0, 12).map((id) => {
      const evidence = evidenceById.get(id);
      if (evidence === undefined) {
        return {
          id,
          description: 'Evidence reference was recorded, but the evidence entity was not found.',
          confidence: 'uncertain' as const,
          source_files: [],
        };
      }
      return {
        id: safeText(evidence.id),
        description: safeText(evidence.description),
        confidence: evidence.confidence,
        source_files: evidence.source_files.map(safeText),
      };
    }),
    redacted_evidence_count: redactedReferenceCount(safeEvidenceIds),
  };
}

function renderAskReport(answer: AskProjectQuestionAnswer): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>rizz ask · ${htmlEscape(answer.intent)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f1115; --panel: #171b22; --text: #f4f6fb; --muted: #a7b0c0; --line: #2b3340; --accent: #6ee7b7; --warn: #fbbf24; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
    header { border-bottom: 1px solid var(--line); margin-bottom: 24px; padding-bottom: 18px; }
    h1 { font-size: clamp(30px, 5vw, 48px); margin: 0 0 8px; letter-spacing: 0; }
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
      <p class="badge">rizz ask · local Project Intelligence</p>
      <h1>${htmlEscape(answer.intent)}</h1>
      <p>${htmlEscape(answer.question)}</p>
      <p class="muted">${htmlEscape(answer.status)} · ${htmlEscape(answer.confidence)} · readiness ${answer.readiness.score}/100 ${htmlEscape(answer.readiness.status)} · generated ${htmlEscape(answer.generated_at)}</p>
    </header>
    <section class="card"><h2>Answer</h2><p>${htmlEscape(answer.answer)}</p>${renderList(answer.answer_items)}</section>
    <section class="grid">
      <article class="card"><h2>Readiness Gate</h2>${renderList([
        answer.readiness.summary,
        ...answer.readiness.reasons,
      ])}</article>
      <article class="card"><h2>Improve</h2>${renderList(answer.readiness.next_required_improvements)}</article>
      <article class="card"><h2>Unknowns</h2>${renderList(answer.unknowns)}</article>
      <article class="card"><h2>Related Entities</h2>${renderList(answer.related_entities)}</article>
      <article class="card"><h2>Evidence Summary</h2>${renderList([
        `${answer.evidence_summary.evidence_count} evidence reference(s)`,
        `${answer.evidence_summary.redacted_evidence_count} redacted evidence reference(s)`,
        ...answer.evidence_summary.records.map((record) => `${record.id}: ${record.description}`),
      ])}</article>
      <article class="card"><h2>Research Artifacts</h2>${renderArtifactLinks(answer.research_artifacts)}</article>
      <article class="card"><h2>Evidence IDs</h2>${renderList(answer.evidence_ids)}</article>
    </section>
  </main>
</body>
</html>
`;
}

async function readExplainEntitySets(entitiesDir: string): Promise<{
  readonly files: readonly BrainEntity[];
  readonly folders: readonly BrainEntity[];
  readonly components: readonly BrainEntity[];
  readonly services: readonly BrainEntity[];
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
    services,
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
    readEntityFile(entitiesDir, 'services.json'),
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
    services,
    flows,
    configs,
    commands,
    tests,
    dependencies,
    risks,
    evidence,
  };
}

async function readExplainResearchArtifacts(rootDir: string): Promise<ExplainResearchArtifacts> {
  const researchDir = join(rootDir, '.rizz', 'research');
  const evidenceQualityPath = join(researchDir, RESEARCH_ARTIFACT_FILES.evidenceQuality);
  const benchmarkReadyPath = join(researchDir, RESEARCH_ARTIFACT_FILES.benchmarkReady);
  const benchmarkTasksPath = join(researchDir, RESEARCH_ARTIFACT_FILES.benchmarkTasks);
  const available = await Promise.all(
    Object.values(RESEARCH_ARTIFACT_FILES).map(async (fileName) => {
      const relativePath = `.rizz/research/${fileName}`;
      return (await exists(join(researchDir, fileName))) ? relativePath : undefined;
    }),
  );
  return {
    evidenceQuality: await readJsonFile<Record<string, unknown>>(evidenceQualityPath),
    benchmarkReady: await readJsonFile<Record<string, unknown>>(benchmarkReadyPath),
    benchmarkTasks: await readJsonFile<Record<string, unknown>>(benchmarkTasksPath),
    availablePaths: available.filter((path): path is string => path !== undefined).map(safeText),
  };
}

function resolveExplainTarget(
  target: string,
  entities: readonly BrainEntity[],
):
  | { readonly ok: true; readonly value: BrainEntity }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const hint = explainTypeHint(target);
  const query = normalizeExplainQuery(hint.query);
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
    .map((entity) => ({ entity, score: explainMatchScore(query, entity, hint.preferredType) }))
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

function explainTypeHint(target: string): {
  readonly query: string;
  readonly preferredType?: EntityType;
} {
  const trimmed = target.trim();
  const match = /^(component|flow|file|folder|service)\s+(.+)$/i.exec(trimmed);
  if (match === null) return { query: trimmed };
  const preferredType = match[1]?.toLowerCase() as EntityType | undefined;
  const query = match[2] ?? '';
  return preferredType === undefined ? { query } : { query, preferredType };
}

function normalizeExplainQuery(value: string): string {
  const cleaned = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '');
  const classification = classifySensitivePath(cleaned);
  return (classification.isSensitive ? classification.redactedId : cleaned).toLowerCase();
}

function explainTypeBonus(entityType: EntityType, preferredType: EntityType | undefined): number {
  if (preferredType !== undefined) return entityType === preferredType ? 20 : 0;
  if (entityType === 'component') return 5;
  if (entityType === 'folder') return 4;
  return 3;
}

function explainMatchScore(
  query: string,
  entity: BrainEntity,
  preferredType: EntityType | undefined,
): number {
  const name = normalizeExplainQuery(entity.name);
  const id = normalizeExplainQuery(entity.id);
  const relativePath = normalizeExplainQuery(stringData(entity, 'relativePath') ?? '');
  const sources = entity.source_files.map(normalizeExplainQuery);
  const slug = stableSlug(query);
  const typeBonus = explainTypeBonus(entity.type, preferredType);

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
  readonly research: ExplainResearchArtifacts;
}): ExplainSummaryData {
  const target = params.target;
  if (target.type === 'flow') return buildFlowExplanation(params);

  const relatedComponents = relatedComponentContext(target, params.entitySets.components);
  const primaryComponent = target.type === 'component' ? target : relatedComponents[0];
  const relationshipContext = explainRelationshipContext(target, params.relationships);
  const componentData = primaryComponent?.data ?? {};
  const targetData = target.data ?? {};
  const primaryService = target.type === 'service' ? target : undefined;
  const relatedFlows = relatedFlowContext(target, params.entitySets.flows);
  const relatedComponentIds = unique([
    ...relatedComponents.map((component) => component.id),
    ...(primaryService === undefined
      ? []
      : serviceDataStringArray(primaryService, 'related_components')),
    ...relationshipContext.dependsOnEntityIds.filter((id) => id.startsWith('component:')),
    ...relationshipContext.dependedOnByEntityIds.filter((id) => id.startsWith('component:')),
  ]);
  const purpose =
    (primaryService === undefined
      ? undefined
      : `${safeText(primaryService.name)} is a ${stringData(primaryService, 'framework') ?? 'unknown'} service inferred from local source evidence. It participates in ${serviceDataStringArray(primaryService, 'related_flows').length} reconstructed flow(s).`) ??
    stringData(target, 'purpose') ??
    (typeof componentData.purpose === 'string' ? componentData.purpose : undefined) ??
    target.description;
  const serviceResponsibilities =
    primaryService === undefined
      ? []
      : unique([
          ...serviceDataStringArray(primaryService, 'routes').map(
            (route) => `Handle route ${route}.`,
          ),
          ...serviceDataStringArray(primaryService, 'jobs').map((job) => `Run job/script ${job}.`),
          ...serviceDataStringArray(primaryService, 'storage_dependencies').map(
            (storage) => `Use storage dependency ${storage}.`,
          ),
          ...serviceDataStringArray(primaryService, 'external_services').map(
            (api) => `Call external service/API ${api}.`,
          ),
        ]);
  const responsibilities = explainArray(
    targetData.responsibilities,
    componentData.responsibilities,
    serviceResponsibilities,
  );
  const dependencies = unique([
    ...explainArray(targetData.dependencies, componentData.dependencies),
    ...relationshipContext.dependsOn,
  ]);
  const dependencyRoles = explainArray(targetData.dependency_roles, componentData.dependency_roles);
  const serviceDependencyRoles =
    primaryService === undefined
      ? []
      : unique([
          ...serviceDataStringArray(primaryService, 'storage_dependencies').map(
            (storage) => `${storage}: storage/state dependency`,
          ),
          ...serviceDataStringArray(primaryService, 'environment_variables').map(
            (envVar) => `${envVar}: environment configuration`,
          ),
          ...serviceDataStringArray(primaryService, 'external_services').map(
            (api) => `${api}: external API dependency`,
          ),
        ]);
  const consumers = unique([
    ...explainArray(targetData.consumers, componentData.consumers),
    ...relationshipContext.dependedOnBy,
  ]);
  const importantFiles = unique([
    ...explainArray(targetData.important_files, componentData.important_files),
    ...target.source_files,
  ]).slice(0, 12);
  const entryPoints = unique([
    ...explainArray(targetData.entry_points, componentData.entry_points),
    ...(primaryService === undefined ? [] : serviceDataStringArray(primaryService, 'entrypoints')),
  ]).slice(0, 12);
  const tests = unique([
    ...explainArray(targetData.tests, componentData.tests),
    ...relatedTestPaths(target, params.entitySets.tests),
  ]);
  const configs = unique([
    ...explainArray(targetData.configs, componentData.configs),
    ...relatedConfigPaths(target, params.entitySets.configs),
    ...(primaryService === undefined
      ? []
      : serviceDataStringArray(primaryService, 'deployment_configs')),
  ]);
  const breaksIfChanged = unique([
    ...explainArray(targetData.what_breaks_if_removed, componentData.what_breaks_if_removed),
    ...relationshipContext.dependedOnBy.map((item) => `Dependent entity may need review: ${item}.`),
  ]);
  const tradeoffs = explainArray(targetData.tradeoffs, componentData.tradeoffs);
  const failureModes = explainArray(targetData.failure_modes, componentData.failure_modes);
  const risks = unique([
    ...explainArray(targetData.known_risks, componentData.known_risks),
    ...(primaryService === undefined ? [] : serviceDataStringArray(primaryService, 'risks')),
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
  const evidenceSummary = explainEvidenceSummary({
    evidenceIds,
    entities: [target, ...(primaryComponent === undefined ? [] : [primaryComponent])],
    evidence: params.entitySets.evidence,
  });
  const benchmarkTaskHints = explainBenchmarkTaskHints({
    targetIds: unique([target.id, ...relatedComponentIds, ...relatedFlows.map((flow) => flow.id)]),
    benchmarkTasks: params.research.benchmarkTasks,
  });
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
    dependency_roles: unique([...dependencyRoles, ...serviceDependencyRoles]).map(safeText),
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
    confidence_basis: explainConfidenceBasis({
      confidence,
      evidenceSummary,
      unknowns,
    }),
    unknowns: unique([
      ...unknowns,
      ...explainArray(targetData.unknowns, componentData.unknowns),
    ]).map(safeText),
    evidence_summary: evidenceSummary,
    evidence_gaps: explainEvidenceGaps({
      targetIds: unique([
        target.id,
        ...relatedComponentIds,
        ...relatedFlows.map((flow) => flow.id),
      ]),
      evidenceQuality: params.research.evidenceQuality,
    }),
    related_components: relatedComponentIds.map(safeText),
    related_flows: relatedFlows.map((flow) => safeText(flow.id)),
    benchmark_task_hints: benchmarkTaskHints,
    research_artifacts: explainResearchArtifactsForTarget({
      entityType: target.type,
      benchmarkTaskHints,
      availablePaths: params.research.availablePaths,
    }),
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
    ...(primaryService !== undefined
      ? {
          service: {
            runtime: safeText(stringData(primaryService, 'runtime') ?? 'unknown'),
            framework: safeText(stringData(primaryService, 'framework') ?? 'unknown'),
            service_root: safeText(
              stringData(primaryService, 'service_root') ?? primaryService.name,
            ),
            entrypoints: serviceDataStringArray(primaryService, 'entrypoints'),
            routes: serviceDataStringArray(primaryService, 'routes'),
            jobs: serviceDataStringArray(primaryService, 'jobs'),
            storage_dependencies: serviceDataStringArray(primaryService, 'storage_dependencies'),
            environment_variables: serviceDataStringArray(primaryService, 'environment_variables'),
            external_services: serviceDataStringArray(primaryService, 'external_services'),
            deployment_configs: serviceDataStringArray(primaryService, 'deployment_configs'),
            related_flows: serviceDataStringArray(primaryService, 'related_flows'),
            related_components: serviceDataStringArray(primaryService, 'related_components'),
            confidence_score:
              numberData(primaryService, 'confidence_score') ??
              confidenceScoreForValue(primaryService.confidence),
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
  readonly research: ExplainResearchArtifacts;
}): ExplainSummaryData {
  const target = params.target;
  const relationshipContext = explainRelationshipContext(target, params.relationships);
  const entrypoints = safeFlowEntrypoints(target);
  const steps = safeFlowSteps(target);
  const journey = flowJourneySummaryData(target);
  const journeySteps = safeFlowJourneySteps(target);
  const serviceCausality = safeFlowServiceCausality(target);
  const dataDependencies = safeFlowDataDependencies(target);
  const flowRisksForTarget = safeFlowRisks(target);
  const components = flowStringArray(target, 'components').map(safeText);
  const services = flowStringArray(target, 'services').map(safeText);
  const files = unique([...flowStringArray(target, 'files'), ...target.source_files]).map(safeText);
  const dependencies = flowStringArray(target, 'dependencies').map(safeText);
  const runtimeSurfaces = flowStringArray(target, 'runtime_surfaces').map(safeText);
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
  const relatedComponentIds = unique([
    ...components,
    ...relationshipContext.dependsOnEntityIds.filter((id) => id.startsWith('component:')),
    ...relationshipContext.dependedOnByEntityIds.filter((id) => id.startsWith('component:')),
  ]);
  const relatedFlowIds = unique([target.id]);
  const evidenceIds = unique([
    ...target.evidence_ids,
    ...entrypoints.flatMap((entrypoint) => entrypoint.evidence),
    ...steps.flatMap((step) => step.evidence),
    ...serviceCausality.flatMap((item) => item.evidence_ids),
    ...dataDependencies.flatMap((dependency) => dependency.evidence_ids),
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
  const evidenceSummary = explainEvidenceSummary({
    evidenceIds,
    entities: [target],
    evidence: params.entitySets.evidence,
  });
  const benchmarkTaskHints = explainBenchmarkTaskHints({
    targetIds: relatedFlowIds,
    benchmarkTasks: params.research.benchmarkTasks,
  });

  return {
    generated_at: params.now,
    target: safeText(params.query),
    resolved_entity_id: safeText(target.id),
    entity_type: target.type,
    summary: safeText(target.description),
    purpose: `${safeText(target.name)} is a ${flowKind(
      target,
    )} flow reconstructed from local static evidence. ${
      journey === undefined ? '' : `Journey name: ${journey.name}. `
    }It is not a runtime trace.`,
    responsibilities: unique([
      ...(journey === undefined
        ? []
        : [`Explains the ${journey.name} with ${journeySteps.length} normalized journey step(s).`]),
      `Connects ${entrypoints.length} entrypoint(s) to ${steps.length} evidence-backed step(s).`,
      `Covers ${components.length} component(s), ${services.length} service(s), ${runtimeSurfaces.length} runtime surface(s), ${dataDependencies.length} state/data dependency signal(s), ${files.length} file(s), ${tests.length} test artifact(s), and ${configs.length} config artifact(s).`,
      ...serviceCausality.map((item) => item.cause),
      ...dataDependencies.map(
        (dependency) =>
          `Tracks ${dependency.label} as ${dependency.kind} evidence with ${dependency.operations.join(', ') || 'unknown'} operation signal(s).`,
      ),
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
      ...dataDependencies.flatMap((dependency) =>
        dependency.operations.map(
          (operation) => `${dependency.label} ${operation} behavior may affect this flow.`,
        ),
      ),
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
    confidence_basis: explainConfidenceBasis({
      confidence: target.confidence,
      evidenceSummary,
      unknowns: flowUnknowns,
    }),
    unknowns: flowUnknowns.map(safeText),
    evidence_summary: evidenceSummary,
    evidence_gaps: explainEvidenceGaps({
      targetIds: unique([...relatedFlowIds, ...relatedComponentIds]),
      evidenceQuality: params.research.evidenceQuality,
    }),
    related_components: relatedComponentIds.map(safeText),
    related_flows: relatedFlowIds.map(safeText),
    benchmark_task_hints: benchmarkTaskHints,
    research_artifacts: explainResearchArtifactsForTarget({
      entityType: target.type,
      benchmarkTaskHints,
      availablePaths: params.research.availablePaths,
    }),
    flow: {
      kind: flowKind(target),
      ...(journey !== undefined ? { journey } : {}),
      journey_steps: journeySteps,
      ...(framework !== undefined ? { framework: safeText(framework) } : {}),
      ...(routePath !== undefined ? { route_path: safeText(routePath) } : {}),
      ...(routeType !== undefined ? { route_type: safeText(routeType) } : {}),
      entrypoints,
      steps,
      components,
      services,
      service_causality: serviceCausality,
      data_dependencies: dataDependencies,
      files,
      dependencies,
      runtime_surfaces: runtimeSurfaces,
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

function formatFlowServiceCausality(item: FlowServiceCausality): string {
  const effects = item.effects.length === 0 ? 'no effects recorded yet' : item.effects.join(', ');
  return `${item.service_id}: ${item.cause} Effects: ${effects}. Confidence: ${item.confidence}.`;
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
  readonly dependsOnEntityIds: readonly string[];
  readonly dependedOnByEntityIds: readonly string[];
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
    dependsOnEntityIds: unique(outbound.map((rel) => rel.to)),
    dependedOnByEntityIds: unique(inbound.map((rel) => rel.from)),
    evidenceIds: unique([...outbound, ...inbound].flatMap((rel) => rel.evidence_ids)),
  };
}

function relatedFlowContext(
  target: BrainEntity,
  flows: readonly BrainEntity[],
): readonly BrainEntity[] {
  if (target.type === 'flow') return [target];
  if (target.type === 'service') {
    const relatedFlowIds = new Set(serviceDataStringArray(target, 'related_flows'));
    return sorted(
      flows.filter(
        (flow) =>
          relatedFlowIds.has(flow.id) || flowStringArray(flow, 'services').includes(target.id),
      ),
      (flow) => flow.id,
    );
  }
  const relatedSourceFiles = new Set([stringData(target, 'relativePath') ?? target.name]);
  for (const file of target.source_files) relatedSourceFiles.add(file);
  return sorted(
    flows.filter((flow) => {
      const flowComponents = stringArrayData(flow, 'components');
      if (flowComponents.includes(target.id)) return true;
      for (const sourceFile of flow.source_files) {
        if (relatedSourceFiles.has(sourceFile)) return true;
        if (target.type === 'folder' && sourceFile.startsWith(`${target.name}/`)) return true;
      }
      return false;
    }),
    (flow) => flow.id,
  );
}

function explainEvidenceSummary(params: {
  readonly evidenceIds: readonly string[];
  readonly entities: readonly BrainEntity[];
  readonly evidence: readonly BrainEntity[];
}): ExplainSummaryData['evidence_summary'] {
  const safeEvidenceIds = unique(params.evidenceIds.map(safeText));
  const evidenceById = new Map(params.evidence.map((entity) => [entity.id, entity]));
  const fieldEvidence = unique(
    params.entities.flatMap((entity) =>
      Object.entries(recordStringArrayData(entity, 'field_evidence')).flatMap(([field, ids]) =>
        ids.map((id) => `${field}: ${id}`),
      ),
    ),
  ).map(safeText);
  const records = safeEvidenceIds.slice(0, 12).map((id) => {
    const evidence = evidenceById.get(id);
    if (evidence === undefined) {
      return {
        id,
        label: id,
        description: 'Evidence reference was recorded, but the evidence entity was not found.',
        confidence: 'uncertain' as const,
        source_files: [],
      };
    }
    const kind = stringData(evidence, 'kind');
    return {
      id: safeText(evidence.id),
      label: safeText(evidence.name),
      description: safeText(evidence.description),
      confidence: evidence.confidence,
      source_files: evidence.source_files.map(safeText),
      ...(kind === undefined ? {} : { kind: safeText(kind) }),
    };
  });
  return {
    evidence_count: safeEvidenceIds.length,
    direct_evidence_ids: safeEvidenceIds,
    field_evidence: fieldEvidence,
    records,
    redacted_evidence_count: redactedReferenceCount(safeEvidenceIds),
  };
}

function explainConfidenceBasis(params: {
  readonly confidence: Confidence;
  readonly evidenceSummary: ExplainSummaryData['evidence_summary'];
  readonly unknowns: readonly string[];
}): readonly string[] {
  const basis = [
    `${params.evidenceSummary.evidence_count} direct evidence reference(s) support this explanation.`,
    `${params.evidenceSummary.field_evidence.length} field-level evidence reference(s) support specific claims.`,
  ];
  if (params.confidence === 'verified') {
    basis.push('Confidence is verified from local brain evidence.');
  } else {
    basis.push(`Confidence is ${params.confidence}; use unknowns and evidence gaps as limits.`);
  }
  if (params.unknowns.length > 0) {
    basis.push(`${params.unknowns.length} unknown or confidence-limiting note(s) remain.`);
  }
  return basis.map(safeText);
}

function explainEvidenceGaps(params: {
  readonly targetIds: readonly string[];
  readonly evidenceQuality: Record<string, unknown> | undefined;
}): readonly string[] {
  if (params.evidenceQuality === undefined) {
    return ['Evidence quality artifact is missing. Run rizz brain to refresh local research.'];
  }
  const targetIds = new Set(params.targetIds);
  const topGaps = recordArray(params.evidenceQuality, 'top_evidence_gaps').filter(isRecord);
  const targetGaps = topGaps.filter((gap) => {
    const id = typeof gap.id === 'string' ? gap.id : '';
    return targetIds.has(id);
  });
  const gaps = targetGaps.length > 0 ? targetGaps : topGaps.slice(0, 3);
  if (gaps.length === 0) {
    return ['No evidence gaps are recorded in .rizz/research/evidence_quality.json.'];
  }
  return gaps
    .slice(0, 6)
    .map((gap) => {
      const id = typeof gap.id === 'string' ? gap.id : 'unknown';
      const field = typeof gap.field === 'string' ? ` ${gap.field}` : '';
      const severity = typeof gap.severity === 'string' ? gap.severity : 'unknown';
      const reason = typeof gap.reason === 'string' ? gap.reason : 'Evidence gap recorded.';
      return `${id}${field} [${severity}]: ${reason}`;
    })
    .map(safeText);
}

function explainBenchmarkTaskHints(params: {
  readonly targetIds: readonly string[];
  readonly benchmarkTasks: Record<string, unknown> | undefined;
}): ExplainSummaryData['benchmark_task_hints'] {
  if (params.benchmarkTasks === undefined) return [];
  const targetIds = new Set(params.targetIds);
  return recordArray(params.benchmarkTasks, 'tasks')
    .filter(isRecord)
    .filter((task) => {
      const target = isRecord(task.target) ? task.target : undefined;
      const entityId =
        target !== undefined && typeof target.entity_id === 'string' ? target.entity_id : '';
      return targetIds.has(entityId);
    })
    .slice(0, 5)
    .map((task) => ({
      id: typeof task.id === 'string' ? safeText(task.id) : 'task:unknown',
      category: benchmarkTaskCategoryFromValue(task.category),
      prompt: typeof task.prompt === 'string' ? safeText(task.prompt) : '',
      expected_artifact:
        typeof task.expected_artifact === 'string' ? safeText(task.expected_artifact) : '',
      expected_check_fields: asStringArray(task.expected_check_fields).map(safeText),
      confidence: confidenceFromValue(task.confidence),
      why_it_matters: typeof task.why_it_matters === 'string' ? safeText(task.why_it_matters) : '',
    }));
}

function benchmarkTaskCategoryFromValue(value: unknown): BenchmarkTaskCategory {
  if (BENCHMARK_TASK_CATEGORIES.includes(value as BenchmarkTaskCategory)) {
    return value as BenchmarkTaskCategory;
  }
  return 'evidence-unknown-coverage';
}

function explainResearchArtifactsForTarget(params: {
  readonly entityType: EntityType;
  readonly benchmarkTaskHints: readonly { readonly expected_artifact: string }[];
  readonly availablePaths: readonly string[];
}): ExplainSummaryData['research_artifacts'] {
  const available = new Set(params.availablePaths);
  const proving = new Set<string>();
  if (params.entityType === 'flow') {
    proving.add('.rizz/research/flow_understanding.json');
    proving.add('.rizz/research/flow_coverage.json');
    proving.add('.rizz/research/flow_confidence.json');
  } else if (params.entityType === 'service') {
    proving.add('.rizz/research/service_intelligence.json');
    proving.add('.rizz/research/flow_understanding.json');
  } else {
    proving.add('.rizz/research/component_intelligence.json');
  }
  for (const hint of params.benchmarkTaskHints) proving.add(hint.expected_artifact);
  const limiting = new Set([
    '.rizz/research/evidence_quality.json',
    '.rizz/research/confidence.json',
  ]);
  if (params.benchmarkTaskHints.length > 0) {
    proving.add('.rizz/research/benchmark_tasks.json');
  }
  return {
    proving: [...proving].filter((path) => available.has(path)).sort((a, b) => a.localeCompare(b)),
    limiting: [...limiting]
      .filter((path) => available.has(path))
      .sort((a, b) => a.localeCompare(b)),
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
	      <article class="card"><h2>Confidence Basis</h2>${renderList(explanation.confidence_basis)}</article>
	      <article class="card"><h2>Evidence Summary</h2>${renderList([
          `${explanation.evidence_summary.evidence_count} evidence reference(s)`,
          `${explanation.evidence_summary.field_evidence.length} field evidence reference(s)`,
          `${explanation.evidence_summary.redacted_evidence_count} redacted evidence reference(s)`,
          ...explanation.evidence_summary.records.map(
            (record) => `${record.id}: ${record.description}`,
          ),
        ])}</article>
	      <article class="card"><h2>Evidence Gaps</h2>${renderList(explanation.evidence_gaps)}</article>
	      <article class="card"><h2>Related Components</h2>${renderList(explanation.related_components)}</article>
	      <article class="card"><h2>Related Flows</h2>${renderList(explanation.related_flows)}</article>
	      <article class="card"><h2>Benchmark Task Hints</h2>${renderList(
          explanation.benchmark_task_hints.map(
            (task) => `${task.id}: ${task.expected_artifact} - ${task.prompt}`,
          ),
        )}</article>
	      <article class="card"><h2>Research Artifacts</h2>${renderList([
          ...explanation.research_artifacts.proving.map((path) => `Proves: ${path}`),
          ...explanation.research_artifacts.limiting.map((path) => `Limits: ${path}`),
        ])}</article>
	      ${renderComponentExplanationCards(explanation)}
	      ${renderServiceExplanationCards(explanation)}
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

function renderServiceExplanationCards(explanation: ExplainSummaryData): string {
  if (explanation.service === undefined) return '';
  return `<article class="card"><h2>Service Runtime</h2>${renderList([
    `Runtime: ${explanation.service.runtime}`,
    `Framework: ${explanation.service.framework}`,
    `Root: ${explanation.service.service_root}`,
    `Confidence score: ${explanation.service.confidence_score}`,
  ])}</article>
      <article class="card"><h2>Service Routes</h2>${renderList(
        explanation.service.routes,
      )}</article>
      <article class="card"><h2>Service Jobs</h2>${renderList(explanation.service.jobs)}</article>
      <article class="card"><h2>Service Storage</h2>${renderList(
        explanation.service.storage_dependencies,
      )}</article>
      <article class="card"><h2>Service Environment</h2>${renderList(
        explanation.service.environment_variables,
      )}</article>
      <article class="card"><h2>External APIs</h2>${renderList(
        explanation.service.external_services,
      )}</article>
      <article class="card"><h2>Deployment Configs</h2>${renderList(
        explanation.service.deployment_configs,
      )}</article>`;
}

function renderFlowExplanationCards(explanation: ExplainSummaryData): string {
  if (explanation.flow === undefined) return '';
  return `<article class="card"><h2>Journey</h2>${renderList(
    explanation.flow.journey === undefined
      ? ['No semantic journey name was inferred.']
      : [
          `${explanation.flow.journey.name} (${explanation.flow.journey.confidence} · ${explanation.flow.journey.score})`,
          ...explanation.flow.journey.reasons,
          ...explanation.flow.journey.missing_evidence,
        ],
  )}</article>
      <article class="card"><h2>Journey Steps</h2>${renderList(
        explanation.flow.journey_steps.map(formatJourneyStepForReview),
      )}</article>
      <article class="card"><h2>Entry Contract</h2>${renderList(
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
      <article class="card"><h2>State/Data Dependencies</h2>${renderList(
        explanation.flow.data_dependencies.length === 0
          ? ['No state/data dependency signal was linked to this flow.']
          : explanation.flow.data_dependencies.map(formatDataDependencyForReview),
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
      <article class="card"><h2>Flow Services</h2>${renderList(explanation.flow.services)}</article>
      <article class="card"><h2>Runtime Surfaces</h2>${renderList(
        explanation.flow.runtime_surfaces,
      )}</article>
      <article class="card"><h2>Service Causality</h2>${renderList(
        explanation.flow.service_causality.map(formatFlowServiceCausality),
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

async function readBrainBuckets(entitiesDir: string): Promise<BrainBuckets> {
  const entries: Array<readonly [keyof BrainBuckets, BrainEntity[]]> = await Promise.all(
    ENTITY_FILES.map(async ([bucket, fileName]) => {
      const entities = [...(await readEntityFile(entitiesDir, fileName))] as BrainEntity[];
      return [bucket, entities] as readonly [keyof BrainBuckets, BrainEntity[]];
    }),
  );
  const byBucket: Partial<Record<keyof BrainBuckets, BrainEntity[]>> = {};
  for (const [bucket, entities] of entries) {
    byBucket[bucket] = entities;
  }
  return {
    projects: byBucket.projects ?? [],
    files: byBucket.files ?? [],
    folders: byBucket.folders ?? [],
    components: byBucket.components ?? [],
    services: byBucket.services ?? [],
    apis: byBucket.apis ?? [],
    databaseTables: byBucket.databaseTables ?? [],
    configs: byBucket.configs ?? [],
    dependencies: byBucket.dependencies ?? [],
    commands: byBucket.commands ?? [],
    tests: byBucket.tests ?? [],
    flows: byBucket.flows ?? [],
    decisions: byBucket.decisions ?? [],
    risks: byBucket.risks ?? [],
    agents: byBucket.agents ?? [],
    tasks: byBucket.tasks ?? [],
    sessions: byBucket.sessions ?? [],
    handoffs: byBucket.handoffs ?? [],
    reviews: byBucket.reviews ?? [],
    findings: byBucket.findings ?? [],
    evidence: byBucket.evidence ?? [],
    status: byBucket.status ?? [],
  };
}

async function readReviewEntitySets(entitiesDir: string): Promise<{
  readonly files: readonly BrainEntity[];
  readonly components: readonly BrainEntity[];
  readonly services: readonly BrainEntity[];
  readonly flows: readonly BrainEntity[];
  readonly configs: readonly BrainEntity[];
  readonly commands: readonly BrainEntity[];
  readonly tests: readonly BrainEntity[];
  readonly dependencies: readonly BrainEntity[];
  readonly risks: readonly BrainEntity[];
}> {
  const [files, components, services, flows, configs, commands, tests, dependencies, risks] =
    await Promise.all([
      readEntityFile(entitiesDir, 'files.json'),
      readEntityFile(entitiesDir, 'components.json'),
      readEntityFile(entitiesDir, 'services.json'),
      readEntityFile(entitiesDir, 'flows.json'),
      readEntityFile(entitiesDir, 'configs.json'),
      readEntityFile(entitiesDir, 'commands.json'),
      readEntityFile(entitiesDir, 'tests.json'),
      readEntityFile(entitiesDir, 'dependencies.json'),
      readEntityFile(entitiesDir, 'risks.json'),
    ]);
  return { files, components, services, flows, configs, commands, tests, dependencies, risks };
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

function changedPathsFromNameStatusLine(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];
  const parts = trimmed.split(/\t+/).filter((part) => part.trim() !== '');
  if (parts.length === 1) return [parts[0] ?? ''];
  const status = parts[0] ?? '';
  const paths = parts.slice(1);
  if (/^[RC]/.test(status)) return paths;
  return paths.slice(-1);
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

  const worktreeFiles = runGit(rootDir, ['diff', '--name-status', '--find-renames', 'HEAD', '--']);
  if (!worktreeFiles.ok) {
    return { ok: false, error: { code: 'GIT_DIFF_FAILED', message: worktreeFiles.error } };
  }
  const untrackedFiles = runGit(rootDir, ['ls-files', '--others', '--exclude-standard']);
  const worktreeChanged = unique(
    [
      ...worktreeFiles.stdout.split(/\r?\n/),
      ...(untrackedFiles.ok ? untrackedFiles.stdout.split(/\r?\n/) : []),
    ]
      .flatMap(changedPathsFromNameStatusLine)
      .filter((line) => line.trim() !== ''),
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
    const branchFiles = runGit(rootDir, [
      'diff',
      '--name-status',
      '--find-renames',
      baseSha,
      'HEAD',
      '--',
    ]);
    if (!branchFiles.ok) {
      return { ok: false, error: { code: 'GIT_DIFF_FAILED', message: branchFiles.error } };
    }
    const branchChanged = unique(
      branchFiles.stdout
        .split(/\r?\n/)
        .flatMap(changedPathsFromNameStatusLine)
        .filter((line) => line.trim() !== ''),
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

function parseConfidence(value: unknown): Confidence {
  if (value === 'verified' || value === 'inferred' || value === 'uncertain') return value;
  return 'uncertain';
}

function parseCouplingLevel(value: unknown): ComponentIntelligence['coupling']['level'] {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return 'low';
}

function parseArchitectureImpactSurfaceType(value: unknown): ArchitectureImpactSurfaceType {
  if (value === 'route') return 'route';
  return 'component';
}

function parseArchitectureImpactRiskLevel(value: unknown): ArchitectureImpactRiskLevel {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return 'low';
}

function numberRecordValue(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  return typeof item === 'number' ? item : 0;
}

function parseArchitectureImpactRiskReasoning(params: {
  readonly value: unknown;
  readonly entityId: string;
  readonly couplingLevel: ComponentIntelligence['coupling']['level'];
  readonly couplingScore: number;
  readonly affectedFlows: readonly string[];
  readonly affectedTests: readonly string[];
  readonly affectedConfigs: readonly string[];
  readonly dependentComponents: readonly string[];
  readonly confidence: Confidence;
  readonly evidenceGapIds: readonly string[];
}): ArchitectureImpactRiskReasoning {
  if (isRecord(params.value)) {
    return {
      risk_level: parseArchitectureImpactRiskLevel(params.value.risk_level),
      risk_score: numberRecordValue(params.value, 'risk_score'),
      criticality:
        typeof params.value.criticality === 'string'
          ? safeText(params.value.criticality)
          : 'unknown',
      coupling_level: parseCouplingLevel(params.value.coupling_level),
      tradeoffs: asStringArray(params.value.tradeoffs).map(safeText),
      risky_surfaces: asStringArray(params.value.risky_surfaces).map(safeText),
      review_focus: asStringArray(params.value.review_focus).map(safeText),
      reasons: asStringArray(params.value.reasons).map(safeText),
    };
  }
  return architectureImpactRiskReasoning({
    entityId: params.entityId,
    criticality: 'unknown',
    criticalityScore: 0,
    couplingLevel: params.couplingLevel,
    couplingScore: params.couplingScore,
    affectedFlows: params.affectedFlows,
    affectedTests: params.affectedTests,
    affectedConfigs: params.affectedConfigs,
    dependentComponents: params.dependentComponents,
    confidence: params.confidence,
    evidenceGapIds: params.evidenceGapIds,
    tradeoffs: [],
    riskySeams: [],
    serviceCausality: [],
  });
}

function reviewImpactEntryFromRecord(entry: unknown): ReviewArchitectureImpactData | undefined {
  if (!isRecord(entry)) return undefined;
  const impactId = typeof entry.impact_id === 'string' ? safeText(entry.impact_id) : undefined;
  const entityId = typeof entry.entity_id === 'string' ? safeText(entry.entity_id) : undefined;
  const name = typeof entry.name === 'string' ? safeText(entry.name) : undefined;
  if (impactId === undefined || entityId === undefined || name === undefined) return undefined;
  const routePath = typeof entry.route_path === 'string' ? safeText(entry.route_path) : undefined;
  const routeType = typeof entry.route_type === 'string' ? safeText(entry.route_type) : undefined;
  const affectedFlows = asStringArray(entry.affected_flows).map(safeText);
  const affectedTests = asStringArray(entry.affected_tests).map(safeText);
  const affectedConfigs = asStringArray(entry.affected_configs).map(safeText);
  const dependentComponents = asStringArray(entry.dependent_components).map(safeText);
  const couplingLevel = parseCouplingLevel(entry.coupling_level);
  const couplingScore = numberRecordValue(entry, 'coupling_score');
  const confidence = parseConfidence(entry.confidence);
  const evidenceGapIds = asStringArray(entry.evidence_gap_ids).map(safeText);
  return {
    impact_id: impactId,
    surface_type: parseArchitectureImpactSurfaceType(entry.surface_type),
    entity_id: entityId,
    name,
    ...(routePath !== undefined ? { route_path: routePath } : {}),
    ...(routeType !== undefined ? { route_type: routeType } : {}),
    matched_changed_files: [],
    matched_components: [],
    matched_flows: [],
    affected_flows: affectedFlows,
    affected_files: asStringArray(entry.affected_files).map(safeText),
    affected_tests: affectedTests,
    affected_configs: affectedConfigs,
    dependent_components: dependentComponents,
    coupling_level: couplingLevel,
    coupling_score: couplingScore,
    confidence,
    confidence_score: numberRecordValue(entry, 'confidence_score'),
    evidence_ids: asStringArray(entry.evidence_ids).map(safeText),
    evidence_gap_ids: evidenceGapIds,
    what_breaks: asStringArray(entry.what_breaks).map(safeText),
    risk_reasoning: parseArchitectureImpactRiskReasoning({
      value: entry.risk_reasoning,
      entityId,
      couplingLevel,
      couplingScore,
      affectedFlows,
      affectedTests,
      affectedConfigs,
      dependentComponents,
      confidence,
      evidenceGapIds,
    }),
    reasons: asStringArray(entry.reasons).map(safeText),
  };
}

function reviewArchitectureImpactMap(params: {
  readonly latest: Record<string, unknown>;
  readonly changedFiles: readonly string[];
  readonly componentIds: readonly string[];
  readonly flowIds: readonly string[];
}): ReviewArchitectureImpactData[] {
  const architectureReasoning = isRecord(params.latest.latest_architecture_reasoning)
    ? params.latest.latest_architecture_reasoning
    : {};
  const impactMap = isRecord(architectureReasoning.impact_map)
    ? architectureReasoning.impact_map
    : {};
  const changedFileSet = new Set(params.changedFiles);
  const componentIdSet = new Set(params.componentIds);
  const flowIdSet = new Set(params.flowIds);
  return recordArray(impactMap, 'entries')
    .map(reviewImpactEntryFromRecord)
    .filter((entry): entry is ReviewArchitectureImpactData => entry !== undefined)
    .flatMap((entry): ReviewArchitectureImpactData[] => {
      const impactFiles = unique([
        ...entry.affected_files,
        ...entry.affected_tests,
        ...entry.affected_configs,
      ]);
      const matchedChangedFiles = impactFiles.filter((file) => changedFileSet.has(file));
      const matchedComponents = unique(
        [entry.entity_id, ...entry.dependent_components].filter((id) => componentIdSet.has(id)),
      );
      const matchedFlows = entry.affected_flows.filter((id) => flowIdSet.has(id));
      if (
        matchedChangedFiles.length === 0 &&
        matchedComponents.length === 0 &&
        matchedFlows.length === 0
      ) {
        return [];
      }
      return [
        {
          ...entry,
          matched_changed_files: matchedChangedFiles.map(safeText),
          matched_components: matchedComponents.map(safeText),
          matched_flows: matchedFlows.map(safeText),
          reasons: unique([
            ...entry.reasons,
            ...(matchedChangedFiles.length > 0
              ? [`changed_files:${matchedChangedFiles.length}`]
              : []),
            ...(matchedComponents.length > 0
              ? [`matched_components:${matchedComponents.length}`]
              : []),
            ...(matchedFlows.length > 0 ? [`matched_flows:${matchedFlows.length}`] : []),
            ...(entry.confidence !== 'verified' ? [`confidence_gap:${entry.confidence}`] : []),
            ...(entry.evidence_gap_ids.length > 0
              ? [`evidence_gaps:${entry.evidence_gap_ids.length}`]
              : []),
          ]).map(safeText),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.matched_changed_files.length - a.matched_changed_files.length ||
        b.dependent_components.length - a.dependent_components.length ||
        b.coupling_score - a.coupling_score ||
        a.impact_id.localeCompare(b.impact_id),
    )
    .slice(0, 20);
}

function buildReview(params: {
  readonly rootDir: string;
  readonly now: string;
  readonly latest: Record<string, unknown>;
  readonly relationships: readonly BrainRelationship[];
  readonly entitySets: Awaited<ReturnType<typeof readReviewEntitySets>>;
  readonly changedFiles: readonly string[];
  readonly diffText: string;
  readonly verificationEvidence: VerificationEvidenceArtifactData;
}): ReviewSummaryData {
  const changedFiles = params.changedFiles.filter((file) => !shouldSkipRelativePath(file, []));
  const reviewableChangedFiles = changedFiles.filter((file) => !isGeneratedArtifactPath(file));
  const reviewableChangedFileSet = new Set(reviewableChangedFiles);
  const publicChangedFiles = changedFiles.map(safeText);
  const changedGeneratedArtifactFiles = changedFiles.filter(isGeneratedArtifactPath);
  const changedTestFiles = changedFiles.filter((file) => isTestPath(file));
  const changedConfigFiles = changedFiles.filter((file) => isConfigPath(file));
  const changedDependencyFiles = changedFiles.filter((file) => isDependencyPath(file));
  const changedSourceFiles = changedFiles.filter(
    (file) =>
      isSourceFile(file) &&
      !isGeneratedArtifactPath(file) &&
      !isConfigPath(file) &&
      !isDependencyPath(file) &&
      hasRuntimeRelevantSourceDiff(file, params.diffText),
  );
  const affectedComponents = affectedComponentEntities(
    reviewableChangedFiles,
    params.entitySets.components,
  );
  const affectedComponentIds = affectedComponents.map((component) => component.id);
  const dependentComponents = dependentComponentEntities(
    affectedComponentIds,
    params.relationships,
    params.entitySets.components,
  );
  const dependentComponentIds = dependentComponents.map((component) => component.id);
  const allAffectedComponents = uniqueEntities([...affectedComponents, ...dependentComponents]);
  const affectedFlows = affectedFlowEntities(
    reviewableChangedFiles,
    allAffectedComponents,
    params.entitySets.flows,
    params.diffText,
  );
  const affectedServices = affectedServiceEntities({
    changedFiles: reviewableChangedFiles,
    services: params.entitySets.services,
    affectedFlows,
  });
  const affectedFlowIds = affectedFlows.map((flow) => flow.id);
  const affectedServiceIds = affectedServices.map((service) => service.id);
  const architectureImpactMap = reviewArchitectureImpactMap({
    latest: params.latest,
    changedFiles: reviewableChangedFiles,
    componentIds: allAffectedComponents.map((component) => component.id),
    flowIds: affectedFlowIds,
  });
  const architectureImpactComponentIds = unique(
    architectureImpactMap.flatMap((entry) => [
      entry.entity_id,
      ...entry.matched_components,
      ...entry.dependent_components,
    ]),
  );
  const architectureImpactFlowIds = unique(
    architectureImpactMap.flatMap((entry) => [...entry.affected_flows, ...entry.matched_flows]),
  );
  const directlyAffectedEntities = unique([
    ...reviewableChangedFiles.map((file) => entityId('file', file)),
    ...affectedComponentIds,
    ...affectedFlowIds,
    ...affectedServiceIds,
    ...params.entitySets.configs
      .filter((config) => config.source_files.some((file) => reviewableChangedFileSet.has(file)))
      .map((config) => config.id),
    ...params.entitySets.tests
      .filter((test) => test.source_files.some((file) => reviewableChangedFileSet.has(file)))
      .map((test) => test.id),
  ]);
  const affectedEntitySeed = unique([
    ...directlyAffectedEntities,
    ...dependentComponentIds,
    ...affectedFlowIds,
    ...affectedServiceIds,
    ...architectureImpactComponentIds,
    ...architectureImpactFlowIds,
  ]);
  const affectedRelationships = affectedReviewRelationships(
    params.relationships,
    affectedEntitySeed,
    staleReviewEntityIds(params.entitySets),
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
    ...architectureImpactMap.flatMap((entry) => entry.affected_tests),
    ...changedTestFiles,
  ]).map(safeText);
  const affectedConfigs = unique([
    ...affectedFlows.flatMap((flow) => flow.configs),
    ...allAffectedComponents.flatMap((component) => stringArrayData(component, 'configs')),
    ...architectureImpactMap.flatMap((entry) => entry.affected_configs),
    ...changedConfigFiles,
    ...changedDependencyFiles,
  ]).map(safeText);
  const dependencyRuntimeImpact = reviewDependencyRuntimeImpact({
    changedConfigFiles,
    changedDependencyFiles,
    entitySets: params.entitySets,
    directComponents: affectedComponents,
    dependentComponents,
    affectedFlows,
    affectedServices,
    affectedTests,
    affectedConfigs,
    architectureImpactMap,
  });
  const architectureEvidenceGapIds = unique(
    architectureImpactMap.flatMap((entry) => entry.evidence_gap_ids),
  ).map(safeText);
  const architectureConfidenceGaps = architectureImpactMap
    .filter((entry) => entry.confidence !== 'verified')
    .map((entry) => `${entry.impact_id}:${entry.confidence}`);
  const architectureWhatBreaks = unique(
    architectureImpactMap.flatMap((entry) => entry.what_breaks),
  ).map(safeText);
  const architectureRiskReasoning = unique(
    architectureImpactMap.flatMap((entry) => [
      `${entry.impact_id}:${entry.risk_reasoning.risk_level}:${entry.risk_reasoning.risky_surfaces.join(', ') || 'no risky surface flags'}`,
      ...entry.risk_reasoning.review_focus.map((focus) => `${entry.impact_id}:${focus}`),
    ]),
  ).map(safeText);
  const serviceCausalityPaths = affectedFlows.flatMap((flow) => flow.service_causality);
  const serviceCausalityEffects = unique(serviceCausalityPaths.flatMap((item) => item.effects)).map(
    safeText,
  );
  const affectedJourneyNames = unique(
    affectedFlows.flatMap((flow) => (flow.journey_name === undefined ? [] : [flow.journey_name])),
  ).map(safeText);
  const affectedJourneySteps = affectedFlows.flatMap((flow) => flow.affected_steps);
  const testEvidenceChanges = reviewTestEvidenceChanges({
    changedTestFiles,
    affectedFlows,
  });
  const affectedDataDependencies = uniqueBy(
    affectedFlows.flatMap((flow) => flow.data_dependencies),
    (dependency) => dependency.dependency_id,
  );
  const affectedStateOperations = unique(
    affectedDataDependencies.flatMap((dependency) => dependency.operations),
  ).map(safeText);
  const userVisibleFailureModes = unique(
    affectedFlows.flatMap((flow) => flow.user_visible_failure_modes),
  ).map(safeText);
  const journeyMissingEvidence = unique(affectedFlows.flatMap((flow) => flow.missing_evidence)).map(
    safeText,
  );
  const reviewEvidenceIds = unique([
    ...allAffectedComponents.flatMap((component) => component.evidence_ids),
    ...affectedServices.flatMap((service) => service.evidence_ids),
    ...affectedFlows.flatMap((flow) => flow.evidence_ids),
    ...serviceCausalityPaths.flatMap((item) => item.evidence_ids),
    ...affectedRelationships.flatMap((relationship) => relationship.evidence_ids),
    ...architectureImpactMap.flatMap((entry) => entry.evidence_ids),
    ...changedFiles.map(evidenceId),
  ]).map(safeText);
  const blastRadius = classifyReviewBlastRadius({
    fileCount: reviewableChangedFiles.length,
    directComponentCount: affectedComponents.length,
    dependentComponentCount: dependentComponents.length,
    flowCount: affectedFlows.length,
    relationshipCount: affectedRelationships.length,
    architectureImpactSurfaceCount: architectureImpactMap.length,
    highCouplingImpactSurfaceCount: architectureImpactMap.filter(
      (entry) => entry.coupling_level === 'high',
    ).length,
    architectureConfidenceGapCount: architectureConfidenceGaps.length,
  });
  const blastRadiusReasons = blastRadiusReasonLines({
    changedFiles,
    directComponents: affectedComponents,
    dependentComponents,
    affectedFlows,
    affectedServices,
    affectedRelationships,
    architectureImpactMap,
    dependencyRuntimeImpact,
    affectedTests,
    affectedConfigs,
  });
  const verificationStatus = reviewVerificationStatus(params.verificationEvidence);
  const hasLocalVerification = verificationStatus.local_checks_passed.length > 0;

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

  const isBroad = reviewableChangedFiles.length > 8 || affectedComponents.length > 3;
  if (isBroad || blastRadius === 'broad') {
    addFinding({
      slug: 'broad-change',
      severity:
        reviewableChangedFiles.length > 20 ||
        affectedComponents.length > 5 ||
        dependentComponents.length > 3
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
      severity: hasLocalVerification ? 'low' : changedSourceFiles.length > 4 ? 'high' : 'medium',
      category: 'Missing tests',
      title: hasLocalVerification
        ? 'Runtime files changed without new tests, but local checks are recorded'
        : 'Runtime files changed without test artifacts in the diff',
      description: safeText(
        `${changedSourceFiles.length} source file(s) changed, but no test file changed with them. Existing linked test evidence: ${affectedTests.slice(0, 5).join(', ') || 'none detected'}. ${
          hasLocalVerification
            ? `Recorded local checks passed: ${verificationStatus.local_checks_passed.slice(0, 4).join(', ')}.`
            : ''
        }`,
      ),
      affected_files: changedSourceFiles.map(safeText),
      affected_entities: graphAffectedEntities,
      confidence: hasLocalVerification ? 'inferred' : 'verified',
      recommendation: hasLocalVerification
        ? 'Use the recorded checks as local regression evidence, then add focused tests if the behavior changed.'
        : 'Run the existing quality gate and add focused tests for the changed behavior or document why existing coverage is sufficient.',
    });
  }

  if (changedGeneratedArtifactFiles.length > 0) {
    addFinding({
      slug: 'generated-artifacts',
      severity: 'low',
      category: 'Maintainability',
      title: 'Generated or vendor artifacts changed',
      description: safeText(
        `The diff includes ${changedGeneratedArtifactFiles.length} generated/vendor-like artifact(s): ${changedGeneratedArtifactFiles
          .slice(0, 6)
          .join(
            ', ',
          )}. Rizz keeps them visible but does not treat them as authored runtime source or state/data blast radius.`,
      ),
      affected_files: changedGeneratedArtifactFiles.map(safeText),
      affected_entities: unique(
        changedGeneratedArtifactFiles.map((file) => entityId('file', file)),
      ),
      confidence: 'inferred',
      recommendation:
        'Verify the generator, lockfile, or source artifact that produced this output instead of reviewing generated churn as product logic.',
    });
  }

  if (
    changedTestFiles.length > 0 &&
    changedSourceFiles.length === 0 &&
    changedConfigFiles.length === 0 &&
    changedDependencyFiles.length === 0
  ) {
    addFinding({
      slug: 'test-evidence-only',
      severity: 'low',
      category: 'Correctness',
      title: 'Test evidence changed without runtime surface changes',
      description: safeText(
        `The diff updates ${changedTestFiles.length} test artifact(s). Rizz treats this as confidence/evidence movement for affected journeys, not direct runtime behavior change. ${
          testEvidenceChanges.slice(0, 3).join(' ') || ''
        }`,
      ),
      affected_files: changedTestFiles.map(safeText),
      affected_entities: graphAffectedEntities,
      confidence: 'verified',
      recommendation:
        'Use the changed tests to calibrate confidence, and only require runtime blast-radius review if source, config, dependency, or generated source inputs changed.',
    });
  }

  if (changedConfigFiles.length > 0 || changedDependencyFiles.length > 0) {
    const impactDescription =
      dependencyRuntimeImpact === null
        ? 'No local flow, service, component, script, or dependency evidence was linked to these package/config files.'
        : `Runtime/dependency impact links ${dependencyRuntimeImpact.changed_files.length} changed package/config file(s) to ${dependencyRuntimeImpact.affected_flows.length} flow(s), ${dependencyRuntimeImpact.affected_services.length} service(s), ${dependencyRuntimeImpact.affected_components.length} component(s), and ${dependencyRuntimeImpact.package_scripts.length} package script(s). Focused verification: ${
            dependencyRuntimeImpact.verification_focus.slice(0, 4).join('; ') || 'none recorded'
          }.`;
    addFinding({
      slug: 'config-dependency-change',
      severity: changedDependencyFiles.length > 0 ? 'medium' : 'low',
      category: changedDependencyFiles.length > 0 ? 'Backward compatibility' : 'Architecture drift',
      title: 'Configuration or dependency surface changed',
      description: safeText(
        `The diff touches setup, package, build, CI, or dependency metadata. ${impactDescription}`,
      ),
      affected_files: unique([...changedConfigFiles, ...changedDependencyFiles]),
      affected_entities: unique([
        ...graphAffectedEntities,
        ...(dependencyRuntimeImpact?.dependency_entities ?? []),
        ...(dependencyRuntimeImpact?.affected_components ?? []),
        ...(dependencyRuntimeImpact?.affected_services ?? []),
        ...(dependencyRuntimeImpact?.affected_flows ?? []),
      ]),
      confidence: 'verified',
      recommendation:
        dependencyRuntimeImpact === null
          ? 'Verify install, build, and public package contents before merge.'
          : `Verify the linked runtime blast radius before merge: ${dependencyRuntimeImpact.verification_focus
              .slice(0, 5)
              .join('; ')}.`,
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
          .map(reviewFlowDescriptionLabel)
          .slice(0, 5)
          .join(', ')}. Linked tests/configs: ${
          unique([
            ...affectedFlows.flatMap((flow) => flow.tests),
            ...affectedFlows.flatMap((flow) => flow.configs),
          ])
            .slice(0, 6)
            .join(', ') || 'none detected'
        }. User-visible risks: ${
          userVisibleFailureModes.slice(0, 4).join(' ') || 'none recorded'
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

  if (affectedDataDependencies.length > 0) {
    const stateWriteImpact = affectedStateOperations.some((operation) =>
      ['schema', 'write', 'update', 'delete', 'cache', 'session'].includes(operation),
    );
    addFinding({
      slug: 'state-data-impact',
      severity: stateWriteImpact ? 'medium' : 'low',
      category: 'Hidden coupling',
      title: 'State/data dependency overlaps the diff',
      description: safeText(
        `The diff touches ${affectedDataDependencies.length} state/data dependency signal(s): ${affectedDataDependencies
          .map(formatDataDependencyForReview)
          .slice(0, 5)
          .join(' ')} Affected operation(s): ${
          affectedStateOperations.slice(0, 6).join(', ') || 'unknown'
        }.`,
      ),
      affected_files: unique(affectedDataDependencies.flatMap((dependency) => dependency.files)),
      affected_entities: unique([...graphAffectedEntities, ...affectedFlowIds]),
      evidenceIds: unique(
        affectedDataDependencies.flatMap((dependency) => dependency.evidence_ids),
      ),
      confidence: affectedDataDependencies.every(
        (dependency) => dependency.confidence === 'verified',
      )
        ? 'verified'
        : 'inferred',
      recommendation:
        'Verify migrations, repositories, cache/session behavior, and linked journey tests before treating the change as isolated.',
    });
  }

  if (affectedServices.length > 0) {
    addFinding({
      slug: 'affected-services',
      severity: affectedServices.some((service) => service.risks.length > 0) ? 'medium' : 'low',
      category: 'Hidden coupling',
      title: 'Service intelligence overlaps the diff',
      description: safeText(
        `${affectedServices.length} service(s) are affected: ${affectedServices
          .map((service) => service.name)
          .slice(0, 5)
          .join(
            ', ',
          )}. Review routes, flows, storage, env vars, external APIs, deployment configs, and smoke checks before merge.`,
      ),
      affected_files: unique(affectedServices.flatMap((service) => service.changed_files)),
      affected_entities: unique([...graphAffectedEntities, ...affectedServiceIds]),
      evidenceIds: unique(affectedServices.flatMap((service) => service.evidence_ids)),
      confidence: 'inferred',
      recommendation:
        'Open the service explanation and verify affected flows plus storage/auth/CORS/deployment checks when relevant.',
    });
  }

  if (serviceCausalityPaths.length > 0) {
    addFinding({
      slug: 'service-causality',
      severity: serviceCausalityEffects.length > 0 ? 'medium' : 'low',
      category: 'Hidden coupling',
      title: 'Service causality explains affected flow blast radius',
      description: safeText(
        `${serviceCausalityPaths.length} flow-to-service causality path(s) are affected. Effects: ${
          serviceCausalityEffects.slice(0, 6).join(', ') || 'none recorded'
        }.`,
      ),
      affected_files: unique(affectedFlows.flatMap((flow) => flow.changed_files)),
      affected_entities: unique([
        ...affectedFlowIds,
        ...serviceCausalityPaths.map((item) => item.service_id),
      ]),
      evidenceIds: unique(serviceCausalityPaths.flatMap((item) => item.evidence_ids)),
      confidence: serviceCausalityPaths.every((item) => item.confidence === 'verified')
        ? 'verified'
        : 'inferred',
      recommendation:
        'Review the affected flow path, service behavior, and recorded side effects before treating this change as local.',
    });
  }

  if (architectureImpactMap.length > 0) {
    addFinding({
      slug: 'architecture-impact-map',
      severity:
        architectureImpactMap.some((entry) => entry.coupling_level === 'high') ||
        architectureImpactMap.length > 3
          ? 'medium'
          : 'low',
      category: 'Architecture drift',
      title: 'Architecture impact map overlaps the diff',
      description: safeText(
        `${architectureImpactMap.length} impact-map surface(s) connect the diff to likely breakage: ${
          architectureWhatBreaks.slice(0, 3).join(' ') || 'no what-breaks note recorded'
        } Risk reasoning: ${
          architectureRiskReasoning.slice(0, 2).join(' ') || 'no risk reasoning recorded'
        }.`,
      ),
      affected_files: unique(architectureImpactMap.flatMap((entry) => entry.matched_changed_files)),
      affected_entities: unique([...graphAffectedEntities, ...architectureImpactComponentIds]),
      evidenceIds: unique(architectureImpactMap.flatMap((entry) => entry.evidence_ids)),
      confidence: architectureConfidenceGaps.length > 0 ? 'inferred' : 'verified',
      recommendation:
        'Use the matched architecture impact surfaces to review dependent components, linked flows, tests, configs, and evidence gaps before merge.',
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

  const reviewableOverengineeringRisk =
    reviewableChangedFiles.length > 12 && changedTestFiles.length < 2;
  if (reviewableOverengineeringRisk) {
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

  const requiredTests = requiredTestCommands(params.entitySets.commands, reviewableChangedFiles);
  const verificationPlan = reviewVerificationPlan({
    changedSourceFiles,
    changedTestFiles,
    changedConfigFiles,
    changedDependencyFiles,
    affectedFlows,
    affectedServices,
    affectedComponents: unique([...affectedComponentIds, ...dependentComponentIds]),
    affectedDataDependencies,
    affectedStateOperations,
    dependencyRuntimeImpact,
    architectureImpactMap,
    findings,
    requiredTests,
    verificationStatus,
  });
  const surgicalityScore = scoreSurgicality(
    reviewableChangedFiles.length,
    affectedComponents.length + dependentComponents.length,
    findings,
  );
  const overallRisk = classifyOverallRisk(findings, blastRadius);
  return {
    id: entityId('review', `${params.now}-git-diff`),
    generated_at: params.now,
    changed_files: publicChangedFiles,
    direct_affected_components: directAffectedComponentData,
    affected_services: affectedServices,
    dependent_components: dependentComponentData,
    affected_components: unique([...affectedComponentIds, ...dependentComponentIds]),
    affected_flows: affectedFlows,
    affected_relationships: affectedRelationships,
    architecture_impact_map: architectureImpactMap,
    dependency_runtime_impact: dependencyRuntimeImpact,
    affected_entities: graphAffectedEntities,
    blast_radius_reasons: blastRadiusReasons,
    review_evidence_summary: {
      changed_files: changedFiles.length,
      generated_artifacts: changedGeneratedArtifactFiles.map(safeText),
      test_evidence_changes: testEvidenceChanges,
      direct_components: affectedComponents.length,
      affected_services: affectedServices.length,
      dependent_components: dependentComponents.length,
      affected_flows: affectedFlows.length,
      dependency_runtime_impacts: dependencyRuntimeImpact === null ? 0 : 1,
      dependency_runtime_changed_files: dependencyRuntimeImpact?.changed_files ?? [],
      dependency_runtime_surfaces: dependencyRuntimeImpact?.runtime_surfaces ?? [],
      dependency_runtime_verification_focus: dependencyRuntimeImpact?.verification_focus ?? [],
      service_causality_paths: serviceCausalityPaths.length,
      service_causality_effects: serviceCausalityEffects,
      affected_journeys: affectedJourneyNames,
      affected_journey_steps: affectedJourneySteps.length,
      affected_data_dependencies: affectedDataDependencies.map((dependency) =>
        safeText(dependency.label),
      ),
      affected_state_operations: affectedStateOperations,
      user_visible_failure_modes: userVisibleFailureModes,
      journey_missing_evidence: journeyMissingEvidence,
      architecture_impact_surfaces: architectureImpactMap.length,
      architecture_confidence_gaps: architectureConfidenceGaps.map(safeText),
      architecture_evidence_gap_ids: architectureEvidenceGapIds,
      architecture_what_breaks: architectureWhatBreaks,
      architecture_risk_reasoning: architectureRiskReasoning,
      affected_tests: affectedTests,
      affected_configs: affectedConfigs,
      verification_evidence_ids: params.verificationEvidence.items.map((item) => item.id),
      evidence_ids: reviewEvidenceIds.slice(0, 40),
    },
    verification_status: verificationStatus,
    verification_plan: verificationPlan,
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
      dependencyRuntimeImpact,
      blastRadiusReasons,
    ),
    recommended_action: recommendAction(overallRisk, findings),
  };
}

function countReviewFindingsBySeverity(
  findings: readonly ReviewFindingData[],
): Record<ReviewSeverity, number> {
  const counts = Object.fromEntries(REVIEW_SEVERITIES.map((severity) => [severity, 0])) as Record<
    ReviewSeverity,
    number
  >;
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function countReviewFindingsByCategory(
  findings: readonly ReviewFindingData[],
): Record<ReviewCategory, number> {
  const counts = Object.fromEntries(REVIEW_CATEGORIES.map((category) => [category, 0])) as Record<
    ReviewCategory,
    number
  >;
  for (const finding of findings) counts[finding.category] += 1;
  return counts;
}

function riskPenalty(risk: OverallRisk): number {
  if (risk === 'critical') return 45;
  if (risk === 'high') return 30;
  if (risk === 'medium') return 18;
  return 5;
}

function blastRadiusPenalty(blastRadius: BlastRadius): number {
  if (blastRadius === 'broad') return 20;
  if (blastRadius === 'moderate') return 10;
  return 3;
}

function scoreReviewReadiness(
  review: ReviewSummaryData,
  unsafeSensitiveReferenceCount: number,
): number {
  const evidenceBonus = Math.min(12, review.review_evidence_summary.evidence_ids.length);
  const testBonus = Math.min(8, review.required_tests.length * 2);
  const verificationPlanBonus = Math.min(8, review.verification_plan.length * 2);
  const requiredVerificationPenalty =
    review.verification_plan.filter((item) => item.priority === 'required').length * 2;
  const findingPenalty = review.findings.length * 4;
  const secretPenalty = unsafeSensitiveReferenceCount * 25;
  return Math.max(
    0,
    Math.min(
      100,
      review.surgicality_score * 10 +
        evidenceBonus +
        testBonus +
        verificationPlanBonus -
        requiredVerificationPenalty -
        findingPenalty -
        riskPenalty(review.overall_risk) -
        blastRadiusPenalty(review.blast_radius) -
        secretPenalty,
    ),
  );
}

function emptyReviewClaimSurfaceCounts(): Record<ReviewClaimEvidenceSurface, number> {
  return {
    blast_radius_reason: 0,
    finding: 0,
    affected_flow: 0,
    verification_plan: 0,
  };
}

function emptyConfidenceCounts(): Record<Confidence, number> {
  return { verified: 0, inferred: 0, uncertain: 0 };
}

function reviewClaimRedactionCount(
  claim: Omit<ReviewClaimEvidenceData, 'redacted_evidence_count'>,
): number {
  return redactedReferenceCount(safeResearchValue(claim));
}

function architectureImpactClaimRedactionCount(
  claim: Omit<ReviewArchitectureImpactClaimEvidenceData, 'redacted_evidence_count'>,
): number {
  return redactedReferenceCount(safeResearchValue(claim));
}

function buildArchitectureImpactClaimEvidence(
  review: ReviewSummaryData,
): ReviewArchitectureImpactClaimEvidenceData[] {
  return review.architecture_impact_map.map((impact, index) => {
    const affectedEntities = unique([
      impact.entity_id,
      ...impact.matched_components,
      ...impact.dependent_components,
      ...impact.matched_flows,
      ...impact.affected_flows,
    ]);
    const unknowns = unique([
      ...(impact.evidence_gap_ids.length > 0
        ? [`Architecture evidence gaps remain: ${impact.evidence_gap_ids.slice(0, 6).join(', ')}.`]
        : []),
      ...(impact.confidence !== 'verified'
        ? [`Architecture impact confidence is ${impact.confidence}; confirm source evidence.`]
        : []),
      ...(impact.evidence_ids.length === 0
        ? ['No direct evidence IDs were linked to this architecture impact surface.']
        : []),
    ]);
    const claimWithoutRedaction = {
      claim_id: entityId('evidence', `review-architecture-impact-claim-${index + 1}`),
      impact_id: safeText(impact.impact_id),
      surface_type: impact.surface_type,
      claim: safeText(
        `${impact.impact_id} links ${impact.matched_changed_files.join(', ') || 'changed files'} to ${
          impact.name
        }; likely breakage: ${impact.what_breaks.slice(0, 3).join(' ') || 'none recorded'}.`,
      ),
      confidence: impact.confidence,
      evidence_ids: unique(impact.evidence_ids.map(safeText)),
      source_files: unique(
        [...impact.matched_changed_files, ...impact.affected_files].map(safeText),
      ),
      affected_entities: affectedEntities.map(safeText),
      matched_components: impact.matched_components.map(safeText),
      matched_flows: impact.matched_flows.map(safeText),
      affected_flows: impact.affected_flows.map(safeText),
      affected_tests: impact.affected_tests.map(safeText),
      affected_configs: impact.affected_configs.map(safeText),
      what_breaks: impact.what_breaks.map(safeText),
      review_focus: impact.risk_reasoning.review_focus.map(safeText),
      rules: unique(
        [
          'architecture_impact_map',
          `surface:${impact.surface_type}`,
          `coupling:${impact.coupling_level}`,
          `risk:${impact.risk_reasoning.risk_level}`,
          ...impact.reasons,
        ].map(safeText),
      ),
      unknowns: unknowns.map(safeText),
    };
    return {
      ...claimWithoutRedaction,
      redacted_evidence_count: architectureImpactClaimRedactionCount(claimWithoutRedaction),
    };
  });
}

function buildReviewClaimEvidenceArtifact(
  review: ReviewSummaryData,
): ReviewClaimEvidenceArtifactData {
  const claims: ReviewClaimEvidenceData[] = [];
  const pushClaim = (
    surface: ReviewClaimEvidenceSurface,
    params: {
      readonly claim: string;
      readonly confidence: Confidence;
      readonly evidenceIds: readonly string[];
      readonly sourceFiles: readonly string[];
      readonly affectedEntities: readonly string[];
      readonly rules: readonly string[];
      readonly unknowns: readonly string[];
    },
  ): void => {
    const claimWithoutRedaction = {
      claim_id: entityId('evidence', `review-claim-${surface}-${claims.length + 1}`),
      surface,
      claim: safeText(params.claim),
      confidence: params.confidence,
      evidence_ids: unique(params.evidenceIds.map(safeText)),
      source_files: unique(params.sourceFiles.map(safeText)),
      affected_entities: unique(params.affectedEntities.map(safeText)),
      rules: unique(params.rules.map(safeText)),
      unknowns: unique(params.unknowns.map(safeText)),
    };
    claims.push({
      ...claimWithoutRedaction,
      redacted_evidence_count: reviewClaimRedactionCount(claimWithoutRedaction),
    });
  };

  for (const reason of review.blast_radius_reasons) {
    pushClaim('blast_radius_reason', {
      claim: reason,
      confidence: review.review_evidence_summary.evidence_ids.length > 0 ? 'inferred' : 'uncertain',
      evidenceIds: review.review_evidence_summary.evidence_ids,
      sourceFiles: review.changed_files,
      affectedEntities: review.affected_entities,
      rules: ['blast_radius_reason', `blast_radius:${review.blast_radius}`],
      unknowns:
        review.review_evidence_summary.evidence_ids.length === 0
          ? ['No direct evidence IDs were linked to this blast-radius reason.']
          : [],
    });
  }

  for (const finding of review.findings) {
    pushClaim('finding', {
      claim: `${finding.title}: ${finding.description}`,
      confidence: finding.confidence,
      evidenceIds: finding.evidence_ids,
      sourceFiles: finding.affected_files,
      affectedEntities: finding.affected_entities,
      rules: [`finding:${finding.category}`, `severity:${finding.severity}`],
      unknowns:
        finding.evidence_ids.length === 0
          ? ['No direct evidence IDs were linked to this finding.']
          : [],
    });
  }

  for (const flow of review.affected_flows) {
    pushClaim('affected_flow', {
      claim: `${reviewFlowDescriptionLabel(flow)} is affected by changed files ${
        flow.changed_files.join(', ') || 'none recorded'
      }.`,
      confidence: flow.confidence,
      evidenceIds: flow.evidence_ids,
      sourceFiles: unique([...flow.changed_files, ...flow.entrypoints]),
      affectedEntities: unique([flow.id, ...flow.components, ...flow.services]),
      rules: ['affected_flow_overlap', `flow_kind:${flow.kind}`],
      unknowns: (() => {
        if (flow.missing_evidence.length > 0) return flow.missing_evidence;
        if (flow.evidence_ids.length === 0) {
          return ['No direct evidence IDs were linked to this affected flow.'];
        }
        return [];
      })(),
    });
  }

  for (const item of review.verification_plan) {
    pushClaim('verification_plan', {
      claim: `${item.priority} ${item.verification_type} verification: ${item.reason}`,
      confidence: item.confidence,
      evidenceIds: item.evidence_ids,
      sourceFiles: item.linked_files,
      affectedEntities: unique([
        ...item.linked_findings,
        ...item.linked_flows,
        ...item.linked_components,
      ]),
      rules: [`verification_plan:${item.verification_type}`, `priority:${item.priority}`],
      unknowns:
        item.evidence_ids.length === 0
          ? ['No direct evidence IDs were linked to this verification step.']
          : [],
    });
  }

  const architectureImpactClaims = buildArchitectureImpactClaimEvidence(review);
  const claimsBySurface = emptyReviewClaimSurfaceCounts();
  const claimsByConfidence = emptyConfidenceCounts();
  for (const claim of claims) {
    claimsBySurface[claim.surface] += 1;
    claimsByConfidence[claim.confidence] += 1;
  }
  const safeClaims = safeResearchValue(claims);
  const safeArchitectureImpactClaims = safeResearchValue(architectureImpactClaims);
  const claimsWithEvidence =
    claims.filter((claim) => claim.evidence_ids.length > 0).length +
    architectureImpactClaims.filter((claim) => claim.evidence_ids.length > 0).length;
  const totalClaimCount = claims.length + architectureImpactClaims.length;
  const safeEvidencePayload = {
    claims: safeClaims,
    architecture_impact_claims: safeArchitectureImpactClaims,
  };
  const redactedReferenceCountValue = redactedReferenceCount(safeEvidencePayload);
  const unsafeSensitiveReferenceCount = unredactedSensitiveReferenceCount(safeEvidencePayload);
  return {
    schema_version: 1,
    generated_at: review.generated_at,
    review_id: review.id,
    basis: {
      source: 'pre_change_project_brain_plus_git_diff',
      description:
        'Review claim evidence is derived from the existing Project Intelligence Layer plus the current git diff; it does not claim post-change runtime certainty.',
      review_fields: [
        'changed_files',
        'blast_radius_reasons',
        'findings',
        'affected_flows',
        'verification_plan',
        'architecture_impact_map',
      ],
    },
    changed_files: review.changed_files,
    deterministic: true,
    provider_calls_required: false,
    network_required: false,
    total_claims: claims.length,
    architecture_impact_claim_count: architectureImpactClaims.length,
    claim_counts: {
      total: totalClaimCount,
      generic_claims: claims.length,
      architecture_impact_claims: architectureImpactClaims.length,
      with_evidence: claimsWithEvidence,
      without_evidence: totalClaimCount - claimsWithEvidence,
    },
    claims_by_surface: claimsBySurface,
    claims_by_confidence: claimsByConfidence,
    redacted_evidence_count: redactedReferenceCountValue,
    secret_safety: {
      redacted_reference_count: redactedReferenceCountValue,
      unsafe_sensitive_reference_count: unsafeSensitiveReferenceCount,
      output_secret_safe: unsafeSensitiveReferenceCount === 0,
    },
    claims: safeClaims as ReviewClaimEvidenceData[],
    architecture_impact_claims:
      safeArchitectureImpactClaims as ReviewArchitectureImpactClaimEvidenceData[],
  };
}

function buildReviewEvalArtifact(review: ReviewSummaryData): ReviewEvalArtifactData {
  const safeReview = safeResearchValue(review);
  const redactedCount = redactedReferenceCount(safeReview);
  const unsafeSensitiveReferenceCount = unredactedSensitiveReferenceCount(safeReview);
  const serviceCausality = review.affected_flows.flatMap((flow) => flow.service_causality);
  const serviceCausalityEffects = unique(serviceCausality.flatMap((item) => item.effects));
  return {
    schema_version: 1,
    generated_at: review.generated_at,
    review_id: review.id,
    deterministic: true,
    provider_calls_required: false,
    network_required: false,
    total_findings: review.findings.length,
    findings_by_severity: countReviewFindingsBySeverity(review.findings),
    findings_by_category: countReviewFindingsByCategory(review.findings),
    generated_artifact_count: review.review_evidence_summary.generated_artifacts.length,
    test_evidence_change_count: review.review_evidence_summary.test_evidence_changes.length,
    affected_component_count: review.affected_components.length,
    affected_service_count: review.affected_services.length,
    direct_affected_component_count: review.direct_affected_components.length,
    dependent_component_count: review.dependent_components.length,
    affected_flow_count: review.affected_flows.length,
    dependency_runtime_impact_count: review.dependency_runtime_impact === null ? 0 : 1,
    dependency_runtime_changed_file_count:
      review.dependency_runtime_impact?.changed_files.length ?? 0,
    dependency_runtime_surface_count:
      review.dependency_runtime_impact?.runtime_surfaces.length ?? 0,
    dependency_runtime_verification_focus_count:
      review.dependency_runtime_impact?.verification_focus.length ?? 0,
    service_causality_path_count: serviceCausality.length,
    service_causality_effect_count: serviceCausalityEffects.length,
    affected_journey_count: review.review_evidence_summary.affected_journeys.length,
    affected_journey_step_count: review.review_evidence_summary.affected_journey_steps,
    affected_data_dependency_count:
      review.review_evidence_summary.affected_data_dependencies.length,
    affected_state_operation_count: review.review_evidence_summary.affected_state_operations.length,
    user_visible_failure_mode_count:
      review.review_evidence_summary.user_visible_failure_modes.length,
    journey_missing_evidence_count: review.review_evidence_summary.journey_missing_evidence.length,
    affected_relationship_count: review.affected_relationships.length,
    architecture_impact_surface_count: review.architecture_impact_map.length,
    architecture_impact_component_surface_count: review.architecture_impact_map.filter(
      (entry) => entry.surface_type === 'component',
    ).length,
    architecture_impact_route_surface_count: review.architecture_impact_map.filter(
      (entry) => entry.surface_type === 'route',
    ).length,
    architecture_what_breaks_note_count:
      review.review_evidence_summary.architecture_what_breaks.length,
    architecture_risk_reasoning_count:
      review.review_evidence_summary.architecture_risk_reasoning.length,
    architecture_evidence_gap_count:
      review.review_evidence_summary.architecture_evidence_gap_ids.length,
    architecture_confidence_gap_count:
      review.review_evidence_summary.architecture_confidence_gaps.length,
    verification_evidence_count: review.verification_status.total_checks,
    verification_passed_count: review.verification_status.passed_checks.length,
    verification_failed_count: review.verification_status.failed_checks.length,
    verification_plan_count: review.verification_plan.length,
    verification_plan_required_count: review.verification_plan.filter(
      (item) => item.priority === 'required',
    ).length,
    verification_plan_recommended_count: review.verification_plan.filter(
      (item) => item.priority === 'recommended',
    ).length,
    verification_plan_optional_count: review.verification_plan.filter(
      (item) => item.priority === 'optional',
    ).length,
    architecture_affected_test_count: unique(
      review.architecture_impact_map.flatMap((entry) => entry.affected_tests),
    ).length,
    architecture_affected_config_count: unique(
      review.architecture_impact_map.flatMap((entry) => entry.affected_configs),
    ).length,
    required_test_count: review.required_tests.length,
    evidence_id_count: review.review_evidence_summary.evidence_ids.length,
    blast_radius: review.blast_radius,
    overall_risk: review.overall_risk,
    surgicality_score: review.surgicality_score,
    review_readiness_score: scoreReviewReadiness(review, unsafeSensitiveReferenceCount),
    secret_safety: {
      redaction_applied: redactedCount > 0,
      redacted_reference_count: redactedCount,
      unsafe_sensitive_reference_count: unsafeSensitiveReferenceCount,
      output_secret_safe: unsafeSensitiveReferenceCount === 0,
    },
    redaction: {
      redacted_reference_count: redactedCount,
      unsafe_sensitive_reference_count: unsafeSensitiveReferenceCount,
      note:
        unsafeSensitiveReferenceCount === 0
          ? 'Review eval output is safe to share; sensitive references are omitted or redacted.'
          : 'Review eval output still contains unsafe sensitive references.',
    },
    scoring_notes: [
      'Review eval is computed from deterministic local review, brain, graph, and evidence artifacts.',
      'Architecture impact counts are populated only when changed files, components, or flows overlap the local impact map.',
      'Verification evidence can reduce local regression risk only when checks are explicitly recorded.',
      'Readiness combines surgicality, risk, blast radius, findings, test guidance, evidence, and secret safety.',
    ],
  };
}

async function updateBrainIndexReviewArtifactPaths(indexPath: string): Promise<void> {
  const index = (await readJsonFile<Record<string, unknown>>(indexPath)) ?? {};
  const researchPaths = isRecord(index.research_paths) ? index.research_paths : {};
  await writeVerifiedFile(
    indexPath,
    jsonString(
      safeBrainValue({
        ...index,
        research_paths: {
          ...researchPaths,
          review_eval: '.rizz/research/review_eval.json',
          review_claim_evidence: '.rizz/research/review_claim_evidence.json',
          verification_evidence: '.rizz/research/verification_evidence.json',
        },
      }),
    ),
  );
}

async function updateBrainIndexVerificationEvidencePath(indexPath: string): Promise<void> {
  const index = (await readJsonFile<Record<string, unknown>>(indexPath)) ?? {};
  const researchPaths = isRecord(index.research_paths) ? index.research_paths : {};
  await writeVerifiedFile(
    indexPath,
    jsonString(
      safeBrainValue({
        ...index,
        research_paths: {
          ...researchPaths,
          verification_evidence: '.rizz/research/verification_evidence.json',
        },
      }),
    ),
  );
}

function isSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php)$/.test(path) && !isTestPath(path);
}

type DiffFileChange = {
  readonly addedLines: readonly string[];
  readonly deletedLines: readonly string[];
  readonly isDeleted: boolean;
  readonly isRenamed: boolean;
  readonly isNew: boolean;
};

function hasRuntimeRelevantSourceDiff(path: string, diffText: string): boolean {
  if (isTypeOnlySupportFile(path)) return false;
  const change = diffChangeForFile(diffText, path);
  if (change === undefined) return true;
  if (change.isDeleted || change.isRenamed || change.isNew) return true;
  return changedCodeLines(change).length > 0;
}

function hasStateDataRelevantDiff(path: string, diffText: string): boolean {
  if (isTypeOnlySupportFile(path)) return false;
  const change = diffChangeForFile(diffText, path);
  if (change === undefined) return true;
  if (change.isDeleted || change.isRenamed || change.isNew) return true;
  return changedCodeLines(change).length > 0;
}

function changedCodeLines(change: DiffFileChange): string[] {
  return [...change.addedLines, ...change.deletedLines].filter((line) => {
    const trimmed = line.trim();
    if (trimmed === '') return false;
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('*/') ||
      trimmed.startsWith('<!--') ||
      trimmed.startsWith('--')
    ) {
      return false;
    }
    return true;
  });
}

function diffChangeForFile(diffText: string, path: string): DiffFileChange | undefined {
  return parseDiffFileChanges(diffText).get(path);
}

function parseDiffFileChanges(diffText: string): Map<string, DiffFileChange> {
  const changes = new Map<string, DiffFileChange>();
  let current:
    | {
        oldPath: string;
        newPath: string;
        addedLines: string[];
        deletedLines: string[];
        isDeleted: boolean;
        isRenamed: boolean;
        isNew: boolean;
      }
    | undefined;
  const commitCurrent = (): void => {
    if (current === undefined) return;
    const value: DiffFileChange = {
      addedLines: current.addedLines,
      deletedLines: current.deletedLines,
      isDeleted: current.isDeleted,
      isRenamed: current.isRenamed,
      isNew: current.isNew,
    };
    changes.set(current.newPath, value);
    changes.set(current.oldPath, value);
  };
  for (const line of diffText.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header !== null) {
      commitCurrent();
      current = {
        oldPath: header[1] ?? '',
        newPath: header[2] ?? '',
        addedLines: [],
        deletedLines: [],
        isDeleted: false,
        isRenamed: false,
        isNew: false,
      };
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('deleted file mode')) {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith('new file mode')) {
      current.isNew = true;
      continue;
    }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      current.isRenamed = true;
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) current.addedLines.push(line.slice(1));
    if (line.startsWith('-')) current.deletedLines.push(line.slice(1));
  }
  commitCurrent();
  return changes;
}

function isTestPath(path: string): boolean {
  return /(__tests__|\.test\.|\.spec\.)/.test(path);
}

function isConfigPath(path: string): boolean {
  return (
    path.startsWith('.github/') ||
    isDeploymentConfigPath(path) ||
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
    if (component.latest_status === 'stale') return false;
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
  const componentsById = new Map(
    components
      .filter((component) => component.latest_status !== 'stale')
      .map((component) => [component.id, component]),
  );
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
  staleEntityIds: ReadonlySet<string>,
): ReviewAffectedRelationshipData[] {
  const affectedIds = new Set(affectedEntityIds);
  return relationships
    .filter(
      (rel) =>
        (affectedIds.has(rel.from) || affectedIds.has(rel.to)) &&
        !staleEntityIds.has(rel.from) &&
        !staleEntityIds.has(rel.to),
    )
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

function staleReviewEntityIds(
  entitySets: Awaited<ReturnType<typeof readReviewEntitySets>>,
): Set<string> {
  return new Set(
    [
      ...entitySets.files,
      ...entitySets.components,
      ...entitySets.services,
      ...entitySets.flows,
      ...entitySets.configs,
      ...entitySets.commands,
      ...entitySets.tests,
      ...entitySets.dependencies,
      ...entitySets.risks,
    ]
      .filter((entity) => entity.latest_status === 'stale')
      .map((entity) => entity.id),
  );
}

function reviewDependencyRuntimeImpact(params: {
  readonly changedConfigFiles: readonly string[];
  readonly changedDependencyFiles: readonly string[];
  readonly entitySets: Awaited<ReturnType<typeof readReviewEntitySets>>;
  readonly directComponents: readonly BrainEntity[];
  readonly dependentComponents: readonly BrainEntity[];
  readonly affectedFlows: readonly AffectedFlowData[];
  readonly affectedServices: readonly ReviewAffectedServiceData[];
  readonly affectedTests: readonly string[];
  readonly affectedConfigs: readonly string[];
  readonly architectureImpactMap: readonly ReviewArchitectureImpactData[];
}): ReviewDependencyRuntimeImpactData | null {
  const changedFiles = unique([...params.changedDependencyFiles, ...params.changedConfigFiles]);
  if (changedFiles.length === 0) return null;

  const packageManifests = params.changedDependencyFiles.filter((file) =>
    /(^|\/)package\.json$/.test(file),
  );
  const lockfiles = params.changedDependencyFiles.filter(
    (file) => !packageManifests.includes(file),
  );
  const changedDependencyFileSet = new Set(params.changedDependencyFiles);
  const packageScripts = reviewPackageScriptsForChangedFiles(
    params.entitySets.commands,
    params.changedDependencyFiles,
  );
  const dependencyEntities = reviewDependencyEntitiesForChangedFiles({
    dependencies: params.entitySets.dependencies,
    changedDependencyFiles: params.changedDependencyFiles,
    includeAllDependencies: lockfiles.length > 0,
  });
  const runtimeSurfaces = reviewDependencyRuntimeSurfaces({
    changedConfigFiles: params.changedConfigFiles,
    changedDependencyFiles: params.changedDependencyFiles,
    packageScripts,
    affectedFlows: params.affectedFlows,
    affectedServices: params.affectedServices,
  });
  const affectedComponents = unique([
    ...params.directComponents.map((component) => component.id),
    ...params.dependentComponents.map((component) => component.id),
    ...params.architectureImpactMap.flatMap((entry) => [
      entry.entity_id,
      ...entry.matched_components,
      ...entry.dependent_components,
    ]),
  ]).map(safeText);
  const affectedServices = params.affectedServices.map((service) => service.id);
  const affectedFlows = params.affectedFlows.map((flow) => flow.id);
  const affectedTests = unique([
    ...params.affectedTests,
    ...params.architectureImpactMap.flatMap((entry) => entry.affected_tests),
  ]).map(safeText);
  const affectedConfigs = unique([
    ...params.affectedConfigs,
    ...params.architectureImpactMap.flatMap((entry) => entry.affected_configs),
  ]).map(safeText);
  const verificationFocus = reviewDependencyVerificationFocus({
    packageScripts,
    affectedFlows: params.affectedFlows,
    affectedServices: params.affectedServices,
    affectedTests,
    changedDependencyFiles: params.changedDependencyFiles,
    changedConfigFiles: params.changedConfigFiles,
  });

  return {
    changed_files: changedFiles.map(safeText),
    package_manifests: packageManifests.map(safeText),
    lockfiles: lockfiles.map(safeText),
    config_files: params.changedConfigFiles.map(safeText),
    dependency_entities: dependencyEntities.map((dependency) => dependency.id),
    package_scripts: packageScripts,
    runtime_surfaces: runtimeSurfaces,
    affected_components: affectedComponents,
    affected_services: affectedServices,
    affected_flows: affectedFlows,
    affected_tests: affectedTests,
    affected_configs: affectedConfigs,
    verification_focus: verificationFocus,
    reasons: unique([
      ...(packageManifests.length > 0
        ? [`Changed package manifest(s): ${packageManifests.slice(0, 5).join(', ')}.`]
        : []),
      ...(lockfiles.length > 0
        ? [`Changed lockfile(s): ${lockfiles.slice(0, 5).join(', ')}.`]
        : []),
      ...(params.changedConfigFiles.length > 0
        ? [`Changed config file(s): ${params.changedConfigFiles.slice(0, 5).join(', ')}.`]
        : []),
      ...(packageScripts.length > 0
        ? [
            `${packageScripts.length} package script(s) can change install/build/test/runtime behavior.`,
          ]
        : []),
      ...(dependencyEntities.length > 0
        ? [
            `${dependencyEntities.length} declared dependency entity/entities are linked to changed package evidence.`,
          ]
        : []),
      ...(changedDependencyFileSet.size > 0 && affectedFlows.length > 0
        ? [
            `Package/dependency evidence is linked to affected flow(s): ${affectedFlows.slice(0, 5).join(', ')}.`,
          ]
        : []),
      ...(params.affectedServices.length > 0
        ? [
            `Affected service(s) inherit package/config risk: ${affectedServices.slice(0, 5).join(', ')}.`,
          ]
        : []),
    ]).map(safeText),
    confidence:
      affectedComponents.length > 0 ||
      affectedFlows.length > 0 ||
      affectedServices.length > 0 ||
      packageScripts.length > 0
        ? 'inferred'
        : 'verified',
  };
}

function reviewDependencyEntitiesForChangedFiles(params: {
  readonly dependencies: readonly BrainEntity[];
  readonly changedDependencyFiles: readonly string[];
  readonly includeAllDependencies: boolean;
}): BrainEntity[] {
  const changedFileSet = new Set(params.changedDependencyFiles);
  return params.dependencies
    .filter((dependency) => {
      if (dependency.latest_status === 'stale') return false;
      if (params.includeAllDependencies) return true;
      return dependency.source_files.some((file) => changedFileSet.has(file));
    })
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 20);
}

function reviewPackageScriptsForChangedFiles(
  commands: readonly BrainEntity[],
  changedDependencyFiles: readonly string[],
): ReviewPackageScriptData[] {
  const changedFileSet = new Set(changedDependencyFiles);
  return commands
    .filter((command) => command.latest_status !== 'stale')
    .filter((command) => command.source_files.some((file) => changedFileSet.has(file)))
    .map((command) => {
      const manifest = stringData(command, 'manifest') ?? command.source_files[0] ?? '';
      const commandText = stringData(command, 'command') ?? '';
      return {
        manifest: safeText(manifest),
        name: safeText(command.name),
        command: safeText(commandText),
        category: reviewPackageScriptCategory(command.name, commandText),
      };
    })
    .sort(
      (a, b) =>
        a.manifest.localeCompare(b.manifest) ||
        reviewPackageScriptCategoryRank(a.category) - reviewPackageScriptCategoryRank(b.category) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 20);
}

function reviewPackageScriptCategory(name: string, command: string): ReviewPackageScriptCategory {
  const scriptName = name.toLowerCase();
  if (/typecheck|type-check/.test(scriptName)) return 'typecheck';
  if (/test/.test(scriptName)) return 'test';
  if (/lint/.test(scriptName)) return 'lint';
  if (/pack/.test(scriptName)) return 'pack';
  if (/build|compile|bundle/.test(scriptName)) return 'build';
  if (/deploy/.test(scriptName)) return 'deploy';
  if (/start|dev|serve/.test(scriptName)) return 'start';
  if (/runtime|smoke|e2e/.test(scriptName)) return 'runtime';
  const text = command.toLowerCase();
  if (/typecheck|tsc|type-check/.test(text)) return 'typecheck';
  if (/test|vitest|jest|pytest|playwright|cypress/.test(text)) return 'test';
  if (/lint|biome|eslint/.test(text)) return 'lint';
  if (/pack|npm pack|pnpm pack/.test(text)) return 'pack';
  if (/build|compile|bundle/.test(text)) return 'build';
  if (/deploy|vercel|netlify|wrangler|sst/.test(text)) return 'deploy';
  if (/start|dev|serve|node /.test(text)) return 'start';
  if (/runtime|smoke|e2e/.test(text)) return 'runtime';
  return 'other';
}

function reviewPackageScriptCategoryRank(category: ReviewPackageScriptCategory): number {
  switch (category) {
    case 'typecheck':
      return 1;
    case 'test':
      return 2;
    case 'lint':
      return 3;
    case 'build':
      return 4;
    case 'pack':
      return 5;
    case 'start':
      return 6;
    case 'deploy':
      return 7;
    case 'runtime':
      return 8;
    case 'other':
      return 9;
  }
}

function reviewDependencyRuntimeSurfaces(params: {
  readonly changedConfigFiles: readonly string[];
  readonly changedDependencyFiles: readonly string[];
  readonly packageScripts: readonly ReviewPackageScriptData[];
  readonly affectedFlows: readonly AffectedFlowData[];
  readonly affectedServices: readonly ReviewAffectedServiceData[];
}): string[] {
  return unique([
    ...(params.changedDependencyFiles.length > 0 ? ['install/dependency resolution'] : []),
    ...(params.changedConfigFiles.length > 0 ? ['configuration/runtime setup'] : []),
    ...params.packageScripts.map((script) => `package script:${script.category}`),
    ...(params.affectedFlows.length > 0 ? ['reconstructed flows'] : []),
    ...(params.affectedServices.length > 0 ? ['service runtime behavior'] : []),
    ...(params.affectedServices.some((service) => service.deployment_configs.length > 0)
      ? ['deployment config']
      : []),
    ...(params.affectedServices.some((service) => service.environment_variables.length > 0)
      ? ['environment variables']
      : []),
    ...(params.affectedFlows.some((flow) => flow.route_path !== undefined)
      ? ['route runtime']
      : []),
  ]).map(safeText);
}

function reviewDependencyVerificationFocus(params: {
  readonly packageScripts: readonly ReviewPackageScriptData[];
  readonly affectedFlows: readonly AffectedFlowData[];
  readonly affectedServices: readonly ReviewAffectedServiceData[];
  readonly affectedTests: readonly string[];
  readonly changedDependencyFiles: readonly string[];
  readonly changedConfigFiles: readonly string[];
}): string[] {
  const priorityScripts = params.packageScripts.filter((script) =>
    ['typecheck', 'test', 'lint', 'build', 'pack'].includes(script.category),
  );
  return uniqueInOrder([
    ...(params.changedDependencyFiles.length > 0
      ? ['Validate package install and lockfile resolution for the changed dependency files.']
      : []),
    ...(params.changedConfigFiles.length > 0
      ? ['Run the config-backed build/test path that consumes the changed config files.']
      : []),
    ...priorityScripts.map(
      (script) => `Run package script ${script.manifest}#${script.name}: ${script.command}.`,
    ),
    ...params.affectedFlows
      .slice(0, 6)
      .map((flow) => `Exercise affected flow ${reviewFlowDescriptionLabel(flow)}.`),
    ...params.affectedServices
      .slice(0, 6)
      .map((service) => `Smoke affected service ${service.id}.`),
    ...params.affectedTests.slice(0, 6).map((test) => `Run linked test artifact ${test}.`),
    ...(params.packageScripts.some((script) => script.category === 'pack')
      ? ['Inspect packed package contents after the dependency/config change.']
      : []),
  ])
    .map(safeText)
    .slice(0, 12);
}

function reviewVerificationPlan(params: {
  readonly changedSourceFiles: readonly string[];
  readonly changedTestFiles: readonly string[];
  readonly changedConfigFiles: readonly string[];
  readonly changedDependencyFiles: readonly string[];
  readonly affectedFlows: readonly AffectedFlowData[];
  readonly affectedServices: readonly ReviewAffectedServiceData[];
  readonly affectedComponents: readonly string[];
  readonly affectedDataDependencies: readonly FlowDataDependency[];
  readonly affectedStateOperations: readonly string[];
  readonly dependencyRuntimeImpact: ReviewDependencyRuntimeImpactData | null;
  readonly architectureImpactMap: readonly ReviewArchitectureImpactData[];
  readonly findings: readonly ReviewFindingData[];
  readonly requiredTests: readonly string[];
  readonly verificationStatus: ReviewVerificationStatusData;
}): ReviewVerificationPlanItemData[] {
  const items: ReviewVerificationPlanItemData[] = [];
  const addItem = (
    item: Omit<ReviewVerificationPlanItemData, 'id'> & { readonly slug: string },
  ): void => {
    items.push({
      id: entityId('task', `review-verification-${item.slug}-${items.length + 1}`),
      priority: item.priority,
      verification_type: item.verification_type,
      reason: safeText(item.reason),
      commands: unique(item.commands.map(safeText)).slice(0, 8),
      manual_checks: unique(item.manual_checks.map(safeText)).slice(0, 10),
      linked_findings: unique(item.linked_findings.map(safeText)),
      linked_flows: unique(item.linked_flows.map(safeText)).slice(0, 12),
      linked_components: unique(item.linked_components.map(safeText)).slice(0, 12),
      linked_files: unique(item.linked_files.map(safeText)).slice(0, 16),
      evidence_ids: unique(item.evidence_ids.map(safeText)).slice(0, 20),
      confidence: item.confidence,
    });
  };
  const findingIds = (predicate: (finding: ReviewFindingData) => boolean): string[] =>
    params.findings.filter(predicate).map((finding) => finding.id);
  const hasRecordedLocalChecks = params.verificationStatus.local_checks_passed.length > 0;

  if (params.changedSourceFiles.length > 0) {
    const linkedTests = unique(params.affectedFlows.flatMap((flow) => flow.tests));
    addItem({
      slug: 'runtime-tests',
      priority:
        params.changedTestFiles.length === 0 && !hasRecordedLocalChecks
          ? 'required'
          : 'recommended',
      verification_type: 'test',
      reason:
        params.changedTestFiles.length === 0
          ? 'Runtime/source files changed without a matching test file in the diff.'
          : 'Runtime/source files changed and should be verified through the linked test surface.',
      commands: params.requiredTests,
      manual_checks: [
        ...(linkedTests.length === 0
          ? ['Add or identify focused tests for the changed runtime behavior.']
          : linkedTests.map((test) => `Run or inspect linked test artifact ${test}.`)),
        ...params.affectedFlows
          .slice(0, 5)
          .map((flow) => `Exercise affected journey ${reviewFlowDescriptionLabel(flow)}.`),
      ],
      linked_findings: findingIds((finding) => finding.category === 'Missing tests'),
      linked_flows: params.affectedFlows.map((flow) => flow.id),
      linked_components: params.affectedComponents,
      linked_files: params.changedSourceFiles,
      evidence_ids: unique(params.affectedFlows.flatMap((flow) => flow.evidence_ids)),
      confidence:
        linkedTests.length > 0 || params.requiredTests.length > 0 ? 'inferred' : 'uncertain',
    });
  }

  if (params.affectedDataDependencies.length > 0) {
    const stateWriteImpact = params.affectedStateOperations.some((operation) =>
      ['schema', 'write', 'update', 'delete', 'cache/session'].includes(operation),
    );
    addItem({
      slug: 'state-data',
      priority: stateWriteImpact ? 'required' : 'recommended',
      verification_type: stateWriteImpact ? 'data' : 'state',
      reason: `Changed files overlap ${params.affectedDataDependencies.length} state/data dependency signal(s) and operation(s): ${params.affectedStateOperations.join(', ') || 'unknown'}.`,
      commands: params.requiredTests,
      manual_checks: unique([
        'Verify data contract compatibility for affected readers and writers.',
        ...params.affectedDataDependencies.map(formatDataDependencyForReview),
        ...params.affectedFlows
          .slice(0, 5)
          .map(
            (flow) =>
              `Confirm ${reviewFlowDescriptionLabel(flow)} still handles persisted state correctly.`,
          ),
      ]),
      linked_findings: findingIds((finding) => finding.title.includes('State/data dependency')),
      linked_flows: params.affectedFlows.map((flow) => flow.id),
      linked_components: params.affectedComponents,
      linked_files: unique(
        params.affectedDataDependencies.flatMap((dependency) => dependency.files),
      ),
      evidence_ids: unique(
        params.affectedDataDependencies.flatMap((dependency) => dependency.evidence_ids),
      ),
      confidence: params.affectedDataDependencies.every(
        (dependency) => dependency.confidence === 'verified',
      )
        ? 'verified'
        : 'inferred',
    });
  }

  if (params.dependencyRuntimeImpact !== null) {
    addItem({
      slug: 'dependency-runtime',
      priority: params.changedDependencyFiles.length > 0 ? 'required' : 'recommended',
      verification_type: 'dependency',
      reason:
        'Package, dependency, or runtime configuration changes can alter install, build, route, service, or package behavior.',
      commands: params.requiredTests,
      manual_checks: params.dependencyRuntimeImpact.verification_focus,
      linked_findings: findingIds(
        (finding) => finding.title === 'Configuration or dependency surface changed',
      ),
      linked_flows: params.dependencyRuntimeImpact.affected_flows,
      linked_components: params.dependencyRuntimeImpact.affected_components,
      linked_files: params.dependencyRuntimeImpact.changed_files,
      evidence_ids: unique(params.dependencyRuntimeImpact.changed_files.map(evidenceId)),
      confidence: params.dependencyRuntimeImpact.confidence,
    });
  } else if (params.changedConfigFiles.length > 0 || params.changedDependencyFiles.length > 0) {
    addItem({
      slug: 'config-manual',
      priority: 'recommended',
      verification_type: 'manual',
      reason:
        'Configuration or dependency files changed, but no richer runtime impact model was linked.',
      commands: params.requiredTests,
      manual_checks: [
        'Run install/build/test checks that consume the changed config files.',
        'Inspect runtime/deployment assumptions affected by the changed config.',
      ],
      linked_findings: findingIds(
        (finding) => finding.title === 'Configuration or dependency surface changed',
      ),
      linked_flows: [],
      linked_components: params.affectedComponents,
      linked_files: unique([...params.changedConfigFiles, ...params.changedDependencyFiles]),
      evidence_ids: unique(
        [...params.changedConfigFiles, ...params.changedDependencyFiles].map(evidenceId),
      ),
      confidence: 'uncertain',
    });
  }

  const serviceCausality = params.affectedFlows.flatMap((flow) => flow.service_causality);
  if (serviceCausality.length > 0) {
    addItem({
      slug: 'service-causality',
      priority: 'recommended',
      verification_type: 'service-causality',
      reason: `${serviceCausality.length} flow-to-service causality path(s) explain the affected blast radius.`,
      commands: params.requiredTests,
      manual_checks: unique([
        ...serviceCausality.map(
          (item) =>
            `Smoke ${item.service_id} through ${item.effects.join(', ') || 'recorded service effects'}.`,
        ),
        ...params.affectedServices.map((service) => `Smoke affected service ${service.id}.`),
      ]),
      linked_findings: findingIds((finding) => finding.title.includes('Service causality')),
      linked_flows: params.affectedFlows.map((flow) => flow.id),
      linked_components: params.affectedComponents,
      linked_files: unique(serviceCausality.flatMap((item) => item.files)),
      evidence_ids: unique(serviceCausality.flatMap((item) => item.evidence_ids)),
      confidence: serviceCausality.every((item) => item.confidence === 'verified')
        ? 'verified'
        : 'inferred',
    });
  }

  if (params.architectureImpactMap.length > 0) {
    addItem({
      slug: 'architecture-contract',
      priority: params.architectureImpactMap.some((entry) => entry.coupling_level === 'high')
        ? 'required'
        : 'recommended',
      verification_type: 'contract',
      reason: `${params.architectureImpactMap.length} architecture impact-map surface(s) connect this diff to likely breakage.`,
      commands: params.requiredTests,
      manual_checks: unique([
        ...params.architectureImpactMap.flatMap((entry) => entry.what_breaks).slice(0, 6),
        ...params.architectureImpactMap
          .flatMap((entry) => entry.risk_reasoning.review_focus)
          .slice(0, 6),
      ]),
      linked_findings: findingIds((finding) => finding.title.includes('Architecture impact map')),
      linked_flows: unique(params.architectureImpactMap.flatMap((entry) => entry.affected_flows)),
      linked_components: unique(
        params.architectureImpactMap.flatMap((entry) => [
          entry.entity_id,
          ...entry.dependent_components,
        ]),
      ),
      linked_files: unique(params.architectureImpactMap.flatMap((entry) => entry.affected_files)),
      evidence_ids: unique(params.architectureImpactMap.flatMap((entry) => entry.evidence_ids)),
      confidence: params.architectureImpactMap.every((entry) => entry.confidence === 'verified')
        ? 'verified'
        : 'inferred',
    });
  }

  if (items.length === 0 && params.findings.length > 0) {
    addItem({
      slug: 'findings-manual',
      priority: 'recommended',
      verification_type: 'manual',
      reason: 'Review findings exist, but no targeted runnable verification evidence was inferred.',
      commands: params.requiredTests,
      manual_checks: params.findings.slice(0, 5).map((finding) => finding.recommendation),
      linked_findings: params.findings.map((finding) => finding.id),
      linked_flows: params.affectedFlows.map((flow) => flow.id),
      linked_components: params.affectedComponents,
      linked_files: unique(params.findings.flatMap((finding) => finding.affected_files)),
      evidence_ids: unique(params.findings.flatMap((finding) => finding.evidence_ids)),
      confidence: 'uncertain',
    });
  }

  const priorityRank: Record<ReviewVerificationPriority, number> = {
    required: 0,
    recommended: 1,
    optional: 2,
  };
  return uniqueBy(items, (item) => `${item.priority}:${item.verification_type}:${item.reason}`)
    .sort(
      (a, b) =>
        priorityRank[a.priority] - priorityRank[b.priority] ||
        confidenceScoreForValue(b.confidence) - confidenceScoreForValue(a.confidence) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 12);
}

function verificationPlanSummary(plan: readonly ReviewVerificationPlanItemData[]): {
  readonly total: number;
  readonly required: number;
  readonly recommended: number;
  readonly optional: number;
} {
  return {
    total: plan.length,
    required: plan.filter((item) => item.priority === 'required').length,
    recommended: plan.filter((item) => item.priority === 'recommended').length,
    optional: plan.filter((item) => item.priority === 'optional').length,
  };
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

function affectedServiceEntities(params: {
  readonly changedFiles: readonly string[];
  readonly services: readonly BrainEntity[];
  readonly affectedFlows: readonly AffectedFlowData[];
}): ReviewAffectedServiceData[] {
  const changedFileSet = new Set(params.changedFiles);
  const flowServiceIds = new Set(params.affectedFlows.flatMap((flow) => flow.services));
  return params.services
    .filter((service) => {
      if (service.latest_status === 'stale') return false;
      if (flowServiceIds.has(service.id)) return true;
      return service.source_files.some((file) => changedFileSet.has(file));
    })
    .map((service) => {
      const changedFiles = service.source_files.filter((file) => changedFileSet.has(file));
      const affectedFlows = unique([
        ...serviceDataStringArray(service, 'related_flows'),
        ...params.affectedFlows
          .filter((flow) => flow.services.includes(service.id))
          .map((flow) => flow.id),
      ]);
      const flowMatches = params.affectedFlows.filter((flow) => affectedFlows.includes(flow.id));
      const tests = unique(flowMatches.flatMap((flow) => flow.tests));
      const configs = unique([
        ...flowMatches.flatMap((flow) => flow.configs),
        ...serviceDataStringArray(service, 'deployment_configs'),
      ]);
      return {
        id: safeText(service.id),
        name: safeText(service.name),
        runtime: safeText(stringData(service, 'runtime') ?? 'unknown'),
        framework: safeText(stringData(service, 'framework') ?? 'unknown'),
        changed_files: changedFiles.map(safeText),
        entrypoints: serviceDataStringArray(service, 'entrypoints'),
        routes: serviceDataStringArray(service, 'routes'),
        jobs: serviceDataStringArray(service, 'jobs'),
        storage_dependencies: serviceDataStringArray(service, 'storage_dependencies'),
        environment_variables: serviceDataStringArray(service, 'environment_variables'),
        external_services: serviceDataStringArray(service, 'external_services'),
        deployment_configs: serviceDataStringArray(service, 'deployment_configs'),
        affected_flows: affectedFlows.map(safeText),
        tests: tests.map(safeText),
        configs: configs.map(safeText),
        risks: serviceDataStringArray(service, 'risks'),
        confidence: service.confidence,
        evidence_ids: service.evidence_ids.map(safeText),
        reasons: unique([
          ...(changedFiles.length > 0
            ? [`${changedFiles.length} changed file(s) are owned by this service.`]
            : []),
          ...(affectedFlows.length > 0
            ? [`${affectedFlows.length} affected flow(s) link to this service.`]
            : []),
          ...(serviceDataStringArray(service, 'deployment_configs').length > 0
            ? ['Deployment config evidence is linked to this service.']
            : []),
          ...(serviceDataStringArray(service, 'storage_dependencies').length > 0
            ? ['Storage dependency evidence is linked to this service.']
            : []),
        ]).map(safeText),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function affectedFlowEntities(
  changedFiles: readonly string[],
  affectedComponents: readonly BrainEntity[],
  flows: readonly BrainEntity[],
  diffText: string,
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
    const flowServices = flowStringArray(flow, 'services');
    const directChangedFiles = changedFiles.filter((file) => flowFiles.includes(file));
    const componentChangedFiles = flowComponents.some((componentId) =>
      affectedComponentIds.has(componentId),
    )
      ? changedFiles.filter((file) => affectedComponentFiles.has(file))
      : [];
    const matchedChangedFiles = unique([...directChangedFiles, ...componentChangedFiles]);
    if (matchedChangedFiles.length === 0) return [];
    const reasons = affectedFlowReasons({
      flow,
      matchedChangedFiles,
      componentChangedFiles,
    });
    const journey = flowJourneySummaryData(flow);
    const affectedSteps = affectedJourneyStepsForChangedFiles(flow, matchedChangedFiles);
    const affectedDataDependencies = affectedDataDependenciesForChangedFiles(
      flow,
      matchedChangedFiles,
      diffText,
    );
    const missingEvidence = unique([
      ...(journey?.missing_evidence ?? []),
      ...affectedSteps.flatMap((step) => step.missing_evidence),
      ...affectedDataDependencies.flatMap((dependency) => dependency.missing_evidence),
      ...(flowStringArray(flow, 'tests').length === 0
        ? ['No directly linked tests were detected for this affected journey.']
        : []),
    ]).map(safeText);
    return [
      {
        id: safeText(flow.id),
        name: safeText(flow.name),
        ...(journey !== undefined
          ? { journey_name: journey.name, journey_confidence: journey.confidence }
          : {}),
        kind: flowKind(flow),
        ...reviewRouteFlowFields(flow),
        confidence: flow.confidence,
        score: asFlowConfidenceScore(flow),
        entrypoints: reviewFlowEntrypointLabels(flow),
        affected_steps: affectedSteps,
        runtime_surfaces: flowStringArray(flow, 'runtime_surfaces').map(safeText),
        data_dependencies: affectedDataDependencies,
        user_visible_failure_modes: userVisibleFailureModesForFlow({
          flow,
          affectedSteps,
          affectedDataDependencies,
          matchedChangedFiles,
        }),
        missing_evidence: missingEvidence,
        changed_files: matchedChangedFiles.map(safeText),
        components: flowComponents.map(safeText),
        services: flowServices.map(safeText),
        service_causality: safeFlowServiceCausality(flow),
        tests: flowStringArray(flow, 'tests').map(safeText),
        configs: flowStringArray(flow, 'configs').map(safeText),
        risks: flowRisks(flow).length,
        evidence_ids: flow.evidence_ids.map(safeText),
        reasons,
      },
    ];
  });
  return [...affectedFlows].sort((a, b) => a.id.localeCompare(b.id));
}

function reviewTestEvidenceChanges(params: {
  readonly changedTestFiles: readonly string[];
  readonly affectedFlows: readonly AffectedFlowData[];
}): string[] {
  return params.changedTestFiles
    .map((file) => {
      const linkedFlows = params.affectedFlows
        .filter((flow) => flow.tests.includes(file))
        .map(reviewFlowDescriptionLabel)
        .slice(0, 4);
      return safeText(
        `${file} updates test evidence for ${
          linkedFlows.length > 0 ? linkedFlows.join(', ') : 'an unmapped test surface'
        }.`,
      );
    })
    .sort((a, b) => a.localeCompare(b));
}

function affectedDataDependenciesForChangedFiles(
  flow: BrainEntity,
  changedFiles: readonly string[],
  diffText: string,
): FlowDataDependency[] {
  const changedFileSet = new Set(changedFiles);
  return safeFlowDataDependencies(flow).filter((dependency) =>
    dependency.files.some(
      (file) => changedFileSet.has(file) && hasStateDataRelevantDiff(file, diffText),
    ),
  );
}

function affectedJourneyStepsForChangedFiles(
  flow: BrainEntity,
  changedFiles: readonly string[],
): FlowJourneyStep[] {
  const changedFileSet = new Set(changedFiles);
  const matched = safeFlowJourneySteps(flow).filter((step) =>
    [...step.files, ...step.configs, ...step.tests].some((file) => changedFileSet.has(file)),
  );
  if (matched.length > 0) return matched;
  return safeFlowJourneySteps(flow)
    .filter((step) => step.type === 'trigger')
    .slice(0, 1);
}

function userVisibleFailureModesForFlow(params: {
  readonly flow: BrainEntity;
  readonly affectedSteps: readonly FlowJourneyStep[];
  readonly affectedDataDependencies: readonly FlowDataDependency[];
  readonly matchedChangedFiles: readonly string[];
}): string[] {
  const journeyName = flowJourneySummaryData(params.flow)?.name ?? params.flow.name;
  const stepTypes = new Set(params.affectedSteps.map((step) => step.type));
  const stateOperations = new Set(
    params.affectedDataDependencies.flatMap((dependency) => dependency.operations),
  );
  return unique([
    ...(stepTypes.has('validation_auth')
      ? [`${journeyName} can reject valid users, admit invalid users, or break protected access.`]
      : []),
    ...(stepTypes.has('read_write_storage')
      ? [`${journeyName} can read stale data, fail writes, or corrupt persisted state.`]
      : []),
    ...(stepTypes.has('external_service_call')
      ? [
          `${journeyName} can fail when an external provider contract, token, or network surface changes.`,
        ]
      : []),
    ...(stepTypes.has('rendering_response')
      ? [
          `${journeyName} can render the wrong UI, return the wrong response, or break route output.`,
        ]
      : []),
    ...(stepTypes.has('background_job_async')
      ? [`${journeyName} can drop, delay, or duplicate background processing.`]
      : []),
    ...(stepTypes.has('business_logic')
      ? [`${journeyName} can change user-visible decisions, calculations, or state transitions.`]
      : []),
    ...(stepTypes.has('runtime_config')
      ? [
          `${journeyName} can break through runtime config, routing, environment, build, or deployment drift.`,
        ]
      : []),
    ...(stepTypes.has('test_coverage')
      ? [`${journeyName} confidence changed because linked test evidence changed.`]
      : []),
    ...(stateOperations.has('schema')
      ? [`${journeyName} can break when a schema/model/table contract drifts from callers.`]
      : []),
    ...(stateOperations.has('read')
      ? [`${journeyName} can read stale, missing, or mis-shaped data.`]
      : []),
    ...(stateOperations.has('write') ||
    stateOperations.has('update') ||
    stateOperations.has('delete')
      ? [`${journeyName} can fail to persist, mutate, or delete state correctly.`]
      : []),
    ...(stateOperations.has('cache/session')
      ? [`${journeyName} can serve stale cache/session data or lose session continuity.`]
      : []),
    ...params.affectedDataDependencies.map(
      (dependency) =>
        `${journeyName} depends on ${dependency.label} (${dependency.operations.join(', ') || 'state dependency'}).`,
    ),
    ...flowStringArray(params.flow, 'failure_modes').slice(0, 4),
    ...(params.matchedChangedFiles.length > 0
      ? [
          `Review ${params.matchedChangedFiles.slice(0, 4).join(', ')} before relying on this journey.`,
        ]
      : []),
  ]).map(safeText);
}

type FlowEvidenceCategory =
  | 'entrypoint'
  | 'component'
  | 'content'
  | 'config'
  | 'test'
  | 'dependency'
  | 'source';

function affectedFlowReasons(params: {
  readonly flow: BrainEntity;
  readonly matchedChangedFiles: readonly string[];
  readonly componentChangedFiles: readonly string[];
}): string[] {
  const journey = flowJourneySummaryData(params.flow);
  const routeLabel = reviewFlowDescriptionLabel({
    id: params.flow.id,
    name: params.flow.name,
    ...(journey !== undefined
      ? {
          journey_name: journey.name,
          journey_confidence: journey.confidence,
        }
      : {}),
    kind: flowKind(params.flow),
    ...reviewRouteFlowFields(params.flow),
    confidence: params.flow.confidence,
    score: asFlowConfidenceScore(params.flow),
    entrypoints: reviewFlowEntrypointLabels(params.flow),
    affected_steps: [],
    runtime_surfaces: flowStringArray(params.flow, 'runtime_surfaces'),
    data_dependencies: [],
    user_visible_failure_modes: [],
    missing_evidence: flowJourneySummaryData(params.flow)?.missing_evidence ?? [],
    changed_files: [],
    components: flowStringArray(params.flow, 'components'),
    services: flowStringArray(params.flow, 'services'),
    service_causality: safeFlowServiceCausality(params.flow),
    tests: flowStringArray(params.flow, 'tests'),
    configs: flowStringArray(params.flow, 'configs'),
    risks: flowRisks(params.flow).length,
    evidence_ids: params.flow.evidence_ids,
    reasons: [],
  });
  const reasons = params.matchedChangedFiles.map((file) => {
    const category = flowEvidenceCategoryForFile({
      flow: params.flow,
      file,
      componentChangedFiles: params.componentChangedFiles,
    });
    return `${routeLabel} includes changed ${category} evidence: ${safeText(file)}.`;
  });
  return unique(reasons).slice(0, 8);
}

function flowEvidenceCategoryForFile(params: {
  readonly flow: BrainEntity;
  readonly file: string;
  readonly componentChangedFiles: readonly string[];
}): FlowEvidenceCategory {
  const entrypointFiles = new Set(
    flowEntrypoints(params.flow).map((entrypoint) => entrypoint.path),
  );
  const tests = new Set(flowStringArray(params.flow, 'tests'));
  const configs = new Set(flowStringArray(params.flow, 'configs'));
  if (entrypointFiles.has(params.file)) return 'entrypoint';
  if (tests.has(params.file) || isTestPath(params.file)) return 'test';
  if (configs.has(params.file) || isConfigPath(params.file) || isRouteConfigPath(params.file)) {
    return 'config';
  }
  if (isDependencyPath(params.file)) return 'dependency';
  if (isContentPath(params.file)) return 'content';
  if (params.componentChangedFiles.includes(params.file) || isComponentPath(params.file)) {
    return 'component';
  }
  return 'source';
}

function isContentPath(path: string): boolean {
  return /(^|\/)(content|contents|data)\//i.test(path);
}

function isRouteConfigPath(path: string): boolean {
  return /(^|\/)config\//i.test(path);
}

function isComponentPath(path: string): boolean {
  return /(^|\/)(components|ui)\//i.test(path);
}

function reviewRouteFlowFields(
  flow: BrainEntity,
): Pick<AffectedFlowData, 'framework' | 'route_path' | 'route_type'> {
  const framework = stringData(flow, 'framework');
  const routePath = stringData(flow, 'route_path');
  const routeType = stringData(flow, 'route_type');
  if (framework === undefined && routePath === undefined && routeType === undefined) return {};
  return {
    ...(framework !== undefined ? { framework: safeText(framework) } : {}),
    ...(routePath !== undefined ? { route_path: safeText(routePath) } : {}),
    ...(routeType !== undefined ? { route_type: safeText(routeType) } : {}),
  };
}

function reviewFlowEntrypointLabels(flow: BrainEntity): string[] {
  return flowEntrypoints(flow)
    .map((entrypoint) =>
      entrypoint.symbol === null ? entrypoint.path : `${entrypoint.path}#${entrypoint.symbol}`,
    )
    .map(safeText);
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
  readonly architectureImpactSurfaceCount: number;
  readonly highCouplingImpactSurfaceCount: number;
  readonly architectureConfidenceGapCount: number;
}): BlastRadius {
  if (
    params.fileCount > 12 ||
    params.directComponentCount > 4 ||
    params.dependentComponentCount > 3 ||
    params.flowCount > 5 ||
    params.relationshipCount > 80 ||
    params.architectureImpactSurfaceCount > 5 ||
    params.highCouplingImpactSurfaceCount > 1
  ) {
    return 'broad';
  }
  if (
    params.fileCount > 4 ||
    params.directComponentCount > 1 ||
    params.dependentComponentCount > 0 ||
    params.flowCount > 1 ||
    params.relationshipCount > 40 ||
    params.architectureImpactSurfaceCount > 0 ||
    params.architectureConfidenceGapCount > 0
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
  readonly affectedServices: readonly ReviewAffectedServiceData[];
  readonly affectedRelationships: readonly ReviewAffectedRelationshipData[];
  readonly architectureImpactMap: readonly ReviewArchitectureImpactData[];
  readonly dependencyRuntimeImpact: ReviewDependencyRuntimeImpactData | null;
  readonly affectedTests: readonly string[];
  readonly affectedConfigs: readonly string[];
}): string[] {
  const directNames = params.directComponents.map((component) => component.name);
  const dependentNames = params.dependentComponents.map((component) => component.name);
  const routeFlowReasons = affectedRouteFlowReasons(params.affectedFlows);
  const serviceCausality = params.affectedFlows.flatMap((flow) => flow.service_causality);
  const serviceCausalityEffects = unique(serviceCausality.flatMap((item) => item.effects));
  const impactMapReasons = architectureImpactReasonLines(params.architectureImpactMap);
  const dependencyRuntimeReasons =
    params.dependencyRuntimeImpact === null
      ? []
      : [
          `Dependency/runtime impact links changed package/config files to ${params.dependencyRuntimeImpact.affected_flows.length} flow(s), ${params.dependencyRuntimeImpact.affected_services.length} service(s), ${params.dependencyRuntimeImpact.affected_components.length} component(s), and ${params.dependencyRuntimeImpact.package_scripts.length} package script(s).`,
          `Focused dependency/runtime verification: ${params.dependencyRuntimeImpact.verification_focus.slice(0, 5).join('; ') || 'none recorded'}.`,
        ];
  return [
    `${params.changedFiles.length} changed file(s) map to ${params.directComponents.length} direct component(s): ${directNames.slice(0, 5).join(', ') || 'none'}.`,
    params.dependentComponents.length === 0
      ? 'No dependent consumer components were found from import/call/dependency graph edges.'
      : `${params.dependentComponents.length} dependent consumer component(s) require review: ${dependentNames.slice(0, 5).join(', ')}.`,
    `${params.affectedFlows.length} affected flow(s) link the change to ${params.affectedTests.length} test artifact(s) and ${params.affectedConfigs.length} config artifact(s).`,
    serviceCausality.length === 0
      ? 'No service causality path was recorded for the affected flows.'
      : `${serviceCausality.length} service causality path(s) explain flow-to-service blast radius; effects: ${serviceCausalityEffects.slice(0, 6).join(', ') || 'none recorded'}.`,
    `${params.affectedServices.length} affected service(s) link the change to routes, jobs, storage, external API, env, or deployment evidence.`,
    ...routeFlowReasons,
    ...impactMapReasons,
    ...dependencyRuntimeReasons,
    `${params.affectedRelationships.length} graph relationship(s) touch the review blast radius.`,
  ].map(safeText);
}

function architectureImpactReasonLines(entries: readonly ReviewArchitectureImpactData[]): string[] {
  if (entries.length === 0) {
    return ['No architecture impact-map surfaces overlapped this review diff.'];
  }
  const affectedTests = unique(entries.flatMap((entry) => entry.affected_tests));
  const affectedConfigs = unique(entries.flatMap((entry) => entry.affected_configs));
  const evidenceGapIds = unique(entries.flatMap((entry) => entry.evidence_gap_ids));
  const confidenceGaps = entries.filter((entry) => entry.confidence !== 'verified');
  return [
    `${entries.length} architecture impact-map surface(s) overlap the diff: ${entries
      .map((entry) => entry.impact_id)
      .slice(0, 5)
      .join(', ')}.`,
    ...entries.slice(0, 5).map((entry) => {
      const routeLabel =
        entry.route_path === undefined
          ? entry.name
          : `${entry.route_path} ${entry.route_type ?? ''}`;
      const whatBreaks = entry.what_breaks.slice(0, 2).join(' ');
      return `${entry.impact_id} connects changed files/components/routes to ${routeLabel}; coupling:${entry.coupling_level}; dependent components:${entry.dependent_components.length}; what breaks: ${whatBreaks || 'no note recorded'}.`;
    }),
    `Architecture impact-map linked tests/configs: tests ${affectedTests.slice(0, 5).join(', ') || 'none'}; configs ${affectedConfigs.slice(0, 5).join(', ') || 'none'}.`,
    confidenceGaps.length === 0 && evidenceGapIds.length === 0
      ? 'Architecture impact-map confidence has no matched evidence gap recorded.'
      : `Architecture impact-map confidence gaps: ${
          confidenceGaps
            .map((entry) => `${entry.impact_id}:${entry.confidence}`)
            .slice(0, 5)
            .join(', ') || 'none'
        }; evidence gaps: ${evidenceGapIds.slice(0, 5).join(', ') || 'none'}.`,
  ];
}

function affectedRouteFlowReasons(flows: readonly AffectedFlowData[]): string[] {
  return flows
    .filter((flow) => flow.route_path !== undefined || flow.framework === 'nextjs-app-router')
    .slice(0, 5)
    .map((flow) => {
      const routePath = flow.route_path ?? flow.name;
      const routeType = flow.route_type ?? flow.kind;
      const linkedTests = flow.tests.slice(0, 3);
      const linkedConfigs = flow.configs.slice(0, 3);
      const artifactSummary = reviewRouteArtifactSummary(linkedTests, linkedConfigs);
      const entrypointSummary = reviewRouteListSummary('Entrypoints', flow.entrypoints);
      const componentSummary = reviewRouteListSummary('Components', flow.components);
      const reasonSummary = reviewRouteListSummary('Causality', flow.reasons, 5);
      return `${routePath} route flow (${routeType}) is affected through ${flow.changed_files.length} changed file(s): ${flow.changed_files.slice(0, 5).join(', ')}. ${reasonSummary} ${entrypointSummary} ${componentSummary} ${artifactSummary}`;
    });
}

function reviewRouteListSummary(label: string, values: readonly string[], limit = 3): string {
  const visibleValues = values.slice(0, limit);
  if (visibleValues.length === 0) return `${label}: none recorded.`;
  return `${label}: ${visibleValues.join(', ')}.`;
}

function reviewRouteArtifactSummary(
  linkedTests: readonly string[],
  linkedConfigs: readonly string[],
): string {
  if (linkedTests.length === 0 && linkedConfigs.length === 0) {
    return 'No linked test or config artifact was recorded.';
  }
  const summaries = [
    linkedTests.length > 0 ? `Linked tests: ${linkedTests.join(', ')}` : undefined,
    linkedConfigs.length > 0 ? `Linked configs: ${linkedConfigs.join(', ')}` : undefined,
  ].filter((summary): summary is string => summary !== undefined);
  return `${summaries.join('. ')}.`;
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
  dependencyRuntimeImpact: ReviewDependencyRuntimeImpactData | null,
  blastRadiusReasons: readonly string[],
): string[] {
  const categories = findings.map((finding) => finding.category);
  const componentNames = components.map((component) => component.name);
  const dependentNames = dependentComponents.map((component) => component.name);
  return uniqueInOrder([
    ...categories,
    ...componentNames.map((name) => `component: ${name}`),
    ...dependentNames.map((name) => `dependent component: ${name}`),
    ...affectedFlows.map(reviewFlowFocusLabel),
    ...affectedFlows.flatMap(reviewFlowCausalityFocusLabels),
    ...(dependencyRuntimeImpact === null
      ? []
      : [
          ...dependencyRuntimeImpact.runtime_surfaces.map(
            (surface) => `dependency/runtime: ${surface}`,
          ),
          ...dependencyRuntimeImpact.verification_focus.slice(0, 4),
        ]),
    ...blastRadiusReasons.slice(0, 2),
    ...(changedFiles.some(isDependencyPath) ? ['install/package behavior'] : []),
    ...(changedFiles.some(isConfigPath) ? ['configuration and CI behavior'] : []),
  ]).slice(0, 12);
}

function reviewFlowFocusLabel(flow: AffectedFlowData): string {
  if (flow.route_path !== undefined) return `route flow: ${flow.route_path}`;
  return `flow: ${flow.name}`;
}

function reviewFlowCausalityFocusLabels(flow: AffectedFlowData): string[] {
  const routeLabels =
    flow.route_path === undefined
      ? []
      : flow.reasons
          .map((reason) => routeEvidenceCategoryFromReason(reason))
          .filter((category): category is FlowEvidenceCategory => category !== undefined)
          .map((category) => `route flow: ${flow.route_path} ${category} evidence`);
  const serviceLabels = flow.service_causality.map(
    (item) => `flow service causality: ${item.service_id}`,
  );
  return [...routeLabels, ...serviceLabels];
}

function routeEvidenceCategoryFromReason(reason: string): FlowEvidenceCategory | undefined {
  const match =
    /changed (entrypoint|component|content|config|test|dependency|source) evidence/.exec(reason);
  if (match === null) return undefined;
  const category = match[1];
  if (
    category === 'entrypoint' ||
    category === 'component' ||
    category === 'content' ||
    category === 'config' ||
    category === 'test' ||
    category === 'dependency' ||
    category === 'source'
  ) {
    return category;
  }
  return undefined;
}

function reviewFlowDescriptionLabel(flow: AffectedFlowData): string {
  const label = flow.journey_name ?? flow.name;
  if (flow.route_path !== undefined) {
    const routeType = flow.route_type ?? flow.kind;
    return `${label} (${flow.route_path} ${routeType})`;
  }
  return label;
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
  return `<table><thead><tr><th>Journey</th><th>Affected Steps</th><th>State/Data Impact</th><th>User-Visible Risk</th><th>Runtime Surfaces</th><th>Changed Files</th><th>Components</th><th>Services</th><th>Tests / Configs</th><th>Confidence</th></tr></thead><tbody>${flows
    .map(
      (flow) => `<tr>
        <td><strong>${htmlEscape(flow.journey_name ?? flow.name)}</strong><br><span class="muted">${htmlEscape(reviewFlowTableMeta(flow))}</span></td>
        <td>${renderList(flow.affected_steps.map(formatJourneyStepForReview))}</td>
        <td>${renderList(flow.data_dependencies.map(formatDataDependencyForReview))}</td>
        <td>${renderList(flow.user_visible_failure_modes)}</td>
        <td>${renderList(flow.runtime_surfaces)}</td>
        <td>${renderList(flow.changed_files)}</td>
        <td>${renderList(flow.components)}</td>
        <td>${renderList(flow.services)}</td>
        <td>${renderList([...flow.tests, ...flow.configs, ...flow.missing_evidence])}</td>
        <td>${htmlEscape(flow.confidence)} · ${flow.score}</td>
      </tr>`,
    )
    .join('')}</tbody></table>`;
}

function formatJourneyStepForReview(step: FlowJourneyStep): string {
  const files = step.files.length === 0 ? 'no files' : step.files.slice(0, 3).join(', ');
  return `${step.label}: ${files} (${step.confidence})`;
}

function formatDataDependencyForReview(dependency: FlowDataDependency): string {
  const files =
    dependency.files.length === 0 ? 'no files' : dependency.files.slice(0, 3).join(', ');
  const operations =
    dependency.operations.length === 0 ? 'state dependency' : dependency.operations.join(', ');
  return `${dependency.label}: ${operations}; ${files} (${dependency.confidence})`;
}

function renderAffectedServiceRows(services: readonly ReviewAffectedServiceData[]): string {
  if (services.length === 0) {
    return '<p class="muted">No service intelligence overlaps this diff.</p>';
  }
  return `<table><thead><tr><th>Service</th><th>Reasons</th><th>Changed Files</th><th>Flows</th><th>Tests / Configs</th><th>Routes / Jobs</th><th>Storage / Env / External / Deploy</th><th>Risks</th></tr></thead><tbody>${services
    .map(
      (service) => `<tr>
        <td><strong>${htmlEscape(service.name)}</strong><br><span class="muted">${htmlEscape(
          service.id,
        )} · ${htmlEscape(service.framework)} · ${htmlEscape(service.confidence)}</span></td>
        <td>${renderList(service.reasons)}</td>
        <td>${renderList(service.changed_files)}</td>
        <td>${renderList(service.affected_flows)}</td>
        <td>${renderList([...service.tests, ...service.configs])}</td>
        <td>${renderList([...service.routes, ...service.jobs])}</td>
        <td>${renderList([
          ...service.storage_dependencies,
          ...service.environment_variables,
          ...service.external_services,
          ...service.deployment_configs,
        ])}</td>
        <td>${renderList(service.risks)}</td>
      </tr>`,
    )
    .join('')}</tbody></table>`;
}

function renderDependencyRuntimeImpact(impact: ReviewDependencyRuntimeImpactData | null): string {
  if (impact === null) {
    return '<p class="muted">No dependency or runtime package/config impact was detected for this diff.</p>';
  }
  return `<table><thead><tr><th>Changed Package / Config</th><th>Runtime Surfaces</th><th>Components / Services / Flows</th><th>Scripts</th><th>Focused Verification</th></tr></thead><tbody><tr>
    <td>${renderList(impact.changed_files)}</td>
    <td>${renderList(impact.runtime_surfaces)}</td>
    <td>${renderList([
      ...impact.affected_components,
      ...impact.affected_services,
      ...impact.affected_flows,
    ])}</td>
    <td>${renderList(
      impact.package_scripts.map(
        (script) => `${script.manifest}#${script.name} (${script.category}): ${script.command}`,
      ),
    )}</td>
    <td>${renderList(impact.verification_focus)}</td>
  </tr></tbody></table>
  ${renderList(impact.reasons)}`;
}

function reviewFlowTableMeta(flow: AffectedFlowData): string {
  const route =
    flow.route_path !== undefined ? ` · ${flow.route_path} ${flow.route_type ?? 'route'}` : '';
  const journey =
    flow.journey_confidence === undefined ? '' : ` · journey ${flow.journey_confidence}`;
  return `${flow.id} · ${flow.kind}${route}${journey}`;
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

function renderVerificationPlanRows(plan: readonly ReviewVerificationPlanItemData[]): string {
  if (plan.length === 0) {
    return '<p class="muted">No targeted verification plan was generated for this review.</p>';
  }
  return `<table><thead><tr><th>Priority</th><th>Type</th><th>Reason</th><th>Commands</th><th>Manual Checks</th><th>Linked Evidence</th></tr></thead><tbody>${plan
    .map(
      (item) => `<tr>
        <td>${htmlEscape(item.priority)}</td>
        <td>${htmlEscape(item.verification_type)}</td>
        <td>${htmlEscape(item.reason)}</td>
        <td>${renderList(item.commands)}</td>
        <td>${renderList(item.manual_checks)}</td>
        <td>${renderList([
          ...item.linked_findings,
          ...item.linked_flows,
          ...item.linked_components,
          ...item.linked_files,
          ...item.evidence_ids,
        ])}</td>
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
      <article class="card"><h2>Affected Services</h2><p>${review.affected_services.length}</p></article>
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
      <h2>Verification Calibration</h2>
      <div class="grid">
        <article class="card"><h2>Recorded Checks</h2><p>${review.verification_status.total_checks}</p></article>
        <article class="card"><h2>Passed</h2><p>${review.verification_status.passed_checks.length}</p></article>
        <article class="card"><h2>Failed</h2><p>${review.verification_status.failed_checks.length}</p></article>
        <article class="card"><h2>Production Smoke</h2><p>${review.verification_status.production_checks_passed.length}</p></article>
      </div>
      <p class="muted">${htmlEscape(review.verification_status.calibration_note)}</p>
      <h3>Risks Reduced</h3>
      ${renderList(review.verification_status.risks_reduced)}
      <h3>Remaining Unknowns</h3>
      ${renderList(review.verification_status.remaining_unknowns)}
    </section>
    <section>
      <h2>Targeted Verification</h2>
      ${renderVerificationPlanRows(review.verification_plan)}
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
      <h2>Affected Services</h2>
      ${renderAffectedServiceRows(review.affected_services)}
    </section>
    <section>
      <h2>Dependency Runtime Impact</h2>
      ${renderDependencyRuntimeImpact(review.dependency_runtime_impact)}
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
      <h2>Research Artifacts</h2>
      ${renderArtifactLinks([
        '.rizz/research/review_eval.json',
        '.rizz/research/review_claim_evidence.json',
        '.rizz/research/verification_evidence.json',
      ])}
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
