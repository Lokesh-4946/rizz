// The agent loop (orchestration). One user instruction → one completed turn: call the model,
// dispatch any tool calls, feed results back, repeat — bounded by the budget and a hard iteration
// backstop. The loop decides *why/when* (compress, retry, fall back, approve, stop, surface); every
// network call and command runs through a service that returns Result<T> (ADR-001). It never makes a
// raw provider call or touches the filesystem itself.

import {
  type ApprovalDecision,
  type ApprovalRequest,
  type Message,
  type ModelInfo,
  type Provider,
  type Result,
  RizzError,
  type SessionStore,
  TOOL_SPECS,
  type ToolSpec,
  callModel,
  dispatchTool,
  err,
  estimateCostUsd,
  ok,
} from '@rizz/providers';
import {
  type Budget,
  type BudgetState,
  DEFAULT_BUDGET,
  isExhausted,
  newBudgetState,
  recordUsage,
} from './budget.js';
import { type CompressConfig, maybeCompress, shouldCompress } from './compress.js';
import { type RoutingContext, classifyFailure, runFallback } from './fallback.js';
import type { Session } from './session.js';

/** Streamed orchestration events for the TUI — tool lines, fallback/compaction notes, etc. */
export type TurnEvent =
  | { readonly type: 'assistant'; readonly content: string }
  | { readonly type: 'tool'; readonly display: string; readonly ok: boolean }
  | { readonly type: 'fallback'; readonly note: string }
  | { readonly type: 'compacted'; readonly note: string }
  | { readonly type: 'approval-denied'; readonly command: string }
  | { readonly type: 'notice'; readonly message: string };

export interface RunTurnOptions {
  readonly provider: Provider;
  readonly session: Session;
  readonly input: string;
  /** Workspace root that tool paths resolve against. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly budget?: Budget;
  readonly budgetState?: BudgetState;
  /** Tool loadout offered to the model. Defaults to the strict four (D-018). */
  readonly tools?: readonly ToolSpec[];
  /** Hard backstop against a runaway tool loop (latent-demands §4). Default 50. */
  readonly iterationBackstop?: number;
  /** Active model — used for cost accounting. */
  readonly model?: ModelInfo;
  /** Subscription path → cost is always $0 (D-021). Default true. */
  readonly subscription?: boolean;
  /** Enables visible model fallback on retryable failures. Omitted → single-provider mode. */
  readonly routing?: RoutingContext;
  /** Enables context compaction. Omitted → never compress (e.g. short sessions / tests). */
  readonly compress?: CompressConfig;
  /** Persists each new message + running totals. Omitted → in-memory only (e.g. print mode / tests). */
  readonly store?: SessionStore;
  readonly sessionId?: string;
  readonly onApprovalNeeded?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  readonly onChunk?: (text: string) => void;
  readonly onEvent?: (event: TurnEvent) => void;
}

export type StopReason = 'final' | 'backstop' | 'interrupted';

export interface TurnResult {
  readonly content: string;
  readonly budgetState: BudgetState;
  readonly stopReason: StopReason;
}

const MAX_REPAIRS = 2;

function budgetExceeded(state: BudgetState): RizzError {
  return new RizzError(
    'BUDGET_EXCEEDED',
    `budget reached (${state.turns} turns, ${state.tokens} tokens, $${state.costUsd.toFixed(2)})`,
  );
}

/** A model-backed summarizer for compaction, bound to the currently active provider. */
function makeSummarizer(provider: Provider) {
  return async (slice: readonly Message[]): Promise<Result<string>> => {
    // Flatten the slice into ONE user message. Passing the raw slice would forward orphan `tool`
    // (and `assistant` tool-call) messages that real provider APIs reject because their originating
    // tool_use isn't in the request — which would make compaction fail for any tool-using session.
    const transcript = slice.map((m) => `${m.role}: ${m.content}`).join('\n\n');
    const reply = await callModel({
      provider,
      messages: [
        {
          role: 'system',
          content:
            'Summarize the following conversation transcript faithfully and concisely. Preserve decisions, file paths, and any open threads.',
        },
        { role: 'user', content: transcript },
      ],
    });
    if (!reply.ok) return reply;
    return ok(reply.value.content);
  };
}

