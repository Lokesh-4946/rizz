import { createHash } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareProjectStore } from '../project-store.js';
import { type InboxItem, snapshotFromEvents, visionQuote, writeBrain } from './brain-index.js';
import { appendSynced, nextAppendOffset, readText, withLock, writeAtomic } from './io.js';
import { appendJournalEvent, loadJournal } from './journal.js';
import { appendTokenRow, rowFromEvent } from './ledger.js';
import { type ObserveEvent, committedOwnerDecisions, isRecord } from './model.js';
import {
  appendThreadEntry,
  driftNotesFor,
  ensureObserveVault,
  inboxId,
  isInboxAnswered,
  listInbox,
  readDecisionRecords,
  writeHandoff,
  writeInboxItem,
} from './notes.js';
import {
  observePaths,
  spoolDropDir,
  spoolFile,
  spoolLock,
  spoolOffsetFile,
  spoolPendingDir,
} from './paths.js';
import { type StaffResult, staffErr, staffOk } from './result.js';

export interface FoldResult {
  readonly applied: number;
  readonly duplicates: number;
  readonly projects: readonly string[];
}

async function readOffset(path: string): Promise<StaffResult<number>> {
  const text = await readText(path);
  if (!text.ok) return text;
  if (text.value === undefined || text.value.trim() === '') return staffOk(0);
  try {
    const parsed: unknown = JSON.parse(text.value);
    if (
      isRecord(parsed) &&
      typeof parsed.offset === 'number' &&
      Number.isFinite(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return staffOk(parsed.offset);
    }
  } catch {
    // A kill mid-write leaves a partial offset. Replay; journal ids are idempotent.
    return staffOk(0);
  }
  return staffOk(0);
}

async function applyEvent(
  rizzHome: string,
  event: ObserveEvent,
): Promise<StaffResult<'applied' | 'duplicate'>> {
  const prepared = await prepareProjectStore({ rootDir: event.projectRoot, rizzHome });
  if (!prepared.ok) {
    return staffErr('IO_FAILED', prepared.error.message);
  }
  const paths = observePaths(prepared.value.projectDir);
  const vault = await ensureObserveVault(paths);
  if (!vault.ok) return vault;
  const journal = await appendJournalEvent(paths.journalDir, event);
  if (!journal.ok) return journal;
  const events = await loadJournal(paths.journalDir);
  if (!events.ok) return events;
  const stored = events.value.find((item) => item.id === event.id);
  if (stored === undefined) {
    return staffErr('INVALID_STATE', 'journal is missing an event it just committed');
  }
  const thread = await appendThreadEntry(paths.threadsDir, stored, events.value);
  if (!thread.ok) return thread;
  const row = rowFromEvent(stored);
  if (row !== undefined) {
    const existingLedger = await readText(paths.ledger);
    if (!existingLedger.ok) return existingLedger;
    if (!(existingLedger.value ?? '').includes(`"eventId":${JSON.stringify(stored.id)}`)) {
      const ledger = await appendTokenRow(paths.ledger, row);
      if (!ledger.ok) return ledger;
    }
  }
  const decisions = await readDecisionRecords(paths.decisions);
  if (!decisions.ok) return decisions;
  const owners = committedOwnerDecisions(stored);
  for (const text of owners) {
    const queued = await queueInboxItem(paths.inboxDir, decisions.value, {
      id: inboxId(stored.threadId, text),
      text,
      threadId: stored.threadId,
    });
    if (!queued.ok) return queued;
  }
  if (stored.kind === 'stop') {
    const drift = await driftNotesFor(
      paths.vision,
      events.value.filter((item) => item.threadId === stored.threadId),
    );
    if (!drift.ok) return drift;
    for (const note of drift.value) {
      const queued = await queueInboxItem(paths.inboxDir, decisions.value, {
        id: inboxId(stored.threadId, note),
        text: note,
        threadId: stored.threadId,
      });
      if (!queued.ok) return queued;
    }
    const handoff = await writeHandoff(paths.handoffsDir, stored, events.value, drift.value);
    if (!handoff.ok) return handoff;
  }
  const brain = await refreshObserveIndex({
    projectDir: prepared.value.projectDir,
    projectRoot: event.projectRoot,
    at: event.at,
    rizzHome,
  });
  if (!brain.ok) return brain;
  if (journal.value === 'duplicate') return staffOk('duplicate');
  return staffOk('applied');
}

async function queueInboxItem(
  inboxDir: string,
  decisions: readonly { readonly id: string }[],
  item: { readonly id: string; readonly text: string; readonly threadId: string },
): Promise<StaffResult<void>> {
  if (isInboxAnswered(item.id, decisions)) {
    await rm(join(inboxDir, `${item.id}.md`), { force: true });
    return staffOk(undefined);
  }
  return writeInboxItem(inboxDir, item);
}

/** Rewrite BRAIN.md from the journal, inbox, and decision log. Safe to repeat. */
export async function refreshObserveIndex(options: {
  readonly projectDir: string;
  readonly projectRoot: string;
  readonly at: string;
  readonly rizzHome?: string;
}): Promise<StaffResult<void>> {
  const paths = observePaths(options.projectDir);
  const events = await loadJournal(paths.journalDir);
  if (!events.ok) return events;
  const decisions = await readDecisionRecords(paths.decisions);
  if (!decisions.ok) return decisions;
  const inbox = await listInbox(paths.inboxDir);
  if (!inbox.ok) return inbox;
  const openInbox: InboxItem[] = [];
  for (const item of inbox.value) {
    if (isInboxAnswered(item.id, decisions.value)) {
      await rm(join(paths.inboxDir, `${item.id}.md`), { force: true });
      continue;
    }
    openInbox.push(item);
  }
  const vision = await readText(paths.vision);
  if (!vision.ok) return vision;
  const unrecorded =
    options.rizzHome === undefined
      ? 0
      : await countUnrecorded(options.rizzHome, options.projectRoot);
  const snapshot = snapshotFromEvents(events.value, {
    updated: options.at,
    projectRoot: options.projectRoot,
    decisions: decisions.value,
    inbox: openInbox,
    visionQuote: visionQuote(vision.value ?? ''),
    unrecorded,
  });
  const brain = await writeBrain(paths.brain, snapshot);
  if (!brain.ok) return brain;
  return staffOk(undefined);
}

export async function foldSpool(rizzHome: string): Promise<StaffResult<FoldResult>> {
  return withLock(spoolLock(rizzHome), async () => {
    const offsetResult = await readOffset(spoolOffsetFile(rizzHome));
    if (!offsetResult.ok) return offsetResult;
    let raw = '';
    try {
      raw = await readFile(spoolFile(rizzHome), 'utf8');
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
      if (code === 'ENOENT') {
        raw = '';
      } else {
        return staffErr('IO_FAILED', 'cannot read the observe spool');
      }
    }
    const offset = Math.min(offsetResult.value, raw.length);
    const pending = raw.slice(offset);
    const lines = pending.split('\n');
    // split keeps a trailing empty string when the spool ends in a newline.
    const complete = lines.slice(0, -1);
    let applied = 0;
    let duplicates = 0;
    const projects = new Set<string>();
    let consumed = 0;
    for (const line of complete) {
      consumed += line.length + 1;
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed) || typeof parsed.id !== 'string') continue;
      const event = parsed as unknown as ObserveEvent;
      const result = await applyEvent(rizzHome, event);
      if (!result.ok) return result;
      if (result.value === 'duplicate') duplicates += 1;
      else applied += 1;
      projects.add(event.projectRoot);
    }
    const marked = await writeAtomic(
      spoolOffsetFile(rizzHome),
      `${JSON.stringify({ offset: offset + consumed })}\n`,
    );
    if (!marked.ok) return marked;
    const queued = await applyPendingEvents(rizzHome);
    if (!queued.ok) return queued;
    for (const project of queued.value.projects) projects.add(project);
    return staffOk({
      applied: applied + queued.value.applied,
      duplicates: duplicates + queued.value.duplicates,
      projects: [...projects],
    });
  });
}

