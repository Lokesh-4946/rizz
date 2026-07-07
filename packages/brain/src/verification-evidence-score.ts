type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'unknown';
type VerificationPriority = 'required' | 'recommended' | 'optional';
type Confidence = 'verified' | 'inferred' | 'uncertain';

interface VerificationEvidenceItem {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly status: VerificationStatus;
}

interface VerificationPlanItem {
  readonly id: string;
  readonly priority: VerificationPriority;
  readonly verification_type: string;
  readonly reason: string;
  readonly commands: readonly string[];
  readonly manual_checks: readonly string[];
  readonly linked_files: readonly string[];
}

interface VerificationProofGap {
  readonly id: string;
  readonly priority: VerificationPriority;
  readonly verification_type: string;
  readonly reason: string;
  readonly commands: readonly string[];
  readonly manual_checks: readonly string[];
  readonly linked_files: readonly string[];
  readonly missing_reason: string;
}

interface VerificationProofCoverage {
  readonly plan_id: string;
  readonly evidence_id: string;
  readonly evidence_status: VerificationStatus;
  readonly evidence_name: string;
  readonly command: string;
}

export interface VerificationEvidenceScore {
  readonly score: number;
  readonly status: 'ready' | 'needs_evidence' | 'blocked';
  readonly plan_count: number;
  readonly required_count: number;
  readonly recorded_count: number;
  readonly passed_count: number;
  readonly failed_count: number;
  readonly covered_plan_count: number;
  readonly covered_required_count: number;
  readonly missing_required_count: number;
  readonly missing_recommended_count: number;
  readonly covered_items: readonly VerificationProofCoverage[];
  readonly missing_items: readonly VerificationProofGap[];
  readonly approval_summary: string;
  readonly agent_next_actions: readonly string[];
  readonly confidence: Confidence;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function itemMatchesEvidence(
  item: VerificationPlanItem,
  evidence: VerificationEvidenceItem,
): boolean {
  const evidenceCommand = normalize(evidence.command);
  if (item.commands.some((command) => normalize(command) === evidenceCommand)) return true;
  const evidenceName = normalize(evidence.name);
  return (
    evidenceName.includes(normalize(item.id)) ||
    item.commands.some((command) => evidenceName.includes(normalize(command))) ||
    item.manual_checks.some((check) => evidenceName.includes(normalize(check)))
  );
}

function boundedScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function priorityGap(item: VerificationPlanItem): VerificationProofGap {
  return {
    id: item.id,
    priority: item.priority,
    verification_type: item.verification_type,
    reason: item.reason,
    commands: item.commands.slice(0, 4),
    manual_checks: item.manual_checks.slice(0, 4),
    linked_files: item.linked_files.slice(0, 8),
    missing_reason:
      item.priority === 'required'
        ? 'Required verification has no recorded passing evidence.'
        : 'Recommended verification has no recorded passing evidence.',
  };
}

export function buildVerificationEvidenceScore(params: {
  readonly planItems: readonly VerificationPlanItem[];
  readonly evidenceItems: readonly VerificationEvidenceItem[];
}): VerificationEvidenceScore {
  const failedCount = params.evidenceItems.filter((item) => item.status === 'failed').length;
  const passedCount = params.evidenceItems.filter((item) => item.status === 'passed').length;
  if (params.planItems.length === 0) {
    const status = failedCount > 0 ? 'blocked' : 'needs_evidence';
    return {
      score: failedCount > 0 ? 35 : passedCount > 0 ? 70 : 45,
      status,
      plan_count: 0,
      required_count: 0,
      recorded_count: params.evidenceItems.length,
      passed_count: passedCount,
      failed_count: failedCount,
      covered_plan_count: 0,
      covered_required_count: 0,
      missing_required_count: 0,
      missing_recommended_count: 0,
      covered_items: [],
      missing_items: [],
      approval_summary:
        passedCount > 0
          ? 'Verification evidence is recorded, but no review plan was available to score coverage.'
          : 'No verification plan or recorded evidence is available yet.',
      agent_next_actions: ['Run rizz review to generate a targeted verification plan.'],
      confidence: passedCount > 0 ? 'inferred' : 'uncertain',
    };
  }
  const covered: VerificationProofCoverage[] = [];
  const missing: VerificationProofGap[] = [];
  for (const item of params.planItems) {
    const matched = params.evidenceItems.find(
      (evidence) => evidence.status === 'passed' && itemMatchesEvidence(item, evidence),
    );
    if (matched === undefined) {
      if (item.priority !== 'optional') missing.push(priorityGap(item));
      continue;
    }
    covered.push({
      plan_id: item.id,
      evidence_id: matched.id,
      evidence_status: matched.status,
      evidence_name: matched.name,
      command: matched.command,
    });
  }
  const required = params.planItems.filter((item) => item.priority === 'required');
  const recommended = params.planItems.filter((item) => item.priority === 'recommended');
  const coveredRequired = covered.filter((item) =>
    required.some((plan) => plan.id === item.plan_id),
  );
  const missingRequired = missing.filter((item) => item.priority === 'required');
  const missingRecommended = missing.filter((item) => item.priority === 'recommended');
  const requiredCoverage =
    required.length === 0 ? 1 : coveredRequired.length / Math.max(1, required.length);
  const recommendedCoverage =
    recommended.length === 0
      ? 1
      : covered.filter((item) => recommended.some((plan) => plan.id === item.plan_id)).length /
        Math.max(1, recommended.length);
  const score = boundedScore(
    20 +
      requiredCoverage * 55 +
      recommendedCoverage * 15 +
      Math.min(10, passedCount * 2) -
      Math.min(30, failedCount * 10) -
      Math.min(20, missingRequired.length * 8),
  );
  const status =
    failedCount > 0 || missingRequired.length > 0
      ? 'blocked'
      : missingRecommended.length > 0 || score < 85
        ? 'needs_evidence'
        : 'ready';
  return {
    score,
    status,
    plan_count: params.planItems.length,
    required_count: required.length,
    recorded_count: params.evidenceItems.length,
    passed_count: passedCount,
    failed_count: failedCount,
    covered_plan_count: covered.length,
    covered_required_count: coveredRequired.length,
    missing_required_count: missingRequired.length,
    missing_recommended_count: missingRecommended.length,
    covered_items: covered.slice(0, 12),
    missing_items: missing.slice(0, 12),
    approval_summary:
      status === 'ready'
        ? `Verification proof is ready: ${covered.length}/${params.planItems.length} planned check(s) have passing evidence.`
        : `Verification proof is incomplete: ${missingRequired.length} required and ${missingRecommended.length} recommended check(s) need evidence.`,
    agent_next_actions: missing
      .slice(0, 6)
      .map((item) =>
        item.commands.length === 0
          ? `Perform ${item.verification_type} verification for ${item.id} and record it with rizz verify add.`
          : `Run ${item.commands[0]} and record it with rizz verify add for ${item.id}.`,
      ),
    confidence:
      status === 'ready' ? 'verified' : params.evidenceItems.length > 0 ? 'inferred' : 'uncertain',
  };
}
