import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

interface SkillFile {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
}

interface SkillFinding {
  readonly code: string;
  readonly severity: 'info' | 'warning';
  readonly path: string;
  readonly summary: string;
}

interface SkillInspection {
  readonly name: string;
  readonly description: string;
  readonly source_dir: string;
  readonly source_repository: string;
  readonly revision: string;
  readonly digest: string;
  readonly license: { readonly id: string; readonly path: string | null };
  readonly files: readonly SkillFile[];
  readonly scripts: readonly string[];
  readonly supported_agents: readonly ['agents', 'codex', 'claude', 'copilot'];
}

interface SkillAudit extends SkillInspection {
  readonly status: 'clean' | 'approval-required';
  readonly findings: readonly SkillFinding[];
  readonly requirements: {
    readonly shell: boolean;
    readonly network: boolean;
    readonly credentials: boolean;
  };
}

type SkillResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface SourceOptions {
  readonly sourceDir: string;
}

export interface PinnedSkillRecord {
  readonly source_repository: string;
  readonly revision: string;
  readonly digest: string;
  readonly license: string;
  readonly audit_status: SkillAudit['status'];
  readonly cache_dir: string;
  readonly scripts: readonly string[];
  readonly requirements: SkillAudit['requirements'];
  readonly supported_agents: SkillInspection['supported_agents'];
}

interface SkillRegistry {
  readonly schema_version: 1;
  readonly skills: Readonly<Record<string, PinnedSkillRecord>>;
}

function git(sourceDir: string, args: readonly string[]): string | null {
  const result = spawnSync('git', args, { cwd: sourceDir, encoding: 'utf8' });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value === '' ? null : value;
}

async function sourceFiles(sourceDir: string): Promise<Array<{ path: string; content: Buffer }>> {
  const files: Array<{ path: string; content: Buffer }> = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => {
      if (left.name < right.name) return -1;
      if (left.name > right.name) return 1;
      return 0;
    });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw Object.assign(new Error(`symlinked skill content is not allowed: ${absolute}`), {
          code: 'SKILL_SYMLINK_REJECTED',
        });
      }
      if (metadata.isDirectory()) await visit(absolute);
      else if (metadata.isFile()) {
        files.push({
          path: relative(sourceDir, absolute).split(sep).join('/'),
          content: await readFile(absolute),
        });
      }
    }
  }
  await visit(sourceDir);
  return files;
}

function frontmatter(contents: string): { name: string; description: string } | null {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match === null) return null;
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const field = line.match(/^([a-z_]+):\s*(.+)$/i);
    if (field !== null) fields.set(field[1]?.toLowerCase() ?? '', field[2]?.trim() ?? '');
  }
  const name = fields.get('name');
  const description = fields.get('description');
  return name === undefined || description === undefined ? null : { name, description };
}

function safeName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function licenseId(contents: string): string {
  if (/MIT License/i.test(contents)) return 'MIT';
  if (/Apache License.*2\.0/is.test(contents)) return 'Apache-2.0';
  if (/BSD 3-Clause/i.test(contents)) return 'BSD-3-Clause';
  return 'UNKNOWN';
}

