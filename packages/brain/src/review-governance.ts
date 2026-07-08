import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ReviewMissionComparisonData,
  type ReviewMissionContractLoad,
  compareReviewMissionContract,
} from './review-mission-contract.js';

export type ReviewDiffBasis = 'working_tree' | 'branch' | 'none';
export type ReviewGovernanceStatus = 'clean' | 'watch' | 'needs_attention';

export interface ReviewGitBasisData {
  readonly base_ref: string;
  readonly base_sha: string | null;
  readonly head_sha: string | null;
  readonly branch_name: string;
  readonly diff_basis: ReviewDiffBasis;
  readonly working_tree_dirty: boolean;
  readonly untracked_files: readonly string[];
  readonly branch_ahead: number;
  readonly branch_behind: number;
  readonly merge_base_found: boolean;
}

export interface ReviewGovernanceData {
  readonly status: ReviewGovernanceStatus;
  readonly score: number;
  readonly git: ReviewGitBasisData;
  readonly mission_contract: ReviewMissionComparisonData;
  readonly reviewable_changed_files: readonly string[];
  readonly generated_artifacts: readonly string[];
  readonly scope_clusters: readonly string[];
  readonly dominant_scope: string | null;
  readonly version_control_warnings: readonly string[];
  readonly scope_drift_signals: readonly string[];
  readonly duplicate_change_signals: readonly string[];
  readonly generated_artifact_noise: readonly string[];
  readonly agent_next_actions: readonly string[];
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderList(values: readonly string[]): string {
  if (values.length === 0) return '<p class="muted">None recorded.</p>';
  return `<ul>${values.map((value) => `<li>${htmlEscape(value)}</li>`).join('')}</ul>`;
}

export function renderReviewGovernance(governance: ReviewGovernanceData): string {
  return `<div class="grid">
    <article class="card"><h2>Governance</h2><p>${governance.score}/100 · ${htmlEscape(governance.status)}</p></article>
    <article class="card"><h2>Diff Basis</h2><p>${htmlEscape(governance.git.diff_basis)}</p></article>
    <article class="card"><h2>Mission Scope</h2><p>${governance.mission_contract.score}/100 · ${htmlEscape(governance.mission_contract.status)}</p></article>
    <article class="card"><h2>Scope Clusters</h2><p>${governance.scope_clusters.length}</p></article>
    <article class="card"><h2>Duplicate Signals</h2><p>${governance.duplicate_change_signals.length}</p></article>
  </div>
  <h3>Mission Contract</h3>
  ${renderList([
    `Source: ${governance.mission_contract.source}`,
    `Status: ${governance.mission_contract.status}`,
    ...(governance.mission_contract.contract_id === null
      ? []
      : [`Contract: ${governance.mission_contract.contract_id}`]),
    ...(governance.mission_contract.summary === null
      ? []
      : [`Summary: ${governance.mission_contract.summary}`]),
    ...(governance.mission_contract.contract_path === null
      ? []
      : [`Path: ${governance.mission_contract.contract_path}`]),
    ...(governance.mission_contract.compared_fields.length === 0
      ? ['Compared fields: none']
      : [`Compared fields: ${governance.mission_contract.compared_fields.join(', ')}`]),
    ...(governance.mission_contract.normalization_notes.length === 0
      ? []
      : [`Normalization: ${governance.mission_contract.normalization_notes.join(' ')}`]),
  ])}
  <h3>Mission Scope Signals</h3>
  ${renderList([
    ...governance.mission_contract.violating_paths.map((path) => `Out-of-mission path: ${path}`),
    ...governance.mission_contract.forbidden_paths.map((path) => `Forbidden path: ${path}`),
    ...governance.mission_contract.unexpected_scope_clusters.map(
      (cluster) => `Unexpected scope cluster: ${cluster}`,
    ),
    ...governance.mission_contract.generated_artifact_violations.map(
      (path) => `Generated artifact needs mission approval: ${path}`,
    ),
    ...governance.mission_contract.version_control_mismatches,
    ...governance.mission_contract.warnings,
    ...(governance.mission_contract.status === 'matched'
      ? ['Diff matches the deterministic mission contract boundaries.']
      : []),
  ])}
  <h3>Version-Control Warnings</h3>
  ${renderList(
    governance.version_control_warnings.length === 0
      ? ['No version-control hygiene warnings were detected.']
      : governance.version_control_warnings,
  )}
  <h3>Scope Drift</h3>
  ${renderList(
    governance.scope_drift_signals.length === 0
      ? ['No mission-scope drift signals were detected.']
      : governance.scope_drift_signals,
  )}
  <h3>Possible Duplication</h3>
  ${renderList(
    governance.duplicate_change_signals.length === 0
      ? ['No repeated changed-code signals were detected.']
      : governance.duplicate_change_signals,
  )}
  <h3>Agent Next Actions</h3>
  ${renderList(
    governance.agent_next_actions.length === 0
      ? ['No governance repair actions are required before human approval.']
      : governance.agent_next_actions,
  )}`;
}

export type ReviewGitChangesResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly changedFiles: readonly string[];
        readonly diffText: string;
        readonly git: ReviewGitBasisData;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface DiffFileChange {
  readonly addedLines: readonly string[];
  readonly deletedLines: readonly string[];
}

function boundedScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function runGit(
  rootDir: string,
  args: readonly string[],
): { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly error: string } {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8', maxBuffer: 5_000_000 });
  if (result.status === 0) return { ok: true, stdout: result.stdout };
  return { ok: false, error: result.stderr.trim() || result.stdout.trim() || 'git command failed' };
}

function changedPathsFromNameStatusLine(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];
  const parts = trimmed.split(/\t+/).filter((part) => part.trim() !== '');
  if (parts.length === 1) return [parts[0] ?? ''];
  const status = parts[0] ?? '';
  const paths = parts.slice(1);
  if (/^[RC]/.test(status)) return paths;
  return paths.slice(-1);
}

