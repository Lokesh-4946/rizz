import { describe, expect, it } from 'vitest';

import {
  architectureFlowEvidenceSummary,
  componentLocalEvidenceReadiness,
  componentLocalEvidenceRecords,
  flowArchitectureConfidence,
} from './architecture-confidence.js';

const redactedRouteFlow = {
  id: 'flow:app--api--search--route-ts',
  confidence: 'uncertain' as const,
  evidence_ids: ['evidence:file-app--api--search--route-ts'],
  data: {
    kind: 'api',
    confidence: { score: 0.8, reason: 'route, test, and config evidence' },
    entrypoints: [{ type: 'route', evidence: ['evidence:file-app--api--search--route-ts'] }],
    components: ['component:app--api--search'],
    services: ['service:packages--search'],
    tests: ['app/api/search/route.test.ts'],
    configs: ['next.config.ts'],
  },
};

describe('architecture confidence calibration', () => {
  it('verifies locally evidenced architecture flows without changing redaction confidence', () => {
    expect(redactedRouteFlow.confidence).toBe('uncertain');
    expect(flowArchitectureConfidence(redactedRouteFlow)).toBe('verified');
  });

  it('keeps script-root flows uncertain when they lack local evidence', () => {
    expect(
      flowArchitectureConfidence({
        id: 'flow:scripts--release',
        confidence: 'uncertain',
        evidence_ids: ['evidence:file-package-json'],
        data: {
          kind: 'script',
          confidence: { score: 0.35, reason: 'script-only evidence' },
          entrypoints: [{ type: 'script', evidence: ['evidence:file-package-json'] }],
          services: ['service:scripts'],
        },
      }),
    ).toBe('uncertain');
  });

  it('does not architecture-verify package scripts from generic test evidence alone', () => {
    expect(
      flowArchitectureConfidence({
        id: 'flow:packages--cli--start',
        confidence: 'verified',
        evidence_ids: ['evidence:file-package-json'],
        data: {
          kind: 'script',
          confidence: { score: 0.82, reason: 'script and test evidence' },
          entrypoints: [{ type: 'script', evidence: ['evidence:file-package-json'] }],
          components: ['component:packages--cli', 'component:packages--core'],
          tests: ['packages/cli/start.test.ts'],
        },
      }),
    ).toBe('inferred');
  });

  it('separates script static evidence from missing local evidence debt', () => {
    const manifestOnlyScript = {
      id: 'flow:scripts--release',
      confidence: 'uncertain' as const,
      evidence_ids: ['evidence:file-package-json'],
      data: {
        kind: 'script',
        confidence: { score: 0.35, reason: 'script-only evidence' },
        signals: ['package script'],
        entrypoints: [{ type: 'script', evidence: ['evidence:file-package-json'] }],
      },
    };
    const commandTargetScript = {
      id: 'flow:scripts--docs',
      confidence: 'inferred' as const,
      evidence_ids: ['evidence:file-package-json'],
      data: {
        kind: 'script',
        confidence: { score: 0.7, reason: 'manifest-backed command target' },
        signals: ['command target', 'package script'],
        entrypoints: [{ type: 'command', evidence: ['evidence:file-package-json'] }],
        components: ['component:scripts'],
        steps: [
          {
            type: 'handler',
            path: 'scripts/docs.js',
            evidence: ['evidence:file-package-json'],
          },
        ],
      },
    };

    const summary = architectureFlowEvidenceSummary([manifestOnlyScript, commandTargetScript]);

    expect(summary.weakFlows.map((flow) => flow.id)).toEqual([
      'flow:scripts--release',
      'flow:scripts--docs',
    ]);
    expect(summary.localEvidenceDebtFlows.map((flow) => flow.id)).toEqual([
      'flow:scripts--release',
    ]);
    expect(summary.staticRuntimeDebtFlows.map((flow) => flow.id)).toEqual(['flow:scripts--docs']);
    expect(summary.scriptStaticEvidenceFlows.map((flow) => flow.id)).toEqual([
      'flow:scripts--docs',
    ]);
    expect(flowArchitectureConfidence(commandTargetScript)).toBe('inferred');
  });

  it('summarizes component-local route and service evidence', () => {
    const records = componentLocalEvidenceRecords({
      components: [
        {
          id: 'component:app--api--search',
          confidence: 'verified',
          evidence_ids: ['evidence:file-app--api--search--route-ts'],
          data: {
            tests: ['app/api/search/route.test.ts'],
            configs: ['next.config.ts'],
            field_evidence: { tests: ['evidence:file-app--api--search--route-test-ts'] },
          },
        },
      ],
      flows: [redactedRouteFlow],
      services: [
        {
          id: 'service:packages--search',
          confidence: 'verified',
          evidence_ids: ['evidence:file-packages--search--index-ts'],
          data: { related_components: ['component:app--api--search'] },
        },
      ],
    });

    expect(records).toEqual([
      expect.objectContaining({
        component_id: 'component:app--api--search',
        route_flow_count: 1,
        service_count: 1,
        service_flow_count: 1,
        local_tests: ['app/api/search/route.test.ts'],
        local_configs: ['next.config.ts'],
        confidence: 'verified',
      }),
    ]);
    expect(records[0]?.evidence_ids).toContain('evidence:file-app--api--search--route-test-ts');
    expect(componentLocalEvidenceReadiness(records)).toBe(100);
  });
});
