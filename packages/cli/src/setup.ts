import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir as osHomedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type DoctorCheckId =
  | 'node'
  | 'package-manager'
  | 'git'
  | 'rizz-home'
  | 'terminal'
  | 'keychain';

export type DoctorSeverity = 'ok' | 'info' | 'warn' | 'blocker';

export interface DependencyDoctorCheck {
  readonly id: DoctorCheckId;
  readonly label: string;
  readonly severity: DoctorSeverity;
  readonly summary: string;
  readonly observed?: string;
  readonly fix?: string;
}

export interface DependencyDoctorReport {
  readonly checks: readonly DependencyDoctorCheck[];
  readonly blockers: number;
  readonly warnings: number;
  readonly nextSteps: readonly string[];
}

export interface ParsedNodeVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export type CommandProbeResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: string; readonly stdout?: string };

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CommandProbeResult>;

export type SetupProviderRouteId = 'codex-subscription' | 'openai-api' | 'anthropic-api' | 'skip';

export type CodexCliStatus = 'ready' | 'needs-login' | 'missing';

export interface CodexCliDiagnostic {
  readonly status: CodexCliStatus;
  readonly summary: string;
  readonly observed?: string;
}

export interface SetupProviderChoice {
  readonly id: SetupProviderRouteId;
  readonly label: string;
  readonly summary: string;
}

export type PathAccessResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type PathAccess = (path: string, mode: number) => Promise<PathAccessResult>;

export interface TerminalDoctorInput {
  readonly isTTY: boolean;
  readonly columns?: number;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface RizzHomeDoctorInput {
  readonly rizzHomeDir: string;
  readonly rizzHomeExists: boolean;
  readonly rizzHomeWritable?: boolean;
  readonly homeWritable?: boolean;
}

export interface KeychainDoctorInput {
  readonly platform: NodeJS.Platform;
  readonly helperAvailable?: boolean;
}

export interface BuildDependencyDoctorReportParams {
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly homeDir: string;
  readonly rizzHomeDir?: string;
  readonly isTTY: boolean;
  readonly columns?: number;
  readonly commandRunner: CommandRunner;
  readonly pathAccess: PathAccess;
}

export interface RunSetupDryRunOptions {
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly homeDir?: string;
  readonly rizzHomeDir?: string;
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly commandRunner?: CommandRunner;
  readonly pathAccess?: PathAccess;
  readonly write?: (text: string) => void;
}

export type SetupQuestion = (question: string) => Promise<string | null>;

export interface RunSetupInteractiveOptions extends RunSetupDryRunOptions {
  readonly ask?: SetupQuestion;
  readonly defaultUserName?: string;
}

export type SetupArgsResult =
  | { readonly ok: true; readonly action: 'interactive' | 'dry-run' | 'help' }
  | { readonly ok: false; readonly message: string };

export const SETUP_USAGE = `Usage:
  rizz setup             choose a model route for this workspace
  rizz setup --dry-run   check local readiness without connecting a provider
  rizz setup --help      show setup help`;

function probeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
    ...(env.SystemRoot !== undefined ? { SystemRoot: env.SystemRoot } : {}),
    ...(env.WINDIR !== undefined ? { WINDIR: env.WINDIR } : {}),
    ...(env.COMSPEC !== undefined ? { COMSPEC: env.COMSPEC } : {}),
  };
}

function makeCheck(params: {
  readonly id: DoctorCheckId;
  readonly label: string;
  readonly severity: DoctorSeverity;
  readonly summary: string;
  readonly observed?: string;
  readonly fix?: string;
}): DependencyDoctorCheck {
  return {
    id: params.id,
    label: params.label,
    severity: params.severity,
    summary: params.summary,
    ...(params.observed !== undefined ? { observed: params.observed } : {}),
    ...(params.fix !== undefined ? { fix: params.fix } : {}),
  };
}

function normalizeObservedVersion(prefix: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return `${prefix} available`;
  if (trimmed.startsWith(prefix)) return trimmed;
  return `${prefix} ${trimmed}`;
}

function envFlag(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && value !== '0';
}

export function parseNodeVersion(version: string): ParsedNodeVersion | undefined {
  const trimmed = version.trim();
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(trimmed);
  if (match === null) return undefined;
  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '0', 10);
  const patch = Number.parseInt(match[3] ?? '0', 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return undefined;
  }
  return { raw: trimmed, major, minor, patch };
}

