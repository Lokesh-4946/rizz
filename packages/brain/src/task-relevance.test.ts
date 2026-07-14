import { describe, expect, it } from 'vitest';
import {
  type RelevanceCandidate,
  admitCausalNeighbor,
  decideTaskRelevance,
  extractTaskAnchors,
} from './task-relevance.js';

function candidate(overrides: Partial<RelevanceCandidate> = {}): RelevanceCandidate {
  return {
    id: 'file:packages/expect/src/jest-expect.ts',
    type: 'file',
    name: 'jest-expect.ts',
    description: 'Matcher registration for Vitest expect assertions',
    confidence: 'direct',
    sourceFiles: ['packages/expect/src/jest-expect.ts'],
    evidenceIds: ['evidence:jest-expect'],
    ...overrides,
  };
}

describe('mission-scoped relevance', () => {
  it('extracts exact paths, filenames, and symbols while excluding generic task words', () => {
    const anchors = extractTaskAnchors(
      'Fix `toHaveProperty` null handling in packages/expect/src/jest-expect.ts',
    );

    expect(anchors.exact).toEqual(
      new Set(['tohaveproperty', 'packages/expect/src/jest-expect.ts', 'jest-expect.ts']),
    );
    expect(anchors.terms).toContain('null');
    expect(anchors.terms).not.toContain('fix');
    expect(anchors.terms).not.toContain('handling');
  });

  it('treats a standalone PascalCase symbol as an exact anchor', () => {
    const anchors = extractTaskAnchors('Update Hero');
    const decision = decideTaskRelevance({
      anchors,
      candidate: candidate({
        id: 'file:src/hero.ts',
        name: 'src/hero.ts',
        description: 'Homepage component',
        sourceFiles: ['src/hero.ts'],
      }),
    });

    expect(anchors.exact).toContain('hero');
    expect(decision).toMatchObject({ admitted: true, reasons: ['exact:hero'] });
  });

  it('does not reward unrelated evidence or source inventory volume', () => {
    const anchors = extractTaskAnchors(
      'Fix `toHaveProperty` null handling in packages/expect/src/jest-expect.ts',
    );
    const exact = decideTaskRelevance({ anchors, candidate: candidate() });
    const inflated = decideTaskRelevance({
      anchors,
      candidate: candidate({
        evidenceIds: Array.from({ length: 4_000 }, (_, index) => `evidence:${index}`),
        sourceFiles: [
          'packages/expect/src/jest-expect.ts',
          ...Array.from({ length: 4_000 }, (_, index) => `docs/translations/${index}.md`),
        ],
      }),
    });
    const folder = decideTaskRelevance({
      anchors,
      candidate: candidate({
        id: 'folder:docs',
        type: 'folder',
        name: 'docs',
        description: 'Documentation tests and matcher review guidance',
        sourceFiles: Array.from({ length: 4_000 }, (_, index) => `docs/translations/${index}.md`),
        evidenceIds: Array.from({ length: 4_000 }, (_, index) => `evidence:${index}`),
      }),
    });

    expect(exact.admitted).toBe(true);
    expect(inflated.score).toBe(exact.score);
    expect(inflated.reasons).toEqual(exact.reasons);
    expect(folder.admitted).toBe(false);
    expect(exact.score).toBeGreaterThan(folder.score);
  });

  it('rejects generic-only overlap and admits an explicitly anchored aggregate folder', () => {
    const generic = decideTaskRelevance({
      anchors: extractTaskAnchors('Fix the router path test review'),
      candidate: candidate({
        id: 'folder:docs',
        type: 'folder',
        name: 'docs',
        description: 'Router path test review documentation',
        sourceFiles: ['docs/router.md'],
      }),
    });
    const explicitFolder = decideTaskRelevance({
      anchors: extractTaskAnchors('Update `docs/translations` for the release'),
      candidate: candidate({
        id: 'folder:docs/translations',
        type: 'folder',
        name: 'docs/translations',
        description: 'Translated documentation',
        sourceFiles: Array.from({ length: 100 }, (_, index) => `docs/translations/${index}.md`),
      }),
    });

    expect(generic).toMatchObject({ admitted: false, reasons: ['no-strong-anchor'] });
    expect(explicitFolder.admitted).toBe(true);
    expect(explicitFolder.reasons).toContain('exact:docs/translations');
  });

  it('admits direct changed files and test neighbors ahead of lexical candidates', () => {
    const anchors = extractTaskAnchors('Fix the router path test review');
    const changedFile = {
      ...candidate({ id: 'file:src/router.ts', name: 'router.ts', sourceFiles: ['src/router.ts'] }),
      matchKind: 'changed-file' as const,
    };
    const testNeighbor = {
      ...candidate({
        id: 'test:src/router.test.ts',
        type: 'test',
        name: 'router.test.ts',
        sourceFiles: ['src/router.test.ts'],
      }),
      matchKind: 'test-neighbor' as const,
    };

    const changedDecision = decideTaskRelevance({ anchors, candidate: changedFile });
    const testDecision = decideTaskRelevance({ anchors, candidate: testNeighbor });

    expect(changedDecision).toMatchObject({ admitted: true, reasons: ['direct:changed-file'] });
    expect(testDecision).toMatchObject({ admitted: true, reasons: ['direct:test-neighbor'] });
    expect(changedDecision.score).toBeGreaterThan(testDecision.score);
  });

  it('requires a verified two-edge-or-shorter causal path', () => {
    expect(
      admitCausalNeighbor({
        causalPath: ['file:source', 'flow:consumer', 'test:consumer'],
        edgeConfidence: ['direct', 'verified'],
      }).admitted,
    ).toBe(true);
    expect(
      admitCausalNeighbor({
        causalPath: ['file:source', 'flow:first', 'flow:second', 'test:consumer'],
        edgeConfidence: ['direct', 'verified', 'direct'],
      }),
    ).toMatchObject({
      admitted: false,
      error_code: 'REVIEW_SCOPE_UNEXPLAINED',
      reasons: ['causal-path-exceeds-two-edges'],
    });
    expect(
      admitCausalNeighbor({
        causalPath: ['file:source', 'flow:consumer', 'test:consumer'],
        edgeConfidence: ['direct', 'uncertain'],
      }),
    ).toMatchObject({
      admitted: false,
      error_code: 'REVIEW_SCOPE_UNEXPLAINED',
      reasons: ['causal-path-confidence:uncertain'],
    });
    expect(
      admitCausalNeighbor({
        causalPath: ['file:source', 'folder:inventory'],
        edgeConfidence: ['verified'],
        inventoryOnlyEdges: [0],
      }),
    ).toMatchObject({
      admitted: false,
      error_code: 'REVIEW_SCOPE_UNEXPLAINED',
      reasons: ['causal-path-inventory-only'],
    });
  });
});
