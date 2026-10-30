import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { packTestRelease, publishTestPackage } from './pack-test-release.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'npm_test_token_do_not_leak_610c';
const roots = [];

function tempDir(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function isOutside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return false;
  if (isAbsolute(rel)) return true;
  return rel === '..' || rel.startsWith(`..${sep}`);
}

function sink(chunks) {
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
}

function refusingSpawn() {
  return () => {
    throw new Error('npm should not be called');
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('pack test release', () => {
  it('refuses publish without --confirm-publish', async () => {
    const stderr = [];
    await expect(
      packTestRelease(['--publish', '--build', '2'], {
        env: { ...process.env, NPM_TOKEN: TOKEN },
        stderr: sink(stderr),
        spawn: refusingSpawn(),
      }),
    ).rejects.toThrow(/--confirm-publish @valoir\/rizz-test@0\.4\.0-test\.2/);
    expect(stderr.join('')).not.toContain(TOKEN);
  });

  it('refuses a package name other than @valoir/rizz-test', async () => {
    await expect(
      packTestRelease(
        ['--publish', '--build', '2', '--confirm-publish', '@valoir/rizz@0.4.0-test.2'],
        {
          env: { ...process.env, NPM_TOKEN: TOKEN },
          spawn: refusingSpawn(),
        },
      ),
    ).rejects.toThrow(/refusing to publish @valoir\/rizz/);
  });

  it('refuses a confirm version that does not match the build', async () => {
    await expect(
      packTestRelease(
        ['--publish', '--build', '2', '--confirm-publish', '@valoir/rizz-test@0.4.0'],
        {
          env: { ...process.env, NPM_TOKEN: TOKEN },
          spawn: refusingSpawn(),
        },
      ),
    ).rejects.toThrow(/@valoir\/rizz-test@0\.4\.0-test\.2/);
  });

  it('refuses --tag latest', async () => {
    await expect(
      packTestRelease(
        [
          '--publish',
          '--build',
          '2',
          '--tag',
          'latest',
          '--confirm-publish',
          '@valoir/rizz-test@0.4.0-test.2',
        ],
        {
          env: { ...process.env, NPM_TOKEN: TOKEN },
          spawn: refusingSpawn(),
        },
      ),
    ).rejects.toThrow(/--tag latest/);
  });

  it('deletes the npmrc when publish fails', async () => {
    const tempParent = tempDir('rizz-npmrc-parent-');
    const stdout = [];
    const stderr = [];
    let npmrcPath = '';
    await expect(
      publishTestPackage({
        tarball: join(tempParent, 'missing.tgz'),
        build: 2,
        confirm: '@valoir/rizz-test@0.4.0-test.2',
        tag: '',
        token: TOKEN,
        repoRoot,
        outDir: join(repoRoot, 'dist-pack'),
        tempParent,
        stdout: sink(stdout),
        stderr: sink(stderr),
        spawn(_command, args, spawnOptions) {
          expect(args).toContain('--access');
          expect(args).toContain('public');
          expect(args).toContain('--tag');
          expect(args).toContain('test');
          expect(args).not.toContain('latest');
          expect(spawnOptions.env.NPM_TOKEN).toBeUndefined();
          const configFlag = args.indexOf('--userconfig');
          const config = args[configFlag + 1];
          npmrcPath = config;
          expect(existsSync(config)).toBe(true);
          expect(readFileSync(config, 'utf8')).toBe(`//registry.npmjs.org/:_authToken=${TOKEN}\n`);
          if (process.platform !== 'win32') {
            expect(statSync(config).mode & 0o777).toBe(0o600);
          }
          expect(isOutside(repoRoot, config)).toBe(true);
          expect(isOutside(join(repoRoot, 'dist-pack'), config)).toBe(true);
          return { status: 1, stdout: '', stderr: 'publish failed\n' };
        },
      }),
    ).rejects.toThrow(/npm publish failed/);
    expect(npmrcPath).not.toBe('');
    expect(existsSync(npmrcPath)).toBe(false);
    expect(readdirSync(tempParent)).toEqual([]);
    expect(stdout.join('')).not.toContain(TOKEN);
    expect(stderr.join('')).not.toContain(TOKEN);
  });

  it('deletes the npmrc when publish is interrupted', async () => {
    const tempParent = tempDir('rizz-npmrc-signal-');
    const stdout = [];
    const stderr = [];
    const handlers = new Map();
    let npmrcPath = '';
    await expect(
      publishTestPackage({
        tarball: join(tempParent, 'missing.tgz'),
        build: 2,
        confirm: '@valoir/rizz-test@0.4.0-test.2',
        tag: 'test',
        token: TOKEN,
        repoRoot,
        outDir: join(repoRoot, 'dist-pack'),
        tempParent,
        stdout: sink(stdout),
        stderr: sink(stderr),
        listen(signal, handler) {
          handlers.set(signal, handler);
        },
        unlisten() {},
        exit(code) {
          throw new Error(`exit ${code}`);
        },
        spawn(_command, args) {
          const config = args[args.indexOf('--userconfig') + 1];
          npmrcPath = config;
          expect(existsSync(config)).toBe(true);
          expect(readFileSync(config, 'utf8')).toContain(TOKEN);
          const onSigint = handlers.get('SIGINT');
          const onSigterm = handlers.get('SIGTERM');
          expect(typeof onSigint).toBe('function');
          expect(typeof onSigterm).toBe('function');
          onSigterm();
          return { status: 0, stdout: TOKEN, stderr: TOKEN };
        },
      }),
    ).rejects.toThrow(/exit 143/);
    expect(existsSync(npmrcPath)).toBe(false);
    expect(readdirSync(tempParent)).toEqual([]);
    expect(stdout.join('')).not.toContain(TOKEN);
    expect(stderr.join('')).not.toContain(TOKEN);
  });

  it('prints the packed package version from the test tarball', async () => {
    const cli = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
    expect(existsSync(cli)).toBe(true);
    const out = tempDir('rizz-pack-out-');
    const stdout = [];
    const packed = await packTestRelease(['--build', '4', '--out', out], {
      stdout: sink(stdout),
      spawn(command, args, options) {
        if (command === 'pnpm') return { status: 0, stdout: '', stderr: '' };
        return spawnSync(command, args, options);
      },
    });
    expect(packed.version).toBe('0.4.0-test.4');
    expect(packed.packageName).toBe('@valoir/rizz-test');
    expect(stdout.join('')).toContain(packed.tarball);
    const extract = tempDir('rizz-pack-extract-');
    const extracted = spawnSync('tar', ['-xzf', packed.tarball, '-C', extract], {
      encoding: 'utf8',
    });
    expect(extracted.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(extract, 'package', 'package.json'), 'utf8'));
    expect(manifest.name).toBe('@valoir/rizz-test');
    expect(manifest.version).toBe('0.4.0-test.4');
    const ran = spawnSync(
      process.execPath,
      [join(extract, 'package', 'bin', 'rizz.js'), '--version'],
      { encoding: 'utf8' },
    );
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe(manifest.version);
    expect(ran.stdout.trim()).not.toBe('0.4.0');
  }, 120_000);
});