export function classifyNode(version: string): DependencyDoctorCheck {
  const parsed = parseNodeVersion(version);
  if (parsed === undefined) {
    return makeCheck({
      id: 'node',
      label: 'node',
      severity: 'blocker',
      summary: 'could not parse Node version',
      observed: version,
      fix: 'Install Node 22 or newer, then rerun rizz setup --dry-run.',
    });
  }
  const observed = parsed.raw.startsWith('v') ? parsed.raw : `v${parsed.raw}`;
  if (parsed.major < 22) {
    return makeCheck({
      id: 'node',
      label: 'node',
      severity: 'blocker',
      summary: 'Node 22 or newer is required',
      observed,
      fix: 'Install Node 22 or newer, then rerun rizz setup --dry-run.',
    });
  }
  return makeCheck({
    id: 'node',
    label: 'node',
    severity: 'ok',
    summary: 'Node version is supported',
    observed,
  });
}

export function classifyPackageManager(params: {
  readonly pnpm: CommandProbeResult;
  readonly corepack?: CommandProbeResult;
}): DependencyDoctorCheck {
  if (params.pnpm.ok) {
    return makeCheck({
      id: 'package-manager',
      label: 'package manager',
      severity: 'ok',
      summary: 'pnpm is available',
      observed: normalizeObservedVersion('pnpm', params.pnpm.stdout),
    });
  }
  if (params.corepack?.ok === true) {
    return makeCheck({
      id: 'package-manager',
      label: 'package manager',
      severity: 'ok',
      summary: 'corepack is available; pnpm can be activated',
      observed: normalizeObservedVersion('corepack', params.corepack.stdout),
    });
  }
  return makeCheck({
    id: 'package-manager',
    label: 'package manager',
    severity: 'warn',
    summary: 'pnpm and corepack were not found',
    fix: 'Enable corepack or install pnpm before running the full setup wizard.',
  });
}

export function classifyGit(result: CommandProbeResult): DependencyDoctorCheck {
  if (result.ok) {
    return makeCheck({
      id: 'git',
      label: 'git',
      severity: 'ok',
      summary: 'git is available',
      observed: normalizeObservedVersion('git', result.stdout),
    });
  }
  return makeCheck({
    id: 'git',
    label: 'git',
    severity: 'warn',
    summary: 'git was not found',
    fix: 'Install git if you want repo-aware workflows.',
  });
}

export function classifyRizzHome(input: RizzHomeDoctorInput): DependencyDoctorCheck {
  if (input.rizzHomeExists) {
    if (input.rizzHomeWritable === true) {
      return makeCheck({
        id: 'rizz-home',
        label: '~/.rizz',
        severity: 'ok',
        summary: 'directory exists and is writable',
        observed: input.rizzHomeDir,
      });
    }
    return makeCheck({
      id: 'rizz-home',
      label: '~/.rizz',
      severity: 'blocker',
      summary: 'directory exists but is not writable',
      observed: input.rizzHomeDir,
      fix: 'Make ~/.rizz writable, then rerun rizz setup --dry-run.',
    });
  }

  if (input.homeWritable === true) {
    return makeCheck({
      id: 'rizz-home',
      label: '~/.rizz',
      severity: 'info',
      summary: 'missing; setup would create it later',
      observed: input.rizzHomeDir,
    });
  }

  return makeCheck({
    id: 'rizz-home',
    label: '~/.rizz',
    severity: 'blocker',
    summary: 'missing and home directory is not writable',
    observed: input.rizzHomeDir,
    fix: 'Make your home directory writable, then rerun rizz setup --dry-run.',
  });
}

export function classifyTerminal(input: TerminalDoctorInput): DependencyDoctorCheck {
  const columns = input.columns;
  if (envFlag(input.env.CI)) {
    return makeCheck({
      id: 'terminal',
      label: 'terminal',
      severity: 'info',
      summary: 'CI detected; plain output enabled',
    });
  }
  if (envFlag(input.env.RIZZ_REDUCED_MOTION)) {
    return makeCheck({
      id: 'terminal',
      label: 'terminal',
      severity: 'info',
      summary: 'reduced motion enabled',
    });
  }
  if (input.env.NO_COLOR !== undefined) {
    return makeCheck({
      id: 'terminal',
      label: 'terminal',
      severity: 'info',
      summary: 'no color; plain output enabled',
    });
  }
  if (!input.isTTY) {
    return makeCheck({
      id: 'terminal',
      label: 'terminal',
      severity: 'info',
      summary: 'non-interactive output; plain layout enabled',
    });
  }
  if (columns !== undefined && columns < 80) {
    return makeCheck({
      id: 'terminal',
      label: 'terminal',
      severity: 'warn',
      summary: 'narrow terminal; compact layout recommended',
      observed: `${columns} columns`,
    });
  }
  return makeCheck({
    id: 'terminal',
    label: 'terminal',
    severity: 'ok',
    summary: 'interactive terminal looks usable',
    ...(columns !== undefined ? { observed: `${columns} columns` } : {}),
  });
}

