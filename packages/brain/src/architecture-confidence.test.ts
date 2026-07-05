import { describe, expect, it } from 'vitest';

import {
  architectureFlowEvidenceSummary,
  componentBoundaryConfidence,
  componentBoundaryEvidenceRecord,
  componentBoundaryUnknowns,
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

  it('calibrates component boundary confidence from direct local evidence', () => {
    const component = {
      id: 'component:packages--cli',
      confidence: 'inferred' as const,
      evidence_ids: ['evidence:file-packages--cli--package.json'],
      data: {
        entry_points: ['packages/cli/src/index.ts'],
        tests: ['packages/cli/src/index.test.ts'],
        configs: ['packages/cli/package.json'],
        read_first: ['packages/cli/package.json', 'packages/cli/src/index.ts'],
        unknowns: [
          'No explicit entrypoint was detected for this component.',
          'No component-local test evidence was detected.',
          'Component understanding is backed by limited static evidence.',
          'Runtime behavior has not been executed.',
        ],
      },
    };

    const record = componentBoundaryEvidenceRecord({
      component,
      flows: [
        {
          id: 'flow:packages--cli--start',
          confidence: 'inferred',
          evidence_ids: ['evidence:file-packages--cli--src--index.ts'],
          data: {
            entrypoints: [
              {
                path: 'packages/cli/src/index.ts',
                component_id: 'component:packages--cli',
                evidence: ['evidence:file-packages--cli--src--index.ts'],
              },
            ],
            tests: ['packages/cli/src/index.test.ts'],
            configs: ['packages/cli/package.json'],
          },
        },
      ],
    });

    expect(record).toMatchObject({
      component_id: 'component:packages--cli',
      direct_entrypoint_count: 1,
      local_test_count: 1,
      local_config_count: 1,
      read_first_count: 2,
      confidence: 'verified',
      calibration_rule: expect.stringContaining('does not claim runtime verification'),
    });
    expect(componentBoundaryConfidence(record)).toBe('verified');
    expect(componentBoundaryUnknowns(component, record)).toEqual([
      'Runtime behavior has not been executed.',
    ]);
  });
});
