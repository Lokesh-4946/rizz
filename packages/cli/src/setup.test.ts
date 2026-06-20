import { constants } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type CommandProbeResult,
  type CommandRunner,
  type DependencyDoctorReport,
  type PathAccess,
  buildDependencyDoctorReport,
  classifyKeychain,
  classifyNode,
  classifyPackageManager,
  classifyTerminal,
  doctorExitCode,
  formatDependencyDoctorReport,
  parseSetupArgs,
  runCommandProbe,
  runSetupInteractive,
} from './setup.js';

const HOME = '/tmp/rizz-home';
const RIZZ_HOME = `${HOME}/.rizz`;

interface AccessFact {
  readonly exists: boolean;
  readonly writable: boolean;
}

interface ReportFixtureOptions {
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly commandResults?: Readonly<Record<string, CommandProbeResult>>;
  readonly accessFacts?: Readonly<Record<string, AccessFact>>;
}

function commandKey(command: string, args: readonly string[]): string {
  return `${command} ${args.join(' ')}`;
}

function commandFixture(results: Readonly<Record<string, CommandProbeResult>>): {
  readonly calls: string[];
  readonly runner: CommandRunner;
} {
  const calls: string[] = [];
  return {
    calls,
    runner: async (command, args) => {
      calls.push(commandKey(command, args));
      return results[commandKey(command, args)] ?? { ok: false, reason: 'ENOENT' };
    },
  };
}

function accessFixture(facts: Readonly<Record<string, AccessFact>>): {
  readonly calls: Array<{ readonly path: string; readonly mode: number }>;
  readonly pathAccess: PathAccess;
} {
  const calls: Array<{ readonly path: string; readonly mode: number }> = [];
  return {
    calls,
    pathAccess: async (path, mode) => {
      calls.push({ path, mode });
      const fact = facts[path] ?? { exists: false, writable: false };
      if (mode === constants.F_OK)
        return fact.exists ? { ok: true } : { ok: false, reason: 'ENOENT' };
      if (mode === constants.W_OK) {
        return fact.writable ? { ok: true } : { ok: false, reason: 'EACCES' };
      }
      return { ok: false, reason: 'unsupported access mode' };
    },
  };
}

async function buildReportFixture(options: ReportFixtureOptions = {}): Promise<{
  readonly report: DependencyDoctorReport;
  readonly commandCalls: readonly string[];
  readonly accessCalls: ReadonlyArray<{ readonly path: string; readonly mode: number }>;
}> {
  const commands = commandFixture({
    'pnpm --version': { ok: true, stdout: '11.6.0' },
    'git --version': { ok: true, stdout: 'git version 2.45.0' },
    'which secret-tool': { ok: true, stdout: '/usr/bin/secret-tool' },
    ...(options.commandResults ?? {}),
  });
  const access = accessFixture({
    [HOME]: { exists: true, writable: true },
    [RIZZ_HOME]: { exists: true, writable: true },
    ...(options.accessFacts ?? {}),
  });
  const report = await buildDependencyDoctorReport({
    nodeVersion: options.nodeVersion ?? '24.0.0',
    platform: options.platform ?? 'linux',
    env: options.env ?? {},
    homeDir: HOME,
    rizzHomeDir: RIZZ_HOME,
    isTTY: options.isTTY ?? true,
    ...(options.columns !== undefined ? { columns: options.columns } : {}),
    commandRunner: commands.runner,
    pathAccess: access.pathAccess,
  });
  return { report, commandCalls: commands.calls, accessCalls: access.calls };
}

function findCheck(report: DependencyDoctorReport, id: string) {
  return report.checks.find((check) => check.id === id);
}

