// Rough token estimate (~4 chars/token). A cheap, dependency-free heuristic good enough to drive
// the compression trigger and the status-bar context gauge; the real per-call token counts come from
// provider usage (callModel). Not exact — never used for billing, only for "are we near the window?".

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: readonly { content: string }[]): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content);
  return total;
}
