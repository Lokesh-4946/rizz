import { describe, expect, it } from 'vitest';
import { buildVerificationEvidenceScore } from './verification-evidence-score.js';

describe('verification evidence scoring', () => {
  it('does not mark empty plan and empty evidence as approval-ready', () => {
    const score = buildVerificationEvidenceScore({ planItems: [], evidenceItems: [] });

    expect(score).toMatchObject({
      status: 'needs_evidence',
      approval_state: 'needs_verification_plan',
      score: 45,
      plan_count: 0,
      recorded_count: 0,
      confidence: 'uncertain',
    });
    expect(score.approval_summary).toContain('No verification plan or recorded evidence');
  });
});
