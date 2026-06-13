#!/usr/bin/env node
// @rizz/cli — the `rizz` entrypoint. Orchestration layer: parses the command, then hands off to
// core/tui. Kept dependency-free so cold start stays fast (the footprint gate measures this exact
// binary). The real command surface (run, /login, /model, workspace) lands M2+.

const VERSION = '0.0.0';

const USAGE = `rizz — the lightest, most connectable coding agent harness

Usage:
  rizz [options]

Options:
  -v, --version   print the rizz version
  -h, --help      show this help

Single-agent and minimal by default. The interactive TUI, /login, /model and the
/workspace multi-agent mode arrive in later milestones.`;

function main(argv: readonly string[]): number {
  const arg = argv[0];
  switch (arg) {
    case '-v':
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(`${USAGE}\n`);
      return 0;
    default:
      process.stderr.write(`rizz: unknown option '${arg}'\nTry 'rizz --help'.\n`);
      return 2;
  }
}

process.exit(main(process.argv.slice(2)));
