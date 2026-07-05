type Confidence = 'verified' | 'inferred' | 'uncertain';

interface EntityLike {
  readonly id: string;
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
}

interface EntrypointLike {
  readonly type?: unknown;
  readonly evidence?: unknown;
}

interface ServiceCausalityLike {
  readonly effects?: unknown;
  readonly evidence_ids?: unknown;
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
