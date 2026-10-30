import type { InboxItem } from './brain-index.js';
import type { TokenTotals } from './ledger.js';
import { renderTokenReport } from './ledger.js';

/** Progress one-liner plus only the decisions waiting on the owner. */
export function renderSummary(options: {
  readonly threads: number;
  readonly inbox: readonly InboxItem[];
  readonly dropped?: number;
}): string {
  const progress = `${options.threads} thread(s) observed.`;
  const parts = [progress];
  if (options.inbox.length === 0) {
    parts.push('No decisions need the owner.');
  } else {
    const lines = options.inbox.map((item) => `- ${item.text} (${item.threadId})`);
    parts.push(`Needs the owner:\n${lines.join('\n')}`);
  }
  const dropped = options.dropped ?? 0;
  if (dropped > 0) parts.push(`${dropped} hook event(s) could not be recorded.`);
  return parts.join('\n');
}

export function renderTokens(totals: TokenTotals): string {
  return renderTokenReport(totals);
}
