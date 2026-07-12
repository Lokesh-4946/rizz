import {
  enablePinnedSkill,
  listEnabledProjectSkills,
  removeEnabledProjectSkill,
} from './project-skill-enablement.js';
import { prepareProjectStore } from './project-store.js';
import {
  addPinnedSkill,
  inspectPinnedSkillCandidate,
  listPinnedSkillFiles,
  readPinnedSkillRecord,
} from './skill-source-manager.js';

interface LifecycleOptions {
  readonly rootDir: string;
  readonly rizzHome: string;
}

type LifecycleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

async function writeVerified(path: string, value: unknown): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  if ((await readFile(path, 'utf8')) !== contents) {
    throw new Error(`write verification failed: ${path}`);
  }
}

export interface SkillUpdatePreview {
  readonly name: string;
  readonly current_revision: string;
  readonly proposed_revision: string;
  readonly current_digest: string;
  readonly proposed_digest: string;
  readonly audit_status: 'clean' | 'approval-required';
  readonly project_enabled: boolean;
  readonly files: {
    readonly added: readonly string[];
    readonly changed: readonly string[];
    readonly removed: readonly string[];
  };
}

export async function previewSkillUpdate(
  options: LifecycleOptions & { readonly sourceDir: string; readonly revision: string },
): Promise<LifecycleResult<SkillUpdatePreview>> {
  const candidate = await inspectPinnedSkillCandidate(options);
  if (!candidate.ok) return candidate;
  const current = await readPinnedSkillRecord({
    rizzHome: options.rizzHome,
    name: candidate.value.name,
  });
  if (!current.ok) return current;
  const currentFiles = await listPinnedSkillFiles({ record: current.value });
  if (!currentFiles.ok) return currentFiles;
  const currentByPath = new Map(currentFiles.value.map((file) => [file.path, file.digest]));
  const proposedByPath = new Map(candidate.value.files.map((file) => [file.path, file.digest]));
  const added = [...proposedByPath.keys()].filter((path) => !currentByPath.has(path)).sort();
  const removed = [...currentByPath.keys()].filter((path) => !proposedByPath.has(path)).sort();
  const changed = [...proposedByPath.entries()]
    .filter(([path, digest]) => currentByPath.has(path) && currentByPath.get(path) !== digest)
    .map(([path]) => path)
    .sort();
  const enabled = await listEnabledProjectSkills({
    rootDir: options.rootDir,
    rizzHome: options.rizzHome,
  });
  if (!enabled.ok) return enabled;
  return {
    ok: true,
    value: {
      name: candidate.value.name,
      current_revision: current.value.revision,
      proposed_revision: candidate.value.revision,
      current_digest: current.value.digest,
      proposed_digest: candidate.value.digest,
      audit_status: candidate.value.status,
      project_enabled: enabled.value.skills.some((skill) => skill.name === candidate.value.name),
      files: { added, changed, removed },
    },
  };
}

export async function applySkillUpdate(
  options: LifecycleOptions & {
    readonly sourceDir: string;
    readonly revision: string;
    readonly approved: boolean;
    readonly now?: Date;
  },
): Promise<
  LifecycleResult<{
    readonly name: string;
    readonly digest: string;
    readonly previous_digest: string;
    readonly revision: string;
    readonly project_updated: boolean;
    readonly history_path: string;
  }>
> {
  if (!options.approved) {
    return {
      ok: false,
      error: {
        code: 'SKILL_UPDATE_APPROVAL_REQUIRED',
        message: 'Skill update apply requires explicit approval.',
      },
    };
  }
  const preview = await previewSkillUpdate(options);
  if (!preview.ok) return preview;
  const enabled = await listEnabledProjectSkills({
    rootDir: options.rootDir,
    rizzHome: options.rizzHome,
  });
  if (!enabled.ok) return enabled;
  const projectSkill = enabled.value.skills.find((skill) => skill.name === preview.value.name);
  const added = await addPinnedSkill({
    sourceDir: options.sourceDir,
    rizzHome: options.rizzHome,
    revision: options.revision,
    approved: true,
  });
  if (!added.ok) return added;
  if (projectSkill !== undefined) {
    const updated = await enablePinnedSkill({
      rootDir: options.rootDir,
      rizzHome: options.rizzHome,
      name: added.value.name,
      agents: projectSkill.agents,
      approved: true,
    });
    if (!updated.ok) return updated;
  }
  const prepared = await prepareProjectStore(options);
  if (!prepared.ok) return prepared;
  const now = options.now ?? new Date();
  const historyPath = join(
    prepared.value.projectDir,
    'history',
    `skill-update-${added.value.name}-${now.getTime()}.json`,
  );
  await writeVerified(historyPath, {
    schema_version: 1,
    project_id: prepared.value.projectId,
    action: 'update',
    updated_at: now.toISOString(),
    name: added.value.name,
    previous_revision: preview.value.current_revision,
    previous_digest: preview.value.current_digest,
    revision: added.value.source_revision,
    digest: added.value.digest,
    project_updated: projectSkill !== undefined,
  });
  return {
    ok: true,
    value: {
      name: added.value.name,
      digest: added.value.digest,
      previous_digest: preview.value.current_digest,
      revision: added.value.source_revision,
      project_updated: projectSkill !== undefined,
      history_path: historyPath,
    },
  };
}

export async function removeProjectSkill(
  options: LifecycleOptions & {
    readonly name: string;
    readonly approved: boolean;
    readonly now?: Date;
  },
) {
  return removeEnabledProjectSkill(options);
}
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
