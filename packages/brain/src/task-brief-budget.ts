import type { TaskBrief, TaskBriefClaim } from './context-loop.js';
import type { RelevanceDecision } from './task-relevance.js';

export const TASK_BRIEF_MAX_BYTES = 32 * 1024;
export const TASK_BRIEF_MAX_CLAIMS = 12;
export const TASK_BRIEF_MAX_FILES_PER_CLAIM = 8;
export const TASK_BRIEF_MAX_EVIDENCE_PER_CLAIM = 8;
export const TASK_BRIEF_MAX_SUMMARY_BYTES = 1_024;

type TaskBriefEnvelope = Omit<TaskBrief, 'claims' | 'compatible_skills' | 'size_budget'>;
type CompatibleSkill = TaskBrief['compatible_skills'][number];
type TaskBriefClaimInput = Omit<
  TaskBriefClaim,
  'relevance_score' | 'relevance_reasons' | 'relevance_confidence' | 'causal_path'
>;

export interface TaskBriefClaimCandidate {
  readonly claim: TaskBriefClaimInput;
  readonly relevance: RelevanceDecision;
}

export interface AssembleTaskBriefParams {
  readonly envelope: TaskBriefEnvelope;
  readonly claims: readonly TaskBriefClaimCandidate[];
  readonly compatibleSkills: readonly CompatibleSkill[];
  readonly maxBytes?: number;
  readonly maxClaims?: number;
}

export interface BudgetedTaskBriefClaim extends TaskBriefClaim {
  readonly relevance_score: number;
  readonly relevance_reasons: readonly string[];
  readonly relevance_confidence: RelevanceDecision['confidence'];
  readonly causal_path: readonly string[];
}

export interface TaskBriefSkillPointer {
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
  readonly audit_status: CompatibleSkill['audit_status'];
  readonly audit_findings?: readonly [];
  readonly requirements: CompatibleSkill['requirements'];
}

export interface TaskBriefSizeBudget {
  readonly max_claims: number;
  readonly included_claims: number;
  readonly max_bytes: number;
  readonly emitted_bytes: number;
  readonly truncated_claims: number;
  readonly truncated_source_files: number;
  readonly truncated_evidence_ids: number;
  readonly truncated_skills: number;
}

export interface BudgetedTaskBrief extends TaskBriefEnvelope {
  readonly claims: readonly BudgetedTaskBriefClaim[];
  readonly compatible_skills: readonly TaskBriefSkillPointer[];
  readonly size_budget: TaskBriefSizeBudget;
}

export type AssembleTaskBriefResult =
  | { readonly ok: true; readonly value: BudgetedTaskBrief }
  | {
      readonly ok: false;
      readonly error: { readonly code: 'BRIEF_BYTE_BUDGET_EXCEEDED'; readonly message: string };
    };

function utf8Prefix(value: string, maxBytes: number): string {
  let emittedBytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (emittedBytes + characterBytes > maxBytes) break;
    result += character;
    emittedBytes += characterBytes;
  }
  return result;
}

function boundedClaim(candidate: TaskBriefClaimCandidate): BudgetedTaskBriefClaim {
  return {
    ...candidate.claim,
    summary: utf8Prefix(candidate.claim.summary, TASK_BRIEF_MAX_SUMMARY_BYTES),
    source_files: candidate.claim.source_files.slice(0, TASK_BRIEF_MAX_FILES_PER_CLAIM),
    evidence_ids: candidate.claim.evidence_ids.slice(0, TASK_BRIEF_MAX_EVIDENCE_PER_CLAIM),
    relevance_score: candidate.relevance.score,
    relevance_reasons: [...candidate.relevance.reasons],
    relevance_confidence: candidate.relevance.confidence,
    causal_path: [...candidate.relevance.causal_path],
  };
}

function skillPointer(skill: CompatibleSkill): TaskBriefSkillPointer {
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
    agents: [...skill.agents],
    audit_status: skill.audit_status,
    ...(skill.audit_status === 'clean' ? { audit_findings: [] as const } : {}),
    requirements: skill.requirements,
  };
}

function compareCandidates(left: TaskBriefClaimCandidate, right: TaskBriefClaimCandidate): number {
  return (
    right.relevance.score - left.relevance.score ||
    left.relevance.reasons.join('\u0000').localeCompare(right.relevance.reasons.join('\u0000')) ||
    left.claim.entity_id.localeCompare(right.claim.entity_id)
  );
}

function fixedPointBytes(brief: BudgetedTaskBrief): BudgetedTaskBrief {
  let emittedBytes = brief.size_budget.emitted_bytes;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const candidate = {
      ...brief,
      size_budget: { ...brief.size_budget, emitted_bytes: emittedBytes },
    };
    const measuredBytes = Buffer.byteLength(JSON.stringify(candidate));
    if (measuredBytes === emittedBytes) return candidate;
    emittedBytes = measuredBytes;
  }
  return {
    ...brief,
    size_budget: { ...brief.size_budget, emitted_bytes: emittedBytes },
  };
}