function parseAheadBehind(stdout: string): { readonly ahead: number; readonly behind: number } {
  const [aheadText, behindText] = stdout.trim().split(/\s+/);
  return {
    ahead: Number.parseInt(aheadText ?? '0', 10) || 0,
    behind: Number.parseInt(behindText ?? '0', 10) || 0,
  };
}

function gitBasis(params: {
  readonly rootDir: string;
  readonly baseRef: string;
  readonly diffBasis: ReviewDiffBasis;
  readonly baseSha: string | null;
  readonly untrackedFiles: readonly string[];
  readonly workingTreeDirty: boolean;
  readonly sanitizeText: (value: string) => string;
}): ReviewGitBasisData {
  const head = runGit(params.rootDir, ['rev-parse', 'HEAD']);
  const branch = runGit(params.rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const aheadBehind = runGit(params.rootDir, [
    'rev-list',
    '--left-right',
    '--count',
    `HEAD...${params.baseRef}`,
  ]);
  const counts = aheadBehind.ok ? parseAheadBehind(aheadBehind.stdout) : { ahead: 0, behind: 0 };
  return {
    base_ref: params.baseRef,
    base_sha: params.baseSha,
    head_sha: head.ok ? head.stdout.trim() : null,
    branch_name: branch.ok ? branch.stdout.trim() : 'unknown',
    diff_basis: params.diffBasis,
    working_tree_dirty: params.workingTreeDirty,
    untracked_files: params.untrackedFiles.map(params.sanitizeText),
    branch_ahead: counts.ahead,
    branch_behind: counts.behind,
    merge_base_found: params.baseSha !== null,
  };
}

function readUntrackedFileText(params: {
  readonly rootDir: string;
  readonly stdout: string;
  readonly shouldSkipPath: (path: string) => boolean;
}): string {
  const chunks: string[] = [];
  const files = params.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !params.shouldSkipPath(line));
  for (const file of files) {
    try {
      const absolutePath = join(params.rootDir, file);
      const fileStat = statSync(absolutePath);
      if (!fileStat.isFile() || fileStat.size > 1_000_000) continue;
      chunks.push(readFileSync(absolutePath, 'utf8'));
    } catch {}
  }
  return chunks.join('\n');
}

