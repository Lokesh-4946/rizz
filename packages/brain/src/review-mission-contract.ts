import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

export type ReviewMissionContractSource = 'none' | 'inline' | 'file';
export type ReviewMissionContractLoadStatus = 'absent' | 'loaded' | 'invalid';
export type ReviewMissionScopeStatus = 'absent' | 'insufficient' | 'matched' | 'mismatch';

export interface ReviewMissionContract {
  readonly id?: string;
  readonly summary?: string;
  readonly target_branch?: string;
  readonly allowed_path_prefixes?: readonly string[];
  readonly allowed_files?: readonly string[];
  readonly forbidden_path_prefixes?: readonly string[];
  readonly expected_scope_clusters?: readonly string[];
  readonly expected_components?: readonly string[];
  readonly expected_services?: readonly string[];
  readonly expected_flows?: readonly string[];
  readonly allow_generated_artifacts?: boolean;
  readonly max_reviewable_files?: number;
  readonly max_scope_clusters?: number;
  readonly required_checks?: readonly string[];
}

export interface ReviewMissionContractLoad {
  readonly source: ReviewMissionContractSource;
  readonly status: ReviewMissionContractLoadStatus;
  readonly path?: string;
  readonly contract: ReviewMissionContract | null;
  readonly warnings: readonly string[];
}

export interface ReviewMissionComparisonData {
  readonly status: ReviewMissionScopeStatus;
  readonly score: number;
  readonly source: ReviewMissionContractSource;
  readonly contract_id: string | null;
  readonly summary: string | null;
  readonly contract_path: string | null;
  readonly compared_fields: readonly string[];
  readonly matched_paths: readonly string[];
  readonly violating_paths: readonly string[];
  readonly forbidden_paths: readonly string[];
  readonly unexpected_scope_clusters: readonly string[];
  readonly missing_expected_scope_clusters: readonly string[];
  readonly missing_expected_components: readonly string[];
  readonly missing_expected_services: readonly string[];
  readonly missing_expected_flows: readonly string[];
  readonly generated_artifact_violations: readonly string[];
  readonly version_control_mismatches: readonly string[];
  readonly required_checks: readonly string[];
  readonly warnings: readonly string[];
  readonly agent_next_actions: readonly string[];
}

function boundedScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  );
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contractFromRecord(value: Record<string, unknown>): ReviewMissionContract {
  const id = stringValue(value.id);
  const summary = stringValue(value.summary);
  const targetBranch = stringValue(value.target_branch);
  const allowedPathPrefixes = stringArrayValue(value.allowed_path_prefixes).map(normalizePath);
  const allowedFiles = stringArrayValue(value.allowed_files).map(normalizePath);
  const forbiddenPathPrefixes = stringArrayValue(value.forbidden_path_prefixes).map(normalizePath);
  const expectedScopeClusters = stringArrayValue(value.expected_scope_clusters).map(normalizePath);
  const expectedComponents = stringArrayValue(value.expected_components);
  const expectedServices = stringArrayValue(value.expected_services);
  const expectedFlows = stringArrayValue(value.expected_flows);
  const allowGeneratedArtifacts = booleanValue(value.allow_generated_artifacts);
  const maxReviewableFiles = positiveIntegerValue(value.max_reviewable_files);
  const maxScopeClusters = positiveIntegerValue(value.max_scope_clusters);
  const requiredChecks = stringArrayValue(value.required_checks);
  return {
    ...(id !== undefined ? { id } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(targetBranch !== undefined ? { target_branch: targetBranch } : {}),
    ...(allowedPathPrefixes.length > 0 ? { allowed_path_prefixes: allowedPathPrefixes } : {}),
    ...(allowedFiles.length > 0 ? { allowed_files: allowedFiles } : {}),
    ...(forbiddenPathPrefixes.length > 0 ? { forbidden_path_prefixes: forbiddenPathPrefixes } : {}),
    ...(expectedScopeClusters.length > 0 ? { expected_scope_clusters: expectedScopeClusters } : {}),
    ...(expectedComponents.length > 0 ? { expected_components: expectedComponents } : {}),
    ...(expectedServices.length > 0 ? { expected_services: expectedServices } : {}),
    ...(expectedFlows.length > 0 ? { expected_flows: expectedFlows } : {}),
    ...(allowGeneratedArtifacts !== undefined
      ? { allow_generated_artifacts: allowGeneratedArtifacts }
      : {}),
    ...(maxReviewableFiles !== undefined ? { max_reviewable_files: maxReviewableFiles } : {}),
    ...(maxScopeClusters !== undefined ? { max_scope_clusters: maxScopeClusters } : {}),
    ...(requiredChecks.length > 0 ? { required_checks: requiredChecks } : {}),
  };
}

function parseMissionText(text: string): {
  readonly contract: ReviewMissionContract | null;
  readonly warning?: string;
} {
  const trimmed = text.trim();
  if (trimmed === '') return { contract: null, warning: 'Mission contract input was empty.' };
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        return { contract: null, warning: 'Mission contract JSON must be an object.' };
      }
      return { contract: contractFromRecord(parsed) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { contract: null, warning: `Mission contract JSON could not be parsed: ${message}` };
    }
  }
  return {
    contract: { id: 'inline-mission', summary: trimmed },
    warning:
      'Inline mission text has no deterministic path or entity boundaries; add allowed_path_prefixes, allowed_files, or expected_scope_clusters for scope comparison.',
  };
}

