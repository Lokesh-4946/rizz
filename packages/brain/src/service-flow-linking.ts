import { basename } from 'node:path';

type Confidence = 'verified' | 'inferred' | 'uncertain';
type FlowKind = 'api' | 'cli' | 'job' | 'ui' | 'config' | 'test' | 'unknown';
type FlowEntrypointType = 'route' | 'command' | 'function' | 'script' | 'file' | 'config';
type FlowStepType =
  | 'route'
  | 'handler'
  | 'service'
  | 'function'
  | 'config'
  | 'dependency'
  | 'test'
  | 'external';
type FlowRiskKind =
  | 'missing_test'
  | 'missing_config'
  | 'weak_evidence'
  | 'orphan_step'
  | 'changed_hotspot'
  | 'deployment_storage'
  | 'deployment_auth'
  | 'deployment_cors';

interface BrainEntityLike {
  readonly id: string;
  readonly name: string;
  readonly confidence: Confidence;
  readonly evidence_ids: readonly string[];
  readonly source_files: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
}

interface FlowEntrypoint {
  readonly type: FlowEntrypointType;
  readonly path: string;
  readonly symbol: string | null;
  readonly component_id?: string | null;
  readonly evidence: readonly string[];
}

interface FlowStep {
  readonly step_id: string;
  readonly order: number;
  readonly type: FlowStepType;
  readonly path: string;
  readonly symbol: string | null;
  readonly description: string;
  readonly evidence: readonly string[];
}

interface FlowRisk {
  readonly risk_id: string;
  readonly kind: FlowRiskKind;
  readonly description: string;
  readonly evidence: readonly string[];
}

interface FlowEvidence {
  readonly path: string;
  readonly line_start: number;
  readonly line_end: number;
  readonly reason: string;
}

interface FlowServiceCausality {
  readonly service_id: string;
  readonly service_name: string;
  readonly service_root: string;
  readonly files: readonly string[];
  readonly step_ids: readonly string[];
  readonly cause: string;
  readonly effects: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly confidence: Confidence;
  readonly unknowns: readonly string[];
}

interface FlowConfidence {
  readonly score: number;
  readonly reason: string;
}