export function readReviewGitChanges(params: {
  readonly rootDir: string;
  readonly shouldSkipPath: (path: string) => boolean;
  readonly sanitizeText: (value: string) => string;
}): ReviewGitChangesResult {
  const baseRef = 'origin/develop';
  const inside = runGit(params.rootDir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return {
      ok: false,
      error: { code: 'GIT_REQUIRED', message: 'rizz review needs to run inside a git worktree.' },
    };
  }

  const worktreeFiles = runGit(params.rootDir, [
    'diff',
    '--name-status',
    '--find-renames',
    'HEAD',
    '--',
  ]);
  if (!worktreeFiles.ok) {
    return { ok: false, error: { code: 'GIT_DIFF_FAILED', message: worktreeFiles.error } };
  }
  const untrackedFiles = runGit(params.rootDir, ['ls-files', '--others', '--exclude-standard']);
  const untrackedFileList = untrackedFiles.ok
    ? untrackedFiles.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
    : [];
  const worktreeChanged = unique(
    [...worktreeFiles.stdout.split(/\r?\n/), ...untrackedFileList]
      .flatMap(changedPathsFromNameStatusLine)
      .filter((line) => line.trim() !== ''),
  );
  if (worktreeChanged.length > 0) {
    const diff = runGit(params.rootDir, ['diff', '--no-ext-diff', '--find-renames', 'HEAD', '--']);
    const base = runGit(params.rootDir, ['merge-base', 'HEAD', baseRef]);
    const untrackedDiffText = untrackedFiles.ok
      ? readUntrackedFileText({
          rootDir: params.rootDir,
          stdout: untrackedFiles.stdout,
          shouldSkipPath: params.shouldSkipPath,
        })
      : '';
    return {
      ok: true,
      value: {
        changedFiles: worktreeChanged,
        diffText: `${diff.ok ? diff.stdout : ''}\n${untrackedDiffText}`,
        git: gitBasis({
          rootDir: params.rootDir,
          baseRef,
          diffBasis: 'working_tree',
          baseSha: base.ok && base.stdout.trim() !== '' ? base.stdout.trim() : null,
          untrackedFiles: untrackedFileList,
          workingTreeDirty: true,
          sanitizeText: params.sanitizeText,
        }),
      },
    };
  }

  const base = runGit(params.rootDir, ['merge-base', 'HEAD', baseRef]);
  if (base.ok && base.stdout.trim() !== '') {
    const baseSha = base.stdout.trim();
    const branchFiles = runGit(params.rootDir, [
      'diff',
      '--name-status',
      '--find-renames',
      baseSha,
      'HEAD',
      '--',
    ]);
    if (!branchFiles.ok) {
      return { ok: false, error: { code: 'GIT_DIFF_FAILED', message: branchFiles.error } };
    }
    const branchChanged = unique(
      branchFiles.stdout
        .split(/\r?\n/)
        .flatMap(changedPathsFromNameStatusLine)
        .filter((line) => line.trim() !== ''),
    );
    const diff = runGit(params.rootDir, [
      'diff',
      '--no-ext-diff',
      '--find-renames',
      baseSha,
      'HEAD',
      '--',
    ]);
    return {
      ok: true,
      value: {
        changedFiles: branchChanged,
        diffText: diff.ok ? diff.stdout : '',
        git: gitBasis({
          rootDir: params.rootDir,
          baseRef,
          diffBasis: branchChanged.length > 0 ? 'branch' : 'none',
          baseSha,
          untrackedFiles: [],
          workingTreeDirty: false,
          sanitizeText: params.sanitizeText,
        }),
      },
    };
  }

  return {
    ok: true,
    value: {
      changedFiles: [],
      diffText: '',
      git: gitBasis({
        rootDir: params.rootDir,
        baseRef,
        diffBasis: 'none',
        baseSha: null,
        untrackedFiles: [],
        workingTreeDirty: false,
        sanitizeText: params.sanitizeText,
      }),
    },
  };
}

