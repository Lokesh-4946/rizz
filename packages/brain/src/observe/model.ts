import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../sensitivity.js';

export type HostId = 'cursor' | 'codex' | 'claude';

export type ObserveKind =
  | 'session_start'
  | 'prompt'
  | 'tool'
  | 'file'
  | 'usage'
  | 'stop'
  | 'decision'
  | 'message';

/** One normalized host event. The journal stores this JSON verbatim and never rewrites it. */
export interface ObserveEvent {
  readonly id: string;
  readonly at: string;
  readonly tool: HostId;
  readonly hook: string;
  readonly threadId: string;
  readonly projectRoot: string;
  readonly kind: ObserveKind;
  readonly text: string;
  readonly files: readonly string[];
  readonly fields: Readonly<Record<string, string>>;
}

export function isHostId(value: string): value is HostId {
  return value === 'cursor' || value === 'codex' || value === 'claude';
}

export function safeThreadId(tool: HostId, raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const body = cleaned === '' ? 'thread' : cleaned.slice(0, 72);
  return `${tool}-${body}`;
}

export function clip(text: string, max: number): string {
  const redacted = redactSensitiveText(text);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}…`;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const OWNER_MARK = 'owner decision:';

type QuoteMode = 'normal' | 'single' | 'double' | 'tick';

function isFenceDelimiter(line: string): boolean {
  return /^\s*```/.test(line);
}

/** A single quote starts a code span only when it is not an apostrophe in a word. */
function isSingleQuoteDelimiter(line: string, index: number, mode: QuoteMode): boolean {
  if (line[index] !== "'") return false;
  if (mode === 'single') return true;
  const previous = index === 0 ? '' : (line[index - 1] ?? '');
  return !/[A-Za-z0-9]/.test(previous);
}

/**
 * Explicit `Owner decision:` marks, at line start or later on the line (D-051).
 * The same words inside quotes, backticks, or a fenced code block are not decisions.
 */
export function ownerDecisionLines(text: string): string[] {
  const found: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const starts = ownerMarkEnds(line);
    for (let index = 0; index < starts.length; index += 1) {
      const from = starts[index] ?? 0;
      const next = starts[index + 1];
      const until = next === undefined ? line.length : next - OWNER_MARK.length;
      const decision = line.slice(from, until).trim();
      if (decision !== '') found.push(decision);
    }
  }
  return found;
}

function ownerMarkEnds(line: string): number[] {
  const starts: number[] = [];
  let mode: QuoteMode = 'normal';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';
    if (char === '\\' && mode !== 'normal') {
      index += 1;
      continue;
    }
    if (mode === 'normal') {
      if (char === '"') {
        mode = 'double';
        continue;
      }
      if (char === '`') {
        mode = 'tick';
        continue;
      }
      if (isSingleQuoteDelimiter(line, index, mode)) {
        mode = 'single';
        continue;
      }
      if (line.slice(index, index + OWNER_MARK.length).toLowerCase() === OWNER_MARK) {
        starts.push(index + OWNER_MARK.length);
        index += OWNER_MARK.length - 1;
      }
      continue;
    }
    if (mode === 'double' && char === '"') mode = 'normal';
    else if (mode === 'tick' && char === '`') mode = 'normal';
    else if (isSingleQuoteDelimiter(line, index, mode)) mode = 'normal';
  }
  return starts;
}

export function observeEventId(hook: string, payload: Record<string, unknown>): string {
  const thread =
    pickString(payload, ['conversation_id', 'session_id', 'thread_id', 'thread-id']) ?? 'none';
  const generation =
    pickString(payload, ['generation_id', 'turn_id', 'turn-id', 'tool_use_id']) ?? '';
  const name = pickString(payload, ['hook_event_name']) ?? hook;
  if (generation !== '') return `${thread}:${name}:${generation}`;
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  return `${thread}:${name}:${hash}`;
}

function kindFor(hook: string): ObserveKind {
  switch (hook) {
    case 'sessionStart':
    case 'SessionStart':
      return 'session_start';
    case 'beforeSubmitPrompt':
    case 'UserPromptSubmit':
    case 'afterAgentResponse':
      return 'prompt';
    case 'postToolUse':
    case 'PostToolUse':
    case 'afterShellExecution':
      return 'tool';
    case 'afterFileEdit':
      return 'file';
    case 'preCompact':
    case 'PreCompact':
      return 'usage';
    case 'stop':
    case 'Stop':
    case 'subagentStop':
    case 'SubagentStop':
    case 'sessionEnd':
    case 'SessionEnd':
    case 'notify':
      return 'stop';
    default:
      return 'tool';
  }
}

function usageFields(payload: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  const usage = payload.usage;
  const usageRecord =
    typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : payload;
  const input = numberField(usageRecord, 'input_tokens') ?? numberField(usageRecord, 'inputTokens');
  const output =
    numberField(usageRecord, 'output_tokens') ?? numberField(usageRecord, 'outputTokens');
  const cacheRead =
    numberField(usageRecord, 'cache_read_input_tokens') ??
    numberField(usageRecord, 'cached_input_tokens');
  const cacheWrite = numberField(usageRecord, 'cache_creation_input_tokens');
  if (input !== undefined || output !== undefined) {
    fields.reported = 'yes';
    fields.usageKind = 'turn';
    if (input !== undefined) fields.inputTokens = String(input);
    if (output !== undefined) fields.outputTokens = String(output);
    if (cacheRead !== undefined) fields.cacheRead = String(cacheRead);
    if (cacheWrite !== undefined) fields.cacheWrite = String(cacheWrite);
  }
  const context = numberField(payload, 'context_tokens');
  if (context !== undefined) {
    fields.usageKind = fields.usageKind ?? 'context';
    fields.contextTokens = String(context);
    fields.reported = fields.reported ?? 'no';
  }
  return fields;
}

