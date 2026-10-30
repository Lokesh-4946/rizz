import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareProjectStore } from '../../project-store.js';
import {
  type BrainSnapshot,
  readBrainText,
  snapshotFromEvents,
  visionQuote,
  writeBrain,
} from '../brain-index.js';
import { readText, writeAtomic } from '../io.js';
import { loadJournal } from '../journal.js';
import type { ObserveEvent } from '../model.js';
import { ensureObserveVault, listInbox, readDecisionRecords } from '../notes.js';
import { observePaths } from '../paths.js';
import { type StaffResult, staffErr, staffOk } from '../result.js';
import { listRelays, readRelayNotice } from './config.js';
import {
  DEFAULT_REPLY_WAIT_MS,
  RELAY_WAIT_ENV,
  type RelayMessageRow,
  type RelayView,
  effectiveWaitMs,
  formatRelayRow,
  quoteRelayReplies,
  relayMessageRows,
  selectRelayRows,
} from './contract.js';

function readPath(projectDir: string): string {
  return join(projectDir, 'observe', 'relay-read.json');
}

export async function readRelayReadIds(projectDir: string): Promise<readonly string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(readPath(projectDir), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('ids' in parsed)) return [];
    const ids = (parsed as { ids?: unknown }).ids;
    if (!Array.isArray(ids)) return [];
    return ids.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

async function writeReadIds(
  projectDir: string,
  ids: readonly string[],
): Promise<StaffResult<void>> {
  return writeAtomic(readPath(projectDir), `${JSON.stringify({ ids })}\n`);
}

export async function relayViewFor(
  rizzHome: string,
  nowMs: number,
  readIds: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RelayView> {
  const configs = await listRelays(rizzHome);
  const waitByRelay: Record<string, number> = {};
  if (configs.ok) {
    for (const config of configs.value) {
      waitByRelay[config.name] = effectiveWaitMs(config.replyWaitMs, env[RELAY_WAIT_ENV]);
    }
  }
  const fallback = effectiveWaitMs(DEFAULT_REPLY_WAIT_MS, env[RELAY_WAIT_ENV]);
  return { nowMs, waitMs: fallback, waitByRelay, readIds };
}

interface ProjectMessages {
  readonly projectDir: string;
  readonly rootPath: string;
  readonly events: readonly ObserveEvent[];
}

export async function projectMessageEvents(
  rizzHome: string,
  projectRoot: string,
): Promise<StaffResult<ProjectMessages>> {
  const prepared = await prepareProjectStore({ rootDir: projectRoot, rizzHome });
  if (!prepared.ok) return staffErr('IO_FAILED', prepared.error.message);
  const paths = observePaths(prepared.value.projectDir);
  const events = await loadJournal(paths.journalDir);
  if (!events.ok) return events;
  const rootPath = prepared.value.rootPath;
  return staffOk({
    projectDir: prepared.value.projectDir,
    rootPath,
    events: events.value.filter((event) => event.projectRoot === rootPath),
  });
}

export async function loadRelayRows(
  rizzHome: string,
  projectRoot: string,
  nowMs = Date.now(),
): Promise<StaffResult<readonly RelayMessageRow[]>> {
  const loaded = await projectMessageEvents(rizzHome, projectRoot);
  if (!loaded.ok) return loaded;
  const readIds = await readRelayReadIds(loaded.value.projectDir);
  const view = await relayViewFor(rizzHome, nowMs, readIds);
  return staffOk(relayMessageRows(loaded.value.events, view));
}

export async function relaySummaryLines(
  rizzHome: string,
  projectRoot: string,
  nowMs = Date.now(),
): Promise<string[]> {
  const rows = await loadRelayRows(rizzHome, projectRoot, nowMs);
  const lines: string[] = [];
  const notice = await readRelayNotice(rizzHome);
  if (notice !== '') lines.push(`- fault: ${notice}`);
  if (!rows.ok) {
    lines.push(`- fault: ${rows.error.message}`);
    return lines;
  }
  const selected = selectRelayRows(rows.value, 12);
  for (const row of selected.shown) lines.push(`- ${formatRelayRow(row)}`);
  if (selected.hidden > 0) lines.push(`- ${selected.hidden} more messages on the brain page`);
  return lines;
}

export async function refreshRelayBrain(options: {
  readonly rizzHome: string;
  readonly projectRoot: string;
  readonly now: string;
}): Promise<StaffResult<string>> {
  const prepared = await prepareProjectStore({
    rootDir: options.projectRoot,
    rizzHome: options.rizzHome,
  });
  if (!prepared.ok) return staffErr('IO_FAILED', prepared.error.message);
  const paths = observePaths(prepared.value.projectDir);
  const vault = await ensureObserveVault(paths);
  if (!vault.ok) return vault;
  const events = await loadJournal(paths.journalDir);
  if (!events.ok) return events;
  const decisions = await readDecisionRecords(paths.decisions);
  if (!decisions.ok) return decisions;
  const inbox = await listInbox(paths.inboxDir);
  if (!inbox.ok) return inbox;
  const vision = await readText(paths.vision);
  if (!vision.ok) return vision;
  const readIds = await readRelayReadIds(prepared.value.projectDir);
  const nowMs = Date.parse(options.now);
  const relay = await relayViewFor(
    options.rizzHome,
    Number.isFinite(nowMs) ? nowMs : Date.now(),
    readIds,
  );
  const base = snapshotFromEvents(events.value, {
    updated: options.now,
    projectRoot: prepared.value.rootPath,
    decisions: decisions.value,
    inbox: inbox.value,
    visionQuote: visionQuote(vision.value ?? ''),
  });
  const snapshot: BrainSnapshot = { ...base, relay };
  const written = await writeBrain(paths.brain, snapshot);
  if (!written.ok) return written;
  return staffOk(written.value);
}

export async function takeUnreadRelayContext(options: {
  readonly rizzHome: string;
  readonly projectRoot: string;
  readonly now: string;
}): Promise<string> {
  const configs = await listRelays(options.rizzHome);
  if (!configs.ok || configs.value.length === 0) return '';
  const loaded = await projectMessageEvents(options.rizzHome, options.projectRoot);
  if (!loaded.ok) return '';
  const readIds = await readRelayReadIds(loaded.value.projectDir);
  const view = await relayViewFor(options.rizzHome, Date.parse(options.now), readIds);
  const unread = relayMessageRows(loaded.value.events, view).filter(
    (row) => row.direction === 'in' && row.unread,
  );
  if (unread.length === 0) return '';
  const merged = [...readIds];
  for (const row of unread) {
    if (!merged.includes(row.messageId)) merged.push(row.messageId);
  }
  const quote = quoteRelayReplies(
    unread.map((row) => ({ from: row.relay, text: row.text, inReplyTo: row.inReplyTo })),
  );
  const saved = await writeReadIds(loaded.value.projectDir, merged);
  if (saved.ok) {
    await refreshRelayBrain({
      rizzHome: options.rizzHome,
      projectRoot: options.projectRoot,
      now: options.now,
    });
  }
  return quote;
}

export async function readBrainExcerpt(projectDir: string): Promise<string> {
  const text = await readBrainText(join(projectDir, 'observe', 'BRAIN.md'));
  return text.ok ? text.value : '';
}