function reviewScopeCluster(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length <= 1) return 'root';
  if (parts[0] === 'packages' || parts[0] === 'apps') return `${parts[0]}/${parts[1]}`;
  if (parts[0] === '.github') return '.github';
  return parts[0] ?? 'root';
}

function changedCodeLines(change: DiffFileChange): string[] {
  return [...change.addedLines, ...change.deletedLines].filter((line) => {
    const trimmed = line.trim();
    if (trimmed === '') return false;
    return !/^(\/\/|#|\/\*|\*|\*\/|<!--|--)/.test(trimmed);
  });
}

function parseDiffFileChanges(diffText: string): Map<string, DiffFileChange> {
  const changes = new Map<string, DiffFileChange>();
  let current:
    | { oldPath: string; newPath: string; addedLines: string[]; deletedLines: string[] }
    | undefined;
  const commitCurrent = (): void => {
    if (current === undefined) return;
    const value = { addedLines: current.addedLines, deletedLines: current.deletedLines };
    changes.set(current.newPath, value);
    changes.set(current.oldPath, value);
  };
  for (const line of diffText.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header !== null) {
      commitCurrent();
      current = {
        oldPath: header[1] ?? '',
        newPath: header[2] ?? '',
        addedLines: [],
        deletedLines: [],
      };
      continue;
    }
    if (current === undefined || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) current.addedLines.push(line.slice(1));
    if (line.startsWith('-')) current.deletedLines.push(line.slice(1));
  }
  commitCurrent();
  return changes;
}

function scopeDriftSignals(params: {
  readonly changedFiles: readonly string[];
  readonly clusters: readonly string[];
  readonly isSourceFile: (path: string) => boolean;
  readonly isConfigPath: (path: string) => boolean;
  readonly isDependencyPath: (path: string) => boolean;
  readonly sanitizeText: (value: string) => string;
}): string[] {
  const signals: string[] = [];
  const hasSource = params.changedFiles.some(params.isSourceFile);
  const hasDocs = params.changedFiles.some((file) => /\.(md|mdx|txt|rst)$/i.test(file));
  const hasConfig = params.changedFiles.some(
    (file) => params.isConfigPath(file) || params.isDependencyPath(file),
  );
  if (params.clusters.length > 3) {
    signals.push(
      `${params.clusters.length} scope clusters changed: ${params.clusters.slice(0, 6).join(', ')}.`,
    );
  }
  if (hasSource && hasDocs && hasConfig) {
    signals.push(
      'Source, docs, and config/package files changed together; confirm one mission owns all of them.',
    );
  } else if (hasSource && hasDocs) {
    signals.push('Source and docs changed together; confirm docs are tied to the behavior.');
  } else if (hasSource && hasConfig) {
    signals.push(
      'Source and config/package files changed together; confirm the runtime change requires the config movement.',
    );
  }
  return signals.map(params.sanitizeText);
}

function duplicateChangeSignals(params: {
  readonly diffText: string;
  readonly sanitizeText: (value: string) => string;
}): string[] {
  const repeated = new Map<string, Set<string>>();
  for (const [path, change] of parseDiffFileChanges(params.diffText)) {
    for (const line of unique(changedCodeLines(change).map((item) => item.trim()))) {
      if (line.length < 18 || /^[{}[\](),.;]+$/.test(line)) continue;
      const files = repeated.get(line) ?? new Set<string>();
      files.add(path);
      repeated.set(line, files);
    }
  }
  const repeatedLineSignals = [...repeated.entries()]
    .filter(([, files]) => files.size > 1)
    .slice(0, 5)
    .map(([line, files]) =>
      params.sanitizeText(
        `Repeated changed line across ${files.size} file(s): ${[...files]
          .slice(0, 4)
          .join(', ')} :: ${line.slice(0, 120)}`,
      ),
    );
  return unique([...repeatedLineSignals, ...duplicateBlockSignals(params)]).slice(0, 6);
}

const DUPLICATE_NORMALIZED_KEYWORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'else',
  'export',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'let',
  'new',
  'null',
  'return',
  'switch',
  'throw',
  'true',
  'try',
  'undefined',
  'while',
]);

