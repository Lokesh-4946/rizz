export const VISION_TEMPLATE = `# Project vision

Say what this project is and what done looks like. The host agent reads the short index.
Edit this file yourself. Rizz does not overwrite it.

## Must
- keep changes local to this repository

## Never
- commit secrets or credentials
`;

export interface VisionConstraints {
  readonly must: readonly string[];
  readonly never: readonly string[];
}

function headingName(line: string): string | undefined {
  const match = /^##\s+(.+)$/.exec(line.trim());
  if (match === null) return undefined;
  return (match[1] ?? '').trim().toLowerCase();
}

function bulletText(line: string): string | undefined {
  const match = /^[-*]\s+(.+)$/.exec(line.trim());
  if (match === null) return undefined;
  const text = (match[1] ?? '').trim();
  return text === '' ? undefined : text;
}

/** Pull `## Must` and `## Never` bullets out of the vision markdown. Other sections are prose. */
export function parseVisionConstraints(markdown: string): VisionConstraints {
  const must: string[] = [];
  const never: string[] = [];
  let section: 'must' | 'never' | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = headingName(line);
    if (heading !== undefined) {
      if (heading === 'must') section = 'must';
      else if (heading === 'never') section = 'never';
      else section = undefined;
      continue;
    }
    if (section === undefined) continue;
    const bullet = bulletText(line);
    if (bullet === undefined) continue;
    if (section === 'must') must.push(bullet);
    else never.push(bullet);
  }
  return { must, never };
}
