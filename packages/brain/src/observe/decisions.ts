import { type StaffResult, staffErr, staffOk } from './result.js';

export type DecisionSource = 'owner' | 'worker' | 'observed';

/** One append-only decisions-log row. Status is derived: a later row can supersede this id. */
export interface DecisionRecord {
  readonly id: string;
  readonly text: string;
  readonly source: DecisionSource;
  readonly createdAt: string;
  readonly workerId?: string;
  readonly supersedes?: string;
}

function isSource(value: unknown): value is DecisionSource {
  return value === 'owner' || value === 'worker' || value === 'observed';
}

function parseLine(line: string, lineNumber: number): StaffResult<DecisionRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return staffErr('INVALID_STATE', `decisions log line ${lineNumber} is not JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return staffErr('INVALID_STATE', `decisions log line ${lineNumber} is not a record`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    return staffErr('INVALID_STATE', `decisions log line ${lineNumber} is missing an id`);
  }
  if (typeof record.text !== 'string' || record.text.trim() === '') {
    return staffErr('INVALID_STATE', `decisions log line ${lineNumber} is missing text`);
  }
  if (!isSource(record.source)) {
    return staffErr('INVALID_STATE', `decisions log line ${lineNumber} has an unknown source`);
  }
  if (typeof record.createdAt !== 'string' || record.createdAt.trim() === '') {
    return staffErr('INVALID_STATE', `decisions log line ${lineNumber} is missing createdAt`);
  }
  if (record.workerId !== undefined && typeof record.workerId !== 'string') {
    return staffErr('INVALID_STATE', `decisions log line ${lineNumber} has a bad workerId`);
  }
  if (record.supersedes !== undefined && typeof record.supersedes !== 'string') {
    return staffErr('INVALID_STATE', `decisions log line ${lineNumber} has a bad supersedes id`);
  }
  return staffOk({
    id: record.id,
    text: record.text,
    source: record.source,
    createdAt: record.createdAt,
    ...(typeof record.workerId === 'string' ? { workerId: record.workerId } : {}),
    ...(typeof record.supersedes === 'string' && record.supersedes !== ''
      ? { supersedes: record.supersedes }
      : {}),
  });
}

export function parseDecisions(raw: string): StaffResult<readonly DecisionRecord[]> {
  const records: DecisionRecord[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    const parsed = parseLine(line, index + 1);
    if (!parsed.ok) return parsed;
    records.push(parsed.value);
  }
  return staffOk(records);
}

export function serializeDecisions(records: readonly DecisionRecord[]): string {
  if (records.length === 0) return '';
  const lines = records.map((record) => {
    const payload: Record<string, string> = {
      id: record.id,
      text: record.text,
      source: record.source,
      createdAt: record.createdAt,
    };
    if (record.workerId !== undefined) payload.workerId = record.workerId;
    if (record.supersedes !== undefined) payload.supersedes = record.supersedes;
    return JSON.stringify(payload);
  });
  return `${lines.join('\n')}\n`;
}

/** A decision is active until a later row names it in `supersedes`. */
export function activeDecisions(records: readonly DecisionRecord[]): readonly DecisionRecord[] {
  const superseded = new Set<string>();
  for (const record of records) {
    if (record.supersedes !== undefined) superseded.add(record.supersedes);
  }
  return records.filter((record) => !superseded.has(record.id));
}