export function classifyKeychain(input: KeychainDoctorInput): DependencyDoctorCheck {
  switch (input.platform) {
    case 'darwin':
      if (input.helperAvailable === true) {
        return makeCheck({
          id: 'keychain',
          label: 'keychain',
          severity: 'ok',
          summary: 'macOS keychain helper is available',
          observed: 'security',
        });
      }
      return makeCheck({
        id: 'keychain',
        label: 'keychain',
        severity: 'warn',
        summary: 'macOS keychain helper was not found',
        fix: 'Make the security helper available on PATH before provider connection.',
      });
    case 'linux':
      if (input.helperAvailable === true) {
        return makeCheck({
          id: 'keychain',
          label: 'keychain',
          severity: 'ok',
          summary: 'libsecret helper is available',
          observed: 'secret-tool',
        });
      }
      return makeCheck({
        id: 'keychain',
        label: 'keychain',
        severity: 'warn',
        summary: 'no secret-tool; file fallback would be used later',
        fix: 'Install secret-tool for OS-backed credential storage, or continue with file fallback later.',
      });
    case 'win32':
      return makeCheck({
        id: 'keychain',
        label: 'keychain',
        severity: 'warn',
        summary:
          'OS keychain helper is not wired on Windows yet; file fallback would be used later',
      });
    default:
      return makeCheck({
        id: 'keychain',
        label: 'keychain',
        severity: 'info',
        summary: 'no OS keychain helper check for this platform; file fallback would be used later',
      });
  }
}

export function doctorExitCode(report: DependencyDoctorReport): 0 | 1 {
  return report.blockers > 0 ? 1 : 0;
}

export function parseSetupArgs(args: readonly string[]): SetupArgsResult {
  if (args.length === 0) return { ok: true, action: 'interactive' };
  if (args.length === 1 && args[0] === '--dry-run') return { ok: true, action: 'dry-run' };
  if (args.length === 1 && args[0] === '--help') return { ok: true, action: 'help' };
  return {
    ok: false,
    message: 'unsupported setup option(s) for this setup slice',
  };
}

export async function runCommandProbe(
  command: string,
  args: readonly string[],
): Promise<CommandProbeResult> {
  return new Promise<CommandProbeResult>((resolve) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', env: probeEnv(), timeout: 2_000 },
      (error, stdout) => {
        const output = String(stdout ?? '').trim();
        if (error === null) {
          resolve({ ok: true, stdout: output });
          return;
        }
        const code = typeof error.code === 'string' ? error.code : 'COMMAND_FAILED';
        resolve({
          ok: false,
          reason: code,
          ...(output !== '' ? { stdout: output } : {}),
        });
      },
    );
  });
}

