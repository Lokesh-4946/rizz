import { appendSynced, readText } from './io.js';
import type { ObserveEvent } from './model.js';
import { type StaffResult, staffErr, staffOk } from './result.js';
import { type TextTokenCount, countTextTokens } from './tokenize.js';

export type TokenCountSource = 'host' | 'tiktoken-o200k' | 'approx';

export interface TokenRow {
  readonly ts: string;
  readonly tool: string;
  readonly thread: string;
  readonly run: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly context: number;
  readonly reported: boolean;
  readonly source: TokenCountSource;
  readonly eventId: string;
}

export interface TokenSourceTotals {
  readonly input: number;
  readonly output: number;
  readonly runs: number;
}

export interface TokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly context: number;
  readonly reportedRuns: number;
  readonly unreportedRuns: number;
  readonly bySource: Readonly<Record<TokenCountSource, TokenSourceTotals>>;
  readonly byThread: readonly {
    readonly thread: string;
    readonly input: number;
    readonly output: number;
    readonly unreported: number;
  }[];
}

function num(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTokenCountSource(value: unknown): value is TokenCountSource {
  return value === 'host' || value === 'tiktoken-o200k' || value === 'approx';
}

function sourceForLegacyRow(reported: boolean): TokenCountSource {
  if (reported) return 'host';
  return 'approx';
}

function normalizeRow(parsed: object): TokenRow {
  const row = parsed as TokenRow;
  if (isTokenCountSource(row.source)) return row;
  return { ...row, source: sourceForLegacyRow(row.reported === true) };
}

function placeEstimatedCount(
  event: ObserveEvent,
  count: number,
): { readonly input: number; readonly output: number } {
  if (event.kind === 'stop') return { input: 0, output: count };
  return { input: count, output: 0 };
}

export async function rowFromEvent(
  event: ObserveEvent,
  countText: (text: string) => Promise<TextTokenCount> = countTextTokens,
): Promise<TokenRow | undefined> {
  const hostInput = event.fields.inputTokens;
  const hostOutput = event.fields.outputTokens;
  const hasTurn = hostInput !== undefined || hostOutput !== undefined;
  const hasContext = event.fields.contextTokens !== undefined;
  const isStop = event.kind === 'stop';
  if (!hasTurn && !hasContext && !isStop) return undefined;
  let input = num(hostInput);
  let output = num(hostOutput);
  let source: TokenCountSource = 'host';
  if (!hasTurn) {
    const counted = await countText(event.text);
    const placed = placeEstimatedCount(event, counted.count);
    input = placed.input;
    output = placed.output;
    source = counted.source;
  }
  return {
    ts: event.at,
    tool: event.tool,
    thread: event.threadId,
    run: event.fields.status ?? event.hook,
    input,
    output,
    cacheRead: num(event.fields.cacheRead),
    cacheWrite: num(event.fields.cacheWrite),
    context: num(event.fields.contextTokens),
    reported: event.fields.reported === 'yes',
    source,
    eventId: event.id,
  };
}

export async function appendTokenRow(path: string, row: TokenRow): Promise<StaffResult<void>> {
  return appendSynced(path, `${JSON.stringify(row)}\n`);
}

export async function readTokenRows(path: string): Promise<StaffResult<readonly TokenRow[]>> {
  const text = await readText(path);
  if (!text.ok) return text;
  const rows: TokenRow[] = [];
  for (const line of (text.value ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) rows.push(normalizeRow(parsed));
    } catch {
      return staffErr('INVALID_STATE', 'token ledger has a non-JSON line');
    }
  }
  return staffOk(rows);
}

function emptySourceTotals(): Record<TokenCountSource, TokenSourceTotals> {
  return {
    host: { input: 0, output: 0, runs: 0 },
    'tiktoken-o200k': { input: 0, output: 0, runs: 0 },
    approx: { input: 0, output: 0, runs: 0 },
  };
}

export function summarizeTokens(rows: readonly TokenRow[]): TokenTotals {
  const byThread = new Map<string, { input: number; output: number; unreported: number }>();
  const bySource = emptySourceTotals();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let context = 0;
  let reportedRuns = 0;
  let unreportedRuns = 0;
  for (const row of rows) {
    input += row.input;
    output += row.output;
    cacheRead += row.cacheRead;
    cacheWrite += row.cacheWrite;
    if (row.context > 0) context = row.context;
    if (row.reported) reportedRuns += 1;
    else unreportedRuns += 1;
    const source = isTokenCountSource(row.source) ? row.source : sourceForLegacyRow(row.reported);
    const currentSource = bySource[source];
    bySource[source] = {
      input: currentSource.input + row.input,
      output: currentSource.output + row.output,
      runs: currentSource.runs + 1,
    };
    const current = byThread.get(row.thread) ?? { input: 0, output: 0, unreported: 0 };
    byThread.set(row.thread, {
      input: current.input + row.input,
      output: current.output + row.output,
      unreported: current.unreported + (row.reported ? 0 : 1),
    });
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    context,
    reportedRuns,
    unreportedRuns,
    bySource,
    byThread: [...byThread.entries()].map(([thread, totals]) => ({ thread, ...totals })),
  };
}

export function renderTokenReport(totals: TokenTotals): string {
  const host = totals.bySource.host;
  const tiktoken = totals.bySource['tiktoken-o200k'];
  const approx = totals.bySource.approx;
  const lines = [
    `reported: ${host.input} in / ${host.output} out`,
    `tiktoken-o200k: ${tiktoken.input} in / ${tiktoken.output} out`,
    `approx: ${approx.input} in / ${approx.output} out`,
    `cache: ${totals.cacheRead} read / ${totals.cacheWrite} write`,
    `context: ${totals.context}`,
    `unreported runs: ${totals.unreportedRuns}`,
  ];
  for (const thread of totals.byThread) {
    lines.push(
      `${thread.thread}: ${thread.input} in / ${thread.output} out / ${thread.unreported} unreported`,
    );
  }
  if (totals.byThread.length === 0) lines.push('no usage recorded');
  return lines.join('\n');
}
