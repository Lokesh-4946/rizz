import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type BridgeStatus = 'created' | 'unchanged' | 'planned';

interface BridgeWrite {
  readonly agent: string;
  readonly skill: string;
  readonly path: string;
  readonly digest: string;
  readonly status: BridgeStatus;
}

interface AgentBridgeResult {
  readonly command: 'detect' | 'configure' | 'doctor';
  readonly agents: readonly AgentDetection[];
  readonly writes: readonly BridgeWrite[];
  readonly checks: readonly BridgeCheck[];
  readonly applied: boolean;
  readonly healthy: boolean;
}

interface AgentDetection {
  readonly id: string;
  readonly command: string | null;
  readonly command_detected: boolean;
  readonly skills_dir: string;
  readonly skills_dir_detected: boolean;
}

interface BridgeCheck {
  readonly agent: string;
  readonly skill: string;
  readonly path: string;
  readonly status: 'healthy' | 'missing' | 'conflict';
}

interface AgentCommandOptions {
  readonly args: readonly string[];
  readonly homeDir: string;
  readonly commandExists?: (command: string) => boolean;
}

type AgentCommandResponse =
  | { readonly ok: true; readonly value: AgentBridgeResult }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

const TARGETS = [
  { id: 'agents', command: null, directory: '.agents' },
  { id: 'codex', command: 'codex', directory: '.codex' },
  { id: 'claude', command: 'claude', directory: '.claude' },
  { id: 'copilot', command: 'copilot', directory: '.copilot' },
] as const;

const SKILLS = [
  {
    name: 'use-rizz-context',
    description:
      'Use when starting repository work that benefits from scoped, evidence-backed Rizz context.',
    body: 'Set `TASK` to the accepted task, then run `rizz prepare` and `rizz brief "$TASK" --json`. Use the returned project ID, revision, citations, omissions, and evidence gaps. Do not treat AI hypotheses as verified facts.',
  },
  {
    name: 'follow-rizz-loop',
    description: 'Use when implementing repository work through the Rizz engineering loop.',
    body: 'Run `rizz loop status --json`, then follow prepare → brief → start → plan → implement → verify → review → complete → handoff. Keep scope and current revision aligned. Let the AI reason and edit; use Rizz to preserve evidence and continuity.',
  },
  {
    name: 'prepare-rizz-review',
    description: 'Use before reviewing a change with deterministic Rizz evidence.',
    body: 'Run `rizz review` for the current diff. Validate every proposed finding against exact file and line evidence, preserve redaction, and report unsupported concerns as evidence gaps rather than facts.',
  },
  {
    name: 'record-rizz-checkpoint',
    description: 'Use after a meaningful implementation or verification checkpoint.',
    body: 'Read `rizz loop status --json`, then run `rizz loop checkpoint --json` with the current sequence and a concise evidence-backed summary. Record inspected files, changed files, commands, results, blockers, and the agent/tool used.',
  },
  {
    name: 'handoff-rizz-work',
    description: 'Use when pausing or completing work that another AI or developer may continue.',
    body: 'Run `rizz loop handoff --json` with the current project ID, revision, sequence, completed scope, verification, unresolved evidence gaps, and exact next baton. Do not copy project-private state into the repository.',
  },
] as const;

function skillContent(skill: (typeof SKILLS)[number]): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# Rizz bridge\n\n${skill.body}\n\nAlways query Rizz from the current repository. Rizz state is user-local and project-isolated; never create or commit a project brain, adapter, or generated Rizz state.\n`;
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function optionalRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function detections(options: AgentCommandOptions): Promise<AgentDetection[]> {
  const exists =
    options.commandExists ??
    ((command: string) => {
      const checked = spawnSync(command, ['--version'], { stdio: 'ignore' });
      return checked.status === 0;
    });
  return Promise.all(
    TARGETS.filter((target) => target.command !== null).map(async (target) => {
      const skillsDir = join(options.homeDir, target.directory, 'skills');
      return {
        id: target.id,
        command: target.command,
        command_detected: exists(target.command),
        skills_dir: skillsDir,
        skills_dir_detected: await directoryExists(skillsDir),
      };
    }),
  );
}

function bridgeEntries(homeDir: string) {
  return TARGETS.flatMap((target) =>
    SKILLS.map((skill) => {
      const content = skillContent(skill);
      return {
        agent: target.id,
        skill: skill.name,
        path: join(homeDir, target.directory, 'skills', skill.name, 'SKILL.md'),
        content,
        digest: digest(content),
      };
    }),
  );
}

