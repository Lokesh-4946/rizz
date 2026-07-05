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
