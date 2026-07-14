import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { type EnabledProjectSkill, listVerifiedProjectSkills } from './project-skill-enablement.js';
import { prepareProjectStore } from './project-store.js';
import { redactSensitiveText } from './sensitivity.js';
import { extractTaskAnchors } from './task-relevance.js';

export type MissionAgent = 'codex' | 'claude' | 'copilot';
export type MissionScopeStatus = 'open' | 'proposed' | 'accepted';

export type MissionCitation =
  | { readonly kind: 'path'; readonly value: string }
  | { readonly kind: 'symbol'; readonly value: string; readonly path: string }
  | { readonly kind: 'evidence'; readonly value: string };

export interface ProposedMissionConstraint {
  readonly statement: string;
  readonly source: 'ai';
  readonly citations: readonly MissionCitation[];
}

export interface MissionRisk {
  readonly statement: string;
  readonly provenance: 'explicit' | 'deterministic_signal' | 'ai_inferred';
  readonly status: 'reported' | 'signal' | 'hypothesis';
  readonly citations: readonly MissionCitation[];
}

export interface SelectedSkillPointer {
  readonly name: string;
  readonly source_id?: string;
  readonly skill_path?: string;
  readonly source_repository?: string;
  readonly digest: string;
  readonly file_digest?: string;
  readonly revision: string;
  readonly license?: string;
  readonly attribution?: string;
  readonly audit_status: 'clean' | 'approval-required';
  readonly requirements: {
    readonly shell: boolean;
    readonly network: boolean;
    readonly credentials: boolean;
  };
  readonly selection_reasons: readonly string[];
}

export interface MissionBlocker {
  readonly code: 'MISSION_SKILL_APPROVAL_REQUIRED';
  readonly skill: string;
  readonly reason: string;
}

interface MissionIdentity {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly repository_revision: string;
  readonly task: string;
  readonly agent: MissionAgent;
  readonly execution_mode: 'single-agent';
  readonly scope: readonly string[];
  readonly scope_status: MissionScopeStatus;
  readonly anchors: {
    readonly exact: readonly string[];
    readonly terms: readonly string[];
  };
  readonly selected_skills: readonly SelectedSkillPointer[];
  readonly approved_skill_risks: readonly string[];
  readonly constraints: readonly string[];
  readonly proposed_constraints: readonly ProposedMissionConstraint[];
  readonly stop_conditions: readonly string[];
  readonly required_behavior: readonly string[];
  readonly non_goals: readonly string[];
  readonly proposed_non_goals: readonly ProposedMissionConstraint[];
  readonly risks: readonly MissionRisk[];
  readonly verification_checks: readonly string[];
  readonly uncertainty_notes: readonly string[];
}

export interface MissionPreview extends MissionIdentity {
  readonly mission_id: string;
  readonly approved: false;
  readonly blockers: readonly MissionBlocker[];
}

export interface MissionContract extends MissionIdentity {
  readonly mission_id: string;
  readonly approved: true;
  readonly blockers: readonly [];
}

export type MissionBriefIdentity = Pick<
  MissionPreview,
  'mission_id' | 'agent' | 'repository_revision' | 'selected_skills'
>;

export function missionBriefIdentity(mission: MissionPreview): MissionBriefIdentity {
  return {
    mission_id: mission.mission_id,
    agent: mission.agent,
    repository_revision: mission.repository_revision,
    selected_skills: mission.selected_skills,
  };
}

interface MissionFailure {
  readonly code: string;
  readonly message: string;
}

export type MissionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MissionFailure };

export interface MissionPreviewOptions {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly task: string;
  readonly agent: MissionAgent;
  readonly scope?: readonly string[];
  readonly scopeStatus?: MissionScopeStatus;
  readonly requestedSkills?: readonly string[];
  readonly approvedSkillRisks?: readonly string[];
  readonly constraints?: readonly string[];
  readonly proposedConstraints?: readonly {
    readonly statement: string;
    readonly citations: readonly MissionCitation[];
  }[];
  readonly stopConditions?: readonly string[];
  readonly requiredBehavior?: readonly string[];
  readonly nonGoals?: readonly string[];
  readonly proposedNonGoals?: readonly {
    readonly statement: string;
    readonly citations: readonly MissionCitation[];
  }[];
  readonly risks?: readonly {
    readonly statement: string;
    readonly provenance: MissionRisk['provenance'];
    readonly citations?: readonly MissionCitation[];
  }[];
  readonly verificationChecks?: readonly string[];
  readonly uncertaintyNotes?: readonly string[];
}

