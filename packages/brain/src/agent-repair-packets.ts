type AgentRepairPacketSeverity = 'high' | 'medium' | 'low';

type AgentRepairPacketSource =
  | 'architecture'
  | 'evidence_quality'
  | 'incremental'
  | 'review_blast_radius'
  | 'security'
  | 'tools'
  | 'verification';

type AgentRepairPacketConfidence = 'verified' | 'inferred' | 'uncertain';

interface AgentRepairPacket {
  readonly priority: number;
  readonly packet_id: string;
  readonly source: AgentRepairPacketSource;
  readonly severity: AgentRepairPacketSeverity;
  readonly target_type: string;
  readonly target_id: string;
  readonly intent: string;
  readonly read_first_files: readonly string[];
  readonly inspect_actions: readonly string[];
  readonly repair_actions: readonly string[];
  readonly verification_actions: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly evidence_gap_ids: readonly string[];
  readonly artifacts: readonly string[];
  readonly agent_prompt: string;
  readonly stop_conditions: readonly string[];
  readonly confidence: AgentRepairPacketConfidence;
}

export interface AgentRepairPacketsArtifact {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly deterministic: boolean;
  readonly provider_calls_required: boolean;
  readonly network_required: boolean;
  readonly packet_count: number;
  readonly high_priority_count: number;
  readonly sources: Record<AgentRepairPacketSource, number>;
  readonly packets: readonly AgentRepairPacket[];
  readonly summary: string;
  readonly calibration_rule: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordArray(value: unknown, key: string): Readonly<Record<string, unknown>>[] {
  if (!isRecord(value)) return [];
  const item = value[key];
  return Array.isArray(item) ? item.filter(isRecord) : [];
}

function recordString(value: unknown, key: string, fallback = ''): string {
  if (!isRecord(value)) return fallback;
  const item = value[key];
  return typeof item === 'string' ? item : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function recordStringArray(value: unknown, key: string): string[] {
  if (!isRecord(value)) return [];
  return stringArray(value[key]);
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.filter((item) => item !== ''))].sort((a, b) => a.localeCompare(b));
}

function slug(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'unknown'
  );
}

function parseSeverity(value: unknown): AgentRepairPacketSeverity {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  if (value === 'critical') return 'high';
  return 'medium';
}

function parseConfidence(value: unknown): AgentRepairPacketConfidence {
  if (value === 'verified' || value === 'inferred' || value === 'uncertain') return value;
  return 'uncertain';
}

function severityRank(value: AgentRepairPacketSeverity): number {
  if (value === 'high') return 0;
  if (value === 'medium') return 1;
  return 2;
}

function sourceRank(value: AgentRepairPacketSource): number {
  if (value === 'review_blast_radius') return 0;
  if (value === 'verification') return 1;
  if (value === 'architecture') return 2;
  if (value === 'evidence_quality') return 3;
  if (value === 'security') return 4;
  if (value === 'tools') return 5;
  return 6;
}

function queueSource(value: string): AgentRepairPacketSource {
  if (value === 'evidence') return 'evidence_quality';
  if (value === 'architecture') return 'architecture';
  if (value === 'incremental') return 'incremental';
  if (value === 'security') return 'security';
  if (value === 'tools') return 'tools';
  return 'evidence_quality';
}

function packetSources(
  packets: readonly AgentRepairPacket[],
): Record<AgentRepairPacketSource, number> {
  return {
    architecture: packets.filter((packet) => packet.source === 'architecture').length,
    evidence_quality: packets.filter((packet) => packet.source === 'evidence_quality').length,
    incremental: packets.filter((packet) => packet.source === 'incremental').length,
    review_blast_radius: packets.filter((packet) => packet.source === 'review_blast_radius').length,
    security: packets.filter((packet) => packet.source === 'security').length,
    tools: packets.filter((packet) => packet.source === 'tools').length,
    verification: packets.filter((packet) => packet.source === 'verification').length,
  };
}

