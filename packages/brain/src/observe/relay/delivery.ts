import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareProjectStore } from '../../project-store.js';
import { commitObserveEvent } from '../fold.js';
import { appendSynced, readText, withLock } from '../io.js';
import { type ObserveEvent, isRecord } from '../model.js';
import { type StaffResult, staffErr, staffOk } from '../result.js';
import { readBrainExcerpt, refreshRelayBrain } from './board.js';
import {
  clearRelayNotice,
  listRelays,
  readRelay,
  writePrivateFile,
  writeRelayNotice,
} from './config.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  type PollMessage,
  type PollPage,
  RELAY_TEXT_CAP,
  backoffMs,
  boundedRelayText,
  hookMessageId,
  indexExcerpt,
  isRelayName,
  newMessageId,
  parseRelayPrompt,
  replyIdentity,
  safeRelayReason,
  webhookPayload,
} from './contract.js';

export { writeRelayNotice } from './config.js';

const MESSAGE_ID = /^msg_[a-f0-9]{24}$/;

export interface OutboxItem {
  readonly id: string;
  readonly to: string;
  readonly text: string;
  readonly projectPath: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly status: 'queued' | 'sent' | 'failed';
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastError: string;
  readonly sentAt: string;
  readonly exhausted: boolean;
}

interface SpoolSend {
  readonly id: string;
  readonly to: string;
  readonly text: string;
  readonly projectRoot: string;
  readonly at: string;
  readonly rejectReason: string;
}

interface PollState {
  readonly cursor: string;
  readonly nextPollAt: number;
  readonly failures: number;
}

export interface RelayRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface RelayResponse {
  readonly status: number;
  readonly body: string;
  readonly truncated: boolean;
}

export interface RelayRuntime {
  now(): Date;
  fetch(request: RelayRequest): Promise<RelayResponse>;
}

export interface MaintainStats {
  readonly drained: number;
  readonly sent: number;
  readonly failed: number;
  readonly ingested: number;
  readonly skipped: boolean;
}

function defaultRuntime(): RelayRuntime {
  return { now: () => new Date(), fetch: fetchRelay };
}

async function fetchRelay(request: RelayRequest): Promise<RelayResponse> {
  const init: RequestInit = {
    method: request.method,
    headers: { ...request.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  };
  if (request.body !== undefined) init.body = request.body;
  const response = await fetch(request.url, init);
  const raw = await response.text();
  const truncated = raw.length > 32_000;
  return { status: response.status, body: truncated ? raw.slice(0, 32_000) : raw, truncated };
}

function outboxPath(rizzHome: string, id: string): string {
  return join(rizzHome, 'relay', 'outbox', `${id}.json`);
}

function spoolPath(rizzHome: string): string {
  return join(rizzHome, 'relay', 'spool.jsonl');
}

function offsetPath(rizzHome: string): string {
  return join(rizzHome, 'relay', 'spool-offset.json');
}

function pollPath(rizzHome: string, name: string): string {
  return join(rizzHome, 'relay', 'poll', `${name}.json`);
}

function iso(date: Date): string {
  return date.toISOString();
}

function pollIntervalMs(): number {
  const raw = process.env.RIZZ_RELAY_POLL_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return 15_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return 15_000;
  return parsed;
}

function parseOutbox(value: unknown): OutboxItem | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !MESSAGE_ID.test(value.id))
    return undefined;
  if (typeof value.to !== 'string' || typeof value.text !== 'string') return undefined;
  if (typeof value.projectPath !== 'string' || typeof value.projectId !== 'string')
    return undefined;
  if (value.status !== 'queued' && value.status !== 'sent' && value.status !== 'failed') {
    return undefined;
  }
  if (typeof value.attempts !== 'number' || typeof value.exhausted !== 'boolean') return undefined;
  return {
    id: value.id,
    to: value.to,
    text: value.text,
    projectPath: value.projectPath,
    projectId: value.projectId,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    status: value.status,
    attempts: value.attempts,
    nextAttemptAt: typeof value.nextAttemptAt === 'string' ? value.nextAttemptAt : '',
    lastError: typeof value.lastError === 'string' ? value.lastError : '',
    sentAt: typeof value.sentAt === 'string' ? value.sentAt : '',
    exhausted: value.exhausted,
  };
}