function buildBrief(params: {
  readonly envelope: TaskBriefEnvelope;
  readonly claims: readonly BudgetedTaskBriefClaim[];
  readonly skills: readonly TaskBriefSkillPointer[];
  readonly maxBytes: number;
  readonly maxClaims: number;
  readonly inputClaims: readonly TaskBriefClaimCandidate[];
  readonly inputSkills: number;
}): BudgetedTaskBrief {
  const inputSourceFiles = params.inputClaims.reduce(
    (total, candidate) => total + candidate.claim.source_files.length,
    0,
  );
  const inputEvidenceIds = params.inputClaims.reduce(
    (total, candidate) => total + candidate.claim.evidence_ids.length,
    0,
  );
  const includedSourceFiles = params.claims.reduce(
    (total, claim) => total + claim.source_files.length,
    0,
  );
  const includedEvidenceIds = params.claims.reduce(
    (total, claim) => total + claim.evidence_ids.length,
    0,
  );
  return fixedPointBytes({
    ...params.envelope,
    claims: params.claims,
    compatible_skills: params.skills,
    size_budget: {
      max_claims: params.maxClaims,
      included_claims: params.claims.length,
      max_bytes: params.maxBytes,
      emitted_bytes: 0,
      truncated_claims: Math.max(0, params.inputClaims.length - params.claims.length),
      truncated_source_files: inputSourceFiles - includedSourceFiles,
      truncated_evidence_ids: inputEvidenceIds - includedEvidenceIds,
      truncated_skills: Math.max(0, params.inputSkills - params.skills.length),
    },
  });
}

function fits(brief: BudgetedTaskBrief, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(brief)) <= maxBytes;
}

export function assembleTaskBrief(params: AssembleTaskBriefParams): AssembleTaskBriefResult {
  const maxBytes = Math.max(
    1,
    Math.min(params.maxBytes ?? TASK_BRIEF_MAX_BYTES, TASK_BRIEF_MAX_BYTES),
  );
  const maxClaims = Math.max(
    1,
    Math.min(params.maxClaims ?? TASK_BRIEF_MAX_CLAIMS, TASK_BRIEF_MAX_CLAIMS),
  );
  const admittedClaims = params.claims.filter((candidate) => candidate.relevance.admitted);
  const candidates = [...admittedClaims].sort(compareCandidates).slice(0, maxClaims);
  const empty = buildBrief({
    envelope: params.envelope,
    claims: [],
    skills: [],
    maxBytes,
    maxClaims,
    inputClaims: admittedClaims,
    inputSkills: params.compatibleSkills.length,
  });
  if (!fits(empty, maxBytes)) {
    return {
      ok: false,
      error: {
        code: 'BRIEF_BYTE_BUDGET_EXCEEDED',
        message: `Required Task Brief envelope exceeds the ${maxBytes}-byte serialized budget.`,
      },
    };
  }

  const claims: BudgetedTaskBriefClaim[] = [];
  for (const candidate of candidates) {
    const bounded = boundedClaim(candidate);
    const candidateClaims = [...claims, bounded];
    const candidateBrief = buildBrief({
      envelope: params.envelope,
      claims: candidateClaims,
      skills: [],
      maxBytes,
      maxClaims,
      inputClaims: admittedClaims,
      inputSkills: params.compatibleSkills.length,
    });
    if (fits(candidateBrief, maxBytes)) claims.push(bounded);
  }

  let envelope = params.envelope;
  if (claims.length === 0 && admittedClaims.length > 0) {
    const evidenceGap =
      'Strong task evidence was omitted because it did not fit the serialized byte budget.';
    envelope = {
      ...envelope,
      evidence_gaps: [...new Set([...envelope.evidence_gaps, evidenceGap])],
    };
  }
  let brief = buildBrief({
    envelope,
    claims,
    skills: [],
    maxBytes,
    maxClaims,
    inputClaims: admittedClaims,
    inputSkills: params.compatibleSkills.length,
  });
  if (!fits(brief, maxBytes)) {
    return {
      ok: false,
      error: {
        code: 'BRIEF_BYTE_BUDGET_EXCEEDED',
        message: `Required Task Brief envelope exceeds the ${maxBytes}-byte serialized budget.`,
      },
    };
  }
  const skills: TaskBriefSkillPointer[] = [];
  for (const skill of [...params.compatibleSkills].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const pointer = skillPointer(skill);
    const candidateSkills = [...skills, pointer];
    const candidateBrief = buildBrief({
      envelope,
      claims,
      skills: candidateSkills,
      maxBytes,
      maxClaims,
      inputClaims: admittedClaims,
      inputSkills: params.compatibleSkills.length,
    });
    if (fits(candidateBrief, maxBytes)) skills.push(pointer);
  }
  brief = buildBrief({
    envelope,
    claims,
    skills,
    maxBytes,
    maxClaims,
    inputClaims: admittedClaims,
    inputSkills: params.compatibleSkills.length,
  });
  return {
    ok: true,
    value: brief,
  };
}
