import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type HumanApprovalState =
  | 'blocked_by_failed_evidence'
  | 'awaiting_agent_repair'
  | 'awaiting_verification_evidence'
  | 'awaiting_human_signoff'
  | 'signed_off';

export interface HumanApprovalPacket {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly review_id: string;
  readonly state: HumanApprovalState;
  readonly agent_evidence_ready: boolean;
  readonly human_signoff_required: boolean;
  readonly human_signoff_recorded: boolean;
  readonly merge_release_ready: boolean;
  readonly signoff_source: string | null;
  readonly signoff_summary: string | null;
  readonly blockers: readonly string[];
  readonly evidence_summary: readonly string[];
  readonly next_actions: readonly string[];
  readonly artifacts: readonly string[];
  readonly calibration_rule: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordString(value: unknown, key: string, fallback = ''): string {
  if (!isRecord(value)) return fallback;
  const item = value[key];
  return typeof item === 'string' ? item : fallback;
}

function recordNumber(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const item = value[key];
  return typeof item === 'number' && Number.isFinite(item) ? item : 0;
}

function recordArray(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value)) return [];
  const item = value[key];
  return Array.isArray(item) ? item : [];
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderList(values: readonly string[]): string {
  if (values.length === 0) return '<p class="muted">None recorded.</p>';
  return `<ul>${values.map((value) => `<li>${htmlEscape(value)}</li>`).join('')}</ul>`;
}

export async function readHumanSignoffRecord(rootDir: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(rootDir, '.rizz', 'human-signoff.json'), 'utf8'),
    );
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function buildHumanApprovalPacket(params: {
  readonly generatedAt: string;
  readonly review: unknown;
  readonly signoffRecord: unknown;
}): HumanApprovalPacket {
  const review = params.review;
  const proof = isRecord(review) ? review.verification_evidence_score : undefined;
  const governance = isRecord(review) ? review.review_governance : undefined;
  const reviewId = recordString(review, 'id', 'unknown-review');
  const recommendedAction = recordString(review, 'recommended_action', 'investigate');
  const findings = isRecord(review) && Array.isArray(review.findings) ? review.findings : [];
  const findingCount = findings.length;
  const proofState = recordString(proof, 'approval_state', 'needs_verification_plan');
  const proofScore = recordNumber(proof, 'score');
  const failedCount = recordNumber(proof, 'failed_count');
  const missingRequired = recordNumber(proof, 'missing_required_count');
  const governanceStatus = recordString(governance, 'status', 'unknown');
  const signoffStatus = recordString(params.signoffRecord, 'status').toLowerCase();
  const signoffRecorded = signoffStatus === 'signed_off' || signoffStatus === 'approved';
  const agentEvidenceReady =
    recommendedAction === 'approve' &&
    proofState === 'ready_for_human_approval' &&
    failedCount === 0 &&
    missingRequired === 0 &&
    governanceStatus !== 'needs_attention';
  const blockers = unique([
    failedCount > 0 ? `${failedCount} failed verification evidence item(s).` : '',
    missingRequired > 0 ? `${missingRequired} required verification item(s) lack proof.` : '',
    recommendedAction !== 'approve'
      ? `Review action is ${recommendedAction}; agent repair or investigation remains.`
      : '',
    governanceStatus === 'needs_attention' ? 'Review governance still needs attention.' : '',
  ]);
  const state: HumanApprovalState =
    failedCount > 0
      ? 'blocked_by_failed_evidence'
      : recommendedAction !== 'approve' || governanceStatus === 'needs_attention'
        ? 'awaiting_agent_repair'
        : proofState !== 'ready_for_human_approval' || missingRequired > 0
          ? 'awaiting_verification_evidence'
          : signoffRecorded
            ? 'signed_off'
            : 'awaiting_human_signoff';
  return {
    schema_version: 1,
    generated_at: params.generatedAt,
    review_id: reviewId,
    state,
    agent_evidence_ready: agentEvidenceReady,
    human_signoff_required: true,
    human_signoff_recorded: signoffRecorded,
    merge_release_ready: state === 'signed_off',
    signoff_source: signoffRecorded ? '.rizz/human-signoff.json' : null,
    signoff_summary:
      signoffRecorded && isRecord(params.signoffRecord)
        ? recordString(params.signoffRecord, 'summary', 'Human signed off this review.')
        : null,
    blockers,
    evidence_summary: [
      `Review action: ${recommendedAction}.`,
      `Verification proof: ${proofScore}/100 (${proofState}).`,
      `Governance: ${governanceStatus}.`,
      `${findingCount} review finding(s) recorded.`,
    ],
    next_actions:
      state === 'signed_off'
        ? ['Proceed only within the signed-off mission and release boundary.']
        : state === 'awaiting_human_signoff'
          ? [
              'Human reviews .rizz/reports/review.html, then records signoff in .rizz/human-signoff.json.',
            ]
          : blockers.length > 0
            ? blockers.map((blocker) => `Resolve before human signoff: ${blocker}`)
            : ['Run rizz review and record verification evidence before requesting signoff.'],
    artifacts: [
      '.rizz/reports/review.html',
      '.rizz/research/review_eval.json',
      '.rizz/research/verification_evidence.json',
      '.rizz/research/human_approval.json',
    ],
    calibration_rule:
      'Agent evidence can make a review ready for human signoff, but merge/release approval is true only when human_signoff_recorded is true.',
  };
}

