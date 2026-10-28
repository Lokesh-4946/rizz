import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareRepository } from './prepare.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

it('prepares external intelligence without changing repository files or git status', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'rizz-prepare-'));
  cleanup.push(sandbox);
  const rootDir = join(sandbox, 'repo');
  const rizzHome = join(sandbox, 'rizz-home');
  await mkdir(rootDir);
  const git = (args: readonly string[]) =>
    spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: rootDir,
      encoding: 'utf8',
    });
  git(['init', '-q']);
  git(['config', 'user.email', 'rizz@example.com']);
  git(['config', 'user.name', 'Rizz Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.fsmonitor', 'false']);
  await writeFile(join(rootDir, 'package.json'), '{"name":"clean-project"}\n', 'utf8');
  git(['add', 'package.json']);
  git(['commit', '-qm', 'init']);
  const filesBefore = await readdir(rootDir);
  const statusBefore = git(['status', '--porcelain']).stdout;

  const result = await prepareRepository({ rootDir, rizzHome });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.project.projectDir.startsWith(rizzHome)).toBe(true);
  expect(await readdir(rootDir)).toEqual(filesBefore);
  expect(git(['status', '--porcelain']).stdout).toBe(statusBefore);
});
