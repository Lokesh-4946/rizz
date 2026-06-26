// Headless interfaces (job #3 — the interop hub, §12). Two ways to drive rizz without the TUI:
//   • one-shot JSON  — a turn in, a structured JSON result out (pipelines, CI, scripts);
//   • RPC            — a long-lived stdin/stdout line protocol another process drives (the deferred
//                      Telegram bridge D-036, editors, agents).
// Both are ORCHESTRATION over the existing loop + services (ADR-001/D-024) — they reuse runTurn, never
// fork it; services stay pure. The bash approve/deny gate is a protocol message in RPC — a remote
// driver must answer it; destructive/networked commands are NEVER auto-approved (one-shot JSON denies
// them outright, since there is no channel to ask). Core-light: no new deps, JSON only.

import type { ModelInfo, Provider, SessionStore } from '@valoir/rizz-providers';
import { type BudgetState, newBudgetState } from './budget.js';
import { type StopReason, type TurnEvent, runTurn } from './loop.js';
import { type Session, createSession } from './session.js';

/** The resolved active provider the CLI hands to a headless runner (it does the auth, not these). */
export interface HeadlessProvider {
  readonly provider: Provider;
  readonly model?: ModelInfo;
  readonly subscription: boolean;
}

// --- One-shot JSON ---

/** One tool the turn ran, as the loop's compact display line + whether it succeeded. */
export interface JsonToolCall {
  readonly display: string;
  readonly ok: boolean;
}

export interface JsonTurnResult {
  readonly ok: boolean;
  readonly reply?: string;
  readonly model?: string;
  readonly toolCalls?: readonly JsonToolCall[];
  readonly usage?: { readonly tokens: number };
  readonly costUsd?: number;
  readonly stopReason?: StopReason;
  /** Present when ok=false — a stable RizzError code + message (never a raw stack). */
  readonly error?: { readonly code: string; readonly message: string };
}

