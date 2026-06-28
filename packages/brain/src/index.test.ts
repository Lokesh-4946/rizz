import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateProjectBrain } from './index.js';

async function withTempProject<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'rizz-brain-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readTreeText(dir: string): Promise<string> {
  let out = '';
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out += await readTreeText(path);
      continue;
    }
    if (entry.isFile()) out += await readFile(path, 'utf8');
  }
  return out;
}

describe('project brain generation', () => {
  it('writes relational brain files, latest state, graph, snapshot, and report', async () => {
    await withTempProject(async (dir) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'sample-app',
          scripts: { build: 'tsc -b', test: 'vitest run', start: 'node dist/index.js' },
          dependencies: { '@example/runtime': '^1.0.0' },
          devDependencies: { vitest: '^2.0.0', typescript: '^5.0.0' },
        }),
      );
      await writeFile(join(dir, 'tsconfig.json'), '{}');
      await writeFile(join(dir, 'README.md'), '# Sample');
      await writeFile(join(dir, 'src.test.ts'), 'import { expect, it } from "vitest";');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:30:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: { scannedFiles: 4, changedFiles: 4, staleFiles: 0, commands: 3, tests: 1 },
      });
      if (!result.ok) return;

      const latest = await readJson<Record<string, unknown>>(result.value.latestPath);
      expect(latest.latest_architecture_summary).toContain('component');
      expect(latest.project_state).toMatchObject({
        package_manager: 'unknown',
        changed_files: expect.arrayContaining([
          'README.md',
          'package.json',
          'src.test.ts',
          'tsconfig.json',
        ]),
        stale_files: [],
      });

      const graph = await readJson<{ relationships: Array<{ from: string; relation: string }> }>(
        join(dir, '.rizz', 'brain', 'graph.json'),
      );
      expect(graph.relationships.some((rel) => rel.relation === 'depends_on')).toBe(true);
      expect(graph.relationships.some((rel) => rel.relation === 'exposes')).toBe(true);

      const files = await readJson<{ entities: Array<{ id: string; data?: { hash?: string } }> }>(
        join(dir, '.rizz', 'brain', 'entities', 'files.json'),
      );
      expect(files.entities.map((entity) => entity.id)).toContain('file:package.json');
      expect(files.entities.every((entity) => typeof entity.data?.hash === 'string')).toBe(true);

      const report = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(report).toContain('rizz project brain');
      expect(report).toContain('Dependency Graph');

      const snapshot = await readJson<Record<string, unknown>>(
        join(dir, '.rizz', 'brain', 'snapshots', '2026-06-28T10-30-00.000Z.json'),
      );
      expect(snapshot).toHaveProperty('latest');
    });
  });

  it('preserves stable file ids and marks removed files as stale on later scans', async () => {
    await withTempProject(async (dir) => {
      const packagePath = join(dir, 'package.json');
      await writeFile(
        packagePath,
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(dir, 'old.ts'), 'export const oldValue = 1;');

      const first = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:30:00.000Z'),
      });
      expect(first.ok).toBe(true);

      await rm(join(dir, 'old.ts'));
      await writeFile(
        packagePath,
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest' } }),
      );

      const second = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:31:00.000Z'),
      });
      expect(second).toMatchObject({
        ok: true,
        value: { scannedFiles: 1, changedFiles: 1, staleFiles: 1 },
      });

      const files = await readJson<{
        entities: Array<{ id: string; latest_status: string; created_at: string }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'files.json'));
      expect(files.entities).toContainEqual(
        expect.objectContaining({
          id: 'file:old.ts',
          latest_status: 'stale',
          created_at: '2026-06-28T10:30:00.000Z',
        }),
      );
      expect(files.entities).toContainEqual(
        expect.objectContaining({
          id: 'file:package.json',
          latest_status: 'changed',
          created_at: '2026-06-28T10:30:00.000Z',
        }),
      );
    });
  });

  it('redacts secret-like strings from generated brain and report output', async () => {
    await withTempProject(async (dir) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'sample-app',
          scripts: {
            test: 'OPENAI_API_KEY=sk-ant-brainsecret0000000000000000 ghp_token=ghp_brainsecret000000000000000 vitest run --header "Authorization: Bearer brain.secret.token"',
          },
        }),
      );
      await writeFile(
        join(dir, '.env.example'),
        'OPENROUTER_API_KEY=sk-or-v1-brainsecret0000000000000000',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:32:00.000Z'),
      });

      expect(result.ok).toBe(true);
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).not.toContain('sk-ant-brainsecret');
      expect(generated).not.toContain('sk-or-v1-brainsecret');
      expect(generated).not.toContain('ghp_brainsecret');
      expect(generated).not.toContain('Bearer brain.secret.token');
      expect(generated).toContain('[redacted secret]');
    });
  });

  it('skips private env and key files while keeping env examples', async () => {
    await withTempProject(async (dir) => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await writeFile(join(dir, '.env'), 'OPENAI_API_KEY=sk-ant-private0000000000000000');
      await writeFile(
        join(dir, '.env.local'),
        'OPENROUTER_API_KEY=sk-or-v1-private0000000000000000',
      );
      await writeFile(join(dir, 'server.key'), 'private key sentinel');
      await writeFile(join(dir, '.env.example'), 'OPENROUTER_API_KEY=');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:33:00.000Z'),
      });

      expect(result.ok).toBe(true);
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).not.toContain('"relativePath": ".env"');
      expect(generated).not.toContain('.env.local');
      expect(generated).not.toContain('server.key');
      expect(generated).not.toContain('private key sentinel');
      expect(generated).toContain('.env.example');
    });
  });
});
