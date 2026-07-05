interface CommandTargetStep {
  readonly step_id: string;
  readonly order: number;
  readonly type: 'handler';
  readonly path: string;
  readonly symbol: string;
  readonly description: string;
  readonly evidence: readonly string[];
}

type Confidence = 'verified' | 'inferred' | 'uncertain';

function normalizedPathHint(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/[),;]+$/g, '');
}

function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]+)"|'([^']+)'|`([^`]+)`|[^\s]+/g;
  for (const match of command.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[0];
    const normalized = normalizedPathHint(token);
    if (normalized !== '') tokens.push(normalized);
  }
  return tokens;
}

function extension(path: string): string {
  const index = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return index > slash ? path.slice(index) : '';
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

export function commandTargetPaths(command: string, baseDir: string | undefined): string[] {
  return unique(
    commandTokens(command).flatMap((token) => {
      if (token.startsWith('-') || token.includes('://')) return [];
      if (/\s/.test(token)) return [];
      if (token.includes('=') && !token.includes('/')) return [];
      if (!token.includes('/') && extension(token) === '') return [];
      if (baseDir === undefined || token.startsWith('/') || token.startsWith('../')) return [token];
      return [token, `${baseDir}/${token}`];
    }),
  ).slice(0, 8);
}

export function commandTargetSteps(params: {
  readonly targets: readonly string[];
  readonly representedPaths: ReadonlySet<string>;
  readonly flowId: string;
  readonly startOrder: number;
  readonly scriptName: string;
  readonly evidenceId: string;
  readonly flowStepId: (flowId: string, order: number) => string;
}): CommandTargetStep[] {
  return params.targets
    .filter((path) => !params.representedPaths.has(path))
    .slice(0, 3)
    .map((target, index) => {
      const order = params.startOrder + index;
      return {
        step_id: params.flowStepId(params.flowId, order),
        order,
        type: 'handler',
        path: target,
        symbol: params.scriptName,
        description: `Package script targets ${target} from manifest command evidence.`,
        evidence: [params.evidenceId],
      };
    });
}

export function flowConfidenceFor(intelligence: {
  readonly tests: readonly unknown[];
  readonly signals: readonly string[];
  readonly unknowns: readonly unknown[];
}): {
  readonly confidence: Confidence;
  readonly score: number;
  readonly reason: string;
} {
  let score = 0.35;
  if (intelligence.signals.includes('package script')) score += 0.2;
  if (intelligence.signals.includes('command target')) score += 0.15;
  if (intelligence.signals.includes('static import')) score += 0.15;
  if (intelligence.signals.includes('route file')) score += 0.15;
  if (intelligence.tests.length > 0) score += 0.15;
  if (intelligence.unknowns.length > 0) score -= 0.1;
  const capped = Math.max(0.1, Math.min(0.95, Number(score.toFixed(2))));
  if (capped >= 0.9 && intelligence.unknowns.length === 0) {
    return {
      confidence: 'verified',
      score: capped,
      reason: 'Direct entrypoint, source, and test evidence were detected.',
    };
  }
  if (capped >= 0.5) {
    return {
      confidence: 'inferred',
      score: capped,
      reason:
        'Flow is reconstructed from local static evidence; runtime reachability is not traced.',
    };
  }
  return {
    confidence: 'uncertain',
    score: capped,
    reason: 'Flow has weak or partial static evidence and needs confirmation before relying on it.',
  };
}
