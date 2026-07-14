import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { MissionBriefIdentity } from './mission-contract.js';
import { listEnabledProjectSkills } from './project-skill-enablement.js';
import { prepareProjectStore } from './project-store.js';
import { redactSensitiveText } from './sensitivity.js';
import type { SkillFinding } from './skill-source-manager.js';
import { type TaskBriefSizeBudget, assembleTaskBrief } from './task-brief-budget.js';
import { decideTaskRelevance, extractTaskAnchors } from './task-relevance.js';

type EvidenceClass = 'verified' | 'direct' | 'derived' | 'ai-hypothesis';
type LoopStatus = 'started' | 'planning' | 'implementing' | 'verifying' | 'reviewing' | 'completed';
export const SUPPORTED_SKILL_AGENTS = ['agents', 'claude', 'codex', 'copilot'] as const;

interface RizzFailure {
  readonly code: string;
  readonly message: string;
}

type RizzResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RizzFailure };

export interface TaskBriefClaim {
  readonly entity_id: string;
  readonly entity_type: string;
  readonly summary: string;
  readonly evidence_class: EvidenceClass;
  readonly source_files: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly relevance_score: number;
  readonly relevance_reasons: readonly string[];
  readonly relevance_confidence: 'verified' | 'direct' | 'inferred' | 'uncertain';
  readonly causal_path: readonly string[];
}

export interface TaskBrief {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly repository_revision: string | null;
  readonly brain_generated_at: string;
  readonly task: string;
  readonly agent: string | null;
  readonly mission?: MissionBriefIdentity;
  readonly claims: readonly TaskBriefClaim[];
  readonly omissions: readonly string[];
  readonly stale_evidence_warnings: readonly string[];
  readonly evidence_gaps: readonly string[];
  readonly compatible_skills: readonly {
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
    readonly audit_status: 'clean' | 'approval-required';
    readonly audit_findings?: readonly SkillFinding[];
    readonly requirements: {
      readonly shell: boolean;
      readonly network: boolean;
      readonly credentials: boolean;
    };
  }[];
  readonly size_budget: TaskBriefSizeBudget;
}

interface LoopCheckpoint {
  readonly sequence: number;
  readonly recorded_at: string;
  readonly summary: string;
  readonly files_inspected: readonly string[];
  readonly files_changed: readonly string[];
  readonly commands: readonly string[];
  readonly verification: readonly string[];
  readonly pr_url: string | null;
  readonly comments: readonly string[];
}

export interface LoopWorkState {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly work_id: string;
  readonly workspace_path: string;
  readonly task: string;
  readonly accepted_scope: readonly string[];
  readonly agent: string;
  readonly base_revision: string | null;
  readonly current_revision: string | null;
  readonly status: LoopStatus;
  readonly sequence: number;
  readonly started_at: string;
  readonly updated_at: string;
  readonly checkpoints: readonly LoopCheckpoint[];
}

interface EntityRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly confidence?: string;
  readonly evidence_ids?: readonly string[];
  readonly source_files?: readonly string[];
}

function error(code: string, message: string): RizzResult<never> {
  return { ok: false, error: { code, message } };
}

function gitRevision(rootDir: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function entityRecord(value: unknown): EntityRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    type: value.type,
    name: value.name,
    description: value.description,
    ...(typeof value.confidence === 'string' ? { confidence: value.confidence } : {}),
    evidence_ids: stringArray(value.evidence_ids),
    source_files: stringArray(value.source_files),
  };
}

async function readEntities(brainDir: string): Promise<EntityRecord[]> {
  const entitiesDir = join(brainDir, 'entities');
  let names: string[];
  try {
    names = (await readdir(entitiesDir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const entities: EntityRecord[] = [];
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(entitiesDir, name), 'utf8'));
      if (!isRecord(parsed) || !Array.isArray(parsed.entities)) continue;
      for (const value of parsed.entities) {
        const entity = entityRecord(value);
        if (entity !== null) entities.push(entity);
      }
    } catch {
      // A malformed optional entity bucket is omitted and surfaced in the packet count.
    }
  }
  return entities;
}

function evidenceClass(entity: EntityRecord): EvidenceClass {
  if (entity.confidence === 'verified' && (entity.evidence_ids?.length ?? 0) > 0) return 'verified';
  if ((entity.evidence_ids?.length ?? 0) > 0 || (entity.source_files?.length ?? 0) > 0)
    return 'direct';
  return 'derived';
}

async function readGeneratedAt(brainDir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(brainDir, 'latest.json'), 'utf8'));
    return isRecord(parsed) && typeof parsed.generated_at === 'string' ? parsed.generated_at : null;
  } catch {
    return null;
  }
}

