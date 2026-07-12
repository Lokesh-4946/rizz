import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

export interface ProjectStore {
  readonly projectId: string;
  readonly projectDir: string;
  readonly brainDir: string;
  readonly researchDir: string;
  readonly reportsDir: string;
  readonly rootPath: string;
  readonly remoteIdentity: string | null;
}

export type PrepareProjectStoreResult =
  | { readonly ok: true; readonly value: ProjectStore }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface ProjectRegistryEntry {
  readonly root_path: string;
  readonly remote_identity: string | null;
  readonly project_dir: string;
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
  if (currentPlatform === 'darwin') return join(homeDir, 'Library', 'Application Support', 'rizz');
  if (currentPlatform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    return `${localAppData === undefined || localAppData === '' ? homeDir : localAppData}/rizz`;
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return join(
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
    const rootFingerprint = createHash('sha256').update(rootPath).digest('hex');
    const identity = `${remoteIdentity ?? 'local'}\0${rootFingerprint}`;
    const projectId = createHash('sha256').update(identity).digest('hex').slice(0, 24);
    const projectDir = join(rizzHome, 'projects', projectId);
    const directories = [
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
    ];
    await Promise.all([
      mkdir(join(rizzHome, 'global', 'skills'), { recursive: true }),
      mkdir(join(rizzHome, 'global', 'adapters'), { recursive: true }),
      ...directories.map((directory) => mkdir(join(projectDir, directory), { recursive: true })),
    ]);
    const entry: ProjectRegistryEntry = {
      root_path: rootPath,
      remote_identity: remoteIdentity,
      project_dir: projectDir,
    };
    await writeVerified(
      join(projectDir, 'project.json'),
      `${JSON.stringify({ schema_version: 1, project_id: projectId, name: basename(rootPath), ...entry }, null, 2)}\n`,
    );
    const registryPath = join(rizzHome, 'registry.json');
    const releaseRegistryLock = await acquireRegistryLock(rizzHome);
    try {
      const registry = await readRegistry(registryPath);
      await writeVerified(
        registryPath,
        `${JSON.stringify({ schema_version: 1, projects: { ...registry.projects, [projectId]: entry } }, null, 2)}\n`,
      );
    } finally {
      await releaseRegistryLock();
    }
    return {
      ok: true,
      value: {
        projectId,
        projectDir,
        brainDir: join(projectDir, 'brain'),
        researchDir: join(projectDir, 'research'),
        reportsDir: join(projectDir, 'reports'),
        rootPath,
        remoteIdentity,
      },
    };
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
