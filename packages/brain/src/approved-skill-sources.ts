import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface ApprovedSkillSource {
  readonly id: string;
  readonly owner: string;
  readonly repository: string;
  readonly description: string;
  readonly agents: readonly string[];
  readonly license: string;
}

type SourceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

const APPROVED_SOURCES: readonly ApprovedSkillSource[] = [
  {
    id: 'anthropic-skills',
    owner: 'Anthropic',
    repository: 'https://github.com/anthropics/skills.git',
    description: 'Claude and open Agent Skills examples.',
    agents: ['claude', 'agents'],
    license: 'Apache-2.0',
  },
  {
    id: 'github-awesome-copilot',
    owner: 'GitHub',
    repository: 'https://github.com/github/awesome-copilot.git',
    description: 'Community Copilot instructions, prompts, and skills.',
    agents: ['copilot', 'agents'],
    license: 'MIT',
  },
  {
    id: 'openai-skills',
    owner: 'OpenAI',
    repository: 'https://github.com/openai/skills.git',
    description: 'OpenAI-maintained Codex skills.',
    agents: ['codex', 'agents'],
    license: 'Apache-2.0',
  },
  {
    id: 'superpowers',
    owner: 'Jesse Vincent',
    repository: 'https://github.com/obra/superpowers.git',
    description: 'Agentic software-development workflow skills.',
    agents: ['codex', 'claude', 'agents'],
    license: 'MIT',
  },
  {
    id: 'trail-of-bits-skills',
    owner: 'Trail of Bits',
    repository: 'https://github.com/trailofbits/skills.git',
    description: 'Security engineering Agent Skills.',
    agents: ['claude', 'agents'],
    license: 'CC-BY-SA-4.0',
  },
  {
    id: 'vercel-agent-skills',
    owner: 'Vercel',
    repository: 'https://github.com/vercel-labs/agent-skills.git',
    description: 'Web development Agent Skills.',
    agents: ['codex', 'claude', 'agents'],
    license: 'MIT',
  },
];

function catalogSource(
  id: string,
  catalog: readonly ApprovedSkillSource[],
): ApprovedSkillSource | undefined {
  return catalog.find((source) => source.id === id);
}

function validRevision(revision: string): boolean {
  return /^[a-f0-9]{40}$/.test(revision);
}

function git(cwd: string, args: readonly string[]): SourceResult<string> {
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (result.status !== 0)
    return {
      ok: false,
      error: {
        code: 'SKILL_SOURCE_FETCH_FAILED',
        message: result.stderr?.trim() || 'Git acquisition failed.',
      },
    };
  return { ok: true, value: result.stdout?.trim() ?? '' };
}

export function searchApprovedSkillSources(options: {
  readonly query?: string;
}): readonly ApprovedSkillSource[] {
  const query = options.query?.trim().toLowerCase() ?? '';
  return APPROVED_SOURCES.filter(
    (source) =>
      query === '' ||
      `${source.id} ${source.owner} ${source.description} ${source.agents.join(' ')}`
        .toLowerCase()
        .includes(query),
  );
}

export function previewApprovedSkillSource(options: {
  readonly id: string;
  readonly revision: string;
  readonly catalog?: readonly ApprovedSkillSource[];
}): SourceResult<{
  readonly id: string;
  readonly revision: string;
  readonly repository: string;
  readonly writes_repository: false;
  readonly executes_content: false;
  readonly requires_network: true;
}> {
  const source = catalogSource(options.id, options.catalog ?? APPROVED_SOURCES);
  if (source === undefined)
    return {
      ok: false,
      error: {
        code: 'SKILL_SOURCE_NOT_APPROVED',
        message: `Unknown approved skill source: ${options.id}`,
      },
    };
  if (!validRevision(options.revision))
    return {
      ok: false,
      error: {
        code: 'SKILL_SOURCE_PIN_INVALID',
        message: 'Skill source pin must be an exact 40-character lowercase Git commit.',
      },
    };
  return {
    ok: true,
    value: {
      id: source.id,
      revision: options.revision,
      repository: source.repository,
      writes_repository: false,
      executes_content: false,
      requires_network: true,
    },
  };
}

export async function acquireApprovedSkillSource(options: {
  readonly id: string;
  readonly revision: string;
  readonly rizzHome: string;
  readonly approved: boolean;
  readonly catalog?: readonly ApprovedSkillSource[];
}): Promise<
  SourceResult<{
    readonly source: ApprovedSkillSource;
    readonly revision: string;
    readonly checkout_dir: string;
    readonly executes_content: false;
  }>
> {
  if (!options.approved)
    return {
      ok: false,
      error: {
        code: 'SKILL_SOURCE_APPROVAL_REQUIRED',
        message: 'Network acquisition requires explicit approval.',
      },
    };
  const catalog = options.catalog ?? APPROVED_SOURCES;
  const preview = previewApprovedSkillSource({
    id: options.id,
    revision: options.revision,
    catalog,
  });
  if (!preview.ok) return preview;
  const source = catalogSource(options.id, catalog);
  if (source === undefined)
    return {
      ok: false,
      error: {
        code: 'SKILL_SOURCE_NOT_APPROVED',
        message: `Unknown approved skill source: ${options.id}`,
      },
    };
  const base = join(options.rizzHome, 'global', 'skills', 'sources', source.id);
  const destination = join(base, options.revision);
  let temporary: string | undefined;
  try {
    const existing = git(destination, ['rev-parse', 'HEAD']);
    if (existing.ok && existing.value === options.revision)
      return {
        ok: true,
        value: {
          source,
          revision: options.revision,
          checkout_dir: await realpath(destination),
          executes_content: false,
        },
      };
    temporary = join(base, `.acquire-${process.pid}-${randomUUID()}`);
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const initialized = git(temporary, ['init', '--quiet']);
    if (!initialized.ok) return initialized;
    const remote = git(temporary, ['remote', 'add', 'origin', source.repository]);
    if (!remote.ok) return remote;
    const fetched = git(temporary, ['fetch', '--quiet', '--depth=1', 'origin', options.revision]);
    if (!fetched.ok) return fetched;
    const checkedOut = git(temporary, ['checkout', '--quiet', '--detach', options.revision]);
    if (!checkedOut.ok) return checkedOut;
    const head = git(temporary, ['rev-parse', 'HEAD']);
    if (!head.ok || head.value !== options.revision)
      return {
        ok: false,
        error: {
          code: 'SKILL_SOURCE_VERIFY_FAILED',
          message: 'Acquired checkout does not match the requested revision.',
        },
      };
    await mkdir(base, { recursive: true, mode: 0o700 });
    await rename(temporary, destination);
    return {
      ok: true,
      value: {
        source,
        revision: options.revision,
        checkout_dir: await realpath(destination),
        executes_content: false,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'SKILL_SOURCE_FETCH_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    if (temporary !== undefined)
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
