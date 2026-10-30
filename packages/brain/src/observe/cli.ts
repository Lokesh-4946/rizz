import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative } from 'node:path';
import { resolveRizzHome } from '../project-store.js';
import { prepareProjectStore } from '../project-store.js';
import { readCodexRollout } from './codex-session.js';
import { appendSpoolEvent, countUnrecorded, foldSpool } from './fold.js';
import { loadJournal } from './journal.js';
import { readTokenRows, summarizeTokens } from './ledger.js';
import { type HostId, isHostId } from './model.js';
import { isInboxAnswered, listInbox, readDecisionRecords } from './notes.js';
import { observePaths } from './paths.js';
import { initObserver, receiveHook } from './receive.js';
import { refreshRelayBrain, relaySummaryLines } from './relay/board.js';
import { runRelayCommand } from './relay/commands.js';
import { listRelays } from './relay/config.js';
import { startObserveServer } from './serve.js';
import { renderSummary, renderTokens } from './summary.js';

const USAGE = `rizz observe — record the host coding agent

  rizz init [--host cursor|codex|claude] [--bridge] [--no-serve] [--no-open]
  rizz hook <cursor|codex|claude> <event>
  rizz serve [--no-open]
  rizz fold
  rizz summary
  rizz tokens
  rizz relay add|list|remove|deliver
  rizz msg <name> <text>

The brain is stored per project under the Rizz home, keyed by the project path.
Hooks fail open and append to a spool. rizz serve folds that spool and opens a local page.
`;

export interface DetectInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cursor: boolean;
  readonly codex: boolean;
  readonly claude: boolean;
}

const CURSOR_ENV = ['CURSOR_AGENT', 'CURSOR_TRACE_ID', 'CURSOR_SESSION_ID', 'CURSOR_PROJECT_DIR'];
const CODEX_ENV = ['CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_CI'];
const CLAUDE_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR'];

function envHit(env: DetectInput['env'], keys: readonly string[]): boolean {
  return keys.some((key) => {
    const value = env[key];
    return value !== undefined && value !== '';
  });
}

/** Prefer the host that is actually running. Otherwise install every tool that is present. */
export function detectHosts(input: DetectInput): {
  readonly hosts: readonly HostId[];
  readonly assumed: boolean;
} {
  const fromEnv: HostId[] = [];
  if (envHit(input.env, CURSOR_ENV)) fromEnv.push('cursor');
  if (envHit(input.env, CODEX_ENV)) fromEnv.push('codex');
  if (envHit(input.env, CLAUDE_ENV)) fromEnv.push('claude');
  if (fromEnv.length > 0) return { hosts: fromEnv, assumed: false };
  const found: HostId[] = [];
  if (input.cursor) found.push('cursor');
  if (input.codex) found.push('codex');
  if (input.claude) found.push('claude');
  if (found.length > 0) return { hosts: found, assumed: false };
  return { hosts: ['cursor'], assumed: true };
}

function openBrowser(url: string): void {
  let command = 'xdg-open';
  let args = [url];
  if (process.platform === 'darwin') command = 'open';
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function detachServe(options: {
  readonly cwd: string;
  readonly noOpen: boolean;
}): Promise<{ ok: true; url: string; pid: number } | { ok: false; message: string }> {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') {
    return { ok: false, message: 'cannot find the rizz entrypoint to start the page' };
  }
  const args = [entry, 'serve'];
  if (options.noOpen) args.push('--no-open');
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: process.env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.unref();
  let stdout = '';
  let stderr = '';
  const url = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 5000);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/);
      if (match?.[0] !== undefined) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (url === undefined || child.pid === undefined) {
    const detail = stderr.trim();
    return { ok: false, message: detail === '' ? 'detached page did not start' : detail };
  }
  return { ok: true, url, pid: child.pid };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

