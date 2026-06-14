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
    expect(macosArgs.set(REF, 'k')).toEqual([
      'add-generic-password',
      '-U',
      '-s',
      'rizz',
      '-a',
      'anthropic',
      '-w',
      'k',
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
  it('returns null when the item is absent (non-zero exit)', async () => {
    const run: Runner = async () => ({ code: 44, stdout: '', stderr: 'not found' });
    const store = await openSecretStore({ platform: 'darwin', runner: run });
    expect(await store.get(REF)).toEqual({ ok: true, value: null });
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
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await store.delete(REF)).ok).toBe(true);
    expect(await store.get(REF)).toEqual({ ok: true, value: null });
  });
});
