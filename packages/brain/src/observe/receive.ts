import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareProjectStore, resolveRizzHome } from '../project-store.js';
import { readBrainText } from './brain-index.js';
import { appendSpoolEvent } from './fold.js';
import { readText } from './io.js';
import {
  type HostId,
  type ObserveEvent,
  hasSharedTurnIdentity,
  isHostId,
  isRecord,
  normalizeHook,
} from './model.js';
import { ensureObserveVault } from './notes.js';
import { observePaths } from './paths.js';
import { refreshRelayBrain, takeUnreadRelayContext } from './relay/board.js';
import { listRelays } from './relay/config.js';
import { queueRelayPrompt } from './relay/delivery.js';
import { staffOk } from './result.js';

export interface HookResponse {
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
}

function projectRootFrom(payload: Record<string, unknown>, fallback: string): string {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0] !== '') return roots[0];
  if (typeof payload.cwd === 'string' && payload.cwd !== '') return payload.cwd;
  return fallback;
}

function withQuote(brainText: string, extra: string): string {
  const base = brainText.trim() === '' ? 'Rizz brain index is empty.' : brainText.slice(0, 6000);
  if (extra.trim() === '') return base;
  return `${base}\n\n${extra.trim()}`;
}

function promptStdout(tool: HostId, hook: string, extra: string): string {
  if (extra.trim() === '') return `${JSON.stringify({ continue: true })}\n`;
  const text = extra.trim();
  if (tool === 'claude') {
    return `${JSON.stringify({
      continue: true,
      hookSpecificOutput: { hookEventName: hook, additionalContext: text },
    })}\n`;
  }
  if (tool === 'codex') return `${JSON.stringify({ continue: true, additionalContext: text })}\n`;
  return `${JSON.stringify({ continue: true, additional_context: text })}\n`;
}

export function hookStdout(tool: HostId, hook: string, brainText: string, extra = ''): string {
  const context = withQuote(brainText, extra);
  if (hook === 'sessionStart') {
    return `${JSON.stringify({ additional_context: context })}\n`;
  }
  if (hook === 'SessionStart' && tool === 'codex') {
    return `${JSON.stringify({ additionalContext: context })}\n`;
  }
  if (hook === 'SessionStart' && tool === 'claude') {
    return `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    })}\n`;
  }
  if (hook === 'beforeSubmitPrompt' || hook === 'UserPromptSubmit') {
    return promptStdout(tool, hook, extra);
  }
  return '{}\n';
}

async function existingBrain(rizzHome: string, projectRoot: string): Promise<string> {
  let root = projectRoot;
  try {
    root = await realpath(projectRoot);
  } catch {
    return 'Rizz has no brain for this folder yet. Run rizz init here.';
  }
  const registry = await readText(join(rizzHome, 'registry.json'));
  if (!registry.ok || registry.value === undefined) {
    return 'Rizz has no brain for this folder yet. Run rizz init here.';
  }
  try {
    const parsed: unknown = JSON.parse(registry.value);
    if (!isRecord(parsed) || !isRecord(parsed.projects)) {
      return 'Rizz has no brain for this folder yet. Run rizz init here.';
    }
    for (const entry of Object.values(parsed.projects)) {
      if (!isRecord(entry) || entry.root_path !== root) continue;
      if (typeof entry.project_dir !== 'string') continue;
      const brain = await readBrainText(join(entry.project_dir, 'observe', 'BRAIN.md'));
      if (brain.ok && brain.value.trim() !== '') return brain.value;
    }
  } catch {
    return 'Rizz has no brain for this folder yet. Run rizz init here.';
  }
  return 'Rizz has no brain for this folder yet. Run rizz init here.';
}

