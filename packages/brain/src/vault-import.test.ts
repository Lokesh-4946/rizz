import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeContextCommand } from './context-command.js';
import {
  applyVaultImport,
  inspectVault,
  previewVaultImport,
  reconcileVaultImport,
} from './vault-import.js';

const roots: string[] = [];

async function setup(): Promise<{ rootDir: string; rizzHome: string; vaultDir: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), 'rizz-vault-repo-'));
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-vault-home-'));
  const vaultDir = await mkdtemp(join(tmpdir(), 'rizz-vault-source-'));
  roots.push(rootDir, rizzHome, vaultDir);
  execFileSync('git', ['init', '-q'], { cwd: rootDir });
  execFileSync('git', ['config', 'user.email', 'rizz@example.test'], { cwd: rootDir });
  execFileSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: rootDir });
  await writeFile(join(rootDir, 'package.json'), '{"name":"vault-target"}\n');
  execFileSync('git', ['add', '.'], { cwd: rootDir });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: rootDir });
  return { rootDir, rizzHome, vaultDir };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('vault inspection and preview', () => {
  it('classifies Markdown and reports duplicates, conflicts, stale paths, and secrets read-only', async () => {
    const fixture = await setup();
    await mkdir(join(fixture.vaultDir, 'nested'));
    const secret = ['sk', 'vault', 'secret', '12345678901234567890'].join('-');
    await writeFile(
      join(fixture.vaultDir, 'product.md'),
      '# Product\n\nShip a local agent OS.\n\nSee /Users/old/project/src.\n',
    );
    await writeFile(
      join(fixture.vaultDir, 'sprint.md'),
      `# Sprint\n\nShip a local agent OS.\n\napi_key=${secret}\n`,
    );
    await writeFile(
      join(fixture.vaultDir, 'nested', 'sprint.md'),
      `# Sprint\n\nDifferent goal.\n\napi_key=${secret}\n`,
    );
    await writeFile(join(fixture.vaultDir, 'ignore.txt'), 'not imported');
    const before = await readdir(fixture.vaultDir, { recursive: true });

    const result = await inspectVault({ sourceDir: fixture.vaultDir });

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.documents.map((document) => [document.source_path, document.classification]),
    ).toEqual([
      ['nested/sprint.md', 'planning'],
      ['product.md', 'product'],
      ['sprint.md', 'planning'],
    ]);
    expect(result.value.duplicate_claims).toEqual(
      expect.arrayContaining([expect.objectContaining({ claim: 'Ship a local agent OS.' })]),
    );
    expect(result.value.naming_conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'sprint.md' })]),
    );
    expect(result.value.stale_absolute_paths).toContain('/Users/old/project/src');
    expect(result.value.secret_findings).toHaveLength(2);
    expect(JSON.stringify(result.value)).not.toContain(secret);
    expect(await readdir(fixture.vaultDir, { recursive: true })).toEqual(before);
  });

  it('previews exact external destinations without writing imported documents', async () => {
    const fixture = await setup();
    await writeFile(join(fixture.vaultDir, 'roadmap.md'), '# Roadmap\n');
    const statusBefore = execFileSync('git', ['status', '--porcelain'], {
      cwd: fixture.rootDir,
      encoding: 'utf8',
    });

    const result = await previewVaultImport({ ...fixture, sourceDir: fixture.vaultDir });

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe('copy');
    expect(result.value.operations).toEqual([
      expect.objectContaining({ source_path: 'roadmap.md', classification: 'product' }),
    ]);
    await expect(
      readFile(result.value.operations[0]?.destination_path ?? '', 'utf8'),
    ).rejects.toThrow();
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: fixture.rootDir, encoding: 'utf8' }),
    ).toBe(statusBefore);
  });
});

describe('vault apply and reconcile', () => {
  it('blocks secret-bearing content before any document is copied', async () => {
    const fixture = await setup();
    const secret = ['sk', 'blocked', 'secret', '12345678901234567890'].join('-');
    await writeFile(join(fixture.vaultDir, 'product.md'), `# Product\n\napi_key=${secret}\n`);
    const result = await applyVaultImport({ ...fixture, sourceDir: fixture.vaultDir });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VAULT_SECRET_REVIEW_REQUIRED' }),
    });
    const { prepareProjectStore } = await import('./project-store.js');
    const store = await prepareProjectStore(fixture);
    if (!store.ok) throw new Error(store.error.message);
    await expect(
      readFile(join(store.value.projectDir, 'product', 'imports', 'product.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('copies only into the project workspace, scaffolds planning docs, and reconciles source drift', async () => {
    const fixture = await setup();
    await writeFile(join(fixture.vaultDir, 'sprint.md'), '# Sprint\n\nInitial.\n');
    const before = await readFile(join(fixture.vaultDir, 'sprint.md'), 'utf8');
    const applied = await applyVaultImport({ ...fixture, sourceDir: fixture.vaultDir });
    expect(applied.ok, applied.ok ? '' : applied.error.message).toBe(true);
    if (!applied.ok) return;
    expect(await readFile(applied.value.operations[0]?.destination_path ?? '', 'utf8')).toBe(
      before,
    );
    for (const relativePath of [
      'product/current.md',
      'product/principles.md',
      'planning/sprint.md',
      'planning/backlog.md',
      'planning/board.md',
    ]) {
      expect(await readFile(join(applied.value.project_dir, relativePath), 'utf8')).toContain('#');
    }
    expect(
      await readFile(join(applied.value.project_dir, 'product/principles.md'), 'utf8'),
    ).toContain('prevents agent slop');
    await writeFile(join(fixture.vaultDir, 'sprint.md'), '# Sprint\n\nChanged.\n');
    const reconciled = await reconcileVaultImport(fixture);
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(reconciled.value.changed_sources).toEqual(['sprint.md']);
    expect(await readFile(join(fixture.vaultDir, 'sprint.md'), 'utf8')).toContain('Changed.');
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: fixture.rootDir, encoding: 'utf8' }),
    ).toBe('');
  });

  it('exposes inspect, preview, apply, and reconcile through JSON CLI parity', async () => {
    const fixture = await setup();
    await writeFile(join(fixture.vaultDir, 'product.md'), '# Product\n\nSubstantial work only.\n');
    const previousHome = process.env.RIZZ_HOME;
    process.env.RIZZ_HOME = fixture.rizzHome;
    try {
      const commands = [
        ['vault', 'inspect', fixture.vaultDir, '--json'],
        ['vault', 'import', fixture.vaultDir, '--preview', '--json'],
        ['vault', 'import', fixture.vaultDir, '--apply', '--json'],
        ['vault', 'reconcile', '--json'],
      ];
      const results = [];
      for (const args of commands) {
        results.push(await executeContextCommand({ rootDir: fixture.rootDir, args }));
      }
      expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0, 0]);
      expect(JSON.parse(results[1]?.stdout ?? '{}').mode).toBe('copy');
      expect(JSON.parse(results[3]?.stdout ?? '{}').changed_sources).toEqual([]);
    } finally {
      process.env.RIZZ_HOME = previousHome;
    }
  });
});
