#!/usr/bin/env node
// @valoir/rizz — the `rizz` entrypoint. Orchestration: parse the command, then hand off to tui/core.
// No args + a TTY → the interactive TUI; no args + piped stdin → one print-mode turn (scriptable,
// job #3). Kept dependency-light so cold start stays fast (the footprint gate measures this binary).

import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import {
  OPENROUTER_DEFAULT_MODEL_ID,
  type ResolvedProvider,
  createRpcServer,
  createSession,
  loginWithApiKey,
  resolveCodexSubscriptionProvider,
  resolveProvider,
  runJsonTurn,
  runTurn,
} from '@valoir/rizz-core';
import { StubProvider, openSecretStore, openSessionStore } from '@valoir/rizz-providers';

const VERSION = '0.1.0';

const USAGE = `rizz - understand a software system

Usage:
  rizz               generate .rizz/brain and .rizz/reports
  rizz brain         refresh project brain
  rizz explain <x>   explain a component or file from the project brain
  rizz explain flow <id>
                     explain a reconstructed flow from the project brain
  rizz review        review current git diff with the project brain
  rizz chat          launch model TUI
  rizz setup         choose model route
  rizz doctor        readiness check
  rizz --json < file one turn, JSON
  rizz --rpc         JSONL RPC
  rizz --version     print version
  rizz --help        show help`;

/** Where sessions persist (mirrors the TUI). Local-first; no cloud (D-011). */
const SESSIONS_DIR = join(homedir(), '.rizz', 'sessions');

function displayLocalPath(path: string): string {
  const local = relative(process.cwd(), path).replace(/\\/g, '/');
  if (local === '') return '.';
  return local.startsWith('..') ? path : local;
}

type StartTuiOptions = ResolvedProvider & {
  readonly notice?: string;
  readonly persistSession?: boolean;
  readonly displayName?: string;
  readonly agentName?: string;
  readonly resumeId?: string;
};

/** Model-selection options pulled from the CLI; composes with any mode. */
interface SelectOpts {
  readonly profile?: string;
  readonly capability?: string;
}

async function startNoModelTui(
  notice: string,
  displayName?: string,
  agentName?: string,
): Promise<void> {
  await startTuiLazy({
    provider: new StubProvider(),
    subscription: false,
    auth: 'demo',
    notice,
    persistSession: false,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(agentName !== undefined ? { agentName } : {}),
  });
}

async function startTuiLazy(options: StartTuiOptions): Promise<void> {
  const { startTui } = await import('@valoir/rizz-tui');
  await startTui(options);
}

async function runBrainCommand(): Promise<number> {
  const { generateProjectBrain } = await import('@valoir/rizz-brain');
  const result = await generateProjectBrain({ rootDir: process.cwd() });
  if (!result.ok) {
    process.stderr.write(`rizz: ${result.error.code}: ${result.error.message}\n`);
    return 1;
  }
  const summary = result.value;
  process.stdout.write(`rizz understood ${summary.scannedFiles} file(s)\n`);
  process.stdout.write(`  brain: ${displayLocalPath(summary.latestPath)}\n`);
  process.stdout.write(`  research: ${displayLocalPath(summary.researchDir)}\n`);
  process.stdout.write(`  report: ${displayLocalPath(summary.reportPath)}\n`);
  process.stdout.write(`  components: ${summary.components}\n`);
  process.stdout.write(`  flows: ${summary.flows}\n`);
  process.stdout.write(`  commands: ${summary.commands}\n`);
  process.stdout.write(`  tests: ${summary.tests}\n`);
  process.stdout.write(`  changed: ${summary.changedFiles}\n`);
  process.stdout.write(`  stale: ${summary.staleFiles}\n`);
  return 0;
}

