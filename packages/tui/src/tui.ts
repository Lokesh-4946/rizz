// Simple-mode interactive TUI (UI/UX spec §4/§5). Zero runtime dependencies — built on node:readline
// + the theme's ANSI (decision D-015). It renders streamed turn events (tool lines, visible fallback,
// compaction notes), prompts inline for command approval, shows the live budget, and routes the slash
// commands `/login` (BYOK key → keychain, D-033), `/model` (picker + hot-swap, D-029), `/theme`
// (hot-swap across the color-depth ladder), and `/plan` (visible stub, D-030). Demo mode is a single
// quiet banner; commands route to their handler rather than being echoed back as chat (D-032).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type AuthKind,
  DEFAULT_COMPRESS,
  type ResolvedProvider,
  type Session,
  type TurnEvent,
  createSession,
  loginWithApiKey,
  newBudgetState,
  providerFromKey,
  resolveProvider,
  runTurn,
} from '@rizz/core';
import {
  DEFAULT_REGISTRY,
  type ModelInfo,
  type Provider,
  type SecretStore,
  type SessionStore,
  StubProvider,
  estimateMessagesTokens,
  listToolCapable,
  openSecretStore,
  openSessionStore,
} from '@rizz/providers';
import { PROVIDER_CATALOG } from './catalog.js';
import { parseCommand, parseThemeArg } from './commands.js';
import {
  type PickerModel,
  renderEmptyState,
  renderHeader,
  renderHint,
  renderModelPicker,
  renderNotConnected,
  renderPlanStub,
  renderStatusBar,
  renderStillWaiting,
  renderThemeList,
  renderThinking,
} from './render.js';
import { BUILTIN_THEMES, THEME_NAMES, type Theme, createTheme, detectColorDepth } from './theme.js';

export interface TuiOptions {
  readonly provider?: Provider;
  readonly theme?: Theme;
  /** Resume a prior session by id (rehydrates its full message history). */
  readonly resumeId?: string;
  /** Active model (cost accounting + status bar). Omitted in demo mode. */
  readonly model?: ModelInfo;
  /** Subscription/demo path → cost is $0; metered → the running spend is shown. Default true. */
  readonly subscription?: boolean;
  /** Auth label for the status bar. Default 'demo'. */
  readonly auth?: AuthKind;
  /** A one-time startup notice (e.g. a keychain read failure), surfaced before the prompt. */
  readonly notice?: string;
  /** Setup launches use in-memory sessions so route selection does not silently write session files. */
  readonly persistSession?: boolean;
  /** Launch-only preferred display name from setup. It is not persisted by Agent Light. */
  readonly displayName?: string;
}

/** Where sessions persist. Local-first; no cloud (D-011). */
const SESSIONS_DIR = join(homedir(), '.rizz', 'sessions');

interface OpenedSession {
  session: Session;
  sessionId: string | undefined;
  notice?: string;
}

/** Create a fresh persisted session; if the store can't create one, fall back to in-memory and say so. */
async function newSession(store: SessionStore, model: string): Promise<OpenedSession> {
  const created = await store.create({ model, branch: 'dev' });
  if (created.ok) return { session: createSession(), sessionId: created.value };
  // Never swallow it (§3.6): tell the user the turn won't be saved.
  return {
    session: createSession(),
    sessionId: undefined,
    notice: `session store unavailable (${created.error.code}) — running in-memory, nothing will be saved`,
  };
}

/** Resume a session by id (full history), else start fresh. Every failure path surfaces a notice. */
async function openSession(
  store: SessionStore,
  model: string,
  resumeId?: string,
): Promise<OpenedSession> {
  if (resumeId === undefined) return newSession(store, model);

  const loaded = await store.load(resumeId);
  if (loaded.ok) {
    const session = createSession();
    session.messages.push(...loaded.value.messages);
    return { session, sessionId: resumeId };
  }

  // Resume failed — never silently start blank (that IS the /resume failure the PR fixes). Start
  // fresh, surfacing both the resume failure and any store-create failure.
  const fresh = await newSession(store, model);
  const resumeNote = `could not resume session ${resumeId} (${loaded.error.code})`;
  return {
    ...fresh,
    notice:
      fresh.notice !== undefined
        ? `${resumeNote}; ${fresh.notice}`
        : `${resumeNote} — started a new session`,
  };
}

