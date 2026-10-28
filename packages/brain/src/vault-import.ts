import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { prepareProjectStore } from './project-store.js';
import { containsSecretLikeValue } from './sensitivity.js';

type VaultClassification = 'product' | 'planning' | 'governance' | 'handoffs' | 'work' | 'brain';

interface VaultError {
  readonly code: string;
  readonly message: string;
}

type VaultResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: VaultError };

export interface VaultDocument {
  readonly source_path: string;
  readonly classification: VaultClassification;
  readonly digest: string;
  readonly bytes: number;
}

export interface VaultInspection {
  readonly schema_version: 1;
  readonly source_dir: string;
  readonly documents: readonly VaultDocument[];
  readonly duplicate_claims: readonly { claim: string; source_paths: readonly string[] }[];
  readonly naming_conflicts: readonly { name: string; source_paths: readonly string[] }[];
  readonly stale_absolute_paths: readonly string[];
  readonly secret_findings: readonly { source_path: string; finding: 'secret-like-value' }[];
  readonly requires_human_reconciliation: readonly string[];
}

export interface VaultImportOperation extends VaultDocument {
  readonly destination_path: string;
}

export interface VaultImportPreview extends VaultInspection {
  readonly project_id: string;
  readonly project_dir: string;
  readonly mode: 'copy';
  readonly operations: readonly VaultImportOperation[];
}

interface VaultManifest {
  readonly schema_version: 1;
  readonly source_dir: string;
  readonly imported_at: string;
  readonly documents: readonly VaultImportOperation[];
}

function failure(code: string, message: string): VaultResult<never> {
  return { ok: false, error: { code, message } };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function classify(path: string, contents: string): VaultClassification {
  const value = `${path}\n${contents.slice(0, 500)}`.toLowerCase();
  if (/\b(sprint|backlog|roadmap plan|release plan|jira|board)\b/.test(value)) return 'planning';
  if (/\b(product|vision|roadmap|requirements?|capabilit)/.test(value)) return 'product';
  if (/\b(decision|adr|governance|policy|approval|constraint)/.test(value)) return 'governance';
  if (/\bhandoff\b/.test(value)) return 'handoffs';
  if (/\b(task|work item|checkpoint|session)\b/.test(value)) return 'work';
  return 'brain';
}

async function markdownFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(path);
      if (found.length > 1_000) throw new Error('vault contains more than 1000 Markdown documents');
    }
  }
  await walk(root);
  return found.sort((left, right) => left.localeCompare(right));
}

function claims(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length >= 8 &&
        !line.startsWith('#') &&
        !line.startsWith('```') &&
        !containsSecretLikeValue(line),
    );
}

function absolutePaths(contents: string): string[] {
  return [
    ...(contents.match(/\/(?:Users|home|var|opt|workspace)\/[A-Za-z0-9_./ -]+/g) ?? []),
    ...(contents.match(/[A-Za-z]:\\[A-Za-z0-9_.\\ -]+/g) ?? []),
  ].map((path) => path.trim().replace(/[.,;:)]+$/, ''));
}

export async function inspectVault(options: { readonly sourceDir: string }): Promise<
  VaultResult<VaultInspection>
