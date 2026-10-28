import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type StaffResult, staffErr, staffOk } from './result.js';

const ORPHAN_LOCK_MS = 1_000;
const LOCK_WAIT_MS = 2_000;

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

/**
 * Drop a trailing partial record so the next append cannot glue onto a killed write.
 * A committed record ends in a newline. Bytes after the last newline were not finished.
 */
async function dropTornTail(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r+');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.size === 0) return;
    let cursor = info.size;
    let newlineAt = -1;
    while (cursor > 0 && newlineAt === -1) {
      const take = Math.min(cursor, 64 * 1024);
      const start = cursor - take;
      const buf = Buffer.alloc(take);
      await handle.read(buf, 0, take, start);
      for (let index = buf.length - 1; index >= 0; index -= 1) {
        if (buf[index] === 0x0a) {
          newlineAt = start + index;
          break;
        }
      }
      cursor = start;
    }
    const nextSize = newlineAt === -1 ? 0 : newlineAt + 1;
    if (nextSize !== info.size) {
      await handle.truncate(nextSize);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

async function verifyTail(path: string, chunk: string): Promise<boolean> {
  const expected = Buffer.from(chunk);
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (info.size < expected.length) return false;
    const got = Buffer.alloc(expected.length);
    const read = await handle.read(got, 0, expected.length, info.size - expected.length);
    if (read.bytesRead !== expected.length) return false;
    return got.equals(expected);
  } finally {
    await handle.close();
  }
}

/** Append bytes and fsync. Callers pass a chunk that already ends in a newline. */
export async function appendSynced(path: string, chunk: string): Promise<StaffResult<void>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await dropTornTail(path);
    const handle = await open(path, 'a');
    try {
      await handle.write(chunk);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const verified = await verifyTail(path, chunk);
    if (!verified) {
      return staffErr('WRITE_VERIFY_FAILED', `append to ${path} did not match what was read back`);
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

async function readLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const text = await readFile(join(lockPath, 'pid'), 'utf8');
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return pid;
  } catch {
    return undefined;
  }
}

/** A dead holder is stale immediately. A lock with no pid file is stale after one second. */
async function lockIsStale(lockPath: string): Promise<boolean> {
  const pid = await readLockPid(lockPath);
  if (pid !== undefined) return !pidAlive(pid);
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > ORPHAN_LOCK_MS;
  } catch {
    return true;
  }
}

/** Exclusive directory lock. One writer at a time; a killed holder does not stick. */
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
        await writeFile(join(lockPath, 'pid'), `${process.pid}\n`);
        return await body();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        return staffErr('IO_FAILED', `cannot lock ${lockPath}: ${errorMessage(error)}`);
      }
      if (await lockIsStale(lockPath)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        return staffErr('IO_FAILED', `timed out locking ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}
