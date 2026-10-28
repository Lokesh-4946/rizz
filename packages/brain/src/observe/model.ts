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
  | 'decision';

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

export function ownerDecisionLines(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^owner decision:\s*(.+)$/i.exec(line.trim());
    if (match?.[1] !== undefined && match[1].trim() !== '') found.push(match[1].trim());
  }
  return found;
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
  const text = clip(textFrom(payload), 1500);
  const owners = ownerDecisionLines(text);
  const fields: Record<string, string> = {
    ...usageFields(payload),
  };
  const status = pickString(payload, ['status', 'reason', 'type']);
  if (status !== undefined) fields.status = status;
  const toolName = pickString(payload, ['tool_name', 'subagent_type']);
  if (toolName !== undefined) fields.toolName = toolName;
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
