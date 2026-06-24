#!/usr/bin/env node
// @rizz/cli — the `rizz` entrypoint. Orchestration: parse the command, then hand off to tui/core.
// No args + a TTY → the interactive TUI; no args + piped stdin → one print-mode turn (scriptable,
// job #3). Kept dependency-light so cold start stays fast (the footprint gate measures this binary).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  OPENROUTER_DEFAULT_MODEL_ID,
  createRpcServer,
  createSession,
  loginWithApiKey,
  resolveCodexSubscriptionProvider,
  resolveProvider,
  runJsonTurn,
  runTurn,
} from '@rizz/core';
import { StubProvider, openSecretStore, openSessionStore } from '@rizz/providers';
import { startTui } from '@rizz/tui';

const VERSION = '0.0.0';

const USAGE = `rizz — the lightest, most connectable coding agent harness

Usage:
  rizz                   launch the interactive TUI
  rizz setup             choose a model route for this workspace
  rizz --profile <p>     pick a model profile (default · deep · fast · cheap · local)
  rizz --capability <c>  pick the best model for a capability (code · plan · cheap · long-context)
  rizz --resume <id>     resume a saved session by id (rehydrates its full history)
  rizz < file            run one turn on piped input and print the reply (print mode)
  rizz --json < file     one-shot turn, structured JSON result on stdout (scriptable)
  rizz --rpc             stdin/stdout JSON line protocol for tools to drive rizz (job #3)
  rizz setup --dry-run   check local readiness without connecting a provider
  rizz --version         print the rizz version
  rizz --help            show this help

Single-agent and minimal by default. Use setup to choose a model route. OpenRouter BYOK starts
directly from setup; a signed-in Codex CLI can start a subscription-backed route.
Workspace mode is opt-in and stays off unless you turn it on. The headless contract is in
runbooks/headless.md.`;

/** Where sessions persist (mirrors the TUI). Local-first; no cloud (D-011). */
const SESSIONS_DIR = join(homedir(), '.rizz', 'sessions');

/** Model-selection options pulled from the CLI; composes with any mode. */
interface SelectOpts {
  readonly profile?: string;
  readonly capability?: string;
}

async function startNoModelTui(notice: string, displayName?: string): Promise<void> {
  await startTui({
    provider: new StubProvider(),
    subscription: false,
    auth: 'demo',
    notice,
    persistSession: false,
    ...(displayName !== undefined ? { displayName } : {}),
  });
}

async function askHidden(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    process.stdout.write(question);
    const internal = rl as unknown as { _writeToOutput?: ((s: string) => void) | undefined };
    const original = internal._writeToOutput;
    const restore = (): void => {
      internal._writeToOutput = original;
    };
    internal._writeToOutput = (s: string): void => {
      if (s.includes('\n')) original?.call(rl, '\n');
    };
    const onClose = (): void => {
      restore();
      resolve(null);
    };
    rl.once('close', onClose);
    rl.question('', (answer) => {
      rl.off('close', onClose);
      restore();
      rl.close();
      resolve(answer);
    });
  });
}

/** Pull a `--flag <value>` pair out of argv; reports a missing value so the caller can error. */
function extractFlag(
  argv: readonly string[],
  flag: string,
): { value?: string; rest: string[]; missingValue?: boolean } {
  const rest = [...argv];
  const i = rest.indexOf(flag);
  if (i === -1) return { rest };
  const value = rest[i + 1];
  if (value === undefined) {
    rest.splice(i, 1);
    return { rest, missingValue: true };
  }
  rest.splice(i, 2);
  return { value, rest };
}

/** Non-TTY: read all of stdin as one prompt, run a single turn, print the reply. */
async function runPrint(select: SelectOpts): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks).toString('utf8').trim();
  if (input === '') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const resolved = await resolveProvider(select);
  if (resolved.notice !== undefined) process.stderr.write(`rizz: ${resolved.notice}\n`);

  const result = await runTurn({
    provider: resolved.provider,
    session: createSession(),
    input,
    cwd: process.cwd(),
    subscription: resolved.subscription,
    ...(resolved.model ? { model: resolved.model } : {}),
  });
  if (!result.ok) {
    process.stderr.write(`rizz: ${result.error.code}: ${result.error.message}\n`);
    return 1;
  }
  process.stdout.write(`${result.value.content}\n`);
  return 0;
}

