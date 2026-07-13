import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

export interface ProjectStore {
  readonly projectId: string;
  readonly projectDir: string;
  readonly brainDir: string;
  readonly researchDir: string;
  readonly reportsDir: string;
  readonly rootPath: string;
  readonly remoteIdentity: string | null;
  readonly repositoryFingerprint: string;
}

export type PrepareProjectStoreResult =
  | { readonly ok: true; readonly value: ProjectStore }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface ProjectRegistryEntry {
  readonly root_path: string;
  readonly remote_identity: string | null;
  readonly project_dir: string;
  readonly repository_fingerprint?: string;
  readonly root_fingerprint?: string;
}

interface ProjectRegistry {
  readonly schema_version: 1;
  readonly projects: Readonly<Record<string, ProjectRegistryEntry>>;
}

export function resolveRizzHome(params?: {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string {
  const currentPlatform = params?.platform ?? platform();
  const homeDir = params?.homeDir ?? homedir();
  const env = params?.env ?? process.env;
  if (env.RIZZ_HOME !== undefined && env.RIZZ_HOME.trim() !== '') return env.RIZZ_HOME;
  const platformPath = currentPlatform === 'win32' ? win32 : posix;
  if (currentPlatform === 'darwin') {
    return platformPath.join(homeDir, 'Library', 'Application Support', 'rizz');
  }
  if (currentPlatform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    return platformPath.join(
      localAppData === undefined || localAppData === '' ? homeDir : localAppData,
      'rizz',
    );
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return platformPath.join(
    xdgDataHome === undefined || xdgDataHome === ''
      ? join(homeDir, '.local', 'share')
      : xdgDataHome,
    'rizz',
  );
}

export function normalizeGitRemote(value: string): string {
  const trimmed = value.trim().replace(/^git@([^:]+):/, 'ssh://git@$1/');
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname
      .replace(/^\/+/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
    return `${host}/${path}`;
  } catch {
    return trimmed.replace(/\.git$/i, '').toLowerCase();
  }
}

function gitRemote(rootDir: string): string | null {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value === '' ? null : value;
}

function repositoryFingerprint(rootDir: string): string {
  const result = spawnSync('git', ['rev-list', '--max-parents=0', '--all'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const roots = result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean).sort() : [];
  const identity = roots.length === 0 ? `unborn\0${rootDir}` : `roots\0${roots.join('\0')}`;
  return createHash('sha256').update(identity).digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch {
    return false;
  }
}

async function readRegistry(path: string): Promise<ProjectRegistry> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (
        record.schema_version === 1 &&
        typeof record.projects === 'object' &&
        record.projects !== null
      ) {
        return parsed as ProjectRegistry;
      }
    }
    throw new Error(`invalid project registry: ${path}`);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { schema_version: 1, projects: {} };
    }
    throw error;
  }
}

async function writeVerified(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, path);
  if ((await readFile(path, 'utf8')) !== contents) {
    throw new Error(`write verification failed for ${path}`);
  }
}

async function acquireRegistryLock(rizzHome: string): Promise<() => Promise<void>> {
  const lockPath = join(rizzHome, 'registry.lock');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockPath);
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error: unknown) {
      const isLocked =
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
      if (!isLocked) throw error;
      await wait(10);
    }
  }
  throw new Error(`timed out acquiring project registry lock: ${lockPath}`);
}

const PROJECT_DIRECTORIES = [
  'product',
  'planning',
  'brain',
  'governance',
  'loop',
  'work',
  'handoffs',
  'evidence',
  'reviews',
  'skills',
  'cache',
  'history',
  'research',
  'reports',
] as const;

function projectStore(
  projectId: string,
  entry: ProjectRegistryEntry,
  repositoryId: string,
): ProjectStore {
  return {
    projectId,
    projectDir: entry.project_dir,
    brainDir: join(entry.project_dir, 'brain'),
    researchDir: join(entry.project_dir, 'research'),
    reportsDir: join(entry.project_dir, 'reports'),
    rootPath: entry.root_path,
    remoteIdentity: entry.remote_identity,
    repositoryFingerprint: repositoryId,
  };
}