interface DuplicateBlockCandidate {
  readonly path: string;
  readonly normalized: string;
  readonly preview: string;
  readonly lineCount: number;
}

function isDuplicateBlockStart(line: string): boolean {
  return (
    /^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/.test(line.trim()) ||
    /^(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/.test(line.trim())
  );
}

function braceDelta(line: string): number {
  return (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
}

function normalizeDuplicateCodeBlock(lines: readonly string[]): string {
  return lines
    .join('\n')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, 'STR')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'NUM')
    .replace(/\b[A-Za-z_$][\w$]*\b/g, (word) =>
      DUPLICATE_NORMALIZED_KEYWORDS.has(word) ? word : 'ID',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function duplicateBlockCandidates(path: string, change: DiffFileChange): DuplicateBlockCandidate[] {
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php)$/i.test(path)) return [];
  const candidates: DuplicateBlockCandidate[] = [];
  for (let index = 0; index < change.addedLines.length; index += 1) {
    const firstLine = change.addedLines[index] ?? '';
    if (!isDuplicateBlockStart(firstLine)) continue;
    const block: string[] = [];
    let balance = 0;
    let sawBrace = false;
    for (let lineIndex = index; lineIndex < change.addedLines.length; lineIndex += 1) {
      const line = change.addedLines[lineIndex] ?? '';
      block.push(line);
      balance += braceDelta(line);
      sawBrace = sawBrace || line.includes('{');
      if ((sawBrace && balance <= 0) || block.length >= 80) {
        index = lineIndex;
        break;
      }
    }
    const normalized = normalizeDuplicateCodeBlock(block);
    if (normalized.length < 80 || !/\breturn\b|\bif\b|\bawait\b|\bthrow\b|=>/.test(normalized)) {
      continue;
    }
    candidates.push({
      path,
      normalized,
      preview: block.join(' ').trim().slice(0, 140),
      lineCount: block.length,
    });
  }
  return candidates;
}

function duplicateBlockSignals(params: {
  readonly diffText: string;
  readonly sanitizeText: (value: string) => string;
}): string[] {
  const grouped = new Map<string, DuplicateBlockCandidate[]>();
  for (const [path, change] of parseDiffFileChanges(params.diffText)) {
    for (const candidate of duplicateBlockCandidates(path, change)) {
      const candidates = grouped.get(candidate.normalized) ?? [];
      candidates.push(candidate);
      grouped.set(candidate.normalized, candidates);
    }
  }
  return [...grouped.values()]
    .filter((candidates) => new Set(candidates.map((candidate) => candidate.path)).size > 1)
    .sort((a, b) => b.length - a.length || (b[0]?.lineCount ?? 0) - (a[0]?.lineCount ?? 0))
    .slice(0, 3)
    .map((candidates) =>
      params.sanitizeText(
        `Repeated normalized function block across ${
          new Set(candidates.map((candidate) => candidate.path)).size
        } file(s): ${unique(candidates.map((candidate) => candidate.path))
          .slice(0, 4)
          .join(', ')} :: ${candidates[0]?.preview ?? ''}`,
      ),
    );
}

