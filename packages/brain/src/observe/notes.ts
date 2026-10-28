import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { InboxItem } from './brain-index.js';
import { type DecisionRecord, activeDecisions, parseDecisions } from './decisions.js';
import { checkDrift } from './drift.js';
import { appendSynced, readText, writeAtomic } from './io.js';
import { loadJournal } from './journal.js';
import type { ObserveEvent } from './model.js';
import type { ObservePaths } from './paths.js';
import { type StaffResult, staffErr, staffOk } from './result.js';
import { VISION_TEMPLATE } from './vision.js';

const THREAD_LOG = '<!-- rizz:thread-log:start -->\n';

export async function ensureObserveVault(paths: ObservePaths): Promise<StaffResult<void>> {
  const vision = await readText(paths.vision);
  if (!vision.ok) return vision;
  if (vision.value === undefined) {
    const created = await writeAtomic(paths.vision, VISION_TEMPLATE);
    if (!created.ok) return created;
  }
  const decisions = await readText(paths.decisions);
  if (!decisions.ok) return decisions;
  if (decisions.value === undefined) {
    const created = await writeAtomic(
      paths.decisions,
      '# Decisions\n\nA later entry can supersede an earlier id. Rizz does not rewrite old entries.\n\n',
    );
    if (!created.ok) return created;
  }
  return staffOk(undefined);
}

export async function readDecisionRecords(
  path: string,
): Promise<StaffResult<readonly DecisionRecord[]>> {
  const text = await readText(path);
  if (!text.ok) return text;
  const lines: string[] = [];
  for (const line of (text.value ?? '').split('\n')) {
    const marker = line.indexOf('%%rizz:decision%%');
    if (marker !== -1) lines.push(line.slice(marker + '%%rizz:decision%%'.length));
    else if (line.startsWith('{')) lines.push(line);
  }
  return parseDecisions(lines.join('\n'));
}

export async function appendDecisionRecord(
  path: string,
  record: DecisionRecord,
): Promise<StaffResult<readonly DecisionRecord[]>> {
  const current = await readDecisionRecords(path);
  if (!current.ok) return current;
  if (
    record.supersedes !== undefined &&
    !current.value.some((item) => item.id === record.supersedes)
  ) {
    return staffErr('BAD_REQUEST', `unknown decision ${record.supersedes}`);
  }
  if (current.value.some((item) => item.id === record.id)) return staffOk(current.value);
  const header =
    current.value.length === 0
      ? '# Decisions\n\nA later entry can supersede an earlier id. Rizz does not rewrite old entries.\n\n'
      : '';
  const prior = await readText(path);
  if (!prior.ok) return prior;
  const base = prior.value ?? header;
  const payload: Record<string, string> = {
    id: record.id,
    text: record.text,
    source: record.source,
    createdAt: record.createdAt,
  };
  if (record.workerId !== undefined) payload.workerId = record.workerId;
  if (record.supersedes !== undefined) payload.supersedes = record.supersedes;
  const human = `## ${record.id} · ${record.createdAt} · ${record.source}${
    record.supersedes === undefined ? '' : ` · supersedes ${record.supersedes}`
  }\n\n${record.text}\n\n%%rizz:decision%%${JSON.stringify(payload)}\n\n`;
  if (base === '') {
    const created = await writeAtomic(path, `${header}${human}`);
    if (!created.ok) return created;
  } else {
    const appended = await appendSynced(path, human);
    if (!appended.ok) return appended;
  }
  return staffOk([...current.value, record]);
}

function threadHead(events: readonly ObserveEvent[], threadId: string): string {
  const mine = events.filter((event) => event.threadId === threadId);
  const latest = mine.at(-1);
  const status = latest?.kind === 'stop' ? (latest.fields.status ?? 'stopped') : 'active';
  const prompts = mine.filter(
    (event) => event.kind === 'prompt' || event.kind === 'decision',
  ).length;
  const tools = mine.filter((event) => event.kind === 'tool').length;
  return `# Thread ${threadId}\n\n<!-- rizz:thread-head:start -->\nstatus: ${status}\nprompts: ${prompts}\ntools: ${tools}\n<!-- rizz:thread-head:end -->\n${THREAD_LOG}`;
}

export async function appendThreadEntry(
  threadsDir: string,
  event: ObserveEvent,
  events: readonly ObserveEvent[],
): Promise<StaffResult<void>> {
  const path = join(threadsDir, `${event.threadId}.md`);
  const existing = await readText(path);
  if (!existing.ok) return existing;
  const marker = `<!-- rizz:event:${event.id} -->`;
  const prior = existing.value;
  if (prior?.includes(marker) === true) return staffOk(undefined);
  const body = event.text === '' ? event.kind : event.text;
  const entry = `${marker}\n### ${event.at} · ${event.hook}\n\n${body}\n\n`;
  const head = threadHead(events, event.threadId);
  if (prior === undefined) {
    return writeAtomic(path, `${head}${entry}`);
  }
  const markerAt = prior.indexOf(THREAD_LOG);
  const log = markerAt === -1 ? '' : prior.slice(markerAt + THREAD_LOG.length);
  return writeAtomic(path, `${head}${log}${entry}`);
}

