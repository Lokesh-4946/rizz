// compressContext — the compression service (design §3.3, §4). It protects the HEAD (system prompt
// + original task intent) and the TAIL (recent messages + tool results), and summarizes only the
// MIDDLE — the opposite of dropping the thread. It returns the rewritten message list plus a
// `droppedSummary` that the loop SHOWS the user ("what was compacted"), which is the underserved
// differentiator (latent-demands §3). The service never mutates the Session — the loop swaps the
// returned list in (ADR-001 rule 2).

import type { Message } from './provider.js';
import type { Result } from './result.js';
import { estimateMessagesTokens, estimateTokens } from './tokens.js';

export interface CompressParams {
  readonly messages: readonly Message[];
  /** Protect the first N messages (system + task intent) — never summarized. */
  readonly keepHead: number;
  /** Protect the last N messages (recent work + tool results) — never summarized. */
  readonly keepTail: number;
  /** Advisory target for the compacted middle; M3 summarizes the whole middle in one shot. */
  readonly targetTokens: number;
  /** Model-backed summarizer — returns prose describing the slice. The loop supplies it. */
  readonly summarize: (slice: readonly Message[]) => Promise<Result<string>>;
}

export interface CompressResult {
  readonly messages: readonly Message[];
  /** Human-facing description of what was compacted — shown by the loop, never hidden. */
  readonly droppedSummary: string;
  readonly tokensSaved: number;
}

export async function compressContext(params: CompressParams): Promise<Result<CompressResult>> {
  const { messages, keepHead, keepTail, summarize } = params;
  const head = messages.slice(0, keepHead);
  const tail = keepTail > 0 ? messages.slice(messages.length - keepTail) : [];
  const middle = messages.slice(keepHead, messages.length - keepTail);

  // Nothing in the middle to compact — return the list unchanged (no-op is a success).
  if (middle.length === 0) {
    return { ok: true, value: { messages, droppedSummary: '', tokensSaved: 0 } };
  }

  const summarized = await summarize(middle);
  if (!summarized.ok) return summarized;

  // `user`, not `system`: the summary is spliced in at index keepHead (mid-array), and real provider
  // APIs reject a `system` entry anywhere but position 0. A bracketed user message is valid anywhere.
  const summaryMessage: Message = {
    role: 'user',
    content: `[Context summary of ${middle.length} earlier messages — task intent + recent work preserved]\n${summarized.value}`,
  };
  const rewritten = [...head, summaryMessage, ...tail];

  // Clamp to 0: a verbose summary could in theory be longer than the slice it replaced, and a
  // negative "saved ~-50 tokens" line would be confusing.
  const tokensSaved = Math.max(
    0,
    estimateMessagesTokens(middle) - estimateTokens(summaryMessage.content),
  );
  return {
    ok: true,
    value: { messages: rewritten, droppedSummary: summarized.value, tokensSaved },
  };
}