> {
  try {
    const sourceDir = (await stat(options.sourceDir)).isDirectory()
      ? await realpath(options.sourceDir)
      : '';
    if (sourceDir === '')
      return failure('VAULT_SOURCE_INVALID', 'Vault source must be a directory.');
    const documents: VaultDocument[] = [];
    const claimsByText = new Map<string, { claim: string; sources: Set<string> }>();
    const names = new Map<string, Array<{ path: string; digest: string }>>();
    const stalePaths = new Set<string>();
    const secretFindings: Array<{ source_path: string; finding: 'secret-like-value' }> = [];
    for (const path of await markdownFiles(sourceDir)) {
      const info = await stat(path);
      if (info.size > 1_048_576)
        throw new Error(`Markdown document exceeds 1MB: ${relative(sourceDir, path)}`);
      const contents = await readFile(path, 'utf8');
      const sourcePath = relative(sourceDir, path).replace(/\\/g, '/');
      const contentDigest = digest(contents);
      documents.push({
        source_path: sourcePath,
        classification: classify(sourcePath, contents),
        digest: contentDigest,
        bytes: Buffer.byteLength(contents),
      });
      for (const claim of claims(contents)) {
        const key = claim.toLowerCase().replace(/\s+/g, ' ');
        const record = claimsByText.get(key) ?? { claim, sources: new Set<string>() };
        record.sources.add(sourcePath);
        claimsByText.set(key, record);
      }
      const named = names.get(basename(sourcePath).toLowerCase()) ?? [];
      named.push({ path: sourcePath, digest: contentDigest });
      names.set(basename(sourcePath).toLowerCase(), named);
      for (const stalePath of absolutePaths(contents)) stalePaths.add(stalePath);
      if (containsSecretLikeValue(contents)) {
        secretFindings.push({ source_path: sourcePath, finding: 'secret-like-value' });
      }
    }
    const duplicateClaims = [...claimsByText.values()]
      .filter(({ sources }) => sources.size > 1)
      .map(({ claim, sources }) => ({
        claim,
        source_paths: [...sources].sort(),
      }))
      .sort((left, right) => left.claim.localeCompare(right.claim));
    const namingConflicts = [...names.entries()]
      .filter(
        ([, entries]) =>
          entries.length > 1 && new Set(entries.map((entry) => entry.digest)).size > 1,
      )
      .map(([name, entries]) => ({ name, source_paths: entries.map((entry) => entry.path).sort() }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const reconciliation = [
      ...namingConflicts.map((conflict) => `Resolve naming conflict: ${conflict.name}`),
      ...secretFindings.map((finding) => `Review secret-like content: ${finding.source_path}`),
      ...[...stalePaths].map((path) => `Reconcile absolute path: ${path}`),
    ];
    return {
      ok: true,
      value: {
        schema_version: 1,
        source_dir: sourceDir,
        documents,
        duplicate_claims: duplicateClaims,
        naming_conflicts: namingConflicts,
        stale_absolute_paths: [...stalePaths].sort(),
        secret_findings: secretFindings,
        requires_human_reconciliation: reconciliation,
      },
    };
  } catch (error: unknown) {
    return failure('VAULT_INSPECT_FAILED', error instanceof Error ? error.message : String(error));
  }
}

function importDestination(projectDir: string, document: VaultDocument): string {
  return join(projectDir, document.classification, 'imports', ...document.source_path.split('/'));
}

export async function previewVaultImport(options: {
  readonly rootDir: string;
  readonly sourceDir: string;
  readonly rizzHome?: string;
}): Promise<VaultResult<VaultImportPreview>> {
  const [inspection, store] = await Promise.all([
    inspectVault(options),
    prepareProjectStore(options),
  ]);
  if (!inspection.ok) return inspection;
  if (!store.ok) return store;
  return {
    ok: true,
    value: {
      ...inspection.value,
      project_id: store.value.projectId,
      project_dir: store.value.projectDir,
      mode: 'copy',
      operations: inspection.value.documents.map((document) => ({
        ...document,
        destination_path: importDestination(store.value.projectDir, document),
      })),
    },
  };
}

async function writeVerified(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, path);
  if ((await readFile(path, 'utf8')) !== contents)
    throw new Error(`write verification failed for ${path}`);
}

const SCAFFOLD = {
  'product/current.md': '# Product Current State\n\nAwaiting approved product intent.\n',
  'product/principles.md':
    '# Product Principles\n\nRizz prevents agent slop by requiring scoped intent, evidence-backed context, verification, review, and durable handoff so developers can ship substantial, inspectable work.\n',
  'planning/sprint.md': '# Current Sprint\n\nNo accepted sprint has been recorded.\n',
  'planning/backlog.md': '# Backlog\n\nNo accepted backlog items have been recorded.\n',
  'planning/board.md':
    '# Work Board\n\n| Item | Status | Agent | Evidence | Verification | Review | PR |\n| --- | --- | --- | --- | --- | --- | --- |\n',
} as const;

async function ensureScaffold(projectDir: string): Promise<void> {
  for (const [relativePath, contents] of Object.entries(SCAFFOLD)) {
    const path = join(projectDir, relativePath);
    try {
      await readFile(path, 'utf8');
    } catch {
      await writeVerified(path, contents);
    }
  }
}

export async function applyVaultImport(options: {
  readonly rootDir: string;
  readonly sourceDir: string;
  readonly rizzHome?: string;
}): Promise<VaultResult<VaultImportPreview>> {
  const preview = await previewVaultImport(options);
  if (!preview.ok) return preview;
  if (preview.value.secret_findings.length > 0) {
    return failure(
      'VAULT_SECRET_REVIEW_REQUIRED',
      'Preview contains secret-like content; reconcile it before apply.',
    );
  }
  try {
    const contentsBySource = new Map<string, string>();
    for (const operation of preview.value.operations) {
      const contents = await readFile(
        join(preview.value.source_dir, operation.source_path),
        'utf8',
      );
      if (digest(contents) !== operation.digest || containsSecretLikeValue(contents)) {
        return failure(
          'VAULT_SOURCE_CHANGED',
          `Vault source changed after preview: ${operation.source_path}. Inspect it again before apply.`,
        );
      }
      contentsBySource.set(operation.source_path, contents);
    }
    await ensureScaffold(preview.value.project_dir);
    for (const operation of preview.value.operations) {
      const contents = contentsBySource.get(operation.source_path);
      if (contents === undefined)
        throw new Error(`missing validated source: ${operation.source_path}`);
      await writeVerified(operation.destination_path, contents);
    }
    const manifest: VaultManifest = {
      schema_version: 1,
      source_dir: preview.value.source_dir,
      imported_at: new Date().toISOString(),
      documents: preview.value.operations,
    };
    await writeVerified(
      join(preview.value.project_dir, 'history', 'vault-import.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return preview;
  } catch (error: unknown) {
    return failure('VAULT_APPLY_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export async function reconcileVaultImport(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
}): Promise<
  VaultResult<{
    readonly project_id: string;
    readonly changed_sources: readonly string[];
    readonly missing_sources: readonly string[];
  }>
> {
  const store = await prepareProjectStore(options);
  if (!store.ok) return store;
  try {
    const manifest = JSON.parse(
      await readFile(join(store.value.projectDir, 'history', 'vault-import.json'), 'utf8'),
    ) as VaultManifest;
    const changedSources: string[] = [];
    const missingSources: string[] = [];
    for (const document of manifest.documents) {
      try {
        const contents = await readFile(join(manifest.source_dir, document.source_path), 'utf8');
        if (digest(contents) !== document.digest) changedSources.push(document.source_path);
      } catch {
        missingSources.push(document.source_path);
      }
    }
    return {
      ok: true,
      value: {
        project_id: store.value.projectId,
        changed_sources: changedSources.sort(),
        missing_sources: missingSources.sort(),
      },
    };
  } catch (error: unknown) {
    return failure(
      'VAULT_RECONCILE_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}