/** One-shot headless JSON: a turn in on stdin, a structured JSON result on stdout (job #3). */
async function runJson(select: SelectOpts): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks).toString('utf8').trim();
  if (input === '') {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'empty input' } })}\n`,
    );
    return 2;
  }
  const resolved = await resolveProvider(select);
  if (resolved.notice !== undefined) process.stderr.write(`rizz: ${resolved.notice}\n`);
  const result = await runJsonTurn({ resolved, input, cwd: process.cwd() });
  process.stdout.write(`${JSON.stringify(result)}\n`); // stdout stays pure JSON; notices go to stderr
  return result.ok ? 0 : 1;
}

/** RPC mode: drive rizz over a stdin/stdout JSON line protocol (job #3 — the interop hub). */
async function runRpc(select: SelectOpts): Promise<number> {
  const resolved = await resolveProvider(select);
  if (resolved.notice !== undefined) process.stderr.write(`rizz: ${resolved.notice}\n`);
  const store = await openSessionStore({ dir: SESSIONS_DIR });
  const server = createRpcServer({
    resolved,
    cwd: process.cwd(),
    store,
    write: (line) => process.stdout.write(line),
  });
  const rl = createInterface({ input: process.stdin });
  await new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      void server.handle(line);
    });
    rl.on('close', () => resolve());
  });
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const p = extractFlag(argv, '--profile');
  if (p.missingValue) {
    process.stderr.write(
      "rizz: --profile needs a name (default · deep · fast · cheap · local)\nTry 'rizz --help'.\n",
    );
    return 2;
  }
  const c = extractFlag(p.rest, '--capability');
  if (c.missingValue) {
    process.stderr.write(
      "rizz: --capability needs a name (code · plan · cheap · long-context)\nTry 'rizz --help'.\n",
    );
    return 2;
  }
  const select: SelectOpts = {
    ...(p.value !== undefined ? { profile: p.value } : {}),
    ...(c.value !== undefined ? { capability: c.value } : {}),
  };
  if (c.rest[0] === 'setup') {
    const { SETUP_USAGE, parseSetupArgs, runSetupDryRun, runSetupInteractive } = await import(
      './setup.js'
    );
    if (select.profile !== undefined || select.capability !== undefined) {
      process.stderr.write(
        "rizz: setup does not accept model selection flags yet\nTry 'rizz setup --dry-run'.\n",
      );
      return 2;
    }
    const setupArgs = parseSetupArgs(c.rest.slice(1));
    if (!setupArgs.ok) {
      process.stderr.write(`rizz: ${setupArgs.message}\n${SETUP_USAGE}\n`);
      return 2;
    }
    if (setupArgs.action === 'help') {
      process.stdout.write(`${SETUP_USAGE}\n`);
      return 0;
    }
    if (setupArgs.action === 'interactive') {
      return runSetupInteractive({
        env: process.env,
        nodeVersion: process.versions.node,
        platform: process.platform,
        homeDir: homedir(),
        isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
        ...(process.stdout.columns !== undefined ? { columns: process.stdout.columns } : {}),
        askSecret: askHidden,
        launchSelectedRoute: async (route, context) => {
          if (route === 'codex-subscription') {
            if (context.codex?.status !== 'ready' || context.codex.command === undefined) {
              return {
                ok: false,
                code: 'CODEX_NOT_READY',
                message:
                  'Codex is not signed in yet. Open the Codex app and sign in, then rerun rizz setup.',
              };
            }
            await startTui({
              ...resolveCodexSubscriptionProvider({
                command: context.codex.command,
                cwd: process.cwd(),
              }),
              persistSession: false,
              ...(context.displayName !== undefined ? { displayName: context.displayName } : {}),
            });
            return { ok: true };
          }
          if (route === 'openrouter-api') {
            if (context.apiKey === undefined || context.apiKey === '') {
              return {
                ok: false,
                code: 'OPENROUTER_KEY_MISSING',
                message: 'OpenRouter key was not entered. Rerun rizz setup when ready.',
              };
            }
            const { resolved } = await loginWithApiKey(await openSecretStore(), context.apiKey, {
              modelId: OPENROUTER_DEFAULT_MODEL_ID,
            });
            if (resolved.auth !== 'api-key') {
              return {
                ok: false,
                code: 'OPENROUTER_NOT_READY',
                message: 'OpenRouter could not be activated. Check the key and try again.',
              };
            }
            process.stdout.write(
              'OpenRouter connected.\nStarting rizz with OpenRouter North Mini Code (free).\n',
            );
            await startTui({
              ...resolved,
              persistSession: false,
              ...(context.displayName !== undefined ? { displayName: context.displayName } : {}),
            });
            return { ok: true };
          }
          if (route === 'openai-api') {
            await startNoModelTui('OpenAI selected. No model connected yet.', context.displayName);
            return { ok: true };
          }
          if (route === 'anthropic-api') {
            await startNoModelTui(
              'Anthropic selected. No model connected yet.',
              context.displayName,
            );
            return { ok: true };
          }
          await startNoModelTui(
            'No model connected. Use /login or /model when ready.',
            context.displayName,
          );
          return { ok: true };
        },
      });
    }
    return runSetupDryRun({
      env: process.env,
      nodeVersion: process.versions.node,
      platform: process.platform,
      homeDir: homedir(),
      isTTY: process.stdout.isTTY === true,
      ...(process.stdout.columns !== undefined ? { columns: process.stdout.columns } : {}),
      write: (text) => process.stdout.write(text),
    });
  }
  // Headless modes (job #3) consume the remaining args as boolean flags; --rpc wins over --json.
  const rest = c.rest.filter((a) => a !== '--json' && a !== '--rpc');
  if (c.rest.includes('--rpc')) return runRpc(select);
  if (c.rest.includes('--json')) return runJson(select);
  const arg = rest[0];
  switch (arg) {
    case '-v':
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case '-h':
    case '--help':
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case '--resume': {
      const resumeId = rest[1];
      if (resumeId === undefined) {
        process.stderr.write("rizz: --resume needs a session id\nTry 'rizz --help'.\n");
        return 2;
      }
      await startTui({ ...(await resolveProvider(select)), resumeId });
      return 0;
    }
    case undefined:
      if (process.stdin.isTTY) {
        await startTui(await resolveProvider(select));
        return 0;
      }
      return runPrint(select);
    default:
      process.stderr.write(`rizz: unknown option '${arg}'\nTry 'rizz --help'.\n`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`rizz: fatal: ${message}\n`);
    process.exit(1);
  });
