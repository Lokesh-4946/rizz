import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir as osHomedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** @internal */
export type DoctorCheckId =
  | 'node'
  | 'package-manager'
  | 'git'
  | 'rizz-home'
  | 'terminal'
  | 'keychain';

/** @internal */
export type DoctorSeverity = 'ok' | 'info' | 'warn' | 'blocker';

/** @internal */
export interface DependencyDoctorCheck {
  readonly id: DoctorCheckId;
  readonly label: string;
  readonly severity: DoctorSeverity;
  readonly summary: string;
  readonly observed?: string;
  readonly fix?: string;
}

/** @internal */
export interface DependencyDoctorReport {
  readonly checks: readonly DependencyDoctorCheck[];
  readonly blockers: number;
  readonly warnings: number;
  readonly nextSteps: readonly string[];
}

/** @internal */
export interface ParsedNodeVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** @internal */
export type CommandProbeResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: string; readonly stdout?: string };

/** @internal */
export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CommandProbeResult>;

/** @internal */
export type SetupProviderRouteId =
  | 'codex-subscription'
  | 'openai-api'
  | 'openrouter-api'
  | 'anthropic-api'
  | 'skip';

/** @internal */
export type CodexCliStatus = 'ready' | 'needs-login' | 'missing';

/** @internal */
export interface CodexCliDiagnostic {
  readonly status: CodexCliStatus;
  readonly command?: string;
  readonly summary: string;
  readonly observed?: string;
}

/** @internal */
export interface SetupProviderChoice {
  readonly id: SetupProviderRouteId;
  readonly label: string;
  readonly summary: string;
}

interface SetupRouteResolution {
  readonly route: SetupProviderRouteId | 'cancel';
  readonly codex: CodexCliDiagnostic;
}

/** @internal */
export type PathAccessResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** @internal */
export type PathAccess = (path: string, mode: number) => Promise<PathAccessResult>;

/** @internal */
export interface TerminalDoctorInput {
  readonly isTTY: boolean;
  readonly columns?: number;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

/** @internal */
export interface RizzHomeDoctorInput {
  readonly rizzHomeDir: string;
  readonly rizzHomeExists: boolean;
  readonly rizzHomeWritable?: boolean;
  readonly homeWritable?: boolean;
}

/** @internal */
export interface KeychainDoctorInput {
  readonly platform: NodeJS.Platform;
  readonly helperAvailable?: boolean;
}

/** @internal */
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

/** @internal */
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

/** @internal */
export type SetupQuestion = (question: string) => Promise<string | null>;

type SetupLaunchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

interface SetupLaunchContext {
  readonly codex?: CodexCliDiagnostic;
  readonly apiKey?: string;
  readonly displayName?: string;
  readonly agentName?: string;
}

type SetupLauncher = (
  route: SetupProviderRouteId,
  context: SetupLaunchContext,
) => Promise<SetupLaunchResult>;

/** @internal */
export interface RunSetupInteractiveOptions extends RunSetupDryRunOptions {
  readonly ask?: SetupQuestion;
  readonly askSecret?: SetupQuestion;
  readonly defaultUserName?: string;
  readonly launchSelectedRoute?: SetupLauncher;
}

/** @internal */
export type SetupArgsResult =
  | { readonly ok: true; readonly action: 'interactive' | 'dry-run' | 'help' }
  | { readonly ok: false; readonly message: string };

/** @internal */
export const SETUP_USAGE = `Usage:
  rizz setup            choose model route
  rizz setup --dry-run  readiness check
  rizz setup --help     show setup help`;

function probeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...(env.USERPROFILE !== undefined ? { USERPROFILE: env.USERPROFILE } : {}),
    ...(env.CODEX_HOME !== undefined ? { CODEX_HOME: env.CODEX_HOME } : {}),
    ...(env.SystemRoot !== undefined ? { SystemRoot: env.SystemRoot } : {}),
    ...(env.WINDIR !== undefined ? { WINDIR: env.WINDIR } : {}),
    ...(env.COMSPEC !== undefined ? { COMSPEC: env.COMSPEC } : {}),
  };
}

function commandProbeTimeoutMs(command: string, args: readonly string[]): number {
  return command.includes('codex') && args[0] === 'doctor' ? 10_000 : 2_000;
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

/** @internal */
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

/** @internal */
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

/** @internal */
export function classifyPackageManager(params: {
  readonly npm: CommandProbeResult;
  readonly pnpm: CommandProbeResult;
  readonly corepack?: CommandProbeResult;
}): DependencyDoctorCheck {
  if (params.npm.ok) {
    return makeCheck({
      id: 'package-manager',
      label: 'package manager',
      severity: 'ok',
      summary: 'npm is available',
      observed: normalizeObservedVersion('npm', params.npm.stdout),
    });
  }
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
    summary: 'npm, pnpm, and corepack were not found',
    fix: 'Install Node with npm, then rerun rizz setup --dry-run.',
  });
}

/** @internal */
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

/** @internal */
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

/** @internal */
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

/** @internal */
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

