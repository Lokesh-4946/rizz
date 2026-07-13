import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AgentRepairPacket } from './agent-repair-packets.js';
import { readProjectStore } from './project-store.js';

export const REPAIR_HANDOFF_AGENTS = ['claude', 'codex', 'copilot'] as const;
export type RepairHandoffAgent = (typeof REPAIR_HANDOFF_AGENTS)[number];
const MAX_PACKETS = 8;
const MAX_ARTIFACT_BYTES = 1_048_576;
const MAX_PROMPT_BYTES = 32_768;

interface RepairFailure {
  readonly code: string;
  readonly message: string;
}

type RepairResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RepairFailure };

interface RepairPacketsArtifact {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly deterministic: true;
  readonly provider_calls_required: false;
  readonly network_required: false;
  readonly packet_count: number;
  readonly packets: readonly AgentRepairPacket[];
}

export interface AgentRepairHandoff {
  readonly schema_version: 1;
  readonly handoff_id: string;
  readonly project_id: string;
  readonly repository_revision: string;
  readonly agent: RepairHandoffAgent;
  readonly artifact: '.rizz/research/agent_repair_packets.json';
  readonly artifact_generated_at: string;
  readonly artifact_digest: string;
  readonly packet_count: number;
  readonly selected_packet_ids: readonly string[];
  readonly packets: readonly AgentRepairPacket[];
  readonly scope: {
    readonly target_ids: readonly string[];
    readonly read_first_files: readonly string[];
    readonly max_files: 16;
  };
  readonly verification: {
    readonly actions: readonly string[];
    readonly max_actions: 12;
    readonly evidence_required: true;
  };
  readonly stop_conditions: readonly string[];
  readonly prompt: string;
  readonly constraints: {
    readonly max_packets: 8;
    readonly max_artifact_bytes: 1048576;
    readonly max_prompt_bytes: 32768;
    readonly approval_required: true;
    readonly executes_agent: false;
    readonly writes_repository: false;
    readonly writes_state: false;
    readonly network_required: false;
    readonly provider_calls_required: false;
    readonly isolated_worktree_required: true;
  };
}

function failure(code: string, message: string): RepairResult<never> {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.includes('\0') || isAbsolute(value)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) return false;
  return !value.split(/[\\/]/).some((part) => part === '..' || part === '');
}

function isRepairPacketSource(value: unknown): boolean {
  return [
    'architecture',
    'evidence_quality',
    'incremental',
    'review_blast_radius',
    'security',
    'tools',
    'verification',
  ].some((source) => source === value);
}

function isRepairHandoffAgent(value: string): value is RepairHandoffAgent {
  return REPAIR_HANDOFF_AGENTS.some((agent) => agent === value);
}

function isRepairPacket(value: unknown): value is AgentRepairPacket {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.priority) &&
    Number(value.priority) > 0 &&
    typeof value.packet_id === 'string' &&
    isRepairPacketSource(value.source) &&
    (value.severity === 'high' || value.severity === 'medium' || value.severity === 'low') &&
    typeof value.target_type === 'string' &&
    typeof value.target_id === 'string' &&
    typeof value.intent === 'string' &&
    isStringArray(value.related_packet_ids) &&
    isStringArray(value.read_first_files) &&
    value.read_first_files.every(isSafeRelativePath) &&
    isStringArray(value.inspect_actions) &&
    isStringArray(value.repair_actions) &&
    isStringArray(value.verification_actions) &&
    isStringArray(value.evidence_ids) &&
    isStringArray(value.evidence_gap_ids) &&
    isStringArray(value.artifacts) &&
    value.artifacts.every(isSafeRelativePath) &&
    typeof value.agent_prompt === 'string' &&
    isStringArray(value.stop_conditions) &&
    (value.confidence === 'verified' ||
      value.confidence === 'inferred' ||
      value.confidence === 'uncertain')
  );
}

function isRepairPacketsArtifact(value: unknown): value is RepairPacketsArtifact {
  if (!isRecord(value)) return false;
  return (
    value.schema_version === 1 &&
    value.deterministic === true &&
    value.provider_calls_required === false &&
    value.network_required === false &&
    typeof value.generated_at === 'string' &&
    Number.isInteger(value.packet_count) &&
    Array.isArray(value.packets) &&
    value.packet_count === value.packets.length &&
    value.packets.every(isRepairPacket) &&
    new Set(value.packets.map((packet) => packet.packet_id)).size === value.packets.length
  );
}

function parseArtifact(contents: string): RepairResult<RepairPacketsArtifact> {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRepairPacketsArtifact(parsed)) {
      return failure('REPAIR_PACKET_INVALID', 'Agent repair packet artifact is invalid.');
    }
    return { ok: true, value: parsed };
  } catch {
    return failure('REPAIR_PACKET_INVALID', 'Agent repair packet artifact is invalid.');
  }
}

function gitRevision(rootDir: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' });
  const revision = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-f0-9]{40}$/.test(revision) ? revision : null;
}

function unique(items: readonly string[], limit: number): string[] {
  return [...new Set(items.filter((item) => item !== ''))].slice(0, limit);
}

function renderPrompt(options: {
  readonly handoffId: string;
  readonly projectId: string;
  readonly revision: string;
  readonly agent: RepairHandoffAgent;
  readonly packets: readonly AgentRepairPacket[];
  readonly readFirstFiles: readonly string[];
  readonly verificationActions: readonly string[];
  readonly stopConditions: readonly string[];
}): string {
  return [
    `Rizz repair handoff ${options.handoffId}`,
    `Agent: ${options.agent}`,
    `Project: ${options.projectId}`,
    `Repository revision: ${options.revision}`,
    `Selected packets: ${options.packets.map((packet) => packet.packet_id).join(', ')}`,
    `Read first: ${options.readFirstFiles.join(', ') || 'none'}`,
    `Repair guidance: ${options.packets.map((packet) => packet.agent_prompt).join(' ')}`,
    `Verification: ${options.verificationActions.join(' ') || 'record exact evidence'}`,
    `Stop conditions: ${options.stopConditions.join(' ')}`,
    'Do not broaden scope or claim repair/verification without recorded evidence.',
  ].join('\n');
}

