#!/usr/bin/env node
// @rizz/cli — the `rizz` entrypoint. Orchestration: parse the command, then hand off to tui/core.
// No args + a TTY → the interactive TUI; no args + piped stdin → one print-mode turn (scriptable,
// job #3). Kept dependency-light so cold start stays fast (the footprint gate measures this binary).

import { createSession, runTurn } from '@rizz/core';
import { StubProvider } from '@rizz/providers';
import { startTui } from '@rizz/tui';

const VERSION = '0.0.0';

const USAGE = `rizz — the lightest, most connectable coding agent harness

Usage:
  rizz               launch the interactive TUI (demo provider until /login is wired)
  rizz --resume <id> resume a saved session by id (rehydrates its full history)
  rizz < file        run one turn on piped input and print the reply (print mode)
  rizz --version     print the rizz version
  rizz --help        show this help

Single-agent and minimal by default. /login, /model and the /workspace multi-agent mode
arrive in later milestones.`;

/** Non-TTY: read all of stdin as one prompt, run a single turn, print the reply. */
async function runPrint(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks).toString('utf8').trim();
  if (input === '') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const result = await runTurn({
    provider: new StubProvider(),
    session: createSession(),
    input,
    cwd: process.cwd(),
  });
  if (!result.ok) {
    process.stderr.write(`rizz: ${result.error.code}: ${result.error.message}\n`);
    return 1;
  }
  process.stdout.write(`${result.value.content}\n`);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const arg = argv[0];
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
      const resumeId = argv[1];
      if (resumeId === undefined) {
        process.stderr.write("rizz: --resume needs a session id\nTry 'rizz --help'.\n");
        return 2;
      }
      await startTui({ provider: new StubProvider(), resumeId });
      return 0;
    }
    case undefined:
      if (process.stdin.isTTY) {
        await startTui({ provider: new StubProvider() });
        return 0;
      }
      return runPrint();
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
