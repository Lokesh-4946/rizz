import type { DriftFinding } from './drift.js';
import type { ObserveEvent } from './model.js';

export interface HandoffDecision {
  readonly text: string;
  readonly supersedes?: string;
}

/** The structured note a worker leaves when a run ends. The next thread starts from this, not chat. */
export interface HandoffBody {
  readonly goal: string;
  readonly done: readonly string[];
  readonly open: readonly string[];
  readonly decisions: readonly HandoffDecision[];
  readonly files: readonly string[];
  readonly ownerDecisions: readonly string[];
}

export interface HandoffNote extends HandoffBody {
  readonly id: string;
  readonly workerId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly drift: readonly DriftFinding[];
  readonly createdAt: string;
  readonly incomplete: boolean;
}

export interface ParsedHandoff {
  readonly body: HandoffBody;
  readonly incomplete: boolean;
}

const HANDOFF_FENCE = /```(?:rizz-handoff|json[ \t]+rizz-handoff)[ \t]*\r?\n([\s\S]*?)```/gi;

const INCOMPLETE_OPEN = 'engine reply had no usable rizz-handoff block';

function emptyBody(open: readonly string[]): HandoffBody {
  return {
    goal: '',
    done: [],
    open,
    decisions: [],
    files: [],
    ownerDecisions: [],
  };
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    items.push(item);
  }
  return items;
}

function decisionList(value: unknown): readonly HandoffDecision[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: HandoffDecision[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.text !== 'string' || record.text.trim() === '') return undefined;
    if (record.supersedes !== undefined && typeof record.supersedes !== 'string') return undefined;
    const supersedes = typeof record.supersedes === 'string' ? record.supersedes.trim() : '';
    items.push(supersedes === '' ? { text: record.text } : { text: record.text, supersedes });
  }
  return items;
}

function bodyFromRecord(record: Record<string, unknown>): HandoffBody | undefined {
  if (typeof record.goal !== 'string') return undefined;
  const done = stringList(record.done);
  const open = stringList(record.open);
  const decisions = decisionList(record.decisions);
  const files = stringList(record.files);
  const ownerDecisions = stringList(record.ownerDecisions);
  if (
    done === undefined ||
    open === undefined ||
    decisions === undefined ||
    files === undefined ||
    ownerDecisions === undefined
  ) {
    return undefined;
  }
  return { goal: record.goal, done, open, decisions, files, ownerDecisions };
}

function lastFence(text: string): string | undefined {
  const matches = text.matchAll(HANDOFF_FENCE);
  let last: string | undefined;
  for (const match of matches) {
    last = match[1];
  }
  return last;
}

/** Pull the last ```rizz-handoff fence out of an engine reply. Missing or invalid JSON is incomplete. */
export function parseHandoffBlock(text: string): ParsedHandoff {
  const fenced = lastFence(text);
  if (fenced === undefined) {
    return { body: emptyBody([INCOMPLETE_OPEN]), incomplete: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced);
  } catch {
    return { body: emptyBody([INCOMPLETE_OPEN]), incomplete: true };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { body: emptyBody([INCOMPLETE_OPEN]), incomplete: true };
  }
  const body = bodyFromRecord(parsed as Record<string, unknown>);
  if (body === undefined) {
    return { body: emptyBody([INCOMPLETE_OPEN]), incomplete: true };
  }
  if (body.goal.trim() === '') {
    return { body, incomplete: true };
  }
  return { body, incomplete: false };
}

export function isHandoffId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

const FENCE_MARK = /```(?:rizz-handoff|json[ \t]+rizz-handoff)/i;

function uniqueStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function replyText(events: readonly ObserveEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.text !== '') parts.push(event.text);
  }
  return parts.join('\n\n');
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 180) return flat;
  return `${flat.slice(0, 180)}…`;
}

/** First non-empty line, so a next step does not repeat the whole prompt. */
function promptSummary(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return oneLine(trimmed);
  }
  return '';
}

function latestPrompt(events: readonly ObserveEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.kind === 'prompt' || event.kind === 'decision') return event.text;
  }
  return '';
}

function lastCommand(events: readonly ObserveEvent[]): ObserveEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.fields.command !== undefined && event.fields.command !== '') return event;
  }
  return undefined;
}

function actionLines(events: readonly ObserveEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.hook === 'recovery' || event.kind === 'session_start' || event.kind === 'usage') {
      continue;
    }
    const command = event.fields.command;
    if (command !== undefined && command !== '') {
      const safe = command.replaceAll('`', "'");
      const exit = event.fields.exitCode;
      const status = exit === undefined ? 'exit status was not reported' : `exit ${exit}`;
      lines.push(`ran \`${safe}\` (${status})`);
    }
    if (event.kind === 'prompt' || event.kind === 'decision') continue;
    for (const file of event.files) lines.push(`edited ${file}`);
  }
  return lines;
}

function checkboxTodos(text: string): string[] {
  const found: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const box = /^[-*]\s+\[\s\]\s+(.+)$/.exec(line.trim());
    if (box?.[1] !== undefined && box[1].trim() !== '') found.push(box[1].trim());
    const todo = /^TODO:\s+(.+)$/i.exec(line.trim());
    if (todo?.[1] !== undefined && todo[1].trim() !== '') found.push(todo[1].trim());
  }
  return found;
}

function todosFromEvents(events: readonly ObserveEvent[]): string[] {
  const found: string[] = [];
  for (const event of events) {
    const raw = event.fields.openTodos;
    if (raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string' && item.trim() !== '') found.push(item.trim());
          }
        }
      } catch {
        // A malformed todo field is skipped; the rest of the note still renders.
      }
    }
    found.push(...checkboxTodos(event.text));
  }
  return uniqueStrings(found);
}