export async function runPathAccess(path: string, mode: number): Promise<PathAccessResult> {
  try {
    await access(path, mode);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

async function probeKeychainHelper(
  currentPlatform: NodeJS.Platform,
  commandRunner: CommandRunner,
): Promise<boolean | undefined> {
  switch (currentPlatform) {
    case 'darwin':
      return (await commandRunner('which', ['security'])).ok;
    case 'linux':
      return (await commandRunner('which', ['secret-tool'])).ok;
    default:
      return undefined;
  }
}

async function classifyRizzHomeFromAccess(params: {
  readonly homeDir: string;
  readonly rizzHomeDir: string;
  readonly pathAccess: PathAccess;
}): Promise<DependencyDoctorCheck> {
  const exists = await params.pathAccess(params.rizzHomeDir, constants.F_OK);
  if (exists.ok) {
    const writable = await params.pathAccess(params.rizzHomeDir, constants.W_OK);
    return classifyRizzHome({
      rizzHomeDir: params.rizzHomeDir,
      rizzHomeExists: true,
      rizzHomeWritable: writable.ok,
    });
  }

  const homeWritable = await params.pathAccess(params.homeDir, constants.W_OK);
  return classifyRizzHome({
    rizzHomeDir: params.rizzHomeDir,
    rizzHomeExists: false,
    homeWritable: homeWritable.ok,
  });
}

function summarizeReport(checks: readonly DependencyDoctorCheck[]): DependencyDoctorReport {
  const blockers = checks.filter((check) => check.severity === 'blocker').length;
  const warnings = checks.filter((check) => check.severity === 'warn').length;
  const nextSteps = checks
    .filter((check) => check.fix !== undefined)
    .map((check) => check.fix)
    .filter((fix): fix is string => fix !== undefined);

  return {
    checks,
    blockers,
    warnings,
    nextSteps: nextSteps.length > 0 ? nextSteps : ['run rizz setup to choose a model route'],
  };
}

export async function buildDependencyDoctorReport(
  params: BuildDependencyDoctorReportParams,
): Promise<DependencyDoctorReport> {
  const checks: DependencyDoctorCheck[] = [classifyNode(params.nodeVersion)];

  const pnpm = await params.commandRunner('pnpm', ['--version']);
  let corepack: CommandProbeResult | undefined;
  if (!pnpm.ok) {
    corepack = await params.commandRunner('corepack', ['--version']);
  }
  checks.push(classifyPackageManager({ pnpm, ...(corepack !== undefined ? { corepack } : {}) }));

  const git = await params.commandRunner('git', ['--version']);
  checks.push(classifyGit(git));

  const rizzHomeDir = params.rizzHomeDir ?? join(params.homeDir, '.rizz');
  checks.push(
    await classifyRizzHomeFromAccess({
      homeDir: params.homeDir,
      rizzHomeDir,
      pathAccess: params.pathAccess,
    }),
  );

  checks.push(
    classifyTerminal({
      isTTY: params.isTTY,
      ...(params.columns !== undefined ? { columns: params.columns } : {}),
      env: params.env,
    }),
  );

  const helperAvailable = await probeKeychainHelper(params.platform, params.commandRunner);
  checks.push(
    classifyKeychain({
      platform: params.platform,
      ...(helperAvailable !== undefined ? { helperAvailable } : {}),
    }),
  );

  return summarizeReport(checks);
}

function formatCheck(check: DependencyDoctorCheck): string {
  const status = `[${check.severity}]`.padEnd(10);
  const label = check.label.padEnd(17);
  const observed = check.observed !== undefined ? ` (${check.observed})` : '';
  return `${status}${label}${check.summary}${observed}`;
}

export function formatDependencyDoctorReport(report: DependencyDoctorReport): string {
  const lines = [
    'rizz setup --dry-run',
    '',
    'dependency doctor',
    ...report.checks.map(formatCheck),
    '',
    'dry-run only: no provider connection, no package installation, no workflow enablement',
    '',
    'next steps',
    ...report.nextSteps.map((step) => `- ${step}`),
    '',
  ];
  return lines.join('\n');
}

function formatInteractiveDoctorSummary(report: DependencyDoctorReport): string {
  const lines = ['rizz setup', '', 'dependency doctor', ...report.checks.map(formatCheck), ''];
  if (report.blockers > 0) {
    lines.push('setup stopped: fix blocker(s), then rerun rizz setup', '');
    lines.push('next steps', ...report.nextSteps.map((step) => `- ${step}`), '');
    lines.push('No changes were made.', '');
    return lines.join('\n');
  }
  const warningLabel = report.warnings === 1 ? 'warning' : 'warnings';
  lines.push(`ready: no blockers, ${report.warnings} ${warningLabel}`, '');
  return lines.join('\n');
}

function cleanDisplayName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  const words = trimmed
    .replace(/[._-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return undefined;
  return words
    .slice(0, 2)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function detectFriendlyDisplayName(env: Readonly<NodeJS.ProcessEnv>, homeDir: string): string {
  return (
    cleanDisplayName(env.RIZZ_SETUP_NAME) ??
    cleanDisplayName(env.USER) ??
    cleanDisplayName(env.USERNAME) ??
    cleanDisplayName(
      homeDir
        .split(/[\\/]/)
        .filter((part) => part !== '')
        .at(-1),
    ) ??
    'there'
  );
}

function createDefaultSetupPrompt(): { readonly ask: SetupQuestion; readonly close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (prompt) =>
      new Promise((resolve) => {
        const onClose = (): void => resolve(null);
        rl.once('close', onClose);
        rl.question(prompt, (answer) => {
          rl.off('close', onClose);
          resolve(answer);
        });
      }),
    close: () => {
      rl.close();
    },
  };
}

async function askSetupQuestion(ask: SetupQuestion, question: string): Promise<string | null> {
  return new Promise((resolve) => {
    void ask(question).then(resolve);
  });
}

function summarizeCodexDoctorOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed === '') return 'codex doctor ok';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      return 'codex doctor ok';
    }
  } catch {
    // Human-readable doctor output is enough; do not parse or echo it.
  }
  return 'codex doctor ok';
}

