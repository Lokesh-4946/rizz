import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAgentCommand } from './agent-bridges.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'rizz-agent-home-'));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('user-level agent bridges', () => {
  it('detects supported tools without writing configuration', async () => {
    const homeDir = await home();
    const result = await executeAgentCommand({
      args: ['agents', 'detect', '--json'],
      homeDir,
      commandExists: (command) => command !== 'claude',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.command).toBe('detect');
    expect(result.value.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'codex', command_detected: true }),
        expect.objectContaining({ id: 'claude', command_detected: false }),
        expect.objectContaining({ id: 'copilot', command_detected: true }),
      ]),
    );
    await expect(
      readFile(join(homeDir, '.agents', 'skills', 'use-rizz-context', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('previews then configures the same five bridge skills for every user-level target', async () => {
    const homeDir = await home();
    const preview = await executeAgentCommand({
      args: ['agents', 'configure', '--user', '--dry-run', '--json'],
      homeDir,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.writes).toHaveLength(20);
    expect(preview.value.applied).toBe(false);

    const configured = await executeAgentCommand({
      args: ['agents', 'configure', '--user', '--json'],
      homeDir,
    });
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;
    expect(configured.value.applied).toBe(true);
    expect(configured.value.writes.every((write) => write.status === 'created')).toBe(true);
    for (const base of ['.agents', '.codex', '.claude', '.copilot']) {
      const content = await readFile(
        join(homeDir, base, 'skills', 'use-rizz-context', 'SKILL.md'),
        'utf8',
      );
      expect(content).toContain('rizz brief "$TASK" --json');
      expect(content).not.toContain(homeDir);
    }
  });

  it('is idempotent and refuses to overwrite a conflicting user skill', async () => {
    const homeDir = await home();
    await executeAgentCommand({ args: ['agents', 'configure', '--user'], homeDir });
    const second = await executeAgentCommand({ args: ['agents', 'configure', '--user'], homeDir });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.writes.every((write) => write.status === 'unchanged')).toBe(true);

    const conflict = join(homeDir, '.claude', 'skills', 'use-rizz-context', 'SKILL.md');
    await mkdir(join(conflict, '..'), { recursive: true });
    await writeFile(conflict, 'user-owned\n');
    const refused = await executeAgentCommand({
      args: ['agents', 'configure', '--user'],
      homeDir,
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'AGENT_SKILL_CONFLICT' },
    });
    expect(await readFile(conflict, 'utf8')).toBe('user-owned\n');
  });

  it('reports missing, healthy, and conflicting bridges in doctor output', async () => {
    const homeDir = await home();
    const missing = await executeAgentCommand({ args: ['agents', 'doctor', '--json'], homeDir });
    expect(missing.ok && missing.value.healthy).toBe(false);
    await executeAgentCommand({ args: ['agents', 'configure', '--user'], homeDir });
    const healthy = await executeAgentCommand({ args: ['agents', 'doctor', '--json'], homeDir });
    expect(healthy.ok && healthy.value.healthy).toBe(true);
    expect(healthy.ok && healthy.value.checks).toHaveLength(20);
  });
});
