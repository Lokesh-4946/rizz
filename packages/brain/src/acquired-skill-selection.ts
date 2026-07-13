import { resolveAcquiredSkill } from './skill-discovery-index.js';
import {
  type PinnedSkillProvenance,
  type SkillFinding,
  addPinnedSkill,
  inspectPinnedSkillCandidate,
} from './skill-source-manager.js';

interface SelectionOptions {
  readonly rizzHome: string;
  readonly sourceId: string;
  readonly revision: string;
  readonly skillPath: string;
}

type SelectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface AcquiredSkillPreview {
  readonly name: string;
  readonly description: string;
  readonly source_id: string;
  readonly skill_path: string;
  readonly source_repository: string;
  readonly revision: string;
  readonly digest: string;
  readonly file_digest: string;
  readonly license: string;
  readonly attribution: string;
  readonly audit_status: 'clean' | 'approval-required';
  readonly audit_findings: readonly SkillFinding[];
  readonly requirements: {
    readonly shell: boolean;
    readonly network: boolean;
    readonly credentials: boolean;
  };
  readonly supported_agents: readonly string[];
  readonly approval_required: true;
  readonly writes_repository: false;
  readonly executes_content: false;
}

interface ResolvedCandidate {
  readonly preview: AcquiredSkillPreview;
  readonly sourceDir: string;
}

function staleSelection(message: string): SelectionResult<never> {
  return { ok: false, error: { code: 'SKILL_SELECTION_STALE', message } };
}

async function resolveCandidate(
  options: SelectionOptions,
): Promise<SelectionResult<ResolvedCandidate>> {
  const selected = await resolveAcquiredSkill(options);
  if (!selected.ok) return selected;
  const audited = await inspectPinnedSkillCandidate({
    sourceDir: selected.value.source_dir,
    revision: options.revision,
  });
  if (!audited.ok) return audited;
  if (
    audited.value.name !== selected.value.skill.name ||
    audited.value.digest !== selected.value.skill.digest ||
    audited.value.source_repository !== selected.value.skill.source_repository
  )
    return staleSelection('Selected skill no longer matches its discovery evidence.');
  const fileDigest = audited.value.files.find((file) => file.path === 'SKILL.md')?.digest;
  if (fileDigest === undefined)
    return staleSelection('Selected skill manifest digest is unavailable.');
  return {
    ok: true,
    value: {
      sourceDir: selected.value.source_dir,
      preview: {
        name: selected.value.skill.name,
        description: selected.value.skill.description,
        source_id: selected.value.skill.source_id,
        skill_path: selected.value.skill.relative_path,
        source_repository: selected.value.skill.source_repository,
        revision: selected.value.skill.revision,
        digest: selected.value.skill.digest,
        file_digest: fileDigest,
        license: selected.value.skill.license,
        attribution: selected.value.skill.attribution,
        audit_status: selected.value.skill.audit_status,
        audit_findings: selected.value.skill.audit_findings,
        requirements: selected.value.skill.requirements,
        supported_agents: selected.value.skill.supported_agents,
        approval_required: true,
        writes_repository: false,
        executes_content: false,
      },
    },
  };
}

export async function previewAcquiredSkill(
  options: SelectionOptions,
): Promise<SelectionResult<AcquiredSkillPreview>> {
  const candidate = await resolveCandidate(options);
  return candidate.ok ? { ok: true, value: candidate.value.preview } : candidate;
}

export async function pinAcquiredSkill(
  options: SelectionOptions & { readonly approved: boolean },
): Promise<
  SelectionResult<
    AcquiredSkillPreview & {
      readonly cache_dir: string;
      readonly immutable_object: string;
    }
  >
> {
  if (!options.approved)
    return {
      ok: false,
      error: {
        code: 'SKILL_APPROVAL_REQUIRED',
        message: 'Pinning an acquired skill requires explicit approval.',
      },
    };
  const candidate = await resolveCandidate(options);
  if (!candidate.ok) return candidate;
  const preview = candidate.value.preview;
  const provenance: PinnedSkillProvenance = {
    source_id: preview.source_id,
    skill_path: preview.skill_path,
    source_repository: preview.source_repository,
    revision: preview.revision,
    digest: preview.digest,
    file_digest: preview.file_digest,
    license: preview.license,
    attribution: preview.attribution,
    audit_status: preview.audit_status,
    audit_findings: preview.audit_findings,
    requirements: preview.requirements,
    supported_agents: preview.supported_agents,
  };
  const pinned = await addPinnedSkill({
    sourceDir: candidate.value.sourceDir,
    rizzHome: options.rizzHome,
    revision: options.revision,
    approved: true,
    provenance,
    rejectNameConflict: true,
  });
  if (!pinned.ok) return pinned;
  return {
    ok: true,
    value: {
      ...preview,
      cache_dir: pinned.value.cache_dir,
      immutable_object: pinned.value.digest,
    },
  };
}
