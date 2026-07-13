import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { auditSkillSource } from './skill-source-manager.js';

type CollectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface SkillCompatibility {
  readonly path: string;
  readonly compatible: boolean;
  readonly audit_status: 'clean' | 'approval-required' | null;
  readonly findings: readonly string[];
}

function git(checkoutDir: string, args: readonly string[]): CollectionResult<string> {
  const result = spawnSync('git', args, {
    cwd: checkoutDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  return result.status === 0
    ? { ok: true, value: result.stdout?.trim() ?? '' }
    : {
        ok: false,
        error: {
          code: 'SKILL_COLLECTION_GIT_FAILED',
          message: result.stderr?.trim() || 'Could not inspect skill collection Git state.',
        },
      };
}

export async function scanSkillCollection(options: {
  readonly checkoutDir: string;
}): Promise<
  CollectionResult<{
    readonly revision: string;
    readonly total: number;
    readonly compatible: number;
    readonly incompatible: number;
    readonly skills: readonly SkillCompatibility[];
  }>
> {
  const revision = git(options.checkoutDir, ['rev-parse', 'HEAD']);
  if (!revision.ok) return revision;
  const manifests = git(options.checkoutDir, ['ls-files', '--', ':(glob)**/SKILL.md']);
  if (!manifests.ok) return manifests;
  const paths = manifests.value === '' ? [] : manifests.value.split(/\r?\n/).sort();
  const skills: SkillCompatibility[] = [];
  for (const manifest of paths) {
    const skillPath = dirname(manifest).split('\\').join('/');
    const audited = await auditSkillSource({
      sourceDir: join(options.checkoutDir, dirname(manifest)),
    });
    skills.push(
      audited.ok
        ? {
            path: skillPath,
            compatible: true,
            audit_status: audited.value.status,
            findings: audited.value.findings.map((finding) => finding.code),
          }
        : {
            path: skillPath,
            compatible: false,
            audit_status: null,
            findings: [audited.error.code],
          },
    );
  }
  const compatible = skills.filter((skill) => skill.compatible).length;
  return {
    ok: true,
    value: {
      revision: revision.value,
      total: skills.length,
      compatible,
      incompatible: skills.length - compatible,
      skills,
    },
  };
}
