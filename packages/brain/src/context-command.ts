import {
  compileTaskBrief,
  completeLoopWork,
  createLoopHandoff,
  readLoopStatus,
  recordLoopCheckpoint,
  startLoopWork,
} from './context-loop.js';

export interface ContextCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ParsedFlag {
  readonly value?: string;
  readonly rest: readonly string[];
  readonly missing: boolean;
}

function flag(args: readonly string[], name: string): ParsedFlag {
  const index = args.indexOf(name);
  if (index < 0) return { rest: args, missing: false };
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) return { rest: args, missing: true };
  return { value, rest: [...args.slice(0, index), ...args.slice(index + 2)], missing: false };
}

function repeatedFlag(
  args: readonly string[],
  name: string,
): { values: string[]; rest: string[]; missing: boolean } {
  const values: string[] = [];
  const rest: string[] = [];
  let missing = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      rest.push(args[index] ?? '');
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) missing = true;
    else {
      values.push(value);
      index += 1;
    }
  }
  return { values, rest, missing };
}

function failed(code: string, message: string): ContextCommandResult {
  return { exitCode: 2, stdout: '', stderr: `rizz: ${code}: ${message}\n` };
}

function rendered(value: unknown, json: boolean, summary: string): ContextCommandResult {
  return {
    exitCode: 0,
    stdout: json ? `${JSON.stringify(value)}\n` : `${summary}\n`,
    stderr: '',
  };
}

function resultError(result: {
  readonly error: { readonly code: string; readonly message: string };
}): ContextCommandResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: `rizz: ${result.error.code}: ${result.error.message}\n`,
  };
}

function sequenceFlag(args: readonly string[]): {
  value?: number;
  rest: readonly string[];
  invalid: boolean;
} {
  const parsed = flag(args, '--sequence');
  if (parsed.missing) return { rest: parsed.rest, invalid: true };
  if (parsed.value === undefined) return { rest: parsed.rest, invalid: false };
  const value = Number(parsed.value);
  return Number.isInteger(value) && value >= 0
    ? { value, rest: parsed.rest, invalid: false }
    : { rest: parsed.rest, invalid: true };
}

function nextLoopAction(status: string): string {
  switch (status) {
    case 'started':
      return 'plan';
    case 'planning':
      return 'implement';
    case 'implementing':
      return 'verify';
    case 'verifying':
      return 'review';
    case 'reviewing':
      return 'complete';
    default:
      return 'start';
  }
}

export async function executeContextCommand(options: {
  readonly rootDir: string;
  readonly args: readonly string[];
}): Promise<ContextCommandResult> {
  const wantsJson = options.args.includes('--json');
  const args = options.args.filter((arg) => arg !== '--json');
  if (args[0] === 'brief') {
    const task = args.slice(1).join(' ').trim();
    if (task === '') return failed('BRIEF_TASK_REQUIRED', 'Brief needs a task.');
    const result = await compileTaskBrief({ rootDir: options.rootDir, task });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2));
  }
  if (args[0] !== 'loop') return failed('CONTEXT_COMMAND_UNKNOWN', 'Expected brief or loop.');
  const action = args[1];
  const actionArgs = args.slice(2);
  if (action === 'status' || action === 'next') {
    if (actionArgs.length > 0)
      return failed('LOOP_OPTION_UNKNOWN', `Unknown option '${actionArgs[0]}'.`);
    const result = await readLoopStatus({ rootDir: options.rootDir });
    if (!result.ok) return resultError(result);
    const next = nextLoopAction(result.value.status);
    return rendered(
      action === 'next' ? { ...result.value, next } : result.value,
      wantsJson,
      action === 'next'
        ? `rizz loop next: ${next}`
        : `rizz loop ${result.value.status} at sequence ${result.value.sequence}`,
    );
  }
  if (action === 'start') {
    const task = flag(actionArgs, '--task');
    const agent = flag(task.rest, '--agent');
    const scopes = repeatedFlag(agent.rest, '--scope');
    if (task.missing || agent.missing || scopes.missing)
      return failed('LOOP_FLAG_VALUE_REQUIRED', 'Loop flags need values.');
    if (task.value === undefined || agent.value === undefined)
      return failed('LOOP_START_REQUIRED', 'Loop start needs --task and --agent.');
    if (scopes.rest.length > 0)
      return failed('LOOP_OPTION_UNKNOWN', `Unknown option '${scopes.rest[0]}'.`);
    const result = await startLoopWork({
      rootDir: options.rootDir,
      task: task.value,
      agent: agent.value,
      scope: scopes.values,
    });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, `rizz loop started ${result.value.work_id}`);
  }
  const summary = flag(actionArgs, '--summary');
  const sequence = sequenceFlag(summary.rest);
  if (summary.missing || sequence.invalid)
    return failed('LOOP_FLAG_VALUE_REQUIRED', 'Loop flags need valid values.');
  if (summary.value === undefined)
    return failed('LOOP_SUMMARY_REQUIRED', `Loop ${action ?? 'action'} needs --summary.`);
  if (action === 'handoff') {
    const next = flag(sequence.rest, '--next-baton');
    if (next.missing || next.value === undefined)
      return failed('LOOP_HANDOFF_REQUIRED', 'Loop handoff needs --next-baton.');
    if (next.rest.length > 0)
      return failed('LOOP_OPTION_UNKNOWN', `Unknown option '${next.rest[0]}'.`);
    const result = await createLoopHandoff({
      rootDir: options.rootDir,
      summary: summary.value,
      nextBaton: next.value,
      ...(sequence.value === undefined ? {} : { expectedSequence: sequence.value }),
    });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, `rizz loop handoff ${result.value.handoff_path}`);
  }
  if (sequence.rest.length > 0)
    return failed('LOOP_OPTION_UNKNOWN', `Unknown option '${sequence.rest[0]}'.`);
  if (action === 'complete') {
    const result = await completeLoopWork({
      rootDir: options.rootDir,
      summary: summary.value,
      ...(sequence.value === undefined ? {} : { expectedSequence: sequence.value }),
    });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, `rizz loop completed ${result.value.work_id}`);
  }
  const statuses = {
    checkpoint: 'implementing',
    verify: 'verifying',
    review: 'reviewing',
  } as const;
  if (action !== 'checkpoint' && action !== 'verify' && action !== 'review') {
    return failed('LOOP_ACTION_UNKNOWN', `Unknown loop action '${action ?? ''}'.`);
  }
  const result = await recordLoopCheckpoint({
    rootDir: options.rootDir,
    summary: summary.value,
    status: statuses[action],
    ...(sequence.value === undefined ? {} : { expectedSequence: sequence.value }),
  });
  if (!result.ok) return resultError(result);
  return rendered(
    result.value,
    wantsJson,
    `rizz loop ${result.value.status} at sequence ${result.value.sequence}`,
  );
}