function license(root: string): Promise<{ id: string; path: string | null }> {
  return (async () => {
    for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      try {
        const contents = await readFile(join(root, name), 'utf8');
        return { id: licenseId(contents), path: name };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { id: 'UNKNOWN', path: null };
  })();
}

function failure(error: unknown): SkillResult<never> {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'SKILL_INSPECT_FAILED';
  return {
    ok: false,
    error: { code, message: error instanceof Error ? error.message : String(error) },
  };
}

export async function inspectSkillSource(
  options: SourceOptions,
): Promise<SkillResult<SkillInspection>> {
  try {
    const canonicalSource = await realpath(options.sourceDir);
    const repositoryRoot = git(canonicalSource, ['rev-parse', '--show-toplevel']);
    const revision = git(canonicalSource, ['rev-parse', 'HEAD']);
    if (repositoryRoot === null || revision === null) {
      return {
        ok: false,
        error: {
          code: 'SKILL_GIT_REQUIRED',
          message: 'Skill source must belong to a Git checkout.',
        },
      };
    }
    const relativeSource = relative(repositoryRoot, canonicalSource);
    if (relativeSource.startsWith('..') || relativeSource === '') {
      return {
        ok: false,
        error: {
          code: 'SKILL_SOURCE_INVALID',
          message: 'Skill source must be a directory inside its Git checkout.',
        },
      };
    }
    const files = await sourceFiles(canonicalSource);
    const skill = files.find((file) => file.path === 'SKILL.md');
    if (skill === undefined) {
      return {
        ok: false,
        error: { code: 'SKILL_MANIFEST_MISSING', message: 'Skill source requires SKILL.md.' },
      };
    }
    const metadata = frontmatter(skill.content.toString('utf8'));
    if (metadata === null || !safeName(metadata.name)) {
      return {
        ok: false,
        error: {
          code: 'SKILL_MANIFEST_INVALID',
          message: 'SKILL.md requires a safe name and description.',
        },
      };
    }
    const hash = createHash('sha256');
    const described = files.map((file) => {
      const fileDigest = createHash('sha256').update(file.content).digest('hex');
      hash.update(file.path).update('\0').update(file.content).update('\0');
      return { path: file.path, bytes: file.content.byteLength, digest: fileDigest };
    });
    const scripts = described
      .filter((file) =>
        /(^|\/)(scripts?\/|[^/]+\.(?:sh|bash|zsh|ps1|py|js|mjs|cjs))/.test(file.path),
      )
      .map((file) => file.path);
    const remote = git(canonicalSource, ['config', '--get', 'remote.origin.url']);
    return {
      ok: true,
      value: {
        name: metadata.name,
        description: metadata.description,
        source_dir: canonicalSource,
        source_repository: remote ?? repositoryRoot,
        revision,
        digest: hash.digest('hex'),
        license: await license(repositoryRoot),
        files: described,
        scripts,
        supported_agents: ['agents', 'codex', 'claude', 'copilot'],
      },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function auditSkillSource(options: SourceOptions): Promise<SkillResult<SkillAudit>> {
  const inspected = await inspectSkillSource(options);
  if (!inspected.ok) return inspected;
  const findings: SkillFinding[] = [];
  if (inspected.value.scripts.length > 0) {
    findings.push({
      code: 'SKILL_SCRIPT_PRESENT',
      severity: 'warning',
      path: inspected.value.scripts[0] ?? 'SKILL.md',
      summary:
        'Bundled executable content requires explicit approval and is never run during install.',
    });
  }
  let hasNetwork = false;
  let hasCredentials = false;
  for (const file of await sourceFiles(options.sourceDir)) {
    const text = file.content.toString('utf8');
    if (/\b(?:curl|wget)\s+|\bfetch\s*\(/i.test(text)) hasNetwork = true;
    if (
      /\bAuthorization\b/i.test(text) ||
      /(?:\$|\$\{)?[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\b/.test(text)
    )
      hasCredentials = true;
  }
  if (hasNetwork)
    findings.push({
      code: 'SKILL_NETWORK_REQUIRED',
      severity: 'warning',
      path: 'SKILL.md',
      summary: 'Skill content references network access.',
    });
  if (hasCredentials)
    findings.push({
      code: 'SKILL_CREDENTIAL_REQUIRED',
      severity: 'warning',
      path: 'SKILL.md',
      summary: 'Skill content references credentials or authorization.',
    });
  if (inspected.value.license.id === 'UNKNOWN')
    findings.push({
      code: 'SKILL_LICENSE_UNKNOWN',
      severity: 'warning',
      path: inspected.value.license.path ?? '.',
      summary: 'No recognized source license was found.',
    });
  const requirements = {
    shell: inspected.value.scripts.length > 0,
    network: hasNetwork,
    credentials: hasCredentials,
  };
  return {
    ok: true,
    value: {
      ...inspected.value,
      status: findings.length === 0 ? 'clean' : 'approval-required',
      findings,
      requirements,
    },
  };
}

async function readRegistry(path: string): Promise<SkillRegistry> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as SkillRegistry;
    throw new Error('invalid skill registry');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schema_version: 1, skills: {} };
    throw error;
  }
}

async function writeVerified(path: string, value: unknown): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  if ((await readFile(path, 'utf8')) !== contents)
    throw new Error(`write verification failed: ${path}`);
}

export async function addPinnedSkill(
  options: SourceOptions & {
    readonly rizzHome: string;
    readonly revision: string;
    readonly approved: boolean;
  },
): Promise<
  SkillResult<{
    readonly name: string;
    readonly digest: string;
    readonly source_revision: string;
    readonly cache_dir: string;
  }>
> {
  if (!options.approved)
    return {
      ok: false,
      error: {
        code: 'SKILL_APPROVAL_REQUIRED',
        message: 'Pinned skill installation requires explicit approval.',
      },
    };
  const audited = await inspectPinnedSkillCandidate(options);
  if (!audited.ok) return audited;
  const base = join(options.rizzHome, 'global', 'skills');
  const cacheDir = join(base, 'cache', audited.value.digest);
  await mkdir(cacheDir, { recursive: true });
  for (const file of await sourceFiles(audited.value.source_dir)) {
    const destination = join(cacheDir, ...file.path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    try {
      await writeFile(destination, file.content, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!Buffer.from(await readFile(destination)).equals(file.content)) {
      return {
        ok: false,
        error: {
          code: 'SKILL_CACHE_VERIFY_FAILED',
          message: `Cached skill file mismatch: ${file.path}`,
        },
      };
    }
  }
  const registryPath = join(base, 'registry.json');
  await mkdir(dirname(registryPath), { recursive: true });
  const registry = await readRegistry(registryPath);
  const entry: PinnedSkillRecord = {
    source_repository: audited.value.source_repository,
    revision: audited.value.revision,
    digest: audited.value.digest,
    license: audited.value.license.id,
    audit_status: audited.value.status,
    cache_dir: cacheDir,
    scripts: audited.value.scripts,
    requirements: audited.value.requirements,
    supported_agents: audited.value.supported_agents,
  };
  await writeVerified(registryPath, {
    schema_version: 1,
    skills: { ...registry.skills, [audited.value.name]: entry },
  });
  return {
    ok: true,
    value: {
      name: audited.value.name,
      digest: audited.value.digest,
      source_revision: audited.value.revision,
      cache_dir: cacheDir,
    },
  };
}

export async function readPinnedSkillRecord(options: {
  readonly rizzHome: string;
  readonly name: string;
}): Promise<SkillResult<PinnedSkillRecord>> {
  const registry = await readRegistry(join(options.rizzHome, 'global', 'skills', 'registry.json'));
  const record = registry.skills[options.name];
  return record === undefined
    ? {
        ok: false,
        error: { code: 'SKILL_NOT_PINNED', message: `Skill is not pinned: ${options.name}` },
      }
    : { ok: true, value: record };
}

export async function verifyPinnedSkillCache(options: {
  readonly record: PinnedSkillRecord;
}): Promise<SkillResult<{ readonly digest: string }>> {
  try {
    const hash = createHash('sha256');
    for (const file of await sourceFiles(options.record.cache_dir)) {
      hash.update(file.path).update('\0').update(file.content).update('\0');
    }
    const digest = hash.digest('hex');
    return digest === options.record.digest
      ? { ok: true, value: { digest } }
      : {
          ok: false,
          error: {
            code: 'SKILL_CACHE_TAMPERED',
            message: 'Pinned skill cache content does not match its recorded digest.',
          },
        };
  } catch (error) {
    return failure(error);
  }
}

export async function listPinnedSkillFiles(options: {
  readonly record: PinnedSkillRecord;
}): Promise<SkillResult<readonly SkillFile[]>> {
  const verified = await verifyPinnedSkillCache(options);
  if (!verified.ok) return verified;
  const files = await sourceFiles(options.record.cache_dir);
  return {
    ok: true,
    value: files.map((file) => ({
      path: file.path,
      bytes: file.content.byteLength,
      digest: createHash('sha256').update(file.content).digest('hex'),
    })),
  };
}

export async function inspectPinnedSkillCandidate(
  options: SourceOptions & {
    readonly revision: string;
  },
): Promise<SkillResult<SkillAudit>> {
  const audited = await auditSkillSource(options);
  if (!audited.ok) return audited;
  if (audited.value.revision !== options.revision) {
    return {
      ok: false,
      error: {
        code: 'SKILL_REVISION_MISMATCH',
        message: 'Requested pin does not match the checked-out source revision.',
      },
    };
  }
  const repositoryRoot = git(audited.value.source_dir, ['rev-parse', '--show-toplevel']);
  if (repositoryRoot === null) {
    return {
      ok: false,
      error: { code: 'SKILL_GIT_REQUIRED', message: 'Skill source must belong to Git.' },
    };
  }
  const relativeSource = relative(repositoryRoot, audited.value.source_dir);
  const dirty = git(audited.value.source_dir, [
    'status',
    '--porcelain',
    '--',
    `:(top)${relativeSource}`,
  ]);
  if (dirty !== null) {
    return {
      ok: false,
      error: {
        code: 'SKILL_SOURCE_DIRTY',
        message: 'Pinned skill source contains changes outside the requested revision.',
      },
    };
  }
  return audited;
}
