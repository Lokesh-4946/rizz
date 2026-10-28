import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareRepository } from './prepare.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('prepares external intelligence without changing repository files or git status', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'rizz-prepare-'));
  cleanup.push(sandbox);
  const rootDir = join(sandbox, 'repo');
  const rizzHome = join(sandbox, 'rizz-home');
  await mkdir(rootDir);
  spawnSync('git', ['init', '-q'], { cwd: rootDir });
  spawnSync('git', ['config', 'user.email', 'rizz@example.com'], { cwd: rootDir });
  spawnSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: rootDir });
  await writeFile(join(rootDir, 'package.json'), '{"name":"clean-project"}\n', 'utf8');
  spawnSync('git', ['add', 'package.json'], { cwd: rootDir });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: rootDir });
  const filesBefore = await readdir(rootDir);
  const statusBefore = spawnSync('git', ['status', '--porcelain'], {
    cwd: rootDir,
    encoding: 'utf8',
  }).stdout;

  const result = await prepareRepository({ rootDir, rizzHome });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.project.projectDir.startsWith(rizzHome)).toBe(true);
  expect(await readdir(rootDir)).toEqual(filesBefore);
  expect(
    spawnSync('git', ['status', '--porcelain'], { cwd: rootDir, encoding: 'utf8' }).stdout,
  ).toBe(statusBefore);
});
