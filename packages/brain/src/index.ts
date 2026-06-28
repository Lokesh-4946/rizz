import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
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

interface PackageJsonFact {
  readonly relativePath: string;
  readonly name?: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
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

export interface GenerateProjectBrainOptions {
  readonly rootDir: string;
  readonly now?: Date;
  readonly maxFiles?: number;
}

export interface GenerateProjectBrainSummary {
  readonly rootDir: string;
  readonly brainDir: string;
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

const IGNORED_DIRS = new Set([
  '.git',
  '.rizz',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
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
  if (name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.p12')) return true;
  return false;
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

async function scanFiles(rootDir: string, maxFiles: number): Promise<FileFact[]> {
  const facts: FileFact[] = [];

  async function walk(dir: string): Promise<void> {
    if (facts.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (facts.length >= maxFiles) return;
      const absolutePath = join(dir, entry.name);
      const rel = relative(rootDir, absolutePath).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipFile(entry.name)) continue;
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
        : `${params.projectName} has ${params.buckets.components.length} inferred component(s), ${params.buckets.commands.length} command(s), and ${params.buckets.tests.length} test artifact(s).`,
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

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderList(items: readonly string[]): string {
  if (items.length === 0) return '<p class="muted">None detected yet.</p>';
  return `<ul>${items.map((item) => `<li>${htmlEscape(item)}</li>`).join('')}</ul>`;
}

function renderEntityCards(entities: readonly BrainEntity[]): string {
  if (entities.length === 0) return '<p class="muted">None detected yet.</p>';
  return entities
    .map(
      (entity) => `<article class="card">
        <div class="badge">${htmlEscape(entity.confidence)}</div>
        <h3>${htmlEscape(entity.name)}</h3>
        <p>${htmlEscape(entity.description)}</p>
        <p class="muted">${htmlEscape(entity.id)}</p>
      </article>`,
    )
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
  const commands = params.buckets.commands
    .map((command) => `${command.name}: ${String(command.data?.command ?? '')}`)
    .filter((line) => line.trim() !== '');
  const testCommands = commands.filter((command) => command.toLowerCase().includes('test'));
  const risks = params.buckets.risks.map((risk) => risk.description);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>rizz brain · ${htmlEscape(params.projectName)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f1115; --panel: #171b22; --text: #f4f6fb; --muted: #a7b0c0; --line: #2b3340; --accent: #6ee7b7; --warn: #fbbf24; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 64px; }
    header { border-bottom: 1px solid var(--line); margin-bottom: 24px; padding-bottom: 18px; }
    h1 { font-size: clamp(32px, 6vw, 68px); margin: 0 0 8px; letter-spacing: 0; }
    h2 { margin-top: 34px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
    .card, details { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; color: var(--accent); padding: 2px 8px; font-size: 12px; }
    .muted { color: var(--muted); }
    code { background: #05070a; border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
    input { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 8px; border: 1px solid var(--line); background: #05070a; color: var(--text); margin: 8px 0 14px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; }
    summary { cursor: pointer; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="badge">rizz project brain</p>
      <h1>${htmlEscape(params.projectName)}</h1>
      <p class="muted">${htmlEscape(String(params.latest.latest_architecture_summary ?? ''))}</p>
    </header>
    <section>
      <h2>Executive Summary</h2>
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
      <h2>Component Map</h2>
      <div class="grid">${renderEntityCards(params.buckets.components)}</div>
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
      <input id="filter" placeholder="Search relationships, entities, or files">
      <table id="relationships"><thead><tr><th>From</th><th>Relation</th><th>To</th><th>Confidence</th></tr></thead><tbody>
        ${params.relationships
          .map(
            (rel) =>
              `<tr><td>${htmlEscape(rel.from)}</td><td>${htmlEscape(rel.relation)}</td><td>${htmlEscape(rel.to)}</td><td>${htmlEscape(rel.confidence)}</td></tr>`,
          )
          .join('')}
      </tbody></table>
    </section>
    <section>
      <h2>Configuration & Environment</h2>
      <div class="grid">${renderEntityCards(params.buckets.configs)}</div>
    </section>
    <section>
      <h2>Risk Areas</h2>
      ${renderList(risks)}
    </section>
    <section>
      <h2>New Developer Onboarding Guide</h2>
      <p>Start with the component map, then open the evidence index. Prefer verified facts before inferred facts.</p>
    </section>
    <section>
      <h2>FAQ</h2>
      <details><summary>Should agents reread every file?</summary><p>No. Agents should read <code>.rizz/brain/latest.json</code>, then relevant entities and evidence before opening source files.</p></details>
    </section>
    <section>
      <h2>Evidence Index</h2>
      <div class="grid">${renderEntityCards(params.buckets.evidence)}</div>
    </section>
  </main>
  <script>
    const filter = document.getElementById('filter');
    const rows = Array.from(document.querySelectorAll('#relationships tbody tr'));
    filter?.addEventListener('input', () => {
      const q = filter.value.toLowerCase();
      for (const row of rows) row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
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
    const sourceFiles = params.files
      .filter((file) => file.relativePath.startsWith(`${componentPath}/`))
      .map((file) => file.relativePath);
    const componentId = entityId('component', componentPath);
    buckets.components.push(
      makeEntity({
        id: componentId,
        type: 'component',
        name: safeText(componentPath),
        description: `Inferred component boundary based on files under ${safeText(componentPath)}.`,
        now: params.now,
        confidence: 'inferred',
        evidenceIds: sourceFiles.slice(0, 8).map(evidenceId),
        sourceFiles,
        data: {
          purpose: 'Folder-level component inferred from repository structure.',
          dependsOn: [],
          firstFilesToRead: sourceFiles.slice(0, 6),
          breaksIfRemoved: 'Unknown until deeper semantic analysis runs.',
        },
      }),
    );
    addRelation(
      relationships,
      projectId,
      'owns',
      componentId,
      sourceFiles.slice(0, 8).map(evidenceId),
      'inferred',
    );
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
    const reportsDir = join(rootDir, '.rizz', 'reports');
    await mkdir(entitiesDir, { recursive: true });
    await mkdir(snapshotsDir, { recursive: true });
    await mkdir(reportsDir, { recursive: true });

    const previous = await readJsonFile<{ readonly entities?: readonly BrainEntity[] }>(
      join(entitiesDir, 'files.json'),
    );
    const previousFiles = previousFileFacts(previous?.entities);
    const files = await scanFiles(rootDir, options.maxFiles ?? 5_000);
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
    };
    const graph = {
      generated_at: now,
      relationships: sorted(built.relationships, (rel) => `${rel.from}:${rel.relation}:${rel.to}`),
    };
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
    await writeFile(join(reportsDir, 'index.html'), report);

    return {
      ok: true,
      value: {
        rootDir,
        brainDir,
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
