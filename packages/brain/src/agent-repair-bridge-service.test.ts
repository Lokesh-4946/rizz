import { describe, expect, it } from 'vitest';
import {
  type AgentRepairBridgeRunner,
  runAgentRepairBridge,
} from './agent-repair-bridge-service.js';

describe('agent repair bridge service', () => {
  it('maps every supported agent to a bounded least-privilege non-interactive invocation', async () => {
    const calls: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly input: string | null;
    }> = [];
    const runner: AgentRepairBridgeRunner = async (command, args, options) => {
      calls.push({ command, args, input: options.input });
      return { status: 0, stdout: 'repair complete', stderr: '' };
    };

    for (const agent of ['codex', 'claude', 'copilot'] as const) {
      const result = await runAgentRepairBridge({
        agent,
        cwd: '/isolated/worktree',
        prompt: 'Repair only the selected packet.',
        runner,
      });
      expect(result).toMatchObject({
        ok: true,
        value: { exit_code: 0, stdout: 'repair complete', stderr: '', output_truncated: false },
      });
    }

    expect(calls).toEqual([
      {
        command: 'codex',
        args: ['exec', '--ephemeral', '--sandbox', 'workspace-write', '--color', 'never', '-'],
        input: 'Repair only the selected packet.',
      },
      {
        command: 'claude',
        args: ['--print', '--output-format', 'json', '--permission-mode', 'acceptEdits'],
        input: 'Repair only the selected packet.',
      },
      {
        command: 'copilot',
        args: [
          '-p',
          'Repair only the selected packet.',
          '-s',
          '--no-ask-user',
          '--allow-tool=write',
          '--deny-tool=shell',
          '--deny-tool=url',
          '--excluded-tools=web_fetch,web_search',
        ],
        input: null,
      },
    ]);
  });

  it('redacts secret-like output and returns cancellation as a structured failure', async () => {
    const redacted = await runAgentRepairBridge({
      agent: 'codex',
      cwd: '/isolated/worktree',
      prompt: 'Repair.',
      runner: async () => ({
        status: 0,
        stdout: 'token=top-secret-value api_key=second-secret sk-testsecret1234567890',
        stderr: 'Authorization: Bearer hidden-value',
      }),
    });
    expect(redacted.ok).toBe(true);
    if (!redacted.ok) return;
    expect(redacted.value.stdout).not.toContain('top-secret-value');
    expect(redacted.value.stdout).not.toContain('second-secret');
    expect(redacted.value.stderr).not.toContain('hidden-value');

    let called = false;
    const cancelled = await runAgentRepairBridge({
      agent: 'claude',
      cwd: '/isolated/worktree',
      prompt: 'Repair.',
      signal: AbortSignal.abort(),
      runner: async () => {
        called = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(called).toBe(false);
    expect(cancelled).toMatchObject({ ok: false, error: { code: 'INTERRUPTED' } });
  });
});