async function writeProjectMetadata(
  store: ProjectStore,
  entry: ProjectRegistryEntry,
): Promise<void> {
  await Promise.all(
    PROJECT_DIRECTORIES.map((directory) =>
      mkdir(join(store.projectDir, directory), { recursive: true }),
    ),
  );
  await writeVerified(
    join(store.projectDir, 'project.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        project_id: store.projectId,
        name: basename(store.rootPath),
        ...entry,
      },
      null,
      2,
    )}\n`,
  );
}

function matchesRepository(
  entry: ProjectRegistryEntry,
  remoteIdentity: string | null,
  repositoryId: string,
): boolean {
  if (remoteIdentity !== null) return entry.remote_identity === remoteIdentity;
  return (
    entry.remote_identity === null &&
    entry.repository_fingerprint !== undefined &&
    entry.repository_fingerprint === repositoryId
  );
}

export async function prepareProjectStore(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly remote?: string | null;
}): Promise<PrepareProjectStoreResult> {
  try {
    const rootPath = await realpath(options.rootDir);
    const rizzHome = options.rizzHome ?? resolveRizzHome();
    const rawRemote = options.remote === undefined ? gitRemote(rootPath) : options.remote;
    const remoteIdentity = rawRemote === null ? null : normalizeGitRemote(rawRemote);
    const repositoryId = repositoryFingerprint(rootPath);
    const rootFingerprint = createHash('sha256').update(rootPath).digest('hex');
    await Promise.all([
      mkdir(join(rizzHome, 'global', 'skills'), { recursive: true }),
      mkdir(join(rizzHome, 'global', 'adapters'), { recursive: true }),
    ]);
    const registryPath = join(rizzHome, 'registry.json');
    const releaseRegistryLock = await acquireRegistryLock(rizzHome);
    try {
      const registry = await readRegistry(registryPath);
      const entries = Object.entries(registry.projects);
      const exact = entries.find(
        ([, entry]) => entry.root_path === rootPath && entry.remote_identity === remoteIdentity,
      );
      const staleMatches = [];
      for (const candidate of entries) {
        const [, entry] = candidate;
        if (
          entry.root_path !== rootPath &&
          matchesRepository(entry, remoteIdentity, repositoryId) &&
          !(await pathExists(entry.root_path))
        ) {
          staleMatches.push(candidate);
        }
      }
      if (exact === undefined && staleMatches.length > 0) {
        return {
          ok: false,
          error: {
            code: 'PROJECT_RELINK_REQUIRED',
            message: `This repository matches ${staleMatches.length} project workspace(s) whose registered path no longer exists. Run rizz project relink.`,
          },
        };
      }
      const identity = `${remoteIdentity ?? 'local'}\0${rootFingerprint}`;
      const projectId =
        exact?.[0] ?? createHash('sha256').update(identity).digest('hex').slice(0, 24);
      const entry: ProjectRegistryEntry = {
        root_path: rootPath,
        remote_identity: remoteIdentity,
        project_dir: exact?.[1].project_dir ?? join(rizzHome, 'projects', projectId),
        repository_fingerprint: repositoryId,
        root_fingerprint: rootFingerprint,
      };
      const store = projectStore(projectId, entry, repositoryId);
      await writeProjectMetadata(store, entry);
      await writeVerified(
        registryPath,
        `${JSON.stringify({ schema_version: 1, projects: { ...registry.projects, [projectId]: entry } }, null, 2)}\n`,
      );
      return { ok: true, value: store };
    } finally {
      await releaseRegistryLock();
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'PROJECT_STORE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function readProjectStore(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly remote?: string | null;
}): Promise<PrepareProjectStoreResult> {
  try {
    const rootPath = await realpath(options.rootDir);
    const rizzHome = options.rizzHome ?? resolveRizzHome();
    const rawRemote = options.remote === undefined ? gitRemote(rootPath) : options.remote;
    const remoteIdentity = rawRemote === null ? null : normalizeGitRemote(rawRemote);
    const repositoryId = repositoryFingerprint(rootPath);
    const registry = await readRegistry(join(rizzHome, 'registry.json'));
    const exact = Object.entries(registry.projects).find(
      ([, entry]) => entry.root_path === rootPath && entry.remote_identity === remoteIdentity,
    );
    if (exact === undefined) {
      return {
        ok: false,
        error: {
          code: 'PROJECT_PREPARE_REQUIRED',
          message: 'No isolated project workspace is registered. Run rizz prepare first.',
        },
      };
    }
    return { ok: true, value: projectStore(exact[0], exact[1], repositoryId) };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'PROJECT_STORE_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function relinkProjectStore(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly remote?: string | null;
  readonly projectId?: string;
}): Promise<PrepareProjectStoreResult> {
  try {
    const rootPath = await realpath(options.rootDir);
    const rizzHome = options.rizzHome ?? resolveRizzHome();
    const rawRemote = options.remote === undefined ? gitRemote(rootPath) : options.remote;
    const remoteIdentity = rawRemote === null ? null : normalizeGitRemote(rawRemote);
    const repositoryId = repositoryFingerprint(rootPath);
    const rootFingerprint = createHash('sha256').update(rootPath).digest('hex');
    await mkdir(rizzHome, { recursive: true });
    const registryPath = join(rizzHome, 'registry.json');
    const releaseRegistryLock = await acquireRegistryLock(rizzHome);
    try {
      const registry = await readRegistry(registryPath);
      const candidates = Object.entries(registry.projects).filter(
        ([projectId, entry]) =>
          (options.projectId === undefined || options.projectId === projectId) &&
          (options.projectId !== undefined ||
            matchesRepository(entry, remoteIdentity, repositoryId)),
      );
      const exact = candidates.find(([, entry]) => entry.root_path === rootPath);
      if (exact !== undefined) {
        return { ok: true, value: projectStore(exact[0], exact[1], repositoryId) };
      }
      if (candidates.length === 0) {
        return {
          ok: false,
          error: {
            code: 'PROJECT_RELINK_NOT_FOUND',
            message: 'No registered project workspace matches this repository.',
          },
        };
      }
      if (candidates.length > 1) {
        return {
          ok: false,
          error: {
            code: 'PROJECT_RELINK_AMBIGUOUS',
            message: `Multiple project workspaces match. Rerun with one of these project IDs: ${candidates.map(([id]) => id).join(', ')}.`,
          },
        };
      }
      const selected = candidates[0];
      if (selected === undefined) {
        return {
          ok: false,
          error: { code: 'PROJECT_RELINK_NOT_FOUND', message: 'No project workspace selected.' },
        };
      }
      const [projectId, previous] = selected;
      if ((await pathExists(previous.root_path)) && options.projectId === undefined) {
        return {
          ok: false,
          error: {
            code: 'PROJECT_RELINK_SOURCE_ACTIVE',
            message: `The registered path still exists: ${previous.root_path}. Pass its project ID only if replacing that registration is intentional.`,
          },
        };
      }
      const entry: ProjectRegistryEntry = {
        ...previous,
        root_path: rootPath,
        remote_identity: remoteIdentity,
        repository_fingerprint: repositoryId,
        root_fingerprint: rootFingerprint,
      };
      const store = projectStore(projectId, entry, repositoryId);
      await writeProjectMetadata(store, entry);
      await writeVerified(
        registryPath,
        `${JSON.stringify(
          { schema_version: 1, projects: { ...registry.projects, [projectId]: entry } },
          null,
          2,
        )}\n`,
      );
      return { ok: true, value: store };
    } finally {
      await releaseRegistryLock();
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'PROJECT_RELINK_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
