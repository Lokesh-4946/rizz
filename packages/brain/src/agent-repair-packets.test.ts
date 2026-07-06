import { describe, expect, it } from 'vitest';

import { buildAgentRepairPacketsArtifact } from './agent-repair-packets.js';

describe('agent repair packets', () => {
  it('folds duplicate component architecture assumptions into the component correction packet', () => {
    const artifact = buildAgentRepairPacketsArtifact({
      generatedAt: '2026-07-06T00:00:00.000Z',
      confidenceInspectionQueue: {
        items: [
          {
            source: 'architecture',
            severity: 'high',
            target_type: 'component_correction_packet',
            target_id: 'component:config',
            reason: 'component:config needs component-local tests/config evidence.',
            current_confidence: 'inferred',
            inspect_hint: 'Read the component correction packet first.',
            verification_actions: [
              'Rerun rizz brain and confirm component_boundary_evidence improves.',
            ],
            read_first_files: ['config/kubernetes/deployment.yaml'],
            evidence_ids: ['evidence:component-config'],
            evidence_gap_ids: ['gap:component-config:local-test'],
            artifacts: ['.rizz/research/architecture_reasoning.json'],
          },
          {
            source: 'architecture',
            severity: 'high',
            target_type: 'architecture_assumption',
            target_id: 'assumption:component:config:boundary',
            reason: 'Boundary assumption lacks direct evidence.',
            current_confidence: 'inferred',
            confidence_delta: 60,
            inspect_hint: 'Inspect the linked evidence gaps before upgrading this assumption.',
            verification_actions: ['Use rizz explain on component:config.'],
            evidence_ids: ['evidence:assumption-config'],
            evidence_gap_ids: ['gap:component-config:boundary'],
            artifacts: ['.rizz/brain/latest.json'],
          },
          {
            source: 'architecture',
            severity: 'medium',
            target_type: 'component',
            target_id: 'component:config',
            reason: 'Component confidence area needs inspection.',
            current_confidence: 'inferred',
            confidence_delta: 35,
            inspect_hint: 'Inspect local config ownership evidence.',
            verification_actions: ['Confirm whether this is static inference.'],
            evidence_ids: ['evidence:area-config'],
            evidence_gap_ids: ['gap:component-config:area'],
            artifacts: ['.rizz/reports/index.html'],
          },
          {
            source: 'architecture',
            severity: 'high',
            target_type: 'architecture_assumption',
            target_id: 'assumption:flow:docs--route:route-architecture',
            reason: 'Route architecture assumption needs inspection.',
            current_confidence: 'uncertain',
            evidence_gap_ids: ['gap:flow-docs-route'],
          },
        ],
      },
    });

    expect(artifact.packets).toHaveLength(2);
    expect(artifact.sources.architecture).toBe(2);
    expect(artifact.summary).toContain('2 unified agent repair packet');
    expect(artifact.calibration_rule).toContain('related_packet_ids');
    expect(artifact.packets).toContainEqual(
      expect.objectContaining({
        priority: 1,
        source: 'architecture',
        target_type: 'component_correction_packet',
        target_id: 'component:config',
        related_packet_ids: [
          'repair:architecture:architecture-assumption:assumption-component-config-boundary',
          'repair:architecture:component:component-config',
        ],
        evidence_ids: [
          'evidence:area-config',
          'evidence:assumption-config',
          'evidence:component-config',
        ],
        evidence_gap_ids: [
          'gap:component-config:area',
          'gap:component-config:boundary',
          'gap:component-config:local-test',
        ],
        artifacts: expect.arrayContaining([
          '.rizz/brain/latest.json',
          '.rizz/reports/index.html',
          '.rizz/research/agent_repair_packets.json',
          '.rizz/research/architecture_reasoning.json',
        ]),
        agent_prompt: expect.stringContaining('related_packet_ids as provenance'),
      }),
    );
    expect(artifact.packets).toContainEqual(
      expect.objectContaining({
        priority: 2,
        target_id: 'assumption:flow:docs--route:route-architecture',
        related_packet_ids: [],
      }),
    );
  });
});
