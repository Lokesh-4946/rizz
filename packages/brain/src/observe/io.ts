import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type StaffResult, staffErr, staffOk } from './result.js';

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

/** Write the full file, fsync, then rename over the destination. A crash keeps the previous file. */
export async function writeAtomic(path: string, contents: string): Promise<StaffResult<void>> {
  const dir = dirname(path);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    const actual = await readFile(path, 'utf8');
    if (actual !== contents) {
      return staffErr('WRITE_VERIFY_FAILED', `write to ${path} did not match what was read back`);
    }
    return staffOk(undefined);
  } catch (error) {
    await rm(tmp, { force: true });
    return staffErr('IO_FAILED', `cannot write ${path}: ${errorMessage(error)}`);
  }
}

/** Append bytes and fsync. Callers pass a chunk that already ends in a newline. */
export async function appendSynced(path: string, chunk: string): Promise<StaffResult<void>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'a');
    try {
      await handle.write(chunk);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return staffOk(undefined);
  } catch (error) {
    return staffErr('IO_FAILED', `cannot append ${path}: ${errorMessage(error)}`);
  }
}

export async function readText(path: string): Promise<StaffResult<string | undefined>> {
  try {
    return staffOk(await readFile(path, 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return staffOk(undefined);
    return staffErr('IO_FAILED', `cannot read ${path}: ${errorMessage(error)}`);
  }
}

/** Exclusive directory lock. Stale locks older than 10s are removed. */
export async function withLock<T>(
  lockPath: string,
  body: () => Promise<StaffResult<T>>,
): Promise<StaffResult<T>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath);
      try {
        return await body();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        return staffErr('IO_FAILED', `cannot lock ${lockPath}: ${errorMessage(error)}`);
      }
      if (Date.now() - started > 2000) {
        return staffErr('IO_FAILED', `timed out locking ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}
