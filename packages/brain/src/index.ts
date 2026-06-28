import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, readFileSync, statSync } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

type Confidence = 'verified' | 'inferred' | 'uncertain';

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
  readonly responsibilities: readonly string[];
  readonly interfaces: readonly string[];
  readonly entry_points: readonly string[];
  readonly consumers: readonly string[];
  readonly dependencies: readonly string[];
  readonly exposed_apis: readonly string[];
  readonly tests: readonly string[];
  readonly configs: readonly string[];
  readonly criticality: 'low' | 'medium' | 'high';
  readonly criticality_score: number;
  readonly what_breaks_if_removed: readonly string[];
  readonly important_files: readonly string[];
  readonly known_risks: readonly string[];
  readonly field_evidence: Readonly<Record<string, readonly string[]>>;
  readonly signals: readonly string[];
}

interface PreviousFileFact {
  readonly id: string;
  readonly relativePath: string;
  readonly hash: string;
  readonly createdAt: string;
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

interface ReviewSummaryData {
  readonly id: string;
  readonly generated_at: string;
  readonly changed_files: readonly string[];
  readonly affected_components: readonly string[];
  readonly affected_entities: readonly string[];
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
  readonly consumers: readonly string[];
  readonly important_files: readonly string[];
  readonly entry_points: readonly string[];
  readonly tests: readonly string[];
  readonly configs: readonly string[];
  readonly breaks_if_changed: readonly string[];
  readonly risks: readonly string[];
  readonly read_first: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly depends_on: readonly string[];
  readonly depended_on_by: readonly string[];
  readonly confidence: Confidence;
  readonly unknowns: readonly string[];
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
  evidenceQuality: 'evidence_quality.json',
  incrementalUpdate: 'incremental_update.json',
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
  'tsconfig.json',
  'vite.config.ts',
]);

function shouldSkipFile(name: string): boolean {
  if (name === '.env') return true;
  if (name.startsWith('.env.') && name !== '.env.example') return true;
  if (name.endsWith('.log')) return true;
  if (name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.p12')) return true;
  if (name === 'secrets' || name.startsWith('secrets.')) return true;
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
  return `${type}:${stableSlug(name)}`;
}

function evidenceId(relativePath: string): string {
  return `evidence:file-${stableSlug(relativePath)}`;
}

function jsonString(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-[a-z0-9][a-z0-9_-]{8,}\b/gi, '[redacted secret]')
    .replace(/\bsk-or-v1-[a-z0-9]{16,}\b/gi, '[redacted secret]')
    .replace(/\bgh[pousr]_[a-z0-9_]{20,}\b/gi, '[redacted secret]')
    .replace(/\bBearer\s+[a-z0-9._~+/-]+=*/gi, 'Bearer [redacted secret]');
}

function safeText(value: string): string {
  return redactSecrets(value);
}

