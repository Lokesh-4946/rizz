import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateProjectBrain, reviewProjectChanges } from './index.js';

async function withTempProject<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'rizz-dbms-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function git(dir: string, args: readonly string[]): Promise<void> {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
}

async function initGitProject(dir: string): Promise<void> {
  await git(dir, ['init', '-b', 'develop']);
  await git(dir, ['config', 'user.email', 'rizz@example.com']);
  await git(dir, ['config', 'user.name', 'rizz test']);
}

describe('DBMS usefulness hardening', () => {
  it('detects nested package managers and SQL plus Mongoose database entities', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'backend', 'models'), { recursive: true });
      await mkdir(join(dir, 'frontend'), { recursive: true });
      await mkdir(join(dir, 'database'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'dbms-app', workspaces: ['backend', 'frontend'] }),
      );
      await writeFile(
        join(dir, 'backend', 'package.json'),
        JSON.stringify({
          name: 'dbms-backend',
          dependencies: { mongoose: '^8.0.0', express: '^5.0.0' },
        }),
      );
      await writeFile(join(dir, 'backend', 'package-lock.json'), '{}\n');
      await writeFile(join(dir, 'frontend', 'package.json'), JSON.stringify({ name: 'ui' }));
      await writeFile(join(dir, 'frontend', 'package-lock.json'), '{}\n');
      await writeFile(
        join(dir, 'backend', 'models', 'Book.js'),
        [
          'const mongoose = require("mongoose");',
          'const BookSchema = new mongoose.Schema({',
          '  title: { type: String, required: true },',
          '  writer: String,',
          '});',
          'module.exports = mongoose.model("Book", BookSchema);',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'database', 'dbms.sql'),
        'CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, title TEXT);\n',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:22:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const latest = await readJson<{ project_state: { package_manager: string } }>(
        result.value.latestPath,
      );
      expect(latest.project_state.package_manager).toBe('npm (nested)');
      const databaseTables = await readJson<{
        entities: Array<{ name: string; type: string; source_files: string[]; data?: unknown }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'database_tables.json'));
      expect(databaseTables.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Book',
            type: 'database/table',
            source_files: ['backend/models/Book.js'],
            data: expect.objectContaining({
              kind: 'mongoose_model',
              fields: expect.arrayContaining(['title', 'writer']),
            }),
          }),
          expect.objectContaining({
            name: 'books',
            type: 'database/table',
            source_files: ['database/dbms.sql'],
            data: expect.objectContaining({ kind: 'sql_table' }),
          }),
        ]),
      );
    });
  });

  it('keeps controller review blast radius route-local and filters unusable test scripts', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'src', 'controllers'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'controller-review-app',
          scripts: { test: 'echo "Error: no test specified" && exit 1' },
          dependencies: { express: '^5.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'src', 'server.js'),
        [
          'const express = require("express");',
          'const app = express();',
          'app.get("/orders", (_req, res) => res.json({ route: "orders" }));',
          'app.get("/members", (_req, res) => res.json({ route: "members" }));',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'src', 'controllers', 'ordersController.js'),
        'exports.ordersController = (_req, res) => res.json([]);\n',
      );
      await writeFile(
        join(dir, 'src', 'controllers', 'membersController.js'),
        'exports.membersController = (_req, res) => res.json([]);\n',
      );
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:23:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'src', 'controllers', 'membersController.js'),
        'exports.membersController = (_req, res) => res.json([{ id: "m1" }]);\n',
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:24:00.000Z'),
      });

      expect(review.ok).toBe(true);
      if (!review.ok) return;
      const routePaths = review.value.review.affected_flows.map((flow) => flow.route_path);
      expect(routePaths).toContain('/members');
      expect(routePaths).not.toContain('/orders');
      expect(review.value.review.required_tests.join('\n')).not.toContain('no test specified');
      expect(review.value.review.required_tests).toContain(
        'Run the project test command; none was detected in the brain.',
      );
    });
  });
});