export function renderHumanApprovalPacket(packet: HumanApprovalPacket | undefined): string {
  if (packet === undefined) return '<p class="muted">No human approval packet recorded.</p>';
  return `<div class="grid">
    <article class="card compact"><h3>Human Approval</h3>${renderList([
      `State: ${packet.state}`,
      `Agent evidence ready: ${packet.agent_evidence_ready}`,
      `Human signoff recorded: ${packet.human_signoff_recorded}`,
      `Merge/release ready: ${packet.merge_release_ready}`,
    ])}</article>
    <article class="card compact"><h3>Approval Evidence</h3>${renderList(packet.evidence_summary)}</article>
    <article class="card compact"><h3>Approval Blockers</h3>${renderList(packet.blockers)}</article>
    <article class="card compact"><h3>Approval Next Actions</h3>${renderList(packet.next_actions)}</article>
  </div>`;
}

export function renderLatestVerificationPlan(latest: unknown): string {
  const status = isRecord(latest) ? latest.latest_review_status : undefined;
  if (!isRecord(status)) {
    return '<p class="muted">Agent plan: <code>.rizz/research/verification_plan.json</code>.</p>';
  }
  const humanApproval = isRecord(status.human_approval)
    ? (status.human_approval as unknown as HumanApprovalPacket)
    : undefined;
  const proof = status.verification_evidence_score;
  const proofCard = isRecord(proof)
    ? `<article class="card compact">
      <div class="badge">${recordString(proof, 'status', 'needs_evidence')}</div>
      <h3>Proof Score</h3>
      ${renderList([
        `${recordNumber(proof, 'score')}/100`,
        recordString(proof, 'approval_state', 'needs_agent_repair'),
        `${recordNumber(proof, 'covered_required_count')}/${recordNumber(proof, 'required_count')} required covered`,
        `${recordNumber(proof, 'missing_required_count')} required missing`,
      ])}
    </article>`
    : '';
  const plan = recordArray(status, 'verification_plan').filter(isRecord);
  if (plan.length === 0) {
    return `${renderHumanApprovalPacket(humanApproval)}${proofCard}<p class="muted">No review verification plan recorded.</p>`;
  }
  const required = plan.filter((item) => recordString(item, 'priority') === 'required');
  const recommended = plan.filter((item) => recordString(item, 'priority') === 'recommended');
  const missingSummary = isRecord(proof) ? asStringArray(proof.missing_summary).slice(0, 5) : [];
  const coveredSummary = isRecord(proof) ? asStringArray(proof.covered_summary).slice(0, 5) : [];
  const missing = recordArray(proof, 'missing_items').filter(isRecord).slice(0, 5);
  const topItems = [...required, ...recommended, ...plan].slice(0, 5);
  return `<div class="grid">
    ${renderHumanApprovalPacket(humanApproval)}
    ${proofCard}
    <article class="card compact">
      <div class="badge">${required.length} required</div>
      <h3>Verification Summary</h3>
      ${renderList([
        `${plan.length} targeted check(s)`,
        `${required.length} required`,
        `${recommended.length} recommended`,
      ])}
    </article>
    <article class="card compact">
      <h3>Missing Proof</h3>
      ${renderList(
        missingSummary.length > 0
          ? missingSummary
          : (missing.length > 0 ? missing : topItems).map((item) => {
              const priority = recordString(item, 'priority', 'recommended');
              const type = recordString(item, 'verification_type', 'manual');
              const reason = recordString(item, 'reason', 'Verify affected behavior.');
              return `${priority} ${type}: ${reason}`;
            }),
      )}
    </article>
    <article class="card compact"><h3>Covered Proof</h3>${renderList(coveredSummary)}</article>
  </div>`;
}
