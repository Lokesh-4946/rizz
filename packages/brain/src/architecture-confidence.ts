type Confidence = 'verified' | 'inferred' | 'uncertain';

interface EntityLike {
  readonly id: string;
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
}

interface EntrypointLike {
  readonly type?: unknown;
  readonly path?: unknown;
  readonly symbol?: unknown;
  readonly component_id?: unknown;
  readonly evidence?: unknown;
}

interface ServiceCausalityLike {
  readonly effects?: unknown;
  readonly evidence_ids?: unknown;
}

interface FlowStepLike {
  readonly type?: unknown;
  readonly path?: unknown;
  readonly evidence?: unknown;
}

type CorrectionSeverity = 'high' | 'medium' | 'low';

export interface ArchitectureFlowEvidenceSummary<T extends EntityLike = EntityLike> {
  readonly weakFlows: readonly T[];
  readonly localEvidenceDebtFlows: readonly T[];
  readonly staticRuntimeDebtFlows: readonly T[];
  readonly scriptStaticEvidenceFlows: readonly T[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function stringData(entity: EntityLike, key: string): string | undefined {
  const value = entity.data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function stringArrayData(entity: EntityLike, key: string): string[] {
  const value = entity.data?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function recordStringArrayData(entity: EntityLike, key: string): Record<string, string[]> {
  const value = entity.data?.[key];
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([field, items]) => [
      field,
      Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [],
    ]),
  );
}

function recordString(value: unknown, key: string, fallback = ''): string {
  if (!isRecord(value)) return fallback;
  const item = value[key];
  return typeof item === 'string' ? item : fallback;
}

function recordNumber(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const item = value[key];
  return typeof item === 'number' ? item : 0;
}

function recordStringArray(value: unknown, key: string): string[] {
  if (!isRecord(value)) return [];
  const item = value[key];
  if (!Array.isArray(item)) return [];
  return item.filter((entry): entry is string => typeof entry === 'string');
}

function recordArray(value: unknown, key: string): Readonly<Record<string, unknown>>[] {
  if (!isRecord(value)) return [];
  const item = value[key];
  return Array.isArray(item) ? item.filter(isRecord) : [];
}

function flowEntrypoints(flow: EntityLike): EntrypointLike[] {
  const value = flow.data?.entrypoints;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function serviceCausality(flow: EntityLike): ServiceCausalityLike[] {
  const value = flow.data?.service_causality;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function flowSteps(flow: EntityLike): FlowStepLike[] {
  const value = flow.data?.steps;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function hasStepEvidence(step: FlowStepLike): boolean {
  return Array.isArray(step.evidence) && step.evidence.length > 0;
}

export function flowHasStaticArchitectureEvidence(flow: EntityLike): boolean {
  const signals = stringArrayData(flow, 'signals');
  const hasCausalSignal = signals.some((signal) =>
    [
      'command path',
      'command target',
      'relative import',
      'source entry',
      'static import',
      'test artifact',
    ].includes(signal),
  );
  const hasCausalStep = flowSteps(flow).some(
    (step) =>
      typeof step.type === 'string' &&
      ['function', 'handler', 'service', 'test'].includes(step.type) &&
      hasStepEvidence(step),
  );
  return (
    hasCausalSignal ||
    hasCausalStep ||
    flowEntrypoints(flow).some((entrypoint) => {
      if (!hasStepEvidence(entrypoint)) return false;
      return (
        typeof entrypoint.type === 'string' &&
        ['api', 'command', 'http', 'layout', 'metadata', 'page', 'route'].includes(entrypoint.type)
      );
    }) ||
    stringArrayData(flow, 'tests').length > 0 ||
    serviceCausality(flow).some(
      (item) =>
        Array.isArray(item.evidence_ids) &&
        item.evidence_ids.length > 0 &&
        Array.isArray(item.effects) &&
        item.effects.length > 0,
    )
  );
}

export function architectureFlowEvidenceSummary<T extends EntityLike>(
  flows: readonly T[],
): ArchitectureFlowEvidenceSummary<T> {
  const weakFlows = flows.filter((flow) => flowArchitectureConfidence(flow) !== 'verified');
  const staticRuntimeDebtFlows = weakFlows.filter(flowHasStaticArchitectureEvidence);
  const staticRuntimeIds = new Set(staticRuntimeDebtFlows.map((flow) => flow.id));
  return {
    weakFlows,
    localEvidenceDebtFlows: weakFlows.filter((flow) => !staticRuntimeIds.has(flow.id)),
    staticRuntimeDebtFlows,
    scriptStaticEvidenceFlows: staticRuntimeDebtFlows.filter((flow) => {
      const signals = stringArrayData(flow, 'signals');
      return stringData(flow, 'kind') === 'script' || signals.includes('package script');
    }),
  };
}

export function architectureFlowEvidencePrecisionRecord(
  summary: ArchitectureFlowEvidenceSummary,
): Record<string, unknown> {
  return {
    weak_flow_count: summary.weakFlows.length,
    local_evidence_gap_count: summary.localEvidenceDebtFlows.length,
    static_runtime_verification_count: summary.staticRuntimeDebtFlows.length,
    script_static_evidence_count: summary.scriptStaticEvidenceFlows.length,
    calibration_rule:
      'Manifest-backed command targets and source/service/test steps count as local static architecture evidence, but they do not claim runtime verification.',
  };
}

export function componentBoundaryEvidenceRecord(params: {
  readonly component: EntityLike;
  readonly flows: readonly EntityLike[];
}): Record<string, unknown> {
  const fieldEvidence = recordStringArrayData(params.component, 'field_evidence');
  const flowEntryPoints = params.flows.flatMap(flowEntrypoints).filter((entrypoint) => {
    if (entrypoint.component_id === params.component.id) return true;
    return Array.isArray(entrypoint.evidence) && entrypoint.evidence.length > 0;
  });
  const componentEntryPoints = stringArrayData(params.component, 'entry_points');
  const directEntrypoints = unique([
    ...componentEntryPoints,
    ...flowEntryPoints.flatMap((entrypoint) => {
      const path = typeof entrypoint.path === 'string' ? entrypoint.path : undefined;
      const symbol = typeof entrypoint.symbol === 'string' ? entrypoint.symbol : undefined;
      if (path === undefined) return symbol === undefined ? [] : [symbol];
      return [symbol === undefined ? path : `${path}#${symbol}`];
    }),
  ]);
  const localTests = unique([
    ...stringArrayData(params.component, 'tests'),
    ...params.flows.flatMap((flow) => stringArrayData(flow, 'tests')),
  ]);
  const localConfigs = unique([
    ...stringArrayData(params.component, 'configs'),
    ...params.flows.flatMap((flow) => stringArrayData(flow, 'configs')),
  ]);
  const readFirst = stringArrayData(params.component, 'read_first');
  const confidence =
    directEntrypoints.length > 0 &&
    readFirst.length > 0 &&
    localTests.length + localConfigs.length > 0
      ? 'verified'
      : directEntrypoints.length + readFirst.length + localTests.length + localConfigs.length > 0
        ? 'inferred'
        : 'uncertain';
  return {
    component_id: params.component.id,
    direct_entrypoint_count: directEntrypoints.length,
    local_test_count: localTests.length,
    local_config_count: localConfigs.length,
    read_first_count: readFirst.length,
    direct_entrypoints: directEntrypoints.slice(0, 8),
    local_tests: localTests.slice(0, 8),
    local_configs: localConfigs.slice(0, 8),
    read_first: readFirst.slice(0, 8),
    confidence,
    evidence_ids: unique([
      ...params.component.evidence_ids,
      ...(fieldEvidence.entry_points ?? []),
      ...(fieldEvidence.tests ?? []),
      ...(fieldEvidence.configs ?? []),
      ...(fieldEvidence.read_first ?? []),
      ...params.flows.flatMap((flow) => flow.evidence_ids),
    ]).slice(0, 20),
    calibration_rule:
      'Boundary confidence uses direct entrypoints, local tests/configs, and read-first files; it does not claim runtime verification.',
  };
}

export function componentBoundaryEvidenceRecords<T extends EntityLike>(params: {
  readonly components: readonly T[];
  readonly flowsByComponent: ReadonlyMap<string, readonly EntityLike[]>;
}): Record<string, unknown>[] {
  return params.components.map((component) =>
    componentBoundaryEvidenceRecord({
      component,
      flows: params.flowsByComponent.get(component.id) ?? [],
    }),
  );
}

export function componentBoundaryEvidenceById(
  records: readonly Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
  return new Map(
    records.flatMap((record) =>
      typeof record.component_id === 'string' ? [[record.component_id, record]] : [],
    ),
  );
}

export function componentBoundaryConfidence(boundaryEvidence: unknown): Confidence {
  if (!isRecord(boundaryEvidence)) return 'uncertain';
  if (boundaryEvidence.confidence === 'verified') return 'verified';
  if (boundaryEvidence.confidence === 'inferred') return 'inferred';
  return 'uncertain';
}

export function componentBoundaryUnknowns(
  component: EntityLike,
  boundaryEvidence: unknown,
): string[] {
  if (!isRecord(boundaryEvidence)) return stringArrayData(component, 'unknowns');
  const hasDirectEntrypoint = Number(boundaryEvidence.direct_entrypoint_count ?? 0) > 0;
  const hasLocalTests = Number(boundaryEvidence.local_test_count ?? 0) > 0;
  const hasLocalConfigs = Number(boundaryEvidence.local_config_count ?? 0) > 0;
  const hasReadFirst = Number(boundaryEvidence.read_first_count ?? 0) > 0;
  return stringArrayData(component, 'unknowns').filter((unknown) => {
    if (
      hasDirectEntrypoint &&
      unknown === 'No explicit entrypoint was detected for this component.'
    ) {
      return false;
    }
    if (hasLocalTests && unknown === 'No component-local test evidence was detected.') {
      return false;
    }
    if (
      hasReadFirst &&
      (hasLocalConfigs || hasLocalTests || hasDirectEntrypoint) &&
      unknown === 'Component understanding is backed by limited static evidence.'
    ) {
      return false;
    }
    return true;
  });
}

function correctionPacketSlug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function correctionSeverity(params: {
  readonly missingEntrypoint: boolean;
  readonly missingTests: boolean;
  readonly missingConfig: boolean;
  readonly missingFlows: boolean;
  readonly isScriptComponent: boolean;
}): CorrectionSeverity {
  if (params.missingEntrypoint && (params.missingTests || params.missingFlows)) return 'high';
  if (params.missingTests && params.isScriptComponent) return 'high';
  if (params.missingFlows || params.missingTests || params.missingConfig) return 'medium';
  return 'low';
}

function correctionConfidenceDelta(severity: CorrectionSeverity): number {
  if (severity === 'high') return 100;
  if (severity === 'medium') return 60;
  return 20;
}

function correctionParseSeverity(value: unknown): CorrectionSeverity {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return 'medium';
}

function correctionCurrentConfidence(value: unknown): Confidence {
  if (!isRecord(value)) return 'uncertain';
  if (value.confidence === 'verified') return 'verified';
  if (value.confidence === 'inferred') return 'inferred';
  return 'uncertain';
}

export function componentCorrectionPackets<T extends EntityLike>(params: {
  readonly components: readonly T[];
  readonly flowsByComponent: ReadonlyMap<string, readonly EntityLike[]>;
  readonly boundaryEvidenceByComponent: ReadonlyMap<string, Record<string, unknown>>;
}): Record<string, unknown>[] {
  return params.components
    .flatMap((component): Record<string, unknown>[] => {
      const boundaryEvidence = params.boundaryEvidenceByComponent.get(component.id);
      if (!isRecord(boundaryEvidence)) return [];
      const boundaryType = stringData(component, 'boundary_type') ?? 'unknown';
      const componentFlows = params.flowsByComponent.get(component.id) ?? [];
      const directEntrypointCount = recordNumber(boundaryEvidence, 'direct_entrypoint_count');
      const localTestCount = recordNumber(boundaryEvidence, 'local_test_count');
      const localConfigCount = recordNumber(boundaryEvidence, 'local_config_count');
      const readFirstCount = recordNumber(boundaryEvidence, 'read_first_count');
      const directEntrypoints = recordStringArray(boundaryEvidence, 'direct_entrypoints');
      const readFirstFiles = recordStringArray(boundaryEvidence, 'read_first');
      const localConfigs = recordStringArray(boundaryEvidence, 'local_configs');
      const isScriptComponent =
        boundaryType === 'automation' ||
        component.id.includes(':scripts') ||
        directEntrypoints.some((entrypoint) => entrypoint.includes('package.json#'));
      const missingEntrypoint = directEntrypointCount === 0;
      const missingTests =
        localTestCount === 0 &&
        (stringData(component, 'criticality') !== 'low' ||
          boundaryType === 'automation' ||
          boundaryType === 'unknown' ||
          component.id.includes(':config'));
      const missingConfig = localConfigCount === 0 && boundaryType !== 'quality';
      const missingFlows = componentFlows.length === 0;
      if (!missingEntrypoint && !missingTests && !missingConfig && !missingFlows) return [];
      const missingEvidence = unique([
        ...(missingEntrypoint ? ['direct entrypoint evidence'] : []),
        ...(missingTests ? ['component-local test evidence'] : []),
        ...(missingConfig ? ['component-local config evidence'] : []),
        ...(missingFlows ? ['reconstructed flow coverage'] : []),
      ]);
      const severity = correctionSeverity({
        missingEntrypoint,
        missingTests,
        missingConfig,
        missingFlows,
        isScriptComponent,
      });
      const inspectActions = unique([
        ...(missingEntrypoint
          ? [`Identify the concrete entrypoint for ${component.id} before changing it.`]
          : []),
        ...(missingFlows
          ? [`Link ${component.id} to route, script, service, or test flows if the component runs.`]
          : []),
        ...(missingConfig
          ? [`Inspect local manifests/configs that define ${component.id} behavior.`]
          : []),
        ...(readFirstCount > 0
          ? [`Start with the listed read-first files for ${component.id}.`]
          : [`Find a read-first source or config file for ${component.id}.`]),
      ]);
      const testActions = unique([
        ...(missingTests
          ? [
              isScriptComponent
                ? `Add or identify a local smoke test for ${component.id} package-script flows.`
                : `Add or identify a component-local test for ${component.id}.`,
            ]
          : []),
        `Do not mark ${component.id} runtime-verified until the targeted check actually runs.`,
      ]);
      const verificationActions = unique([
        `Run rizz brain and confirm ${component.id} component_boundary_evidence improves.`,
        ...(missingTests
          ? [
              'Run the targeted local test and attach verification evidence before upgrading runtime confidence.',
            ]
          : []),
        ...(missingFlows
          ? ['Confirm the component appears in at least one reconstructed flow.']
          : []),
      ]);
      return [
        {
          packet_id: `correction:${correctionPacketSlug(component.id)}:component-boundary`,
          component_id: component.id,
          boundary_type: boundaryType,
          severity,
          confidence: correctionCurrentConfidence(boundaryEvidence),
          reason: `${component.id} needs component-local correction for ${missingEvidence.join(', ')}.`,
          missing_evidence: missingEvidence,
          current_evidence: {
            direct_entrypoint_count: directEntrypointCount,
            local_test_count: localTestCount,
            local_config_count: localConfigCount,
            read_first_count: readFirstCount,
            flow_count: componentFlows.length,
          },
          read_first_files: readFirstFiles.slice(0, 6),
          inspect_targets: unique([...readFirstFiles, ...directEntrypoints, ...localConfigs]).slice(
            0,
            10,
          ),
          inspect_actions: inspectActions,
          test_actions: testActions,
          verification_actions: verificationActions,
          evidence_ids: unique([
            ...component.evidence_ids,
            ...recordStringArray(boundaryEvidence, 'evidence_ids'),
            ...componentFlows.flatMap((flow) => flow.evidence_ids),
          ]).slice(0, 12),
          evidence_gap_ids: missingEvidence.map(
            (gap) => `gap:${correctionPacketSlug(component.id)}:${correctionPacketSlug(gap)}`,
          ),
          agent_prompt: `Read the packet files, inspect ${component.id}, then repair only the missing local evidence before rerunning rizz.`,
          target_outcome:
            'The next brain scan should show direct boundary evidence, targeted local checks, and unchanged runtime honesty unless tests actually ran.',
          calibration_rule:
            'Correction packets are deterministic static guidance for agents; they recommend read/inspect/test steps and do not assert repairs were performed.',
        },
      ];
    })
    .sort(
      (a, b) =>
        correctionSeverityRank(recordString(a, 'severity', 'medium')) -
          correctionSeverityRank(recordString(b, 'severity', 'medium')) ||
        recordString(a, 'component_id').localeCompare(recordString(b, 'component_id')),
    )
    .slice(0, 20);
}

function correctionSeverityRank(value: string): number {
  if (value === 'high') return 0;
  if (value === 'medium') return 1;
  return 2;
}

export function componentCorrectionQueueItems(
  architectureReasoning: Record<string, unknown>,
): Array<{
  readonly source: 'architecture';
  readonly severity: CorrectionSeverity;
  readonly target_type: string;
  readonly target_id: string;
  readonly reason: string;
  readonly current_confidence: Confidence;
  readonly confidence_delta: number;
  readonly inspect_hint: string;
  readonly verification_actions: readonly string[];
  readonly read_first_files: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly evidence_gap_ids: readonly string[];
  readonly artifacts: readonly string[];
}> {
  return recordArray(architectureReasoning, 'component_correction_packets')
    .slice(0, 8)
    .map((packet) => {
      const severity = correctionParseSeverity(packet.severity);
      return {
        source: 'architecture',
        severity,
        target_type: 'component_correction_packet',
        target_id: recordString(packet, 'component_id', 'unknown component'),
        reason: recordString(packet, 'reason', 'Component-local correction packet needs action.'),
        current_confidence: correctionCurrentConfidence(packet),
        confidence_delta: correctionConfidenceDelta(severity),
        inspect_hint: recordString(
          packet,
          'agent_prompt',
          'Read the component correction packet before editing.',
        ),
        verification_actions: recordStringArray(packet, 'verification_actions').slice(0, 4),
        read_first_files: recordStringArray(packet, 'read_first_files').slice(0, 6),
        evidence_ids: recordStringArray(packet, 'evidence_ids').slice(0, 8),
        evidence_gap_ids: recordStringArray(packet, 'evidence_gap_ids').slice(0, 8),
        artifacts: ['.rizz/research/architecture_reasoning.json', '.rizz/reports/index.html'],
      };
    });
}

export function flowArchitectureScore(flow: EntityLike): number {
  const confidence = flow.data?.confidence;
  if (isRecord(confidence) && typeof confidence.score === 'number') return confidence.score;
  if (flow.confidence === 'verified') return 1;
  if (flow.confidence === 'inferred') return 0.65;
  return 0.35;
}

export function flowArchitectureConfidence(flow: EntityLike): Confidence {
  const score = flowArchitectureScore(flow);
  const entrypoints = flowEntrypoints(flow);
  const hasRouteEntrypoint =
    stringData(flow, 'kind') === 'api' ||
    entrypoints.some(
      (entrypoint) =>
        typeof entrypoint.type === 'string' &&
        ['api', 'http', 'layout', 'metadata', 'page', 'route'].includes(entrypoint.type),
    );
  const hasEntrypointEvidence = entrypoints.some(
    (entrypoint) => Array.isArray(entrypoint.evidence) && entrypoint.evidence.length > 0,
  );
  const hasServiceCausality = serviceCausality(flow).some(
    (item) =>
      Array.isArray(item.evidence_ids) &&
      item.evidence_ids.length > 0 &&
      Array.isArray(item.effects) &&
      item.effects.length > 0,
  );
  const hasLocalVerification = stringArrayData(flow, 'tests').length > 0 || hasServiceCausality;
  const hasArchitectureContext =
    stringArrayData(flow, 'components').length > 0 || stringArrayData(flow, 'services').length > 0;
  const hasArchitectureEntrypoint = hasRouteEntrypoint || hasServiceCausality;
  if (
    score >= 0.75 &&
    hasEntrypointEvidence &&
    hasArchitectureContext &&
    hasLocalVerification &&
    hasArchitectureEntrypoint
  ) {
    return 'verified';
  }
  if (flow.confidence === 'verified' && !hasArchitectureEntrypoint) return 'inferred';
  if (flow.confidence === 'verified') return 'verified';
  if (score >= 0.5 && (hasRouteEntrypoint || hasArchitectureContext)) return 'inferred';
  return 'uncertain';
}

export function componentLocalEvidenceRecords(params: {
  readonly components: readonly EntityLike[];
  readonly flows: readonly EntityLike[];
  readonly services: readonly EntityLike[];
}): Array<Record<string, unknown>> {
  return params.components.map((component) => {
    const routeFlows = params.flows.filter(
      (flow) =>
        stringArrayData(flow, 'components').includes(component.id) &&
        (stringData(flow, 'kind') === 'api' ||
          flowEntrypoints(flow).some((entrypoint) => entrypoint.type === 'route')),
    );
    const serviceIds = unique([
      ...params.services
        .filter((service) => stringArrayData(service, 'related_components').includes(component.id))
        .map((service) => service.id),
      ...params.flows
        .filter((flow) => stringArrayData(flow, 'components').includes(component.id))
        .flatMap((flow) => stringArrayData(flow, 'services')),
    ]);
    const serviceFlows = params.flows.filter((flow) =>
      stringArrayData(flow, 'services').some((serviceId) => serviceIds.includes(serviceId)),
    );
    const fieldEvidence = recordStringArrayData(component, 'field_evidence');
    return {
      component_id: component.id,
      route_flow_count: routeFlows.length,
      service_count: serviceIds.length,
      service_flow_count: serviceFlows.length,
      local_tests: unique([
        ...stringArrayData(component, 'tests'),
        ...routeFlows.flatMap((flow) => stringArrayData(flow, 'tests')),
        ...serviceFlows.flatMap((flow) => stringArrayData(flow, 'tests')),
      ]),
      local_configs: unique([
        ...stringArrayData(component, 'configs'),
        ...routeFlows.flatMap((flow) => stringArrayData(flow, 'configs')),
        ...serviceFlows.flatMap((flow) => stringArrayData(flow, 'configs')),
      ]),
      evidence_ids: unique([
        ...component.evidence_ids,
        ...(fieldEvidence.tests ?? []),
        ...(fieldEvidence.configs ?? []),
        ...routeFlows.flatMap((flow) => flow.evidence_ids),
        ...serviceFlows.flatMap((flow) => flow.evidence_ids),
        ...params.services
          .filter((service) => serviceIds.includes(service.id))
          .flatMap((service) => service.evidence_ids),
      ]).slice(0, 20),
      confidence:
        routeFlows.some((flow) => flowArchitectureConfidence(flow) === 'verified') ||
        serviceFlows.some((flow) => flowArchitectureConfidence(flow) === 'verified')
          ? 'verified'
          : routeFlows.length + serviceFlows.length > 0
            ? 'inferred'
            : 'uncertain',
    };
  });
}

export function componentLocalEvidenceReadiness(records: readonly unknown[]): number {
  const localRecords = records.filter(isRecord);
  if (localRecords.length === 0) return 0;
  const withRouteOrService = localRecords.filter(
    (record) =>
      (typeof record.route_flow_count === 'number' && record.route_flow_count > 0) ||
      (typeof record.service_count === 'number' && record.service_count > 0),
  );
  const withTestsOrConfigs = localRecords.filter((record) => {
    const tests = Array.isArray(record.local_tests) ? record.local_tests.length : 0;
    const configs = Array.isArray(record.local_configs) ? record.local_configs.length : 0;
    return tests + configs > 0;
  });
  const verified = localRecords.filter((record) => record.confidence === 'verified');
  return Math.round(
    (withRouteOrService.length / localRecords.length) * 45 +
      (withTestsOrConfigs.length / localRecords.length) * 30 +
      (verified.length / localRecords.length) * 25,
  );
}

export {
  architectureFlowEvidencePrecisionRecord as ap,
  architectureFlowEvidenceSummary as aes,
  componentBoundaryConfidence as bc,
  componentBoundaryEvidenceById as bi,
  componentBoundaryEvidenceRecords as br,
  componentBoundaryUnknowns as bu,
  componentCorrectionPackets as ccp,
  componentCorrectionQueueItems as cqi,
  componentLocalEvidenceRecords as cl,
  flowArchitectureConfidence as afc,
};