async function runReviewCommand(options: { readonly json: boolean }): Promise<number> {
  const { reviewProjectChanges } = await import('@valoir/rizz-brain');
  const result = await reviewProjectChanges({ rootDir: process.cwd(), json: options.json });
  if (!result.ok) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stderr.write(`rizz: ${result.error.code}: ${result.error.message}\n`);
    }
    return 1;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.value.review)}\n`);
    return 0;
  }

  const summary = result.value;
  process.stdout.write(`rizz reviewed ${summary.changedFiles} changed file(s)\n`);
  process.stdout.write(`  overall risk: ${summary.overallRisk}\n`);
  process.stdout.write(`  surgicality: ${summary.surgicalityScore}/10\n`);
  process.stdout.write(`  blast radius: ${summary.blastRadius}\n`);
  process.stdout.write(
    `  direct/dependent components: ${summary.review.direct_affected_components.length}/${summary.review.dependent_components.length}\n`,
  );
  process.stdout.write(`  affected flows: ${summary.review.affected_flows.length}\n`);
  process.stdout.write(`  findings: ${summary.findings}\n`);
  process.stdout.write(`  action: ${summary.recommendedAction}\n`);
  process.stdout.write(`  review: ${displayLocalPath(summary.reviewPath)}\n`);
  process.stdout.write(`  report: ${displayLocalPath(summary.reportPath)}\n`);
  if (summary.review.required_tests.length > 0) {
    process.stdout.write('  required tests:\n');
    for (const command of summary.review.required_tests) {
      process.stdout.write(`    - ${command}\n`);
    }
  }
  if (summary.review.affected_flows.length > 0) {
    process.stdout.write('  affected flows:\n');
    for (const flow of summary.review.affected_flows.slice(0, 5)) {
      process.stdout.write(
        `    - ${flow.id} (${flow.kind}, ${flow.confidence}, ${flow.changed_files.length} changed file(s))\n`,
      );
    }
  }
  if (summary.review.blast_radius_reasons.length > 0) {
    process.stdout.write('  blast radius evidence:\n');
    for (const reason of summary.review.blast_radius_reasons.slice(0, 4)) {
      process.stdout.write(`    - ${reason}\n`);
    }
  }
  if (summary.review.findings.length > 0) {
    process.stdout.write('  reviewer focus:\n');
    for (const finding of summary.review.findings.slice(0, 5)) {
      process.stdout.write(`    - [${finding.severity}] ${finding.category}: ${finding.title}\n`);
    }
  }
  return 0;
}

async function runExplainCommand(options: {
  readonly target: string;
  readonly json: boolean;
}): Promise<number> {
  const { explainProjectTarget } = await import('@valoir/rizz-brain');
  const result = await explainProjectTarget({ rootDir: process.cwd(), target: options.target });
  if (!result.ok) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stderr.write(`rizz: ${result.error.code}: ${result.error.message}\n`);
    }
    return result.error.code === 'EXPLAIN_TARGET_REQUIRED' ? 2 : 1;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.value.explanation)}\n`);
    return 0;
  }

  const explanation = result.value.explanation;
  process.stdout.write(`rizz explained ${explanation.resolved_entity_id}\n`);
  process.stdout.write(`  type: ${explanation.entity_type}\n`);
  process.stdout.write(`  confidence: ${explanation.confidence}\n`);
  process.stdout.write(`  latest report: ${displayLocalPath(result.value.reportPath)}\n`);
  process.stdout.write(`\nWhat this is\n  ${explanation.purpose}\n`);
  writeSection('Responsibilities', explanation.responsibilities);
  writeSection('Entry points', explanation.entry_points);
  writeSection('Important files', explanation.important_files);
  writeSection('Dependencies', explanation.dependencies);
  writeSection('Dependency roles', explanation.dependency_roles);
  writeSection('Consumers', explanation.consumers);
  writeSection('Tests', explanation.tests);
  writeSection('Configs', explanation.configs);
  writeSection('Tradeoffs', explanation.tradeoffs);
  writeSection('Failure modes', explanation.failure_modes);
  writeSection('What breaks if changed', explanation.breaks_if_changed);
  writeSection('Risks', explanation.risks);
  writeSection('Read first', explanation.read_first);
  writeSection('Unknowns', explanation.unknowns);
  writeSection('Evidence', explanation.evidence_ids);
  return 0;
}

