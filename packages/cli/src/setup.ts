import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir as osHomedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';

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

export type SetupArgsResult =
  | { readonly ok: true; readonly action: 'dry-run' | 'help' }
  | { readonly ok: false; readonly message: string };

export const SETUP_USAGE = `Usage:
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
  if (args.length === 1 && args[0] === '--dry-run') return { ok: true, action: 'dry-run' };
  if (args.length === 1 && args[0] === '--help') return { ok: true, action: 'help' };
  if (args.length === 0) {
    return {
      ok: false,
      message: 'setup is interactive in a later slice; run `rizz setup --dry-run` for now',
    };
  }
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
    nextSteps:
      nextSteps.length > 0 ? nextSteps : ['run rizz setup when the interactive wizard lands'],
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
