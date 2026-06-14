// Secret storage service (the "how" of keeping a BYOK key off the repo/logs — brief §3.6). A small,
// dependency-free wrapper over the OS keychain where one exists (macOS Keychain via `security`,
// libsecret via `secret-tool`), with a restricted-permission file fallback everywhere else. Returns
// structured Result; never logs a secret; never throws for expected failures (ADR-001).
//
// The actual process spawn and file I/O are injected (`runner` / the fs binding) so the command
// construction and the fallback store are unit-testable without touching a real keychain.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { type Result, RizzError, err, ok } from '../result.js';

/** Identifies one secret. `service` groups rizz's entries; `account` is the provider id. */
export interface SecretRef {
  readonly service: string;
  readonly account: string;
}

/** rizz's keychain service name + the well-known account for the Anthropic BYOK key. */
export const RIZZ_SERVICE = 'rizz';
export const ANTHROPIC_ACCOUNT = 'anthropic';

/** macOS `security` exit code for errSecItemNotFound — the only "no key" (vs locked/denied) signal. */
const SEC_ITEM_NOT_FOUND = 44;

export type SecretBackend = 'macos-keychain' | 'libsecret' | 'file';

export interface SecretStore {
  /** Which backend is in use — surfaced once so a file fallback is visible, never silent (§3.6). */
  readonly backend: SecretBackend;
  /** The secret, or `null` when no entry exists. Never logs the value. */
  get(ref: SecretRef): Promise<Result<string | null>>;
  set(ref: SecretRef, secret: string): Promise<Result<void>>;
  delete(ref: SecretRef): Promise<Result<void>>;
}

/** Result of one spawned helper command. */
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawns a helper (e.g. `security`, `secret-tool`). Injected so backends are testable. */
export type Runner = (file: string, args: readonly string[], input?: string) => Promise<RunResult>;

// --- Command builders (pure: ref → argv). Kept separate from exec so they can be asserted directly. ---

/** macOS `security` argv for get/set/delete of a generic password. */
export const macosArgs = {
  get(ref: SecretRef): readonly string[] {
    return ['find-generic-password', '-s', ref.service, '-a', ref.account, '-w'];
  },
  // The secret is fed over stdin (the trailing `-w` takes no value), so it never appears in argv /
  // `ps` output. `-U` updates an existing item instead of erroring on a duplicate.
  set(ref: SecretRef): readonly string[] {
    return ['add-generic-password', '-U', '-s', ref.service, '-a', ref.account, '-w'];
  },
  delete(ref: SecretRef): readonly string[] {
    return ['delete-generic-password', '-s', ref.service, '-a', ref.account];
  },
};

/** libsecret `secret-tool` argv. `store` reads the secret from stdin (no argv exposure). */
export const libsecretArgs = {
  lookup(ref: SecretRef): readonly string[] {
    return ['lookup', 'service', ref.service, 'account', ref.account];
  },
  store(ref: SecretRef): readonly string[] {
    return [
      'store',
      '--label',
      `${ref.service}:${ref.account}`,
      'service',
      ref.service,
      'account',
      ref.account,
    ];
  },
  clear(ref: SecretRef): readonly string[] {
    return ['clear', 'service', ref.service, 'account', ref.account];
  },
};

// --- Backends ---

function macosBackend(run: Runner): SecretStore {
  return {
    backend: 'macos-keychain',
    async get(ref) {
      const r = await run('security', macosArgs.get(ref));
      if (r.code === 0) return ok(r.stdout.replace(/\n$/, ''));
      // Only exit 44 (errSecItemNotFound) means "no key". Other codes — 36 (keychain locked / auth
      // required), denial, corruption — must surface, or a stored key silently drops to demo mode.
      if (r.code === SEC_ITEM_NOT_FOUND) return ok(null);
      return err(new RizzError('TOOL_IO', `keychain read failed (security exit ${r.code})`));
    },
    async set(ref, secret) {
      const r = await run('security', macosArgs.set(ref), secret);
      if (r.code !== 0)
        return err(new RizzError('TOOL_IO', `keychain write failed (security exit ${r.code})`));
      return ok(undefined);
    },
    async delete(ref) {
      // A missing item is fine for delete — treat any exit as success-or-absent.
      await run('security', macosArgs.delete(ref));
      return ok(undefined);
    },
  };
}