function displayMissionPath(rootDir: string, path: string): string {
  const local = relative(rootDir, path).replace(/\\/g, '/');
  return local === '' || local.startsWith('..') ? path : local;
}

export function loadReviewMissionContract(params: {
  readonly rootDir: string;
  readonly mission?: string;
  readonly missionFile?: string;
  readonly sanitizeText: (value: string) => string;
}): ReviewMissionContractLoad {
  if (params.mission !== undefined) {
    const parsed = parseMissionText(params.mission);
    return {
      source: 'inline',
      status: parsed.contract === null ? 'invalid' : 'loaded',
      contract: parsed.contract,
      warnings: parsed.warning === undefined ? [] : [params.sanitizeText(parsed.warning)],
    };
  }
  const filePath =
    params.missionFile !== undefined
      ? params.missionFile
      : existsSync(join(params.rootDir, '.rizz', 'mission-contract.json'))
        ? join(params.rootDir, '.rizz', 'mission-contract.json')
        : undefined;
  if (filePath === undefined) {
    return { source: 'none', status: 'absent', contract: null, warnings: [] };
  }
  const absolutePath = isAbsolute(filePath) ? filePath : join(params.rootDir, filePath);
  try {
    const parsed = parseMissionText(readFileSync(absolutePath, 'utf8'));
    return {
      source: 'file',
      status: parsed.contract === null ? 'invalid' : 'loaded',
      path: params.sanitizeText(displayMissionPath(params.rootDir, absolutePath)),
      contract: parsed.contract,
      warnings: parsed.warning === undefined ? [] : [params.sanitizeText(parsed.warning)],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      source: 'file',
      status: 'invalid',
      path: params.sanitizeText(displayMissionPath(params.rootDir, absolutePath)),
      contract: null,
      warnings: [params.sanitizeText(`Mission contract file could not be read: ${message}`)],
    };
  }
}