export async function runTurn(options: RunTurnOptions): Promise<Result<TurnResult>> {
  const { provider, session, input, cwd, signal, onEvent, onApprovalNeeded, onChunk, routing } =
    options;
  const budget = options.budget ?? DEFAULT_BUDGET;
  const budgetState = options.budgetState ?? newBudgetState();
  const tools = options.tools ?? TOOL_SPECS;
  const backstop = options.iterationBackstop ?? 50;
  const subscription = options.subscription ?? true;
  const compressConfig = options.compress;
  const { store, sessionId } = options;
  const emit = (event: TurnEvent): void => onEvent?.(event);

  // Append a new message to the in-memory session AND, when a store is wired, to disk. Compaction is
  // deliberately NOT persisted: the store keeps the full history (design §4); only the in-context
  // window is compressed. A persistence failure surfaces a notice but never loses the turn.
  const pushMessage = async (message: Message): Promise<void> => {
    session.messages.push(message);
    if (store !== undefined && sessionId !== undefined) {
      const appended = await store.append(sessionId, message);
      if (!appended.ok)
        emit({ type: 'notice', message: `session not persisted: ${appended.error.code}` });
    }
  };
  const persistTotals = async (): Promise<void> => {
    if (store !== undefined && sessionId !== undefined) {
      await store.updateMeta(sessionId, {
        tokens: budgetState.tokens,
        costUsd: budgetState.costUsd,
      });
    }
  };

  // Guard BEFORE mutating the session (M2 invariant): if the turn can't even start, the user message
  // must not land in history, or a retry would duplicate it.
  if (signal?.aborted) return err(new RizzError('INTERRUPTED', 'turn interrupted'));
  if (isExhausted(budgetState, budget)) return err(budgetExceeded(budgetState));

  await pushMessage({ role: 'user', content: input });

  let activeProvider = provider;
  let activeModel = options.model;
  let lastContent = '';
  let repairs = 0;

  for (let iteration = 0; iteration < backstop; iteration += 1) {
    // Mid-turn interrupt: the partial turn is preserved in the session, never silently dropped.
    if (signal?.aborted) return err(new RizzError('INTERRUPTED', 'turn interrupted'));
    if (isExhausted(budgetState, budget)) return err(budgetExceeded(budgetState));

    if (compressConfig && shouldCompress(session.messages, compressConfig)) {
      const compacted = await maybeCompress(
        session.messages,
        compressConfig,
        makeSummarizer(activeProvider),
      );
      if (compacted.ok && compacted.value.note !== undefined) {
        session.messages.splice(0, session.messages.length, ...compacted.value.messages);
        emit({ type: 'compacted', note: compacted.value.note });
      } else if (!compacted.ok) {
        // Best-effort: a failed compaction must not kill the turn, but we never swallow it silently.
        emit({ type: 'notice', message: `compaction skipped: ${compacted.error.code}` });
      }
    }

    const reply = await callModel({
      provider: activeProvider,
      messages: session.messages,
      tools,
      ...(signal ? { signal } : {}),
      ...(onChunk ? { onChunk } : {}),
    });

    if (!reply.ok) {
      const action = classifyFailure(reply.error.code);
      if (action === 'fallback' && routing && activeModel) {
        const fb = runFallback(routing, { modelId: activeModel.id, code: reply.error.code });
        if (fb.ok) {
          activeProvider = fb.value.provider;
          activeModel = fb.value.model;
          emit({ type: 'fallback', note: fb.value.note });
          continue;
        }
        return fb; // chain exhausted → surface
      }
      if (action === 'repair' && repairs < MAX_REPAIRS) {
        repairs += 1;
        // `user`, not `system`: the Messages API takes the system prompt as a top-level param, so a
        // mid-conversation system message is a 400. A user-role nudge is valid across providers.
        await pushMessage({
          role: 'user',
          content: 'Your previous tool call was malformed. Re-emit a single valid tool call.',
        });
        continue;
      }
      return reply; // surface (auth, budget, exhausted repairs, unexpected)
    }

    const { usage, content, toolCalls } = reply.value;
    const costUsd =
      subscription || activeModel === undefined
        ? 0
        : estimateCostUsd(activeModel, usage, { subscription: false });
    recordUsage(budgetState, { ...usage, costUsd });
    await persistTotals();

    lastContent = content;
    if (content !== '') {
      await pushMessage({ role: 'assistant', content });
      emit({ type: 'assistant', content });
    }

    if (toolCalls.length === 0) {
      return ok({ content: lastContent, budgetState, stopReason: 'final' });
    }

    for (const call of toolCalls) {
      const dispatched = await dispatchTool({
        call,
        cwd,
        ...(signal ? { signal } : {}),
        ...(onApprovalNeeded ? { onApprovalNeeded } : {}),
      });

      if (!dispatched.ok) {
        // Feed the failure back to the model so it can adjust — never a silent tool failure.
        await pushMessage({
          role: 'tool',
          content: `tool ${call.name} failed — ${dispatched.error.code}: ${dispatched.error.message}`,
          ...(call.id !== undefined ? { toolCallId: call.id } : {}),
        });
        emit({ type: 'tool', display: `${call.name} · ${dispatched.error.code}`, ok: false });
      } else {
        await pushMessage({
          role: 'tool',
          content: dispatched.value.forModel,
          ...(call.id !== undefined ? { toolCallId: call.id } : {}),
        });
        emit({ type: 'tool', display: dispatched.value.forDisplay, ok: true });
        if (dispatched.value.meta?.denied === true) {
          emit({ type: 'approval-denied', command: String(call.args.command ?? '') });
        }
      }

      // Finish the current tool, then stop before starting the next if interrupted (design §1.4).
      if (signal?.aborted) return err(new RizzError('INTERRUPTED', 'turn interrupted'));
    }
  }

  return ok({ content: lastContent, budgetState, stopReason: 'backstop' });
}
