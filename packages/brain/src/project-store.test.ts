import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeGitRemote,
  prepareProjectStore,
  relinkProjectStore,
  resolveRizzHome,
} from './project-store.js';

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('project store', () => {
  it('resolves the platform data directory without using the repository', () => {
    expect(resolveRizzHome({ platform: 'darwin', homeDir: '/Users/tester', env: {} })).toBe(
      '/Users/tester/Library/Application Support/rizz',
    );
    expect(
      resolveRizzHome({
        platform: 'linux',
        homeDir: '/home/tester',
        env: { XDG_DATA_HOME: '/data/tester' },
      }),
    ).toBe('/data/tester/rizz');
    expect(
      resolveRizzHome({
        platform: 'win32',
        homeDir: 'C:\\Users\\tester',
        env: { LOCALAPPDATA: 'D:\\Local' },
      }),
    ).toBe('D:\\Local\\rizz');
  });

  it('normalizes common Git remote forms to one repository identity', () => {
    expect(normalizeGitRemote('git@github.com:Valoir/Rizz.git')).toBe('github.com/valoir/rizz');
    expect(normalizeGitRemote('https://github.com/valoir/rizz.git')).toBe('github.com/valoir/rizz');
  });

  it('creates isolated project storage and a verified registry outside the repository', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'rizz-project-store-'));
    cleanup.push(sandbox);
    const rootDir = join(sandbox, 'repo');
    const rizzHome = join(sandbox, 'rizz-home');
    await mkdir(join(rootDir, '.git'), { recursive: true });
    await writeFile(join(rootDir, 'README.md'), '# Example\n', 'utf8');

    const first = await prepareProjectStore({ rootDir, rizzHome, remote: null });
    const second = await prepareProjectStore({ rootDir, rizzHome, remote: null });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.projectId).toBe(first.value.projectId);
    expect(first.value.projectDir.startsWith(rizzHome)).toBe(true);
    expect(first.value.projectDir.startsWith(await realpath(rootDir))).toBe(false);
    expect(first.value.brainDir).toBe(join(first.value.projectDir, 'brain'));
    expect(JSON.parse(await readFile(join(rizzHome, 'registry.json'), 'utf8'))).toMatchObject({
      schema_version: 1,
      projects: {
        [first.value.projectId]: {
          root_path: await realpath(rootDir),
        },
      },
    });
    await expect(
      readFile(join(rootDir, '.rizz', 'brain', 'latest.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('keeps separate clones of the same remote isolated', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'rizz-project-store-clones-'));
    cleanup.push(sandbox);
    const rizzHome = join(sandbox, 'rizz-home');
    const firstRoot = join(sandbox, 'first');
    const secondRoot = join(sandbox, 'second');
    await mkdir(firstRoot);
    await mkdir(secondRoot);

    const first = await prepareProjectStore({
      rootDir: firstRoot,
      rizzHome,
      remote: 'git@github.com:valoir/example.git',
    });
    const second = await prepareProjectStore({
      rootDir: secondRoot,
      rizzHome,
      remote: 'https://github.com/valoir/example.git',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.remoteIdentity).toBe(second.value.remoteIdentity);
    expect(first.value.projectId).not.toBe(second.value.projectId);
    expect(first.value.projectDir).not.toBe(second.value.projectDir);
  });

  it('requires an explicit relink when a registered repository path moved', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'rizz-project-store-move-'));
    cleanup.push(sandbox);
    const rizzHome = join(sandbox, 'rizz-home');
    const firstRoot = join(sandbox, 'before');
    const movedRoot = join(sandbox, 'after');
    const remote = 'git@github.com:valoir/moved-project.git';
    await mkdir(firstRoot);
    const first = await prepareProjectStore({ rootDir: firstRoot, rizzHome, remote });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await rename(firstRoot, movedRoot);

    const blocked = await prepareProjectStore({ rootDir: movedRoot, rizzHome, remote });

    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_RELINK_REQUIRED' },
    });
    expect(
      Object.keys(JSON.parse(await readFile(join(rizzHome, 'registry.json'), 'utf8')).projects),
    ).toHaveLength(1);

    const relinked = await relinkProjectStore({ rootDir: movedRoot, rizzHome, remote });
    expect(relinked.ok).toBe(true);
    if (!relinked.ok) return;
    expect(relinked.value.projectId).toBe(first.value.projectId);
    expect(relinked.value.rootPath).toBe(await realpath(movedRoot));

    const prepared = await prepareProjectStore({ rootDir: movedRoot, rizzHome, remote });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.projectId).toBe(first.value.projectId);
  });

  it('relinks a moved repository without a remote by its root commit fingerprint', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'rizz-project-store-local-move-'));
    cleanup.push(sandbox);
    const rizzHome = join(sandbox, 'rizz-home');
    const firstRoot = join(sandbox, 'before');
    const movedRoot = join(sandbox, 'after');
    await mkdir(firstRoot);
    spawnSync('git', ['init', '-q'], { cwd: firstRoot });
    spawnSync('git', ['config', 'user.email', 'rizz@example.com'], { cwd: firstRoot });
    spawnSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: firstRoot });
    await writeFile(join(firstRoot, 'README.md'), '# Local\n', 'utf8');
    spawnSync('git', ['add', 'README.md'], { cwd: firstRoot });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: firstRoot });
    const first = await prepareProjectStore({ rootDir: firstRoot, rizzHome, remote: null });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await rename(firstRoot, movedRoot);

    await expect(
      prepareProjectStore({ rootDir: movedRoot, rizzHome, remote: null }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'PROJECT_RELINK_REQUIRED' },
    });
    const relinked = await relinkProjectStore({ rootDir: movedRoot, rizzHome, remote: null });
    expect(relinked.ok).toBe(true);
    if (!relinked.ok) return;
    expect(relinked.value.projectId).toBe(first.value.projectId);
    expect(relinked.value.repositoryFingerprint).toBe(first.value.repositoryFingerprint);
  });

  it('uses an explicit project id to relink a legacy registry entry without a fingerprint', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'rizz-project-store-legacy-move-'));
    cleanup.push(sandbox);
    const rizzHome = join(sandbox, 'rizz-home');
    const firstRoot = join(sandbox, 'before');
    const movedRoot = join(sandbox, 'after');
    await mkdir(firstRoot);
    const first = await prepareProjectStore({ rootDir: firstRoot, rizzHome, remote: null });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const registryPath = join(rizzHome, 'registry.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    Reflect.deleteProperty(registry.projects[first.value.projectId], 'repository_fingerprint');
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await rename(firstRoot, movedRoot);

    const relinked = await relinkProjectStore({
      rootDir: movedRoot,
      rizzHome,
      remote: null,
      projectId: first.value.projectId,
    });

    expect(relinked.ok).toBe(true);
    if (!relinked.ok) return;
    expect(relinked.value.projectId).toBe(first.value.projectId);
  });

  it('preserves every project when prepares update one registry concurrently', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'rizz-project-store-concurrent-'));
    cleanup.push(sandbox);
    const rizzHome = join(sandbox, 'rizz-home');
    const roots = [join(sandbox, 'one'), join(sandbox, 'two')];
    await Promise.all(roots.map((root) => mkdir(root)));

    const results = await Promise.all(
      roots.map((rootDir) => prepareProjectStore({ rootDir, rizzHome, remote: null })),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const registry = JSON.parse(await readFile(join(rizzHome, 'registry.json'), 'utf8'));
    expect(Object.keys(registry.projects)).toHaveLength(2);
  });

  it('refuses to overwrite a malformed registry', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'rizz-project-store-malformed-'));
    cleanup.push(sandbox);
    const rootDir = join(sandbox, 'repo');
    const rizzHome = join(sandbox, 'rizz-home');
    await mkdir(rootDir);
    await mkdir(rizzHome);
    await writeFile(join(rizzHome, 'registry.json'), '{not-json}\n', 'utf8');

    const result = await prepareProjectStore({ rootDir, rizzHome, remote: null });

    expect(result.ok).toBe(false);
    expect(await readFile(join(rizzHome, 'registry.json'), 'utf8')).toBe('{not-json}\n');
  });
});
