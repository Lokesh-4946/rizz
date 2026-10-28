import { readFile } from 'node:fs/promises';
import { prepareProjectStore } from '../project-store.js';
import { snapshotFromEvents, visionQuote, writeBrain } from './brain-index.js';
import { appendSynced, readText, withLock, writeAtomic } from './io.js';
import { appendJournalEvent, loadJournal } from './journal.js';
import { appendTokenRow, rowFromEvent } from './ledger.js';
import { type ObserveEvent, isRecord, ownerDecisionLines } from './model.js';
import {
  appendThreadEntry,
  driftNotesFor,
  ensureObserveVault,
  inboxId,
  listInbox,
  readDecisionRecords,
  writeHandoff,
  writeInboxItem,
} from './notes.js';
import { observePaths, spoolFile, spoolLock, spoolOffsetFile } from './paths.js';
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
  const thread = await appendThreadEntry(paths.threadsDir, event, events.value);
  if (!thread.ok) return thread;
  const row = rowFromEvent(event);
  if (row !== undefined) {
    const existingLedger = await readText(paths.ledger);
    if (!existingLedger.ok) return existingLedger;
    if (!(existingLedger.value ?? '').includes(`"eventId":${JSON.stringify(event.id)}`)) {
      const ledger = await appendTokenRow(paths.ledger, row);
      if (!ledger.ok) return ledger;
    }
  }
  const owners = ownerDecisionLines(event.text);
  for (const text of owners) {
    const item = await writeInboxItem(paths.inboxDir, {
      id: inboxId(event.threadId, text),
      text,
      threadId: event.threadId,
    });
    if (!item.ok) return item;
  }
  if (event.kind === 'stop') {
    const drift = await driftNotesFor(
      paths.vision,
      events.value.filter((item) => item.threadId === event.threadId),
    );
    if (!drift.ok) return drift;
    for (const note of drift.value) {
      const item = await writeInboxItem(paths.inboxDir, {
        id: inboxId(event.threadId, note),
        text: note,
        threadId: event.threadId,
      });
      if (!item.ok) return item;
    }
    const handoff = await writeHandoff(paths.handoffsDir, event, events.value, drift.value);
    if (!handoff.ok) return handoff;
  }
  const brain = await refreshObserveIndex({
    projectDir: prepared.value.projectDir,
    projectRoot: event.projectRoot,
    at: event.at,
  });
  if (!brain.ok) return brain;
  if (journal.value === 'duplicate') return staffOk('duplicate');
  return staffOk('applied');
}

/** Rewrite BRAIN.md from the journal, inbox, and decision log. Safe to repeat. */
export async function refreshObserveIndex(options: {
  readonly projectDir: string;
  readonly projectRoot: string;
  readonly at: string;
}): Promise<StaffResult<void>> {
  const paths = observePaths(options.projectDir);
  const events = await loadJournal(paths.journalDir);
  if (!events.ok) return events;
  const decisions = await readDecisionRecords(paths.decisions);
  if (!decisions.ok) return decisions;
  const inbox = await listInbox(paths.inboxDir);
  if (!inbox.ok) return inbox;
  const vision = await readText(paths.vision);
  if (!vision.ok) return vision;
  const snapshot = snapshotFromEvents(events.value, {
    updated: options.at,
    projectRoot: options.projectRoot,
    decisions: decisions.value,
    inbox: inbox.value,
    visionQuote: visionQuote(vision.value ?? ''),
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
        return staffOk({ applied: 0, duplicates: 0, projects: [] });
      }
      return staffErr('IO_FAILED', 'cannot read the observe spool');
    }
    const offset = Math.min(offsetResult.value, raw.length);
    const pending = raw.slice(offset);
    const lines = pending.split('\n');
    const complete = pending.endsWith('\n') ? lines : lines.slice(0, -1);
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
    return staffOk({
      applied,
      duplicates,
      projects: [...projects],
    });
  });
}

export async function appendSpoolEvent(
  rizzHome: string,
  event: ObserveEvent,
): Promise<StaffResult<void>> {
  const line = `${JSON.stringify(event)}\n`;
  const locked = await withLock(spoolLock(rizzHome), async () =>
    appendSynced(spoolFile(rizzHome), line),
  );
  if (locked.ok) return locked;
  // A stuck lock must not swallow the hook. The line is still appended.
  return appendSynced(spoolFile(rizzHome), line);
}