function matchesPathPrefix(path: string, prefix: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPrefix = normalizePath(prefix).replace(/\/\*\*$/, '');
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function pathAllowed(path: string, contract: ReviewMissionContract): boolean {
  const allowedFiles = contract.allowed_files ?? [];
  const allowedPrefixes = contract.allowed_path_prefixes ?? [];
  if (allowedFiles.length === 0 && allowedPrefixes.length === 0) return true;
  const normalizedPath = normalizePath(path);
  return (
    allowedFiles.some((file) => normalizePath(file) === normalizedPath) ||
    allowedPrefixes.some((prefix) => matchesPathPrefix(normalizedPath, prefix))
  );
}

function pathForbidden(path: string, contract: ReviewMissionContract): boolean {
  return (contract.forbidden_path_prefixes ?? []).some((prefix) => matchesPathPrefix(path, prefix));
}

function hasDeterministicBoundary(contract: ReviewMissionContract): boolean {
  return (
    (contract.allowed_files ?? []).length > 0 ||
    (contract.allowed_path_prefixes ?? []).length > 0 ||
    (contract.forbidden_path_prefixes ?? []).length > 0 ||
    (contract.expected_scope_clusters ?? []).length > 0 ||
    (contract.expected_components ?? []).length > 0 ||
    (contract.expected_services ?? []).length > 0 ||
    (contract.expected_flows ?? []).length > 0 ||
    contract.max_reviewable_files !== undefined ||
    contract.max_scope_clusters !== undefined
  );
}

function missingExpected(
  expected: readonly string[] | undefined,
  actual: readonly string[],
): string[] {
  if (expected === undefined || expected.length === 0) return [];
  const actualSet = new Set(actual);
  return expected.filter((item) => !actualSet.has(item));
}

export function compareReviewMissionContract(params: {
  readonly mission: ReviewMissionContractLoad;
  readonly baseRef: string;
  readonly changedFiles: readonly string[];
  readonly reviewableChangedFiles: readonly string[];
  readonly generatedArtifacts: readonly string[];
  readonly scopeClusters: readonly string[];
  readonly affectedComponentIds: readonly string[];
  readonly affectedServiceIds: readonly string[];
  readonly affectedFlowIds: readonly string[];
  readonly sanitizeText: (value: string) => string;
}): ReviewMissionComparisonData {
  const contract = params.mission.contract;
  if (contract === null) {
    const invalidWarnings = params.mission.status === 'invalid' ? params.mission.warnings : [];
    return {
      status: params.mission.status === 'invalid' ? 'mismatch' : 'absent',
      score: params.mission.status === 'invalid' ? 40 : 70,
      source: params.mission.source,
      contract_id: null,
      summary: null,
      contract_path: params.mission.path ?? null,
      compared_fields: [],
      matched_paths: [],
      violating_paths: [],
      forbidden_paths: [],
      unexpected_scope_clusters: [],
      missing_expected_scope_clusters: [],
      missing_expected_components: [],
      missing_expected_services: [],
      missing_expected_flows: [],
      generated_artifact_violations: [],
      version_control_mismatches: [],
      required_checks: [],
      warnings: invalidWarnings,
      agent_next_actions:
        params.mission.status === 'invalid'
          ? invalidWarnings.map((warning) => `Repair mission contract: ${warning}`)
          : [
              'Add .rizz/mission-contract.json or pass --mission-file so review can compare the diff against human-approved scope.',
            ],
    };
  }
  const comparedFields = unique([
    ...((contract.allowed_files ?? []).length > 0 ? ['allowed_files'] : []),
    ...((contract.allowed_path_prefixes ?? []).length > 0 ? ['allowed_path_prefixes'] : []),
    ...((contract.forbidden_path_prefixes ?? []).length > 0 ? ['forbidden_path_prefixes'] : []),
    ...((contract.expected_scope_clusters ?? []).length > 0 ? ['expected_scope_clusters'] : []),
    ...((contract.expected_components ?? []).length > 0 ? ['expected_components'] : []),
    ...((contract.expected_services ?? []).length > 0 ? ['expected_services'] : []),
    ...((contract.expected_flows ?? []).length > 0 ? ['expected_flows'] : []),
    ...(contract.max_reviewable_files !== undefined ? ['max_reviewable_files'] : []),
    ...(contract.max_scope_clusters !== undefined ? ['max_scope_clusters'] : []),
    ...(contract.target_branch !== undefined ? ['target_branch'] : []),
    ...(contract.allow_generated_artifacts !== undefined ? ['allow_generated_artifacts'] : []),
    ...((contract.required_checks ?? []).length > 0 ? ['required_checks'] : []),
  ]);
  const matchedPaths = params.reviewableChangedFiles.filter((file) => pathAllowed(file, contract));
  const violatingPaths = params.reviewableChangedFiles.filter(
    (file) => !pathAllowed(file, contract),
  );
  const forbiddenPaths = params.reviewableChangedFiles.filter((file) =>
    pathForbidden(file, contract),
  );
  const expectedClusters = contract.expected_scope_clusters ?? [];
  const unexpectedScopeClusters =
    expectedClusters.length === 0
      ? []
      : params.scopeClusters.filter((cluster) => !expectedClusters.includes(cluster));
  const generatedArtifactViolations =
    contract.allow_generated_artifacts === false ? params.generatedArtifacts : [];
  const versionControlMismatches =
    contract.target_branch !== undefined && contract.target_branch !== params.baseRef
      ? [
          `Mission target branch is ${contract.target_branch}, but review base is ${params.baseRef}.`,
        ]
      : [];
  const maxReviewableViolation =
    contract.max_reviewable_files !== undefined &&
    params.reviewableChangedFiles.length > contract.max_reviewable_files
      ? [
          `Mission allows at most ${contract.max_reviewable_files} reviewable file(s), but ${params.reviewableChangedFiles.length} changed.`,
        ]
      : [];
  const maxScopeViolation =
    contract.max_scope_clusters !== undefined &&
    params.scopeClusters.length > contract.max_scope_clusters
      ? [
          `Mission allows at most ${contract.max_scope_clusters} scope cluster(s), but ${params.scopeClusters.length} changed.`,
        ]
      : [];
  const missingExpectedScopeClusters = missingExpected(
    contract.expected_scope_clusters,
    params.scopeClusters,
  );
  const missingExpectedComponents = missingExpected(
    contract.expected_components,
    params.affectedComponentIds,
  );
  const missingExpectedServices = missingExpected(
    contract.expected_services,
    params.affectedServiceIds,
  );
  const missingExpectedFlows = missingExpected(contract.expected_flows, params.affectedFlowIds);
  const warnings = unique([
    ...params.mission.warnings,
    ...(!hasDeterministicBoundary(contract)
      ? [
          'Mission contract has no deterministic path, scope, or entity boundary; review can record intent but cannot prove scope fit.',
        ]
      : []),
    ...((contract.required_checks ?? []).length > 0
      ? [
          'Mission required checks are recorded for verification; rizz review needs recorded evidence before treating them as proof.',
        ]
      : []),
  ]);
  const issueCount =
    violatingPaths.length +
    forbiddenPaths.length +
    unexpectedScopeClusters.length +
    generatedArtifactViolations.length +
    versionControlMismatches.length +
    maxReviewableViolation.length +
    maxScopeViolation.length +
    missingExpectedScopeClusters.length +
    missingExpectedComponents.length +
    missingExpectedServices.length +
    missingExpectedFlows.length;
  const status: ReviewMissionScopeStatus =
    issueCount > 0 ? 'mismatch' : hasDeterministicBoundary(contract) ? 'matched' : 'insufficient';
  return {
    status,
    score: boundedScore(
      status === 'matched'
        ? 100
        : status === 'insufficient'
          ? 65
          : 100 - Math.min(75, issueCount * 12 + warnings.length * 5),
    ),
    source: params.mission.source,
    contract_id: params.sanitizeText(contract.id ?? 'mission-contract'),
    summary: contract.summary === undefined ? null : params.sanitizeText(contract.summary),
    contract_path: params.mission.path ?? null,
    compared_fields: comparedFields.map(params.sanitizeText),
    matched_paths: matchedPaths.map(params.sanitizeText),
    violating_paths: unique(violatingPaths.map(params.sanitizeText)),
    forbidden_paths: unique(forbiddenPaths.map(params.sanitizeText)),
    unexpected_scope_clusters: unique(unexpectedScopeClusters.map(params.sanitizeText)),
    missing_expected_scope_clusters: unique(missingExpectedScopeClusters.map(params.sanitizeText)),
    missing_expected_components: unique(missingExpectedComponents.map(params.sanitizeText)),
    missing_expected_services: unique(missingExpectedServices.map(params.sanitizeText)),
    missing_expected_flows: unique(missingExpectedFlows.map(params.sanitizeText)),
    generated_artifact_violations: unique(generatedArtifactViolations.map(params.sanitizeText)),
    version_control_mismatches: unique(versionControlMismatches.map(params.sanitizeText)),
    required_checks: (contract.required_checks ?? []).map(params.sanitizeText),
    warnings: warnings.map(params.sanitizeText),
    agent_next_actions: unique([
      ...violatingPaths.map(
        (path) => `Move or justify out-of-mission file: ${params.sanitizeText(path)}`,
      ),
      ...forbiddenPaths.map(
        (path) => `Remove forbidden mission-scope change: ${params.sanitizeText(path)}`,
      ),
      ...unexpectedScopeClusters.map(
        (cluster) => `Confirm unexpected mission scope cluster: ${params.sanitizeText(cluster)}`,
      ),
      ...generatedArtifactViolations.map(
        (path) => `Confirm generated artifact is mission-approved: ${params.sanitizeText(path)}`,
      ),
      ...versionControlMismatches.map(
        (signal) => `Resolve mission target mismatch: ${params.sanitizeText(signal)}`,
      ),
      ...maxReviewableViolation.map(params.sanitizeText),
      ...maxScopeViolation.map(params.sanitizeText),
      ...missingExpectedScopeClusters.map(
        (cluster) =>
          `Inspect why expected scope cluster was not touched: ${params.sanitizeText(cluster)}`,
      ),
      ...missingExpectedComponents.map(
        (component) =>
          `Inspect why expected component was not affected: ${params.sanitizeText(component)}`,
      ),
      ...missingExpectedServices.map(
        (service) =>
          `Inspect why expected service was not affected: ${params.sanitizeText(service)}`,
      ),
      ...missingExpectedFlows.map(
        (flow) => `Inspect why expected flow was not affected: ${params.sanitizeText(flow)}`,
      ),
      ...warnings.map((warning) => `Clarify mission contract: ${params.sanitizeText(warning)}`),
    ]).slice(0, 10),
  };
}
