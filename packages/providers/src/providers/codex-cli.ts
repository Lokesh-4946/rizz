import { execFile } from 'node:child_process';
import type { CompletionRequest, CompletionResult, Message, Provider } from '../provider.js';
import { type Result, RizzError, err, ok } from '../result.js';
import { estimateMessagesTokens, estimateTokens } from '../tokens.js';

type RunOptions = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input: string;
  readonly signal?: AbortSignal;
};

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type CodexCliRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<RunResult>;

const EXEC_ARGS = [
  'exec',
  '--ephemeral',
  '--sandbox',
  'read-only',
  '--color',
  'never',
  '--ignore-user-config',
  '--ignore-rules',
  '--skip-git-repo-check',
  '-',
] as const;

const ENV_KEYS =
  'PATH HOME USERPROFILE CODEX_HOME TERM TMPDIR TEMP TMP SystemRoot WINDIR COMSPEC'.split(' ');

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
}

function run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 1024 * 1024,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          status: typeof code === 'number' ? code : error === null ? 0 : null,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );

    child.stdin?.end(options.input);
  });
}

function detail(text: string): string {
  const escapeChar = String.fromCharCode(27);
  const cleaned = text
    .replace(/\s*--ephemeral\b/g, '')
    .replace(/\s*--ignore-user-config\b/g, '')
    .replace(/\s*--ignore-rules\b/g, '')
    .replace(/\s*--skip-git-repo-check\b/g, '')
    .replace(/\s*--sandbox\s+(?:read-only|workspace-write|danger-full-access)\b/g, '')
    .replace(/\s*--color\s+never\b/g, '')
    .replace(/\bst(?:d|din)\s+prompt\b/gi, '')
    .replace(/\bno auth-file access\b/gi, '')
    .replace(new RegExp(`${escapeChar}\\[[0-9;]*m`, 'g'), '')
    .replace(/\b(?:sk|sess|tok|pat)-[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '[redacted]')
    .replace(/\b((?:access|refresh|id)_token)\s*[:=]\s*["']?[^"',\s]+/gi, '$1=[redacted]')
    .replace(/\b(?:authorization|token|bearer)\s*[:= ]\s*["']?[^"',\s]+/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= 400 ? cleaned : `${cleaned.slice(0, 400)}...`;
}

function prompt(messages: readonly Message[]): string {
  const transcript = messages.map((message) => `${message.role}: ${message.content}`).join('\n\n');
  return `You are rizz. Be useful; for greetings, greet back and ask what to work on. Don't claim file edits unless Codex made them.
Latest:
${messages.at(-1)?.content ?? ''}
Transcript:
${transcript}`;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createCodexCliProvider(
  options: {
    readonly command?: string;
    readonly cwd?: string;
    readonly runner?: unknown;
  } = {},
): Provider {
  const command = options.command ?? 'codex';
  const cwd = options.cwd ?? process.cwd();
  const runner = typeof options.runner === 'function' ? (options.runner as CodexCliRunner) : run;

  async function complete(request: CompletionRequest): Promise<Result<CompletionResult>> {
    if (isAborted(request.signal)) {
      return err(new RizzError('INTERRUPTED', 'turn interrupted before Codex was called'));
    }

    try {
      const result = await runner(command, EXEC_ARGS, {
        cwd,
        env: childEnv(process.env),
        input: prompt(request.messages),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      if (isAborted(request.signal)) return err(new RizzError('INTERRUPTED', 'turn interrupted'));
      if (result.status !== 0) {
        const message = detail(result.stderr || result.stdout);
        const code = /login|auth|sign in|credential/i.test(message)
          ? 'PROVIDER_AUTH'
          : 'PROVIDER_UNAVAILABLE';
        return err(
          new RizzError(code, message === '' ? 'Codex CLI failed' : `Codex CLI failed: ${message}`),
        );
      }

      const content = result.stdout.trim();
      if (content === '')
        return err(new RizzError('PROVIDER_UNAVAILABLE', 'Codex returned an empty response'));
      request.onChunk?.(content);
      return ok({
        content,
        inputTokens: estimateMessagesTokens(request.messages),
        outputTokens: estimateTokens(content),
      });
    } catch (cause) {
      if (isAborted(request.signal)) return err(new RizzError('INTERRUPTED', 'turn interrupted'));
      const suffix = cause instanceof Error ? `: ${detail(cause.message)}` : '';
      return err(new RizzError('PROVIDER_UNAVAILABLE', `could not run Codex${suffix}`, { cause }));
    }
  }

  return { id: 'codex', label: 'Codex', complete };
}
