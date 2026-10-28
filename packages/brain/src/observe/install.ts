import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readText, writeAtomic } from './io.js';
import { type HostId, isRecord } from './model.js';
import { type StaffResult, staffErr, staffOk } from './result.js';

export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'beforeSubmitPrompt',
  'afterFileEdit',
  'afterShellExecution',
  'postToolUse',
  'subagentStart',
  'subagentStop',
  'afterAgentResponse',
  'preCompact',
  'stop',
  'sessionEnd',
] as const;

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'SubagentStop',
  'Stop',
  'SessionEnd',
] as const;

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Stop',
] as const;

export function hookCommand(tool: HostId, event: string): string {
  return `rizz hook ${tool} ${event}`;
}

/** Legacy Codex notify. Not installed by default; hooks.json is the primary path. */
export function legacyCodexNotifyLine(): string {
  return 'notify = ["rizz", "hook", "codex", "notify"]';
}

function cursorHooks(): Record<string, { command: string }[]> {
  const hooks: Record<string, { command: string }[]> = {};
  for (const event of CURSOR_HOOK_EVENTS) {
    hooks[event] = [{ command: hookCommand('cursor', event) }];
  }
  return hooks;
}

export async function installCursorHooks(homeDir: string): Promise<StaffResult<string>> {
  const path = join(homeDir, '.cursor', 'hooks.json');
  const existing = await readText(path);
  if (!existing.ok) return existing;
  let root: Record<string, unknown> = { version: 1, hooks: {} };
  if (existing.value !== undefined && existing.value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(existing.value);
      if (!isRecord(parsed)) return staffErr('INVALID_STATE', 'cursor hooks.json is not an object');
      root = parsed;
    } catch {
      return staffErr('INVALID_STATE', 'cursor hooks.json is not JSON');
    }
  }
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  for (const [event, entries] of Object.entries(cursorHooks())) {
    const current = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    const command = entries[0]?.command ?? hookCommand('cursor', event);
    const already = current.some((entry) => isRecord(entry) && entry.command === command);
    if (!already) current.push({ command });
    hooks[event] = current;
  }
  const next = { ...root, version: 1, hooks };
  const written = await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  if (!written.ok) return written;
  return staffOk(path);
}

export async function installCodexHooks(homeDir: string): Promise<StaffResult<string>> {
  const path = join(homeDir, '.codex', 'hooks.json');
  const existing = await readText(path);
  if (!existing.ok) return existing;
  let root: Record<string, unknown> = { hooks: {} };
  if (existing.value !== undefined && existing.value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(existing.value);
      if (!isRecord(parsed)) return staffErr('INVALID_STATE', 'codex hooks.json is not an object');
      root = parsed;
    } catch {
      return staffErr('INVALID_STATE', 'codex hooks.json is not JSON');
    }
  }
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  for (const event of CODEX_HOOK_EVENTS) {
    const command = hookCommand('codex', event);
    const current = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const already = current.some((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) return false;
      return entry.hooks.some((hook) => isRecord(hook) && hook.command === command);
    });
    if (!already) {
      current.push({ hooks: [{ type: 'command', command }] });
    }
    hooks[event] = current;
  }
  const written = await writeAtomic(path, `${JSON.stringify({ ...root, hooks }, null, 2)}\n`);
  if (!written.ok) return written;
  return staffOk(path);
}

export async function installClaudeHooks(homeDir: string): Promise<StaffResult<string>> {
  const path = join(homeDir, '.claude', 'settings.json');
  const existing = await readText(path);
  if (!existing.ok) return existing;
  let root: Record<string, unknown> = {};
  if (existing.value !== undefined && existing.value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(existing.value);
      if (!isRecord(parsed))
        return staffErr('INVALID_STATE', 'claude settings.json is not an object');
      root = parsed;
    } catch {
      return staffErr('INVALID_STATE', 'claude settings.json is not JSON');
    }
  }
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const command = hookCommand('claude', event);
    const current = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const already = current.some((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) return false;
      return entry.hooks.some((hook) => isRecord(hook) && hook.command === command);
    });
    if (!already) current.push({ hooks: [{ type: 'command', command }] });
    hooks[event] = current;
  }
  const written = await writeAtomic(path, `${JSON.stringify({ ...root, hooks }, null, 2)}\n`);
  if (!written.ok) return written;
  return staffOk(path);
}

export async function installHostHooks(
  homeDir: string,
  hosts: readonly HostId[],
): Promise<StaffResult<readonly string[]>> {
  await mkdir(homeDir, { recursive: true });
  const paths: string[] = [];
  for (const host of hosts) {
    if (host === 'cursor') {
      const result = await installCursorHooks(homeDir);
      if (!result.ok) return result;
      paths.push(result.value);
    } else if (host === 'codex') {
      const result = await installCodexHooks(homeDir);
      if (!result.ok) return result;
      paths.push(result.value);
    } else {
      const result = await installClaudeHooks(homeDir);
      if (!result.ok) return result;
      paths.push(result.value);
    }
  }
  return staffOk(paths);
}

const BRIDGE_START = '<!-- rizz:begin -->';
const BRIDGE_END = '<!-- rizz:end -->';

export function bridgeBlock(brainPath: string): string {
  return `${BRIDGE_START}\nRead the Rizz brain index at ${brainPath}. It is the short continuity note for this project. Do not paste the journal into context.\n${BRIDGE_END}\n`;
}

export async function writeOptInBridge(options: {
  readonly projectRoot: string;
  readonly brainPath: string;
}): Promise<StaffResult<readonly string[]>> {
  const written: string[] = [];
  const agentsPath = join(options.projectRoot, 'AGENTS.md');
  const agents = await upsertMarked(agentsPath, bridgeBlock(options.brainPath), true);
  if (!agents.ok) return agents;
  written.push(agentsPath);
  const rulePath = join(options.projectRoot, '.cursor', 'rules', 'rizz.mdc');
  const rule = `---\ndescription: Read the Rizz brain index at session start\nalwaysApply: true\n---\n\n${bridgeBlock(options.brainPath)}`;
  const ruleWrite = await writeAtomic(rulePath, rule);
  if (!ruleWrite.ok) return ruleWrite;
  written.push(rulePath);
  const claudePath = join(options.projectRoot, 'CLAUDE.md');
  const claude = await readText(claudePath);
  if (!claude.ok) return claude;
  if (claude.value !== undefined && !claude.value.includes('@AGENTS.md')) {
    const updated = await upsertMarked(claudePath, '@AGENTS.md\n', false);
    if (!updated.ok) return updated;
    written.push(claudePath);
  }
  return staffOk(written);
}

async function upsertMarked(
  path: string,
  block: string,
  create: boolean,
): Promise<StaffResult<void>> {
  const existing = await readText(path);
  if (!existing.ok) return existing;
  if (existing.value === undefined && !create) return staffOk(undefined);
  const current = existing.value ?? '';
  const start = current.indexOf(BRIDGE_START);
  const end = current.indexOf(BRIDGE_END);
  let next: string;
  if (start !== -1 && end !== -1 && end > start) {
    next = `${current.slice(0, start)}${block}${current.slice(end + BRIDGE_END.length)}`;
  } else if (current.includes(block.trim())) {
    next = current;
  } else {
    next = current === '' ? block : `${current.replace(/\s*$/, '')}\n\n${block}`;
  }
  return writeAtomic(path, next.endsWith('\n') ? next : `${next}\n`);
}