export async function runObserveCli(
  argv: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly rizzHome?: string;
    readonly homeDir?: string;
    readonly stdin?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly hostsPresent?: {
      readonly cursor: boolean;
      readonly codex: boolean;
      readonly claude: boolean;
    };
    readonly open?: (url: string) => void;
    /** Stops `serve` so tests can observe the page without leaving the process up. */
    readonly signal?: AbortSignal;
  },
): Promise<number> {
  const command = argv[0];
  if (
    command === undefined ||
    command === '--help' ||
    command === '-h' ||
    flag(argv, '--help') ||
    flag(argv, '-h')
  ) {
    process.stdout.write(USAGE);
    return 0;
  }
  const cwd = options?.cwd ?? process.cwd();
  const rizzHome = options?.rizzHome ?? resolveRizzHome();
  let homeDir = homedir();
  if (process.env.RIZZ_HOOK_HOME !== undefined && process.env.RIZZ_HOOK_HOME !== '') {
    homeDir = process.env.RIZZ_HOOK_HOME;
  }
  if (options?.homeDir !== undefined) homeDir = options.homeDir;
  const json = flag(argv, '--json');
  if (command === 'relay' || command === 'msg') {
    const env = options?.env ?? process.env;
    let stdin = options?.stdin ?? '';
    const key = env.RIZZ_RELAY_KEY ?? '';
    const readKey = command === 'relay' && argv[1] === 'add' && key.trim() === '';
    if (readKey && options?.stdin === undefined) stdin = await readStdin();
    return runRelayCommand(argv, { cwd, rizzHome, stdin, env });
  }
  if (command === 'hook') {
    const tool = argv[1] ?? '';
    const event = argv[2] ?? '';
    const stdin = options?.stdin ?? (await readStdin());
    const inline = argv[3];
    const response = await receiveHook({
      tool,
      hook: event,
      stdin: stdin.trim() === '' && inline !== undefined ? inline : stdin,
      projectRoot: cwd,
      rizzHome,
    });
    process.stdout.write(response.stdout);
    if (response.stderr !== '') process.stderr.write(response.stderr);
    return response.exitCode;
  }
  if (command === 'fold') {
    const result = await foldSpool(rizzHome, { recoverKilled: true });
    if (!result.ok) {
      process.stderr.write(`rizz: ${result.error.code}: ${result.error.message}\n`);
      return 1;
    }
    process.stdout.write(`rizz folded ${result.value.applied} event(s)\n`);
    if (result.value.recovered > 0) {
      process.stdout.write(`rizz recovered ${result.value.recovered} killed session(s)\n`);
    }
    return 0;
  }
  if (command === 'summary' || command === 'tokens') {
    const projectRoot = await realpath(cwd);
    const prepared = await prepareProjectStore({ rootDir: projectRoot, rizzHome });
    if (!prepared.ok) {
      process.stderr.write(`rizz: ${prepared.error.code}: ${prepared.error.message}\n`);
      return 1;
    }
    const paths = observePaths(prepared.value.projectDir);
    if (command === 'tokens') {
      const rows = await readTokenRows(paths.ledger);
      const text = rows.ok ? renderTokens(summarizeTokens(rows.value)) : 'no usage recorded';
      process.stdout.write(`${text}\n`);
      return rows.ok ? 0 : 1;
    }
    const inbox = await listInbox(paths.inboxDir);
    const decisions = await readDecisionRecords(paths.decisions);
    const openInbox = (inbox.ok ? inbox.value : []).filter(
      (item) => !decisions.ok || !isInboxAnswered(item.id, decisions.value),
    );
    const journal = await loadJournal(paths.journalDir);
    const threads = new Set((journal.ok ? journal.value : []).map((event) => event.threadId)).size;
    const relays = await listRelays(rizzHome);
    if (relays.ok && relays.value.length > 0) {
      await refreshRelayBrain({ rizzHome, projectRoot, now: new Date().toISOString() });
    }
    const relayLines = await relaySummaryLines(rizzHome, projectRoot);
    const dropped = await countUnrecorded(rizzHome, projectRoot);
    const text = renderSummary({ threads, inbox: openInbox, dropped, relayLines });
    process.stdout.write(`${text}\n`);
    return 0;
  }
  if (command === 'serve' || command === 'init') {
    const hostFlag = argv.indexOf('--host');
    const forced = hostFlag === -1 ? undefined : argv[hostFlag + 1];
    if (forced !== undefined && !isHostId(forced)) {
      process.stderr.write('rizz: --host must be cursor, codex, or claude\n');
      return 2;
    }
    const detected = detectHosts({
      env: options?.env ?? process.env,
      cursor: options?.hostsPresent?.cursor ?? false,
      codex: options?.hostsPresent?.codex ?? false,
      claude: options?.hostsPresent?.claude ?? false,
    });
    const hosts = forced === undefined ? detected.hosts : [forced];
    if (command === 'init') {
      const ready = await initObserver({
        projectRoot: cwd,
        rizzHome,
        hosts,
        homeDir,
        bridge: flag(argv, '--bridge'),
      });
      if (!ready.ok) {
        process.stderr.write(`rizz: ${ready.error.code}: ${ready.error.message}\n`);
        return 1;
      }
      const shown = relative(cwd, ready.value.brainPath);
      process.stdout.write(
        `rizz brain ready\n  brain: ${shown.startsWith('..') ? ready.value.brainPath : shown}\n`,
      );
      const assumed = forced === undefined && detected.assumed ? ' (cursor assumed)' : '';
      process.stdout.write(`  hooks: ${hosts.join(', ')}${assumed}\n`);
      if (flag(argv, '--no-serve')) return 0;
      const detached = await detachServe({ cwd, noOpen: flag(argv, '--no-open') });
      if (!detached.ok) {
        process.stderr.write(`rizz: ${detached.message}\n`);
        return 1;
      }
      process.stdout.write(`rizz serve ${detached.url}\n`);
      process.stdout.write(`rizz serve pid ${detached.pid}\n`);
      if (json) {
        process.stdout.write(`${JSON.stringify({ url: detached.url, pid: detached.pid })}\n`);
      }
      return 0;
    }
    if (flag(argv, '--no-serve')) return 0;
    const server = await startObserveServer({ projectRoot: cwd, rizzHome });
    process.stdout.write(`rizz serve ${server.url}\n`);
    if (json) process.stdout.write(`${JSON.stringify({ url: server.url })}\n`);
    const signal = options?.signal;
    const stopped =
      signal === undefined
        ? undefined
        : new Promise<void>((resolve) => {
            const stop = (): void => {
              void server.close().finally(resolve);
            };
            if (signal.aborted) {
              stop();
              return;
            }
            signal.addEventListener('abort', stop, { once: true });
          });
    if (!flag(argv, '--no-open')) (options?.open ?? openBrowser)(server.url);
    if (stopped === undefined) {
      await new Promise<void>(() => undefined);
      return 0;
    }
    await stopped;
    return 0;
  }
  if (command === 'codex-session') {
    const file = argv[1];
    if (file === undefined) {
      process.stderr.write('rizz: codex-session needs a rollout path\n');
      return 2;
    }
    const events = await readCodexRollout({
      path: file,
      projectRoot: cwd,
      at: new Date().toISOString(),
    });
    if (!events.ok) {
      process.stderr.write(`rizz: ${events.error.code}: ${events.error.message}\n`);
      return 1;
    }
    for (const event of events.value) {
      const appended = await appendSpoolEvent(rizzHome, event);
      if (!appended.ok) {
        process.stderr.write(`rizz: ${appended.error.message}\n`);
        return 1;
      }
    }
    process.stdout.write(`rizz spooled ${events.value.length} codex session event(s)\n`);
    return 0;
  }
  process.stderr.write(`rizz: unknown observe command '${command}'\n${USAGE}`);
  return 2;
}
