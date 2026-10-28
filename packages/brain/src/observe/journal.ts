import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { appendSynced, readText, writeAtomic } from './io.js';
import { type ObserveEvent, isRecord } from './model.js';
import { type StaffResult, staffErr, staffOk } from './result.js';

const EVENT_PREFIX = '%%rizz:event%%';

export function journalMonth(at: string): string {
  return /^\d{4}-\d{2}/.test(at) ? at.slice(0, 7) : 'unknown';
}

function humanEntry(event: ObserveEvent): string {
  const files = event.files.length === 0 ? '' : ` · files: ${event.files.join(', ')}`;
  const status = event.fields.status === undefined ? '' : `(${event.fields.status})`;
  const body = event.text === '' ? '' : `\n\n${event.text}\n`;
  return `### ${event.at} · ${event.tool} · ${event.threadId} · ${event.hook}${status}${files}\n- [[threads/${event.threadId}]]${body}\n`;
}

export function eventChunk(event: ObserveEvent): string {
  return `${EVENT_PREFIX}${JSON.stringify(event)}\n${humanEntry(event)}`;
}

export function parseEventLine(line: string): ObserveEvent | undefined {
  if (!line.startsWith(EVENT_PREFIX)) return undefined;
  try {
    const parsed: unknown = JSON.parse(line.slice(EVENT_PREFIX.length));
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.id !== 'string' || typeof parsed.at !== 'string') return undefined;
    if (typeof parsed.tool !== 'string' || typeof parsed.hook !== 'string') return undefined;
    if (typeof parsed.threadId !== 'string' || typeof parsed.projectRoot !== 'string') {
      return undefined;
    }
    if (typeof parsed.kind !== 'string' || typeof parsed.text !== 'string') return undefined;
    if (!Array.isArray(parsed.files)) return undefined;
    if (!isRecord(parsed.fields)) return undefined;
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.fields)) {
      if (typeof value === 'string') fields[key] = value;
    }
    return {
      id: parsed.id,
      at: parsed.at,
      tool: parsed.tool as ObserveEvent['tool'],
      hook: parsed.hook,
      threadId: parsed.threadId,
      projectRoot: parsed.projectRoot,
      kind: parsed.kind as ObserveEvent['kind'],
      text: parsed.text,
      files: parsed.files.filter((item): item is string => typeof item === 'string'),
      fields,
    };
  } catch {
    return undefined;
  }
}

export function eventsIn(markdown: string): ObserveEvent[] {
  const events: ObserveEvent[] = [];
  for (const line of markdown.split('\n')) {
    const event = parseEventLine(line);
    if (event !== undefined) events.push(event);
  }
  return events;
}

export async function appendJournalEvent(
  journalDir: string,
  event: ObserveEvent,
): Promise<StaffResult<'appended' | 'duplicate'>> {
  const path = join(journalDir, `${journalMonth(event.at)}.md`);
  const existing = await readText(path);
  if (!existing.ok) return existing;
  const prior = existing.value ?? '';
  if (eventsIn(prior).some((item) => item.id === event.id)) return staffOk('duplicate');
  const chunk = eventChunk(event);
  if (prior === '') {
    const created = await writeAtomic(path, `# Journal ${journalMonth(event.at)}\n\n${chunk}`);
    if (!created.ok) return created;
    return staffOk('appended');
  }
  const appended = await appendSynced(path, chunk);
  if (!appended.ok) return appended;
  return staffOk('appended');
}

export async function loadJournal(
  journalDir: string,
): Promise<StaffResult<readonly ObserveEvent[]>> {
  let names: string[] = [];
  try {
    names = (await readdir(journalDir)).filter((name) => name.endsWith('.md')).sort();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (code === 'ENOENT') return staffOk([]);
    return staffErr('IO_FAILED', `cannot list ${journalDir}`);
  }
  const events: ObserveEvent[] = [];
  for (const name of names) {
    const text = await readText(join(journalDir, name));
    if (!text.ok) return text;
    events.push(...eventsIn(text.value ?? ''));
  }
  return staffOk(events);
}
