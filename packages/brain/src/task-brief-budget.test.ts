import { describe, expect, it } from 'vitest';
import {
  type AssembleTaskBriefParams,
  TASK_BRIEF_MAX_BYTES,
  TASK_BRIEF_MAX_CLAIMS,
  TASK_BRIEF_MAX_EVIDENCE_PER_CLAIM,
  TASK_BRIEF_MAX_FILES_PER_CLAIM,
  TASK_BRIEF_MAX_SUMMARY_BYTES,
  assembleTaskBrief,
} from './task-brief-budget.js';

function params(overrides: Partial<AssembleTaskBriefParams> = {}): AssembleTaskBriefParams {
  return {
    envelope: {
      schema_version: 1,
      project_id: 'project-precision',
      repository_revision: 'a'.repeat(40),
      brain_generated_at: '2026-07-14T00:00:00.000Z',
      task: 'Fix `toHaveProperty` in packages/expect/src/jest-expect.ts',
      agent: 'codex',
      omissions: [],
      stale_evidence_warnings: [],
      evidence_gaps: [],
    },
    claims: [
      {
        claim: {
          entity_id: 'file:packages/expect/src/jest-expect.ts',
          entity_type: 'file',
          summary: 'Matcher implementation',
          evidence_class: 'direct',
          source_files: ['packages/expect/src/jest-expect.ts'],
          evidence_ids: ['evidence:matcher'],
        },
        relevance: {
          admitted: true,
          score: 200,
          reasons: ['exact:jest-expect.ts'],
          confidence: 'direct',
          causal_path: [],
        },
      },
    ],
    compatibleSkills: [],
    ...overrides,
  };
}

function value(result: ReturnType<typeof assembleTaskBrief>) {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function baseCandidate() {
  const candidate = params().claims[0];
  if (candidate === undefined) throw new Error('missing base claim candidate');
  return candidate;
}

describe('serialized Task Brief budgeting', () => {
  it('fits huge inventories into valid JSON under 32 KiB', () => {
    const base = baseCandidate();
    const result = assembleTaskBrief(
      params({
        claims: [
          {
            ...base,
            claim: {
              ...base.claim,
              summary: '🔥'.repeat(2_000),
              source_files: Array.from(
                { length: 20_000 },
                (_, index) => `packages/模块-${index}/source.ts`,
              ),
              evidence_ids: Array.from({ length: 20_000 }, (_, index) => `evidence:${index}`),
            },
          },
        ],
      }),
    );

    const brief = value(result);
    const json = JSON.stringify(brief);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(TASK_BRIEF_MAX_BYTES);
    expect(brief.size_budget.emitted_bytes).toBe(Buffer.byteLength(json));
    expect(brief.claims[0]?.source_files).toHaveLength(TASK_BRIEF_MAX_FILES_PER_CLAIM);
    expect(brief.claims[0]?.evidence_ids).toHaveLength(TASK_BRIEF_MAX_EVIDENCE_PER_CLAIM);
    expect(Buffer.byteLength(brief.claims[0]?.summary ?? '')).toBeLessThanOrEqual(
      TASK_BRIEF_MAX_SUMMARY_BYTES,
    );
    expect(brief.size_budget.truncated_source_files).toBe(19_992);
    expect(brief.size_budget.truncated_evidence_ids).toBe(19_992);
  });

  it('caps claims at twelve and sorts admitted candidates deterministically by relevance', () => {
    const base = baseCandidate();
    const claims = Array.from({ length: 20 }, (_, index) => ({
      ...base,
      claim: {
        ...base.claim,
        entity_id: `file:${String(index).padStart(2, '0')}.ts`,
      },
      relevance: {
        ...base.relevance,
        score: index === 19 ? 1_000 : 100,
        reasons: index === 19 ? ['exact:target.ts'] : ['term:matcher'],
      },
    }));

    const brief = value(assembleTaskBrief(params({ claims })));

    expect(brief.size_budget.max_claims).toBe(TASK_BRIEF_MAX_CLAIMS);
    expect(brief.size_budget.included_claims).toBe(TASK_BRIEF_MAX_CLAIMS);
    expect(brief.size_budget.truncated_claims).toBe(8);
    expect(brief.claims[0]?.entity_id).toBe('file:19.ts');
    expect(brief.claims.every((claim) => claim.relevance_reasons.length > 0)).toBe(true);
  });

  it('serializes bounded skill capability pointers without audit detail', () => {
    const brief = value(
      assembleTaskBrief(
        params({
          compatibleSkills: [
            {
              name: 'review-loop',
              source_id: 'approved-source',
              skill_path: 'skills/review-loop',
              source_repository: 'https://example.test/review-loop.git',
              digest: 'b'.repeat(64),
              file_digest: 'c'.repeat(64),
              revision: 'd'.repeat(40),
              license: 'MIT',
              attribution: 'Example',
              agents: ['codex'],
              audit_status: 'approval-required',
              audit_findings: Array.from({ length: 5_000 }, (_, index) => ({
                severity: 'warning' as const,
                code: `FINDING_${index}`,
                path: `scripts/${index}.sh`,
                summary: 'x'.repeat(1_000),
              })),
              requirements: { shell: true, network: false, credentials: false },
            },
          ],
        }),
      ),
    );

    expect(brief.compatible_skills).toEqual([
      {
        name: 'review-loop',
        source_id: 'approved-source',
        skill_path: 'skills/review-loop',
        source_repository: 'https://example.test/review-loop.git',
        digest: 'b'.repeat(64),
        file_digest: 'c'.repeat(64),
        revision: 'd'.repeat(40),
        license: 'MIT',
        attribution: 'Example',
        agents: ['codex'],
        audit_status: 'approval-required',
        requirements: { shell: true, network: false, credentials: false },
      },
    ]);
    expect(Buffer.byteLength(JSON.stringify(brief))).toBeLessThanOrEqual(TASK_BRIEF_MAX_BYTES);
  });

  it('returns a structured failure when the required envelope cannot fit', () => {
    const result = assembleTaskBrief(params({ maxBytes: 32 }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'BRIEF_BYTE_BUDGET_EXCEEDED' }),
    });
  });

  it('allows callers to lower but never raise the approved 32 KiB ceiling', () => {
    const brief = value(assembleTaskBrief(params({ maxBytes: 64 * 1024 })));

    expect(brief.size_budget.max_bytes).toBe(TASK_BRIEF_MAX_BYTES);
    expect(brief.size_budget.emitted_bytes).toBeLessThanOrEqual(TASK_BRIEF_MAX_BYTES);
  });

  it('reports an honest evidence gap when an admitted claim cannot fit', () => {
    const base = baseCandidate();
    const brief = value(
      assembleTaskBrief(
        params({
          maxBytes: 800,
          claims: [
            {
              ...base,
              claim: {
                ...base.claim,
                summary: 'x'.repeat(TASK_BRIEF_MAX_SUMMARY_BYTES),
                source_files: Array.from({ length: 8 }, (_, index) => `src/${index}.ts`),
                evidence_ids: Array.from({ length: 8 }, (_, index) => `evidence:${index}`),
              },
            },
          ],
        }),
      ),
    );

    expect(brief.claims).toEqual([]);
    expect(brief.evidence_gaps).toContain(
      'Strong task evidence was omitted because it did not fit the serialized byte budget.',
    );
    expect(brief.size_budget.truncated_claims).toBe(1);
  });
});
