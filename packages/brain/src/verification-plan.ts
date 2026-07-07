type Confidence = 'verified' | 'inferred' | 'uncertain';

type VerificationPriority = 'required' | 'recommended' | 'optional';

type VerificationType = 'test' | 'typecheck' | 'lint' | 'build' | 'pack' | 'manual';

interface VerificationEntity {
  readonly id: string;
  readonly name: string;
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly source_files: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
}

interface AgentVerificationPlanItem {
  readonly id: string;
  readonly priority: VerificationPriority;
  readonly verification_type: VerificationType;
  readonly command_name?: string;
  readonly command?: string;
  readonly manifest?: string;
  readonly reason: string;
  readonly agent_instructions: readonly string[];
  readonly linked_flows: readonly string[];
  readonly linked_components: readonly string[];
  readonly linked_files: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly expected_evidence: {
    readonly record_with: string;
    readonly confidence_upgrade_rule: string;
  };
  readonly confidence: Confidence;
}

export interface AgentVerificationPlanArtifact {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly deterministic: true;
  readonly provider_calls_required: false;
  readonly network_required: false;
  readonly execution_owner: 'coding_agent';
  readonly runtime_execution_policy: string;
  readonly plan_count: number;
  readonly required_count: number;
  readonly recommended_count: number;
  readonly optional_count: number;
  readonly items: readonly AgentVerificationPlanItem[];
  readonly summary: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === 'string' ? item : undefined;
}

function stableSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.filter((item) => item !== ''))];
}

function commandType(name: string, command: string): VerificationType {
  const value = `${name} ${command}`.toLowerCase();
  if (/typecheck|type-check|tsc\b/.test(value)) return 'typecheck';
  if (/test|vitest|jest|pytest|playwright|cypress/.test(value)) return 'test';
  if (/lint|biome|eslint/.test(value)) return 'lint';
  if (/pack|npm pack|pnpm pack/.test(value)) return 'pack';
  if (/build|compile|bundle/.test(value)) return 'build';
  return 'manual';
}

function priorityFor(type: VerificationType): VerificationPriority {
  if (type === 'test' || type === 'typecheck') return 'required';
  if (type === 'lint' || type === 'build') return 'recommended';
  return 'optional';
}

function commandRank(type: VerificationType): number {
  if (type === 'test') return 0;
  if (type === 'typecheck') return 1;
  if (type === 'lint') return 2;
  if (type === 'build') return 3;
  if (type === 'pack') return 4;
  return 5;
}

function relatedFlowIds(
  command: VerificationEntity,
  flows: readonly VerificationEntity[],
): string[] {
  const manifest = recordString(command.data, 'manifest') ?? command.source_files[0] ?? '';
  const commandName = command.name.toLowerCase();
  return flows
    .filter((flow) => {
      const files = Array.isArray(flow.data?.files) ? flow.data.files : [];
      const kind = recordString(flow.data, 'kind') ?? '';
      return (
        files.includes(manifest) ||
        flow.name.toLowerCase().includes(commandName) ||
        kind.toLowerCase() === commandName
      );
    })
    .map((flow) => flow.id)
    .slice(0, 8);
}

function relatedComponentIds(
  files: readonly string[],
  components: readonly VerificationEntity[],
): string[] {
  return components
    .filter((component) =>
      component.source_files.some((file) =>
        files.some(
          (linked) =>
            linked === file || file.startsWith(`${linked.replace(/\/package\.json$/, '')}/`),
        ),
      ),
    )
    .map((component) => component.id)
    .slice(0, 8);
}

export function buildAgentVerificationPlanArtifact(params: {
  readonly generatedAt: string;
  readonly commands: readonly VerificationEntity[];
  readonly flows: readonly VerificationEntity[];
  readonly components: readonly VerificationEntity[];
}): AgentVerificationPlanArtifact {
  const items: AgentVerificationPlanItem[] = [];
  for (const command of params.commands) {
    const commandText = recordString(command.data, 'command');
    const manifest = recordString(command.data, 'manifest') ?? command.source_files[0];
    if (commandText === undefined || manifest === undefined) continue;
    const type = commandType(command.name, commandText);
    const priority = priorityFor(type);
    const linkedFlows = relatedFlowIds(command, params.flows);
    const linkedFiles = unique([manifest, ...command.source_files]);
    const linkedComponents = relatedComponentIds(linkedFiles, params.components);
    const evidenceName = `${manifest}#${command.name}`;
    items.push({
      id: `verification-plan:${stableSlug(evidenceName)}`,
      priority,
      verification_type: type,
      command_name: command.name,
      command: commandText,
      manifest,
      reason:
        priority === 'required'
          ? 'Agent should run this before claiming runtime-verified confidence.'
          : 'Agent should run this when the change touches related behavior or before approval.',
      agent_instructions: [
        `Run ${commandText} from the repo root or the package context implied by ${manifest}.`,
        'Capture pass/fail status and a short output summary.',
        `Record the result with rizz verify add --name "${evidenceName}" --command "${commandText}" --status <passed|failed|skipped> --summary "<what happened>".`,
      ],
      linked_flows: linkedFlows,
      linked_components: linkedComponents,
      linked_files: linkedFiles,
      evidence_ids: command.evidence_ids,
      expected_evidence: {
        record_with: 'rizz verify add',
        confidence_upgrade_rule:
          'Only recorded passed evidence can upgrade runtime confidence; skipped, unknown, or failed evidence keeps runtime claims unverified.',
      },
      confidence: linkedFlows.length > 0 || linkedComponents.length > 0 ? 'inferred' : 'uncertain',
    });
  }
  const commandItems = items
    .sort(
      (a, b) =>
        commandRank(a.verification_type) - commandRank(b.verification_type) ||
        (a.manifest ?? '').localeCompare(b.manifest ?? '') ||
        (a.command_name ?? '').localeCompare(b.command_name ?? ''),
    )
    .slice(0, 12);

  const requiredCount = commandItems.filter((item) => item.priority === 'required').length;
  const recommendedCount = commandItems.filter((item) => item.priority === 'recommended').length;
  const optionalCount = commandItems.filter((item) => item.priority === 'optional').length;
  return {
    schema_version: 1,
    generated_at: params.generatedAt,
    deterministic: true,
    provider_calls_required: false,
    network_required: false,
    execution_owner: 'coding_agent',
    runtime_execution_policy:
      'rizz plans and judges runtime evidence; the coding agent runs commands only with user/workspace approval.',
    plan_count: commandItems.length,
    required_count: requiredCount,
    recommended_count: recommendedCount,
    optional_count: optionalCount,
    items: commandItems,
    summary:
      commandItems.length === 0
        ? 'No runnable verification commands were detected; agent must use manual verification evidence.'
        : `${commandItems.length} agent-run verification check(s) detected: ${requiredCount} required, ${recommendedCount} recommended, ${optionalCount} optional.`,
  };
}
