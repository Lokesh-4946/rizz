import { basename, extname } from 'node:path';

export type RelevanceConfidence = 'verified' | 'direct' | 'inferred' | 'uncertain';

export interface TaskAnchors {
  readonly exact: ReadonlySet<string>;
  readonly terms: ReadonlySet<string>;
}

export interface RelevanceCandidate {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly confidence?: string;
  readonly sourceFiles: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly matchKind?: 'changed-file' | 'test-neighbor';
}

export interface RelevanceParams {
  readonly anchors: TaskAnchors;
  readonly candidate: RelevanceCandidate;
}

export interface RelevanceDecision {
  readonly admitted: boolean;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly confidence: RelevanceConfidence;
  readonly causal_path: readonly string[];
  readonly error_code?: 'REVIEW_SCOPE_UNEXPLAINED';
}

export interface CausalNeighborParams {
  readonly causalPath: readonly string[];
  readonly edgeConfidence: readonly RelevanceConfidence[];
  readonly inventoryOnlyEdges?: readonly number[];
}

const COMMON_TASK_TERMS = new Set([
  'add',
  'change',
  'code',
  'command',
  'component',
  'config',
  'create',
  'data',
  'docs',
  'documentation',
  'file',
  'fix',
  'folder',
  'function',
  'handling',
  'implement',
  'issue',
  'method',
  'module',
  'package',
  'path',
  'project',
  'release',
  'repository',
  'review',
  'route',
  'router',
  'script',
  'service',
  'software',
  'state',
  'test',
  'tests',
  'update',
]);

function normalize(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function lexicalTerms(value: string): string[] {
  return normalize(value)
    .split(/[^\p{L}\p{N}_]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !COMMON_TASK_TERMS.has(term));
}

function exactTaskValues(task: string): string[] {
  const values = new Set<string>();
  for (const match of task.matchAll(/[`'"]([^`'"]+)[`'"]/gu)) {
    const value = normalize(match[1] ?? '');
    if (value !== '') values.add(value);
  }
  for (const match of task.matchAll(/[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)+/gu)) {
    const path = normalize(match[0]);
    values.add(path);
    values.add(normalize(basename(path)));
  }
  for (const match of task.matchAll(
    /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Za-z0-9]*|[A-Za-z0-9]+_[A-Za-z0-9_]+)\b/g,
  )) {
    const value = normalize(match[0]);
    if (!COMMON_TASK_TERMS.has(value)) values.add(value);
  }
  return [...values].filter((value) => value !== '').sort();
}

export function extractTaskAnchors(task: string): TaskAnchors {
  const exact = new Set(exactTaskValues(task));
  const terms = new Set(lexicalTerms(task).filter((term) => !exact.has(term)));
  return { exact, terms };
}

function candidateExactValues(candidate: RelevanceCandidate): ReadonlySet<string> {
  const values = new Set<string>();
  const addPathIdentity = (value: string): void => {
    const normalized = normalize(value);
    values.add(normalized);
    const filename = normalize(basename(normalized));
    values.add(filename);
    const extension = extname(filename);
    if (extension !== '') values.add(filename.slice(0, -extension.length));
  };
  const id = normalize(candidate.id);
  addPathIdentity(id);
  addPathIdentity(id.includes(':') ? (id.split(':').slice(1).join(':') ?? id) : id);
  addPathIdentity(candidate.name);
  for (const sourceFile of candidate.sourceFiles) addPathIdentity(sourceFile);
  return values;
}

function normalizedConfidence(confidence: string | undefined): RelevanceConfidence {
  if (
    confidence === 'verified' ||
    confidence === 'direct' ||
    confidence === 'inferred' ||
    confidence === 'uncertain'
  ) {
    return confidence;
  }
  return 'uncertain';
}

export function decideTaskRelevance(params: RelevanceParams): RelevanceDecision {
  const exactValues = candidateExactValues(params.candidate);
  const exactMatches = [...params.anchors.exact].filter((anchor) => exactValues.has(anchor)).sort();
  const searchableTerms = new Set(
    lexicalTerms(`${params.candidate.id} ${params.candidate.name} ${params.candidate.description}`),
  );
  const termMatches = [...params.anchors.terms].filter((term) => searchableTerms.has(term)).sort();
  let directScore = 0;
  if (params.candidate.matchKind === 'changed-file') directScore = 1_000;
  else if (params.candidate.matchKind === 'test-neighbor') directScore = 900;
  const directReasons =
    params.candidate.matchKind === undefined ? [] : [`direct:${params.candidate.matchKind}`];
  const isAggregateFolder = params.candidate.type === 'folder';
  const isExplicitFolder = isAggregateFolder && exactMatches.length > 0;
  const admitted =
    directReasons.length > 0 ||
    exactMatches.length > 0 ||
    (!isAggregateFolder && termMatches.length >= 2);
  const reasons = [
    ...directReasons,
    ...exactMatches.map((value) => `exact:${value}`),
    ...termMatches.map((value) => `term:${value}`),
  ];
  if (!admitted && reasons.length === 0) reasons.push('no-strong-anchor');
  if (isAggregateFolder && !isExplicitFolder && termMatches.length > 0)
    reasons.push('aggregate-folder-not-explicitly-anchored');
  return {
    admitted,
    score:
      directScore +
      exactMatches.length * 100 +
      termMatches.length * 10 -
      (isAggregateFolder ? 25 : 0),
    reasons,
    confidence: normalizedConfidence(params.candidate.confidence),
    causal_path: [],
  };
}

function rejectedCausalDecision(params: CausalNeighborParams, reason: string): RelevanceDecision {
  return {
    admitted: false,
    score: 0,
    reasons: [reason],
    confidence: 'uncertain',
    causal_path: params.causalPath,
    error_code: 'REVIEW_SCOPE_UNEXPLAINED',
  };
}

export function admitCausalNeighbor(params: CausalNeighborParams): RelevanceDecision {
  if (
    params.edgeConfidence.length === 0 ||
    params.edgeConfidence.length !== params.causalPath.length - 1
  ) {
    return rejectedCausalDecision(params, 'causal-path-invalid');
  }
  if (params.edgeConfidence.length > 2) {
    return rejectedCausalDecision(params, 'causal-path-exceeds-two-edges');
  }
  if ((params.inventoryOnlyEdges?.length ?? 0) > 0) {
    return rejectedCausalDecision(params, 'causal-path-inventory-only');
  }
  const weakConfidence = params.edgeConfidence.find(
    (confidence) => confidence === 'inferred' || confidence === 'uncertain',
  );
  if (weakConfidence !== undefined) {
    return rejectedCausalDecision(params, `causal-path-confidence:${weakConfidence}`);
  }
  const confidence = params.edgeConfidence.every((value) => value === 'verified')
    ? 'verified'
    : 'direct';
  return {
    admitted: true,
    score: 100 - (params.edgeConfidence.length - 1) * 10,
    reasons: [`causal-path:${params.edgeConfidence.length}-edge`],
    confidence,
    causal_path: params.causalPath,
  };
}
