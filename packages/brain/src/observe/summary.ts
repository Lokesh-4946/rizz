import type { InboxItem } from './brain-index.js';
import type { TokenTotals } from './ledger.js';
import { renderTokenReport } from './ledger.js';

export interface OwnerDecisionSummary {
  readonly threads: number;
  readonly dropped: number;
  readonly decisions: readonly {
    readonly id: string;
    readonly text: string;
    readonly threadId: string;
  }[];
}

export function ownerDecisionSummary(options: {
  readonly threads: number;
  readonly inbox: readonly InboxItem[];
  readonly dropped?: number;
}): OwnerDecisionSummary {
  return {
    threads: options.threads,
    dropped: options.dropped ?? 0,
    decisions: options.inbox.map((item) => ({
      id: item.id,
      text: item.text,
      threadId: item.threadId,
    })),
  };
}

/** Progress one-liner plus only the decisions waiting on the owner. */
export function renderSummary(options: {
  readonly threads: number;
  readonly inbox: readonly InboxItem[];
  readonly dropped?: number;
}): string {
  const summary = ownerDecisionSummary(options);
  const progress = `${summary.threads} thread(s) observed.`;
  const parts = [progress];
  if (summary.decisions.length === 0) {
    parts.push('No decisions need the owner.');
  } else {
    const lines = summary.decisions.map((item) => `- ${item.text} (${item.threadId})`);
    parts.push(`Needs the owner:\n${lines.join('\n')}`);
  }
  if (summary.dropped > 0) parts.push(`${summary.dropped} hook event(s) could not be recorded.`);
  return parts.join('\n');
}

export function renderTokens(totals: TokenTotals): string {
  return renderTokenReport(totals);
}
