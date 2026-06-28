import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateProjectBrain, reviewProjectChanges } from './index.js';

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

async function git(dir: string, args: readonly string[]): Promise<void> {
  const { spawnSync } = await import('node:child_process');
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

  it('enriches components with purpose, interfaces, criticality, dependencies, and removal impact', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'packages', 'cli', 'package.json'),
        JSON.stringify({
          name: '@sample/cli',
          scripts: { start: 'node dist/index.js', test: 'vitest run' },
          dependencies: { commander: '^12.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'export function main() { return "ok"; }',
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.test.ts'),
        'import { it } from "vitest";',
      );

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:31:30.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const components = await readJson<{
        entities: Array<{
          id: string;
          description: string;
          data?: {
            purpose?: string;
            responsibilities?: string[];
            interfaces?: string[];
            entry_points?: string[];
            consumers?: string[];
            dependencies?: string[];
            exposed_apis?: string[];
            tests?: string[];
            configs?: string[];
            criticality?: string;
            criticality_score?: number;
            what_breaks_if_removed?: string[];
            important_files?: string[];
            known_risks?: string[];
            field_evidence?: Record<string, string[]>;
          };
        }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'components.json'));
      const cli = components.entities.find((entity) => entity.id === 'component:packages--cli');
      expect(cli).toBeDefined();
      expect(cli?.description).toContain('Command-line surface');
      expect(cli?.data).toMatchObject({
        purpose: expect.stringContaining('Command-line surface'),
        criticality: 'high',
      });
      expect(cli?.data?.responsibilities).toContain(
        'Expose user-facing commands and route them to product flows.',
      );
      expect(cli?.data?.interfaces).toEqual(
        expect.arrayContaining(['package: @sample/cli', 'script: start', 'script: test']),
      );
      expect(cli?.data?.entry_points).toEqual(
        expect.arrayContaining([
          'packages/cli/package.json',
          'packages/cli/package.json#start -> node dist/index.js',
          'packages/cli/src/index.ts',
        ]),
      );
      expect(cli?.data?.consumers).toContain('Developers invoking the rizz CLI.');
      expect(cli?.data?.dependencies).toEqual(expect.arrayContaining(['commander', 'vitest']));
      expect(cli?.data?.exposed_apis).toContain('module export surface: packages/cli/src/index.ts');
      expect(cli?.data?.tests).toEqual(['packages/cli/src/index.test.ts']);
      expect(cli?.data?.configs).toEqual(['packages/cli/package.json']);
      expect(cli?.data?.criticality_score).toBeGreaterThanOrEqual(7);
      expect(cli?.data?.what_breaks_if_removed).toContainEqual(
        expect.stringContaining('likely critical'),
      );
      expect(cli?.data?.important_files).toEqual(
        expect.arrayContaining(['packages/cli/package.json', 'packages/cli/src/index.ts']),
      );
      expect(cli?.data?.known_risks).toEqual([]);
      expect(cli?.data?.field_evidence).toMatchObject({
        purpose: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        dependencies: expect.arrayContaining(['evidence:file-packages--cli--package.json']),
        tests: ['evidence:file-packages--cli--src--index.test.ts'],
        configs: ['evidence:file-packages--cli--package.json'],
        exposed_apis: ['evidence:file-packages--cli--src--index.ts'],
      });

      const latest = await readJson<{ latest_component_map: Array<Record<string, unknown>> }>(
        result.value.latestPath,
      );
      expect(latest.latest_component_map).toContainEqual(
        expect.objectContaining({
          id: 'component:packages--cli',
          purpose: expect.stringContaining('Command-line surface'),
          responsibilities: expect.arrayContaining([
            'Expose user-facing commands and route them to product flows.',
          ]),
          entry_points: expect.arrayContaining(['packages/cli/src/index.ts']),
          criticality: 'high',
          what_breaks_if_removed: expect.arrayContaining([
            expect.stringContaining('likely critical'),
          ]),
          important_files: expect.arrayContaining(['packages/cli/package.json']),
        }),
      );

      const graph = await readJson<{
        relationships: Array<{ from: string; relation: string; to: string }>;
      }>(join(dir, '.rizz', 'brain', 'graph.json'));
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'component:packages--cli',
          relation: 'owns',
          to: 'file:packages--cli--src--index.ts',
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'component:packages--cli',
          relation: 'depends_on',
          to: 'dependency:commander',
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'test:packages--cli--src--index.test.ts',
          relation: 'tests',
          to: 'component:packages--cli',
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from: 'component:packages--cli',
          relation: 'exposes',
        }),
      );

      const report = await readFile(join(dir, '.rizz', 'reports', 'index.html'), 'utf8');
      expect(report).toContain('Responsibilities');
      expect(report).toContain('If Removed');
      expect(report).toContain('Important Files');
      expect(report).toContain('Evidence');
      expect(report).toContain('Command-line surface');
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

  it('skips default local agent, build, binary, and tsbuildinfo noise', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, '.agents', 'handoffs'), { recursive: true });
      await mkdir(join(dir, '.codex'), { recursive: true });
      await mkdir(join(dir, 'dist-pack'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await writeFile(join(dir, 'src', 'index.ts'), 'export const ok = true;');
      await writeFile(join(dir, '.agents', 'handoffs', 'handoff.md'), 'local agent memory');
      await writeFile(join(dir, '.codex', 'config.toml'), 'model = "test"');
      await writeFile(join(dir, 'dist-pack', 'sample.tgz'), 'packed package');
      await writeFile(join(dir, 'tsconfig.tsbuildinfo'), '{}');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:34:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: { scannedFiles: 2, changedFiles: 2 },
      });
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).toContain('src/index.ts');
      expect(generated).not.toContain('local agent memory');
      expect(generated).not.toContain('.codex/config.toml');
      expect(generated).not.toContain('sample.tgz');
      expect(generated).not.toContain('tsconfig.tsbuildinfo');
    });
  });

  it('honors project .rizzignore patterns for user-controlled scan scope', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, 'tmp'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await writeFile(join(dir, '.rizzignore'), 'tmp/\n*.generated.ts\n');
      await writeFile(join(dir, 'src', 'index.ts'), 'export const ok = true;');
      await writeFile(join(dir, 'src', 'client.generated.ts'), 'export const generated = true;');
      await writeFile(join(dir, 'tmp', 'notes.md'), 'scratch');

      const result = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:35:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: { scannedFiles: 3, changedFiles: 3 },
      });
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).toContain('.rizzignore');
      expect(generated).toContain('src/index.ts');
      expect(generated).not.toContain('client.generated.ts');
      expect(generated).not.toContain('tmp/notes.md');
    });
  });

  it('drops previously known files from active state when they become ignored', async () => {
    await withTempProject(async (dir) => {
      await mkdir(join(dir, 'tmp'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await writeFile(join(dir, 'tmp', 'notes.md'), 'scratch');

      const first = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:36:00.000Z'),
      });
      expect(first).toMatchObject({
        ok: true,
        value: { scannedFiles: 2, staleFiles: 0 },
      });

      await writeFile(join(dir, '.rizzignore'), 'tmp/\n');
      const second = await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:37:00.000Z'),
      });
      expect(second).toMatchObject({
        ok: true,
        value: { scannedFiles: 2, staleFiles: 0 },
      });

      const files = await readJson<{ entities: Array<{ name: string; latest_status: string }> }>(
        join(dir, '.rizz', 'brain', 'entities', 'files.json'),
      );
      expect(files.entities).not.toContainEqual(expect.objectContaining({ name: 'tmp/notes.md' }));
      expect(files.entities).not.toContainEqual(
        expect.objectContaining({ latest_status: 'stale' }),
      );
    });
  });

  it('reviews the current git diff and writes evidence-backed review artifacts', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'sample-app',
          scripts: { check: 'vitest run && tsc -b', build: 'tsc -b' },
        }),
      );
      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'export const answer = 1;\n',
      );
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:38:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);

      await writeFile(
        join(dir, 'packages', 'cli', 'src', 'index.ts'),
        'export const answer = 2;\n',
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:39:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          changedFiles: 1,
          affectedComponents: 1,
          blastRadius: 'narrow',
          recommendedAction: 'investigate',
        },
      });
      if (!result.ok) return;
      expect(result.value.review.changed_files).toEqual(['packages/cli/src/index.ts']);
      expect(result.value.review.affected_components).toContain('component:packages--cli');
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({ category: 'Missing tests', severity: 'medium' }),
      );

      const reviews = await readJson<{
        entities: Array<{ id: string; data?: { overall_risk?: string } }>;
      }>(join(dir, '.rizz', 'brain', 'entities', 'reviews.json'));
      expect(reviews.entities).toContainEqual(
        expect.objectContaining({
          id: 'review:2026-06-28t10-39-00.000z-git-diff',
          data: expect.objectContaining({ overall_risk: 'medium' }),
        }),
      );
      const latest = await readJson<{
        latest_review_status: { readonly status?: string; readonly findings?: number };
      }>(join(dir, '.rizz', 'brain', 'latest.json'));
      expect(latest.latest_review_status).toMatchObject({
        status: 'investigate',
      });
      expect(Number(latest.latest_review_status.findings)).toBeGreaterThanOrEqual(1);
      const report = await readFile(join(dir, '.rizz', 'reports', 'review.html'), 'utf8');
      expect(report).toContain('rizz review');
      expect(report).toContain('Missing tests');
    });
  });

  it('automatically creates a lightweight brain when review runs first', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(join(dir, 'README.md'), '# changed\n');

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:40:00.000Z'),
      });

      expect(result.ok).toBe(true);
      expect(await readFile(join(dir, '.rizz', 'brain', 'latest.json'), 'utf8')).toContain(
        'latest_review_status',
      );
    });
  });

  it('fails review when required brain schema files are malformed', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await mkdir(join(dir, '.rizz', 'brain'), { recursive: true });
      await writeFile(join(dir, '.rizz', 'brain', 'latest.json'), '{}');
      await writeFile(join(dir, '.rizz', 'brain', 'graph.json'), '{"relationships":[]}');
      await writeFile(join(dir, 'README.md'), '# sample\n');
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(join(dir, 'README.md'), '# changed\n');

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:41:00.000Z'),
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'BRAIN_SCHEMA_INVALID' },
      });
    });
  });

  it('redacts secret-like strings from review findings and reports', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(dir, 'provider.ts'), 'export const key = "";\n');
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:42:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'provider.ts'),
        'export const key = "sk-or-v1-reviewsecret0000000000000000";\n',
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:43:00.000Z'),
      });

      expect(result.ok).toBe(true);
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).not.toContain('sk-or-v1-reviewsecret');
      expect(generated).toContain('Security-sensitive surface changed');
    });
  });

  it('detects secret-like strings in untracked files without persisting them', async () => {
    await withTempProject(async (dir) => {
      await initGitProject(dir);
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'sample-app', scripts: { test: 'vitest run' } }),
      );
      await generateProjectBrain({
        rootDir: dir,
        now: new Date('2026-06-28T10:44:00.000Z'),
      });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'initial']);
      await writeFile(
        join(dir, 'scratch.ts'),
        'export const key = "sk-or-v1-untrackedsecret0000000000000000";\n',
      );

      const result = await reviewProjectChanges({
        rootDir: dir,
        now: new Date('2026-06-28T10:45:00.000Z'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.review.findings).toContainEqual(
        expect.objectContaining({ category: 'Security', severity: 'critical' }),
      );
      const generated = await readTreeText(join(dir, '.rizz'));
      expect(generated).not.toContain('sk-or-v1-untrackedsecret');
      expect(generated).toContain('Security-sensitive surface changed');
    });
  });
});
