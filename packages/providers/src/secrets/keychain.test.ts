import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANTHROPIC_ACCOUNT,
  type FileBackendDeps,
  RIZZ_SERVICE,
  type Runner,
  libsecretArgs,
  macosArgs,
  openSecretStore,
} from './keychain.js';

const REF = { service: RIZZ_SERVICE, account: ANTHROPIC_ACCOUNT };

const okRun: Runner = async () => ({ code: 0, stdout: '', stderr: '' });
const missingRun: Runner = async () => ({ code: 1, stdout: '', stderr: '' });
const noopFileDeps: FileBackendDeps = {
  path: '/tmp/none',
  readFile: () => null,
  writeFile: () => {},
};

/** Real-fs file deps at a chosen path (mirrors the default, but not under ~/.rizz). */
function realFileDeps(path: string): FileBackendDeps {
  return {
    path,
    readFile(p) {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile(p, content) {
      writeFileSync(p, content, { mode: 0o600 });
      chmodSync(p, 0o600);
    },
  };
}

describe('command builders', () => {
  it('builds macOS security argv', () => {
    expect(macosArgs.get(REF)).toEqual([
      'find-generic-password',
      '-s',
      'rizz',
      '-a',
      'anthropic',
      '-w',
    ]);
    expect(macosArgs.set(REF)).toEqual([
      'add-generic-password',
      '-U',
      '-s',
      'rizz',
      '-a',
      'anthropic',
      '-w',
    ]);
    expect(macosArgs.delete(REF)).toEqual([
      'delete-generic-password',
      '-s',
      'rizz',
      '-a',
      'anthropic',
    ]);
  });

  it('builds libsecret secret-tool argv', () => {
    expect(libsecretArgs.lookup(REF)).toEqual([
      'lookup',
      'service',
      'rizz',
      'account',
      'anthropic',
    ]);
    expect(libsecretArgs.store(REF)[0]).toBe('store');
    expect(libsecretArgs.clear(REF)).toEqual(['clear', 'service', 'rizz', 'account', 'anthropic']);
  });
});

describe('backend selection', () => {
  it('selects macOS Keychain on darwin', async () => {
    const store = await openSecretStore({ platform: 'darwin', runner: okRun });
    expect(store.backend).toBe('macos-keychain');
  });

  it('selects libsecret on linux when secret-tool exists', async () => {
    const store = await openSecretStore({ platform: 'linux', runner: okRun });
    expect(store.backend).toBe('libsecret');
  });

  it('falls back to the file store on linux without secret-tool', async () => {
    const store = await openSecretStore({
      platform: 'linux',
      runner: missingRun,
      fileDeps: noopFileDeps,
    });
    expect(store.backend).toBe('file');
  });

  it('uses the file store on windows', async () => {
    const store = await openSecretStore({
      platform: 'win32',
      runner: okRun,
      fileDeps: noopFileDeps,
    });
    expect(store.backend).toBe('file');
  });
});

describe('macOS backend over an injected runner', () => {
  it('returns null only for errSecItemNotFound (exit 44)', async () => {
    const run: Runner = async () => ({ code: 44, stdout: '', stderr: 'not found' });
    const store = await openSecretStore({ platform: 'darwin', runner: run });
    expect(await store.get(REF)).toEqual({ ok: true, value: null });
  });

  it('surfaces a locked/denied keychain (non-44 exit) as TOOL_IO, not silent demo', async () => {
    const run: Runner = async () => ({ code: 36, stdout: '', stderr: 'interaction required' });
    const store = await openSecretStore({ platform: 'darwin', runner: run });
    const got = await store.get(REF);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error.code).toBe('TOOL_IO');
  });

  it('returns the trimmed secret on success', async () => {
    const run: Runner = async () => ({ code: 0, stdout: 'secret-value\n', stderr: '' });
    const store = await openSecretStore({ platform: 'darwin', runner: run });
    expect(await store.get(REF)).toEqual({ ok: true, value: 'secret-value' });
  });

  it('reports a write failure as TOOL_IO', async () => {
    const run: Runner = async () => ({ code: 1, stdout: '', stderr: 'denied' });
    const store = await openSecretStore({ platform: 'darwin', runner: run });
    const set = await store.set(REF, 'k');
    expect(set.ok).toBe(false);
    if (set.ok) return;
    expect(set.error.code).toBe('TOOL_IO');
  });

  it('feeds the secret to security over stdin, never via argv', async () => {
    let captured: { args: readonly string[]; input: string | undefined } | undefined;
    const run: Runner = async (_file, args, input) => {
      captured = { args, input };
      return { code: 0, stdout: '', stderr: '' };
    };
    const store = await openSecretStore({ platform: 'darwin', runner: run });
    await store.set(REF, 'super-secret');
    expect(captured?.input).toBe('super-secret');
    expect(captured?.args).not.toContain('super-secret');
  });
});

describe('probe + write-failure paths', () => {
  it('probes for secret-tool with `which` on the resolved platform', async () => {
    const seen: string[] = [];
    const run: Runner = async (file) => {
      seen.push(file);
      return { code: 1, stdout: '', stderr: '' };
    };
    await openSecretStore({ platform: 'linux', runner: run, fileDeps: noopFileDeps });
    expect(seen).toContain('which');
  });

  it('returns TOOL_IO when the file write throws (ENOSPC/EACCES)', async () => {
    const store = await openSecretStore({
      platform: 'win32',
      runner: okRun,
      fileDeps: {
        path: '/x',
        readFile: () => null,
        writeFile: () => {
          throw new Error('ENOSPC');
        },
      },
    });
    const set = await store.set(REF, 'k');
    expect(set.ok).toBe(false);
    if (set.ok) return;
    expect(set.error.code).toBe('TOOL_IO');
  });
});

describe('libsecret backend over an injected runner', () => {
  it('treats a clean miss (non-zero, empty stderr) as no key', async () => {
    // `which` must succeed so the libsecret backend (not the file fallback) is selected.
    const run: Runner = async (file) =>
      file === 'which'
        ? { code: 0, stdout: '/usr/bin/secret-tool', stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
    const store = await openSecretStore({ platform: 'linux', runner: run });
    expect(store.backend).toBe('libsecret');
    expect(await store.get(REF)).toEqual({ ok: true, value: null });
  });

  it('surfaces a runtime failure (non-zero, non-empty stderr) as TOOL_IO', async () => {
    const run: Runner = async (file) =>
      file === 'which'
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 1, stdout: '', stderr: 'Cannot create an item in a locked collection' };
    const store = await openSecretStore({ platform: 'linux', runner: run });
    const got = await store.get(REF);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error.code).toBe('TOOL_IO');
  });
});

describe('file backend round-trip', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rizz-secrets-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores, reads, and deletes a secret at 0600', async () => {
    const path = join(dir, 'secrets.json');
    const store = await openSecretStore({
      platform: 'win32',
      runner: okRun,
      fileDeps: realFileDeps(path),
    });

    expect(await store.get(REF)).toEqual({ ok: true, value: null });
    expect((await store.set(REF, 'k-123')).ok).toBe(true);
    expect(await store.get(REF)).toEqual({ ok: true, value: 'k-123' });
    // POSIX-only: Windows NTFS reports 0o666 (no POSIX bits) — the file is protected by the profile ACL.
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect((await store.delete(REF)).ok).toBe(true);
    expect(await store.get(REF)).toEqual({ ok: true, value: null });
  });
});