export async function compileTaskBrief(options: {
  readonly rootDir: string;
  readonly task: string;
  readonly rizzHome?: string;
  readonly maxClaims?: number;
  readonly maxBytes?: number;
  readonly agent?: string;
  readonly mission?: MissionBriefIdentity;
}): Promise<RizzResult<TaskBrief>> {
  if (
    options.agent !== undefined &&
    !SUPPORTED_SKILL_AGENTS.some((supported) => supported === options.agent)
  ) {
    return error(
      'SKILL_AGENT_UNSUPPORTED',
      `Brief agent must be one of: ${SUPPORTED_SKILL_AGENTS.join(', ')}.`,
    );
  }
  const store = await prepareProjectStore(options);
  if (!store.ok) return store;
  const repositoryRevision = gitRevision(store.value.rootPath);
  if (
    options.mission !== undefined &&
    (options.mission.agent !== options.agent ||
      options.mission.repository_revision !== repositoryRevision)
  ) {
    return error(
      'MISSION_BRIEF_MISMATCH',
      'Task Brief mission agent or repository revision does not match the current request.',
    );
  }
  const generatedAt = await readGeneratedAt(store.value.brainDir);
  if (generatedAt === null) {
    return error(
      'BRAIN_PREPARE_REQUIRED',
      'No prepared project intelligence exists. Run rizz prepare.',
    );
  }
  const allEntities = await readEntities(store.value.brainDir);
  const anchors = extractTaskAnchors(options.task);
  const candidates = allEntities.map((entity) => {
    const relevance = decideTaskRelevance({
      anchors,
      candidate: {
        id: entity.id,
        type: entity.type,
        name: entity.name,
        description: entity.description,
        ...(entity.confidence === undefined ? {} : { confidence: entity.confidence }),
        sourceFiles: entity.source_files ?? [],
        evidenceIds: entity.evidence_ids ?? [],
      },
    });
    return {
      claim: {
        entity_id: entity.id,
        entity_type: entity.type,
        summary: entity.description,
        evidence_class: evidenceClass(entity),
        source_files: entity.source_files ?? [],
        evidence_ids: entity.evidence_ids ?? [],
        relevance_score: relevance.score,
        relevance_reasons: relevance.reasons,
        relevance_confidence: relevance.confidence,
        causal_path: relevance.causal_path,
      },
      relevance,
    };
  });
  const admittedCount = candidates.filter((candidate) => candidate.relevance.admitted).length;
  const omitted = Math.max(0, allEntities.length - admittedCount);
  const enabledSkills = await listEnabledProjectSkills(options);
  if (!enabledSkills.ok) return enabledSkills;
  return assembleTaskBrief({
    envelope: {
      schema_version: 1,
      project_id: store.value.projectId,
      repository_revision: repositoryRevision,
      brain_generated_at: generatedAt,
      task: redactSensitiveText(options.task),
      agent: options.agent ?? null,
      ...(options.mission === undefined ? {} : { mission: options.mission }),
      omissions: omitted > 0 ? [`${omitted} lower-ranked or uncited claim(s) omitted`] : [],
      stale_evidence_warnings: [
        'Brain evidence is timestamped but not bound to this exact repository revision.',
      ],
      evidence_gaps:
        admittedCount === 0 ? ['No strong repository evidence matched the task anchors.'] : [],
    },
    claims: candidates,
    compatibleSkills: enabledSkills.value.skills.filter(
      (skill) => options.agent === undefined || skill.agents.includes(options.agent),
    ),
    ...(options.maxClaims === undefined ? {} : { maxClaims: options.maxClaims }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
}

async function writeVerifiedContents(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, path);
  if ((await readFile(path, 'utf8')) !== contents)
    throw new Error(`write verification failed for ${path}`);
}

async function writeVerified(path: string, value: unknown): Promise<void> {
  await writeVerifiedContents(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readState(path: string): Promise<LoopWorkState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed) || parsed.schema_version !== 1) return null;
    if (
      typeof parsed.project_id !== 'string' ||
      typeof parsed.work_id !== 'string' ||
      typeof parsed.workspace_path !== 'string' ||
      typeof parsed.task !== 'string' ||
      typeof parsed.agent !== 'string' ||
      typeof parsed.status !== 'string' ||
      typeof parsed.sequence !== 'number' ||
      !Array.isArray(parsed.accepted_scope) ||
      !Array.isArray(parsed.checkpoints)
    ) {
      return null;
    }
    return parsed as unknown as LoopWorkState;
  } catch {
    return null;
  }
}

async function acquireLoopLock(workspacePath: string): Promise<() => Promise<void>> {
  const lockPath = join(workspacePath, 'state.lock');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockPath);
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (caught: unknown) {
      const isLocked =
        isRecord(caught) &&
        'code' in caught &&
        (caught as { readonly code?: unknown }).code === 'EEXIST';
      if (!isLocked) throw caught;
      await wait(10);
    }
  }
  throw new Error(`timed out acquiring loop state lock: ${lockPath}`);
}

