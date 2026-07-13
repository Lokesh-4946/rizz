import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { type ApprovedSkillSource, searchApprovedSkillSources } from './approved-skill-sources.js';
import { auditSkillSource } from './skill-source-manager.js';

const MAX_ACQUIRED_REVISIONS = 64;
const MAX_INDEXED_SKILLS = 5_000;
export const MAX_ACQUIRED_SKILL_RESULTS = 100;

type DiscoveryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  readonly relative_path: string;
  readonly source_id: string;
  readonly source_repository: string;
  readonly revision: string;
  readonly digest: string;
  readonly supported_agents: readonly string[];
  readonly audit_status: 'clean' | 'approval-required';
  readonly audit_findings: readonly {
    readonly code: string;
    readonly severity: 'info' | 'warning';
    readonly path: string;
    readonly summary: string;
  }[];
  readonly requirements: {
    readonly shell: boolean;
    readonly network: boolean;
    readonly credentials: boolean;
  };
  readonly license: string;
  readonly attribution: string;
}

interface AcquiredSourceEvidence {
  readonly source_id: string;
  readonly source_repository: string;
  readonly revision: string;
  readonly skill_count: number;
}

interface SkillDiscoveryIndex {
  readonly schema_version: 1;
  readonly sources: readonly AcquiredSourceEvidence[];
  readonly skills: readonly DiscoveredSkill[];
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function git(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

function failed(code: string, message: string): DiscoveryResult<never> {
  return { ok: false, error: { code, message } };
}

function normalizedRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const nested = relative(parent, candidate);
  return (
    nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
}

async function revisionDirectories(path: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function verifyCheckout(options: {
  readonly checkoutDir: string;
  readonly revision: string;
  readonly source: ApprovedSkillSource;
}): Promise<DiscoveryResult<readonly string[]>> {
  if (!/^[a-f0-9]{40}$/.test(options.revision))
    return failed(
      'SKILL_SOURCE_REVISION_INVALID',
      `Acquired source directory is not an exact revision: ${options.revision}`,
    );
  try {
    const metadata = await lstat(options.checkoutDir);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      return failed('SKILL_SOURCE_TAMPERED', 'Acquired source checkout must be a real directory.');
    const canonicalParent = await realpath(dirname(options.checkoutDir));
    if ((await realpath(options.checkoutDir)) !== join(canonicalParent, options.revision))
      return failed('SKILL_SOURCE_TAMPERED', 'Acquired source checkout escapes its cache path.');
  } catch (error) {
    return failed(
      'SKILL_SOURCE_CACHE_MISSING',
      error instanceof Error ? error.message : String(error),
    );
  }
  const head = git(options.checkoutDir, ['rev-parse', 'HEAD']);
  if (!head.ok || head.stdout !== options.revision)
    return failed(
      'SKILL_SOURCE_REVISION_DRIFT',
      'Acquired source HEAD does not match its exact revision directory.',
    );
  const origin = git(options.checkoutDir, ['config', '--get', 'remote.origin.url']);
  if (!origin.ok || origin.stdout !== options.source.repository)
    return failed(
      'SKILL_SOURCE_ORIGIN_MISMATCH',
      `Acquired source origin does not match ${options.source.repository}.`,
    );
  const status = git(options.checkoutDir, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status.ok || status.stdout !== '')
    return failed(
      'SKILL_SOURCE_TAMPERED',
      'Acquired source contains tracked or untracked changes.',
    );
  const manifests = git(options.checkoutDir, ['ls-files', '-z', '--', ':(glob)**/SKILL.md']);
  if (!manifests.ok)
    return failed(
      'SKILL_SOURCE_INSPECT_FAILED',
      manifests.stderr || 'Could not enumerate tracked skill manifests.',
    );
  return {
    ok: true,
    value: manifests.stdout === '' ? [] : manifests.stdout.split('\0').filter(Boolean).sort(),
  };
}

function compareSkills(left: DiscoveredSkill, right: DiscoveredSkill): number {
  const leftKey = `${left.name}\0${left.source_id}\0${left.revision}\0${left.relative_path}`;
  const rightKey = `${right.name}\0${right.source_id}\0${right.revision}\0${right.relative_path}`;
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

async function buildIndex(options: {
  readonly rizzHome: string;
  readonly sourceId?: string;
  readonly revision?: string;
}): Promise<DiscoveryResult<SkillDiscoveryIndex>> {
  try {
    const catalog = searchApprovedSkillSources({ query: '' });
    const sources =
      options.sourceId === undefined
        ? catalog
        : catalog.filter((source) => source.id === options.sourceId);
    if (options.sourceId !== undefined && sources.length === 0)
      return failed(
        'SKILL_SOURCE_NOT_APPROVED',
        `Unknown approved skill source: ${options.sourceId}`,
      );
    const evidence: AcquiredSourceEvidence[] = [];
    const skills: DiscoveredSkill[] = [];
    let revisionCount = 0;
    for (const source of sources) {
      const sourceBase = join(options.rizzHome, 'global', 'skills', 'sources', source.id);
      try {
        const sourceMetadata = await lstat(sourceBase);
        if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory())
          return failed(
            'SKILL_SOURCE_TAMPERED',
            `Acquired source cache must be a real directory: ${source.id}`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (options.revision !== undefined)
          return failed(
            'SKILL_SOURCE_CACHE_MISSING',
            `Acquired source cache is missing: ${source.id}@${options.revision}`,
          );
        continue;
      }
      const revisions =
        options.revision === undefined ? await revisionDirectories(sourceBase) : [options.revision];
      for (const revision of revisions) {
        revisionCount += 1;
        if (revisionCount > MAX_ACQUIRED_REVISIONS)
          return failed(
            'SKILL_INDEX_SOURCE_LIMIT',
            `Skill discovery supports at most ${MAX_ACQUIRED_REVISIONS} acquired revisions.`,
          );
        const checkoutDir = join(sourceBase, revision);
        const verified = await verifyCheckout({ checkoutDir, revision, source });
        if (!verified.ok) return verified;
        const before = skills.length;
        for (const manifest of verified.value) {
          if (skills.length >= MAX_INDEXED_SKILLS)
            return failed(
              'SKILL_INDEX_SKILL_LIMIT',
              `Skill discovery supports at most ${MAX_INDEXED_SKILLS} skills.`,
            );
          const skillDir = join(checkoutDir, dirname(manifest));
          const audited = await auditSkillSource({ sourceDir: skillDir });
          if (!audited.ok)
            return failed(
              audited.error.code,
              `${source.id}@${revision}:${dirname(manifest)}: ${audited.error.message}`,
            );
          const license =
            audited.value.license.id === 'UNKNOWN' ? source.license : audited.value.license.id;
          const auditFindings =
            source.license === 'UNKNOWN'
              ? audited.value.findings
              : audited.value.findings.filter(
                  (finding) => finding.code !== 'SKILL_LICENSE_UNKNOWN',
                );
          skills.push({
            name: audited.value.name,
            description: audited.value.description,
            relative_path: normalizedRelative(checkoutDir, skillDir),
            source_id: source.id,
            source_repository: source.repository,
            revision,
            digest: audited.value.digest,
            supported_agents: source.agents,
            audit_status: auditFindings.length === 0 ? 'clean' : 'approval-required',
            audit_findings: auditFindings,
            requirements: audited.value.requirements,
            license,
            attribution: source.owner,
          });
        }
        evidence.push({
          source_id: source.id,
          source_repository: source.repository,
          revision,
          skill_count: skills.length - before,
        });
      }
    }
    if (revisionCount === 0)
      return failed(
        'SKILL_SOURCE_CACHE_MISSING',
        'No previously acquired approved skill collections were found.',
      );
    skills.sort(compareSkills);
    return { ok: true, value: { schema_version: 1, sources: evidence, skills } };
  } catch (error) {
    return failed(
      'SKILL_INDEX_BUILD_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function writeIndexObject(options: {
  readonly rizzHome: string;
  readonly index: SkillDiscoveryIndex;
  readonly repositoryRoot?: string;
}): Promise<DiscoveryResult<{ readonly digest: string; readonly path: string }>> {
  const contents = `${JSON.stringify(options.index, null, 2)}\n`;
  const digest = createHash('sha256').update(contents).digest('hex');
  const path = join(options.rizzHome, 'global', 'skills', 'indexes', `${digest}.json`);
  try {
    if (options.repositoryRoot !== undefined) {
      const topLevel = git(options.repositoryRoot, ['rev-parse', '--show-toplevel']);
      const repositoryRoot = await realpath(topLevel.ok ? topLevel.stdout : options.repositoryRoot);
      const rizzHome = await realpath(options.rizzHome);
      if (pathIsWithin(repositoryRoot, rizzHome))
        return failed(
          'SKILL_INDEX_REPOSITORY_LOCAL',
          'Skill discovery indexes must stay outside the project repository.',
        );
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if ((await readFile(path, 'utf8')) !== contents)
      return failed(
        'SKILL_INDEX_OBJECT_TAMPERED',
        'Content-addressed skill index does not match its digest.',
      );
    return { ok: true, value: { digest, path } };
  } catch (error) {
    return failed(
      'SKILL_INDEX_WRITE_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function searchAcquiredSkills(options: {
  readonly rizzHome: string;
  readonly query?: string;
  readonly limit?: number;
  readonly sourceId?: string;
  readonly revision?: string;
  readonly repositoryRoot?: string;
}): Promise<
  DiscoveryResult<{
    readonly index_digest: string;
    readonly index_path: string;
    readonly total_indexed: number;
    readonly matched: number;
    readonly returned: number;
    readonly truncated: boolean;
    readonly results: readonly DiscoveredSkill[];
  }>
> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACQUIRED_SKILL_RESULTS)
    return failed(
      'SKILL_SEARCH_LIMIT_INVALID',
      `Skill search limit must be an integer from 1 to ${MAX_ACQUIRED_SKILL_RESULTS}.`,
    );
  if ((options.sourceId === undefined) !== (options.revision === undefined))
    return failed(
      'SKILL_SEARCH_SOURCE_INVALID',
      'Exact source filtering requires both source ID and revision.',
    );
  if (options.revision !== undefined && !/^[a-f0-9]{40}$/.test(options.revision))
    return failed(
      'SKILL_SOURCE_REVISION_INVALID',
      'Skill source revision must be an exact 40-character lowercase Git commit.',
    );
  const indexed = await buildIndex({
    rizzHome: options.rizzHome,
    ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
    ...(options.revision === undefined ? {} : { revision: options.revision }),
  });
  if (!indexed.ok) return indexed;
  const stored = await writeIndexObject({
    rizzHome: options.rizzHome,
    index: indexed.value,
    ...(options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot }),
  });
  if (!stored.ok) return stored;
  const query = options.query?.trim().toLowerCase() ?? '';
  const matches = indexed.value.skills.filter((skill) =>
    [
      skill.name,
      skill.description,
      skill.relative_path,
      skill.source_id,
      skill.source_repository,
      skill.attribution,
      skill.license,
      skill.audit_status,
      ...skill.supported_agents,
      ...skill.audit_findings.map((finding) => finding.code),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query),
  );
  const results = matches.slice(0, limit);
  return {
    ok: true,
    value: {
      index_digest: stored.value.digest,
      index_path: stored.value.path,
      total_indexed: indexed.value.skills.length,
      matched: matches.length,
      returned: results.length,
      truncated: matches.length > results.length,
      results,
    },
  };
}
