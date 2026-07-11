import { readFile, writeFile } from 'node:fs/promises';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  try {
    const contents = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(contents);
    return isRecord(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

async function writeVerifiedJson(path: string, value: unknown): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, contents, 'utf8');
  const written = await readFile(path, 'utf8');
  if (written !== contents) throw new Error(`write verification failed for ${path}`);
}

export async function updateBrainIndexResearchPaths(
  indexPath: string,
  paths: Readonly<Record<string, string>>,
): Promise<void> {
  const index = await readJsonRecord(indexPath);
  const researchPaths = isRecord(index.research_paths) ? index.research_paths : {};
  await writeVerifiedJson(indexPath, {
    ...index,
    research_paths: {
      ...researchPaths,
      ...paths,
    },
  });
}
