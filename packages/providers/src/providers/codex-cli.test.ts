import { describe, expect, it } from 'vitest';
import { createCodexCliProvider } from './codex-cli.js';

describe('createCodexCliProvider', () => {
  it('runs codex exec with a safe ephemeral read-only invocation', async () => {
    let seenArgs: readonly string[] = [];
    let seenInput = '';
    let sawProviderSecret = false;
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    try {
      const provider = createCodexCliProvider({
        command: 'codex-test',
        runner: async (
          _command: string,
          args: readonly string[],
          options: { readonly env: NodeJS.ProcessEnv; readonly input: string },
        ) => {
          seenArgs = args;
          seenInput = options.input;
          sawProviderSecret = options.env.ANTHROPIC_API_KEY !== undefined;
          return { status: 0, stdout: 'hello from codex', stderr: '' };
        },
      });

      const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.content).toBe('hello from codex');
      expect(seenArgs).toContain('exec');
      expect(seenArgs).toContain('--ephemeral');
      expect(seenArgs).toContain('--sandbox');
      expect(seenArgs).toContain('read-only');
      expect(seenArgs).toContain('--ignore-user-config');
      expect(seenArgs).toContain('--ignore-rules');
      expect(seenInput).toContain('Latest:\nhi');
      expect(seenInput).toContain('for greetings, greet back');
      expect(sawProviderSecret).toBe(false);
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });

  it('maps auth-looking failures to PROVIDER_AUTH without leaking raw tokens', async () => {
    const provider = createCodexCliProvider({
      runner: async () => ({
        status: 1,
        stdout: '',
        stderr:
          'please login with token sk-secret-value access_token=tok-secret eyJabc.defghijklmnopqrstuvwxyz',
      }),
    });

    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROVIDER_AUTH');
      expect(result.error.message).toContain('please login');
      expect(result.error.message).not.toContain('sk-secret-value');
      expect(result.error.message).not.toContain('tok-secret');
      expect(result.error.message).not.toContain('eyJabc');
    }
  });

  it('returns INTERRUPTED when the signal is already aborted', async () => {
    const provider = createCodexCliProvider({
      runner: async () => {
        throw new Error('runner should not be called');
      },
    });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      signal: AbortSignal.abort(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERRUPTED');
  });
});