export async function previewAgentRepairHandoff(options: {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly agent: string;
  readonly packetIds?: readonly string[];
  readonly limit?: number;
}): Promise<RepairResult<AgentRepairHandoff>> {
  if (!isRepairHandoffAgent(options.agent)) {
    return failure(
      'REPAIR_AGENT_UNSUPPORTED',
      `Repair handoff agent must be one of: ${REPAIR_HANDOFF_AGENTS.join(', ')}.`,
    );
  }
  const agent = options.agent;
  const limit = options.limit ?? (options.packetIds === undefined ? 4 : 8);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PACKETS) {
    return failure('REPAIR_LIMIT_INVALID', 'Repair handoff limit must be an integer from 1 to 8.');
  }
  const requestedPacketIds = unique(options.packetIds ?? [], MAX_PACKETS + 1);
  if (requestedPacketIds.length > limit) {
    return failure(
      'REPAIR_PACKET_LIMIT_EXCEEDED',
      `Requested ${requestedPacketIds.length} packets with a limit of ${limit}.`,
    );
  }
  const store = await readProjectStore({
    rootDir: options.rootDir,
    ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
  });
  if (!store.ok) return store;
  const revision = gitRevision(store.value.rootPath);
  if (revision === null) {
    return failure('REPAIR_REVISION_REQUIRED', 'Repair handoff requires a committed Git revision.');
  }
  const artifactPath = join(store.value.researchDir, 'agent_repair_packets.json');
  let contents: string;
  try {
    contents = await readFile(artifactPath, 'utf8');
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return failure(
        'REPAIR_PACKET_PREPARE_REQUIRED',
        'No agent repair packets exist. Run rizz prepare and rizz review first.',
      );
    }
    return failure(
      'REPAIR_PACKET_READ_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (Buffer.byteLength(contents) > MAX_ARTIFACT_BYTES) {
    return failure(
      'REPAIR_ARTIFACT_LIMIT_EXCEEDED',
      `Agent repair packet artifact exceeds ${MAX_ARTIFACT_BYTES} bytes.`,
    );
  }
  const artifact = parseArtifact(contents);
  if (!artifact.ok) return artifact;
  const requested = new Set(requestedPacketIds);
  const missing = requestedPacketIds.filter(
    (packetId) => !artifact.value.packets.some((packet) => packet.packet_id === packetId),
  );
  if (missing.length > 0) {
    return failure('REPAIR_PACKET_NOT_FOUND', `Unknown repair packet(s): ${missing.join(', ')}.`);
  }
  let selected = artifact.value.packets;
  if (requested.size > 0) {
    selected = artifact.value.packets.filter((packet) => requested.has(packet.packet_id));
  }
  selected = selected.slice(0, limit);
  if (selected.length === 0) {
    return failure('REPAIR_PACKET_EMPTY', 'No repair packets are available for handoff.');
  }
  const artifactDigest = createHash('sha256').update(contents).digest('hex');
  const selectedPacketIds = selected.map((packet) => packet.packet_id);
  const handoffId = createHash('sha256')
    .update(
      JSON.stringify({
        project_id: store.value.projectId,
        repository_revision: revision,
        agent,
        artifact_digest: artifactDigest,
        selected_packet_ids: selectedPacketIds,
      }),
    )
    .digest('hex');
  const readFirstFiles = unique(
    selected.flatMap((packet) => packet.read_first_files),
    16,
  );
  const verificationActions = unique(
    selected.flatMap((packet) => packet.verification_actions),
    12,
  );
  const stopConditions = unique(
    selected.flatMap((packet) => packet.stop_conditions),
    12,
  );
  const prompt = renderPrompt({
    handoffId,
    projectId: store.value.projectId,
    revision,
    agent,
    packets: selected,
    readFirstFiles,
    verificationActions,
    stopConditions,
  });
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    return failure(
      'REPAIR_PROMPT_LIMIT_EXCEEDED',
      `Repair handoff prompt exceeds ${MAX_PROMPT_BYTES} bytes. Narrow the packet selection.`,
    );
  }
  return {
    ok: true,
    value: {
      schema_version: 1,
      handoff_id: handoffId,
      project_id: store.value.projectId,
      repository_revision: revision,
      agent,
      artifact: '.rizz/research/agent_repair_packets.json',
      artifact_generated_at: artifact.value.generated_at,
      artifact_digest: artifactDigest,
      packet_count: selected.length,
      selected_packet_ids: selectedPacketIds,
      packets: selected,
      scope: {
        target_ids: unique(
          selected.map((packet) => packet.target_id),
          16,
        ),
        read_first_files: readFirstFiles,
        max_files: 16,
      },
      verification: {
        actions: verificationActions,
        max_actions: 12,
        evidence_required: true,
      },
      stop_conditions: stopConditions,
      prompt,
      constraints: {
        max_packets: MAX_PACKETS,
        max_artifact_bytes: MAX_ARTIFACT_BYTES,
        max_prompt_bytes: MAX_PROMPT_BYTES,
        approval_required: true,
        executes_agent: false,
        writes_repository: false,
        writes_state: false,
        network_required: false,
        provider_calls_required: false,
        isolated_worktree_required: true,
      },
    },
  };
}
