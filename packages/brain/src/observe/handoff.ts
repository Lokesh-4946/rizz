import type { DriftFinding } from './drift.js';

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
