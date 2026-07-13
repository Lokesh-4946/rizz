import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type PinnedSkillRecord, verifyPinnedSkillCache } from './skill-source-manager.js';

type DoctorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface DoctorFinding {
  readonly code: 'SKILL_CACHE_MISSING' | 'SKILL_CACHE_TAMPERED' | 'SKILL_CACHE_ORPHANED';
  readonly path: string;
  readonly repairable: boolean;
}

function registrySkills(value: unknown): Readonly<Record<string, PinnedSkillRecord>> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('schema_version' in value) ||
    value.schema_version !== 1 ||
    !('skills' in value) ||
    typeof value.skills !== 'object' ||
    value.skills === null ||
    Array.isArray(value.skills)
  )
    throw Object.assign(new Error('Skill registry schema is invalid.'), {
      code: 'SKILL_REGISTRY_INVALID',
    });
  return value.skills as Readonly<Record<string, PinnedSkillRecord>>;
}

async function directories(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function doctorSkillRegistry(options: {
  readonly rizzHome: string;
  readonly repair?: boolean;
  readonly approved?: boolean;
}): Promise<
  DoctorResult<{
    readonly healthy: boolean;
    readonly repaired: boolean;
    readonly findings: readonly DoctorFinding[];
  }>
> {
  if (options.repair === true && options.approved !== true)
    return {
      ok: false,
      error: {
        code: 'SKILL_REPAIR_APPROVAL_REQUIRED',
        message: 'Skill repair requires explicit approval.',
      },
    };
  try {
    const base = join(options.rizzHome, 'global', 'skills');
    const cache = join(base, 'cache');
    let records: Readonly<Record<string, PinnedSkillRecord>> = {};
    try {
      records = registrySkills(JSON.parse(await readFile(join(base, 'registry.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const findings: DoctorFinding[] = [];
    const referenced = new Set(Object.values(records).map((record) => record.cache_dir));
    for (const record of Object.values(records)) {
      const verified = await verifyPinnedSkillCache({ record });
      if (!verified.ok)
        findings.push({
          code: verified.error.code === 'ENOENT' ? 'SKILL_CACHE_MISSING' : 'SKILL_CACHE_TAMPERED',
          path: record.cache_dir,
          repairable: false,
        });
    }
    for (const directory of await directories(cache)) {
      if (!referenced.has(directory))
        findings.push({
          code: 'SKILL_CACHE_ORPHANED',
          path: directory,
          repairable: !/^[a-f0-9]{64}$/.test(basename(directory)),
        });
    }
    let repaired = false;
    if (options.repair === true) {
      const quarantine = join(base, 'quarantine');
      for (const finding of findings) {
        if (!finding.repairable) continue;
        await mkdir(quarantine, { recursive: true });
        await rename(finding.path, join(quarantine, `${basename(finding.path)}-${Date.now()}`));
        repaired = true;
      }
    }
    const remaining =
      options.repair === true ? findings.filter((finding) => !finding.repairable) : findings;
    return { ok: true, value: { healthy: remaining.length === 0, repaired, findings } };
  } catch (error) {
    return {
      ok: false,
      error: {
        code:
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'SKILL_DOCTOR_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
