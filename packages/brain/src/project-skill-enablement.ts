import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareProjectStore } from './project-store.js';
import {
  type SkillFinding,
  readPinnedSkillRecord,
  verifyPinnedSkillCache,
} from './skill-source-manager.js';

interface ProjectOptions {
  readonly rootDir: string;
  readonly rizzHome?: string;
}

export interface EnabledProjectSkill {
  readonly name: string;
  readonly source_id?: string;
  readonly skill_path?: string;
  readonly source_repository?: string;
  readonly digest: string;
  readonly file_digest?: string;
  readonly revision: string;
  readonly license?: string;
  readonly attribution?: string;
  readonly agents: readonly string[];
  readonly owner: 'rizz';
  readonly enabled_at: string;
  readonly audit_status: 'clean' | 'approval-required';
  readonly audit_findings?: readonly SkillFinding[];
  readonly requirements: {
    readonly shell: boolean;
    readonly network: boolean;
    readonly credentials: boolean;
  };
}

interface EnabledManifest {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly skills: Readonly<Record<string, EnabledProjectSkill>>;
}

type EnableResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

async function readManifest(
  path: string,
  projectId: string,
): Promise<EnableResult<EnabledManifest>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { schema_version?: unknown }).schema_version === 1 &&
      (parsed as { project_id?: unknown }).project_id === projectId &&
      typeof (parsed as { skills?: unknown }).skills === 'object' &&
      (parsed as { skills?: unknown }).skills !== null &&
      !Array.isArray((parsed as { skills?: unknown }).skills)
    ) {
      return { ok: true, value: parsed as EnabledManifest };
    }
    return {
      ok: false,
      error: {
        code: 'SKILL_ENABLEMENT_INVALID',
        message: 'Project skill enablement manifest is invalid or belongs to another project.',
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: true,
        value: { schema_version: 1, project_id: projectId, skills: {} },
      };
    }
    return {
      ok: false,
      error: {
        code: 'SKILL_ENABLEMENT_INVALID',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function writeVerified(path: string, value: unknown): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  if ((await readFile(path, 'utf8')) !== contents) {
    throw new Error(`write verification failed: ${path}`);
  }
}

async function project(options: ProjectOptions) {
  return prepareProjectStore({
    rootDir: options.rootDir,
    ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
  });
}

export async function enablePinnedSkill(
  options: ProjectOptions & {
    readonly name: string;
    readonly agents: readonly string[];
    readonly approved: boolean;
    readonly now?: Date;
  },
): Promise<EnableResult<EnabledProjectSkill & { readonly manifest_path: string }>> {
  if (!options.approved) {
    return {
      ok: false,
      error: {
        code: 'SKILL_ENABLE_APPROVAL_REQUIRED',
        message: 'Project skill enablement requires explicit approval.',
      },
    };
  }
  const prepared = await project(options);
  if (!prepared.ok) return prepared;
  const pinned = await readPinnedSkillRecord({
    rizzHome: options.rizzHome ?? join(prepared.value.projectDir, '..', '..'),
    name: options.name,
  });
  if (!pinned.ok) return pinned;
  const agents = [...new Set(options.agents)].sort();
  if (agents.length === 0) {
    return {
      ok: false,
      error: { code: 'SKILL_AGENT_REQUIRED', message: 'Enablement requires at least one agent.' },
    };
  }
  const unsupported = agents.find(
    (agent) => !pinned.value.supported_agents.some((supported) => supported === agent),
  );
  if (unsupported !== undefined) {
    return {
      ok: false,
      error: {
        code: 'SKILL_AGENT_UNSUPPORTED',
        message: `Pinned skill does not support agent: ${unsupported}`,
      },
    };
  }
  const verified = await verifyPinnedSkillCache({ record: pinned.value });
  if (!verified.ok) return verified;
  const manifestPath = join(prepared.value.projectDir, 'skills', 'enabled.json');
  const manifest = await readManifest(manifestPath, prepared.value.projectId);
  if (!manifest.ok) return manifest;
  const enabled: EnabledProjectSkill = {
    name: options.name,
    ...(pinned.value.source_id === undefined ? {} : { source_id: pinned.value.source_id }),
    ...(pinned.value.skill_path === undefined ? {} : { skill_path: pinned.value.skill_path }),
    source_repository: pinned.value.source_repository,
    digest: pinned.value.digest,
    ...(pinned.value.file_digest === undefined ? {} : { file_digest: pinned.value.file_digest }),
    revision: pinned.value.revision,
    license: pinned.value.license,
    ...(pinned.value.attribution === undefined ? {} : { attribution: pinned.value.attribution }),
    agents,
    owner: 'rizz',
    enabled_at: (options.now ?? new Date()).toISOString(),
    audit_status: pinned.value.audit_status,
    audit_findings: pinned.value.audit_findings ?? [],
    requirements: pinned.value.requirements,
  };
  await writeVerified(manifestPath, {
    ...manifest.value,
    skills: { ...manifest.value.skills, [options.name]: enabled },
  });
  return { ok: true, value: { ...enabled, manifest_path: manifestPath } };
}

export async function listEnabledProjectSkills(
  options: ProjectOptions,
): Promise<
  EnableResult<{ readonly project_id: string; readonly skills: readonly EnabledProjectSkill[] }>
> {
  const prepared = await project(options);
  if (!prepared.ok) return prepared;
  const manifest = await readManifest(
    join(prepared.value.projectDir, 'skills', 'enabled.json'),
    prepared.value.projectId,
  );
  if (!manifest.ok) return manifest;
  return {
    ok: true,
    value: {
      project_id: prepared.value.projectId,
      skills: Object.values(manifest.value.skills).sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    },
  };
}

function sameRequirements(
  left: EnabledProjectSkill['requirements'],
  right: EnabledProjectSkill['requirements'],
): boolean {
  return (
    left.shell === right.shell &&
    left.network === right.network &&
    left.credentials === right.credentials
  );
}

export async function listVerifiedProjectSkills(
  options: ProjectOptions & { readonly agent: string },
): Promise<
  EnableResult<{ readonly project_id: string; readonly skills: readonly EnabledProjectSkill[] }>
> {
  const listed = await listEnabledProjectSkills(options);
  if (!listed.ok) return listed;
  const prepared = await project(options);
  if (!prepared.ok) return prepared;
  const rizzHome = options.rizzHome ?? join(prepared.value.projectDir, '..', '..');
  const verifiedSkills: EnabledProjectSkill[] = [];
  for (const skill of listed.value.skills) {
    if (!skill.agents.includes(options.agent)) continue;
    const pinned = await readPinnedSkillRecord({ rizzHome, name: skill.name });
    if (!pinned.ok) return pinned;
    const verified = await verifyPinnedSkillCache({ record: pinned.value });
    if (!verified.ok) return verified;
    const identityMatches =
      skill.digest === pinned.value.digest &&
      skill.revision === pinned.value.revision &&
      skill.source_repository === pinned.value.source_repository &&
      skill.source_id === pinned.value.source_id &&
      skill.skill_path === pinned.value.skill_path &&
      skill.file_digest === pinned.value.file_digest &&
      skill.audit_status === pinned.value.audit_status &&
      sameRequirements(skill.requirements, pinned.value.requirements);
    if (!identityMatches) {
      return {
        ok: false,
        error: {
          code: 'SKILL_ENABLEMENT_STALE',
          message: `Enabled skill identity no longer matches its immutable pin: ${skill.name}`,
        },
      };
    }
    verifiedSkills.push(skill);
  }
  return {
    ok: true,
    value: { project_id: listed.value.project_id, skills: verifiedSkills },
  };
}

export async function removeEnabledProjectSkill(
  options: ProjectOptions & {
    readonly name: string;
    readonly approved: boolean;
    readonly now?: Date;
  },
): Promise<
  EnableResult<{
    readonly removed: boolean;
    readonly name: string;
    readonly digest: string | null;
    readonly history_path: string;
  }>
> {
  if (!options.approved) {
    return {
      ok: false,
      error: {
        code: 'SKILL_REMOVE_APPROVAL_REQUIRED',
        message: 'Project skill removal requires explicit approval.',
      },
    };
  }
  const prepared = await project(options);
  if (!prepared.ok) return prepared;
  const manifestPath = join(prepared.value.projectDir, 'skills', 'enabled.json');
  const manifest = await readManifest(manifestPath, prepared.value.projectId);
  if (!manifest.ok) return manifest;
  const existing = manifest.value.skills[options.name];
  if (existing === undefined) {
    return {
      ok: true,
      value: { removed: false, name: options.name, digest: null, history_path: '' },
    };
  }
  if ((existing as { owner?: unknown }).owner !== 'rizz') {
    return {
      ok: false,
      error: {
        code: 'SKILL_OWNERSHIP_MISMATCH',
        message: 'Rizz refuses to remove skill state it does not own.',
      },
    };
  }
  const { [options.name]: removed, ...remaining } = manifest.value.skills;
  const now = options.now ?? new Date();
  const historyPath = join(
    prepared.value.projectDir,
    'history',
    `skill-remove-${options.name}-${now.getTime()}.json`,
  );
  await writeVerified(historyPath, {
    schema_version: 1,
    project_id: prepared.value.projectId,
    action: 'remove-intent',
    requested_at: now.toISOString(),
    skill: removed,
  });
  await writeVerified(manifestPath, { ...manifest.value, skills: remaining });
  await writeVerified(historyPath, {
    schema_version: 1,
    project_id: prepared.value.projectId,
    action: 'remove',
    removed_at: now.toISOString(),
    skill: removed,
  });
  return {
    ok: true,
    value: {
      removed: true,
      name: options.name,
      digest: existing.digest,
      history_path: historyPath,
    },
  };
}
