import { type DecisionRecord, activeDecisions } from './decisions.js';

/** Share of significant words two texts must share before a decision looks like a rewrite. */
export const DECISION_OVERLAP_THRESHOLD = 0.6;

export type DriftKind = 'never_constraint' | 'decision_overlap' | 'unknown_supersede';

export interface DriftFinding {
  readonly severity: 'block' | 'note';
  readonly kind: DriftKind;
  readonly message: string;
  readonly decisionId?: string;
}

export interface ProposedDecision {
  readonly text: string;
  readonly supersedes?: string;
}

export interface DriftInput {
  readonly visionText: string;
  readonly decisions: readonly DecisionRecord[];
  /** Task, handoff goal, or done-items joined into one blob. */
  readonly text: string;
  readonly proposedDecisions?: readonly ProposedDecision[];
}

function significantWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
}

function wordSet(text: string): Set<string> {
  return new Set(significantWords(text));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) shared += 1;
  }
  const union = left.size + right.size - shared;
  if (union === 0) return 0;
  return shared / union;
}

function neverBullets(visionText: string): string[] {
  const bullets: string[] = [];
  let inNever = false;
  for (const line of visionText.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line.trim());
    if (heading !== null) {
      inNever = (heading[1] ?? '').trim().toLowerCase() === 'never';
      continue;
    }
    if (!inNever) continue;
    const bullet = /^[-*]\s+(.+)$/.exec(line.trim());
    if (bullet === null) continue;
    const text = (bullet[1] ?? '').trim();
    if (text !== '') bullets.push(text);
  }
  return bullets;
}

function violatesNever(bullet: string, text: string): boolean {
  const needed = significantWords(bullet);
  // A one-word ban ("secrets") matches too much prose. Require two concrete words.
  if (needed.length < 2) return false;
  const haystack = wordSet(text);
  return needed.every((word) => haystack.has(word));
}

function finding(
  severity: DriftFinding['severity'],
  kind: DriftKind,
  message: string,
  decisionId?: string,
): DriftFinding {
  return {
    severity,
    kind,
    message,
    ...(decisionId !== undefined ? { decisionId } : {}),
  };
}

/**
 * Compare a piece of work with the vision and the active decisions.
 * A Never constraint match blocks. A decision that restates an active one without
 * `supersedes` is a note. Superseding an unknown id is a note.
 */
export function checkDrift(input: DriftInput): readonly DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const bullet of neverBullets(input.visionText)) {
    if (!violatesNever(bullet, input.text)) continue;
    findings.push(
      finding('block', 'never_constraint', `Work matches a Never constraint: ${bullet}`),
    );
  }

  const active = activeDecisions(input.decisions);
  const knownIds = new Set(input.decisions.map((record) => record.id));
  for (const proposed of input.proposedDecisions ?? []) {
    if (proposed.supersedes !== undefined && !knownIds.has(proposed.supersedes)) {
      findings.push(
        finding(
          'note',
          'unknown_supersede',
          `Decision supersedes unknown id ${proposed.supersedes}`,
          proposed.supersedes,
        ),
      );
    }
    const proposedWords = wordSet(proposed.text);
    for (const decision of active) {
      if (proposed.supersedes === decision.id) continue;
      const overlap = jaccard(proposedWords, wordSet(decision.text));
      if (overlap < DECISION_OVERLAP_THRESHOLD) continue;
      findings.push(
        finding(
          'note',
          'decision_overlap',
          `New decision overlaps active ${decision.id} without superseding it`,
          decision.id,
        ),
      );
    }
  }
  return findings;
}

export function hasBlockingDrift(findings: readonly DriftFinding[]): boolean {
  return findings.some((item) => item.severity === 'block');
}