function filesFrom(payload: Record<string, unknown>): string[] {
  const files = [...stringList(payload.modified_files), ...stringList(payload.files)];
  const filePath = pickString(payload, ['file_path']);
  if (filePath !== undefined) files.push(filePath);
  const toolInput = payload.tool_input;
  if (typeof toolInput === 'object' && toolInput !== null) {
    const input = toolInput as Record<string, unknown>;
    const nested = pickString(input, ['file_path', 'path', 'target_file']);
    if (nested !== undefined) files.push(nested);
  }
  return [...new Set(files)];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function shellCommand(payload: Record<string, unknown>): string | undefined {
  const direct = pickString(payload, ['command']);
  if (direct !== undefined) return direct;
  return pickString(recordOf(payload.tool_input) ?? {}, ['command']);
}

function exitCodeOf(payload: Record<string, unknown>): string | undefined {
  const sources = [payload, recordOf(payload.tool_output), recordOf(payload.tool_response)];
  for (const source of sources) {
    if (source === undefined) continue;
    for (const key of ['exit_code', 'exitCode', 'exit_status']) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }
  return undefined;
}

function shellOutput(payload: Record<string, unknown>): string {
  const chunks: string[] = [];
  for (const key of ['output', 'stdout', 'stderr', 'error_message']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') chunks.push(value);
  }
  for (const nested of [payload.tool_output, payload.tool_response]) {
    if (typeof nested === 'string' && nested.trim() !== '') chunks.push(nested);
    const record = recordOf(nested);
    if (record === undefined) continue;
    for (const key of ['output', 'stdout', 'stderr']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') chunks.push(value);
    }
  }
  return chunks.join('\n');
}

const FAILING_TEST = /\bFAIL(?:ED)?\b|\bnot ok\b|AssertionError|\bfailed\b|✕|✖|✗|×/i;

/** First output line that looks like a failing test. The journal stores this, not the full log. */
export function firstFailingTestLine(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (FAILING_TEST.test(trimmed)) return trimmed;
  }
  return undefined;
}

const CLOSED_TODO = new Set(['completed', 'complete', 'cancelled', 'canceled', 'done']);

function todoText(item: unknown): string | undefined {
  if (typeof item === 'string' && item.trim() !== '') return item.trim();
  const record = recordOf(item);
  if (record === undefined) return undefined;
  const content = pickString(record, ['content', 'text', 'title']);
  if (content === undefined) return undefined;
  const status = pickString(record, ['status'])?.toLowerCase();
  if (status !== undefined && CLOSED_TODO.has(status)) return undefined;
  return content;
}

export function openTodoTexts(payload: Record<string, unknown>): string[] {
  const lists = [payload.todos, recordOf(payload.tool_input)?.todos];
  const found: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const text = todoText(item);
      if (text !== undefined) found.push(text);
    }
  }
  return [...new Set(found)].slice(0, 20);
}

function textFrom(payload: Record<string, unknown>): string {
  const direct = pickString(payload, [
    'prompt',
    'text',
    'summary',
    'command',
    'last_assistant_message',
    'last-assistant-message',
    'error_message',
  ]);
  if (direct !== undefined) return direct;
  const messages = payload['input-messages'] ?? payload.input_messages;
  if (Array.isArray(messages)) {
    const parts = messages.filter((item): item is string => typeof item === 'string');
    if (parts.length > 0) return parts.join('\n');
  }
  const tool = pickString(payload, ['tool_name']);
  if (tool !== undefined) return tool;
  return '';
}

export function normalizeHook(options: {
  readonly tool: HostId;
  readonly hook: string;
  readonly payload: Record<string, unknown>;
  readonly projectRoot: string;
  readonly at: string;
}): ObserveEvent {
  const hook = options.hook;
  const payload = options.payload;
  const threadRaw =
    pickString(payload, ['conversation_id', 'session_id', 'thread_id', 'thread-id', 'sessionId']) ??
    'unknown';
  const toolName = pickString(payload, ['tool_name', 'subagent_type']);
  const command = shellCommand(payload);
  let text = clip(textFrom(payload), 1500);
  if (command !== undefined && (text === '' || text === toolName)) text = clip(command, 1500);
  const owners = ownerDecisionLines(text);
  const fields: Record<string, string> = {
    ...usageFields(payload),
  };
  const status = pickString(payload, ['status', 'reason', 'type']);
  if (status !== undefined) fields.status = status;
  if (toolName !== undefined) fields.toolName = toolName;
  if (command !== undefined) fields.command = clip(command, 300);
  const exitCode = exitCodeOf(payload);
  if (exitCode !== undefined) fields.exitCode = exitCode;
  const failing = firstFailingTestLine(shellOutput(payload));
  if (failing !== undefined) fields.failingTest = clip(failing, 200);
  const todos = openTodoTexts(payload);
  if (todos.length > 0) fields.openTodos = JSON.stringify(todos.map((item) => clip(item, 160)));
  if (owners.length > 0) {
    fields.ownerDecision = owners[0] ?? '';
    fields.ownerDecisions = JSON.stringify(owners);
  }
  const transcript = pickString(payload, ['transcript_path', 'agent_transcript_path']);
  if (transcript !== undefined) fields.transcriptPath = transcript;
  return {
    id: observeEventId(hook, payload),
    at: options.at,
    tool: options.tool,
    hook,
    threadId: safeThreadId(options.tool, threadRaw),
    projectRoot: options.projectRoot,
    kind: owners.length > 0 && kindFor(hook) === 'prompt' ? 'decision' : kindFor(hook),
    text,
    files: filesFrom(payload).slice(0, 20),
    fields,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
