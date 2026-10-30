import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareProjectStore, resolveRizzHome } from '../project-store.js';
import { readBrainText } from './brain-index.js';
import { appendSpoolEvent, foldSpool } from './fold.js';
import { readText } from './io.js';
import { type HostId, type ObserveEvent, isHostId, isRecord, normalizeHook } from './model.js';
import { ensureObserveVault, readLatestHandoff } from './notes.js';
import { observePaths } from './paths.js';
import { staffOk } from './result.js';
import { composeSessionContext } from './session-context.js';

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

export function hookStdout(tool: HostId, hook: string, context: string): string {
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
    return `${JSON.stringify({ continue: true })}\n`;
  }
  return '{}\n';
}

const MISSING_BRAIN = 'Rizz has no brain for this folder yet. Run rizz init here.';

async function sessionMaterial(
  rizzHome: string,
  projectRoot: string,
): Promise<{ readonly brain: string; readonly handoff: string | undefined }> {
  let root = projectRoot;
  try {
    root = await realpath(projectRoot);
  } catch {
    return { brain: MISSING_BRAIN, handoff: undefined };
  }
  const registry = await readText(join(rizzHome, 'registry.json'));
  if (!registry.ok || registry.value === undefined) {
    return { brain: MISSING_BRAIN, handoff: undefined };
  }
  try {
    const parsed: unknown = JSON.parse(registry.value);
    if (!isRecord(parsed) || !isRecord(parsed.projects)) {
      return { brain: MISSING_BRAIN, handoff: undefined };
    }
    for (const entry of Object.values(parsed.projects)) {
      if (!isRecord(entry) || entry.root_path !== root) continue;
      if (typeof entry.project_dir !== 'string') continue;
      const paths = observePaths(entry.project_dir);
      const brain = await readBrainText(paths.brain);
      const handoff = await readLatestHandoff(paths.handoffsDir);
      const brainText = brain.ok && brain.value.trim() !== '' ? brain.value : MISSING_BRAIN;
      return { brain: brainText, handoff: handoff.ok ? handoff.value : undefined };
    }
  } catch {
    return { brain: MISSING_BRAIN, handoff: undefined };
  }
  return { brain: MISSING_BRAIN, handoff: undefined };
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
  const at = options.at ?? new Date().toISOString();
  const event: ObserveEvent = normalizeHook({
    tool,
    hook,
    payload,
    projectRoot,
    at,
  });
  const spooled = await appendSpoolEvent(rizzHome, event);
  let stderr = '';
  if (!spooled.ok) stderr = `rizz: ${spooled.error.message}\n`;
  else if (spooled.value === 'dropped') stderr = 'rizz: hook event could not be recorded\n';
  const session = hook === 'sessionStart' || hook === 'SessionStart';
  if (session) {
    const folded = await foldSpool(rizzHome, {
      recoverKilled: true,
      exceptThreadId: event.threadId,
      at,
    });
    if (!folded.ok) stderr += `rizz: ${folded.error.message}\n`;
  }
  const material = session ? await sessionMaterial(rizzHome, projectRoot) : undefined;
  const context =
    material === undefined ? '' : composeSessionContext(material.brain, material.handoff);
  return { exitCode: 0, stdout: hookStdout(tool, hook, context), stderr };
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
