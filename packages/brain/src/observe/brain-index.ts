import type { DecisionRecord } from './decisions.js';
import { activeDecisions } from './decisions.js';
import { readText, writeAtomic } from './io.js';
import { type ObserveEvent, VIEW_TEXT_CAP, clip } from './model.js';
import { DEFAULT_REPLY_WAIT_MS, type RelayView, renderMessageLines } from './relay/contract.js';
import { type StaffResult, staffOk } from './result.js';

export const BRAIN_LINE_CAP = 200;

export interface InboxItem {
  readonly id: string;
  readonly text: string;
  readonly threadId: string;
}

export interface BrainSnapshot {
  readonly updated: string;
  readonly projectRoot: string;
  readonly events: readonly ObserveEvent[];
  readonly decisions: readonly DecisionRecord[];
  readonly inbox: readonly InboxItem[];
  readonly visionQuote: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly contextTokens: number;
  readonly unreportedRuns: number;
  readonly unrecorded?: number;
  readonly relay?: RelayView;
}

interface ThreadRollup {
  readonly id: string;
  readonly tool: string;
  readonly status: string;
  readonly prompts: number;
  readonly tools: number;
  readonly files: number;
  readonly lastAt: string;
}

function rollupThreads(events: readonly ObserveEvent[]): ThreadRollup[] {
  const map = new Map<string, ThreadRollup>();
  for (const event of events) {
    const current = map.get(event.threadId) ?? {
      id: event.threadId,
      tool: event.tool,
      status: 'active',
      prompts: 0,
      tools: 0,
      files: 0,
      lastAt: event.at,
    };
    const status = event.kind === 'stop' ? (event.fields.status ?? 'stopped') : 'active';
    map.set(event.threadId, {
      ...current,
      status,
      prompts: current.prompts + (event.kind === 'prompt' || event.kind === 'decision' ? 1 : 0),
      tools: current.tools + (event.kind === 'tool' ? 1 : 0),
      files: current.files + event.files.length,
      lastAt: event.at,
    });
  }
  return [...map.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

function tokenTotals(events: readonly ObserveEvent[]): {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  unreportedRuns: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let contextTokens = 0;
  let unreportedRuns = 0;
  for (const event of events) {
    if (event.kind === 'usage' || event.fields.inputTokens !== undefined) {
      inputTokens += Number(event.fields.inputTokens ?? 0);
      outputTokens += Number(event.fields.outputTokens ?? 0);
      if (event.fields.contextTokens !== undefined) {
        contextTokens = Number(event.fields.contextTokens);
      }
    }
    if (event.kind === 'stop' && event.fields.reported !== 'yes') unreportedRuns += 1;
    if (
      event.kind === 'usage' &&
      event.fields.reported !== 'yes' &&
      event.fields.usageKind === 'turn'
    ) {
      unreportedRuns += 1;
    }
  }
  return { inputTokens, outputTokens, contextTokens, unreportedRuns };
}

/** Human index. Hard-capped so a host can inject it at session start. */
export function renderBrain(snapshot: BrainSnapshot): string {
  const totals = {
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    contextTokens: snapshot.contextTokens,
    unreportedRuns: snapshot.unreportedRuns,
  };
  const lines: string[] = [
    '# Rizz brain',
    '',
    `Updated: ${snapshot.updated}`,
    `Project: ${snapshot.projectRoot}`,
    `Events: ${snapshot.events.length}`,
    `Tokens: ${totals.inputTokens} in / ${totals.outputTokens} out / ${totals.contextTokens} context / ${totals.unreportedRuns} unreported runs`,
  ];
  if ((snapshot.unrecorded ?? 0) > 0) {
    lines.push(`Unrecorded hooks: ${snapshot.unrecorded}`);
  }
  lines.push('', '## North star');
  if (snapshot.visionQuote.length === 0) lines.push('- vision.md is empty');
  for (const line of snapshot.visionQuote.slice(0, 3)) lines.push(`- ${line}`);
  lines.push('', '## Decisions awaiting you');
  if (snapshot.inbox.length === 0) lines.push('- none');
  for (const item of snapshot.inbox.slice(0, 12)) {
    lines.push(`- ${item.text} ([[threads/${item.threadId}]])`);
  }
  lines.push('', '## Active threads');
  const threads = rollupThreads(snapshot.events);
  if (threads.length === 0) lines.push('- none yet');
  for (const thread of threads.slice(0, 12)) {
    lines.push(
      `- [[threads/${thread.id}]] · ${thread.tool} · ${thread.status} · ${thread.prompts} prompts · ${thread.tools} tools · ${thread.lastAt}`,
    );
  }
  if (threads.length > 12) lines.push(`- ${threads.length - 12} older threads are in the journal`);
  lines.push('', '## Current decisions');
  const active = activeDecisions(snapshot.decisions);
  if (active.length === 0) lines.push('- none');
  for (const decision of active.slice(0, 8)) lines.push(`- ${decision.id}: ${decision.text}`);
  lines.push('', '## Messages');
  const parsedNow = Date.parse(snapshot.updated);
  const relayView = snapshot.relay ?? {
    nowMs: Number.isFinite(parsedNow) ? parsedNow : 0,
    waitMs: DEFAULT_REPLY_WAIT_MS,
    waitByRelay: {},
    readIds: [],
  };
  for (const line of renderMessageLines(snapshot.events, relayView)) lines.push(line);
  lines.push('', '## Recent journal');
  const recent = [...snapshot.events].slice(-12);
  if (recent.length === 0) lines.push('- none yet');
  for (const event of recent) {
    const view = clip(event.text, VIEW_TEXT_CAP);
    const preview = view === '' ? event.hook : view.slice(0, 80);
    lines.push(`- ${event.at} · ${event.tool} · ${event.hook} · ${preview}`);
  }
  lines.push('', '## Notes', '- [[vision]]', '- [[decisions]]', '- ledger/tokens.jsonl', '');
  while (lines.length > BRAIN_LINE_CAP) {
    const recentAt = lines.indexOf('## Recent journal');
    if (recentAt === -1 || recentAt + 2 >= lines.length) break;
    lines.splice(recentAt + 1, 1);
  }
  return lines.slice(0, BRAIN_LINE_CAP).join('\n');
}

export function snapshotFromEvents(
  events: readonly ObserveEvent[],
  extras: {
    readonly updated: string;
    readonly projectRoot: string;
    readonly decisions: readonly DecisionRecord[];
    readonly inbox: readonly InboxItem[];
    readonly visionQuote: readonly string[];
    readonly unrecorded?: number;
    readonly relay?: RelayView;
  },
): BrainSnapshot {
  const totals = tokenTotals(events);
  return { ...extras, events, ...totals };
}

export async function writeBrain(
  path: string,
  snapshot: BrainSnapshot,
): Promise<StaffResult<string>> {
  const rendered = `${renderBrain(snapshot)}\n`;
  const written = await writeAtomic(path, rendered);
  if (!written.ok) return written;
  return staffOk(rendered);
}

export async function readBrainText(path: string): Promise<StaffResult<string>> {
  const text = await readText(path);
  if (!text.ok) return text;
  return staffOk(text.value ?? '');
}

export function visionQuote(markdown: string): string[] {
  const lines: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const bullet = trimmed.replace(/^[-*]\s+/, '');
    lines.push(bullet);
    if (lines.length === 3) break;
  }
  return lines;
}