async function writeOutbox(rizzHome: string, item: OutboxItem): Promise<StaffResult<void>> {
  return writePrivateFile(outboxPath(rizzHome, item.id), `${JSON.stringify(item)}\n`);
}

export async function readOutbox(rizzHome: string, id: string): Promise<OutboxItem | undefined> {
  if (!MESSAGE_ID.test(id)) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(outboxPath(rizzHome, id), 'utf8'));
    return parseOutbox(parsed);
  } catch {
    return undefined;
  }
}

async function listOutbox(rizzHome: string): Promise<OutboxItem[]> {
  let names: string[] = [];
  try {
    names = await readdir(join(rizzHome, 'relay', 'outbox'));
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (code === 'ENOENT') return [];
    throw error;
  }
  const items: OutboxItem[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const item = await readOutbox(rizzHome, name.slice(0, -'.json'.length));
    if (item !== undefined) items.push(item);
  }
  return items;
}

function isDue(item: OutboxItem, nowMs: number): boolean {
  if (item.status === 'sent' || item.exhausted) return false;
  const at = Date.parse(item.nextAttemptAt);
  if (!Number.isFinite(at)) return true;
  return at <= nowMs;
}

async function acquireRelayLock(rizzHome: string): Promise<boolean> {
  const lockPath = join(rizzHome, 'relay', 'lock');
  await mkdir(join(rizzHome, 'relay'), { recursive: true });
  try {
    await mkdir(lockPath);
    return true;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (code !== 'EEXIST') throw error;
    const info = await stat(lockPath).catch(() => undefined);
    if (info !== undefined && Date.now() - info.mtimeMs > 30_000) {
      await rm(lockPath, { recursive: true, force: true });
      try {
        await mkdir(lockPath);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function releaseRelayLock(rizzHome: string): Promise<void> {
  await rm(join(rizzHome, 'relay', 'lock'), { recursive: true, force: true });
}

function messageEvent(options: {
  readonly id: string;
  readonly at: string;
  readonly projectRoot: string;
  readonly relay: string;
  readonly messageId: string;
  readonly direction: 'in' | 'out';
  readonly status: string;
  readonly reason: string;
  readonly text: string;
  readonly inReplyTo: string;
  readonly sentAt: string;
}): ObserveEvent {
  return {
    id: options.id,
    at: options.at,
    tool: 'cursor',
    hook: 'relay',
    threadId: `relay-${options.relay}`,
    projectRoot: options.projectRoot,
    kind: 'message',
    text: options.text,
    files: [],
    fields: {
      direction: options.direction,
      relay: options.relay,
      messageId: options.messageId,
      inReplyTo: options.inReplyTo,
      status: options.status,
      reason: safeRelayReason(options.reason),
      sentAt: options.sentAt,
    },
  };
}

async function recordOutbound(
  rizzHome: string,
  item: OutboxItem,
  at: string,
  status: 'queued' | 'sent' | 'failed',
  reason: string,
  attempt: number,
): Promise<StaffResult<'applied' | 'duplicate'>> {
  const suffix = status === 'failed' ? `failed:${attempt}` : status;
  return commitObserveEvent(
    rizzHome,
    messageEvent({
      id: `relay-out:${item.id}:${suffix}`,
      at,
      projectRoot: item.projectPath,
      relay: item.to,
      messageId: item.id,
      direction: 'out',
      status,
      reason,
      text: item.text,
      inReplyTo: '',
      sentAt: status === 'sent' ? at : item.sentAt,
    }),
  );
}

function parseSpool(value: unknown): SpoolSend | undefined {
  if (!isRecord(value) || value.op !== 'send') return undefined;
  if (typeof value.id !== 'string' || !MESSAGE_ID.test(value.id)) return undefined;
  if (typeof value.to !== 'string' || typeof value.text !== 'string') return undefined;
  if (typeof value.projectRoot !== 'string' || typeof value.at !== 'string') return undefined;
  return {
    id: value.id,
    to: value.to,
    text: value.text,
    projectRoot: value.projectRoot,
    at: value.at,
    rejectReason: typeof value.rejectReason === 'string' ? value.rejectReason : '',
  };
}

async function readOffset(path: string): Promise<number> {
  const text = await readText(path);
  if (!text.ok || text.value === undefined || text.value.trim() === '') return 0;
  try {
    const parsed: unknown = JSON.parse(text.value);
    if (isRecord(parsed) && typeof parsed.offset === 'number') return parsed.offset;
  } catch {
    return 0;
  }
  return 0;
}

export async function enqueueRelaySend(options: {
  readonly rizzHome: string;
  readonly to: string;
  readonly text: string;
  readonly projectRoot: string;
  readonly at: string;
  readonly id?: string;
  readonly rejectReason?: string;
  readonly recordOverflow?: boolean;
}): Promise<StaffResult<{ readonly id: string }>> {
  if (!isRelayName(options.to)) return staffErr('UNKNOWN_RELAY', `unknown relay '${options.to}'`);
  const config = await readRelay(options.rizzHome, options.to);
  if (!config.ok) return config;
  if (config.value === undefined) return staffErr('UNKNOWN_RELAY', `unknown relay '${options.to}'`);
  const id = options.id ?? newMessageId();
  if (!MESSAGE_ID.test(id)) return staffErr('BAD_REQUEST', 'message id is not valid');
  let rejectReason = options.rejectReason ?? '';
  let text = options.text;
  if (text.length > RELAY_TEXT_CAP) {
    if (options.recordOverflow !== true) {
      return staffErr('PAYLOAD_TOO_LARGE', `message exceeds ${RELAY_TEXT_CAP} characters`);
    }
    rejectReason = `payload exceeds ${RELAY_TEXT_CAP} characters`;
    text = text.slice(0, 200);
  }
  const bounded = boundedRelayText(text);
  if (!bounded.ok && rejectReason === '') return staffErr('BAD_REQUEST', 'message text is empty');
  const stored = bounded.ok ? bounded.text : text.slice(0, 200);
  const record = {
    op: 'send' as const,
    id,
    to: options.to,
    text: stored,
    projectRoot: options.projectRoot,
    at: options.at,
    rejectReason,
  };
  const appended = await withLock(join(options.rizzHome, 'relay', 'spool-lock'), async () =>
    appendSynced(spoolPath(options.rizzHome), `${JSON.stringify(record)}\n`),
  );
  if (!appended.ok) return appended;
  return staffOk({ id });
}

export async function queueRelayPrompt(options: {
  readonly rizzHome: string;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly sourceEventId: string;
  readonly at: string;
}): Promise<{ readonly note: string }> {
  const parsed = parseRelayPrompt(options.prompt);
  if (parsed === undefined) return { note: '' };
  const config = await readRelay(options.rizzHome, parsed.name);
  if (!config.ok) {
    return { note: `Rizz did not relay to ${parsed.name}: ${config.error.message}` };
  }
  if (config.value === undefined) return { note: '' };
  const queued = await enqueueRelaySend({
    rizzHome: options.rizzHome,
    to: parsed.name,
    text: parsed.text,
    projectRoot: options.projectRoot,
    at: options.at,
    id: hookMessageId(options.projectRoot, parsed.name, options.sourceEventId),
    recordOverflow: true,
  });
  if (!queued.ok) return { note: `Rizz did not relay to ${parsed.name}: ${queued.error.message}` };
  return { note: `Rizz queued message ${queued.value.id} to ${parsed.name}.` };
}

async function materialize(
  rizzHome: string,
  record: SpoolSend,
): Promise<StaffResult<OutboxItem | undefined>> {
  const existing = await readOutbox(rizzHome, record.id);
  if (existing !== undefined) return staffOk(undefined);
  const prepared = await prepareProjectStore({ rootDir: record.projectRoot, rizzHome });
  if (!prepared.ok) return staffErr('IO_FAILED', prepared.error.message);
  const rejected = record.rejectReason !== '';
  const item: OutboxItem = {
    id: record.id,
    to: record.to,
    text: record.text,
    projectPath: prepared.value.rootPath,
    projectId: prepared.value.projectId,
    createdAt: record.at,
    status: rejected ? 'failed' : 'queued',
    attempts: 0,
    nextAttemptAt: record.at,
    lastError: record.rejectReason,
    sentAt: '',
    exhausted: rejected,
  };
  const written = await writeOutbox(rizzHome, item);
  if (!written.ok) return written;
  const recorded = await recordOutbound(
    rizzHome,
    item,
    record.at,
    rejected ? 'failed' : 'queued',
    record.rejectReason,
    0,
  );
  if (!recorded.ok) return recorded;
  return staffOk(item);
}

async function drainSpool(rizzHome: string): Promise<StaffResult<number>> {
  return withLock(join(rizzHome, 'relay', 'spool-lock'), async () => {
    const offset = await readOffset(offsetPath(rizzHome));
    let raw = '';
    try {
      raw = await readFile(spoolPath(rizzHome), 'utf8');
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
      if (code === 'ENOENT') return staffOk(0);
      return staffErr('IO_FAILED', 'cannot read the relay spool');
    }
    const pending = raw.slice(offset);
    const lines = pending.split('\n');
    const complete = lines.slice(0, -1);
    let drained = 0;
    let consumed = 0;
    for (const line of complete) {
      consumed += line.length + 1;
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        await writeRelayNotice(rizzHome, 'relay spool line was not JSON');
        continue;
      }
      const record = parseSpool(parsed);
      if (record === undefined) {
        await writeRelayNotice(rizzHome, 'relay spool line was not a send');
        continue;
      }
      const saved = await materialize(rizzHome, record);
      if (!saved.ok) return saved;
      drained += 1;
    }
    const written = await writePrivateFile(
      offsetPath(rizzHome),
      `${JSON.stringify({ offset: offset + consumed })}\n`,
    );
    if (!written.ok) return written;
    return staffOk(drained);
  });
}

async function deliverItem(
  rizzHome: string,
  item: OutboxItem,
  runtime: RelayRuntime,
): Promise<StaffResult<'sent' | 'failed'>> {
  const now = runtime.now();
  const attempt = item.attempts + 1;
  const claimed: OutboxItem = {
    ...item,
    attempts: attempt,
    nextAttemptAt: new Date(now.getTime() + backoffMs(attempt)).toISOString(),
  };
  const claimedWrite = await writeOutbox(rizzHome, claimed);
  if (!claimedWrite.ok) return claimedWrite;
  const config = await readRelay(rizzHome, item.to);
  if (!config.ok) return config;
  if (config.value === undefined) {
    const reason = `unknown relay '${item.to}'`;
    const failed: OutboxItem = { ...claimed, status: 'failed', exhausted: true, lastError: reason };
    await writeOutbox(rizzHome, failed);
    await recordOutbound(rizzHome, failed, iso(now), 'failed', reason, attempt);
    return staffOk('failed');
  }
  const prepared = await prepareProjectStore({ rootDir: item.projectPath, rizzHome });
  if (!prepared.ok) return staffErr('IO_FAILED', prepared.error.message);
  const brain = await readBrainExcerpt(prepared.value.projectDir);
  const payload = webhookPayload({
    id: item.id,
    project: item.projectId,
    projectPath: item.projectPath,
    text: item.text,
    indexExcerpt: indexExcerpt(brain),
    sentAt: iso(now),
  });
  let response: RelayResponse;
  try {
    response = await runtime.fetch({
      url: config.value.webhookUrl,
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.value.senderKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'rizz-relay',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    response = { status: 0, body: '', truncated: false };
  }
  const gaveUp = attempt >= MAX_DELIVERY_ATTEMPTS;
  if (response.status >= 200 && response.status < 300) {
    const recorded = await recordOutbound(rizzHome, claimed, iso(now), 'sent', '', attempt);
    if (!recorded.ok) {
      const retry: OutboxItem = {
        ...claimed,
        status: 'queued',
        lastError: 'delivered but not recorded; will retry',
        exhausted: false,
      };
      await writeOutbox(rizzHome, retry);
      return staffOk('failed');
    }
    const sent: OutboxItem = {
      ...claimed,
      status: 'sent',
      sentAt: iso(now),
      lastError: '',
      nextAttemptAt: '',
      exhausted: false,
    };
    const saved = await writeOutbox(rizzHome, sent);
    if (!saved.ok) return saved;
    return staffOk('sent');
  }
  let httpReason = `HTTP ${response.status}`;
  if (response.status === 0) httpReason = 'network error';
  const reason = gaveUp
    ? `${httpReason} (gave up after ${MAX_DELIVERY_ATTEMPTS} attempts)`
    : `${httpReason} (attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS})`;
  const failed: OutboxItem = {
    ...claimed,
    status: 'failed',
    exhausted: gaveUp,
    lastError: reason,
  };
  await recordOutbound(rizzHome, failed, iso(now), 'failed', reason, attempt);
  const saved = await writeOutbox(rizzHome, failed);
  if (!saved.ok) return saved;
  return staffOk('failed');
}

function parsePollPage(value: unknown): PollPage | undefined {
  if (!isRecord(value) || !Array.isArray(value.messages)) return undefined;
  const messages: PollMessage[] = [];
  for (const item of value.messages) {
    if (!isRecord(item) || typeof item.text !== 'string') return undefined;
    messages.push({
      id: typeof item.id === 'string' ? item.id : '',
      inReplyTo: typeof item.inReplyTo === 'string' ? item.inReplyTo : '',
      from: typeof item.from === 'string' ? item.from : '',
      text: item.text,
      at: typeof item.at === 'string' ? item.at : '',
    });
  }
  return { messages, cursor: typeof value.cursor === 'string' ? value.cursor : '' };
}

async function readPollState(rizzHome: string, name: string): Promise<PollState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pollPath(rizzHome, name), 'utf8'));
    if (!isRecord(parsed)) return { cursor: '', nextPollAt: 0, failures: 0 };
    return {
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '',
      nextPollAt: typeof parsed.nextPollAt === 'number' ? parsed.nextPollAt : 0,
      failures: typeof parsed.failures === 'number' ? parsed.failures : 0,
    };
  } catch {
    return { cursor: '', nextPollAt: 0, failures: 0 };
  }
}

export async function ingestRelayReply(options: {
  readonly rizzHome: string;
  readonly from: string;
  readonly inReplyTo: string;
  readonly text: string;
  readonly at: string;
  readonly fallbackProjectRoot?: string;
}): Promise<StaffResult<{ readonly status: 'ingested' | 'duplicate'; readonly id: string }>> {
  if (!isRelayName(options.from))
    return staffErr('UNKNOWN_RELAY', `unknown relay '${options.from}'`);
  const config = await readRelay(options.rizzHome, options.from);
  if (!config.ok) return config;
  if (config.value === undefined)
    return staffErr('UNKNOWN_RELAY', `unknown relay '${options.from}'`);
  if (options.inReplyTo.trim() === '') return staffErr('BAD_REQUEST', 'in-reply-to is required');
  const bounded = boundedRelayText(options.text);
  if (!bounded.ok) {
    const empty = options.text.trim() === '';
    return staffErr(
      empty ? 'BAD_REQUEST' : 'PAYLOAD_TOO_LARGE',
      empty ? 'reply text is empty' : `reply exceeds ${RELAY_TEXT_CAP} characters`,
    );
  }
  const id = replyIdentity(options.from, options.inReplyTo, bounded.text);
  const matched = MESSAGE_ID.test(options.inReplyTo)
    ? await readOutbox(options.rizzHome, options.inReplyTo)
    : undefined;
  const projectRoot = matched?.projectPath ?? options.fallbackProjectRoot;
  if (projectRoot === undefined) {
    return staffErr('BAD_REQUEST', `no project for in-reply-to ${options.inReplyTo}`);
  }
  const prepared = await prepareProjectStore({ rootDir: projectRoot, rizzHome: options.rizzHome });
  if (!prepared.ok) return staffErr('IO_FAILED', prepared.error.message);
  const recorded = await commitObserveEvent(
    options.rizzHome,
    messageEvent({
      id: `relay-in:${id}`,
      at: options.at,
      projectRoot: prepared.value.rootPath,
      relay: options.from,
      messageId: id,
      direction: 'in',
      status: 'received',
      reason: '',
      text: bounded.text,
      inReplyTo: options.inReplyTo,
      sentAt: '',
    }),
  );
  if (!recorded.ok) return recorded;
  await refreshRelayBrain({
    rizzHome: options.rizzHome,
    projectRoot: prepared.value.rootPath,
    now: options.at,
  });
  if (recorded.value === 'duplicate') return staffOk({ status: 'duplicate', id });
  return staffOk({ status: 'ingested', id });
}

async function pollOne(
  rizzHome: string,
  name: string,
  pollUrl: string,
  senderKey: string,
  runtime: RelayRuntime,
): Promise<StaffResult<number>> {
  const state = await readPollState(rizzHome, name);
  const nowMs = runtime.now().getTime();
  if (state.nextPollAt > nowMs) return staffOk(0);
  let url: URL;
  try {
    url = new URL(pollUrl);
  } catch {
    await writeRelayNotice(rizzHome, `poll for ${name} failed: invalid url`);
    return staffOk(0);
  }
  if (state.cursor !== '') url.searchParams.set('cursor', state.cursor);
  let response: RelayResponse;
  try {
    response = await runtime.fetch({
      url: url.toString(),
      method: 'GET',
      headers: {
        authorization: `Bearer ${senderKey}`,
        accept: 'application/json',
        'user-agent': 'rizz-relay',
      },
    });
  } catch {
    response = { status: 0, body: '', truncated: false };
  }
  const failures = state.failures + 1;
  if (response.status < 200 || response.status >= 300 || response.truncated) {
    let reason = `HTTP ${response.status}`;
    if (response.truncated) reason = 'response too large';
    else if (response.status === 0) reason = 'network error';
    await writePrivateFile(
      pollPath(rizzHome, name),
      `${JSON.stringify({
        cursor: state.cursor,
        nextPollAt: nowMs + backoffMs(failures),
        failures,
      })}\n`,
    );
    await writeRelayNotice(rizzHome, `poll for ${name} failed: ${reason}`);
    return staffOk(0);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    await writeRelayNotice(rizzHome, `poll for ${name} failed: response was not JSON`);
    return staffOk(0);
  }
  const page = parsePollPage(parsed);
  if (page === undefined) {
    await writeRelayNotice(rizzHome, `poll for ${name} failed: response was not a message page`);
    return staffOk(0);
  }
  let ingested = 0;
  let blocked = false;
  for (const message of page.messages) {
    if (message.text.trim() === '') {
      await writeRelayNotice(rizzHome, `poll for ${name} skipped a message with no text`);
      continue;
    }
    if (message.from !== '' && message.from !== name) {
      await writeRelayNotice(rizzHome, `poll for ${name} skipped a message from ${message.from}`);
      continue;
    }
    const saved = await ingestRelayReply({
      rizzHome,
      from: name,
      inReplyTo: message.inReplyTo,
      text: message.text,
      at: message.at === '' ? iso(runtime.now()) : message.at,
    });
    if (!saved.ok) {
      blocked = true;
      await writeRelayNotice(
        rizzHome,
        `poll for ${name} did not ingest a reply: ${saved.error.message}`,
      );
      continue;
    }
    if (saved.value.status === 'ingested') ingested += 1;
  }
  const cursor = blocked ? state.cursor : page.cursor;
  const nextPollAt = blocked ? nowMs + backoffMs(failures) : nowMs + pollIntervalMs();
  await writePrivateFile(
    pollPath(rizzHome, name),
    `${JSON.stringify({ cursor, nextPollAt, failures: blocked ? failures : 0 })}\n`,
  );
  return staffOk(ingested);
}

async function hasRelayWork(rizzHome: string): Promise<boolean> {
  const configs = await listRelays(rizzHome);
  if (configs.ok && configs.value.some((config) => config.pollUrl !== '')) return true;
  const items = await listOutbox(rizzHome).catch(() => []);
  if (items.length > 0) return true;
  try {
    await stat(spoolPath(rizzHome));
    return true;
  } catch {
    return false;
  }
}

export async function maintainRelay(
  rizzHome: string,
  runtime: RelayRuntime = defaultRuntime(),
): Promise<StaffResult<MaintainStats>> {
  if (!(await hasRelayWork(rizzHome))) {
    await clearRelayNotice(rizzHome);
    return staffOk({ drained: 0, sent: 0, failed: 0, ingested: 0, skipped: false });
  }
  const locked = await acquireRelayLock(rizzHome);
  if (!locked) return staffOk({ drained: 0, sent: 0, failed: 0, ingested: 0, skipped: true });
  try {
    await clearRelayNotice(rizzHome);
    const drained = await drainSpool(rizzHome);
    if (!drained.ok) return drained;
    let sent = 0;
    let failed = 0;
    let ingested = 0;
    const projects = new Set<string>();
    const items = await listOutbox(rizzHome);
    for (const item of items) {
      projects.add(item.projectPath);
      if (!isDue(item, runtime.now().getTime())) continue;
      const result = await deliverItem(rizzHome, item, runtime);
      if (!result.ok) return result;
      if (result.value === 'sent') sent += 1;
      else failed += 1;
    }
    const configs = await listRelays(rizzHome);
    if (!configs.ok) return configs;
    for (const config of configs.value) {
      if (config.pollUrl === '') continue;
      const polled = await pollOne(
        rizzHome,
        config.name,
        config.pollUrl,
        config.senderKey,
        runtime,
      );
      if (!polled.ok) return polled;
      ingested += polled.value;
    }
    const now = iso(runtime.now());
    for (const projectRoot of projects) {
      const refreshed = await refreshRelayBrain({ rizzHome, projectRoot, now });
      if (!refreshed.ok) {
        await writeRelayNotice(
          rizzHome,
          `could not refresh the brain index: ${refreshed.error.message}`,
        );
      }
    }
    return staffOk({ drained: drained.value, sent, failed, ingested, skipped: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return staffErr('IO_FAILED', safeRelayReason(message));
  } finally {
    await releaseRelayLock(rizzHome);
  }
}

export async function sendRelayText(options: {
  readonly rizzHome: string;
  readonly to: string;
  readonly text: string;
  readonly projectRoot: string;
  readonly at?: string;
  readonly runtime?: RelayRuntime;
}): Promise<
  StaffResult<{ readonly id: string; readonly status: string; readonly reason: string }>
> {
  const at = options.at ?? new Date().toISOString();
  const queued = await enqueueRelaySend({
    rizzHome: options.rizzHome,
    to: options.to,
    text: options.text,
    projectRoot: options.projectRoot,
    at,
  });
  if (!queued.ok) return queued;
  const maintained = await maintainRelay(options.rizzHome, options.runtime ?? defaultRuntime());
  if (!maintained.ok) return maintained;
  const item = await readOutbox(options.rizzHome, queued.value.id);
  if (item === undefined) {
    return staffOk({ id: queued.value.id, status: 'queued', reason: 'waiting for delivery' });
  }
  return staffOk({ id: item.id, status: item.status, reason: item.lastError });
}