function writeSection(title: string, items: readonly string[]): void {
  process.stdout.write(`\n${title}\n`);
  if (items.length === 0) {
    process.stdout.write('  none recorded yet\n');
    return;
  }
  for (const item of items.slice(0, 12)) {
    process.stdout.write(`  - ${item}\n`);
  }
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
            await startTuiLazy({
              ...resolveCodexSubscriptionProvider({
                command: context.codex.command,
                cwd: process.cwd(),
              }),
              persistSession: false,
              ...(context.displayName !== undefined ? { displayName: context.displayName } : {}),
              ...(context.agentName !== undefined ? { agentName: context.agentName } : {}),
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
            await startTuiLazy({
              ...resolved,
              persistSession: false,
              ...(context.displayName !== undefined ? { displayName: context.displayName } : {}),
              ...(context.agentName !== undefined ? { agentName: context.agentName } : {}),
            });
            return { ok: true };
          }
          if (route === 'openai-api') {
            await startNoModelTui(
              'OpenAI selected. No model connected yet.',
              context.displayName,
              context.agentName,
            );
            return { ok: true };
          }
          if (route === 'anthropic-api') {
            await startNoModelTui(
              'Anthropic selected. No model connected yet.',
              context.displayName,
              context.agentName,
            );
            return { ok: true };
          }
          await startNoModelTui(
            'No model connected. Use /login or /model when ready.',
            context.displayName,
            context.agentName,
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
  if (c.rest[0] === 'review') {
    const reviewArgs = c.rest.slice(1);
    const allowed = new Set(['--json']);
    const unknown = reviewArgs.find((arg) => !allowed.has(arg));
    if (unknown !== undefined) {
      process.stderr.write(`rizz: unknown review option '${unknown}'\nTry 'rizz --help'.\n`);
      return 2;
    }
    return runReviewCommand({ json: reviewArgs.includes('--json') });
  }
  if (c.rest[0] === 'explain') {
    const explainArgs = c.rest.slice(1);
    const wantsJson = explainArgs.includes('--json');
    const allowed = new Set(['--json']);
    const unknownFlag = explainArgs.find((arg) => arg.startsWith('-') && !allowed.has(arg));
    if (unknownFlag !== undefined) {
      const error = {
        ok: false,
        error: {
          code: 'UNKNOWN_EXPLAIN_OPTION',
          message: `Unknown explain option '${unknownFlag}'.`,
        },
      };
      if (wantsJson) process.stdout.write(`${JSON.stringify(error)}\n`);
      else
        process.stderr.write(
          `rizz: ${error.error.code}: ${error.error.message}\nTry 'rizz --help'.\n`,
        );
      return 2;
    }
    const targets = explainArgs.filter((arg) => !allowed.has(arg));
    let target = targets[0];
    const isFlowTarget = targets.length === 2 && targets[0] === 'flow';
    if (isFlowTarget) {
      const flowId = targets[1] ?? '';
      target = flowId.startsWith('flow:') ? flowId : `flow:${flowId}`;
    }
    if ((targets.length !== 1 && !isFlowTarget) || target === undefined) {
      const error = {
        ok: false,
        error: {
          code: 'EXPLAIN_TARGET_REQUIRED',
          message: 'Explain needs exactly one component, file, or flow target.',
        },
      };
      if (wantsJson) process.stdout.write(`${JSON.stringify(error)}\n`);
      else
        process.stderr.write(
          `rizz: ${error.error.code}: ${error.error.message}\nTry 'rizz --help'.\n`,
        );
      return 2;
    }
    return runExplainCommand({ target, json: wantsJson });
  }
  // Headless modes (job #3) consume the remaining args as boolean flags; --rpc wins over --json.
  const rest = c.rest.filter((a) => a !== '--json' && a !== '--rpc');
  if (c.rest.includes('--rpc')) return runRpc(select);
  if (c.rest.includes('--json')) return runJson(select);
  const arg = rest[0];
  switch (arg) {
    case 'understand':
    case 'brain':
    case 'report':
      return runBrainCommand();
    case 'doctor': {
      const { runSetupDryRun } = await import('./setup.js');
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
    case 'chat':
      await startTuiLazy(await resolveProvider(select));
      return 0;
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
      await startTuiLazy({ ...(await resolveProvider(select)), resumeId });
      return 0;
    }
    case undefined:
      if (process.stdin.isTTY) {
        return runBrainCommand();
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
