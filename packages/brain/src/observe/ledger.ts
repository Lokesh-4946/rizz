import { appendSynced, readText } from './io.js';
import type { ObserveEvent } from './model.js';
import { type StaffResult, staffErr, staffOk } from './result.js';

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
  readonly eventId: string;
}

export interface TokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly context: number;
  readonly reportedRuns: number;
  readonly unreportedRuns: number;
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

export function rowFromEvent(event: ObserveEvent): TokenRow | undefined {
  const hasTurn = event.fields.inputTokens !== undefined || event.fields.outputTokens !== undefined;
  const hasContext = event.fields.contextTokens !== undefined;
  const isStop = event.kind === 'stop';
  if (!hasTurn && !hasContext && !isStop) return undefined;
  return {
    ts: event.at,
    tool: event.tool,
    thread: event.threadId,
    run: event.fields.status ?? event.hook,
    input: num(event.fields.inputTokens),
    output: num(event.fields.outputTokens),
    cacheRead: num(event.fields.cacheRead),
    cacheWrite: num(event.fields.cacheWrite),
    context: num(event.fields.contextTokens),
    reported: event.fields.reported === 'yes',
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
      if (typeof parsed === 'object' && parsed !== null) rows.push(parsed as TokenRow);
    } catch {
      return staffErr('INVALID_STATE', 'token ledger has a non-JSON line');
    }
  }
  return staffOk(rows);
}

export function summarizeTokens(rows: readonly TokenRow[]): TokenTotals {
  const byThread = new Map<string, { input: number; output: number; unreported: number }>();
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
    byThread: [...byThread.entries()].map(([thread, totals]) => ({ thread, ...totals })),
  };
}

export function renderTokenReport(totals: TokenTotals): string {
  const lines = [
    `reported: ${totals.input} in / ${totals.output} out`,
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