export interface RunJsonTurnParams {
  readonly resolved: HeadlessProvider;
  readonly input: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

/**
 * Run one turn and return a structured result. No approval channel → destructive/networked bash is
 * denied by the loop (safe headless default); read-only tools run. Stable error codes on failure.
 */
export async function runJsonTurn(params: RunJsonTurnParams): Promise<JsonTurnResult> {
  const { resolved, input, cwd, signal } = params;
  const budgetState = newBudgetState();
  const toolCalls: JsonToolCall[] = [];
  const result = await runTurn({
    provider: resolved.provider,
    session: createSession(),
    input,
    cwd,
    subscription: resolved.subscription,
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(signal ? { signal } : {}),
    budgetState,
    onEvent: (event) => {
      if (event.type === 'tool') toolCalls.push({ display: event.display, ok: event.ok });
    },
  });
  if (!result.ok) {
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  }
  return {
    ok: true,
    reply: result.value.content,
    ...(resolved.model ? { model: resolved.model.id } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage: { tokens: result.value.budgetState.tokens },
    costUsd: result.value.budgetState.costUsd,
    stopReason: result.value.stopReason,
  };
}

// --- RPC (line-delimited JSON) ---

/** Client → server. Each carries an `id` echoed on the matching response. */
export interface RpcRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface RpcServerOptions {
  readonly resolved: HeadlessProvider;
  readonly cwd: string;
  /** Optional persistence; without it sessions are in-memory and resume is unavailable. */
  readonly store?: SessionStore;
  /** Emits one framed JSON line (impl appends the newline). */
  readonly write: (line: string) => void;
}

export interface RpcServer {
  /** Feed one inbound line. Returns when the line has been dispatched (a turn runs in the background). */
  handle(line: string): Promise<void>;
}

interface ActiveSession {
  readonly session: Session;
  readonly sessionId: string | undefined;
  readonly budgetState: BudgetState;
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function createRpcServer(options: RpcServerOptions): RpcServer {
  const { resolved, cwd, store, write } = options;
  const emit = (message: object): void => write(`${JSON.stringify(message)}\n`);
  const respond = (id: RpcRequest['id'], result: object): void => emit({ id, result });
  const fail = (id: RpcRequest['id'], code: string, message: string): void =>
    emit({ id, error: { code, message } });

  let active: ActiveSession | undefined;
  let turnInFlight = false;
  // Pending bash approvals: the loop is parked until the client answers with an `approve` request.
  const pendingApprovals = new Map<
    string,
    (decision: { approved: boolean; editedCommand?: string }) => void
  >();
  let approvalSeq = 0;

  const startSession = async (id: RpcRequest['id']): Promise<void> => {
    if (store !== undefined) {
      const created = await store.create({ model: resolved.model?.label ?? 'demo', branch: 'dev' });
      if (created.ok) {
        active = {
          session: createSession(),
          sessionId: created.value,
          budgetState: newBudgetState(),
        };
        respond(id, { sessionId: created.value });
        return;
      }
      // Store failure → in-memory, but say so (never silently drop persistence — §3.6).
      active = { session: createSession(), sessionId: undefined, budgetState: newBudgetState() };
      respond(id, {
        sessionId: null,
        note: `store unavailable (${created.error.code}) — in-memory`,
      });
      return;
    }
    active = { session: createSession(), sessionId: undefined, budgetState: newBudgetState() };
    respond(id, { sessionId: null, note: 'in-memory session (no store wired)' });
  };

  const resumeSession = async (
    id: RpcRequest['id'],
    sessionId: string | undefined,
  ): Promise<void> => {
    if (sessionId === undefined) {
      fail(id, 'BAD_REQUEST', 'session.resume needs a string sessionId');
      return;
    }
    if (store === undefined) {
      fail(id, 'BAD_REQUEST', 'no session store wired — cannot resume');
      return;
    }
    const loaded = await store.load(sessionId);
    if (!loaded.ok) {
      fail(id, loaded.error.code, loaded.error.message);
      return;
    }
    const session = createSession();
    session.messages.push(...loaded.value.messages);
    active = { session, sessionId, budgetState: newBudgetState() };
    respond(id, { sessionId, messages: loaded.value.messages.length });
  };

  const runTurnRpc = (id: RpcRequest['id'], input: string | undefined): void => {
    if (input === undefined) {
      fail(id, 'BAD_REQUEST', 'turn needs a string input');
      return;
    }
    if (active === undefined) {
      fail(id, 'BAD_REQUEST', 'no active session — call session.start or session.resume first');
      return;
    }
    if (turnInFlight) {
      fail(id, 'BAD_REQUEST', 'a turn is already running');
      return;
    }
    turnInFlight = true;
    const current = active;

    const onEvent = (event: TurnEvent): void => emit({ method: 'event', params: event });
    const onChunk = (delta: string): void =>
      emit({ method: 'event', params: { type: 'chunk', delta } });
    // The approval gate as a protocol message: emit a request, park until the client answers.
    const onApprovalNeeded = (req: {
      command: string;
      kind: 'destructive' | 'networked';
      reason: string;
    }) =>
      new Promise<{ approved: boolean; editedCommand?: string }>((resolve) => {
        approvalSeq += 1;
        const requestId = `${id}:${approvalSeq}`;
        pendingApprovals.set(requestId, resolve);
        emit({ method: 'approval', params: { requestId, ...req } });
      });

    runTurn({
      provider: resolved.provider,
      session: current.session,
      input,
      cwd,
      subscription: resolved.subscription,
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(store !== undefined && current.sessionId !== undefined
        ? { store, sessionId: current.sessionId }
        : {}),
      budgetState: current.budgetState,
      onEvent,
      onChunk,
      onApprovalNeeded,
    })
      .then((result) => {
        if (result.ok) {
          respond(id, {
            reply: result.value.content,
            stopReason: result.value.stopReason,
            usage: { tokens: current.budgetState.tokens },
            costUsd: current.budgetState.costUsd,
          });
        } else {
          fail(id, result.error.code, result.error.message);
        }
      })
      .finally(() => {
        turnInFlight = false;
      });
  };

  const applyApproval = (
    id: RpcRequest['id'],
    params: Record<string, unknown> | undefined,
  ): void => {
    const requestId = asString(params?.requestId);
    if (requestId === undefined) {
      fail(id, 'BAD_REQUEST', 'approve needs a string requestId');
      return;
    }
    const resolve = pendingApprovals.get(requestId);
    if (resolve === undefined) {
      fail(id, 'BAD_REQUEST', `no pending approval "${requestId}"`);
      return;
    }
    pendingApprovals.delete(requestId);
    const approved = params?.approved === true;
    const editedCommand = asString(params?.editedCommand);
    resolve({ approved, ...(editedCommand !== undefined ? { editedCommand } : {}) });
    respond(id, { ok: true });
  };

  async function dispatch(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let request: RpcRequest;
    try {
      request = JSON.parse(trimmed) as RpcRequest;
    } catch {
      emit({ id: null, error: { code: 'BAD_REQUEST', message: 'malformed JSON line' } });
      return;
    }
    const { id, method, params } = request;
    switch (method) {
      case 'session.start':
        await startSession(id);
        return;
      case 'session.resume':
        await resumeSession(id, asString(params?.sessionId));
        return;
      case 'turn':
        runTurnRpc(id, asString(params?.input));
        return;
      case 'approve':
        applyApproval(id, params);
        return;
      default:
        fail(id, 'BAD_REQUEST', `unknown method "${method}"`);
        return;
    }
  }

  // Serialize dispatch in arrival order so a `turn` after `session.start` always sees the session,
  // even when a transport fires lines without awaiting (e.g. readline's 'line' events). Each dispatch
  // resolves quickly — a turn runs in the background — so `approve` can still be processed mid-turn.
  let chain: Promise<void> = Promise.resolve();
  function handle(line: string): Promise<void> {
    chain = chain.then(() => dispatch(line));
    return chain;
  }

  return { handle };
}
