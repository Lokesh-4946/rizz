import { execFile } from 'node:child_process';
import type { RepairHandoffAgent } from './agent-repair-handoff.js';

const MAX_OUTPUT_BYTES = 65_536;
const MAX_PROMPT_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 1_200_000;
const ENV_KEYS =
  'PATH HOME USERPROFILE XDG_CONFIG_HOME CODEX_HOME CLAUDE_CONFIG_DIR TERM TMPDIR TEMP TMP SystemRoot WINDIR COMSPEC'.split(
    ' ',
  );

export interface AgentRepairBridgeProcess {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output_truncated: boolean;
}

export type AgentRepairExecutorResult =
  | { readonly ok: true; readonly value: AgentRepairBridgeProcess }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface AgentRepairExecutorInput {
  readonly agent: RepairHandoffAgent;
  readonly cwd: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export type AgentRepairExecutor = (
  options: AgentRepairExecutorInput,
) => Promise<AgentRepairExecutorResult>;

interface RunnerOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input: string | null;
  readonly signal?: AbortSignal;
}

interface RunnerResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error_code?: string;
}

export type AgentRepairBridgeRunner = (
  command: string,
  args: readonly string[],
  options: RunnerOptions,
) => Promise<RunnerResult>;

function failure(code: string, message: string): AgentRepairExecutorResult {
  return { ok: false, error: { code, message } };
}

function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ENV_KEYS.flatMap((key) => (environment[key] === undefined ? [] : [[key, environment[key]]])),
  );
}

function invocation(
  agent: RepairHandoffAgent,
  prompt: string,
): {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string | null;
} {
  if (agent === 'codex') {
    return {
      command: 'codex',
      args: ['exec', '--ephemeral', '--sandbox', 'workspace-write', '--color', 'never', '-'],
      input: prompt,
    };
  }
  if (agent === 'claude') {
    return {
      command: 'claude',
      args: ['--print', '--output-format', 'json', '--permission-mode', 'acceptEdits'],
      input: prompt,
    };
  }
  return {
    command: 'copilot',
    args: [
      '-p',
      prompt,
      '-s',
      '--no-ask-user',
      '--allow-tool=write',
      '--deny-tool=shell',
      '--deny-tool=url',
      '--excluded-tools=web_fetch,web_search',
    ],
    input: null,
  };
}

function exitStatus(error: Error | null, code: string | number | undefined): number | null {
  if (typeof code === 'number') {
    return code;
  }
  if (error === null) {
    return 0;
  }
  return null;
}

function defaultRunner(
  command: string,
  args: readonly string[],
  options: RunnerOptions,
): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 1024 * 1024,
        timeout: DEFAULT_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          status: exitStatus(error, code),
          stdout: String(stdout),
          stderr: String(stderr),
          ...(typeof code === 'string' ? { error_code: code } : {}),
        });
      },
    );
    child.stdin?.end(options.input ?? undefined);
  });
}

function redact(text: string): string {
  return text
    .replace(/\b(?:sk|sess|tok|pat)-[A-Za-z0-9._-]{12,}\b/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '[redacted]')
    .replace(/\b(api[_-]?key)\s*[:=]\s*["']?[^"',\s]+/gi, '$1=[redacted]')
    .replace(/\b((?:access|refresh|id)_?token|token)\s*[:=]\s*["']?[^"',\s]+/gi, '$1=[redacted]')
    .replace(/\bauthorization\s*:\s*(?:bearer\s+)?[^ \t\r\n"',]+/gi, 'Authorization: [redacted]')
    .replace(/\bbearer\s+[^ \t\r\n"',]+/gi, 'Bearer [redacted]');
}

function bounded(text: string): { readonly value: string; readonly truncated: boolean } {
  const bytes = Buffer.from(redact(text));
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) {
    return { value: bytes.toString('utf8'), truncated: false };
  }
  return {
    value: `${bytes.subarray(0, MAX_OUTPUT_BYTES).toString('utf8')}\n[output truncated]`,
    truncated: true,
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function runAgentRepairBridge(
  options: AgentRepairExecutorInput & { readonly runner?: AgentRepairBridgeRunner },
): Promise<AgentRepairExecutorResult> {
  if (isAborted(options.signal)) {
    return failure('INTERRUPTED', 'Agent repair was interrupted before the bridge started.');
  }
  if (Buffer.byteLength(options.prompt) > MAX_PROMPT_BYTES) {
    return failure(
      'REPAIR_BRIDGE_INPUT_LIMIT',
      `Agent repair prompt exceeds ${MAX_PROMPT_BYTES} bytes.`,
    );
  }
  const planned = invocation(options.agent, options.prompt);
  let processResult: RunnerResult;
  try {
    processResult = await (options.runner ?? defaultRunner)(planned.command, planned.args, {
      cwd: options.cwd,
      env: childEnvironment(process.env),
      input: planned.input,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error: unknown) {
    return failure(
      'REPAIR_BRIDGE_UNAVAILABLE',
      redact(error instanceof Error ? error.message : String(error)),
    );
  }
  if (isAborted(options.signal) || processResult.error_code === 'ABORT_ERR') {
    return failure('INTERRUPTED', 'Agent repair was interrupted.');
  }
  if (processResult.status === null) {
    return failure(
      'REPAIR_BRIDGE_UNAVAILABLE',
      `Could not run the ${options.agent} repair bridge (${processResult.error_code ?? 'spawn failed'}).`,
    );
  }
  const stdout = bounded(processResult.stdout);
  const stderr = bounded(processResult.stderr);
  return {
    ok: true,
    value: {
      exit_code: processResult.status,
      stdout: stdout.value,
      stderr: stderr.value,
      output_truncated: stdout.truncated || stderr.truncated,
    },
  };
}