export async function diagnoseCodexCli(commandRunner: CommandRunner): Promise<CodexCliDiagnostic> {
  const doctor = await commandRunner('codex', ['doctor', '--json']);
  if (doctor.ok) {
    return {
      status: 'ready',
      summary: 'detected through local Codex CLI',
      observed: summarizeCodexDoctorOutput(doctor.stdout),
    };
  }

  const version = await commandRunner('codex', ['--version']);
  if (version.ok) {
    return {
      status: 'needs-login',
      summary: 'installed; run codex login first',
      observed: normalizeObservedVersion('codex', version.stdout),
    };
  }

  return {
    status: 'missing',
    summary: 'not found on PATH',
  };
}

export function buildSetupProviderChoices(
  codex: CodexCliDiagnostic,
): readonly SetupProviderChoice[] {
  let codexSummary: string;
  switch (codex.status) {
    case 'ready':
      codexSummary = 'detected through local Codex CLI';
      break;
    case 'needs-login':
      codexSummary = 'installed; sign in with codex login';
      break;
    case 'missing':
      codexSummary = 'not detected; install or open Codex first';
      break;
  }

  return [
    {
      id: 'codex-subscription',
      label: 'Codex subscription',
      summary: codexSummary,
    },
    {
      id: 'openai-api',
      label: 'OpenAI direct',
      summary: 'connect with your own API key later',
    },
    {
      id: 'anthropic-api',
      label: 'Anthropic direct',
      summary: 'connect with your own API key later',
    },
    {
      id: 'skip',
      label: 'Skip for now',
      summary: 'finish setup without connecting a model',
    },
  ];
}

function defaultProviderRoute(codex: CodexCliDiagnostic): SetupProviderRouteId {
  return codex.status === 'ready' ? 'codex-subscription' : 'skip';
}

function formatSetupProviderChoices(params: {
  readonly choices: readonly SetupProviderChoice[];
  readonly defaultRoute: SetupProviderRouteId;
}): string {
  const lines = ['Choose how rizz should talk to a model:'];
  params.choices.forEach((choice, index) => {
    const marker = choice.id === params.defaultRoute ? '>' : ' ';
    lines.push(`${marker} ${index + 1}. ${choice.label.padEnd(19)} ${choice.summary}`);
  });
  lines.push('');
  return lines.join('\n');
}

function parseProviderRouteAnswer(params: {
  readonly answer: string;
  readonly choices: readonly SetupProviderChoice[];
  readonly defaultRoute: SetupProviderRouteId;
}): SetupProviderRouteId | 'cancel' | undefined {
  const normalized = params.answer.trim().toLowerCase();
  if (normalized === '') return params.defaultRoute;
  if (normalized === 'q' || normalized === 'quit' || normalized === 'cancel') return 'cancel';

  const numeric = /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : undefined;
  if (numeric !== undefined && numeric >= 1 && numeric <= params.choices.length) {
    return params.choices[numeric - 1]?.id;
  }

  const match = params.choices.find((choice) => {
    const id = choice.id.toLowerCase();
    const label = choice.label.toLowerCase();
    return normalized === id || normalized === label || id.startsWith(normalized);
  });
  return match?.id;
}

function formatRouteSelectionResult(routeId: SetupProviderRouteId): string {
  switch (routeId) {
    case 'codex-subscription':
      return [
        'Codex subscription selected.',
        'Next: rizz will use the local Codex CLI route. Live launch lands in the next slice.',
        'No credentials were read or written by rizz.',
        '',
      ].join('\n');
    case 'openai-api':
      return [
        'OpenAI direct selected.',
        'Provider connection lands in a later setup step. No key was requested now.',
        'No credentials were read or written by rizz.',
        '',
      ].join('\n');
    case 'anthropic-api':
      return [
        'Anthropic direct selected.',
        'Provider connection lands in a later setup step. No key was requested now.',
        'No credentials were read or written by rizz.',
        '',
      ].join('\n');
    case 'skip':
      return [
        'Skipped model connection for now.',
        'Run rizz setup again when you are ready to connect a model route.',
        'No credentials were read or written by rizz.',
        '',
      ].join('\n');
  }
}