describe('setup dependency doctor', () => {
  it('accepts Node 22.x and 24.x', () => {
    expect(classifyNode('22.0.0')).toMatchObject({ severity: 'ok' });
    expect(classifyNode('v24.1.2')).toMatchObject({ severity: 'ok' });
  });

  it('treats Node 21.x as a blocker and exits 1', async () => {
    const { report } = await buildReportFixture({ nodeVersion: '21.9.0' });

    expect(findCheck(report, 'node')).toMatchObject({ severity: 'blocker' });
    expect(doctorExitCode(report)).toBe(1);
  });

  it('passes when pnpm is present without checking corepack', async () => {
    const { report, commandCalls } = await buildReportFixture();

    expect(findCheck(report, 'package-manager')).toMatchObject({
      severity: 'ok',
      summary: 'pnpm is available',
    });
    expect(commandCalls).not.toContain('corepack --version');
  });

  it('passes when pnpm is absent but corepack is present', () => {
    const check = classifyPackageManager({
      pnpm: { ok: false, reason: 'ENOENT' },
      corepack: { ok: true, stdout: '0.31.0' },
    });

    expect(check).toMatchObject({
      severity: 'ok',
      summary: 'corepack is available; pnpm can be activated',
    });
  });

  it('warns, without exit 1, when both pnpm and corepack are absent', async () => {
    const { report } = await buildReportFixture({
      commandResults: {
        'pnpm --version': { ok: false, reason: 'ENOENT' },
        'corepack --version': { ok: false, reason: 'ENOENT' },
      },
    });

    expect(findCheck(report, 'package-manager')).toMatchObject({ severity: 'warn' });
    expect(doctorExitCode(report)).toBe(0);
  });

  it('warns, without exit 1, when git is missing', async () => {
    const { report } = await buildReportFixture({
      commandResults: { 'git --version': { ok: false, reason: 'ENOENT' } },
    });

    expect(findCheck(report, 'git')).toMatchObject({ severity: 'warn' });
    expect(doctorExitCode(report)).toBe(0);
  });

  it('passes when existing ~/.rizz is writable', async () => {
    const { report } = await buildReportFixture();

    expect(findCheck(report, 'rizz-home')).toMatchObject({
      severity: 'ok',
      summary: 'directory exists and is writable',
    });
  });

  it('blocks when existing ~/.rizz is not writable', async () => {
    const { report } = await buildReportFixture({
      accessFacts: { [RIZZ_HOME]: { exists: true, writable: false } },
    });

    expect(findCheck(report, 'rizz-home')).toMatchObject({ severity: 'blocker' });
    expect(doctorExitCode(report)).toBe(1);
  });

  it('does not write when ~/.rizz is missing and home is writable', async () => {
    const { report, accessCalls } = await buildReportFixture({
      accessFacts: { [RIZZ_HOME]: { exists: false, writable: false } },
    });

    expect(findCheck(report, 'rizz-home')).toMatchObject({
      severity: 'info',
      summary: 'missing; setup would create it later',
    });
    expect(accessCalls).toEqual([
      { path: RIZZ_HOME, mode: constants.F_OK },
      { path: HOME, mode: constants.W_OK },
    ]);
  });

  it('keeps terminal NO_COLOR, CI, narrow columns, and reduced motion as info/warn only', () => {
    expect(classifyTerminal({ isTTY: true, env: { NO_COLOR: '1' } })).toMatchObject({
      severity: 'info',
    });
    expect(classifyTerminal({ isTTY: true, env: { CI: '1' } })).toMatchObject({
      severity: 'info',
    });
    expect(classifyTerminal({ isTTY: true, env: { RIZZ_REDUCED_MOTION: '1' } })).toMatchObject({
      severity: 'info',
    });
    expect(classifyTerminal({ isTTY: true, columns: 60, env: {} })).toMatchObject({
      severity: 'warn',
    });
  });

  it('reports darwin security helper as keychain ok when present', async () => {
    const { report } = await buildReportFixture({
      platform: 'darwin',
      commandResults: { 'which security': { ok: true, stdout: '/usr/bin/security' } },
    });

    expect(findCheck(report, 'keychain')).toMatchObject({
      severity: 'ok',
      observed: 'security',
    });
  });

  it('reports linux missing secret-tool as a later file fallback warning', () => {
    const check = classifyKeychain({ platform: 'linux', helperAvailable: false });

    expect(check).toMatchObject({
      severity: 'warn',
      summary: 'no secret-tool; file fallback would be used later',
    });
  });

  it('formats statuses and next steps without provider-key language', async () => {
    const { report } = await buildReportFixture({
      commandResults: { 'git --version': { ok: false, reason: 'ENOENT' } },
    });
    const output = formatDependencyDoctorReport(report);

    expect(output).toContain('[ok]');
    expect(output).toContain('[warn]');
    expect(output).toContain('next steps');
    expect(output).toContain('Install git if you want repo-aware workflows.');
    expect(output).not.toMatch(/ANTHROPIC_API_KEY|api key|provider key|token/i);
  });

  it('parses setup, setup --dry-run, and setup --help for this slice', () => {
    expect(parseSetupArgs([])).toEqual({ ok: true, action: 'interactive' });
    expect(parseSetupArgs(['--dry-run'])).toEqual({ ok: true, action: 'dry-run' });
    expect(parseSetupArgs(['--help'])).toEqual({ ok: true, action: 'help' });
    expect(parseSetupArgs(['--provider', 'anthropic'])).toMatchObject({ ok: false });
    expect(parseSetupArgs(['--dry-run', '--json'])).toMatchObject({ ok: false });
  });

  it('does not echo unsupported secret-like setup args', () => {
    const parsed = parseSetupArgs(['--provider-key', 'sk-ant-secret']);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).not.toContain('sk-ant-secret');
      expect(parsed.message).not.toContain('--provider-key');
    }
  });

  it('does not expose provider secrets to command probes', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    try {
      const result = await runCommandProbe(process.execPath, [
        '-e',
        'process.stdout.write(process.env.ANTHROPIC_API_KEY ?? "unset")',
      ]);

      expect(result).toEqual({ ok: true, stdout: 'unset' });
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });

  it('interactive setup launches demo TUI with a launch-only agent name', async () => {
    const answers = ['juno_01', ''];
    const output: string[] = [];
    const launched: string[] = [];
    const code = await runSetupInteractive({
      nodeVersion: '24.0.0',
      platform: 'linux',
      env: { USER: 'lokesh' },
      homeDir: HOME,
      rizzHomeDir: RIZZ_HOME,
      isTTY: false,
      commandRunner: commandFixture({
        'pnpm --version': { ok: true, stdout: '11.6.0' },
        'git --version': { ok: true, stdout: 'git version 2.45.0' },
        'which secret-tool': { ok: false, reason: 'ENOENT' },
      }).runner,
      pathAccess: accessFixture({
        [HOME]: { exists: true, writable: true },
        [RIZZ_HOME]: { exists: false, writable: false },
      }).pathAccess,
      ask: async () => answers.shift() ?? '',
      write: (text) => output.push(text),
      startDemoTui: async ({ agentName }) => {
        launched.push(agentName);
      },
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('rizz setup');
    expect(output.join('')).toContain('ready: no blockers');
    expect(output.join('')).toContain('Hi Lokesh.');
    expect(output.join('')).toContain('Harness Mode is local demo mode');
    expect(output.join('')).toContain('launch name: juno_01');
    expect(output.join('')).toContain('credentials: none');
    expect(output.join('')).toContain('saved profile: none');
    expect(output.join('')).toContain('Harness Mode ready');
    expect(launched).toEqual(['juno_01']);
  });

  it('interactive setup can cancel before launching the TUI', async () => {
    const answers = ['', 'cancel'];
    const launched: string[] = [];
    const output: string[] = [];
    const code = await runSetupInteractive({
      nodeVersion: '24.0.0',
      platform: 'linux',
      env: {},
      homeDir: HOME,
      rizzHomeDir: RIZZ_HOME,
      isTTY: false,
      commandRunner: commandFixture({
        'pnpm --version': { ok: true, stdout: '11.6.0' },
        'git --version': { ok: true, stdout: 'git version 2.45.0' },
        'which secret-tool': { ok: false, reason: 'ENOENT' },
      }).runner,
      pathAccess: accessFixture({
        [HOME]: { exists: true, writable: true },
        [RIZZ_HOME]: { exists: false, writable: false },
      }).pathAccess,
      ask: async () => answers.shift() ?? '',
      write: (text) => output.push(text),
      startDemoTui: async ({ agentName }) => {
        launched.push(agentName);
      },
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('launch name: pi');
    expect(output.join('')).toContain('setup cancelled. No changes were made.');
    expect(launched).toEqual([]);
  });

  it('interactive setup retries invalid launch choices', async () => {
    const answers = ['nova', 'maybe', 'demo'];
    const output: string[] = [];
    const launched: string[] = [];
    const code = await runSetupInteractive({
      nodeVersion: '24.0.0',
      platform: 'linux',
      env: {},
      homeDir: HOME,
      rizzHomeDir: RIZZ_HOME,
      isTTY: false,
      commandRunner: commandFixture({
        'pnpm --version': { ok: true, stdout: '11.6.0' },
        'git --version': { ok: true, stdout: 'git version 2.45.0' },
        'which secret-tool': { ok: false, reason: 'ENOENT' },
      }).runner,
      pathAccess: accessFixture({
        [HOME]: { exists: true, writable: true },
        [RIZZ_HOME]: { exists: false, writable: false },
      }).pathAccess,
      ask: async () => answers.shift() ?? '',
      write: (text) => output.push(text),
      startDemoTui: async ({ agentName }) => {
        launched.push(agentName);
      },
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('Choose Y to start, or n to cancel.');
    expect(launched).toEqual(['nova']);
  });

  it('interactive setup stops before prompting when the doctor has blockers', async () => {
    let promptCount = 0;
    let launchCount = 0;
    const output: string[] = [];
    const code = await runSetupInteractive({
      nodeVersion: '21.9.0',
      platform: 'linux',
      env: {},
      homeDir: HOME,
      rizzHomeDir: RIZZ_HOME,
      isTTY: false,
      commandRunner: commandFixture({}).runner,
      pathAccess: accessFixture({
        [HOME]: { exists: true, writable: true },
        [RIZZ_HOME]: { exists: true, writable: true },
      }).pathAccess,
      ask: async () => {
        promptCount += 1;
        return '';
      },
      write: (text) => output.push(text),
      startDemoTui: async () => {
        launchCount += 1;
      },
    });

    expect(code).toBe(1);
    expect(output.join('')).toContain('setup stopped');
    expect(output.join('')).toContain('No changes were made.');
    expect(promptCount).toBe(0);
    expect(launchCount).toBe(0);
  });
});