function failure(code: string, message: string): MissionResult<never> {
  return { ok: false, error: { code, message } };
}

function gitRevision(rootDir: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null;
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => redactSensitiveText(value.trim())))]
    .filter((value) => value !== '')
    .sort();
}

function normalizedScope(scope: readonly string[] | undefined): MissionResult<readonly string[]> {
  const values: string[] = [];
  for (const item of scope ?? []) {
    const value = item.trim().replaceAll('\\', '/').replace(/^\.\//, '');
    if (
      value === '' ||
      value.includes('\0') ||
      value.startsWith('/') ||
      /^[A-Za-z]:\//.test(value) ||
      value.split('/').some((segment) => segment === '..')
    ) {
      return failure('MISSION_SCOPE_INVALID', `Mission scope path is invalid: ${item}`);
    }
    values.push(value);
  }
  return { ok: true, value: [...new Set(values)].sort() };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function missionId(identity: MissionIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(identity)))
    .digest('hex');
}

function persistedMissionIdentity(contract: MissionContract): MissionIdentity {
  return Object.fromEntries(
    Object.entries(contract).filter(
      ([key]) => key !== 'mission_id' && key !== 'approved' && key !== 'blockers',
    ),
  ) as unknown as MissionIdentity;
}

function skillTerms(skill: EnabledProjectSkill): ReadonlySet<string> {
  return new Set(
    `${skill.name} ${skill.skill_path ?? ''}`
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((term) => term.length >= 3),
  );
}

function hasRisk(skill: Pick<EnabledProjectSkill, 'audit_status' | 'requirements'>): boolean {
  return (
    skill.audit_status === 'approval-required' ||
    skill.requirements.shell ||
    skill.requirements.network ||
    skill.requirements.credentials
  );
}

function riskStatus(provenance: MissionRisk['provenance']): MissionRisk['status'] {
  if (provenance === 'ai_inferred') return 'hypothesis';
  if (provenance === 'deterministic_signal') return 'signal';
  return 'reported';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function knownEvidenceIds(brainDir: string): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  let names: string[];
  try {
    names = (await readdir(join(brainDir, 'entities')))
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return ids;
  }
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(brainDir, 'entities', name), 'utf8'));
      if (!isRecord(parsed) || !Array.isArray(parsed.entities)) continue;
      for (const entity of parsed.entities) {
        if (!isRecord(entity)) continue;
        if (typeof entity.id === 'string') ids.add(entity.id);
        if (!Array.isArray(entity.evidence_ids)) continue;
        for (const id of entity.evidence_ids) if (typeof id === 'string') ids.add(id);
      }
    } catch {
      // Invalid optional brain buckets cannot support a mission citation.
    }
  }
  return ids;
}

function normalizedReferencePath(value: string): string | null {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    normalized === '' ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    return null;
  }
  return normalized;
}

async function validateCitation(params: {
  readonly citation: MissionCitation;
  readonly rootPath: string;
  readonly rootRealPath: string;
  readonly evidenceIds: ReadonlySet<string>;
}): Promise<MissionResult<MissionCitation>> {
  const value = params.citation.value.trim();
  if (value === '') {
    return failure('MISSION_REFERENCE_UNSUPPORTED', 'Mission citations cannot be empty.');
  }
  if (params.citation.kind === 'evidence') {
    return params.evidenceIds.has(value)
      ? { ok: true, value: { kind: 'evidence', value } }
      : failure('MISSION_REFERENCE_UNSUPPORTED', `Unknown mission evidence citation: ${value}`);
  }
  const pathValue =
    params.citation.kind === 'path' ? value : normalizedReferencePath(params.citation.path);
  const normalizedPath = normalizedReferencePath(pathValue ?? '');
  if (normalizedPath === null) {
    return failure('MISSION_REFERENCE_UNSUPPORTED', `Invalid mission path citation: ${pathValue}`);
  }
  let citedRealPath: string;
  try {
    citedRealPath = await realpath(join(params.rootPath, normalizedPath));
  } catch {
    return failure(
      'MISSION_REFERENCE_UNSUPPORTED',
      `Missing mission path citation: ${normalizedPath}`,
    );
  }
  const fromRoot = relative(params.rootRealPath, citedRealPath);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    return failure(
      'MISSION_REFERENCE_UNSUPPORTED',
      `Mission citation escapes the repository: ${normalizedPath}`,
    );
  }
  if (params.citation.kind === 'path') {
    return { ok: true, value: { kind: 'path', value: normalizedPath } };
  }
  const symbol = value;
  try {
    if (!(await readFile(citedRealPath, 'utf8')).includes(symbol)) {
      return failure(
        'MISSION_REFERENCE_UNSUPPORTED',
        `Missing literal mission symbol citation: ${symbol} in ${normalizedPath}`,
      );
    }
  } catch {
    return failure(
      'MISSION_REFERENCE_UNSUPPORTED',
      `Unreadable mission symbol citation: ${symbol} in ${normalizedPath}`,
    );
  }
  return { ok: true, value: { kind: 'symbol', value: symbol, path: normalizedPath } };
}