function eventFileName(eventId: string): string {
  return `${createHash('sha256').update(eventId).digest('hex').slice(0, 24)}.json`;
}

export async function countUnrecorded(rizzHome: string, projectRoot: string): Promise<number> {
  let names: string[] = [];
  try {
    names = (await readdir(spoolDropDir(rizzHome))).filter((name) => name.endsWith('.json'));
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (code === 'ENOENT') return 0;
    return 0;
  }
  let count = 0;
  for (const name of names) {
    const text = await readText(join(spoolDropDir(rizzHome), name));
    if (!text.ok || text.value === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(text.value);
      if (isRecord(parsed) && parsed.projectRoot === projectRoot) count += 1;
    } catch {
      count += 1;
    }
  }
  return count;
}

async function applyPendingEvents(rizzHome: string): Promise<StaffResult<FoldResult>> {
  const dir = spoolPendingDir(rizzHome);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (code === 'ENOENT') return staffOk({ applied: 0, duplicates: 0, projects: [] });
    return staffErr('IO_FAILED', 'cannot list queued hook events');
  }
  let applied = 0;
  let duplicates = 0;
  const projects = new Set<string>();
  for (const name of names) {
    const path = join(dir, name);
    const text = await readText(path);
    if (!text.ok) return text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.value ?? '');
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string') continue;
    const result = await applyEvent(rizzHome, parsed as unknown as ObserveEvent);
    if (!result.ok) return result;
    await rm(path, { force: true });
    if (result.value === 'duplicate') duplicates += 1;
    else applied += 1;
    if (typeof parsed.projectRoot === 'string') projects.add(parsed.projectRoot);
  }
  return staffOk({ applied, duplicates, projects: [...projects] });
}

export async function appendSpoolEvent(
  rizzHome: string,
  event: ObserveEvent,
  options?: { readonly stampSequence?: boolean },
): Promise<StaffResult<'recorded' | 'dropped'>> {
  const locked = await withLock(spoolLock(rizzHome), async () => {
    let stamped = event;
    if (options?.stampSequence === true) {
      const offset = await nextAppendOffset(spoolFile(rizzHome));
      if (!offset.ok) return offset;
      stamped = { ...event, id: `${event.id}:s${offset.value}` };
    }
    return appendSynced(spoolFile(rizzHome), `${JSON.stringify(stamped)}\n`);
  });
  const line = `${JSON.stringify(event)}\n`;
  if (locked.ok) return staffOk('recorded');
  const queued = await writeAtomic(join(spoolPendingDir(rizzHome), eventFileName(event.id)), line);
  if (queued.ok) return staffOk('recorded');
  const dropped = await writeAtomic(
    join(spoolDropDir(rizzHome), eventFileName(event.id)),
    `${JSON.stringify({
      id: event.id,
      at: event.at,
      tool: event.tool,
      threadId: event.threadId,
      projectRoot: event.projectRoot,
      reason: queued.error.message,
    })}\n`,
  );
  if (dropped.ok) return staffOk('dropped');
  return queued;
}