/** Record one host hook. Always exit 0 so the host is never blocked. */
export async function receiveHook(options: {
  readonly tool: string;
  readonly hook: string;
  readonly stdin: string;
  readonly projectRoot: string;
  readonly rizzHome?: string;
  readonly at?: string;
}): Promise<HookResponse> {
  const tool = isHostId(options.tool) ? options.tool : undefined;
  if (tool === undefined) {
    return { exitCode: 0, stdout: '{}\n', stderr: `rizz: unknown host '${options.tool}'\n` };
  }
  let payload: Record<string, unknown> = {};
  const trimmed = options.stdin.trim();
  if (trimmed !== '') {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) payload = parsed;
    } catch {
      return {
        exitCode: 0,
        stdout: '{}\n',
        stderr: 'rizz: hook payload was not JSON; nothing recorded\n',
      };
    }
  }
  const hook = options.hook !== '' ? options.hook : String(payload.hook_event_name ?? 'stop');
  const rizzHome = options.rizzHome ?? resolveRizzHome();
  const projectRoot = projectRootFrom(payload, options.projectRoot);
  const event: ObserveEvent = normalizeHook({
    tool,
    hook,
    payload,
    projectRoot,
    at: options.at ?? new Date().toISOString(),
  });
  const spooled = await appendSpoolEvent(rizzHome, event, {
    stampSequence: hasSharedTurnIdentity(payload),
  });
  let stderr = '';
  const recordedId = spooled.ok ? spooled.value.id : event.id;
  if (!spooled.ok) stderr = `rizz: ${spooled.error.message}\n`;
  else if (spooled.value.status === 'dropped') stderr = 'rizz: hook event could not be recorded\n';
  const isPrompt = hook === 'beforeSubmitPrompt' || hook === 'UserPromptSubmit';
  const isSession = hook === 'sessionStart' || hook === 'SessionStart';
  let note = '';
  if (isPrompt && typeof payload.prompt === 'string') {
    const queued = await queueRelayPrompt({
      rizzHome,
      projectRoot,
      prompt: payload.prompt,
      sourceEventId: recordedId,
      at: event.at,
    });
    note = queued.note;
    if (note.startsWith('Rizz did not')) stderr += `rizz: ${note}\n`;
  }
  const quoted =
    isPrompt || isSession
      ? await takeUnreadRelayContext({ rizzHome, projectRoot, now: event.at })
      : '';
  const extra = [note, quoted].filter((part) => part !== '').join('\n\n');
  if (isSession) {
    const relays = await listRelays(rizzHome);
    if (relays.ok && relays.value.length > 0) {
      await refreshRelayBrain({ rizzHome, projectRoot, now: new Date().toISOString() });
    }
  }
  const brain = isSession ? await existingBrain(rizzHome, projectRoot) : '';
  return { exitCode: 0, stdout: hookStdout(tool, hook, brain, extra), stderr };
}

export async function initObserver(options: {
  readonly projectRoot: string;
  readonly rizzHome?: string;
  readonly hosts: readonly HostId[];
  readonly homeDir: string;
  readonly bridge: boolean;
}): Promise<
  | {
      readonly ok: true;
      readonly value: {
        readonly brainPath: string;
        readonly projectDir: string;
        readonly hooks: readonly string[];
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
> {
  const prepared = await prepareProjectStore({
    rootDir: options.projectRoot,
    ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
  });
  if (!prepared.ok) return prepared;
  const paths = observePaths(prepared.value.projectDir);
  const vault = await ensureObserveVault(paths);
  if (!vault.ok) return { ok: false, error: vault.error };
  const { installHostHooks, writeOptInBridge } = await import('./install.js');
  const hooks = await installHostHooks(options.homeDir, options.hosts);
  if (!hooks.ok) return { ok: false, error: hooks.error };
  if (options.bridge) {
    const bridge = await writeOptInBridge({
      projectRoot: options.projectRoot,
      brainPath: paths.brain,
    });
    if (!bridge.ok) return { ok: false, error: bridge.error };
  }
  const brain = await readBrainText(paths.brain);
  if (brain.ok && brain.value.trim() === '') {
    const { snapshotFromEvents, writeBrain, visionQuote } = await import('./brain-index.js');
    const vision = await readText(paths.vision);
    if (!vision.ok) return { ok: false, error: vision.error };
    const written = await writeBrain(
      paths.brain,
      snapshotFromEvents([], {
        updated: new Date().toISOString(),
        projectRoot: prepared.value.rootPath,
        decisions: [],
        inbox: [],
        visionQuote: visionQuote(vision.value ?? ''),
      }),
    );
    if (!written.ok) return { ok: false, error: written.error };
  }
  return staffOk({
    brainPath: paths.brain,
    projectDir: prepared.value.projectDir,
    hooks: hooks.value,
  });
}