export async function startLoopWork(options: {
  readonly rootDir: string;
  readonly task: string;
  readonly agent: string;
  readonly scope?: readonly string[];
  readonly rizzHome?: string;
}): Promise<RizzResult<LoopWorkState>> {
  const store = await prepareProjectStore(options);
  if (!store.ok) return store;
  const workspacePath = join(store.value.projectDir, 'loop');
  await mkdir(workspacePath, { recursive: true });
  const release = await acquireLoopLock(workspacePath);
  try {
    const statePath = join(workspacePath, 'state.json');
    const current = await readState(statePath);
    if (current !== null && current.status !== 'completed') {
      return error('LOOP_ALREADY_ACTIVE', `Work item ${current.work_id} is already active.`);
    }
    const now = new Date().toISOString();
    const revision = gitRevision(store.value.rootPath);
    const state: LoopWorkState = {
      schema_version: 1,
      project_id: store.value.projectId,
      work_id: randomUUID(),
      workspace_path: workspacePath,
      task: redactSensitiveText(options.task),
      accepted_scope: (options.scope ?? []).map(redactSensitiveText),
      agent: redactSensitiveText(options.agent),
      base_revision: revision,
      current_revision: revision,
      status: 'started',
      sequence: 1,
      started_at: now,
      updated_at: now,
      checkpoints: [],
    };
    await writeVerified(statePath, state);
    return { ok: true, value: state };
  } finally {
    await release();
  }
}

export async function readLoopStatus(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
}): Promise<RizzResult<LoopWorkState>> {
  const store = await prepareProjectStore(options);
  if (!store.ok) return store;
  const state = await readState(join(store.value.projectDir, 'loop', 'state.json'));
  return state === null
    ? error('LOOP_NOT_ACTIVE', 'No active work item exists.')
    : { ok: true, value: state };
}

export async function recordLoopCheckpoint(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly summary: string;
  readonly filesInspected?: readonly string[];
  readonly filesChanged?: readonly string[];
  readonly commands?: readonly string[];
  readonly verification?: readonly string[];
  readonly prUrl?: string;
  readonly comments?: readonly string[];
  readonly status?: Exclude<LoopStatus, 'started'>;
  readonly expectedSequence?: number;
}): Promise<RizzResult<LoopWorkState>> {
  const store = await prepareProjectStore(options);
  if (!store.ok) return store;
  const workspacePath = join(store.value.projectDir, 'loop');
  await mkdir(workspacePath, { recursive: true });
  const release = await acquireLoopLock(workspacePath);
  try {
    const current = await readState(join(workspacePath, 'state.json'));
    if (current === null || current.status === 'completed')
      return error('LOOP_NOT_ACTIVE', 'No active work item exists.');
    if (options.expectedSequence !== undefined && options.expectedSequence !== current.sequence) {
      return error(
        'LOOP_REVISION_MISMATCH',
        `Expected loop sequence ${options.expectedSequence}, found ${current.sequence}.`,
      );
    }
    const sequence = current.sequence + 1;
    const now = new Date().toISOString();
    const checkpoint: LoopCheckpoint = {
      sequence,
      recorded_at: now,
      summary: redactSensitiveText(options.summary),
      files_inspected: (options.filesInspected ?? []).map(redactSensitiveText),
      files_changed: (options.filesChanged ?? []).map(redactSensitiveText),
      commands: (options.commands ?? []).map(redactSensitiveText),
      verification: (options.verification ?? []).map(redactSensitiveText),
      pr_url: options.prUrl === undefined ? null : redactSensitiveText(options.prUrl),
      comments: (options.comments ?? []).map(redactSensitiveText),
    };
    const state: LoopWorkState = {
      ...current,
      project_id: store.value.projectId,
      workspace_path: workspacePath,
      current_revision: gitRevision(options.rootDir),
      status: options.status ?? current.status,
      sequence,
      updated_at: now,
      checkpoints: [...current.checkpoints, checkpoint],
    };
    await writeVerified(join(workspacePath, 'state.json'), state);
    return { ok: true, value: state };
  } finally {
    await release();
  }
}

export async function createLoopHandoff(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly summary: string;
  readonly nextBaton: string;
  readonly expectedSequence?: number;
}): Promise<RizzResult<LoopWorkState & { readonly handoff_path: string }>> {
  const checkpoint = await recordLoopCheckpoint({
    ...options,
    comments: [`Next baton: ${options.nextBaton}`],
    ...(options.expectedSequence === undefined
      ? {}
      : { expectedSequence: options.expectedSequence }),
  });
  if (!checkpoint.ok) return checkpoint;
  const handoffDir = join(checkpoint.value.workspace_path, '..', 'handoffs');
  await mkdir(handoffDir, { recursive: true });
  const handoffPath = join(handoffDir, `${checkpoint.value.work_id}.md`);
  await writeVerifiedContents(
    handoffPath,
    `# Work handoff\n\nProject: ${checkpoint.value.project_id}\nWork: ${checkpoint.value.work_id}\nRevision: ${checkpoint.value.current_revision ?? 'unknown'}\n\n## Summary\n\n${redactSensitiveText(options.summary)}\n\n## Next baton\n\n${redactSensitiveText(options.nextBaton)}\n`,
  );
  return { ok: true, value: { ...checkpoint.value, handoff_path: handoffPath } };
}

export async function completeLoopWork(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly summary: string;
  readonly expectedSequence?: number;
}): Promise<RizzResult<LoopWorkState>> {
  return recordLoopCheckpoint({
    ...options,
    status: 'completed',
    ...(options.expectedSequence === undefined
      ? {}
      : { expectedSequence: options.expectedSequence }),
  });
}
