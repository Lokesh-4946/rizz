import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { explainProjectTarget, generateProjectBrain, reviewProjectChanges } from './index.js';

vi.setConfig({ testTimeout: 30_000 });

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
      await mkdir(join(dir, 'database', 'migrations'), { recursive: true });
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
          '  school: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true },',
          '});',
          'module.exports = mongoose.model("Book", BookSchema);',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'database', 'dbms.sql'),
        'CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, title TEXT);\n',
      );
      await writeFile(
        join(dir, 'database', 'models.py'),
        [
          'from flask_sqlalchemy import SQLAlchemy',
          'db = SQLAlchemy()',
          'class User(db.Model):',
          '    __tablename__ = "users"',
          '    id = db.Column(db.Integer, primary_key=True)',
          '    wallet = db.Column(db.Integer, default=0)',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'database', 'migrations', '001_wallet.py'),
        [
          'from alembic import op',
          'import sqlalchemy as sa',
          'def upgrade():',
          '    op.create_table("wallets", sa.Column("id", sa.Integer()), sa.Column("amount", sa.Integer()))',
        ].join('\n'),
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
              fields: expect.arrayContaining(['title', 'writer', 'school']),
            }),
          }),
          expect.objectContaining({
            name: 'books',
            type: 'database/table',
            source_files: ['database/dbms.sql'],
            data: expect.objectContaining({ kind: 'sql_table' }),
          }),
          expect.objectContaining({
            name: 'users',
            type: 'database/table',
            source_files: ['database/models.py'],
            data: expect.objectContaining({
              kind: 'sqlalchemy_model',
              fields: expect.arrayContaining(['id', 'wallet']),
            }),
          }),
          expect.objectContaining({
            name: 'wallets',
            type: 'database/table',
            source_files: ['database/migrations/001_wallet.py'],
            data: expect.objectContaining({
              kind: 'alembic_table',
              fields: expect.arrayContaining(['id', 'amount']),
            }),
          }),
        ]),
      );
      const book = databaseTables.entities.find((entity) => entity.name === 'Book');
      expect(JSON.stringify(book?.data)).not.toContain('"type"');
      expect(JSON.stringify(book?.data)).not.toContain('"required"');
      expect(JSON.stringify(book?.data)).not.toContain('"ref"');
    });
  });

  it('keeps controller review blast radius route-local and filters unusable test scripts', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'backend', 'routes'), { recursive: true });
      await mkdir(join(dir, 'backend', 'controllers'), { recursive: true });
      await mkdir(join(dir, 'backend', 'models'), { recursive: true });
      await mkdir(join(dir, 'frontend'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'controller-review-app', workspaces: ['backend', 'frontend'] }),
      );
      await writeFile(
        join(dir, 'backend', 'package.json'),
        JSON.stringify({
          name: 'controller-review-backend',
          scripts: { test: 'echo "Error: no test specified" && exit 1' },
          dependencies: { express: '^5.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'frontend', 'package.json'),
        JSON.stringify({
          name: 'controller-review-frontend',
          scripts: { test: 'react-scripts test' },
          dependencies: { react: '^19.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'backend', 'routes', 'route.js'),
        [
          'const express = require("express");',
          'const router = express.Router();',
          'const { membersController } = require("../controllers/membersController");',
          'router.get("/orders", (_req, res) => res.json({ route: "orders" }));',
          'router.get("/members", membersController);',
          'module.exports = router;',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'backend', 'models', 'memberSchema.js'),
        [
          'const mongoose = require("mongoose");',
          'const MemberSchema = new mongoose.Schema({',
          '  name: String,',
          '});',
          'module.exports = mongoose.model("Member", MemberSchema);',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'backend', 'controllers', 'membersController.js'),
        [
          'const Member = require("../models/memberSchema");',
          'exports.membersController = async (_req, res) => {',
          '  const members = await Member.findOne({ active: true });',
          '  res.json(members);',
          '};',
        ].join('\n'),
      );
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:23:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'backend', 'controllers', 'membersController.js'),
        [
          'const Member = require("../models/memberSchema");',
          'exports.membersController = async (_req, res) => {',
          '  const members = await Member.findOne({ active: true, verified: true });',
          '  res.json(members);',
          '};',
        ].join('\n'),
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
      expect(review.value.review.required_tests.join('\n')).not.toContain('react-scripts');
      expect(review.value.review.required_tests).toContain(
        'Run the project test command; none was detected in the brain.',
      );
      expect(review.value.review.affected_services.map((service) => service.id)).toEqual(
        expect.arrayContaining(['service:backend--controllers']),
      );
      expect(review.value.review.review_evidence_summary.affected_data_dependencies).toEqual(
        expect.arrayContaining(['orm/database']),
      );
      expect(review.value.review.review_evidence_summary.affected_state_operations).toEqual(
        expect.arrayContaining(['read']),
      );
    });
  });

  it('writes explain reports per target so parallel explains do not collide', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'parallel-explain' }));
      await writeFile(join(dir, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
      await writeFile(join(dir, 'src', 'beta.ts'), 'export const beta = 2;\n');
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:25:00.000Z'),
      });

      const [alpha, beta] = await Promise.all([
        explainProjectTarget({
          rootDir: dir,
          target: 'src/alpha.ts',
          now: new Date('2026-06-28T10:26:00.000Z'),
        }),
        explainProjectTarget({
          rootDir: dir,
          target: 'src/beta.ts',
          now: new Date('2026-06-28T10:26:00.000Z'),
        }),
      ]);

      expect(alpha.ok).toBe(true);
      expect(beta.ok).toBe(true);
      if (!alpha.ok || !beta.ok) return;
      expect(alpha.value.reportPath).not.toBe(beta.value.reportPath);
      expect(await readFile(alpha.value.reportPath, 'utf8')).toContain('src/alpha.ts');
      expect(await readFile(beta.value.reportPath, 'utf8')).toContain('src/beta.ts');
    });
  });
});
