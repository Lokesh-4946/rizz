export interface FileExplainIntelligence {
  readonly purpose?: string;
  readonly responsibilities: readonly string[];
}

const GENERIC_CONSUMER_FALLBACK =
  'Other project components; exact consumers need deeper flow analysis.';

export function mergeFileConsumers(params: {
  readonly recorded: readonly string[];
  readonly relationships: readonly string[];
  readonly routes: readonly string[];
}): string[] {
  const hasExactConsumer = params.relationships.length > 0 || params.routes.length > 0;
  const recorded = hasExactConsumer
    ? params.recorded.filter((consumer) => consumer !== GENERIC_CONSUMER_FALLBACK)
    : params.recorded;
  return unique([...recorded, ...params.relationships, ...params.routes]);
}

export function fileExplainFlowProjection(params: {
  readonly targetPath: string;
  readonly flows: readonly {
    readonly routePath: string | undefined;
    readonly entrypointPath: string | undefined;
    readonly evidenceIds: readonly string[];
    readonly entrypointEvidenceIds: readonly string[];
  }[];
}): { readonly consumers: readonly string[]; readonly evidenceIds: readonly string[] } {
  const consumers = unique(
    params.flows.flatMap((flow) => {
      if (
        flow.routePath === undefined ||
        flow.entrypointPath === undefined ||
        flow.entrypointPath === params.targetPath
      ) {
        return [];
      }
      return [`route consumer: ${flow.routePath} via ${flow.entrypointPath}`];
    }),
  );
  return {
    consumers,
    evidenceIds: unique(
      params.flows.flatMap((flow) => [...flow.evidenceIds, ...flow.entrypointEvidenceIds]),
    ),
  };
}

const DOMAIN_TERMS = [
  'workflow',
  'form',
  'document',
  'repository',
  'search',
  'notification',
  'comment',
  'redaction',
  'viewer',
  'permission',
  'tenant',
  'task',
] as const;

function unique(items: readonly string[]): string[] {
  return [...new Set(items.filter((item) => item !== ''))];
}

export function explainRelationshipContext(
  targetId: string,
  relationships: readonly {
    readonly from: string;
    readonly to: string;
    readonly relation: string;
    readonly evidence_ids: readonly string[];
  }[],
): {
  readonly dependsOn: readonly string[];
  readonly dependedOnBy: readonly string[];
  readonly dependsOnEntityIds: readonly string[];
  readonly dependedOnByEntityIds: readonly string[];
  readonly evidenceIds: readonly string[];
} {
  const dependencyRelations = new Set(['depends_on', 'calls', 'imports', 'configures']);
  const outbound = relationships.filter(
    (item) => item.from === targetId && dependencyRelations.has(item.relation),
  );
  const inbound = relationships.filter(
    (item) => item.to === targetId && dependencyRelations.has(item.relation),
  );
  return {
    dependsOn: unique(outbound.map((item) => `${item.relation}: ${item.to}`)),
    dependedOnBy: unique(inbound.map((item) => `${item.relation}: ${item.from}`)),
    dependsOnEntityIds: unique(outbound.map((item) => item.to)),
    dependedOnByEntityIds: unique(inbound.map((item) => item.from)),
    evidenceIds: unique([...outbound, ...inbound].flatMap((item) => item.evidence_ids)),
  };
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function namesFor(pattern: RegExp, content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return unique(names).slice(0, 8);
}

function importedModules(content: string): string[] {
  return unique(
    [...content.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
      .map((match) => match[1] ?? '')
      .filter((specifier) => specifier.startsWith('.')),
  ).slice(0, 6);
}

function domainTerms(content: string): string[] {
  const lower = content.toLowerCase();
  return DOMAIN_TERMS.map((term) => ({
    term,
    count: lower.split(term).length - 1,
  }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .map((item) => item.term)
    .slice(0, 4);
}

function surfaceLabel(path: string, terms: readonly string[]): string {
  const lowerPath = path.toLowerCase();
  if (lowerPath.includes('contract')) return `${terms.join('/')} contract and runtime surface`;
  if (lowerPath.includes('route')) return `${terms.join('/')} route surface`;
  if (lowerPath.includes('service')) return `${terms.join('/')} service surface`;
  if (terms.length > 0) return `${terms.join('/')} source surface`;
  return 'source file';
}

export function fileExplainIntelligence(params: {
  readonly path: string;
  readonly content: string | undefined;
}): FileExplainIntelligence | undefined {
  if (params.content === undefined || params.content.trim() === '') return undefined;
  const exported = namesFor(
    /\bexport\s+(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g,
    params.content,
  );
  const localFunctions = namesFor(
    /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    params.content,
  ).filter((name) => !exported.includes(name));
  const imports = importedModules(params.content);
  const terms = domainTerms(params.content);
  if (exported.length === 0 && localFunctions.length === 0 && terms.length === 0) {
    return undefined;
  }
  const label = surfaceLabel(params.path, terms);
  const purposeParts = [
    `${basename(params.path)} is a ${label} inferred from file content.`,
    exported.length > 0 ? `Exports ${exported.slice(0, 5).join(', ')}.` : '',
    localFunctions.length > 0
      ? `Local logic includes ${localFunctions.slice(0, 5).join(', ')}.`
      : '',
  ].filter((part) => part !== '');
  return {
    purpose: purposeParts.join(' '),
    responsibilities: unique([
      ...(exported.length > 0
        ? [`Define exported source contract(s): ${exported.slice(0, 6).join(', ')}.`]
        : []),
      ...(terms.length > 0
        ? [`Coordinate ${terms.join(', ')} behavior indicated by repeated source terms.`]
        : []),
      ...(imports.length > 0
        ? [`Use local collaborators: ${imports.slice(0, 5).join(', ')}.`]
        : []),
      'Treat this as deterministic static source inspection, not runtime verification.',
    ]),
  };
}