function queuePackets(confidenceInspectionQueue: unknown): AgentRepairPacket[] {
  return recordArray(confidenceInspectionQueue, 'items').map((item) => {
    const source = queueSource(recordString(item, 'source', 'evidence'));
    const targetType = recordString(item, 'target_type', 'inspection_item');
    const targetId = recordString(item, 'target_id', 'unknown target');
    const inspectHint = recordString(
      item,
      'inspect_hint',
      'Inspect the source artifact before editing.',
    );
    const verificationActions = recordStringArray(item, 'verification_actions');
    return {
      priority: 0,
      packet_id: `repair:${source}:${slug(targetType)}:${slug(targetId)}`,
      source,
      severity: parseSeverity(item.severity),
      target_type: targetType,
      target_id: targetId,
      intent: recordString(item, 'reason', 'Inspect-first repair packet needs action.'),
      read_first_files: recordStringArray(item, 'read_first_files').slice(0, 8),
      inspect_actions: unique([
        inspectHint,
        ...recordStringArray(item, 'artifacts').map((path) => `Open ${path}.`),
      ]).slice(0, 6),
      repair_actions: [
        'Make the smallest scoped change that fills the cited evidence or confidence gap.',
        'Do not broaden runtime confidence unless a targeted check actually runs.',
      ],
      verification_actions:
        verificationActions.length > 0
          ? verificationActions.slice(0, 6)
          : ['Rerun rizz brain and confirm this packet no longer appears at the same priority.'],
      evidence_ids: recordStringArray(item, 'evidence_ids').slice(0, 10),
      evidence_gap_ids: recordStringArray(item, 'evidence_gap_ids').slice(0, 10),
      artifacts: unique([
        ...recordStringArray(item, 'artifacts'),
        '.rizz/research/agent_repair_packets.json',
      ]).slice(0, 8),
      agent_prompt: `Inspect ${targetId}, repair only the cited ${targetType} gap, then rerun rizz.`,
      stop_conditions: [
        'Stop if the cited files or evidence no longer exist in the current worktree.',
        'Stop if the repair requires product intent not present in the mission contract.',
      ],
      confidence: parseConfidence(item.current_confidence),
    };
  });
}

function findingSeverity(value: unknown): AgentRepairPacketSeverity {
  if (value === 'critical' || value === 'high') return 'high';
  if (value === 'medium') return 'medium';
  return 'low';
}

function reviewFindingPackets(review: unknown): AgentRepairPacket[] {
  return recordArray(review, 'findings')
    .slice(0, 8)
    .map((finding) => {
      const findingId = recordString(finding, 'id', 'unknown finding');
      const title = recordString(finding, 'title', 'Review finding needs repair.');
      const recommendation = recordString(
        finding,
        'recommendation',
        'Repair the finding and rerun review.',
      );
      const affectedFiles = recordStringArray(finding, 'affected_files');
      return {
        priority: 0,
        packet_id: `repair:review:${slug(findingId)}`,
        source: 'review_blast_radius',
        severity: findingSeverity(finding.severity),
        target_type: recordString(finding, 'category', 'review_finding'),
        target_id: findingId,
        intent: `${title}: ${recordString(finding, 'description', recommendation)}`,
        read_first_files: affectedFiles.slice(0, 8),
        inspect_actions: unique([
          'Open .rizz/research/review_claim_evidence.json for claim provenance.',
          'Open .rizz/reports/review.html for reviewer context.',
          ...affectedFiles.slice(0, 4).map((file) => `Inspect ${file}.`),
        ]),
        repair_actions: [recommendation],
        verification_actions: [
          'Run the targeted tests listed in the review verification plan when applicable.',
          'Rerun rizz review --json and confirm the finding is resolved or intentionally deferred.',
        ],
        evidence_ids: recordStringArray(finding, 'evidence_ids').slice(0, 10),
        evidence_gap_ids: [],
        artifacts: [
          '.rizz/research/review_eval.json',
          '.rizz/research/review_claim_evidence.json',
          '.rizz/reports/review.html',
        ],
        agent_prompt: `Repair review finding ${findingId}: ${recommendation}`,
        stop_conditions: [
          'Stop if the finding points at files outside the approved mission scope.',
          'Stop if the review finding requires a human product decision.',
        ],
        confidence: parseConfidence(finding.confidence),
      };
    });
}