async function inspectBridges(homeDir: string): Promise<BridgeCheck[]> {
  return Promise.all(
    bridgeEntries(homeDir).map(async (entry) => {
      const existing = await optionalRead(entry.path);
      return {
        agent: entry.agent,
        skill: entry.skill,
        path: entry.path,
        status: existing === null ? 'missing' : existing === entry.content ? 'healthy' : 'conflict',
      } as const;
    }),
  );
}

function baseResult(
  command: AgentBridgeResult['command'],
  agents: readonly AgentDetection[],
): AgentBridgeResult {
  return { command, agents, writes: [], checks: [], applied: false, healthy: false };
}

export async function executeAgentCommand(
  options: AgentCommandOptions,
): Promise<AgentCommandResponse> {
  const command = options.args[1];
  const agents = await detections(options);
  if (command === 'detect') {
    if (options.args.some((arg, index) => index > 1 && arg !== '--json')) {
      return {
        ok: false,
        error: { code: 'AGENT_OPTION_UNKNOWN', message: 'Detect accepts only --json.' },
      };
    }
    return { ok: true, value: { ...baseResult('detect', agents), healthy: true } };
  }
  if (command === 'doctor') {
    if (options.args.some((arg, index) => index > 1 && arg !== '--json')) {
      return {
        ok: false,
        error: { code: 'AGENT_OPTION_UNKNOWN', message: 'Doctor accepts only --json.' },
      };
    }
    const checks = await inspectBridges(options.homeDir);
    return {
      ok: true,
      value: {
        ...baseResult('doctor', agents),
        checks,
        healthy: checks.every((check) => check.status === 'healthy'),
      },
    };
  }
  if (command !== 'configure' || !options.args.includes('--user')) {
    return {
      ok: false,
      error: {
        code: 'AGENT_COMMAND_INVALID',
        message: 'Use agents detect, configure --user, or doctor.',
      },
    };
  }
  const configureOptions = new Set(['--user', '--dry-run', '--json']);
  const unknown = options.args.slice(2).find((arg) => !configureOptions.has(arg));
  if (unknown !== undefined) {
    return {
      ok: false,
      error: { code: 'AGENT_OPTION_UNKNOWN', message: `Unknown option: ${unknown}` },
    };
  }
  const entries = bridgeEntries(options.homeDir);
  const inspected = await inspectBridges(options.homeDir);
  const conflict = inspected.find((check) => check.status === 'conflict');
  if (conflict !== undefined) {
    return {
      ok: false,
      error: {
        code: 'AGENT_SKILL_CONFLICT',
        message: `Refusing to overwrite existing user skill: ${conflict.path}`,
      },
    };
  }
  const isDryRun = options.args.includes('--dry-run');
  const writes: BridgeWrite[] = [];
  for (const entry of entries) {
    const existing = await optionalRead(entry.path);
    if (existing === entry.content) {
      writes.push({
        agent: entry.agent,
        skill: entry.skill,
        path: entry.path,
        digest: entry.digest,
        status: 'unchanged',
      });
      continue;
    }
    if (isDryRun) {
      writes.push({
        agent: entry.agent,
        skill: entry.skill,
        path: entry.path,
        digest: entry.digest,
        status: 'planned',
      });
      continue;
    }
    await mkdir(join(entry.path, '..'), { recursive: true });
    try {
      await writeFile(entry.path, entry.content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = await optionalRead(entry.path);
      if (raced !== entry.content) {
        return {
          ok: false,
          error: {
            code: 'AGENT_SKILL_CONFLICT',
            message: `Concurrent skill conflict: ${entry.path}`,
          },
        };
      }
    }
    if ((await readFile(entry.path, 'utf8')) !== entry.content) {
      return {
        ok: false,
        error: {
          code: 'AGENT_SKILL_VERIFY_FAILED',
          message: `Skill write verification failed: ${entry.path}`,
        },
      };
    }
    writes.push({
      agent: entry.agent,
      skill: entry.skill,
      path: entry.path,
      digest: entry.digest,
      status: 'created',
    });
  }
  return {
    ok: true,
    value: {
      ...baseResult('configure', agents),
      writes,
      applied: !isDryRun,
      healthy: !isDryRun,
    },
  };
}
