import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readText } from './io.js';
import { isRecord } from './model.js';
import { type StaffResult, staffErr, staffOk } from './result.js';

const ORPHAN_LOCK_MS = 1_000;
const CLAIM_WAIT_MS = 2_000;
const STOP_WAIT_MS = 5_000;

export interface ServeRecord {
  readonly pid: number;
  readonly url: string;
}

export type ServeClaim =
  | { readonly state: 'claimed' }
  | { readonly state: 'running'; readonly record: ServeRecord };

interface RegisteredProject {
  readonly rootPath: string;
  readonly projectDir: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

async function readPid(lockDir: string): Promise<number | undefined> {
  try {
    const text = await readFile(join(lockDir, 'pid'), 'utf8');
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return pid;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function parseServeUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('http://127.0.0.1:')) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== '127.0.0.1') return undefined;
    const token = parsed.searchParams.get('token');
    if (token === null || token === '') return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

async function readUrl(lockDir: string): Promise<string | undefined> {
  try {
    return parseServeUrl(await readFile(join(lockDir, 'url'), 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function lockIsStale(lockDir: string): Promise<boolean> {
  const pid = await readPid(lockDir);
  if (pid !== undefined) return !pidAlive(pid);
  try {
    const info = await stat(lockDir);
    return Date.now() - info.mtimeMs > ORPHAN_LOCK_MS;
  } catch {
    return true;
  }
}

async function readRunning(lockDir: string): Promise<ServeRecord | undefined> {
  const pid = await readPid(lockDir);
  if (pid === undefined || !pidAlive(pid)) return undefined;
  const url = await readUrl(lockDir);
  if (url === undefined) return undefined;
  return { pid, url };
}

export async function readLiveServe(
  lockDir: string,
): Promise<StaffResult<ServeRecord | undefined>> {
  try {
    return staffOk(await readRunning(lockDir));
  } catch (error) {
    return staffErr('IO_FAILED', `cannot read the serve lock: ${errorMessage(error)}`);
  }
}

async function verifyFile(path: string, contents: string): Promise<StaffResult<void>> {
  const written = await readFile(path, 'utf8');
  if (written !== contents) {
    return staffErr('WRITE_VERIFY_FAILED', `serve lock file did not match: ${path}`);
  }
  return staffOk(undefined);
}

export async function claimServeLock(
  lockDir: string,
  pid: number,
): Promise<StaffResult<ServeClaim>> {
  try {
    await mkdir(dirname(lockDir), { recursive: true });
    const started = Date.now();
    for (;;) {
      try {
        await mkdir(lockDir);
        const pidText = `${pid}\n`;
        await writeFile(join(lockDir, 'pid'), pidText, { mode: 0o600 });
        const verified = await verifyFile(join(lockDir, 'pid'), pidText);
        if (!verified.ok) {
          await rm(lockDir, { recursive: true, force: true });
          return verified;
        }
        return staffOk({ state: 'claimed' });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          return staffErr('IO_FAILED', `cannot lock serve: ${errorMessage(error)}`);
        }
        if (await lockIsStale(lockDir)) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        const running = await readRunning(lockDir);
        if (running !== undefined) return staffOk({ state: 'running', record: running });
        if (Date.now() - started > CLAIM_WAIT_MS) {
          return staffErr('IO_FAILED', 'timed out claiming the serve lock');
        }
        await wait(15);
      }
    }
  } catch (error) {
    return staffErr('IO_FAILED', `cannot lock serve: ${errorMessage(error)}`);
  }
}

export async function writeServeUrl(lockDir: string, url: string): Promise<StaffResult<void>> {
  const parsed = parseServeUrl(url);
  if (parsed === undefined) {
    return staffErr('INVALID_STATE', 'serve url is not a local token page');
  }
  const path = join(lockDir, 'url');
  const contents = `${parsed}\n`;
  try {
    await writeFile(path, contents, { mode: 0o600 });
    return await verifyFile(path, contents);
  } catch (error) {
    return staffErr('IO_FAILED', `cannot write the serve url: ${errorMessage(error)}`);
  }
}

export async function releaseServeLock(lockDir: string, pid: number): Promise<void> {
  try {
    const current = await readPid(lockDir);
    if (current !== undefined && current !== pid) return;
    await rm(lockDir, { recursive: true, force: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await wait(50);
  }
  return !pidAlive(pid);
}

export async function stopServeLock(
  lockDir: string,
): Promise<
  StaffResult<
    { readonly status: 'stopped'; readonly pid: number } | { readonly status: 'not-running' }
  >
> {
  try {
    const pid = await readPid(lockDir);
    if (pid === undefined || !pidAlive(pid)) {
      await rm(lockDir, { recursive: true, force: true });
      return staffOk({ status: 'not-running' });
    }
    if (pid === process.pid) {
      return staffErr('INVALID_STATE', 'refusing to stop the current process');
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (!pidAlive(pid)) {
        await rm(lockDir, { recursive: true, force: true });
        return staffOk({ status: 'not-running' });
      }
      return staffErr('IO_FAILED', `cannot stop serve process ${pid}: ${errorMessage(error)}`);
    }
    let stopped = await waitUntilDead(pid, STOP_WAIT_MS);
    if (!stopped) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (pidAlive(pid)) {
          return staffErr('IO_FAILED', `cannot stop serve process ${pid}: ${errorMessage(error)}`);
        }
      }
      stopped = await waitUntilDead(pid, 2_000);
    }
    if (!stopped) return staffErr('IO_FAILED', `serve process ${pid} did not exit`);
    await rm(lockDir, { recursive: true, force: true });
    return staffOk({ status: 'stopped', pid });
  } catch (error) {
    return staffErr('IO_FAILED', `cannot stop serve: ${errorMessage(error)}`);
  }
}

async function readRegistryProjects(
  rizzHome: string,
): Promise<StaffResult<readonly RegisteredProject[]>> {
  const registry = await readText(join(rizzHome, 'registry.json'));
  if (!registry.ok) return registry;
  if (registry.value === undefined) return staffOk([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(registry.value);
  } catch {
    return staffErr('INVALID_STATE', 'project registry is unreadable');
  }
  if (!isRecord(parsed) || !isRecord(parsed.projects)) {
    return staffErr('INVALID_STATE', 'project registry is unreadable');
  }
  const projects: RegisteredProject[] = [];
  for (const entry of Object.values(parsed.projects)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.project_dir !== 'string' || entry.project_dir === '') continue;
    if (typeof entry.root_path !== 'string') continue;
    projects.push({ rootPath: entry.root_path, projectDir: entry.project_dir });
  }
  return staffOk(projects);
}

export async function registeredProjectDirs(
  rizzHome: string,
): Promise<StaffResult<readonly string[]>> {
  const projects = await readRegistryProjects(rizzHome);
  if (!projects.ok) return projects;
  return staffOk(projects.value.map((project) => project.projectDir));
}

export async function projectDirForRoot(
  rizzHome: string,
  projectRoot: string,
): Promise<StaffResult<string | undefined>> {
  let root = projectRoot;
  try {
    root = await realpath(projectRoot);
  } catch (error) {
    return staffErr('IO_FAILED', `cannot read ${projectRoot}: ${errorMessage(error)}`);
  }
  const projects = await readRegistryProjects(rizzHome);
  if (!projects.ok) return projects;
  const match = projects.value.find((project) => project.rootPath === root);
  return staffOk(match?.projectDir);
}
