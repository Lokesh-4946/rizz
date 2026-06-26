// maybeCompress — the compression TRIGGER (orchestration). It decides *when* to compress; the *how*
// is the compressContext service (@valoir/rizz-providers). Default trigger at 70% of the model's window
// (D-019) — compacting too late loses the thread (latent-demands §3) — and it is user-configurable.
// Head (system + task intent) and tail (recent work) are protected by the service.

import {
  type CompressResult,
  type Message,
  type Result,
  compressContext,
  estimateMessagesTokens,
  ok,
} from '@valoir/rizz-providers';

export interface CompressConfig {
  /** Fraction of the context window that triggers compaction. Default 0.70 (D-019), configurable. */
  readonly triggerRatio: number;
  readonly contextWindow: number;
  /** Messages to protect at the head (system prompt + original task intent). */
  readonly keepHead: number;
  /** Messages to protect at the tail (recent messages + tool results). */
  readonly keepTail: number;
}

export const DEFAULT_COMPRESS: CompressConfig = {
  triggerRatio: 0.7,
  contextWindow: 200_000,
  keepHead: 2,
  keepTail: 8,
};

/** Pure predicate: are we at/over the trigger threshold? */
export function shouldCompress(messages: readonly Message[], config: CompressConfig): boolean {
  const used = estimateMessagesTokens(messages);
  return used >= config.triggerRatio * config.contextWindow;
}

export interface MaybeCompressResult {
  readonly messages: readonly Message[];
  /** Present only when compaction happened — a quiet, visible note for the TUI. */
  readonly note?: string;
}

/**
 * Compress only if over threshold; otherwise return the messages unchanged. The summarizer is
 * model-backed and supplied by the loop. The loop swaps the returned list into the session — this
 * function never mutates session state (ADR-001 rule 2).
 */
export async function maybeCompress(
  messages: readonly Message[],
  config: CompressConfig,
  summarize: (slice: readonly Message[]) => Promise<Result<string>>,
): Promise<Result<MaybeCompressResult>> {
  if (!shouldCompress(messages, config)) {
    return ok({ messages });
  }

  const compressed: Result<CompressResult> = await compressContext({
    messages,
    keepHead: config.keepHead,
    keepTail: config.keepTail,
    targetTokens: Math.floor(config.triggerRatio * config.contextWindow * 0.5),
    summarize,
  });
  if (!compressed.ok) return compressed;

  const { messages: rewritten, tokensSaved } = compressed.value;
  return ok({
    messages: rewritten,
    note: `compacted context (kept task + recent work) — saved ~${tokensSaved} tokens · /context to view`,
  });
}