async function askSetupProviderRoute(params: {
  readonly ask?: SetupQuestion;
  readonly choices: readonly SetupProviderChoice[];
  readonly defaultRoute: SetupProviderRouteId;
  readonly write: (text: string) => void;
}): Promise<SetupProviderRouteId | 'cancel'> {
  const prompt = params.ask === undefined ? createDefaultSetupPrompt() : undefined;
  const ask = params.ask ?? prompt?.ask;
  if (ask === undefined) {
    return params.defaultRoute;
  }
  try {
    const defaultIndex =
      params.choices.findIndex((choice) => choice.id === params.defaultRoute) + 1;
    while (true) {
      const answer = await askSetupQuestion(ask, `Choose route [${defaultIndex}] `);
      if (answer === null) return 'cancel';
      const route = parseProviderRouteAnswer({
        answer,
        choices: params.choices,
        defaultRoute: params.defaultRoute,
      });
      if (route !== undefined) return route;
      params.write('Choose 1, 2, 3, 4, or q to cancel.\n');
    }
  } finally {
    prompt?.close();
  }
}

async function resolveSetupProviderRoute(params: {
  readonly ask?: SetupQuestion;
  readonly isTTY: boolean;
  readonly commandRunner: CommandRunner;
  readonly write: (text: string) => void;
}): Promise<SetupProviderRouteId | 'cancel'> {
  const codex = await diagnoseCodexCli(params.commandRunner);
  const choices = buildSetupProviderChoices(codex);
  const defaultRoute = defaultProviderRoute(codex);
  params.write(formatSetupProviderChoices({ choices, defaultRoute }));

  if (params.ask === undefined && !params.isTTY) {
    return defaultRoute;
  }

  return askSetupProviderRoute({
    choices,
    defaultRoute,
    write: params.write,
    ...(params.ask !== undefined ? { ask: params.ask } : {}),
  });
}

export async function runSetupDryRun(options: RunSetupDryRunOptions = {}): Promise<0 | 1> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? osHomedir();
  const report = await buildDependencyDoctorReport({
    nodeVersion: options.nodeVersion ?? process.versions.node,
    platform: options.platform ?? osPlatform(),
    env,
    homeDir,
    ...(options.rizzHomeDir !== undefined ? { rizzHomeDir: options.rizzHomeDir } : {}),
    isTTY: options.isTTY ?? false,
    ...(options.columns !== undefined ? { columns: options.columns } : {}),
    commandRunner: options.commandRunner ?? runCommandProbe,
    pathAccess: options.pathAccess ?? runPathAccess,
  });

  options.write?.(formatDependencyDoctorReport(report));
  return doctorExitCode(report);
}

export async function runSetupInteractive(
  options: RunSetupInteractiveOptions = {},
): Promise<0 | 1> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? osHomedir();
  const report = await buildDependencyDoctorReport({
    nodeVersion: options.nodeVersion ?? process.versions.node,
    platform: options.platform ?? osPlatform(),
    env,
    homeDir,
    ...(options.rizzHomeDir !== undefined ? { rizzHomeDir: options.rizzHomeDir } : {}),
    isTTY: options.isTTY ?? false,
    ...(options.columns !== undefined ? { columns: options.columns } : {}),
    commandRunner: options.commandRunner ?? runCommandProbe,
    pathAccess: options.pathAccess ?? runPathAccess,
  });

  const write = options.write ?? ((text: string) => process.stdout.write(text));
  write(formatInteractiveDoctorSummary(report));
  if (report.blockers > 0) return 1;

  const friendlyName = options.defaultUserName ?? detectFriendlyDisplayName(env, homeDir);
  write(`Hi ${friendlyName}.\n`);
  const selectedRoute = await resolveSetupProviderRoute({
    write,
    commandRunner: options.commandRunner ?? runCommandProbe,
    isTTY: options.isTTY === true,
    ...(options.ask !== undefined ? { ask: options.ask } : {}),
  });

  if (selectedRoute === 'cancel') {
    write('setup cancelled. No changes were made. Run rizz setup to choose a route later.\n');
    return 0;
  }

  write(formatRouteSelectionResult(selectedRoute));
  return 0;
}