async function validateCitations(params: {
  readonly citations: readonly MissionCitation[];
  readonly rootPath: string;
  readonly rootRealPath: string;
  readonly evidenceIds: ReadonlySet<string>;
}): Promise<MissionResult<readonly MissionCitation[]>> {
  const citations: MissionCitation[] = [];
  for (const citation of params.citations) {
    const validated = await validateCitation({ ...params, citation });
    if (!validated.ok) return validated;
    citations.push(validated.value);
  }
  return {
    ok: true,
    value: [
      ...new Map(citations.map((citation) => [JSON.stringify(citation), citation])).values(),
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

async function groundedMissionInputs(params: {
  readonly options: MissionPreviewOptions;
  readonly rootPath: string;
  readonly brainDir: string;
}): Promise<
  MissionResult<{
    readonly proposedConstraints: readonly ProposedMissionConstraint[];
    readonly proposedNonGoals: readonly ProposedMissionConstraint[];
    readonly risks: readonly MissionRisk[];
  }>
> {
  const rootRealPath = await realpath(params.rootPath);
  const evidenceIds = await knownEvidenceIds(params.brainDir);
  const validate = (citations: readonly MissionCitation[]) =>
    validateCitations({ citations, rootPath: params.rootPath, rootRealPath, evidenceIds });
  const proposals = async (
    inputs: MissionPreviewOptions['proposedConstraints'],
  ): Promise<MissionResult<readonly ProposedMissionConstraint[]>> => {
    const result: ProposedMissionConstraint[] = [];
    for (const input of inputs ?? []) {
      if (input.citations.length === 0) {
        return failure(
          'MISSION_PROPOSAL_EVIDENCE_REQUIRED',
          'AI-proposed mission constraints and non-goals require repository citations.',
        );
      }
      const citations = await validate(input.citations);
      if (!citations.ok) return citations;
      result.push({
        statement: redactSensitiveText(input.statement.trim()),
        source: 'ai',
        citations: citations.value,
      });
    }
    return {
      ok: true,
      value: result
        .filter((item) => item.statement !== '')
        .sort((left, right) => left.statement.localeCompare(right.statement)),
    };
  };
  const proposedConstraints = await proposals(params.options.proposedConstraints);
  if (!proposedConstraints.ok) return proposedConstraints;
  const proposedNonGoals = await proposals(params.options.proposedNonGoals);
  if (!proposedNonGoals.ok) return proposedNonGoals;
  const risks: MissionRisk[] = [];
  for (const input of params.options.risks ?? []) {
    const suppliedCitations = input.citations ?? [];
    if (input.provenance === 'ai_inferred' && suppliedCitations.length === 0) {
      return failure(
        'MISSION_AI_RISK_EVIDENCE_REQUIRED',
        'AI-inferred mission risks require repository citations.',
      );
    }
    if (input.provenance === 'deterministic_signal' && suppliedCitations.length === 0) {
      return failure(
        'MISSION_SIGNAL_EVIDENCE_REQUIRED',
        'Deterministic mission risk signals require repository citations.',
      );
    }
    const citations = await validate(suppliedCitations);
    if (!citations.ok) return citations;
    risks.push({
      statement: redactSensitiveText(input.statement.trim()),
      provenance: input.provenance,
      status: riskStatus(input.provenance),
      citations: citations.value,
    });
  }
  return {
    ok: true,
    value: {
      proposedConstraints: proposedConstraints.value,
      proposedNonGoals: proposedNonGoals.value,
      risks: risks
        .filter((risk) => risk.statement !== '')
        .sort((left, right) => left.statement.localeCompare(right.statement)),
    },
  };
}

function pointer(skill: EnabledProjectSkill, reasons: readonly string[]): SelectedSkillPointer {
  return {
    name: skill.name,
    ...(skill.source_id === undefined ? {} : { source_id: skill.source_id }),
    ...(skill.skill_path === undefined ? {} : { skill_path: skill.skill_path }),
    ...(skill.source_repository === undefined
      ? {}
      : { source_repository: skill.source_repository }),
    digest: skill.digest,
    ...(skill.file_digest === undefined ? {} : { file_digest: skill.file_digest }),
    revision: skill.revision,
    ...(skill.license === undefined ? {} : { license: skill.license }),
    ...(skill.attribution === undefined ? {} : { attribution: skill.attribution }),
    audit_status: skill.audit_status,
    requirements: skill.requirements,
    selection_reasons: reasons,
  };
}

function selectSkills(params: {
  readonly options: MissionPreviewOptions;
  readonly skills: readonly EnabledProjectSkill[];
  readonly taskTerms: ReadonlySet<string>;
}): MissionResult<readonly SelectedSkillPointer[]> {
  const requested =
    params.options.requestedSkills === undefined
      ? undefined
      : new Set(uniqueSorted(params.options.requestedSkills));
  if (requested !== undefined) {
    const unavailable = [...requested].find(
      (name) => !params.skills.some((skill) => skill.name === name),
    );
    if (unavailable !== undefined) {
      return failure(
        'MISSION_SKILL_UNAVAILABLE',
        `Requested skill is not enabled, compatible, and pinned: ${unavailable}`,
      );
    }
  }
  const selected: SelectedSkillPointer[] = [];
  for (const skill of params.skills) {
    if (requested?.has(skill.name)) {
      selected.push(pointer(skill, ['explicitly-requested']));
      continue;
    }
    if (requested !== undefined || hasRisk(skill)) continue;
    const matchedTerm = [...skillTerms(skill)].find((term) => params.taskTerms.has(term));
    if (matchedTerm !== undefined) selected.push(pointer(skill, [`task-anchor:${matchedTerm}`]));
  }
  return {
    ok: true,
    value: selected.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function previewMission(
  options: MissionPreviewOptions,
): Promise<MissionResult<MissionPreview>> {
  if (!['codex', 'claude', 'copilot'].includes(options.agent)) {
    return failure('MISSION_AGENT_UNSUPPORTED', `Unsupported mission agent: ${options.agent}`);
  }
  const scope = normalizedScope(options.scope);
  if (!scope.ok) return scope;
  const store = await prepareProjectStore(options);
  if (!store.ok) return store;
  const repositoryRevision = gitRevision(store.value.rootPath);
  if (repositoryRevision === null) {
    return failure('MISSION_REVISION_UNAVAILABLE', 'Mission preview requires a Git revision.');
  }
  const verifiedSkills = await listVerifiedProjectSkills({ ...options, agent: options.agent });
  if (!verifiedSkills.ok) return verifiedSkills;
  const grounded = await groundedMissionInputs({
    options,
    rootPath: store.value.rootPath,
    brainDir: store.value.brainDir,
  });
  if (!grounded.ok) return grounded;
  const extracted = extractTaskAnchors(options.task);
  const selected = selectSkills({
    options,
    skills: verifiedSkills.value.skills,
    taskTerms: new Set([...extracted.exact, ...extracted.terms]),
  });
  if (!selected.ok) return selected;
  const approvedSkillRisks = uniqueSorted(options.approvedSkillRisks);
  const blockers: MissionBlocker[] = selected.value
    .filter((skill) => hasRisk(skill) && !approvedSkillRisks.includes(skill.name))
    .map((skill) => ({
      code: 'MISSION_SKILL_APPROVAL_REQUIRED',
      skill: skill.name,
      reason: 'Skill requirements or audit status require explicit mission-level approval.',
    }));
  const scopeStatus = options.scopeStatus ?? (scope.value.length === 0 ? 'open' : 'accepted');
  const identity: MissionIdentity = {
    schema_version: 1,
    project_id: store.value.projectId,
    repository_revision: repositoryRevision,
    task: redactSensitiveText(options.task.trim()),
    agent: options.agent,
    execution_mode: 'single-agent',
    scope: scope.value,
    scope_status: scopeStatus,
    anchors: {
      exact: [...extracted.exact].sort(),
      terms: [...extracted.terms].sort(),
    },
    selected_skills: selected.value,
    approved_skill_risks: approvedSkillRisks,
    constraints: uniqueSorted(options.constraints),
    proposed_constraints: grounded.value.proposedConstraints,
    stop_conditions: uniqueSorted(options.stopConditions),
    required_behavior: uniqueSorted(options.requiredBehavior),
    non_goals: uniqueSorted(options.nonGoals),
    proposed_non_goals: grounded.value.proposedNonGoals,
    risks: grounded.value.risks,
    verification_checks: uniqueSorted(options.verificationChecks),
    uncertainty_notes: uniqueSorted(options.uncertaintyNotes),
  };
  return {
    ok: true,
    value: {
      ...identity,
      mission_id: missionId(identity),
      approved: false,
      blockers,
    },
  };
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

export async function acceptMission(
  options: MissionPreviewOptions & {
    readonly missionId: string;
    readonly approved: boolean;
  },
): Promise<MissionResult<MissionContract>> {
  if (!options.approved) {
    return failure('MISSION_APPROVAL_REQUIRED', 'Mission acceptance requires explicit approval.');
  }
  const preview = await previewMission(options);
  if (!preview.ok) return preview;
  if (preview.value.mission_id !== options.missionId) {
    return failure(
      'MISSION_PREVIEW_STALE',
      'Mission scope, revision, agent, constraints, or selected skill identity changed.',
    );
  }
  if (preview.value.scope_status !== 'accepted') {
    return failure(
      'MISSION_SCOPE_UNRESOLVED',
      'Mission implementation approval requires an explicitly accepted scope.',
    );
  }
  const blocker = preview.value.blockers[0];
  if (blocker !== undefined) return failure(blocker.code, blocker.reason);
  const contract: MissionContract = {
    ...preview.value,
    approved: true,
    blockers: [],
  };
  try {
    const store = await prepareProjectStore(options);
    if (!store.ok) return store;
    const missionsDir = join(store.value.projectDir, 'work', 'missions');
    await mkdir(missionsDir, { recursive: true });
    await writeVerified(join(missionsDir, `${contract.mission_id}.json`), contract);
    await writeVerified(join(store.value.projectDir, 'work', 'mission-current.json'), contract);
    return { ok: true, value: contract };
  } catch (error) {
    return failure('MISSION_STORE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

function isMissionContract(value: unknown): value is MissionContract {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record.schema_version === 1 &&
    typeof record.mission_id === 'string' &&
    typeof record.project_id === 'string' &&
    typeof record.repository_revision === 'string' &&
    typeof record.agent === 'string' &&
    record.approved === true &&
    Array.isArray(record.blockers) &&
    record.blockers.length === 0 &&
    Array.isArray(record.selected_skills)
  );
}

export async function verifyMissionIdentity(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly missionId: string;
}): Promise<MissionResult<MissionContract>> {
  if (!/^[a-f0-9]{64}$/.test(options.missionId)) {
    return failure('MISSION_ID_INVALID', 'Mission ID must be a SHA-256 digest.');
  }
  const store = await prepareProjectStore(options);
  if (!store.ok) return store;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(
        join(store.value.projectDir, 'work', 'missions', `${options.missionId}.json`),
        'utf8',
      ),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return failure('MISSION_NOT_FOUND', 'No accepted mission exists for the requested identity.');
    }
    return failure('MISSION_STORE_FAILED', error instanceof Error ? error.message : String(error));
  }
  if (
    !isMissionContract(parsed) ||
    parsed.mission_id !== options.missionId ||
    missionId(persistedMissionIdentity(parsed)) !== parsed.mission_id
  ) {
    return failure('MISSION_IDENTITY_INVALID', 'Persisted mission contract is malformed.');
  }
  if (gitRevision(store.value.rootPath) !== parsed.repository_revision) {
    return failure(
      'MISSION_PREVIEW_STALE',
      'Repository revision changed after mission acceptance.',
    );
  }
  const verifiedSkills = await listVerifiedProjectSkills({
    ...options,
    agent: parsed.agent,
  });
  if (!verifiedSkills.ok) return verifiedSkills;
  const currentSkills = new Map(verifiedSkills.value.skills.map((skill) => [skill.name, skill]));
  const staleSkill = parsed.selected_skills.find((skill) => {
    const current = currentSkills.get(skill.name);
    return (
      current === undefined ||
      current.digest !== skill.digest ||
      current.revision !== skill.revision ||
      current.file_digest !== skill.file_digest
    );
  });
  if (staleSkill !== undefined) {
    return failure(
      'MISSION_PREVIEW_STALE',
      `Selected skill identity changed after mission acceptance: ${staleSkill.name}`,
    );
  }
  return { ok: true, value: parsed };
}