function libsecretBackend(run: Runner): SecretStore {
  return {
    backend: 'libsecret',
    async get(ref) {
      const r = await run('secret-tool', libsecretArgs.lookup(ref));
      if (r.code !== 0) {
        // secret-tool exits 1 for both "not found" and runtime errors (daemon down, keyring locked,
        // dbus error). Non-empty stderr reliably marks a real failure vs. a clean absence — surface
        // it so a stored key never silently drops to demo (mirrors the macOS exit-44 distinction).
        if (r.stderr.trim() !== '') {
          return err(
            new RizzError('TOOL_IO', `libsecret read failed (secret-tool exit ${r.code})`),
          );
        }
        return ok(null);
      }
      const value = r.stdout.replace(/\n$/, '');
      return ok(value === '' ? null : value);
    },
    async set(ref, secret) {
      const r = await run('secret-tool', libsecretArgs.store(ref), secret);
      if (r.code !== 0)
        return err(new RizzError('TOOL_IO', `keychain write failed (secret-tool exit ${r.code})`));
      return ok(undefined);
    },
    async delete(ref) {
      await run('secret-tool', libsecretArgs.clear(ref));
      return ok(undefined);
    },
  };
}

// Per-user JSON store at 0600 — the fallback when no OS keychain helper is present. On Windows the
// 0o600 chmod is a near-no-op (NTFS has no POSIX bits), but the file lives under the user-profile
// directory whose ACL is already user-restricted; a DPAPI-backed Windows backend is a future upgrade.
export interface FileBackendDeps {
  readonly path: string;
  readonly readFile: (path: string) => string | null;
  readonly writeFile: (path: string, content: string) => void;
}

const refKey = (ref: SecretRef): string => `${ref.service}:${ref.account}`;

function fileBackend(deps: FileBackendDeps): SecretStore {
  const load = (): Record<string, string> => {
    const raw = deps.readFile(deps.path);
    if (raw === null) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      // A corrupt store is treated as empty rather than throwing — the caller can re-`/login`.
      return {};
    }
  };
  // A disk write can fail (ENOSPC/EACCES/EROFS) — return a structured error, never throw (ADR-001).
  const writeData = (data: Record<string, string>): Result<void> => {
    try {
      deps.writeFile(deps.path, JSON.stringify(data));
      return ok(undefined);
    } catch (cause) {
      return err(new RizzError('TOOL_IO', 'could not write the secret store', { cause }));
    }
  };
  return {
    backend: 'file',
    async get(ref) {
      const value = load()[refKey(ref)];
      return ok(value ?? null);
    },
    async set(ref, secret) {
      const data = load();
      data[refKey(ref)] = secret;
      return writeData(data);
    },
    async delete(ref) {
      const data = load();
      delete data[refKey(ref)];
      return writeData(data);
    },
  };
}

// --- Default wiring ---

function defaultRunner(): Runner {
  return async (file, args, input) => {
    const { execFile } = await import('node:child_process');
    return new Promise<RunResult>((resolve) => {
      // execFile (not a shell) → the secret in argv is never parsed by a shell and can't be injected.
      const child = execFile(file, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
      if (input !== undefined) {
        child.stdin?.end(input);
      }
    });
  };
}

/** Default file-store deps: a 0600 file under ~/.rizz. Directory + file perms are tightened on write. */
function defaultFileDeps(): FileBackendDeps {
  const path = join(homedir(), '.rizz', 'secrets.json');
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
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, content, { mode: 0o600 });
      // Re-assert perms in case the file pre-existed with looser bits.
      chmodSync(p, 0o600);
    },
  };
}

/** True when a helper command resolves on PATH — probed once at store-open against the resolved platform. */
async function commandExists(run: Runner, plat: NodeJS.Platform, file: string): Promise<boolean> {
  const probe = plat === 'win32' ? 'where' : 'which';
  const r = await run(probe, [file]);
  return r.code === 0;
}

export interface OpenSecretStoreOptions {
  /** Override the detected platform (tests). */
  readonly platform?: NodeJS.Platform;
  /** Override the helper runner (tests). */
  readonly runner?: Runner;
  /** Override the file fallback deps (tests). */
  readonly fileDeps?: FileBackendDeps;
}

/**
 * Open the best available secret store for this OS: macOS Keychain, then libsecret, then a 0600 file.
 * Selection is async only because the libsecret probe spawns `which`; it does no other I/O.
 */
export async function openSecretStore(options: OpenSecretStoreOptions = {}): Promise<SecretStore> {
  const plat = options.platform ?? osPlatform();
  const run = options.runner ?? defaultRunner();

  if (plat === 'darwin') return macosBackend(run);
  if (plat === 'linux' && (await commandExists(run, plat, 'secret-tool')))
    return libsecretBackend(run);
  return fileBackend(options.fileDeps ?? defaultFileDeps());
}
