import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleTaskBrief } from './task-brief-budget.js';
import {
  type RelevanceCandidate,
  decideTaskRelevance,
  extractTaskAnchors,
} from './task-relevance.js';

interface PrecisionFixture {
  readonly name: string;
  readonly task: string;
  readonly expected_admitted_ids: readonly string[];
  readonly large_inventory_count: number;
  readonly candidates: readonly RelevanceCandidate[];
}

async function fixture(name: string): Promise<PrecisionFixture> {
  return JSON.parse(
    await readFile(join(process.cwd(), 'eval', 'fixtures', 'precision', `${name}.json`), 'utf8'),
  ) as PrecisionFixture;
}

function noisyCandidates(count: number): RelevanceCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `unrelated:inventory:${index}`,
    type: 'flow',
    name: `Unrelated inventory flow ${index}`,
    description: `Translated documentation and unrelated package inventory ${index}`,
    sourceFiles: [`docs/translations/${index}/guide.md`],
    evidenceIds: [`evidence:unrelated:${index}`],
    confidence: 'direct',
  }));
}

describe.each(['fastapi-known-task', 'vitest-known-task'])(
  '%s Milestone-A precision fixture',
  (name) => {
    it('keeps admitted evidence invariant and emits a whole brief under 32 KiB', async () => {
      const input = await fixture(name);
      const anchors = extractTaskAnchors(input.task);
      const oversizedTarget = input.candidates[0];
      if (oversizedTarget === undefined) throw new Error('Fixture needs a target candidate.');
      const sourceFiles = [
        ...oversizedTarget.sourceFiles,
        ...Array.from(
          { length: input.large_inventory_count },
          (_, index) => `inventory/generated/${index}/source.ts`,
        ),
      ];
      const baseCandidates: RelevanceCandidate[] = [
        { ...oversizedTarget, sourceFiles },
        ...input.candidates.slice(1),
      ];
      const decisions = (candidates: readonly RelevanceCandidate[]) =>
        candidates.map((candidate) => ({
          candidate,
          relevance: decideTaskRelevance({ anchors, candidate }),
        }));
      const base = decisions(baseCandidates);
      const noisy = decisions([...baseCandidates, ...noisyCandidates(input.large_inventory_count)]);
      const admittedIds = (items: ReturnType<typeof decisions>) =>
        items
          .filter((item) => item.relevance.admitted)
          .map((item) => item.candidate.id)
          .sort();

      expect(admittedIds(base)).toEqual([...input.expected_admitted_ids].sort());
      expect(admittedIds(noisy)).toEqual(admittedIds(base));

      const brief = assembleTaskBrief({
        envelope: {
          schema_version: 1,
          project_id: `fixture:${input.name}`,
          repository_revision: 'a'.repeat(40),
          brain_generated_at: '2026-07-14T00:00:00.000Z',
          task: input.task,
          agent: 'codex',
          omissions: [`${input.large_inventory_count} uncited inventory entries omitted`],
          stale_evidence_warnings: [],
          evidence_gaps: [],
        },
        claims: noisy.map(({ candidate, relevance }) => ({
          claim: {
            entity_id: candidate.id,
            entity_type: candidate.type,
            summary: candidate.description,
            evidence_class: 'direct',
            source_files: candidate.sourceFiles,
            evidence_ids: candidate.evidenceIds,
          },
          relevance,
        })),
        compatibleSkills: [],
      });
      expect(brief.ok).toBe(true);
      if (!brief.ok) return;
      const serialized = JSON.stringify(brief.value);
      expect(() => JSON.parse(serialized)).not.toThrow();
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(32 * 1024);
      expect(brief.value.size_budget.emitted_bytes).toBe(Buffer.byteLength(serialized));
      expect(brief.value.size_budget.truncated_source_files).toBeGreaterThan(0);
    });
  },
);