export function buildReviewGovernance(params: {
  readonly git: ReviewGitBasisData;
  readonly changedFiles: readonly string[];
  readonly reviewableChangedFiles: readonly string[];
  readonly generatedArtifacts: readonly string[];
  readonly diffText: string;
  readonly missionContract: ReviewMissionContractLoad;
  readonly affectedComponentIds: readonly string[];
  readonly affectedServiceIds: readonly string[];
  readonly affectedFlowIds: readonly string[];
  readonly isSourceFile: (path: string) => boolean;
  readonly isConfigPath: (path: string) => boolean;
  readonly isDependencyPath: (path: string) => boolean;
  readonly sanitizeText: (value: string) => string;
}): ReviewGovernanceData {
  const scopeClusters = unique(params.reviewableChangedFiles.map(reviewScopeCluster));
  const versionControlWarnings = [
    ...(params.git.working_tree_dirty
      ? [
          'Review is based on working-tree changes; commit or stash unrelated edits before PR approval.',
        ]
      : []),
    ...(params.git.branch_behind > 0
      ? [
          `Branch is ${params.git.branch_behind} commit(s) behind ${params.git.base_ref}; rebase or merge before final approval.`,
        ]
      : []),
    ...(params.git.diff_basis === 'none'
      ? ['No branch or working-tree diff was detected for review.']
      : []),
    ...(!params.git.merge_base_found
      ? [
          `Could not resolve merge base against ${params.git.base_ref}; review scope may be incomplete.`,
        ]
      : []),
    ...(params.git.untracked_files.length > 0
      ? [`${params.git.untracked_files.length} untracked file(s) are included in review scope.`]
      : []),
    ...(params.git.branch_name.startsWith('codex/')
      ? ['Branch name uses codex/ prefix; use feature/*, fix/*, or release/* for rizz-owned work.']
      : []),
  ].map(params.sanitizeText);
  const generatedArtifactNoise =
    params.generatedArtifacts.length > 0
      ? [
          params.sanitizeText(
            `${params.generatedArtifacts.length} generated/vendor artifact(s) changed; verify the source generator or lockfile, not only the artifact output.`,
          ),
        ]
      : [];
  const scopeSignals = scopeDriftSignals({ ...params, clusters: scopeClusters });
  const duplicateSignals = duplicateChangeSignals(params);
  const missionComparison = compareReviewMissionContract({
    mission: params.missionContract,
    baseRef: params.git.base_ref,
    changedFiles: params.changedFiles,
    reviewableChangedFiles: params.reviewableChangedFiles,
    generatedArtifacts: params.generatedArtifacts,
    scopeClusters,
    affectedComponentIds: params.affectedComponentIds,
    affectedServiceIds: params.affectedServiceIds,
    affectedFlowIds: params.affectedFlowIds,
    sanitizeText: params.sanitizeText,
  });
  const missionSignals =
    missionComparison.status === 'mismatch' || missionComparison.status === 'insufficient' ? 1 : 0;
  const missionScopeSignals =
    missionComparison.status === 'mismatch'
      ? missionComparison.agent_next_actions.map((action) =>
          params.sanitizeText(`Mission contract: ${action}`),
        )
      : [];
  const allScopeSignals = unique([...scopeSignals, ...missionScopeSignals]);
  const issueCount =
    versionControlWarnings.length +
    allScopeSignals.length +
    duplicateSignals.length +
    generatedArtifactNoise.length +
    missionSignals;
  const status: ReviewGovernanceStatus =
    versionControlWarnings.length > 0 ||
    missionComparison.status === 'mismatch' ||
    allScopeSignals.length > 1 ||
    duplicateSignals.length > 1
      ? 'needs_attention'
      : issueCount > 0
        ? 'watch'
        : 'clean';
  return {
    status,
    score: boundedScore(100 - Math.min(70, issueCount * 12)),
    git: params.git,
    mission_contract: missionComparison,
    reviewable_changed_files: params.reviewableChangedFiles.map(params.sanitizeText),
    generated_artifacts: params.generatedArtifacts.map(params.sanitizeText),
    scope_clusters: scopeClusters.map(params.sanitizeText),
    dominant_scope:
      scopeClusters.length === 1 ? params.sanitizeText(scopeClusters[0] ?? 'root') : null,
    version_control_warnings: versionControlWarnings,
    scope_drift_signals: allScopeSignals,
    duplicate_change_signals: duplicateSignals,
    generated_artifact_noise: generatedArtifactNoise,
    agent_next_actions: unique([
      ...versionControlWarnings.map((warning) => `Resolve version-control hygiene: ${warning}`),
      ...allScopeSignals.map((signal) => `Confirm mission scope: ${signal}`),
      ...missionComparison.agent_next_actions,
      ...duplicateSignals.map((signal) => `Inspect possible duplication: ${signal}`),
      ...generatedArtifactNoise.map((signal) => `Confirm generated artifact source: ${signal}`),
    ]).slice(0, 8),
  };
}