function safeResearchValue(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(safeResearchValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [safeText(key), safeResearchValue(item)]),
  );
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
    const entries = await readdir(dir, { withFileTypes: true });
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
    const hash = typeof entity.data?.hash === 'string' ? entity.data.hash : undefined;
    if (relativePath === undefined || hash === undefined) continue;
    out.set(relativePath, {
      id: entity.id,
      relativePath,
      hash,
      createdAt: entity.created_at,
    });
  }
  return out;
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
  return {
    id: params.id,
    type: params.type,
    name: params.name,
    description: params.description,
    created_at: params.createdAt ?? params.now,
    updated_at: params.now,
    confidence: params.confidence ?? 'verified',
    evidence_ids: unique(params.evidenceIds ?? []),
    related_entity_ids: unique(params.relatedEntityIds ?? []),
    source_files: unique(params.sourceFiles ?? []),
    latest_status: params.latestStatus ?? 'current',
    ...(params.data !== undefined ? { data: params.data } : {}),
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
  if (kind === 'intelligence')
    consumers.add('CLI commands, review, report, and future explain/ask surfaces.');
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
    'criticality' | 'consumers' | 'interfaces' | 'entry_points' | 'exposed_apis'
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

function knownRisksForComponent(
  intelligence: Pick<
    ComponentIntelligence,
    'tests' | 'criticality' | 'dependencies' | 'exposed_apis' | 'consumers' | 'signals'
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
  return [...risks];
}

function inferComponentIntelligence(
  componentPath: string,
  files: readonly FileFact[],
  packageFacts: readonly PackageJsonFact[],
): ComponentIntelligence {
  const packages = packageFactsForComponent(packageFacts, componentPath);
  const responsibilities = responsibilitiesForComponent(componentPath, files, packages);
  const interfaces = interfacesForComponent(packages, files);
  const entryPoints = entryPointsForComponent(packages, files);
  const consumers = consumersForComponent(componentPath, files);
  const dependencies = dependenciesForComponent(packages);
  const exposedApis = exposedApisForComponent(files);
  const tests = testPathsForComponent(files);
  const configs = configPathsForComponent(files);
  const criticality = criticalityForComponent(componentPath, files, packages);
  const componentEvidenceIds = files.slice(0, 12).map((file) => evidenceId(file.relativePath));
  const testEvidenceIds = tests.map(evidenceId);
  const configEvidenceIds = configs.map(evidenceId);
  const apiEvidenceIds = exposedApis
    .map((api) => sourceFileFromSignal(api, new Set(files.map((file) => file.relativePath))))
    .filter((file): file is string => file !== undefined)
    .map(evidenceId);
  const dependencyEvidenceIds = packages.map((pkg) => evidenceId(pkg.relativePath));
  const partial = {
    purpose: purposeForComponent(componentPath, packages),
    responsibilities,
    interfaces,
    entry_points: entryPoints,
    consumers,
    dependencies,
    exposed_apis: exposedApis,
    tests,
    configs,
    criticality: criticality.label,
    criticality_score: criticality.score,
    important_files: firstFilesToRead(files),
    signals: componentSignals(files, packages),
  };
  const whatBreaksIfRemoved = whatBreaksIfRemovedForComponent(componentPath, partial);
  return {
    ...partial,
    what_breaks_if_removed: whatBreaksIfRemoved,
    known_risks: knownRisksForComponent({
      ...partial,
    }),
    field_evidence: {
      purpose: componentEvidenceIds,
      responsibilities: componentEvidenceIds,
      interfaces: unique([...configEvidenceIds, ...apiEvidenceIds, ...componentEvidenceIds]),
      entry_points: unique([...configEvidenceIds, ...apiEvidenceIds, ...componentEvidenceIds]),
      consumers: componentEvidenceIds,
      dependencies: dependencyEvidenceIds,
      exposed_apis: apiEvidenceIds,
      tests: testEvidenceIds,
      configs: configEvidenceIds,
      criticality: componentEvidenceIds,
      what_breaks_if_removed: unique([
        ...componentEvidenceIds,
        ...configEvidenceIds,
        ...apiEvidenceIds,
      ]),
      important_files: componentEvidenceIds,
      known_risks: unique([...componentEvidenceIds, ...testEvidenceIds, ...dependencyEvidenceIds]),
    },
  };
}

function confidenceForComponent(intelligence: ComponentIntelligence): Confidence {
  if (intelligence.signals.length <= 1) return 'uncertain';
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
  return files.filter(
    (file) =>
      CONFIG_FILES.has(basename(file.relativePath)) || file.relativePath.startsWith('.github/'),
  );
}

function testFiles(files: readonly FileFact[]): FileFact[] {
  return files.filter(
    (file) =>
      file.relativePath.includes('__tests__') ||
      file.relativePath.endsWith('.test.ts') ||
      file.relativePath.endsWith('.test.js') ||
      file.relativePath.endsWith('.spec.ts') ||
      file.relativePath.endsWith('.spec.js'),
  );
}

function classifySourceKind(file: FileFact): string {
  if (file.relativePath.endsWith('package.json')) return 'package-manifest';
  if (CONFIG_FILES.has(basename(file.relativePath))) return 'config';
  if (file.relativePath.includes('.test.') || file.relativePath.includes('.spec.')) return 'test';
  if (file.extension === '.ts' || file.extension === '.js') return 'source';
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
}): Record<keyof typeof RESEARCH_ARTIFACT_FILES, unknown> {
  const entities = allBucketEntities(params.buckets);
  const entityCounts = Object.fromEntries(
    ENTITY_FILES.map(([bucket, , entityType]) => [entityType, params.buckets[bucket].length]),
  );
  const activeFileEntities = params.buckets.files.filter((file) => file.latest_status !== 'stale');
  const referencedEvidenceIds = unique([
    ...entities.flatMap((entity) => entity.evidence_ids),
    ...params.relationships.flatMap((relationship) => relationship.evidence_ids),
  ]);
  const knownEvidenceIds = new Set(params.buckets.evidence.map((entity) => entity.id));
  const missingEvidenceReferences = referencedEvidenceIds.filter((id) => !knownEvidenceIds.has(id));
  const filesByStatus = countByValue(params.buckets.files.map((file) => file.latest_status));
  const changedFiles = unique(params.changedFiles);
  const staleFiles = unique(params.staleFiles);
  const componentSourceFiles = new Set(
    params.buckets.components.flatMap((component) => component.source_files),
  );
  const mappedActiveFiles = activeFileEntities.filter((file) =>
    componentSourceFiles.has(file.name),
  );
  const entitiesWithEvidence = entities.filter((entity) => entity.evidence_ids.length > 0);
  const entitiesWithoutEvidence = entities.filter((entity) => entity.evidence_ids.length === 0);
  const relationshipsWithEvidence = params.relationships.filter(
    (relationship) => relationship.evidence_ids.length > 0,
  );
  const relationshipsWithoutEvidence = params.relationships.filter(
    (relationship) => relationship.evidence_ids.length === 0,
  );
  const currentFiles = activeFileEntities.filter((file) => file.latest_status === 'current');
  const newFiles = activeFileEntities.filter((file) => file.latest_status === 'new');

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
      component_confidence: params.buckets.components.map((component) => ({
        id: component.id,
        name: component.name,
        confidence: component.confidence,
        criticality: stringData(component, 'criticality') ?? 'unknown',
        evidence_ids: component.evidence_ids,
        source_files: component.source_files,
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
    evidenceQuality: {
      generated_at: params.now,
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
    },
    incrementalUpdate: {
      generated_at: params.now,
      scanned_files: params.files.length,
      changed_files: changedFiles,
      stale_files: staleFiles,
      file_status_counts: filesByStatus,
      reused_files: currentFiles.length,
      recomputed_files: changedFiles.length,
      file_reuse_ratio: ratio(currentFiles.length, params.files.length),
      current_files: currentFiles.map((file) => file.name).sort((a, b) => a.localeCompare(b)),
      new_files: newFiles.map((file) => file.name).sort((a, b) => a.localeCompare(b)),
    },
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

function buildLatest(params: {
  readonly projectName: string;
  readonly now: string;
  readonly stack: readonly string[];
  readonly packageManager: string;
  readonly buckets: BrainBuckets;
  readonly relationships: readonly BrainRelationship[];
  readonly changedFiles: readonly string[];
  readonly staleFiles: readonly string[];
}): Record<string, unknown> {
  const componentMap = params.buckets.components.map((component) => ({
    id: component.id,
    name: component.name,
    description: component.description,
    confidence: component.confidence,
    source_files: component.source_files,
    purpose: stringData(component, 'purpose'),
    responsibilities: stringArrayData(component, 'responsibilities'),
    interfaces: stringArrayData(component, 'interfaces'),
    entry_points: stringArrayData(component, 'entry_points'),
    consumers: stringArrayData(component, 'consumers'),
    dependencies: stringArrayData(component, 'dependencies'),
    exposed_apis: stringArrayData(component, 'exposed_apis'),
    tests: stringArrayData(component, 'tests'),
    configs: stringArrayData(component, 'configs'),
    criticality: stringData(component, 'criticality'),
    criticality_score: numberData(component, 'criticality_score'),
    what_breaks_if_removed: stringArrayData(component, 'what_breaks_if_removed'),
    important_files: stringArrayData(component, 'important_files'),
    known_risks: stringArrayData(component, 'known_risks'),
  }));
  const risks = params.buckets.risks.map((risk) => ({
    id: risk.id,
    name: risk.name,
    description: risk.description,
    confidence: risk.confidence,
    evidence_ids: risk.evidence_ids,
  }));
  const confidenceGaps = params.buckets.risks
    .filter((risk) => risk.confidence !== 'verified')
    .map((risk) => risk.description);

  return {
    generated_at: params.now,
    project_id: entityId('project', params.projectName),
    latest_architecture_summary:
      params.buckets.components.length === 0
        ? 'No durable component map has been inferred yet.'
        : `${params.projectName} has ${params.buckets.components.length} inferred component(s) with purpose/responsibility signals, ${params.buckets.commands.length} command(s), and ${params.buckets.tests.length} test artifact(s).`,
    latest_component_map: componentMap,
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
  return value
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
      const criticality = stringData(component, 'criticality') ?? 'unknown';
      const score = numberData(component, 'criticality_score');
      const scoreText = score === undefined ? '' : ` · ${score}/10`;
      const fieldEvidence = recordStringArrayData(component, 'field_evidence');
      return `<article class="card" data-search="${htmlEscape(
        `${component.id} ${component.name} ${purpose} ${criticality} ${component.confidence} ${component.source_files.join(' ')}`,
      )}" data-kind="component" data-confidence="${htmlEscape(
        component.confidence,
      )}" data-criticality="${htmlEscape(criticality)}">
        <div class="badge">${htmlEscape(component.confidence)} · ${htmlEscape(criticality)}${htmlEscape(scoreText)}</div>
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
        <h4>Known Risks</h4>
        ${renderListWithEvidence(
          stringArrayData(component, 'known_risks'),
          fieldEvidence.known_risks ?? component.evidence_ids,
          evidenceById,
        )}
        <h4>Evidence</h4>
        ${renderEvidenceLinks(component.evidence_ids, evidenceById)}
        <p class="muted">${htmlEscape(component.id)}</p>
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
      ([key, value]) => `<tr><th>${htmlEscape(key)}</th><td>${htmlEscape(String(value))}</td></tr>`,
    )
    .join('');
  return `<table><tbody>${rows}</tbody></table>`;
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mission Control · ${htmlEscape(params.projectName)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f1115; --panel: #171b22; --text: #f4f6fb; --muted: #a7b0c0; --line: #2b3340; --accent: #6ee7b7; --warn: #fbbf24; --danger: #fda4af; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 64px; }
    header { border-bottom: 1px solid var(--line); margin-bottom: 24px; padding-bottom: 18px; }
    h1 { font-size: clamp(32px, 6vw, 68px); margin: 0 0 8px; letter-spacing: 0; }
    h2 { margin-top: 34px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
    .card, details { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .compact { padding: 12px; }
    .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; color: var(--accent); padding: 2px 8px; font-size: 12px; }
    .badge.warn { color: var(--warn); }
    .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .toolbar { position: sticky; top: 0; z-index: 2; background: color-mix(in srgb, var(--bg) 92%, transparent); border-bottom: 1px solid var(--line); padding: 10px 0; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip { border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--text); padding: 6px 10px; cursor: pointer; }
    .chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
    .muted { color: var(--muted); }
    .evidence-block { border-left: 2px solid var(--line); margin-top: 8px; padding-left: 10px; }
    .evidence-links { padding-left: 18px; }
    a { color: var(--accent); overflow-wrap: anywhere; }
    h4 { margin: 16px 0 6px; }
    code { background: #05070a; border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
    input { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 8px; border: 1px solid var(--line); background: #05070a; color: var(--text); margin: 8px 0 14px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; }
    summary { cursor: pointer; font-weight: 700; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
    @media (max-width: 520px) { main { padding: 20px 12px 48px; } table { display: block; overflow-x: auto; } }
    @media print { .toolbar, script { display: none; } body { background: #fff; color: #000; } .card, details { break-inside: avoid; border-color: #999; } a { color: #000; } }
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
      <div class="stats">
        <span class="badge">${params.buckets.components.length} components</span>
        <span class="badge warn">${params.buckets.risks.length} risks</span>
        <span class="badge warn">${unknownCount} unknowns</span>
        <span class="badge">${params.buckets.evidence.length} evidence records</span>
        <span class="badge">${params.relationships.length} relationships</span>
      </div>
    </header>
    <section class="toolbar" aria-label="Portal filters">
      <label class="sr-only" for="global-filter">Search project intelligence</label>
      <input id="global-filter" placeholder="Search components, files, risks, commands, evidence..." autocomplete="off">
      <div class="chips" aria-label="Filter chips">
        <button class="chip" type="button" data-filter="all" aria-pressed="true">All</button>
        <button class="chip" type="button" data-filter="critical">High criticality</button>
        <button class="chip" type="button" data-filter="risk">Risks</button>
        <button class="chip" type="button" data-filter="unknown">Unknowns</button>
        <button class="chip" type="button" data-filter="verified">Verified</button>
        <button class="chip" type="button" data-filter="inferred">Inferred</button>
        <button class="chip" type="button" data-filter="uncertain">Uncertain</button>
      </div>
      <p class="muted" id="filter-count">Showing all local intelligence.</p>
    </section>
    <section>
      <h2>Start Here</h2>
      <p class="muted">Read this first. Open high-criticality components before editing, then check risks and unknowns before trusting inferred facts.</p>
      <div class="grid">${renderStartHere(params.buckets.components, evidenceById)}</div>
      <h3>Recommended Next Actions</h3>
      ${renderList(recommendedActions.slice(0, 5))}
    </section>
    <section>
      <h2>Overview</h2>
      <div class="grid">
        <article class="card"><h3>Tech Stack</h3>${renderList(params.stack)}</article>
        <article class="card"><h3>Package Manager</h3><p>${htmlEscape(params.packageManager)}</p></article>
        <article class="card"><h3>Relationships</h3><p>${params.relationships.length}</p></article>
      </div>
    </section>
    <section>
      <h2>How To Run Locally</h2>
      <p class="muted">Detected commands are copied from project manifests and should be verified by a human before release docs rely on them.</p>
      ${renderList(commands)}
    </section>
    <section>
      <h2>How To Test</h2>
      ${renderList(testCommands)}
    </section>
    <section>
      <h2>Risk Areas</h2>
      <p class="muted">Known or inferred places where edits deserve extra attention.</p>
      <div class="grid">${renderRiskCards(params.buckets.risks, evidenceById)}</div>
    </section>
    <section>
      <h2>Latest Review</h2>
      <p class="muted">Latest review reads the current git diff against the project brain.</p>
      ${renderLatestReview(params.latest)}
    </section>
    <section>
      <h2>Component Intelligence</h2>
      <div class="grid">${renderComponentCards(params.buckets.components, evidenceById)}</div>
    </section>
    <section>
      <h2>Architecture Reasoning</h2>
      <details open><summary>Current reasoning</summary><p>${htmlEscape(String(params.latest.latest_architecture_summary ?? ''))}</p></details>
    </section>
    <section>
      <h2>Request/Data Flows</h2>
      <div class="grid">${renderEntityCards(params.buckets.flows)}</div>
    </section>
    <section>
      <h2>Dependency Graph</h2>
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
    </section>
    <section>
      <h2>Configuration & Environment</h2>
      <div class="grid">${renderEntityCards(params.buckets.configs)}</div>
    </section>
    <section>
      <h2>New Developer Onboarding Guide</h2>
      <p>Start with the component map, then open the evidence index. Prefer verified facts before inferred facts.</p>
    </section>
    <section>
      <h2>Unknowns</h2>
      <p class="muted">Questions the brain cannot answer confidently yet. Treat these as read-before-edit prompts.</p>
      <div class="grid">${renderUnknowns({
        latest: params.latest,
        components: params.buckets.components,
      })}</div>
    </section>
    <section>
      <h2>Confidence Guide</h2>
      <div class="grid">
        <article class="card"><h3>verified</h3><p>Backed by direct file or manifest evidence.</p></article>
        <article class="card"><h3>inferred</h3><p>Derived from names, paths, scripts, or relationships.</p></article>
        <article class="card"><h3>uncertain</h3><p>Weak or incomplete evidence. Confirm before relying on it.</p></article>
      </div>
    </section>
    <section>
      <h2>FAQ</h2>
      <details><summary>Where did this come from?</summary><p>From <code>.rizz/brain</code>: deterministic local scan output and review artifacts.</p></details>
      <details><summary>Should agents reread every file?</summary><p>No. Agents should read <code>.rizz/brain/latest.json</code>, then relevant entities and evidence before opening source files.</p></details>
      <details><summary>Can I trust inferred facts?</summary><p>Use them for orientation. Depend on verified evidence for decisions.</p></details>
      <details><summary>How do I refresh this?</summary><p>Run <code>rizz brain</code> after meaningful repo changes.</p></details>
      <details><summary>How do reviews appear here?</summary><p>Run <code>rizz review</code>; the latest review status and findings are added to the brain.</p></details>
    </section>
    <section>
      <h2>Evidence</h2>
      <p class="muted">Facts are only useful when their source is visible. Prefer verified evidence before inferred claims.</p>
      <div class="grid">${renderEvidenceIndex(params.buckets.evidence)}</div>
    </section>
  </main>
  <script>
    const filter = document.getElementById('global-filter');
    const count = document.getElementById('filter-count');
    const chips = Array.from(document.querySelectorAll('.chip'));
    const items = Array.from(document.querySelectorAll('[data-search]'));
    let activeFilter = 'all';
    function matchesKind(item) {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'critical') return item.dataset.criticality === 'high';
      if (activeFilter === 'risk') return item.dataset.kind === 'risk';
      if (activeFilter === 'unknown') return item.dataset.kind === 'unknown';
      return item.dataset.confidence === activeFilter;
    }
    function applyFilter() {
      const q = (filter?.value ?? '').toLowerCase();
      let shown = 0;
      for (const item of items) {
        const ok = item.dataset.search.toLowerCase().includes(q) && matchesKind(item);
        item.style.display = ok ? '' : 'none';
        if (ok) shown += 1;
      }
      if (count) count.textContent = shown === 0 ? 'No local intelligence matches this filter.' : 'Showing ' + shown + ' of ' + items.length + ' items.';
    }
    filter?.addEventListener('input', applyFilter);
    for (const chip of chips) {
      chip.addEventListener('click', () => {
        activeFilter = chip.dataset.filter ?? 'all';
        for (const other of chips) other.setAttribute('aria-pressed', String(other === chip));
        applyFilter();
      });
    }
    applyFilter();
  </script>
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
  await writeFile(
    join(entitiesDir, fileName),
    jsonString({
      generated_at: generatedAt,
      entity_type: entityType,
      entities: sorted(entities, (entity) => entity.id),
    }),
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
  const currentPaths = new Set(params.files.map((file) => file.relativePath));
  const changedFiles: string[] = [];
  const staleFiles: string[] = [];

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
    const previous = params.previousFiles.get(file.relativePath);
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

  for (const previous of params.previousFiles.values()) {
    if (currentPaths.has(previous.relativePath)) continue;
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

  for (const componentPath of componentPaths(params.files)) {
    const componentFiles = filesForComponent(params.files, componentPath);
    const sourceFiles = componentFiles.map((file) => file.relativePath);
    const intelligence = inferComponentIntelligence(
      componentPath,
      componentFiles,
      params.packageFacts,
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

  if (buckets.commands.some((command) => command.name === 'build')) {
    buckets.flows.push(
      makeEntity({
        id: entityId('flow', 'build'),
        type: 'flow',
        name: 'build',
        description: 'Build flow inferred from package scripts.',
        now: params.now,
        confidence: 'verified',
        evidenceIds: buckets.commands
          .filter((command) => command.name === 'build')
          .flatMap((command) => command.evidence_ids),
      }),
    );
  }
  if (
    buckets.commands.some((command) => command.name.includes('test') || command.name === 'check')
  ) {
    buckets.flows.push(
      makeEntity({
        id: entityId('flow', 'quality-gate'),
        type: 'flow',
        name: 'quality gate',
        description: 'Quality gate inferred from test/check package scripts.',
        now: params.now,
        confidence: 'verified',
        evidenceIds: buckets.commands
          .filter((command) => command.name.includes('test') || command.name === 'check')
          .flatMap((command) => command.evidence_ids),
      }),
    );
  }

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
    const ignorePatterns = await readRizzIgnore(rootDir);
    const previousFiles = previousFileFacts(previous?.entities);
    for (const relativePath of previousFiles.keys()) {
      if (shouldSkipRelativePath(relativePath, ignorePatterns)) previousFiles.delete(relativePath);
    }
    const files = await scanFiles(rootDir, options.maxFiles ?? 5_000, ignorePatterns);
    const packageFacts = await readPackageJsonFacts(rootDir, files);
    const built = buildBrain({ rootDir, projectName, now, files, previousFiles, packageFacts });
    const latest = buildLatest({
      projectName,
      now,
      stack: built.stack,
      packageManager: built.packageManager,
      buckets: built.buckets,
      relationships: built.relationships,
      changedFiles: built.changedFiles,
      staleFiles: built.staleFiles,
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
      report_path: '.rizz/reports/index.html',
      research_paths: {
        metrics: '.rizz/research/metrics.json',
        coverage: '.rizz/research/coverage.json',
        confidence: '.rizz/research/confidence.json',
        evidence_quality: '.rizz/research/evidence_quality.json',
        incremental_update: '.rizz/research/incremental_update.json',
      },
    };
    const graph = {
      generated_at: now,
      relationships: sorted(built.relationships, (rel) => `${rel.from}:${rel.relation}:${rel.to}`),
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

    await writeFile(join(brainDir, 'index.json'), jsonString(index));
    await writeFile(join(brainDir, 'graph.json'), jsonString(graph));
    await writeFile(join(brainDir, 'latest.json'), jsonString(latest));
    await writeFile(changelogPath, jsonString(changelog));
    await writeFile(join(snapshotsDir, snapshotName), jsonString(snapshot));
    for (const [bucket, fileName, entityType] of ENTITY_FILES) {
      await writeEntityFile(entitiesDir, fileName, entityType, now, built.buckets[bucket]);
    }
    await writeResearchArtifacts(researchDir, researchArtifacts);
    await writeFile(join(reportsDir, 'index.html'), report);

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
        findings: review.findings.length,
        changed_files: review.changed_files,
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
        last_review_risk: review.overall_risk,
      },
    };
    await writeFile(latestPath, jsonString(updatedLatest));

    const reviewReport = renderReviewReport(review);
    const reportPath = join(reportsDir, 'review.html');
    await writeFile(reportPath, reviewReport);

    return {
      ok: true,
      value: {
        rootDir,
        reviewPath: join(entitiesDir, 'reviews.json'),
        latestPath,
        reportPath,
        changedFiles: review.changed_files.length,
        affectedComponents: review.affected_components.length,
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
  readonly configs: readonly BrainEntity[];
  readonly commands: readonly BrainEntity[];
  readonly tests: readonly BrainEntity[];
  readonly dependencies: readonly BrainEntity[];
  readonly risks: readonly BrainEntity[];
  readonly evidence: readonly BrainEntity[];
}> {
  const [files, folders, components, configs, commands, tests, dependencies, risks, evidence] =
    await Promise.all([
      readEntityFile(entitiesDir, 'files.json'),
      readEntityFile(entitiesDir, 'folders.json'),
      readEntityFile(entitiesDir, 'components.json'),
      readEntityFile(entitiesDir, 'configs.json'),
      readEntityFile(entitiesDir, 'commands.json'),
      readEntityFile(entitiesDir, 'tests.json'),
      readEntityFile(entitiesDir, 'dependencies.json'),
      readEntityFile(entitiesDir, 'risks.json'),
      readEntityFile(entitiesDir, 'evidence.json'),
    ]);
  return { files, folders, components, configs, commands, tests, dependencies, risks, evidence };
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
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '').toLowerCase();
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
  if (id.includes(slug) || name.includes(query) || relativePath.includes(query)) {
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
  const risks = unique([
    ...explainArray(targetData.known_risks, componentData.known_risks),
    ...relatedRisks(target, relatedComponents, params.entitySets.risks),
  ]);
  const readFirst = unique([...entryPoints, ...importantFiles, ...target.source_files]).slice(0, 8);
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

  return {
    generated_at: params.now,
    target: safeText(params.query),
    resolved_entity_id: safeText(target.id),
    entity_type: target.type,
    summary: safeText(target.description),
    purpose: safeText(purpose),
    responsibilities: responsibilities.map(safeText),
    dependencies: dependencies.map(safeText),
    consumers: consumers.map(safeText),
    important_files: importantFiles.map(safeText),
    entry_points: entryPoints.map(safeText),
    tests: tests.map(safeText),
    configs: configs.map(safeText),
    breaks_if_changed: breaksIfChanged.map(safeText),
    risks: risks.map(safeText),
    read_first: readFirst.map(safeText),
    evidence_ids: evidenceIds.map(safeText),
    depends_on: relationshipContext.dependsOn.map(safeText),
    depended_on_by: relationshipContext.dependedOnBy.map(safeText),
    confidence,
    unknowns: unknowns.map(safeText),
  };
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
      <article class="card"><h2>Important Files</h2>${renderList(explanation.important_files)}</article>
      <article class="card"><h2>Dependencies</h2>${renderList(explanation.dependencies)}</article>
      <article class="card"><h2>Consumers</h2>${renderList(explanation.consumers)}</article>
      <article class="card"><h2>Tests</h2>${renderList(explanation.tests)}</article>
      <article class="card"><h2>Configs</h2>${renderList(explanation.configs)}</article>
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
  readonly configs: readonly BrainEntity[];
  readonly commands: readonly BrainEntity[];
  readonly tests: readonly BrainEntity[];
  readonly dependencies: readonly BrainEntity[];
  readonly risks: readonly BrainEntity[];
}> {
  const [files, components, configs, commands, tests, dependencies, risks] = await Promise.all([
    readEntityFile(entitiesDir, 'files.json'),
    readEntityFile(entitiesDir, 'components.json'),
    readEntityFile(entitiesDir, 'configs.json'),
    readEntityFile(entitiesDir, 'commands.json'),
    readEntityFile(entitiesDir, 'tests.json'),
    readEntityFile(entitiesDir, 'dependencies.json'),
    readEntityFile(entitiesDir, 'risks.json'),
  ]);
  return { files, components, configs, commands, tests, dependencies, risks };
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
  const changedSourceFiles = changedFiles.filter((file) => isSourceFile(file));
  const changedTestFiles = changedFiles.filter((file) => isTestPath(file));
  const changedConfigFiles = changedFiles.filter((file) => isConfigPath(file));
  const changedDependencyFiles = changedFiles.filter((file) => isDependencyPath(file));
  const affectedComponents = affectedComponentEntities(changedFiles, params.entitySets.components);
  const affectedComponentIds = affectedComponents.map((component) => component.id);
  const directlyAffectedEntities = unique([
    ...changedFiles.map((file) => entityId('file', file)),
    ...affectedComponentIds,
    ...params.entitySets.configs
      .filter((config) => config.source_files.some((file) => changedFileSet.has(file)))
      .map((config) => config.id),
    ...params.entitySets.tests
      .filter((test) => test.source_files.some((file) => changedFileSet.has(file)))
      .map((test) => test.id),
  ]);
  const graphAffectedEntities = unique([
    ...directlyAffectedEntities,
    ...params.relationships
      .filter(
        (rel) =>
          directlyAffectedEntities.includes(rel.from) || directlyAffectedEntities.includes(rel.to),
      )
      .flatMap((rel) => [rel.from, rel.to]),
  ]);

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
      affected_files: unique(params.affected_files),
      affected_entities: unique(params.affected_entities),
      evidence_ids: unique(params.evidenceIds ?? params.affected_files.map(evidenceId)),
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
  if (isBroad) {
    addFinding({
      slug: 'broad-change',
      severity: changedFiles.length > 20 || affectedComponents.length > 5 ? 'high' : 'medium',
      category: 'Regression risk',
      title: 'Broad change crosses multiple brain boundaries',
      description: `The diff touches ${changedFiles.length} file(s) across ${affectedComponents.length} inferred component(s).`,
      affected_files: changedFiles,
      affected_entities: graphAffectedEntities,
      confidence: 'inferred',
      recommendation:
        'Split unrelated changes or make the PR narrative explicitly map each touched component to test evidence.',
      safer_alternative:
        'Land mechanical/docs/config changes separately from runtime behavior changes.',
    });
  }

  if (changedSourceFiles.length > 0 && changedTestFiles.length === 0) {
    addFinding({
      slug: 'missing-tests',
      severity: changedSourceFiles.length > 4 ? 'high' : 'medium',
      category: 'Missing tests',
      title: 'Runtime files changed without test artifacts in the diff',
      description: `${changedSourceFiles.length} source file(s) changed, but no test file changed with them.`,
      affected_files: changedSourceFiles,
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
      affected_files: secretRiskFiles.length > 0 ? secretRiskFiles : changedFiles,
      affected_entities: graphAffectedEntities,
      confidence: containsSecretLikeValue(params.diffText) ? 'verified' : 'inferred',
      recommendation:
        'Audit redaction, storage boundaries, logs, and setup output. Never merge real keys or tokens.',
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
      affected_files: changedFiles.filter((file) => file.includes('brain') || file.includes('cli')),
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
      affected_files: changedFiles,
      affected_entities: graphAffectedEntities,
      confidence: 'inferred',
      recommendation:
        'Cut the PR to the smallest reviewable product slice or add stronger focused tests.',
      safer_alternative: 'Ship schema/artifact writing first, then UX/reporting in the next PR.',
    });
  }

  const requiredTests = requiredTestCommands(params.entitySets.commands, changedFiles);
  const blastRadius = classifyBlastRadius(changedFiles.length, affectedComponents.length);
  const surgicalityScore = scoreSurgicality(
    changedFiles.length,
    affectedComponents.length,
    findings,
  );
  const overallRisk = classifyOverallRisk(findings, blastRadius);
  return {
    id: entityId('review', `${params.now}-git-diff`),
    generated_at: params.now,
    changed_files: changedFiles,
    affected_components: affectedComponentIds,
    affected_entities: graphAffectedEntities,
    findings,
    overall_risk: overallRisk,
    surgicality_score: surgicalityScore,
    blast_radius: blastRadius,
    required_tests: requiredTests,
    suggested_reviewer_focus_areas: suggestedFocusAreas(findings, changedFiles, affectedComponents),
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

function containsSecretLikeValue(value: string): boolean {
  return redactSecrets(value) !== value;
}

function requiredTestCommands(
  commands: readonly BrainEntity[],
  changedFiles: readonly string[],
): string[] {
  const commandTexts = commands
    .map((command) => {
      const text = typeof command.data?.command === 'string' ? command.data.command : undefined;
      return text === undefined ? undefined : `${command.name}: ${text}`;
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
): string[] {
  const categories = findings.map((finding) => finding.category);
  const componentNames = components.map((component) => component.name);
  return unique([
    ...categories,
    ...componentNames.map((name) => `component: ${name}`),
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
      <article class="card"><h2>Findings</h2><p>${review.findings.length}</p></article>
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

  for (const fileName of ['components.json', 'files.json', 'folders.json']) {
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
