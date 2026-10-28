import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isBrainEntity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string' &&
    (value.confidence === 'verified' ||
      value.confidence === 'inferred' ||
      value.confidence === 'uncertain') &&
    Array.isArray(value.evidence_ids) &&
    Array.isArray(value.related_entity_ids) &&
    Array.isArray(value.source_files) &&
    typeof value.latest_status === 'string'
  );
}

export async function validateBrainSchema(brainDir: string): Promise<string[]> {
  const entitiesDir = join(brainDir, 'entities');
  const errors: string[] = [];
  const latest = await readJson(join(brainDir, 'latest.json'));
  if (!isRecord(latest)) errors.push('latest.json must be an object');
  else {
    if (typeof latest.generated_at !== 'string') errors.push('latest.json missing generated_at');
    if (!Array.isArray(latest.latest_component_map)) {
      errors.push('latest.json missing latest_component_map array');
    }
    if (!Array.isArray(latest.latest_flow_map)) {
      errors.push('latest.json missing latest_flow_map array');
    }
  }

  const graph = await readJson(join(brainDir, 'graph.json'));
  if (!isRecord(graph) || !Array.isArray(graph.relationships)) {
    errors.push('graph.json missing relationships array');
  } else {
    for (const [index, relationship] of graph.relationships.entries()) {
      if (
        !isRecord(relationship) ||
        typeof relationship.from !== 'string' ||
        typeof relationship.to !== 'string'
      ) {
        errors.push(`graph.json relationship ${index} is invalid`);
        break;
      }
    }
  }

  const flowIndex = await readJson(join(brainDir, 'flows', 'index.json'));
  if (!isRecord(flowIndex) || !Array.isArray(flowIndex.flows)) {
    errors.push('flows/index.json missing flows array');
  }

  for (const fileName of ['components.json', 'files.json', 'folders.json', 'flows.json']) {
    const path = join(entitiesDir, fileName);
    if (!(await exists(path))) {
      errors.push(`${fileName} missing entities array`);
      continue;
    }
    const file = await readJson(path);
    if (!isRecord(file) || !Array.isArray(file.entities)) {
      errors.push(`${fileName} missing entities array`);
      continue;
    }
    const invalidIndex = file.entities.findIndex((entity) => !isBrainEntity(entity));
    if (invalidIndex >= 0) errors.push(`${fileName} entity ${invalidIndex} is invalid`);
  }

  for (const fileName of ['evidence.json', 'reviews.json']) {
    const path = join(entitiesDir, fileName);
    if (!(await exists(path))) continue;
    const file = await readJson(path);
    if (!isRecord(file) || !Array.isArray(file.entities)) {
      errors.push(`${fileName} missing entities array`);
      continue;
    }
    const invalidIndex = file.entities.findIndex((entity) => !isBrainEntity(entity));
    if (invalidIndex >= 0) errors.push(`${fileName} entity ${invalidIndex} is invalid`);
  }
  return errors;
}
