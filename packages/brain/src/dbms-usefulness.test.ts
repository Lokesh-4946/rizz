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

  it('detects raw SQL foreign keys and cross-table graph relationships', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'database'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'raw-sql-schema-app' }));
      await writeFile(
        join(dir, 'database', 'schema.sql'),
        [
          'CREATE TABLE users (',
          '  id INTEGER PRIMARY KEY,',
          '  email TEXT NOT NULL',
          ');',
          'CREATE TABLE wallets (',
          '  id INTEGER PRIMARY KEY,',
          '  user_id INTEGER REFERENCES users(id),',
          '  balance_cents INTEGER NOT NULL,',
          '  FOREIGN KEY (id) REFERENCES ledgers(wallet_id)',
          ');',
          'CREATE TABLE ledgers (',
          '  wallet_id INTEGER PRIMARY KEY,',
          '  updated_at TEXT',
          ');',
          'ALTER TABLE ledgers ADD CONSTRAINT fk_ledger_user FOREIGN KEY (wallet_id) REFERENCES wallets(id);',
        ].join('\n'),
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:29:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const databaseTables = await readJson<{
        entities: Array<{
          id: string;
          name: string;
          data?: { fields?: string[]; relationships?: unknown[] };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'database_tables.json'));
      expect(databaseTables.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'database/table:database--schema.sql-wallets',
            data: expect.objectContaining({
              fields: expect.arrayContaining(['id', 'user_id', 'balance_cents']),
              relationships: expect.arrayContaining([
                expect.objectContaining({
                  kind: 'foreign_key',
                  source_field: 'user_id',
                  target_table: 'users',
                  target_field: 'id',
                }),
                expect.objectContaining({
                  kind: 'foreign_key',
                  source_field: 'id',
                  target_table: 'ledgers',
                  target_field: 'wallet_id',
                }),
              ]),
            }),
          }),
          expect.objectContaining({
            id: 'database/table:database--schema.sql-ledgers',
            data: expect.objectContaining({
              relationships: expect.arrayContaining([
                expect.objectContaining({
                  kind: 'foreign_key',
                  source_field: 'wallet_id',
                  target_table: 'wallets',
                  target_field: 'id',
                }),
              ]),
            }),
          }),
        ]),
      );
      const graph = await readJson<{
        relationships: Array<{ from: string; relation: string; to: string }>;
      }>(join(dir, '.rizz', 'brain', 'graph.json'));
      expect(graph.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: 'database/table:database--schema.sql-wallets',
            relation: 'depends_on',
            to: 'database/table:database--schema.sql-users',
          }),
          expect.objectContaining({
            from: 'database/table:database--schema.sql-ledgers',
            relation: 'depends_on',
            to: 'database/table:database--schema.sql-wallets',
          }),
        ]),
      );
    });
  });

  it('detects Alembic foreign keys and cross-table graph relationships', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'database', 'migrations'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'alembic-schema-app' }));
      await writeFile(
        join(dir, 'database', 'migrations', '001_wallets.py'),
        [
          'from alembic import op',
          'import sqlalchemy as sa',
          '',
          'def upgrade():',
          '    op.create_table(',
          '        "users",',
          '        sa.Column("id", sa.Integer(), primary_key=True),',
          '        sa.Column("email", sa.String()),',
          '    )',
          '    op.create_table(',
          '        "ledgers",',
          '        sa.Column("id", sa.Integer(), primary_key=True),',
          '        sa.Column("wallet_id", sa.Integer()),',
          '    )',
          '    op.create_table(',
          '        "wallets",',
          '        sa.Column("id", sa.Integer(), primary_key=True),',
          '        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id")),',
          '        sa.Column("ledger_id", sa.Integer()),',
          '        sa.ForeignKeyConstraint(["ledger_id"], ["ledgers.id"]),',
          '    )',
          '    op.add_column(',
          '        "wallets",',
          '        sa.Column("backup_ledger_id", sa.Integer(), sa.ForeignKey("ledgers.id")),',
          '    )',
          '    op.create_foreign_key(',
          '        "fk_ledger_wallet",',
          '        "ledgers",',
          '        "wallets",',
          '        ["wallet_id"],',
          '        ["id"],',
          '    )',
        ].join('\n'),
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:34:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const databaseTables = await readJson<{
        entities: Array<{
          id: string;
          name: string;
          data?: { fields?: string[]; relationships?: unknown[] };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'database_tables.json'));
      expect(databaseTables.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'database/table:database--migrations--001_wallets.py-wallets',
            data: expect.objectContaining({
              fields: expect.arrayContaining(['id', 'user_id', 'ledger_id', 'backup_ledger_id']),
              relationships: expect.arrayContaining([
                expect.objectContaining({
                  kind: 'foreign_key',
                  source_field: 'user_id',
                  target_table: 'users',
                  target_field: 'id',
                }),
                expect.objectContaining({
                  kind: 'foreign_key',
                  source_field: 'ledger_id',
                  target_table: 'ledgers',
                  target_field: 'id',
                }),
                expect.objectContaining({
                  kind: 'foreign_key',
                  source_field: 'backup_ledger_id',
                  target_table: 'ledgers',
                  target_field: 'id',
                }),
              ]),
            }),
          }),
          expect.objectContaining({
            id: 'database/table:database--migrations--001_wallets.py-ledgers',
            data: expect.objectContaining({
              relationships: expect.arrayContaining([
                expect.objectContaining({
                  kind: 'foreign_key',
                  source_field: 'wallet_id',
                  target_table: 'wallets',
                  target_field: 'id',
                }),
              ]),
            }),
          }),
        ]),
      );
      const graph = await readJson<{
        relationships: Array<{ from: string; relation: string; to: string }>;
      }>(join(dir, '.rizz', 'brain', 'graph.json'));
      expect(graph.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: 'database/table:database--migrations--001_wallets.py-wallets',
            relation: 'depends_on',
            to: 'database/table:database--migrations--001_wallets.py-users',
          }),
          expect.objectContaining({
            from: 'database/table:database--migrations--001_wallets.py-ledgers',
            relation: 'depends_on',
            to: 'database/table:database--migrations--001_wallets.py-wallets',
          }),
        ]),
      );
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

  it('links Flask routes through service modules to SQLAlchemy models in review', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'app', 'routes'), { recursive: true });
      await mkdir(join(dir, 'app', 'services'), { recursive: true });
      await mkdir(join(dir, 'app', 'models'), { recursive: true });
      await writeFile(
        join(dir, 'requirements.txt'),
        ['Flask==3.0.0', 'Flask-SQLAlchemy==3.1.1', 'pytest==8.0.0'].join('\n'),
      );
      await writeFile(
        join(dir, 'app', '__init__.py'),
        [
          'from flask import Flask',
          'from app.routes.wallet_routes import wallet_bp',
          'def create_app():',
          '    app = Flask(__name__)',
          '    app.register_blueprint(wallet_bp)',
          '    return app',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'app', 'routes', 'wallet_routes.py'),
        [
          'from flask import Blueprint, jsonify',
          'from app.services.wallet_service import get_wallet',
          'wallet_bp = Blueprint("wallets", __name__)',
          '@wallet_bp.get("/wallets/<int:wallet_id>")',
          'def wallet_detail(wallet_id):',
          '    return jsonify(get_wallet(wallet_id))',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'app', 'services', 'wallet_service.py'),
        [
          'from app.models.wallet import Wallet',
          'def get_wallet(wallet_id):',
          '    return Wallet.query.filter_by(id=wallet_id).first()',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'app', 'models', 'wallet.py'),
        [
          'from flask_sqlalchemy import SQLAlchemy',
          'db = SQLAlchemy()',
          'class Wallet(db.Model):',
          '    __tablename__ = "wallets"',
          '    id = db.Column(db.Integer, primary_key=True)',
          '    balance = db.Column(db.Integer, default=0)',
        ].join('\n'),
      );

      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:25:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'app', 'models', 'wallet.py'),
        [
          'from flask_sqlalchemy import SQLAlchemy',
          'db = SQLAlchemy()',
          'class Wallet(db.Model):',
          '    __tablename__ = "wallets"',
          '    id = db.Column(db.Integer, primary_key=True)',
          '    balance_cents = db.Column(db.Integer, default=0)',
        ].join('\n'),
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:26:00.000Z'),
      });

      expect(review.ok).toBe(true);
      if (!review.ok) return;
      const routePaths = review.value.review.affected_flows.map((flow) => flow.route_path);
      expect(routePaths).toContain('/wallets/<int:wallet_id>');
      const walletFlow = review.value.review.affected_flows.find(
        (flow) => flow.route_path === '/wallets/<int:wallet_id>',
      );
      expect(walletFlow?.framework).toBe('flask');
      expect(walletFlow?.changed_files).toContain('app/models/wallet.py');
      expect(walletFlow?.service_causality.map((item) => item.service_id)).toEqual(
        expect.arrayContaining(['service:app--services', 'service:app--models']),
      );
      expect(review.value.review.affected_services.map((service) => service.id)).toEqual(
        expect.arrayContaining(['service:app--services', 'service:app--models']),
      );
      expect(review.value.review.review_evidence_summary.affected_data_dependencies).toEqual(
        expect.arrayContaining(['orm/database', 'database/table:app--models--wallet.py-wallets']),
      );
      expect(review.value.review.review_evidence_summary.affected_state_operations).toEqual(
        expect.arrayContaining(['schema']),
      );
    });
  });

  it('links SQLAlchemy relationships to cross-table route blast radius', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'app', 'routes'), { recursive: true });
      await mkdir(join(dir, 'app', 'services'), { recursive: true });
      await mkdir(join(dir, 'app', 'models'), { recursive: true });
      await writeFile(
        join(dir, 'requirements.txt'),
        ['Flask==3.0.0', 'Flask-SQLAlchemy==3.1.1', 'pytest==8.0.0'].join('\n'),
      );
      await writeFile(
        join(dir, 'app', 'routes', 'wallet_routes.py'),
        [
          'from flask import Blueprint, jsonify',
          'from app.services.wallet_service import get_wallet',
          'wallet_bp = Blueprint("wallets", __name__)',
          '@wallet_bp.get("/wallets/<int:wallet_id>")',
          'def wallet_detail(wallet_id):',
          '    return jsonify(get_wallet(wallet_id))',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'app', 'services', 'wallet_service.py'),
        [
          'from app.models.wallet import Wallet',
          'def get_wallet(wallet_id):',
          '    return Wallet.query.filter_by(id=wallet_id).first()',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'app', 'models', 'wallet.py'),
        [
          'from app.models.user import User',
          'from app.models.user import db',
          'class Wallet(db.Model):',
          '    __tablename__ = "wallets"',
          '    id = db.Column(db.Integer, primary_key=True)',
          '    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)',
          '    balance_cents = db.Column(db.Integer, default=0)',
          '    user = db.relationship("User", back_populates="wallets")',
        ].join('\n'),
      );
      await writeFile(
        join(dir, 'app', 'models', 'user.py'),
        [
          'from flask_sqlalchemy import SQLAlchemy',
          'db = SQLAlchemy()',
          'class User(db.Model):',
          '    __tablename__ = "users"',
          '    id = db.Column(db.Integer, primary_key=True)',
          '    email = db.Column(db.String(255), nullable=False)',
          '    wallets = db.relationship("Wallet", back_populates="user")',
        ].join('\n'),
      );

      const brain = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:27:00.000Z'),
      });

      expect(brain.ok).toBe(true);
      if (!brain.ok) return;
      const databaseTables = await readJson<{
        entities: Array<{ id: string; name: string; data?: { relationships?: unknown[] } }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'database_tables.json'));
      expect(databaseTables.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'database/table:app--models--wallet.py-wallets',
            data: expect.objectContaining({
              relationships: expect.arrayContaining([
                expect.objectContaining({
                  kind: 'foreign_key',
                  source_field: 'user_id',
                  target_table: 'users',
                  target_field: 'id',
                }),
                expect.objectContaining({
                  kind: 'relationship',
                  source_field: 'user',
                  target_table: 'users',
                  target_model: 'User',
                  inverse_field: 'wallets',
                }),
              ]),
            }),
          }),
        ]),
      );
      const graph = await readJson<{
        relationships: Array<{ from: string; relation: string; to: string }>;
      }>(join(dir, '.rizz', 'brain', 'graph.json'));
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'database/table:app--models--wallet.py-wallets',
          relation: 'depends_on',
          to: 'database/table:app--models--user.py-users',
        }),
      );

      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'app', 'models', 'user.py'),
        [
          'from flask_sqlalchemy import SQLAlchemy',
          'db = SQLAlchemy()',
          'class User(db.Model):',
          '    __tablename__ = "users"',
          '    id = db.Column(db.Integer, primary_key=True)',
          '    email_address = db.Column(db.String(255), nullable=False)',
          '    wallets = db.relationship("Wallet", back_populates="user")',
        ].join('\n'),
      );

      const review = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:28:00.000Z'),
      });

      expect(review.ok).toBe(true);
      if (!review.ok) return;
      const walletFlow = review.value.review.affected_flows.find(
        (flow) => flow.route_path === '/wallets/<int:wallet_id>',
      );
      expect(walletFlow?.changed_files).toContain('app/models/user.py');
      expect(review.value.review.review_evidence_summary.affected_data_dependencies).toEqual(
        expect.arrayContaining(['database/table:app--models--user.py-users']),
      );
      expect(review.value.review.affected_relationships).toContainEqual(
        expect.objectContaining({
          from: 'database/table:app--models--wallet.py-wallets',
          relation: 'depends_on',
          to: 'database/table:app--models--user.py-users',
        }),
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