interface FlowContractSummary {
  readonly entry_contract: readonly string[];
  readonly exit_contract: readonly string[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly side_effects: readonly string[];
  readonly state_transitions: readonly string[];
  readonly failure_modes: readonly string[];
  readonly required_tests: readonly string[];
  readonly confidence_reasons: readonly string[];
  readonly field_evidence: Readonly<Record<string, readonly string[]>>;
}

interface FlowIntelligenceLike {
  readonly flow_id: string;
  readonly name: string;
  readonly kind: FlowKind;
  readonly entrypoints: readonly FlowEntrypoint[];
  readonly steps: readonly FlowStep[];
  readonly components: readonly string[];
  readonly files: readonly string[];
  readonly dependencies: readonly string[];
  readonly runtime_surfaces: readonly string[];
  readonly services?: readonly string[];
  readonly service_causality?: readonly FlowServiceCausality[];
  readonly configs: readonly string[];
  readonly tests: readonly string[];
  readonly risks: readonly FlowRisk[];
  readonly entry_contract: readonly string[];
  readonly exit_contract: readonly string[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly side_effects: readonly string[];
  readonly state_transitions: readonly string[];
  readonly failure_modes: readonly string[];
  readonly required_tests: readonly string[];
  readonly confidence_reasons: readonly string[];
  readonly confidence: FlowConfidence;
  readonly evidence: readonly FlowEvidence[];
  readonly field_evidence: Readonly<Record<string, readonly string[]>>;
  readonly unknowns: readonly string[];
  readonly signals: readonly string[];
}

interface InferServiceEntrypointFlowDeps<Service extends BrainEntityLike> {
  readonly safeText: (value: string) => string;
  readonly evidenceId: (path: string) => string;
  readonly entityId: (type: 'flow', key: string) => string;
  readonly flowStepId: (flowId: string, order: number) => string;
  readonly flowEvidenceForNeedle: (params: {
    readonly rootDir: string;
    readonly path: string;
    readonly needle: RegExp;
    readonly reason: string;
  }) => FlowEvidence;
  readonly flowConfidenceFor: (params: {
    readonly tests: readonly string[];
    readonly signals: readonly string[];
    readonly unknowns: readonly string[];
  }) => { readonly score: number; readonly reason: string };
  readonly flowServiceCausality: (params: {
    readonly frameworkLabel: string;
    readonly entryLabel: string;
    readonly serviceIds: readonly string[];
    readonly services: readonly Service[];
    readonly files: readonly string[];
    readonly steps: readonly FlowStep[];
  }) => FlowServiceCausality[];
  readonly inferFlowContracts: (params: {
    readonly rootDir: string;
    readonly kind: FlowKind;
    readonly entrypoints: readonly FlowEntrypoint[];
    readonly steps: readonly FlowStep[];
    readonly files: readonly string[];
    readonly configs: readonly string[];
    readonly tests: readonly string[];
    readonly risks: readonly FlowRisk[];
    readonly signals: readonly string[];
    readonly confidenceReason: string;
  }) => FlowContractSummary;
  readonly flowRuntimeSurfaces: (params: {
    readonly kind: FlowKind;
    readonly scriptName?: string;
    readonly configs: readonly string[];
    readonly serviceIds: readonly string[];
    readonly services: readonly Service[];
  }) => string[];
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function stringData(entity: BrainEntityLike, key: string): string | undefined {
  const value = entity.data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function stringArrayData(entity: BrainEntityLike, key: string): string[] {
  const value = entity.data?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function serviceRootForEntity(service: BrainEntityLike): string {
  return stringData(service, 'service_root') ?? service.name;
}

export function pathMatchesServiceRoot(path: string, service: BrainEntityLike): boolean {
  const root = serviceRootForEntity(service);
  return root.length > 0 && (path === root || path.startsWith(`${root}/`));
}

function canUseServiceRootFallback(service: BrainEntityLike): boolean {
  const root = serviceRootForEntity(service);
  return (
    root.includes('/') ||
    service.source_files.length > 1 ||
    stringArrayData(service, 'entrypoints').length > 1
  );
}

export function serviceMatchesFlowFile(service: BrainEntityLike, file: string): boolean {
  return (
    service.source_files.some(
      (source) => file === source || file.startsWith(`${source}/`) || source.startsWith(`${file}/`),
    ) ||
    (canUseServiceRootFallback(service) && pathMatchesServiceRoot(file, service))
  );
}

export function serviceIdsForFiles(
  files: readonly string[],
  services: readonly BrainEntityLike[],
): string[] {
  return unique(
    services
      .filter((service) => files.some((file) => serviceMatchesFlowFile(service, file)))
      .map((service) => service.id),
  );
}

export function serviceEntrypointsForFlowFallback(service: BrainEntityLike): string[] {
  return unique(
    stringArrayData(service, 'entrypoints').filter((entrypoint) =>
      service.source_files.includes(entrypoint),
    ),
  );
}

export function flowIntelligenceCoversFile(
  flows: readonly {
    readonly files: readonly string[];
    readonly entrypoints: readonly { readonly path: string }[];
    readonly steps: readonly { readonly path: string }[];
  }[],
  file: string,
): boolean {
  return flows.some(
    (flow) =>
      flow.files.includes(file) ||
      flow.entrypoints.some((entrypoint) => entrypoint.path === file) ||
      flow.steps.some((step) => step.path === file),
  );
}

export function serviceStepsForFlow(params: {
  readonly flowId: string;
  readonly startOrder: number;
  readonly files: readonly string[];
  readonly serviceIds: readonly string[];
  readonly services: readonly BrainEntityLike[];
  readonly safeText: (value: string) => string;
  readonly evidenceId: (path: string) => string;
  readonly flowStepId: (flowId: string, order: number) => string;
}): FlowStep[] {
  const serviceFiles = unique(
    params.services
      .filter((service) => params.serviceIds.includes(service.id))
      .flatMap((service) => params.files.filter((file) => serviceMatchesFlowFile(service, file))),
  );
  return serviceFiles.slice(0, 6).map((file, index) => ({
    step_id: params.flowStepId(params.flowId, params.startOrder + index),
    order: params.startOrder + index,
    type: 'service',
    path: params.safeText(file),
    symbol: null,
    description: `Flow reaches service file ${params.safeText(file)}.`,
    evidence: [params.evidenceId(file)],
  }));
}

export function inferServiceEntrypointFlow<Service extends BrainEntityLike>(params: {
  readonly rootDir: string;
  readonly service: Service;
  readonly entrypoint: string;
  readonly changedFiles: ReadonlySet<string>;
  readonly deps: InferServiceEntrypointFlowDeps<Service>;
}): FlowIntelligenceLike {
  const { deps } = params;
  const flowId = deps.entityId('flow', `service-job/${params.entrypoint}`);
  const entryEvidenceId = deps.evidenceId(params.entrypoint);
  const componentIds = stringArrayData(params.service, 'related_components');
  const configs = unique(stringArrayData(params.service, 'deployment_configs'));
  const files = unique([params.entrypoint, ...params.service.source_files]);
  const entrypointDefinition: FlowEntrypoint = {
    type: 'script',
    path: deps.safeText(params.entrypoint),
    symbol: deps.safeText(basename(params.entrypoint)),
    component_id: componentIds[0] ?? null,
    evidence: [entryEvidenceId],
  };
  const steps: FlowStep[] = [
    {
      step_id: deps.flowStepId(flowId, 1),
      order: 1,
      type: 'handler',
      path: deps.safeText(params.entrypoint),
      symbol: deps.safeText(basename(params.entrypoint)),
      description: `Service entrypoint script ${deps.safeText(
        params.entrypoint,
      )} starts this command flow.`,
      evidence: [entryEvidenceId],
    },
    {
      step_id: deps.flowStepId(flowId, 2),
      order: 2,
      type: 'service',
      path: deps.safeText(params.entrypoint),
      symbol: null,
      description: `Command flow reaches service ${deps.safeText(params.service.name)}.`,
      evidence: [entryEvidenceId],
    },
    ...configs.slice(0, 3).map((config, index) => ({
      step_id: deps.flowStepId(flowId, index + 3),
      order: index + 3,
      type: 'config' as const,
      path: deps.safeText(config),
      symbol: null,
      description: `Service command flow depends on configuration from ${deps.safeText(config)}.`,
      evidence: [deps.evidenceId(config)],
    })),
  ];
  const signals = unique([
    'service entrypoint',
    'service job',
    ...(stringArrayData(params.service, 'jobs').length > 0 ? ['job evidence'] : []),
    ...(stringArrayData(params.service, 'storage_dependencies').length > 0
      ? ['storage evidence']
      : []),
    ...(stringArrayData(params.service, 'environment_variables').length > 0
      ? ['environment evidence']
      : []),
    ...(stringArrayData(params.service, 'external_services').length > 0
      ? ['external API evidence']
      : []),
    ...(configs.length > 0 ? ['configuration'] : []),
  ]);
  const unknowns = unique([
    'No package script or route command was found for this service entrypoint in the capped scan.',
    ...stringArrayData(params.service, 'unknowns'),
  ]);
  const risks: FlowRisk[] = [
    {
      risk_id: `${flowId}:missing-test`,
      kind: 'missing_test',
      description: 'No directly linked test artifact was detected for this service command flow.',
      evidence: [entryEvidenceId],
    },
  ];
  if (files.some((file) => params.changedFiles.has(file))) {
    risks.push({
      risk_id: `${flowId}:changed-hotspot`,
      kind: 'changed_hotspot',
      description: 'A service command flow file changed in the latest scan.',
      evidence: files.filter((file) => params.changedFiles.has(file)).map(deps.evidenceId),
    });
  }
  const confidence = deps.flowConfidenceFor({ tests: [], signals, unknowns });
  const serviceCausality = deps.flowServiceCausality({
    frameworkLabel: 'Service script',
    entryLabel: basename(params.entrypoint),
    serviceIds: [params.service.id],
    services: [params.service],
    files,
    steps,
  });
  const contracts = deps.inferFlowContracts({
    rootDir: params.rootDir,
    kind: 'job',
    entrypoints: [entrypointDefinition],
    steps,
    files,
    configs,
    tests: [],
    risks,
    signals,
    confidenceReason: confidence.reason,
  });
  return {
    flow_id: flowId,
    name: `${deps.safeText(basename(params.entrypoint))} service command flow`,
    kind: 'job',
    entrypoints: [entrypointDefinition],
    steps,
    components: componentIds,
    files,
    dependencies: [],
    runtime_surfaces: deps.flowRuntimeSurfaces({
      kind: 'job',
      scriptName: basename(params.entrypoint),
      configs,
      serviceIds: [params.service.id],
      services: [params.service],
    }),
    services: [params.service.id],
    service_causality: serviceCausality,
    configs,
    tests: [],
    risks,
    entry_contract: contracts.entry_contract,
    exit_contract: contracts.exit_contract,
    inputs: contracts.inputs,
    outputs: contracts.outputs,
    side_effects: contracts.side_effects,
    state_transitions: contracts.state_transitions,
    failure_modes: contracts.failure_modes,
    required_tests: contracts.required_tests,
    confidence_reasons: contracts.confidence_reasons,
    confidence,
    evidence: [
      deps.flowEvidenceForNeedle({
        rootDir: params.rootDir,
        path: params.entrypoint,
        needle: /process\.env|fetch|writeFile|readFile|argv|commander|yargs/i,
        reason: 'Service entrypoint script is the command-flow evidence.',
      }),
    ],
    field_evidence: {
      entrypoints: [entryEvidenceId],
      steps: unique(steps.flatMap((step) => step.evidence)),
      components: params.service.evidence_ids,
      files: files.map(deps.evidenceId),
      dependencies: [],
      runtime_surfaces: unique([entryEvidenceId, ...configs.map(deps.evidenceId)]),
      services: params.service.evidence_ids,
      service_causality: unique(serviceCausality.flatMap((item) => item.evidence_ids)),
      configs: configs.map(deps.evidenceId),
      tests: [],
      risks: unique(risks.flatMap((risk) => risk.evidence)),
      ...contracts.field_evidence,
    },
    unknowns,
    signals,
  };
}
