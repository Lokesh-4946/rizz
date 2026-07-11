import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHumanApprovalPacket, recordHumanSignoff } from './human-approval.js';

describe('human approval packet', () => {
  it('keeps agent evidence readiness separate from human signoff', () => {
    const fingerprint = 'a'.repeat(64);
    const review = {
      id: 'review:clean',
      recommended_action: 'approve',
      findings: [],
      review_governance: { status: 'clean', review_fingerprint: fingerprint },
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
        signoffRecord: {
          status: 'signed_off',
          summary: 'Human approved release.',
          review_id: 'review:clean',
          review_fingerprint: fingerprint,
          history: [],
        },
      }),
    ).toMatchObject({
      state: 'signed_off',
      agent_evidence_ready: true,
      human_signoff_recorded: true,
      merge_release_ready: true,
      signoff_source: '.rizz/human-signoff.json',
      signoff_summary: 'Human approved release.',
      matching_signoff_review_id: 'review:clean',
      signoff_history_count: 0,
    });

    expect(
      buildHumanApprovalPacket({
        generatedAt: '2026-06-28T10:42:00.000Z',
        review,
        signoffRecord: {
          status: 'signed_off',
          summary: 'Human approved an earlier diff.',
          review_id: 'review:earlier',
          review_fingerprint: 'b'.repeat(64),
          history: [
            {
              status: 'signed_off',
              summary: 'Human approved an earlier diff.',
              approver: 'Lokesh',
              recorded_at: '2026-06-28T10:30:00.000Z',
              review_id: 'review:earlier',
              review_fingerprint: 'b'.repeat(64),
              human_approval_state: 'awaiting_human_signoff',
              source: 'rizz approve signoff',
            },
          ],
        },
      }),
    ).toMatchObject({
      state: 'awaiting_human_signoff',
      human_signoff_recorded: false,
      merge_release_ready: false,
      matching_signoff_review_id: null,
      signoff_history_count: 1,
      next_actions: expect.arrayContaining([
        'Previous signoff history is preserved, but no signoff matches this review fingerprint.',
      ]),
    });
  });

  it('records human signoff with history only after rizz marks review ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rizz-human-signoff-'));
    try {
      await mkdir(join(dir, '.rizz', 'research'), { recursive: true });
      await writeFile(
        join(dir, '.rizz', 'research', 'human_approval.json'),
        JSON.stringify({
          schema_version: 1,
          review_id: 'review:ready',
          review_fingerprint: 'a'.repeat(64),
          state: 'awaiting_human_signoff',
          next_actions: ['Human signs off.'],
        }),
      );

      const first = await recordHumanSignoff({
        rootDir: dir,
        summary: 'Approved after reviewing evidence.',
        approver: 'Lokesh',
        now: new Date('2026-06-28T11:00:00.000Z'),
      });

      expect(first).toMatchObject({
        ok: true,
        value: {
          record: {
            status: 'signed_off',
            summary: 'Approved after reviewing evidence.',
            approver: 'Lokesh',
            review_id: 'review:ready',
            review_fingerprint: 'a'.repeat(64),
            agent_self_approval_allowed: false,
            history: [{ review_id: 'review:ready' }],
          },
          nextActions: expect.arrayContaining([
            'Agents must treat this as a recorded human decision, not self-approval.',
          ]),
        },
      });

      const second = await recordHumanSignoff({
        rootDir: dir,
        summary: 'Approved after final smoke proof.',
        approver: 'Lokesh',
        now: new Date('2026-06-28T11:05:00.000Z'),
      });

      expect(second.ok).toBe(true);
      const written = JSON.parse(
        await readFile(join(dir, '.rizz', 'human-signoff.json'), 'utf8'),
      ) as {
        readonly summary: string;
        readonly history: readonly unknown[];
      };
      expect(written.summary).toBe('Approved after final smoke proof.');
      expect(written.history).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks signoff when agent repair or evidence remains', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rizz-human-signoff-blocked-'));
    try {
      await mkdir(join(dir, '.rizz', 'research'), { recursive: true });
      await writeFile(
        join(dir, '.rizz', 'research', 'human_approval.json'),
        JSON.stringify({
          schema_version: 1,
          review_id: 'review:blocked',
          state: 'awaiting_agent_repair',
        }),
      );

      await expect(
        recordHumanSignoff({
          rootDir: dir,
          summary: 'Approved anyway.',
          approver: 'Lokesh',
          now: new Date('2026-06-28T11:10:00.000Z'),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'SIGNOFF_NOT_READY' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
