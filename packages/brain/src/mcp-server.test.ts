import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeContextCommand } from './context-command.js';
import { startLoopWork } from './context-loop.js';
import { generateProjectBrain } from './index.js';
import { createMcpServer } from './mcp-server.js';
import { prepareProjectStore } from './project-store.js';

const roots: string[] = [];

async function fixture(): Promise<{ rootDir: string; rizzHome: string; projectId: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), 'rizz-mcp-repo-'));
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-mcp-home-'));
  roots.push(rootDir, rizzHome);
  execFileSync('git', ['init', '-q'], { cwd: rootDir });
  execFileSync('git', ['config', 'user.email', 'rizz@example.test'], { cwd: rootDir });
  execFileSync('git', ['config', 'user.name', 'Rizz Test'], { cwd: rootDir });
  await mkdir(join(rootDir, 'src'));
  await writeFile(join(rootDir, 'src', 'hero.ts'), 'export const hero = true;\n');
  execFileSync('git', ['add', '.'], { cwd: rootDir });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: rootDir });
  const store = await prepareProjectStore({ rootDir, rizzHome, remote: null });
  if (!store.ok) throw new Error(store.error.message);
  const brain = await generateProjectBrain({ rootDir, outputDir: store.value.projectDir });
  if (!brain.ok) throw new Error(brain.error.message);
  await writeFile(
    join(store.value.projectDir, 'product', 'current.md'),
    '# Product\n\nShip useful work.\n',
  );
  await writeFile(
    join(store.value.projectDir, 'planning', 'sprint.md'),
    '# Sprint\n\nUpdate Hero.\n',
  );
  return { rootDir, rizzHome, projectId: store.value.projectId };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function capture() {
  const messages: Array<Record<string, unknown>> = [];
  return {
    messages,
    write(line: string) {
      messages.push(JSON.parse(line));
    },
  };
}

describe('Rizz MCP server', () => {
  it('initializes and exposes stable resources and tools without a model', async () => {
    const setup = await fixture();
    const output = capture();
    const server = createMcpServer({ ...setup, write: output.write });
    await server.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list' }));
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));

    expect(output.messages[0]).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 1,
        result: expect.objectContaining({ serverInfo: { name: 'rizz', version: '0.3.1' } }),
      }),
    );
    const resources = (output.messages[1]?.result as { resources: Array<{ uri: string }> })
      .resources;
    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        'rizz://project/current',
        'rizz://brain/summary',
        'rizz://sprint/current',
        'rizz://resources/status',
      ]),
    );
    const tools = (output.messages[2]?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'get_task_brief',
        'record_checkpoint',
        'complete_work',
        'create_handoff',
      ]),
    );
  });

  it('reads isolated resources and compiles the same task brief as CLI JSON', async () => {
    const setup = await fixture();
    const output = capture();
    const server = createMcpServer({ ...setup, write: output.write });
    await server.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    );
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'rizz://product/current' },
      }),
    );
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_task_brief', arguments: { task: 'Update Hero' } },
      }),
    );
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'explain_file', arguments: { path: 'src/hero.ts' } },
      }),
    );
    expect(JSON.stringify(output.messages[1])).toContain('Ship useful work.');
    const result = output.messages[2]?.result as {
      structuredContent: { project_id: string; claims: unknown[] };
    };
    const cli = await executeContextCommand({
      rootDir: setup.rootDir,
      rizzHome: setup.rizzHome,
      args: ['brief', 'Update Hero', '--json'],
    });
    expect(result.structuredContent.project_id).toBe(setup.projectId);
    expect(result.structuredContent.claims.length).toBeGreaterThan(0);
    expect(result.structuredContent).toEqual(JSON.parse(cli.stdout));
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(output.messages[3]?.result).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          latestPath: expect.stringContaining(setup.rizzHome),
          explanation: expect.objectContaining({ target: 'src/hero.ts' }),
        }),
      }),
    );
  });

  it('requires project, repository, and sequence matches for mutations', async () => {
    const setup = await fixture();
    const output = capture();
    const server = createMcpServer({ ...setup, write: output.write });
    await server.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    );
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'record_checkpoint',
          arguments: {
            project_id: setup.projectId,
            repository_revision: 'wrong',
            sequence: 1,
            summary: 'unsafe',
          },
        },
      }),
    );
    expect(output.messages[1]?.result).toEqual(
      expect.objectContaining({
        isError: true,
        structuredContent: expect.objectContaining({ code: 'MCP_REVISION_MISMATCH' }),
      }),
    );
  });

  it('records successful mutations in the selected isolated project store', async () => {
    const setup = await fixture();
    const started = await startLoopWork({
      ...setup,
      task: 'Update Hero',
      agent: 'codex',
    });
    if (!started.ok) throw new Error(started.error.message);
    const output = capture();
    const server = createMcpServer({ ...setup, write: output.write });
    await server.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    );
    const repositoryRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: setup.rootDir,
      encoding: 'utf8',
    }).trim();
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'record_checkpoint',
          arguments: {
            project_id: setup.projectId,
            repository_revision: repositoryRevision,
            sequence: 1,
            summary: 'Inspected Hero',
          },
        },
      }),
    );
    const mutation = output.messages[1]?.result as {
      isError?: boolean;
      structuredContent: { sequence?: number };
    };
    expect(mutation.isError).not.toBe(true);
    expect(mutation.structuredContent.sequence).toBe(2);
  });

  it('rejects resources and tools before initialization', async () => {
    const setup = await fixture();
    const output = capture();
    const server = createMcpServer({ ...setup, write: output.write });
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(output.messages[0]?.error).toEqual(
      expect.objectContaining({ code: -32002, message: 'Server not initialized' }),
    );
  });

  it('returns protocol errors for malformed JSON and unknown methods without crashing', async () => {
    const setup = await fixture();
    const output = capture();
    const server = createMcpServer({ ...setup, write: output.write });
    await server.handle('{bad');
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'missing' }));
    expect(output.messages.map((message) => (message.error as { code: number }).code)).toEqual([
      -32700, -32601,
    ]);
  });
});
