import { describe, expect, it } from 'vitest';
import { buildHumanApprovalPacket } from './human-approval.js';

describe('human approval packet', () => {
  it('keeps agent evidence readiness separate from human signoff', () => {
    const review = {
      id: 'review:clean',
      recommended_action: 'approve',
      findings: [],
      review_governance: { status: 'clean' },
      verification_evidence_score: {
        approval_state: 'ready_for_human_approval',
        score: 96,
        failed_count: 0,
        missing_required_count: 0,
      },
    };

    expect(
      buildHumanApprovalPacket({
        generatedAt: '2026-06-28T10:40:00.000Z',
        review,
        signoffRecord: null,
      }),
    ).toMatchObject({
      state: 'awaiting_human_signoff',
      agent_evidence_ready: true,
      human_signoff_recorded: false,
      merge_release_ready: false,
    });

    expect(
      buildHumanApprovalPacket({
        generatedAt: '2026-06-28T10:41:00.000Z',
        review,
        signoffRecord: { status: 'signed_off', summary: 'Human approved release.' },
      }),
    ).toMatchObject({
      state: 'signed_off',
      agent_evidence_ready: true,
      human_signoff_recorded: true,
      merge_release_ready: true,
      signoff_source: '.rizz/human-signoff.json',
      signoff_summary: 'Human approved release.',
    });
  });
});