export async function startTui(options: TuiOptions = {}): Promise<void> {
  // Active session state — mutable so /login, /model, and /theme hot-swap without a restart.
  let theme = options.theme ?? createTheme({ depth: detectColorDepth() });
  let activeProvider: Provider = options.provider ?? new StubProvider();
  let activeModel: ModelInfo | undefined = options.model;
  let activeSubscription = options.subscription ?? true;
  let activeAuth: AuthKind = options.auth ?? 'demo';
  // The BYOK key entered via /login, held in memory only (never logged). Lets /model switch models even
  // when the keychain write failed — so a model switch never silently downgrades a live session to demo.
  let sessionApiKey: string | undefined;
  let sessionApiKeyProvider: string | undefined;
  const cwd = process.cwd();

  const store: SessionStore | undefined =
    options.persistSession === false ? undefined : await openSessionStore({ dir: SESSIONS_DIR });
  const secrets: SecretStore = await openSecretStore();
  const budgetState = newBudgetState();
  const opened =
    store === undefined
      ? { session: createSession(), sessionId: undefined, notice: undefined }
      : await openSession(store, activeProvider.label, options.resumeId);
  const { session, sessionId, notice } = opened;
  const modelDisplay = (): string => {
    if (activeAuth === 'subscription' && activeProvider.id === 'codex') {
      return activeModel?.label ?? 'Codex · model not reported';
    }
    if (activeAuth === 'demo') return 'no model';
    return activeModel?.label ?? activeProvider.label;
  };
  const writeLine = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  writeLine(renderHeader(theme, modelDisplay()));
  writeLine('');
  if (options.displayName !== undefined) {
    writeLine(theme.system(`  ${options.displayName}, rizz is ready.`));
  }
  if (options.notice !== undefined) writeLine(theme.alert(`  ⚠ ${options.notice}`));
  if (notice !== undefined) writeLine(theme.alert(`  ⚠ ${notice}`));
  if (activeAuth === 'subscription') {
    writeLine(theme.dim('  Codex subscription active. Model is managed by Codex.'));
  }
  if (activeAuth === 'demo') {
    writeLine(theme.dim('  No model connected. Use /login or /model when ready.'));
  }
  writeLine(renderEmptyState(theme));
  writeLine(renderHint(theme));
  writeLine('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Resolves null if the interface closes (idle Ctrl+C / EOF) so the prompt loop never hangs.
  const ask = (question: string): Promise<string | null> =>
    new Promise((resolve) => {
      const onClose = (): void => resolve(null);
      rl.once('close', onClose);
      rl.question(question, (answer) => {
        rl.off('close', onClose);
        resolve(answer);
      });
    });

  // Read a secret with the echo suppressed so the key never lands in the terminal/scrollback (§3.6).
  // readline has no built-in masked input; overriding `_writeToOutput` is the standard approach. We
  // print the prompt ourselves and then mute EVERYTHING except newlines — robust across Node versions
  // (no reliance on readline echoing the prompt back in a single, exact-match call).
  const askSecret = (question: string): Promise<string | null> =>
    new Promise((resolve) => {
      process.stdout.write(question);
      // reason: `_writeToOutput` is a readline internal — the only hook for muting echo in core Node.
      const internal = rl as unknown as { _writeToOutput?: ((s: string) => void) | undefined };
      const original = internal._writeToOutput;
      const restore = (): void => {
        internal._writeToOutput = original;
      };
      // Swallow keystroke echoes; let newlines through so Enter still advances the line.
      internal._writeToOutput = (s: string): void => {
        if (s.includes('\n')) original?.call(rl, '\n');
      };
      const onClose = (): void => {
        restore();
        resolve(null);
      };
      rl.question('', (answer) => {
        rl.off('close', onClose);
        restore();
        resolve(answer);
      });
      rl.once('close', onClose);
    });

  // One controller per in-flight turn. Ctrl+C aborts a running turn; when idle, it quits.
  let inFlight: AbortController | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const clearProgressTimers = (): void => {
    if (progressTimer !== undefined) clearTimeout(progressTimer);
    progressTimer = undefined;
  };
  const beginTurnProgress = (): void => {
    clearProgressTimers();
    const label =
      activeAuth === 'subscription' && activeProvider.id === 'codex'
        ? 'Codex'
        : activeProvider.label;
    writeLine(renderThinking(theme));
    progressTimer = setTimeout(() => writeLine(renderStillWaiting(theme, label)), 8_000);
  };
  rl.on('SIGINT', () => {
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
      clearProgressTimers();
      writeLine(theme.alert('  ⛌ interrupted'));
      return;
    }
    rl.close();
  });

  const renderEvent = (event: TurnEvent): void => {
    clearProgressTimers();
    switch (event.type) {
      case 'assistant':
        writeLine(theme.text(`  ${event.content}`));
        break;
      case 'tool': {
        const paint = event.ok ? theme.system : theme.alert;
        writeLine(paint(`  ${theme.glyphs.arrow} ${event.display}`));
        break;
      }
      case 'fallback':
        writeLine(theme.alert(`  ↻ ${event.note}`));
        break;
      case 'compacting':
        writeLine(theme.dim('  compacting context...'));
        break;
      case 'compacted':
        writeLine(theme.dim(`  context compacted: ${event.note}`));
        break;
      case 'approval-denied':
        writeLine(theme.dim(`  ${theme.glyphs.cross} denied: ${event.command}`));
        break;
      case 'notice':
        writeLine(theme.dim(`  ${event.message}`));
        break;
    }
  };

  const approve = async (req: {
    command: string;
    kind: 'destructive' | 'networked';
    reason: string;
  }): Promise<{ approved: true } | { approved: false }> => {
    writeLine(theme.alert(`  ⚠ ${req.kind} command needs approval:`));
    writeLine(theme.text(`    ${req.command}`));
    writeLine(theme.dim(`    ${req.reason}`));
    const answer = ((await ask(theme.accent('    approve? [y/N] '))) ?? '').trim().toLowerCase();
    return answer === 'y' || answer === 'yes' ? { approved: true } : { approved: false };
  };

  const statusLine = (): string => {
    const used = estimateMessagesTokens(session.messages);
    const ctxPct = Math.min(100, Math.round((used / DEFAULT_COMPRESS.contextWindow) * 100));
    // $0.00 (sub) on the subscription/demo path; the real running spend on a metered BYOK key.
    const cost = activeSubscription ? '$0.00 (sub)' : `$${budgetState.costUsd.toFixed(2)}`;
    const authDisplay = activeAuth === 'demo' ? 'not connected' : activeAuth;
    return renderStatusBar(theme, {
      model: modelDisplay(),
      auth: authDisplay,
      ctxPct,
      tokens: budgetState.tokens,
      cost,
      branch: 'dev', // TODO: read the active git branch once the workspace service lands.
    });
  };
  /** Apply a resolved provider as the new active model (shared by /login and /model). */
  const adopt = (resolved: ResolvedProvider): void => {
    activeProvider = resolved.provider;
    activeModel = resolved.model;
    activeSubscription = resolved.subscription;
    activeAuth = resolved.auth;
    if (resolved.notice !== undefined) writeLine(theme.dim(`  ${resolved.notice}`));
  };

  const handleLogin = async (): Promise<void> => {
    const loginProvider = activeModel?.provider ?? 'anthropic';
    const loginModelId = activeModel?.id;
    const key = (
      await askSecret(theme.accent(`  paste your ${loginProvider} API key (hidden): `))
    )?.trim();
    if (key === undefined || key === '') {
      writeLine(theme.dim('  login cancelled.'));
      return;
    }
    const { resolved, persisted } = await loginWithApiKey(secrets, key, {
      ...(loginModelId !== undefined ? { modelId: loginModelId } : {}),
    });
    adopt(resolved);
    if (resolved.auth === 'api-key') {
      sessionApiKey = key; // held in memory so /model can switch models without the keychain
      sessionApiKeyProvider = resolved.model?.provider;
      writeLine(theme.system(`  ${theme.glyphs.check} signed in — ${activeProvider.label}`));
      if (!persisted) writeLine(theme.dim('  (key not saved to the keychain — this session only)'));
    } else {
      writeLine(theme.alert('  could not activate that key.'));
    }
  };

  const handleModel = async (): Promise<void> => {
    if (activeAuth === 'subscription' && activeProvider.id === 'codex') {
      writeLine(theme.accent('  Codex subscription'));
      writeLine(theme.text(`  current: ${modelDisplay()}`));
      writeLine(theme.dim('  Codex manages the model for this subscription route.'));
      writeLine(theme.dim('  Use OpenRouter direct for selectable models.'));
      return;
    }
    const modelEntries = listToolCapable(DEFAULT_REGISTRY);
    const models: PickerModel[] = modelEntries.map((m) => ({
      id: m.id,
      label: m.label,
      active: m.id === activeModel?.id,
    }));
    writeLine(renderModelPicker(theme, models, PROVIDER_CATALOG));
    const answer = (await ask(theme.accent('  model #: ')))?.trim() ?? '';
    if (answer === '') return;
    const index = Number.parseInt(answer, 10) - 1;
    const chosen = models[index];
    if (chosen === undefined) {
      writeLine(theme.alert('  no such model.'));
      return;
    }
    const chosenModel = modelEntries[index];
    if (activeAuth !== 'api-key') {
      writeLine(renderNotConnected(theme, chosen.label));
      writeLine(theme.dim('  run /login first to connect a key, then pick a model.'));
      return;
    }
    // Build from the in-memory key when we have it (covers a session-only login); otherwise re-read
    // the keychain/env. Guard against a silent downgrade: never overwrite a live session with demo.
    const resolved =
      sessionApiKey !== undefined && chosenModel?.provider === sessionApiKeyProvider
        ? providerFromKey(sessionApiKey, { modelId: chosen.id })
        : await resolveProvider({ secrets, modelId: chosen.id });
    if (resolved.auth !== 'api-key') {
      writeLine(
        theme.alert("  couldn't re-read your key — keeping the current model. Try /login again."),
      );
      return;
    }
    adopt(resolved);
    writeLine(theme.system(`  ${theme.glyphs.check} switched to ${activeProvider.label}`));
  };

  const handleTheme = (arg: string | undefined): void => {
    const name = parseThemeArg(arg);
    if (name === undefined) {
      writeLine(renderThemeList(theme, THEME_NAMES, theme.name));
      return;
    }
    if (BUILTIN_THEMES[name] === undefined) {
      writeLine(theme.alert(`  unknown theme "${name}" — try: ${THEME_NAMES.join(', ')}`));
      return;
    }
    theme = createTheme({ depth: theme.depth, spec: name });
    writeLine(theme.system(`  ${theme.glyphs.check} theme set to ${name}`));
  };

  const handleChat = async (text: string): Promise<void> => {
    inFlight = new AbortController();
    beginTurnProgress();
    const result = await runTurn({
      provider: activeProvider,
      session,
      input: text,
      cwd,
      signal: inFlight.signal,
      budgetState,
      subscription: activeSubscription,
      ...(activeModel ? { model: activeModel } : {}),
      compress: DEFAULT_COMPRESS,
      ...(store !== undefined ? { store } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      onEvent: renderEvent,
      onApprovalNeeded: approve,
    });
    clearProgressTimers();
    inFlight = null;
    if (!result.ok && result.error.code !== 'INTERRUPTED') {
      writeLine(theme.alert(`  ${result.error.code}: ${result.error.message}`));
    }
    writeLine(statusLine());
  };

  // Returns false to quit the loop. Commands route here (not to the model) — D-032.
  const handleLine = async (line: string): Promise<boolean> => {
    const command = parseCommand(line);
    switch (command.kind) {
      case 'empty':
        return true;
      case 'exit':
        return false;
      case 'help':
        writeLine(renderHint(theme));
        return true;
      case 'login':
        await handleLogin();
        return true;
      case 'model':
        await handleModel();
        return true;
      case 'status':
        writeLine(statusLine());
        if (activeAuth === 'subscription' && activeProvider.id === 'codex') {
          writeLine(theme.dim('  Codex manages the model for this subscription route.'));
        }
        return true;
      case 'theme':
        handleTheme(command.arg);
        return true;
      case 'plan':
        writeLine(renderPlanStub(theme));
        return true;
      case 'workspace':
        writeLine(theme.dim('  workspace mode is opt-in and not connected yet.'));
        return true;
      case 'unknown':
        writeLine(theme.alert(`  unknown command /${command.name} — try /help`));
        return true;
      case 'chat':
        await handleChat(command.text);
        return true;
    }
  };

  for (;;) {
    const line = await ask(theme.accent(`${theme.glyphs.caret} `));
    if (line === null) break; // interface closed (idle Ctrl+C / EOF)
    const keepGoing = await handleLine(line);
    if (!keepGoing) break;
  }
  rl.close();
  writeLine(theme.dim('  bye.'));
}
