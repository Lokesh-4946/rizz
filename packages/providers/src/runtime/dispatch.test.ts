import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ApprovalRequest, dispatchTool } from './dispatch.js';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rizz-dispatch-'));
}

describe('dispatchTool', () => {
  it('rejects an unknown tool with BAD_TOOL_CALL', async () => {
    const result = await dispatchTool({
      call: { name: 'frobnicate', args: {} },
      cwd: process.cwd(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BAD_TOOL_CALL');
  });

  it('rejects a write missing required args with BAD_TOOL_CALL', async () => {
    const result = await dispatchTool({
      call: { name: 'write', args: { path: 'x' } },
      cwd: process.cwd(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BAD_TOOL_CALL');
  });

  it('routes write→read round-trip with a clickable display line', async () => {
    const cwd = await tmpDir();
    const write = await dispatchTool({
      call: { name: 'write', args: { path: 'a.txt', content: 'hi' } },
      cwd,
    });
    expect(write.ok).toBe(true);
    if (write.ok) expect(write.value.forDisplay).toContain('write · a.txt');
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('hi');
  });

  it('runs a read-only bash command with no approval prompt', async () => {
    let asked = false;
    const result = await dispatchTool({
      call: { name: 'bash', args: { command: 'echo ok' } },
      cwd: process.cwd(),
      onApprovalNeeded: async () => {
        asked = true;
        return { approved: true };
      },
    });
    expect(result.ok).toBe(true);
    expect(asked).toBe(false);
  });

  it('asks for approval on a destructive command and runs it when approved', async () => {
    const cwd = await tmpDir();
    const requests: ApprovalRequest[] = [];
    const result = await dispatchTool({
      call: { name: 'bash', args: { command: 'touch approved.txt' } },
      cwd,
      onApprovalNeeded: async (req) => {
        requests.push(req);
        return { approved: true };
      },
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.kind).toBe('destructive');
    expect(await readFile(join(cwd, 'approved.txt'), 'utf8')).toBe('');
  });

  it('does not run a destructive command when approval is denied', async () => {
    const result = await dispatchTool({
      call: { name: 'bash', args: { command: 'rm -rf /tmp/should-not-run' } },
      cwd: process.cwd(),
      onApprovalNeeded: async () => ({ approved: false }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.meta?.denied).toBe(true);
  });

  it('denies-by-default when a destructive command has no approval channel', async () => {
    const result = await dispatchTool({
      call: { name: 'bash', args: { command: 'rm -rf x' } },
      cwd: process.cwd(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.meta?.denied).toBe(true);
  });
});