export async function writeHandoff(
  handoffsDir: string,
  event: ObserveEvent,
  events: readonly ObserveEvent[],
  driftNotes: readonly string[],
): Promise<StaffResult<string>> {
  const path = join(handoffsDir, `${event.id.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80)}.md`);
  const existing = await readText(path);
  if (!existing.ok) return existing;
  if (existing.value !== undefined) return staffOk(path);
  const mine = events.filter((item) => item.threadId === event.threadId);
  const goal =
    mine.find((item) => item.kind === 'prompt' || item.kind === 'decision')?.text ?? event.text;
  const files = [...new Set(mine.flatMap((item) => item.files))];
  const owners = mine.flatMap((item) => {
    const raw = item.fields.ownerDecisions;
    if (raw === undefined)
      return item.fields.ownerDecision === undefined ? [] : [item.fields.ownerDecision];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } catch {
      return [];
    }
  });
  const done = mine
    .filter((item) => item.kind === 'tool' || item.kind === 'file')
    .slice(-8)
    .map((item) => item.text || item.hook);
  const lines = [
    `# Handoff ${event.threadId}`,
    '',
    `- thread: [[threads/${event.threadId}]]`,
    `- tool: ${event.tool}`,
    `- status: ${event.fields.status ?? 'stopped'}`,
    '',
    '## Goal',
    '',
    goal || 'No prompt was recorded.',
    '',
    '## Done',
    '',
    ...(done.length === 0 ? ['- none recorded'] : done.map((item) => `- ${item}`)),
    '',
    '## Files',
    '',
    ...(files.length === 0 ? ['- none recorded'] : files.map((file) => `- ${file}`)),
    '',
    '## Needs the owner',
    '',
    ...(owners.length === 0 ? ['- none'] : owners.map((item) => `- ${item}`)),
    '',
    '## Drift',
    '',
    ...(driftNotes.length === 0 ? ['- none'] : driftNotes.map((item) => `- ${item}`)),
    '',
  ];
  const written = await writeAtomic(path, lines.join('\n'));
  if (!written.ok) return written;
  return staffOk(path);
}

export function inboxId(threadId: string, text: string): string {
  return createHash('sha256').update(`${threadId}\0${text}`).digest('hex').slice(0, 16);
}

export function inboxDecisionId(inboxItemId: string): string {
  return `dec_${inboxItemId}`;
}

export function isInboxAnswered(
  inboxItemId: string,
  decisions: readonly { readonly id: string }[],
): boolean {
  return decisions.some((record) => record.id === inboxDecisionId(inboxItemId));
}

export async function writeInboxItem(
  inboxDir: string,
  item: InboxItem,
): Promise<StaffResult<void>> {
  const path = join(inboxDir, `${item.id}.md`);
  const existing = await readText(path);
  if (!existing.ok) return existing;
  if (existing.value !== undefined) return staffOk(undefined);
  return writeAtomic(
    path,
    `# ${item.text}\n\n- thread: [[threads/${item.threadId}]]\n- id: ${item.id}\n`,
  );
}

export async function listInbox(inboxDir: string): Promise<StaffResult<readonly InboxItem[]>> {
  let names: string[] = [];
  try {
    names = (await readdir(inboxDir)).filter((name) => name.endsWith('.md')).sort();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (code === 'ENOENT') return staffOk([]);
    return staffErr('IO_FAILED', `cannot list ${inboxDir}`);
  }
  const items: InboxItem[] = [];
  for (const name of names) {
    const text = await readText(join(inboxDir, name));
    if (!text.ok) return text;
    const body = text.value ?? '';
    const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? name;
    const thread = /\[\[threads\/([^\]]+)\]\]/.exec(body)?.[1] ?? 'unknown';
    items.push({ id: name.replace(/\.md$/, ''), text: title, threadId: thread });
  }
  return staffOk(items);
}

export async function driftNotesFor(
  visionPath: string,
  events: readonly ObserveEvent[],
): Promise<StaffResult<readonly string[]>> {
  const vision = await readText(visionPath);
  if (!vision.ok) return vision;
  const text = events.map((event) => event.text).join('\n');
  const findings = checkDrift({
    visionText: vision.value ?? '',
    decisions: [],
    text,
  });
  return staffOk(
    findings.filter((finding) => finding.severity === 'block').map((finding) => finding.message),
  );
}

export async function eventsForThread(
  journalDir: string,
  threadId: string,
): Promise<StaffResult<readonly ObserveEvent[]>> {
  const loaded = await loadJournal(journalDir);
  if (!loaded.ok) return loaded;
  return staffOk(loaded.value.filter((event) => event.threadId === threadId));
}

export { activeDecisions };