/** @internal */
export function doctorExitCode(report: DependencyDoctorReport): 0 | 1 {
  return report.blockers > 0 ? 1 : 0;
}

/** @internal */
export function parseSetupArgs(args: readonly string[]): SetupArgsResult {
  if (args.length === 0) return { ok: true, action: 'interactive' };
  if (args.length === 1 && args[0] === '--dry-run') return { ok: true, action: 'dry-run' };
  if (args.length === 1 && args[0] === '--help') return { ok: true, action: 'help' };
  return {
    ok: false,
    message: 'unsupported setup option(s) for this setup slice',
  };
}

/** @internal */
export async function runCommandProbe(
  command: string,
  args: readonly string[],
): Promise<CommandProbeResult> {
  return new Promise<CommandProbeResult>((resolve) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', env: probeEnv(), timeout: commandProbeTimeoutMs(command, args) },
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

/** @internal */
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

/** @internal */
export async function buildDependencyDoctorReport(
  params: BuildDependencyDoctorReportParams,
): Promise<DependencyDoctorReport> {
  const checks: DependencyDoctorCheck[] = [classifyNode(params.nodeVersion)];

  const npm = await params.commandRunner('npm', ['--version']);
  const pnpm = npm.ok
    ? ({ ok: false, reason: 'not-needed' } as const)
    : await params.commandRunner('pnpm', ['--version']);
  let corepack: CommandProbeResult | undefined;
  if (!npm.ok && !pnpm.ok) {
    corepack = await params.commandRunner('corepack', ['--version']);
  }
  checks.push(
    classifyPackageManager({ npm, pnpm, ...(corepack !== undefined ? { corepack } : {}) }),
  );

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

/** @internal */
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

const SECRET_LIKE = /(?:sk|sess|tok|pat|npm)[_-]|eyJ|token|bearer|authorization/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: setup strips terminal controls from names.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function redactSecretLike(text: string): string {
  return SECRET_LIKE.test(text) ? '[redacted]' : text;
}

function cleanSetupAnswer(answer: string | null): string | undefined {
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const trimmed = answer
    ?.replace(ansi, ' ')
    .replace(CONTROL_CHARS, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (trimmed === undefined || trimmed === '') return undefined;
  return redactSecretLike(trimmed);
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

async function resolveSetupNames(params: {
  readonly ask?: SetupQuestion;
  readonly isTTY: boolean;
  readonly defaultName: string;
  readonly write: (text: string) => void;
}): Promise<{ readonly displayName?: string; readonly agentName?: string }> {
  if (params.ask === undefined && !params.isTTY) return {};

  const prompt = params.ask === undefined ? createDefaultSetupPrompt() : undefined;
  const ask = params.ask ?? prompt?.ask;
  if (ask === undefined) return {};

  try {
    params.write("Hey. How're you doing?\n");
    const displayAnswer = await ask(
      `What should I call you? [suggestion: ${redactSecretLike(params.defaultName)}] `,
    );
    const agentAnswer = await ask('What should I call the agent? [rizz] ');
    const displayName = cleanSetupAnswer(displayAnswer);
    const agentName = cleanSetupAnswer(agentAnswer) ?? 'rizz';
    return {
      ...(displayName !== undefined ? { displayName } : {}),
      agentName,
    };
  } finally {
    prompt?.close();
  }
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

function codexDoctorShowsChatGptAuth(stdout: string | undefined): boolean {
  const trimmed = stdout?.trim();
  if (trimmed === undefined || trimmed === '') return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const checks =
      'checks' in parsed ? (parsed as { readonly checks?: unknown }).checks : undefined;
    if (typeof checks !== 'object' || checks === null) return false;
    const auth = (checks as Readonly<Record<string, unknown>>)['auth.credentials'];
    if (typeof auth !== 'object' || auth === null) return false;
    const status = 'status' in auth ? (auth as { readonly status?: unknown }).status : undefined;
    return status === 'ok';
  } catch {
    return false;
  }
}

const CODEX_COMMAND_CANDIDATES = ['codex', '/Applications/Codex.app/Contents/Resources/codex'];

/** @internal */
export async function diagnoseCodexCli(commandRunner: CommandRunner): Promise<CodexCliDiagnostic> {
  for (const command of CODEX_COMMAND_CANDIDATES) {
    const doctor = await commandRunner(command, ['doctor', '--json']);
    if (codexDoctorShowsChatGptAuth(doctor.stdout)) {
      return {
        status: 'ready',
        command,
        summary: 'detected through local Codex CLI',
        observed: summarizeCodexDoctorOutput(doctor.stdout ?? ''),
      };
    }

    const version = await commandRunner(command, ['--version']);
    if (version.ok || doctor.ok) {
      return {
        status: 'needs-login',
        command,
        summary: 'installed; open Codex and sign in',
        observed: version.ok
          ? normalizeObservedVersion('codex', version.stdout)
          : summarizeCodexDoctorOutput(doctor.stdout ?? ''),
      };
    }
  }

  return {
    status: 'missing',
    summary: 'not detected; install or open Codex first',
  };
}

/** @internal */
export function buildSetupProviderChoices(
  codex: CodexCliDiagnostic,
): readonly SetupProviderChoice[] {
  return [
    {
      id: 'openrouter-api',
      label: 'OpenRouter direct',
      summary: 'fast BYOK path',
    },
    {
      id: 'codex-subscription',
      label: 'Codex subscription',
      summary: codex.summary,
    },
    {
      id: 'openai-api',
      label: 'OpenAI direct',
      summary: 'connect with OpenAI',
    },
    {
      id: 'anthropic-api',
      label: 'Anthropic direct',
      summary: 'connect with Anthropic',
    },
    {
      id: 'skip',
      label: 'Skip for now',
      summary: 'start without a model',
    },
  ];
}

function defaultProviderRoute(): SetupProviderRouteId {
  return 'openrouter-api';
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
      return ['Codex subscription selected.', 'Starting rizz with Codex.', ''].join('\n');
    case 'openai-api':
      return [
        'OpenAI direct selected.',
        'No model connected yet.',
        'No credentials were read or written by rizz.',
        '',
      ].join('\n');
    case 'openrouter-api':
      return ['OpenRouter direct selected.', ''].join('\n');
    case 'anthropic-api':
      return [
        'Anthropic direct selected.',
        'No model connected yet.',
        'No credentials were read or written by rizz.',
        '',
      ].join('\n');
    case 'skip':
      return [
        'Skipped model connection.',
        'Starting rizz without an active model.',
        'No credentials were read or written by rizz.',
        '',
      ].join('\n');
  }
}

function routeNeedsSetupApiKey(routeId: SetupProviderRouteId): boolean {
  return routeId === 'openrouter-api';
}

function routeSecretPrompt(routeId: SetupProviderRouteId): string {
  switch (routeId) {
    case 'openrouter-api':
      return 'Paste your OpenRouter API key (hidden): ';
    case 'codex-subscription':
    case 'openai-api':
    case 'anthropic-api':
    case 'skip':
      return '';
  }
}

function validateSetupApiKey(routeId: SetupProviderRouteId, apiKey: string): string | undefined {
  switch (routeId) {
    case 'openrouter-api':
      return apiKey.startsWith('sk-or-')
        ? undefined
        : 'That does not look like an OpenRouter API key. Check the key and try again.';
    case 'codex-subscription':
    case 'openai-api':
    case 'anthropic-api':
    case 'skip':
      return undefined;
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
      const answer = await ask(`Choose route [${defaultIndex}] `);
      if (answer === null) return 'cancel';
      const route = parseProviderRouteAnswer({
        answer,
        choices: params.choices,
        defaultRoute: params.defaultRoute,
      });
      if (route !== undefined) return route;
      params.write(`Choose 1-${params.choices.length}, or q to cancel.\n`);
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
}): Promise<SetupRouteResolution> {
  const codex = await diagnoseCodexCli(params.commandRunner);
  const choices = buildSetupProviderChoices(codex);
  const defaultRoute = params.ask === undefined && !params.isTTY ? 'skip' : defaultProviderRoute();
  params.write(formatSetupProviderChoices({ choices, defaultRoute }));

  if (params.ask === undefined && !params.isTTY) {
    return { route: defaultRoute, codex };
  }

  const route = await askSetupProviderRoute({
    choices,
    defaultRoute,
    write: params.write,
    ...(params.ask !== undefined ? { ask: params.ask } : {}),
  });
  return { route, codex };
}

/** @internal */
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

/** @internal */
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

  const detectedName = options.defaultUserName ?? detectFriendlyDisplayName(env, homeDir);
  const setupNames = await resolveSetupNames({
    write,
    defaultName: detectedName,
    isTTY: options.isTTY === true,
    ...(options.ask !== undefined ? { ask: options.ask } : {}),
  });
  const selected = await resolveSetupProviderRoute({
    write,
    commandRunner: options.commandRunner ?? runCommandProbe,
    isTTY: options.isTTY === true,
    ...(options.ask !== undefined ? { ask: options.ask } : {}),
  });

  if (selected.route === 'cancel') {
    write('setup cancelled. No changes were made. Run rizz setup to choose a route later.\n');
    return 0;
  }

  write(formatRouteSelectionResult(selected.route));
  if (options.launchSelectedRoute !== undefined && options.isTTY === true) {
    let apiKey: string | undefined;
    if (routeNeedsSetupApiKey(selected.route)) {
      const askSecret = options.askSecret;
      const answer = (await askSecret?.(routeSecretPrompt(selected.route)))?.trim();
      if (answer === undefined || answer === '') {
        write('OpenRouter key was not entered. Run rizz setup when ready.\n');
        return 0;
      }
      const validationMessage = validateSetupApiKey(selected.route, answer);
      if (validationMessage !== undefined) {
        write(`${validationMessage}\n`);
        return 1;
      }
      apiKey = answer;
    }
    const launched = await options.launchSelectedRoute(selected.route, {
      codex: selected.codex,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...setupNames,
    });
    if (!launched.ok) {
      write(`Could not start rizz: ${launched.message}\n`);
      return 1;
    }
  }
  return 0;
}