function verificationPlanPackets(review: unknown): AgentRepairPacket[] {
  return recordArray(review, 'verification_plan')
    .slice(0, 8)
    .map((item) => {
      const planId = recordString(item, 'id', 'unknown verification');
      const commands = recordStringArray(item, 'commands');
      const manualChecks = recordStringArray(item, 'manual_checks');
      return {
        priority: 0,
        packet_id: `repair:verification:${slug(planId)}`,
        source: 'verification',
        severity: recordString(item, 'priority') === 'required' ? 'high' : 'medium',
        target_type: `verification:${recordString(item, 'verification_type', 'manual')}`,
        target_id: planId,
        intent: recordString(item, 'reason', 'Targeted verification is needed before approval.'),
        read_first_files: recordStringArray(item, 'linked_files').slice(0, 8),
        inspect_actions: [
          'Open .rizz/research/review_eval.json and inspect the verification_plan entry.',
          ...manualChecks.slice(0, 4),
        ],
        repair_actions:
          commands.length > 0
            ? commands.map((command) => `Prepare to run: ${command}`)
            : ['Perform the manual verification check and record the result.'],
        verification_actions: [
          ...commands.map((command) => `Run ${command}.`),
          'Record the result with rizz verification evidence before claiming runtime confidence.',
        ].slice(0, 6),
        evidence_ids: recordStringArray(item, 'evidence_ids').slice(0, 10),
        evidence_gap_ids: [],
        artifacts: ['.rizz/research/review_eval.json', '.rizz/research/verification_evidence.json'],
        agent_prompt: `Complete verification ${planId} and attach evidence before approval.`,
        stop_conditions: [
          'Stop if the command is destructive, networked, or outside the mission approval boundary.',
          'Stop if verification fails; hand the failure back as repair context.',
        ],
        confidence: parseConfidence(item.confidence),
      };
    });
}

function packetKey(packet: AgentRepairPacket): string {
  return `${packet.source}\u0000${packet.target_type}\u0000${packet.target_id}`;
}

function comparePackets(a: AgentRepairPacket, b: AgentRepairPacket): number {
  return (
    severityRank(a.severity) - severityRank(b.severity) ||
    sourceRank(a.source) - sourceRank(b.source) ||
    a.target_id.localeCompare(b.target_id)
  );
}

function uniquePackets(packets: readonly AgentRepairPacket[]): AgentRepairPacket[] {
  const seen = new Set<string>();
  const out: AgentRepairPacket[] = [];
  for (const packet of packets) {
    const key = packetKey(packet);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(packet);
  }
  return out;
}

export function buildAgentRepairPacketsArtifact(params: {
  readonly generatedAt: string;
  readonly confidenceInspectionQueue: unknown;
  readonly review?: unknown;
}): AgentRepairPacketsArtifact {
  const packets = uniquePackets([
    ...reviewFindingPackets(params.review),
    ...verificationPlanPackets(params.review),
    ...queuePackets(params.confidenceInspectionQueue),
  ])
    .sort(comparePackets)
    .slice(0, 16)
    .map((packet, index) => ({ ...packet, priority: index + 1 }));
  const highPriorityCount = packets.filter((packet) => packet.severity === 'high').length;
  return {
    schema_version: 1,
    generated_at: params.generatedAt,
    deterministic: true,
    provider_calls_required: false,
    network_required: false,
    packet_count: packets.length,
    high_priority_count: highPriorityCount,
    sources: packetSources(packets),
    packets,
    summary:
      packets.length === 0
        ? 'No agent repair packets were generated.'
        : `${packets.length} unified agent repair packet(s), including ${highPriorityCount} high-priority packet(s), are ready for inspect-first repair.`,
    calibration_rule:
      'Agent repair packets unify architecture correction, evidence quality, review blast radius, and verification guidance; packets are deterministic guidance and do not claim repairs or runtime verification were performed.',
  };
}
