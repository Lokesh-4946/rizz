import type { InboxItem } from './brain-index.js';
import type { TokenTotals } from './ledger.js';
import { renderTokenReport } from './ledger.js';

/** Progress one-liner plus only the decisions waiting on the owner. */
export function renderSummary(options: {
  readonly threads: number;
  readonly inbox: readonly InboxItem[];
}): string {
  const progress = `${options.threads} thread(s) observed.`;
  if (options.inbox.length === 0) {
    return `${progress}\nNo decisions need the owner.`;
  }
  const lines = options.inbox.map((item) => `- ${item.text} (${item.threadId})`);
  return `${progress}\nNeeds the owner:\n${lines.join('\n')}`;
}

export function renderTokens(totals: TokenTotals): string {
  return renderTokenReport(totals);
}
