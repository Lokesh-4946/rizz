// A no-network provider for the walking skeleton. It echoes a short demo reply so the loop and TUI
// can be exercised end-to-end before the real subscription adapter lands (M3). Implements the
// Provider service contract exactly, so swapping in the Claude adapter is a one-line change.

import type { CompletionRequest, CompletionResult, Provider } from './provider.js';
import { type Result, RizzError, err, ok } from './result.js';

/** Rough token estimate (~4 chars/token) — placeholder until real provider usage is wired in M3. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

export class StubProvider implements Provider {
  readonly id = 'stub';
  readonly label = 'demo (no provider)';

  async complete(request: CompletionRequest): Promise<Result<CompletionResult>> {
    if (request.signal?.aborted) {
      return err(new RizzError('INTERRUPTED', 'turn interrupted before the model replied'));
    }

    const prompt = request.messages.at(-1)?.content ?? '';
    const said = truncate(prompt, 200);
    // Concise demo reply — the persistent "/login to go live" hint is the TUI's demo banner (D-032),
    // so this no longer re-nags every turn.
    const content = `(demo) I can't run a real turn yet. You said: "${said}".`;

    return ok({
      content,
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(content),
    });
  }
}