function ownersFromEvents(events: readonly ObserveEvent[]): string[] {
  const found: string[] = [];
  for (const event of events) {
    const raw = event.fields.ownerDecisions;
    if (raw === undefined) {
      if (event.fields.ownerDecision !== undefined) found.push(event.fields.ownerDecision);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (typeof item === 'string') found.push(item);
      }
    } catch {
      if (event.fields.ownerDecision !== undefined) found.push(event.fields.ownerDecision);
    }
  }
  return found;
}

function finishedStatus(status: string): boolean {
  return status === 'completed' || status === 'complete' || status === 'success';
}

function nextStep(options: {
  readonly prompt: string;
  readonly failing: string | undefined;
  readonly todos: readonly string[];
  readonly killed: boolean;
  readonly status: string;
}): string {
  const prompt = promptSummary(options.prompt);
  const todo = options.todos[0];
  if (options.failing !== undefined && prompt !== '') {
    return `Finish "${prompt}" by fixing ${options.failing}`;
  }
  if (options.failing !== undefined) return `Fix the failing test: ${options.failing}`;
  if (todo !== undefined && prompt !== '') return `Finish "${prompt}" — ${todo}`;
  if (todo !== undefined) return `Next: ${todo}`;
  if (options.killed && prompt !== '') {
    return `Resume unfinished work from the last prompt: ${prompt}`;
  }
  if (options.killed) return 'Resume the session. No prompt was recorded.';
  if (prompt !== '' && finishedStatus(options.status)) {
    return `No unfinished work from the last prompt: ${prompt}`;
  }
  if (prompt !== '') return `Continue from the last prompt: ${prompt}`;
  return 'No unfinished work was recorded.';
}

function commandLines(event: ObserveEvent | undefined): string[] {
  if (event === undefined || event.fields.command === undefined || event.fields.command === '') {
    return ['## Last command', '', '- none recorded', ''];
  }
  const command = event.fields.command.replaceAll('`', "'");
  const exit = event.fields.exitCode;
  const status = exit === undefined ? 'exit status was not reported' : `exited ${exit}`;
  const lines = ['## Last command', '', `\`${command}\` ${status}`];
  if (event.fields.failingTest !== undefined && event.fields.failingTest !== '') {
    lines.push(event.fields.failingTest);
  }
  lines.push('');
  return lines;
}

/** Owner decisions carried in a usable rizz-handoff fence. An incomplete fence adds none. */
export function parsedOwnerDecisions(text: string): readonly string[] {
  const parsed = parseHandoffBlock(text);
  if (parsed.incomplete) return [];
  return parsed.body.ownerDecisions;
}

/** Markdown note for one thread. Calls {@link parseHandoffBlock} on the recorded reply text. */
export function renderHandoffNote(
  event: ObserveEvent,
  events: readonly ObserveEvent[],
  driftNotes: readonly string[],
): string {
  const mine = events.filter((item) => item.threadId === event.threadId);
  const reply = replyText(mine);
  const parsed = parseHandoffBlock(reply);
  const fence = FENCE_MARK.test(reply);
  const parsedBody = parsed.incomplete ? undefined : parsed.body;
  const prompt = latestPrompt(mine);
  const journalGoal =
    mine.find((item) => item.kind === 'prompt' || item.kind === 'decision')?.text ?? event.text;
  const goal =
    parsedBody !== undefined && parsedBody.goal.trim() !== '' ? parsedBody.goal : journalGoal;
  const done = uniqueStrings([
    ...actionLines(mine),
    ...(parsedBody === undefined ? [] : parsedBody.done),
  ]).slice(0, 16);
  const files = uniqueStrings([
    ...mine.flatMap((item) => item.files),
    ...(parsedBody === undefined ? [] : parsedBody.files),
  ]);
  const owners = uniqueStrings([
    ...ownersFromEvents(mine),
    ...(parsedBody === undefined ? [] : parsedBody.ownerDecisions),
  ]);
  let openFromFence: readonly string[] = [];
  if (parsedBody !== undefined) openFromFence = parsedBody.open;
  else if (fence) openFromFence = parsed.body.open;
  const todos = uniqueStrings([...todosFromEvents(mine), ...openFromFence]);
  const killed = event.fields.recovery === 'yes';
  const status = event.fields.status ?? 'stopped';
  const command = lastCommand(mine);
  const failing = command?.fields.failingTest;
  const lines = [
    `# Handoff ${event.threadId}`,
    '',
    `- thread: [[threads/${event.threadId}]]`,
    `- tool: ${event.tool}`,
    `- status: ${status}`,
  ];
  if (killed) lines.push('- recovery: session ended without a stop hook');
  lines.push(
    '',
    '## Goal',
    '',
    goal.trim() === '' ? 'No prompt was recorded.' : goal,
    '',
    '## Latest prompt',
    '',
    prompt.trim() === '' ? 'No prompt was recorded.' : prompt,
    '',
    '## Done',
    '',
    ...(done.length === 0 ? ['- none recorded'] : done.map((item) => `- ${item}`)),
    '',
    ...commandLines(command),
    '## Touched files',
    '',
    ...(files.length === 0 ? ['- none recorded'] : files.map((file) => `- ${file}`)),
    '',
    '## Open / Next',
    '',
    ...(todos.length === 0 ? ['- none open'] : todos.map((item) => `- ${item}`)),
    `- Next: ${nextStep({ prompt, failing, todos, killed, status })}`,
    '',
    '## Needs the owner',
    '',
    ...(owners.length === 0 ? ['- none'] : owners.map((item) => `- ${item}`)),
    '',
    '## Drift',
    '',
    ...(driftNotes.length === 0 ? ['- none'] : driftNotes.map((item) => `- ${item}`)),
    '',
  );
  return lines.join('\n');
}
