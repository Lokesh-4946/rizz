#!/usr/bin/env node
// rizz eval harness. Runs local deterministic smoke checks plus the PI-Bench seed tasks against
// rizz brain research artifacts. The PI-Bench seed stays provider-free and network-free.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(evalDir);
const tasksDir = join(evalDir, 'tasks');
const cliBin = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const installLocalScript = join(repoRoot, 'scripts', 'install-local.mjs');
const EVAL_LOCAL_PACKAGES = ['brain', 'providers', 'core', 'tui', 'cli'];
const PI_BENCH_TASK_SCHEMA_VERSION = 2;
const PI_BENCH_TASK_SUITE = 'pi-bench-seed';
const PI_BENCH_TASK_MODE = 'local';
const COVERAGE_TARGETS = ['component', 'flow', 'evidence', 'unknown'];
const PI_BENCH_TASK_CATEGORIES = [
  'smoke',
  'research-metrics',
  'incremental-understanding',
  'unknown-coverage',
  'architecture-flow',
  'review-blast-radius',
];

if (!ensureEvalBuild()) process.exit(1);

/** Load every *.task.json under eval/tasks. */
function loadTasks() {
  return readdirSync(tasksDir)
    .filter((f) => f.endsWith('.task.json'))
    .map((f) => JSON.parse(readFileSync(join(tasksDir, f), 'utf8')));
}

const tasks = loadTasks();
const piBenchResult = runPiBenchTasks(tasks);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function hasNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasRatioNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isSafeRelativePath(value) {
  if (!isNonEmptyString(value)) return false;
  if (value.includes('\0') || isAbsolute(value)) return false;
  const parts = value.split(/[\\/]/);
  return !parts.includes('..');
}

function validateFixture(fixture) {
  const errors = [];
  if (!isRecord(fixture)) return ['fixture must be an object'];
  if (!isSafeRelativePath(fixture.root)) {
    errors.push('fixture.root must be a safe relative path');
  }
  if (!Array.isArray(fixture.files) || fixture.files.length === 0) {
    errors.push('fixture.files must include at least one file');
  } else {
    for (const [index, file] of fixture.files.entries()) {
      if (!isRecord(file)) {
        errors.push(`fixture.files[${index}] must be an object`);
        continue;
      }
      if (!isSafeRelativePath(file.path)) {
        errors.push(`fixture.files[${index}].path must be a safe relative path`);
      }
      if (typeof file.contents !== 'string') {
        errors.push(`fixture.files[${index}].contents must be a string`);
      }
    }
  }
  return errors;
}

function validateCoverageTargets(targets) {
  const errors = [];
  if (!isRecord(targets)) return ['coverage_targets must be an object'];
  for (const key of COVERAGE_TARGETS) {
    const target = targets[key];
    if (!isRecord(target)) {
      errors.push(`coverage_targets.${key} must be an object`);
      continue;
    }
    if (!hasNonNegativeNumber(target.minimum_total)) {
      errors.push(`coverage_targets.${key}.minimum_total must be a non-negative number`);
    }
    if (!hasNonNegativeNumber(target.minimum_covered)) {
      errors.push(`coverage_targets.${key}.minimum_covered must be a non-negative number`);
    }
    if (!hasRatioNumber(target.minimum_ratio)) {
      errors.push(`coverage_targets.${key}.minimum_ratio must be a number between 0 and 1`);
    }
  }
  return errors;
}

function validateArtifactAssertions(assertions) {
  const errors = [];
  if (!Array.isArray(assertions) || assertions.length === 0) {
    return ['artifact_assertions must include at least one assertion'];
  }
  for (const [index, assertion] of assertions.entries()) {
    if (!isRecord(assertion)) {
      errors.push(`artifact_assertions[${index}] must be an object`);
      continue;
    }
    if (!isSafeRelativePath(assertion.path)) {
      errors.push(`artifact_assertions[${index}].path must be a safe relative path`);
    }
    if (assertion.type !== 'json' && assertion.type !== 'file') {
      errors.push(`artifact_assertions[${index}].type must be json or file`);
    }
    if (
      assertion.required_fields !== undefined &&
      (!isStringArray(assertion.required_fields) || assertion.required_fields.length === 0)
    ) {
      errors.push(`artifact_assertions[${index}].required_fields must include strings`);
    }
    if (
      assertion.required_substrings !== undefined &&
      (!isStringArray(assertion.required_substrings) || assertion.required_substrings.length === 0)
    ) {
      errors.push(`artifact_assertions[${index}].required_substrings must include strings`);
    }
    if (
      assertion.forbidden_substrings !== undefined &&
      (!isStringArray(assertion.forbidden_substrings) ||
        assertion.forbidden_substrings.length === 0)
    ) {
      errors.push(`artifact_assertions[${index}].forbidden_substrings must include strings`);
    }
  }
  return errors;
}

function validateReviewDiff(diff) {
  const errors = [];
  if (!isRecord(diff)) return ['review.diff must be an object'];
  if (!Array.isArray(diff.files) || diff.files.length === 0) {
    errors.push('review.diff.files must include at least one file');
  } else {
    for (const [index, file] of diff.files.entries()) {
      if (!isRecord(file)) {
        errors.push(`review.diff.files[${index}] must be an object`);
        continue;
      }
      if (!isSafeRelativePath(file.path)) {
        errors.push(`review.diff.files[${index}].path must be a safe relative path`);
      }
      if (typeof file.contents !== 'string') {
        errors.push(`review.diff.files[${index}].contents must be a string`);
      }
    }
  }
  return errors;
}

function validateIncrementalDiff(diff) {
  const errors = [];
  if (!isRecord(diff)) return ['incremental.diff must be an object'];
  if (!Array.isArray(diff.files) || diff.files.length === 0) {
    errors.push('incremental.diff.files must include at least one file');
  } else {
    for (const [index, file] of diff.files.entries()) {
      if (!isRecord(file)) {
        errors.push(`incremental.diff.files[${index}] must be an object`);
        continue;
      }
      if (!isSafeRelativePath(file.path)) {
        errors.push(`incremental.diff.files[${index}].path must be a safe relative path`);
      }
      if (typeof file.contents !== 'string') {
        errors.push(`incremental.diff.files[${index}].contents must be a string`);
      }
    }
  }
  return errors;
}

function validateOptionalStringArray(assertions, field, errors) {
  if (
    assertions[field] !== undefined &&
    (!isStringArray(assertions[field]) || assertions[field].length === 0)
  ) {
    errors.push(`review.assertions.${field} must include strings`);
  }
}

function validateReviewAssertions(assertions) {
  const errors = [];
  if (!isRecord(assertions)) return ['review.assertions must be an object'];
  for (const field of [
    'changed_files_include',
    'changed_files_exclude',
    'direct_components_include',
    'dependent_components_include',
    'affected_flows_include',
    'affected_tests_include',
    'affected_configs_include',
    'required_tests_include',
    'blast_radius_reasons_include',
    'forbidden_output_substrings',
  ]) {
    validateOptionalStringArray(assertions, field, errors);
  }
  for (const field of [
    'minimum_direct_components',
    'minimum_dependent_components',
    'minimum_affected_flows',
    'minimum_affected_relationships',
  ]) {
    if (assertions[field] !== undefined && !hasNonNegativeNumber(assertions[field])) {
      errors.push(`review.assertions.${field} must be a non-negative number`);
    }
  }
  if (
    assertions.blast_radius !== undefined &&
    !['narrow', 'moderate', 'broad'].includes(assertions.blast_radius)
  ) {
    errors.push('review.assertions.blast_radius must be narrow, moderate, or broad');
  }
  if (assertions.findings_include !== undefined) {
    if (!Array.isArray(assertions.findings_include) || assertions.findings_include.length === 0) {
      errors.push('review.assertions.findings_include must include objects');
    } else {
      for (const [index, finding] of assertions.findings_include.entries()) {
        if (!isRecord(finding)) {
          errors.push(`review.assertions.findings_include[${index}] must be an object`);
          continue;
        }
        if (!isNonEmptyString(finding.category) && !isNonEmptyString(finding.title_includes)) {
          errors.push(
            `review.assertions.findings_include[${index}] must include category or title_includes`,
          );
        }
      }
    }
  }
  if (assertions.route_flows_include !== undefined) {
    if (
      !Array.isArray(assertions.route_flows_include) ||
      assertions.route_flows_include.length === 0
    ) {
      errors.push('review.assertions.route_flows_include must include objects');
    } else {
      for (const [index, flow] of assertions.route_flows_include.entries()) {
        if (!isRecord(flow)) {
          errors.push(`review.assertions.route_flows_include[${index}] must be an object`);
          continue;
        }
        for (const field of ['id', 'framework', 'route_path', 'route_type']) {
          if (flow[field] !== undefined && !isNonEmptyString(flow[field])) {
            errors.push(
              `review.assertions.route_flows_include[${index}].${field} must be a non-empty string`,
            );
          }
        }
        for (const field of [
          'entrypoints_include',
          'changed_files_include',
          'tests_include',
          'configs_include',
        ]) {
          if (
            flow[field] !== undefined &&
            (!isStringArray(flow[field]) || flow[field].length === 0)
          ) {
            errors.push(
              `review.assertions.route_flows_include[${index}].${field} must include strings`,
            );
          }
        }
      }
    }
  }
  return errors;
}

function validateIncrementalAssertions(assertions) {
  const errors = [];
  if (!isRecord(assertions)) return ['incremental.assertions must be an object'];
  for (const field of [
    'changed_files_include',
    'changed_files_exclude',
    'evidence_delta_changed_include',
    'changed_entities_include',
    'forbidden_output_substrings',
  ]) {
    validateOptionalStringArray(assertions, field, errors);
  }
  for (const field of [
    'expected_changed_file_count',
    'expected_stale_file_count',
    'expected_reused_files',
    'expected_recomputed_files',
    'expected_redacted_changed_file_count',
    'minimum_changed_entity_count',
    'minimum_stable_entity_count',
    'minimum_reused_understanding_count',
    'minimum_recomputed_understanding_count',
    'minimum_scan_efficiency_score',
  ]) {
    if (assertions[field] !== undefined && !hasNonNegativeNumber(assertions[field])) {
      errors.push(`incremental.assertions.${field} must be a non-negative number`);
    }
  }
  if (
    assertions.expected_file_reuse_ratio !== undefined &&
    !hasRatioNumber(assertions.expected_file_reuse_ratio)
  ) {
    errors.push(
      'incremental.assertions.expected_file_reuse_ratio must be a number between 0 and 1',
    );
  }
  for (const field of ['require_previous_fingerprint', 'require_fingerprint_changed']) {
    if (assertions[field] !== undefined && typeof assertions[field] !== 'boolean') {
      errors.push(`incremental.assertions.${field} must be a boolean`);
    }
  }
  return errors;
}

function validateIncrementalSpec(incremental) {
  if (!isRecord(incremental)) return ['incremental must be an object'];
  return [
    ...validateIncrementalDiff(incremental.diff),
    ...validateIncrementalAssertions(incremental.assertions),
  ];
}

function validateReviewSpec(review) {
  if (!isRecord(review)) return ['review must be an object for review-blast-radius tasks'];
  return [...validateReviewDiff(review.diff), ...validateReviewAssertions(review.assertions)];
}

function validateExplainSpec(explain) {
  const errors = [];
  if (!isRecord(explain)) return ['explain must be an object'];
  if (!isNonEmptyString(explain.target)) errors.push('explain.target must be a non-empty string');
  const assertions = explain.assertions;
  if (!isRecord(assertions)) {
    errors.push('explain.assertions must be an object');
  } else {
    validateOptionalStringArray(assertions, 'required_output_substrings', errors);
    validateOptionalStringArray(assertions, 'forbidden_output_substrings', errors);
  }
  if (explain.artifact_assertions !== undefined) {
    errors.push(...validateArtifactAssertions(explain.artifact_assertions));
  }
  return errors;
}

function validateRubric(rubric) {
  if (!isRecord(rubric)) return ['rubric must be an object'];
  const errors = [];
  if (!isStringArray(rubric.pass) || rubric.pass.length === 0) {
    errors.push('rubric.pass must include at least one string');
  }
  if (!isStringArray(rubric.fail) || rubric.fail.length === 0) {
    errors.push('rubric.fail must include at least one string');
  }
  return errors;
}

function validatePiBenchTask(task) {
  const errors = [];
  if (!isRecord(task)) return ['task must be an object'];
  if (task.schema_version !== PI_BENCH_TASK_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${PI_BENCH_TASK_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(task.id) || !/^[a-z0-9][a-z0-9-]*$/.test(task.id)) {
    errors.push('id must be kebab-case');
  }
  if (task.suite !== PI_BENCH_TASK_SUITE) errors.push(`suite must be ${PI_BENCH_TASK_SUITE}`);
  if (task.mode !== PI_BENCH_TASK_MODE) errors.push(`mode must be ${PI_BENCH_TASK_MODE}`);
  if (!PI_BENCH_TASK_CATEGORIES.includes(task.category)) {
    errors.push(`category must be one of ${PI_BENCH_TASK_CATEGORIES.join(', ')}`);
  }
  if (!isNonEmptyString(task.title)) errors.push('title must be a non-empty string');
  if (!isNonEmptyString(task.prompt)) errors.push('prompt must be a non-empty string');
  const isReviewTask = task.category === 'review-blast-radius';
  if (!Array.isArray(task.expected_artifacts) || task.expected_artifacts.length === 0) {
    errors.push('expected_artifacts must include at least one path');
  } else if (!task.expected_artifacts.every(isSafeRelativePath)) {
    errors.push('expected_artifacts must be safe relative paths');
  }
  errors.push(...validateFixture(task.fixture));
  if (isReviewTask) {
    errors.push(...validateReviewSpec(task.review));
  } else {
    errors.push(...validateCoverageTargets(task.coverage_targets));
    if (task.explain !== undefined) errors.push(...validateExplainSpec(task.explain));
    if (task.incremental !== undefined) errors.push(...validateIncrementalSpec(task.incremental));
  }
  errors.push(...validateArtifactAssertions(task.artifact_assertions));
  errors.push(...validateRubric(task.rubric));
  return errors;
}

function walkFiles(root, relativePrefix = '') {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = relativePrefix === '' ? entry.name : `${relativePrefix}/${entry.name}`;
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'dist' && entry.name !== 'node_modules') {
        files.push(...walkFiles(absolutePath, relativePath));
      }
      continue;
    }
    if (entry.isFile()) files.push({ absolutePath, relativePath });
  }
  return files;
}

function latestMtimeMs(paths) {
  return paths.reduce((latest, path) => {
    if (!existsSync(path)) return latest;
    return Math.max(latest, statSync(path).mtimeMs);
  }, 0);
}

function packageBuildState(packageName) {
  const packageDir = join(repoRoot, 'packages', packageName);
  const distEntry = join(packageDir, 'dist', 'index.js');
  if (!existsSync(distEntry)) {
    return { stale: true, reason: `packages/${packageName}/dist/index.js is missing` };
  }
  const inputs = [
    join(repoRoot, 'tsconfig.base.json'),
    join(repoRoot, 'tsconfig.json'),
    join(packageDir, 'package.json'),
    join(packageDir, 'tsconfig.json'),
    ...walkFiles(join(packageDir, 'src'))
      .filter((file) => /\.(ts|tsx|js|json)$/.test(file.relativePath))
      .map((file) => file.absolutePath),
  ];
  const inputMtime = latestMtimeMs(inputs);
  const outputMtime = statSync(distEntry).mtimeMs;
  if (inputMtime > outputMtime) {
    return { stale: true, reason: `packages/${packageName}/dist/index.js is older than sources` };
  }
  return { stale: false, reason: '' };
}

function buildCommand() {
  if (process.env.npm_execpath !== undefined && process.env.npm_execpath.trim() !== '') {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath, 'exec', 'tsc', '-b', '--force'],
    };
  }
  return { command: 'pnpm', args: ['exec', 'tsc', '-b', '--force'] };
}

function stalePackageReasons() {
  return EVAL_LOCAL_PACKAGES.map(packageBuildState)
    .filter((state) => state.stale)
    .map((state) => state.reason);
}

function ensureEvalBuild() {
  const staleReasons = stalePackageReasons();
  if (staleReasons.length === 0) return true;

  console.error('rizz eval: refreshing stale local package dist before scoring');
  for (const reason of staleReasons) console.error(`  - ${reason}`);

  const { command, args } = buildCommand();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 60_000,
  });
  if (result.error !== undefined) {
    console.error(`rizz eval: build required but could not start ${command}: ${result.error}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(
      `rizz eval: build required but ${command} ${args.join(' ')} exited ${result.status}`,
    );
    return false;
  }

  const remainingStaleReasons = stalePackageReasons();
  if (remainingStaleReasons.length > 0) {
    console.error('rizz eval: build completed but required dist output is still stale or missing');
    for (const reason of remainingStaleReasons) console.error(`  - ${reason}`);
    return false;
  }
  return true;
}

function safeJoin(root, relativePath) {
  const normalized = normalize(relativePath);
  assert(
    isSafeRelativePath(normalized) && normalized !== '.' && !normalized.startsWith(`..${sep}`),
    `unsafe relative path: ${relativePath}`,
  );
  return join(root, normalized);
}

function materializeFixture(task, parentDir) {
  const repoDir = safeJoin(parentDir, task.fixture.root);
  mkdirSync(repoDir, { recursive: true });
  for (const file of task.fixture.files) {
    const filePath = safeJoin(repoDir, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.contents);
  }
  return repoDir;
}

function readJsonArtifact(rootDir, relativePath) {
  return JSON.parse(readFileSync(safeJoin(rootDir, relativePath), 'utf8'));
}

function getPathValue(value, path) {
  let current = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function assertExpectedArtifacts(task, repoDir) {
  const errors = [];
  for (const artifact of task.expected_artifacts) {
    if (!existsSync(safeJoin(repoDir, artifact))) errors.push(`missing artifact ${artifact}`);
  }
  return errors;
}

function assertArtifactContracts(task, repoDir) {
  const errors = [];
  for (const assertion of task.artifact_assertions) {
    const artifactPath = safeJoin(repoDir, assertion.path);
    if (!existsSync(artifactPath)) {
      errors.push(`missing asserted artifact ${assertion.path}`);
      continue;
    }
    const artifactText = readFileSync(artifactPath, 'utf8');
    for (const substring of assertion.required_substrings ?? []) {
      if (!artifactText.includes(substring)) {
        errors.push(`${assertion.path} missing substring ${substring}`);
      }
    }
    for (const substring of assertion.forbidden_substrings ?? []) {
      if (artifactText.includes(substring)) {
        errors.push(`${assertion.path} included forbidden substring ${substring}`);
      }
    }
    if (assertion.type !== 'json') continue;
    let json;
    try {
      json = JSON.parse(artifactText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${assertion.path} is not valid JSON: ${message}`);
      continue;
    }
    for (const field of assertion.required_fields ?? []) {
      if (getPathValue(json, field) === undefined) {
        errors.push(`${assertion.path} missing ${field}`);
      }
    }
  }
  return errors;
}

function coverageValues(benchmarkReady, key) {
  const coverage = benchmarkReady.coverage?.[key];
  if (!isRecord(coverage)) return undefined;
  if (key === 'evidence') {
    return {
      total: coverage.records,
      covered: coverage.claims_with_evidence,
      ratio: coverage.coverage_ratio,
    };
  }
  return {
    total: coverage.total,
    covered: coverage.covered,
    ratio: coverage.coverage_ratio,
  };
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatCoverage(key, component) {
  if (key === 'evidence') {
    return `${component.covered} claims/${component.total} records ${percent(component.ratio)}`;
  }
  return `${component.covered}/${component.total} ${percent(component.ratio)}`;
}

function scoreBenchmarkReady(task, benchmarkReady) {
  const errors = [];
  if (benchmarkReady.schema_version !== 1) errors.push('benchmark_ready schema_version must be 1');
  if (benchmarkReady.benchmark_suite !== PI_BENCH_TASK_SUITE) {
    errors.push(`benchmark_ready benchmark_suite must be ${PI_BENCH_TASK_SUITE}`);
  }
  if (benchmarkReady.deterministic !== true) errors.push('benchmark_ready must be deterministic');
  if (benchmarkReady.provider_calls_required !== false) {
    errors.push('benchmark_ready must not require provider calls');
  }
  if (benchmarkReady.network_required !== false) {
    errors.push('benchmark_ready must not require network access');
  }

  const coverage = {};
  for (const key of COVERAGE_TARGETS) {
    const values = coverageValues(benchmarkReady, key);
    if (values === undefined) {
      errors.push(`benchmark_ready coverage.${key} is missing`);
      continue;
    }
    const target = task.coverage_targets[key];
    const total = typeof values.total === 'number' ? values.total : Number.NaN;
    const covered = typeof values.covered === 'number' ? values.covered : Number.NaN;
    const ratioValue = typeof values.ratio === 'number' ? values.ratio : Number.NaN;
    coverage[key] = { total, covered, ratio: ratioValue };
    if (!Number.isFinite(total) || total < target.minimum_total) {
      errors.push(`coverage.${key}.total ${total} below ${target.minimum_total}`);
    }
    if (!Number.isFinite(covered) || covered < target.minimum_covered) {
      errors.push(`coverage.${key}.covered ${covered} below ${target.minimum_covered}`);
    }
    if (!Number.isFinite(ratioValue) || ratioValue < target.minimum_ratio) {
      errors.push(`coverage.${key}.coverage_ratio ${ratioValue} below ${target.minimum_ratio}`);
    }
  }

  const readiness = isRecord(benchmarkReady.readiness) ? benchmarkReady.readiness : {};
  const readinessScore =
    typeof readiness.score === 'number' && Number.isFinite(readiness.score) ? readiness.score : 0;
  return { errors, coverage, readinessScore };
}

function applyReviewDiff(task, repoDir) {
  for (const file of task.review.diff.files) {
    const filePath = safeJoin(repoDir, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.contents);
  }
}

function applyIncrementalDiff(task, repoDir) {
  if (task.incremental === undefined) return;
  for (const file of task.incremental.diff.files) {
    const filePath = safeJoin(repoDir, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.contents);
  }
}

function idsFromRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => (isRecord(row) && typeof row.id === 'string' ? row.id : undefined))
    .filter((id) => id !== undefined);
}

function reviewArray(review, field) {
  const value = review[field];
  return Array.isArray(value) ? value : [];
}

function assertIncludesAll(actual, expected, label) {
  const errors = [];
  for (const item of expected ?? []) {
    if (!actual.includes(item)) errors.push(`${label} missing ${item}`);
  }
  return errors;
}

function assertExcludesAll(actual, expected, label) {
  const errors = [];
  for (const item of expected ?? []) {
    if (actual.includes(item)) errors.push(`${label} leaked ${item}`);
  }
  return errors;
}

function assertSubstringMatches(actual, expected, label) {
  const errors = [];
  for (const item of expected ?? []) {
    if (!actual.some((value) => typeof value === 'string' && value.includes(item))) {
      errors.push(`${label} missing substring ${item}`);
    }
  }
  return errors;
}

function assertReviewFindings(review, expected) {
  const findings = reviewArray(review, 'findings');
  const errors = [];
  for (const item of expected ?? []) {
    const matched = findings.some((finding) => {
      if (!isRecord(finding)) return false;
      const categoryMatches =
        item.category === undefined || String(finding.category ?? '') === item.category;
      const titleMatches =
        item.title_includes === undefined ||
        String(finding.title ?? '').includes(item.title_includes);
      return categoryMatches && titleMatches;
    });
    if (!matched) {
      errors.push(
        `findings missing ${item.category ?? '(any category)'} ${item.title_includes ?? ''}`.trim(),
      );
    }
  }
  return errors;
}

function assertReviewRouteFlows(review, expected) {
  const flows = reviewArray(review, 'affected_flows');
  const errors = [];
  for (const item of expected ?? []) {
    const matchedFlow = flows.find((flow) => {
      if (!isRecord(flow)) return false;
      const idMatches = item.id === undefined || String(flow.id ?? '') === item.id;
      const frameworkMatches =
        item.framework === undefined || String(flow.framework ?? '') === item.framework;
      const routePathMatches =
        item.route_path === undefined || String(flow.route_path ?? '') === item.route_path;
      const routeTypeMatches =
        item.route_type === undefined || String(flow.route_type ?? '') === item.route_type;
      return idMatches && frameworkMatches && routePathMatches && routeTypeMatches;
    });
    if (matchedFlow === undefined) {
      errors.push(`affected_flows missing route metadata for ${item.route_path ?? item.id}`);
      continue;
    }
    errors.push(
      ...assertIncludesAll(
        reviewArray(matchedFlow, 'entrypoints'),
        item.entrypoints_include,
        'affected_flows.entrypoints',
      ),
      ...assertIncludesAll(
        reviewArray(matchedFlow, 'changed_files'),
        item.changed_files_include,
        'affected_flows.changed_files',
      ),
      ...assertIncludesAll(
        reviewArray(matchedFlow, 'tests'),
        item.tests_include,
        'affected_flows.tests',
      ),
      ...assertIncludesAll(
        reviewArray(matchedFlow, 'configs'),
        item.configs_include,
        'affected_flows.configs',
      ),
    );
  }
  return errors;
}

function assertNoForbiddenReviewOutput(output, forbidden) {
  const errors = [];
  for (const item of forbidden ?? []) {
    if (output.includes(item)) errors.push(`review output leaked forbidden substring ${item}`);
  }
  return errors;
}

function assertReviewContract(task, repoDir, review, stdout) {
  const assertions = task.review.assertions;
  const errors = [];
  const directComponentIds = idsFromRows(review.direct_affected_components);
  const dependentComponentIds = idsFromRows(review.dependent_components);
  const affectedFlowIds = idsFromRows(review.affected_flows);
  const affectedRelationships = reviewArray(review, 'affected_relationships');
  const evidenceSummary = isRecord(review.review_evidence_summary)
    ? review.review_evidence_summary
    : {};
  const affectedTests = Array.isArray(evidenceSummary.affected_tests)
    ? evidenceSummary.affected_tests
    : [];
  const affectedConfigs = Array.isArray(evidenceSummary.affected_configs)
    ? evidenceSummary.affected_configs
    : [];

  errors.push(
    ...assertIncludesAll(
      reviewArray(review, 'changed_files'),
      assertions.changed_files_include,
      'changed_files',
    ),
    ...assertExcludesAll(
      reviewArray(review, 'changed_files'),
      assertions.changed_files_exclude,
      'changed_files',
    ),
    ...assertIncludesAll(
      directComponentIds,
      assertions.direct_components_include,
      'direct_affected_components',
    ),
    ...assertIncludesAll(
      dependentComponentIds,
      assertions.dependent_components_include,
      'dependent_components',
    ),
    ...assertIncludesAll(affectedFlowIds, assertions.affected_flows_include, 'affected_flows'),
    ...assertIncludesAll(affectedTests, assertions.affected_tests_include, 'affected_tests'),
    ...assertIncludesAll(affectedConfigs, assertions.affected_configs_include, 'affected_configs'),
    ...assertSubstringMatches(
      reviewArray(review, 'required_tests'),
      assertions.required_tests_include,
      'required_tests',
    ),
    ...assertSubstringMatches(
      reviewArray(review, 'blast_radius_reasons'),
      assertions.blast_radius_reasons_include,
      'blast_radius_reasons',
    ),
    ...assertReviewFindings(review, assertions.findings_include),
    ...assertReviewRouteFlows(review, assertions.route_flows_include),
  );

  if (
    assertions.minimum_direct_components !== undefined &&
    directComponentIds.length < assertions.minimum_direct_components
  ) {
    errors.push(
      `direct_affected_components ${directComponentIds.length} below ${assertions.minimum_direct_components}`,
    );
  }
  if (
    assertions.minimum_dependent_components !== undefined &&
    dependentComponentIds.length < assertions.minimum_dependent_components
  ) {
    errors.push(
      `dependent_components ${dependentComponentIds.length} below ${assertions.minimum_dependent_components}`,
    );
  }
  if (
    assertions.minimum_affected_flows !== undefined &&
    affectedFlowIds.length < assertions.minimum_affected_flows
  ) {
    errors.push(
      `affected_flows ${affectedFlowIds.length} below ${assertions.minimum_affected_flows}`,
    );
  }
  if (
    assertions.minimum_affected_relationships !== undefined &&
    affectedRelationships.length < assertions.minimum_affected_relationships
  ) {
    errors.push(
      `affected_relationships ${affectedRelationships.length} below ${assertions.minimum_affected_relationships}`,
    );
  }
  if (assertions.blast_radius !== undefined && review.blast_radius !== assertions.blast_radius) {
    errors.push(`blast_radius ${review.blast_radius} did not match ${assertions.blast_radius}`);
  }

  const reportPath = safeJoin(repoDir, '.rizz/reports/review.html');
  const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  errors.push(
    ...assertNoForbiddenReviewOutput(
      `${stdout}\n${report}`,
      assertions.forbidden_output_substrings,
    ),
  );
  return {
    errors,
    summary: {
      directComponents: directComponentIds.length,
      dependentComponents: dependentComponentIds.length,
      affectedFlows: affectedFlowIds.length,
      affectedRelationships: affectedRelationships.length,
      blastRadius: review.blast_radius,
    },
  };
}

function assertIncrementalContract(task, repoDir, incremental, outputs) {
  if (task.incremental === undefined) return { errors: [], summary: undefined };
  const assertions = task.incremental.assertions;
  const errors = [];
  const changedFiles = reviewArray(incremental, 'changed_files');
  const changedEntities = reviewArray(incremental, 'changed_entities')
    .map((entity) => (isRecord(entity) ? String(entity.id ?? '') : ''))
    .filter((id) => id !== '');
  const evidenceDelta = isRecord(incremental.evidence_delta) ? incremental.evidence_delta : {};
  const evidenceDeltaChanged = Array.isArray(evidenceDelta.changed) ? evidenceDelta.changed : [];

  errors.push(
    ...assertIncludesAll(
      changedFiles,
      assertions.changed_files_include,
      'incremental.changed_files',
    ),
    ...assertExcludesAll(
      changedFiles,
      assertions.changed_files_exclude,
      'incremental.changed_files',
    ),
    ...assertSubstringMatches(
      evidenceDeltaChanged,
      assertions.evidence_delta_changed_include,
      'incremental.evidence_delta.changed',
    ),
    ...assertSubstringMatches(
      changedEntities,
      assertions.changed_entities_include,
      'incremental.changed_entities',
    ),
  );

  const exactNumberFields = [
    ['changed_file_count', 'expected_changed_file_count'],
    ['stale_file_count', 'expected_stale_file_count'],
    ['reused_files', 'expected_reused_files'],
    ['recomputed_files', 'expected_recomputed_files'],
  ];
  for (const [artifactField, assertionField] of exactNumberFields) {
    if (
      assertions[assertionField] !== undefined &&
      incremental[artifactField] !== assertions[assertionField]
    ) {
      errors.push(
        `incremental.${artifactField} ${incremental[artifactField]} did not match ${assertions[assertionField]}`,
      );
    }
  }

  if (
    assertions.expected_file_reuse_ratio !== undefined &&
    incremental.file_reuse_ratio !== assertions.expected_file_reuse_ratio
  ) {
    errors.push(
      `incremental.file_reuse_ratio ${incremental.file_reuse_ratio} did not match ${assertions.expected_file_reuse_ratio}`,
    );
  }

  const minimumNumberFields = [
    ['changed_entity_count', 'minimum_changed_entity_count'],
    ['stable_entity_count', 'minimum_stable_entity_count'],
    ['reused_understanding_count', 'minimum_reused_understanding_count'],
    ['recomputed_understanding_count', 'minimum_recomputed_understanding_count'],
    ['scan_efficiency_score', 'minimum_scan_efficiency_score'],
  ];
  for (const [artifactField, assertionField] of minimumNumberFields) {
    if (
      assertions[assertionField] !== undefined &&
      (typeof incremental[artifactField] !== 'number' ||
        incremental[artifactField] < assertions[assertionField])
    ) {
      errors.push(
        `incremental.${artifactField} ${incremental[artifactField]} below ${assertions[assertionField]}`,
      );
    }
  }

  if (assertions.expected_redacted_changed_file_count !== undefined) {
    const redactedCount = changedFiles.filter(
      (file) => typeof file === 'string' && file.startsWith('redacted:sensitive-file:'),
    ).length;
    if (redactedCount !== assertions.expected_redacted_changed_file_count) {
      errors.push(
        `incremental.changed_files redacted count ${redactedCount} did not match ${assertions.expected_redacted_changed_file_count}`,
      );
    }
  }

  if (
    assertions.require_previous_fingerprint === true &&
    !/^[a-f0-9]{64}$/.test(String(incremental.previous_brain_fingerprint ?? ''))
  ) {
    errors.push('incremental.previous_brain_fingerprint must be a sha256 fingerprint');
  }
  if (!/^[a-f0-9]{64}$/.test(String(incremental.current_brain_fingerprint ?? ''))) {
    errors.push('incremental.current_brain_fingerprint must be a sha256 fingerprint');
  }
  if (
    assertions.require_fingerprint_changed === true &&
    incremental.previous_brain_fingerprint === incremental.current_brain_fingerprint
  ) {
    errors.push('incremental.current_brain_fingerprint must differ from previous');
  }

  const artifactOutput = [
    outputs,
    readArtifactText(repoDir, '.rizz/research/incremental_update.json'),
    readArtifactText(repoDir, '.rizz/research/understanding_score.json'),
    readArtifactText(repoDir, '.rizz/brain/latest.json'),
    readArtifactText(repoDir, '.rizz/reports/index.html'),
  ].join('\n');
  errors.push(
    ...assertNoForbiddenReviewOutput(artifactOutput, assertions.forbidden_output_substrings),
  );

  return {
    errors,
    summary: {
      changedFiles: changedFiles.length,
      stableEntities:
        typeof incremental.stable_entity_count === 'number' ? incremental.stable_entity_count : 0,
      reusedUnderstanding:
        typeof incremental.reused_understanding_count === 'number'
          ? incremental.reused_understanding_count
          : 0,
      recomputedUnderstanding:
        typeof incremental.recomputed_understanding_count === 'number'
          ? incremental.recomputed_understanding_count
          : 0,
      scanEfficiency:
        typeof incremental.scan_efficiency_score === 'number'
          ? incremental.scan_efficiency_score
          : 0,
    },
  };
}

function readArtifactText(repoDir, relativePath) {
  const artifactPath = safeJoin(repoDir, relativePath);
  return existsSync(artifactPath) ? readFileSync(artifactPath, 'utf8') : '';
}

function assertExplainContract(task, repoDir) {
  if (task.explain === undefined) return [];
  const result = runCliInCwdSync(repoDir, ['explain', task.explain.target], '');
  const errors = [];
  if (result.error !== undefined) errors.push(String(result.error));
  if (result.status !== 0) {
    errors.push(`rizz explain exited ${result.status}: ${result.stderr || result.stdout}`);
  }

  const assertions = task.explain.assertions;
  if (isRecord(assertions)) {
    for (const substring of assertions.required_output_substrings ?? []) {
      if (!result.stdout.includes(substring)) {
        errors.push(`explain output missing substring ${substring}`);
      }
    }
    for (const substring of assertions.forbidden_output_substrings ?? []) {
      if (result.stdout.includes(substring)) {
        errors.push(`explain output included forbidden substring ${substring}`);
      }
    }
  }

  if (Array.isArray(task.explain.artifact_assertions)) {
    errors.push(
      ...assertArtifactContracts(
        { artifact_assertions: task.explain.artifact_assertions },
        repoDir,
      ),
    );
  }
  return errors;
}

function runReviewPiBenchTask(task) {
  return withTempDirSync('rizz-pi-bench-review-', (dir) => {
    const repoDir = materializeFixture(task, dir);
    const errors = [];
    gitInCwd(repoDir, ['init', '-b', 'develop']);
    gitInCwd(repoDir, ['config', 'user.email', 'rizz@example.com']);
    gitInCwd(repoDir, ['config', 'user.name', 'rizz eval']);

    const brain = runCliInCwdSync(repoDir, ['brain'], '');
    if (brain.error !== undefined) errors.push(String(brain.error));
    if (brain.status !== 0) {
      errors.push(`rizz brain exited ${brain.status}: ${brain.stderr || brain.stdout}`);
    }
    gitInCwd(repoDir, ['add', '.']);
    gitInCwd(repoDir, ['commit', '-m', 'initial fixture']);
    applyReviewDiff(task, repoDir);

    const result = runCliInCwdWithGitSync(repoDir, ['review', '--json'], '');
    if (result.error !== undefined) errors.push(String(result.error));
    if (result.status !== 0) {
      errors.push(`rizz review exited ${result.status}: ${result.stderr || result.stdout}`);
    }
    errors.push(...assertExpectedArtifacts(task, repoDir));
    errors.push(...assertArtifactContracts(task, repoDir));

    let review;
    let reviewScore;
    try {
      review = JSON.parse(result.stdout);
      reviewScore = assertReviewContract(task, repoDir, review, result.stdout);
      errors.push(...reviewScore.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`could not parse review JSON: ${message}`);
    }

    if (errors.length > 0 || reviewScore === undefined) {
      return { ok: false, errors, summary: undefined };
    }
    return { ok: true, errors: [], summary: { kind: 'review', ...reviewScore.summary } };
  });
}

function runPiBenchTask(task) {
  const schemaErrors = validatePiBenchTask(task);
  if (schemaErrors.length > 0) {
    return { ok: false, errors: schemaErrors, summary: undefined };
  }
  if (task.category === 'review-blast-radius') return runReviewPiBenchTask(task);

  return withTempDirSync('rizz-pi-bench-', (dir) => {
    const repoDir = materializeFixture(task, dir);
    const firstResult = runCliInCwdSync(repoDir, ['brain'], '');
    const errors = [];
    if (firstResult.error !== undefined) errors.push(String(firstResult.error));
    if (firstResult.status !== 0) {
      errors.push(
        `rizz brain exited ${firstResult.status}: ${firstResult.stderr || firstResult.stdout}`,
      );
    }

    let result = firstResult;
    let incrementalScore;
    if (task.incremental !== undefined && errors.length === 0) {
      applyIncrementalDiff(task, repoDir);
      result = runCliInCwdSync(repoDir, ['brain'], '');
      if (result.error !== undefined) errors.push(String(result.error));
      if (result.status !== 0) {
        errors.push(
          `incremental rizz brain exited ${result.status}: ${result.stderr || result.stdout}`,
        );
      }
    }

    errors.push(...assertExpectedArtifacts(task, repoDir));
    errors.push(...assertArtifactContracts(task, repoDir));
    errors.push(...assertExplainContract(task, repoDir));

    if (task.incremental !== undefined) {
      try {
        const incremental = readJsonArtifact(repoDir, '.rizz/research/incremental_update.json');
        incrementalScore = assertIncrementalContract(
          task,
          repoDir,
          incremental,
          `${firstResult.stdout}\n${firstResult.stderr}\n${result.stdout}\n${result.stderr}`,
        );
        errors.push(...incrementalScore.errors);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`could not read incremental_update.json: ${message}`);
      }
    }

    let score;
    try {
      const benchmarkReady = readJsonArtifact(repoDir, '.rizz/research/benchmark_ready.json');
      score = scoreBenchmarkReady(task, benchmarkReady);
      errors.push(...score.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`could not read benchmark_ready.json: ${message}`);
    }

    if (errors.length > 0 || score === undefined) {
      return { ok: false, errors, summary: undefined };
    }
    return {
      ok: true,
      errors: [],
      summary: {
        kind: 'research',
        readinessScore: score.readinessScore,
        coverage: score.coverage,
        incremental: incrementalScore?.summary,
      },
    };
  });
}

function runPiBenchTasks(loadedTasks) {
  console.log(`rizz eval — ${loadedTasks.length} PI-Bench task(s) loaded`);
  let passed = 0;
  let scoreTotal = 0;
  let scoredTasks = 0;
  for (const task of loadedTasks) {
    const result = runPiBenchTask(task);
    if (result.ok) {
      passed += 1;
      if (result.summary.kind === 'review') {
        console.log(
          `  ✓ ${task.id} [${task.category}] blast ${result.summary.blastRadius} | direct ${result.summary.directComponents}, dependent ${result.summary.dependentComponents}, flows ${result.summary.affectedFlows}, relationships ${result.summary.affectedRelationships}`,
        );
      } else {
        scoreTotal += result.summary.readinessScore;
        scoredTasks += 1;
        const coverage = result.summary.coverage;
        const incremental =
          result.summary.incremental === undefined
            ? ''
            : ` | incremental changed ${result.summary.incremental.changedFiles}, stable entities ${result.summary.incremental.stableEntities}, reused ${result.summary.incremental.reusedUnderstanding}, recomputed ${result.summary.incremental.recomputedUnderstanding}, efficiency ${result.summary.incremental.scanEfficiency}`;
        console.log(
          `  ✓ ${task.id} [${task.category}] score ${result.summary.readinessScore} | component ${formatCoverage('component', coverage.component)}, flow ${formatCoverage('flow', coverage.flow)}, evidence ${formatCoverage('evidence', coverage.evidence)}, unknown ${formatCoverage('unknown', coverage.unknown)}${incremental}`,
        );
      }
    } else {
      console.log(`  ✗ ${task?.id ?? '(missing id)'} — ${result.errors.join('; ')}`);
    }
  }
  const averageScore = scoredTasks === 0 ? 0 : Math.round(scoreTotal / scoredTasks);
  console.log(`\n${passed}/${loadedTasks.length} PI-Bench task(s) passed`);
  console.log(`PI-Bench average research readiness score: ${averageScore}`);
  return { passed, total: loadedTasks.length, ok: passed === loadedTasks.length, averageScore };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isolatedEnv(home) {
  // Avoid accidental live-provider/keychain use: the smoke must stay local, deterministic, and free.
  const env = {
    CI: '1',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    PATH: '',
  };

  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  return env;
}

function isolatedEnvWithGit(home) {
  return {
    ...isolatedEnv(home),
    PATH: process.env.PATH ?? '',
  };
}

function redactOutput(output, secret) {
  return output.split(secret).join('[redacted secret]');
}

function withTempHomeSync(run) {
  const home = mkdtempSync(join(tmpdir(), 'rizz-headless-smoke-'));
  try {
    return run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function withTempHomeAsync(run) {
  const home = mkdtempSync(join(tmpdir(), 'rizz-headless-smoke-'));
  try {
    return await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function withTempDirSync(prefix, run) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseJsonLines(stdout) {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  assert(lines.length > 0, 'expected at least one stdout line');
  return lines.map((line) => JSON.parse(line));
}

function runCliSync(args, input) {
  return withTempHomeSync((home) =>
    spawnSync(process.execPath, [cliBin, ...args], {
      cwd: repoRoot,
      input,
      encoding: 'utf8',
      env: isolatedEnv(home),
      timeout: 5_000,
    }),
  );
}

function runCliInCwdSync(cwd, args, input) {
  return withTempHomeSync((home) =>
    spawnSync(process.execPath, [cliBin, ...args], {
      cwd,
      input,
      encoding: 'utf8',
      env: isolatedEnv(home),
      timeout: 5_000,
    }),
  );
}

function runCliInCwdWithGitSync(cwd, args, input) {
  return withTempHomeSync((home) =>
    spawnSync(process.execPath, [cliBin, ...args], {
      cwd,
      input,
      encoding: 'utf8',
      env: isolatedEnvWithGit(home),
      timeout: 5_000,
    }),
  );
}

function gitInCwd(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert(result.status === 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

function setupSmokeEnv(home, secret) {
  return {
    ...isolatedEnv(home),
    ANTHROPIC_API_KEY: secret,
    OPENROUTER_API_KEY: secret,
  };
}

function runSetupCliSync(args, secret) {
  return withTempHomeSync((home) => {
    const result = spawnSync(process.execPath, [cliBin, 'setup', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: setupSmokeEnv(home, secret),
      timeout: 5_000,
    });
    return {
      result,
      rizzHomeExists: existsSync(join(home, '.rizz')),
    };
  });
}

function runInstallLocalSync(args) {
  return spawnSync(process.execPath, [installLocalScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function runInstalledShim(shimPath, args) {
  const nodeDir = dirname(process.execPath);
  return spawnSync(shimPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${nodeDir}:${process.env.PATH ?? ''}`,
    },
    timeout: 5_000,
  });
}

async function runRpcSmoke() {
  return withTempHomeAsync(
    (home) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cliBin, '--rpc'], {
          cwd: repoRoot,
          env: isolatedEnv(home),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const messages = [];
        let stdout = '';
        let stderr = '';
        let bufferedStdout = '';
        let turnSent = false;
        let stdinClosed = false;

        const closeStdin = () => {
          if (!stdinClosed) {
            stdinClosed = true;
            child.stdin.end();
          }
        };

        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('rizz --rpc smoke timed out'));
        }, 5_000);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          bufferedStdout += chunk;
          const lines = bufferedStdout.split('\n');
          bufferedStdout = lines.pop() ?? '';

          for (const line of lines) {
            if (line.trim() === '') continue;
            const message = JSON.parse(line);
            messages.push(message);

            if (!turnSent && message.id === 1 && message.result !== undefined) {
              turnSent = true;
              child.stdin.write(
                `${JSON.stringify({
                  id: 2,
                  method: 'turn',
                  params: { input: 'hello from rpc smoke' },
                })}\n`,
              );
            }

            if (message.id === 2 && message.result !== undefined) closeStdin();
          }
        });

        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });

        child.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        child.on('close', (code, signal) => {
          clearTimeout(timeout);
          try {
            assert(signal === null, `rizz --rpc exited by signal ${signal}`);
            assert(code === 0, `rizz --rpc exited ${code}: ${stderr}`);
            assert(bufferedStdout.trim() === '', 'rizz --rpc left a partial stdout JSON line');
            assert(
              messages.some((message) => message.id === 1),
              'missing session.start response',
            );
            assert(
              messages.some((message) => message.id === 2),
              'missing turn response',
            );
            assert(
              messages.some(
                (message) =>
                  message.method === 'event' &&
                  message.params !== undefined &&
                  message.params.type === 'assistant',
              ),
              'missing assistant event',
            );
            resolve({ stdout, stderr, messages });
          } catch (error) {
            reject(error);
          }
        });

        child.stdin.write(`${JSON.stringify({ id: 1, method: 'session.start' })}\n`);
      }),
  );
}

async function runHeadlessSmoke() {
  console.log('\nrizz CLI process smoke — headless/setup gates');
  let smokePassed = 0;
  const checks = [
    {
      name: 'rizz --json empty input exits 2 with BAD_REQUEST JSON',
      run() {
        const result = runCliSync(['--json'], '');
        assert(result.error === undefined, String(result.error));
        assert(result.status === 2, `expected exit 2, got ${result.status}`);
        assert(result.stderr === '', `expected empty stderr, got ${JSON.stringify(result.stderr)}`);
        const [message] = parseJsonLines(result.stdout);
        assert(message.ok === false, 'expected ok:false');
        assert(message.error?.code === 'BAD_REQUEST', 'expected BAD_REQUEST');
      },
    },
    {
      name: 'rizz --json emits one parseable stdout JSON result',
      run() {
        const result = runCliSync(['--json'], 'hello from json smoke\n');
        assert(result.error === undefined, String(result.error));
        assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
        const messages = parseJsonLines(result.stdout);
        assert(messages.length === 1, `expected one stdout line, got ${messages.length}`);
        const [message] = messages;
        assert(message.ok === true, 'expected ok:true');
        assert(typeof message.reply === 'string', 'expected string reply');
        assert(message.usage?.tokens > 0, 'expected positive token usage');
        assert(message.costUsd === 0, 'expected demo/subscription costUsd 0');
      },
    },
    {
      name: 'rizz --rpc handles session.start -> turn as line-delimited JSON',
      async run() {
        const { messages } = await runRpcSmoke();
        const start = messages.find((message) => message.id === 1);
        const turn = messages.find((message) => message.id === 2);
        assert(start?.result !== undefined, 'expected session.start result');
        assert(turn?.result?.reply !== undefined, 'expected turn reply');
        assert(turn.result.usage?.tokens > 0, 'expected turn usage');
      },
    },
    {
      name: 'rizz setup --dry-run exits 0 without leaking provider env or creating ~/.rizz',
      run() {
        const secret = 'sk-ant-eval-setup-smoke-secret';
        const { result, rizzHomeExists } = runSetupCliSync(['--dry-run'], secret);
        const combinedOutput = `${result.stdout}\n${result.stderr}`;

        assert(result.error === undefined, String(result.error));
        assert(
          result.status === 0,
          `expected exit 0, got ${result.status}: ${redactOutput(result.stderr, secret)}`,
        );
        assert(
          result.stderr === '',
          `expected empty stderr, got ${JSON.stringify(redactOutput(result.stderr, secret))}`,
        );
        assert(result.stdout.includes('dependency doctor'), 'expected dependency doctor output');
        assert(!combinedOutput.includes(secret), 'fake provider key was echoed');
        assert(!rizzHomeExists, 'dry-run created temp HOME/.rizz');
      },
    },
    {
      name: 'rizz setup unsupported secret-like arg exits 2 without echoing the secret',
      run() {
        const secret = 'sk-ant-eval-unsupported-setup-secret';
        const { result, rizzHomeExists } = runSetupCliSync(['--provider-key', secret], secret);
        const combinedOutput = `${result.stdout}\n${result.stderr}`;

        assert(result.error === undefined, String(result.error));
        assert(result.status === 2, `expected exit 2, got ${result.status}`);
        assert(
          result.stdout === '',
          `expected empty stdout, got ${JSON.stringify(redactOutput(result.stdout, secret))}`,
        );
        assert(result.stderr.includes('unsupported setup option'), 'expected setup usage error');
        assert(!combinedOutput.includes(secret), 'unsupported setup arg secret was echoed');
        assert(!rizzHomeExists, 'unsupported setup arg created temp HOME/.rizz');
      },
    },
    {
      name: 'rizz setup shows route picker without provider credentials or config writes',
      run() {
        const secret = 'sk-ant-eval-interactive-setup-secret';
        const { configExists, envUser, result } = withTempHomeSync((home) => {
          const env = setupSmokeEnv(home, secret);
          const child = spawnSync(process.execPath, [cliBin, 'setup'], {
            cwd: repoRoot,
            input: '',
            encoding: 'utf8',
            env,
            timeout: 5_000,
          });
          return {
            configExists: existsSync(join(home, '.rizz', 'config.json')),
            envUser: env.USER,
            result: child,
          };
        });
        const combinedOutput = `${result.stdout}\n${result.stderr}`;

        assert(result.error === undefined, String(result.error));
        assert(
          result.status === 0,
          `expected exit 0, got ${result.status}: ${redactOutput(result.stderr, secret)}`,
        );
        assert(result.stdout.includes('rizz setup'), 'expected setup output');
        assert(
          result.stdout.includes('Choose how rizz should talk to a model'),
          'expected setup route picker',
        );
        assert(
          result.stdout.includes('Skipped model connection.'),
          'expected setup to skip model route in isolated env',
        );
        assert(!result.stdout.includes('Name this launch?'), 'old launch-name prompt remained');
        assert(
          !result.stdout.includes("Hey. How're you doing?"),
          'non-interactive setup printed the first-run greeting',
        );
        assert(
          !result.stdout.includes('What should I call you?'),
          'non-interactive setup printed the nickname prompt',
        );
        if (envUser) {
          assert(!result.stdout.includes(envUser), 'non-interactive setup echoed the system user');
        }
        assert(!result.stdout.includes('[pi]'), 'old pi default remained');
        assert(!result.stdout.includes('local demo mode'), 'old local demo copy remained');
        assert(!result.stdout.includes('Demo / Harness'), 'old demo harness copy remained');
        assert(!combinedOutput.includes(secret), 'fake provider key was echoed');
        assert(!configExists, 'interactive setup wrote temp HOME/.rizz/config.json');
      },
    },
    {
      name: 'rizz brain writes local project brain without provider credentials',
      run() {
        withTempDirSync('rizz-brain-smoke-', (dir) => {
          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ name: 'brain-smoke', scripts: { test: 'vitest run' } }),
          );
          writeFileSync(join(dir, 'index.ts'), 'export const ok = true;\n');

          const result = runCliInCwdSync(dir, ['brain'], '');
          assert(result.error === undefined, String(result.error));
          assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
          assert(result.stdout.includes('rizz understood 2 file(s)'), 'expected brain summary');
          assert(existsSync(join(dir, '.rizz', 'brain', 'latest.json')), 'missing latest.json');
          assert(existsSync(join(dir, '.rizz', 'brain', 'graph.json')), 'missing graph.json');
          assert(
            existsSync(join(dir, '.rizz', 'brain', 'entities', 'files.json')),
            'missing files entity store',
          );
          const researchDir = join(dir, '.rizz', 'research');
          for (const fileName of [
            'metrics.json',
            'coverage.json',
            'confidence.json',
            'component_intelligence.json',
            'evidence_quality.json',
            'incremental_update.json',
            'benchmark_ready.json',
          ]) {
            const artifactPath = join(researchDir, fileName);
            assert(existsSync(artifactPath), `missing research artifact ${fileName}`);
            JSON.parse(readFileSync(artifactPath, 'utf8'));
          }
          const metrics = JSON.parse(readFileSync(join(researchDir, 'metrics.json'), 'utf8'));
          assert(metrics.scanned_files === 2, 'research metrics missed scanned files');
          assert(metrics.evidence_records === 2, 'research metrics missed evidence records');
          const componentIntelligence = JSON.parse(
            readFileSync(join(researchDir, 'component_intelligence.json'), 'utf8'),
          );
          assert(
            typeof componentIntelligence.component_understanding_score === 'number',
            'component intelligence missing understanding score',
          );
          assert(
            Array.isArray(componentIntelligence.components),
            'component intelligence missing component rows',
          );
          const reportPath = join(dir, '.rizz', 'reports', 'index.html');
          assert(existsSync(reportPath), 'missing HTML report');
          const report = readFileSync(reportPath, 'utf8');
          assert(report.includes('Mission Control ·'), 'missing Mission Control title');
          assert(report.includes('local project intelligence'), 'missing portal positioning');
          assert(report.includes('Mission Control scorecard'), 'missing Mission Control scorecard');
          assert(report.includes('Understanding Score'), 'missing understanding score');
          assert(report.includes('Evidence Quality'), 'missing evidence quality');
          assert(report.includes('Review Readiness'), 'missing review readiness');
          assert(report.includes('Unknown Risk'), 'missing unknown risk');
          assert(
            report.includes('<section class="objects" aria-label="Mission Control objects">'),
            'missing Mission Control objects',
          );
          assert(report.includes('<span>Components</span>'), 'missing components object');
          assert(report.includes('<span>Flows</span>'), 'missing flows object');
          assert(report.includes('<span>Architecture</span>'), 'missing architecture object');
          assert(report.includes('<span>Review Blast Radius</span>'), 'missing review object');
          assert(report.includes('<span>Evidence</span>'), 'missing evidence object');
          assert(report.includes('<span>Unknowns</span>'), 'missing unknowns object');
          assert(report.includes('<span>Read First</span>'), 'missing read-first object');
          assert(report.includes('<h2>Start Here</h2>'), 'missing Start Here section');
          assert(report.includes('<h3>Risk Areas</h3>'), 'missing risk section');
          assert(report.includes('<h3>Raw Artifacts</h3>'), 'missing raw artifact links');
          assert(!report.includes('<script'), 'report should not include scripts');
          assert(!report.includes('fetch('), 'report should not fetch');
          assert(report.includes('href="#evidence-file-package-json"'), 'missing evidence link');
          assert(report.includes('id="evidence-file-package-json"'), 'missing evidence anchor');
          assert(!report.includes('<script src='), 'portal references external script');
          assert(
            !report.includes('<link rel="stylesheet"'),
            'portal references external stylesheet',
          );
          assert(!report.includes('fetch('), 'portal uses fetch');
          assert(!report.includes('http://'), 'portal references http URL');
          assert(!report.includes('https://'), 'portal references https URL');
        });
      },
    },
    {
      name: 'rizz review writes brain-backed review artifacts for current git diff',
      run() {
        withTempDirSync('rizz-review-smoke-', (dir) => {
          gitInCwd(dir, ['init', '-b', 'develop']);
          gitInCwd(dir, ['config', 'user.email', 'rizz@example.com']);
          gitInCwd(dir, ['config', 'user.name', 'rizz eval']);
          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ name: 'review-smoke', scripts: { test: 'vitest run' } }),
          );
          mkdirSync(join(dir, 'src'), { recursive: true });
          writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = true;\n');
          const brain = runCliInCwdSync(dir, ['brain'], '');
          assert(brain.status === 0, `expected brain exit 0, got ${brain.status}: ${brain.stderr}`);
          gitInCwd(dir, ['add', '.']);
          gitInCwd(dir, ['commit', '-m', 'initial']);
          writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = false;\n');

          const result = runCliInCwdWithGitSync(dir, ['review', '--json'], '');
          assert(result.error === undefined, String(result.error));
          assert(
            result.status === 0,
            `expected review exit 0, got ${result.status}: ${result.stderr}`,
          );
          assert(!result.stdout.includes('sk-or-v1-'), 'review output leaked secret-like text');
          const review = JSON.parse(result.stdout);
          assert(
            review.changed_files.includes('src/index.ts'),
            'review missed changed source file',
          );
          assert(review.findings.length > 0, 'review produced no findings');
          assert(
            review.required_tests.some((command) => command.includes('vitest')),
            'review missed test command',
          );
          assert(
            existsSync(join(dir, '.rizz', 'brain', 'entities', 'reviews.json')),
            'missing reviews entity store',
          );
          assert(existsSync(join(dir, '.rizz', 'reports', 'review.html')), 'missing review report');
        });
      },
    },
    {
      name: 'rizz explain explains a component from the local project brain',
      run() {
        withTempDirSync('rizz-explain-smoke-', (dir) => {
          mkdirSync(join(dir, 'packages', 'brain', 'src'), { recursive: true });
          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ name: 'explain-smoke', scripts: { test: 'vitest run' } }),
          );
          writeFileSync(
            join(dir, 'packages', 'brain', 'package.json'),
            JSON.stringify({
              name: '@smoke/brain',
              scripts: { test: 'vitest run packages/brain' },
              dependencies: { zod: '^3.0.0' },
            }),
          );
          writeFileSync(
            join(dir, 'packages', 'brain', 'src', 'index.ts'),
            'export const ok = 1;\n',
          );
          writeFileSync(
            join(dir, 'packages', 'brain', 'src', 'index.test.ts'),
            'import { it } from "vitest"; it("works", () => {});\n',
          );

          const brain = runCliInCwdSync(dir, ['brain'], '');
          assert(brain.status === 0, `expected brain exit 0, got ${brain.status}: ${brain.stderr}`);

          const result = runCliInCwdSync(dir, ['explain', 'packages/brain', '--json'], '');
          assert(
            result.status === 0,
            `expected explain exit 0, got ${result.status}: ${result.stderr}`,
          );
          assert(!result.stdout.includes('sk-or-v1-'), 'explain output leaked secret-like text');
          const explanation = JSON.parse(result.stdout);
          assert(
            explanation.resolved_entity_id === 'component:packages--brain',
            'explain resolved the wrong entity',
          );
          assert(explanation.entity_type === 'component', 'explain returned the wrong entity type');
          assert(
            explanation.dependencies.includes('zod'),
            'explain missed component dependency evidence',
          );
          assert(
            explanation.dependency_roles.includes('runtime dependency: zod'),
            'explain missed dependency role evidence',
          );
          assert(
            explanation.failure_modes.some((item) => item.includes('Dependency upgrades')),
            'explain missed component failure mode evidence',
          );
          assert(
            explanation.read_first.includes('packages/brain/src/index.ts'),
            'explain missed read-first file',
          );
          assert(
            existsSync(join(dir, '.rizz', 'reports', 'explain.html')),
            'missing explain report',
          );

          const missingTarget = runCliInCwdSync(dir, ['explain', '--json'], '');
          assert(missingTarget.status === 2, 'expected missing explain target to exit 2');
          assert(missingTarget.stderr === '', 'expected JSON explain error to keep stderr empty');
          const missingTargetError = JSON.parse(missingTarget.stdout);
          assert(
            missingTargetError.error.code === 'EXPLAIN_TARGET_REQUIRED',
            'missing target JSON error code mismatch',
          );

          const ambiguous = runCliInCwdSync(dir, ['explain', 'index', '--json'], '');
          assert(ambiguous.status === 1, 'expected ambiguous explain target to exit 1');
          assert(ambiguous.stderr === '', 'expected ambiguous JSON explain error stderr empty');
          const ambiguousError = JSON.parse(ambiguous.stdout);
          assert(
            ambiguousError.error.code === 'EXPLAIN_TARGET_AMBIGUOUS',
            'ambiguous target JSON error code mismatch',
          );
        });
      },
    },
  ];

  for (const check of checks) {
    try {
      await check.run();
      smokePassed += 1;
      console.log(`  ✓ ${check.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ ${check.name}`);
      console.log(`    ${message}`);
    }
  }

  console.log(`\n${smokePassed}/${checks.length} CLI process smoke check(s) passed`);
  return smokePassed === checks.length;
}

function runInstallShimSmoke() {
  console.log('\nrizz install-local smoke - shim safety gates');
  let smokePassed = 0;
  const checks = [
    {
      name: 'install-local writes a regular executable shim and forwards args',
      run() {
        withTempDirSync('rizz-install-smoke-', (dir) => {
          const binDir = join(dir, 'bin');
          const result = runInstallLocalSync(['--dir', binDir]);
          if (process.platform === 'win32') {
            assert(result.status === 1, `expected Windows exit 1, got ${result.status}`);
            assert(
              result.stderr.includes('pnpm build && pnpm -C packages/cli link --global'),
              'expected Windows pnpm link guidance',
            );
            return;
          }

          assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
          const shimPath = join(binDir, 'rizz');
          const shimStat = lstatSync(shimPath);
          assert(shimStat.isFile(), 'expected shim to be a regular file');
          assert(!shimStat.isSymbolicLink(), 'expected shim not to be a symlink');
          assert((shimStat.mode & 0o111) !== 0, 'expected executable bit on shim');

          const version = runInstalledShim(shimPath, ['--version']);
          assert(
            version.status === 0,
            `expected installed shim --version exit 0, got ${version.status}: ${version.stderr}`,
          );
          assert(version.stdout.trim() === '0.1.0', 'expected shim to forward --version 0.1.0');
        });
      },
    },
    {
      name: 'install-local replaces a symlink without touching its target',
      run() {
        if (process.platform === 'win32') return;
        withTempDirSync('rizz-install-symlink-smoke-', (dir) => {
          const binDir = join(dir, 'bin');
          mkdirSync(binDir, { recursive: true });
          const targetPath = join(dir, 'symlink-target');
          const shimPath = join(binDir, 'rizz');
          writeFileSync(targetPath, 'target sentinel');
          symlinkSync(targetPath, shimPath);

          const result = runInstallLocalSync(['--dir', binDir]);
          assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
          assert(readFileSync(targetPath, 'utf8') === 'target sentinel', 'symlink target changed');
          const shimStat = lstatSync(shimPath);
          assert(shimStat.isFile(), 'expected replacement shim to be a regular file');
          assert(!shimStat.isSymbolicLink(), 'expected replacement shim not to be a symlink');
        });
      },
    },
    {
      name: 'install-local replaces a dangling symlink without creating its target',
      run() {
        if (process.platform === 'win32') return;
        withTempDirSync('rizz-install-dangling-symlink-smoke-', (dir) => {
          const binDir = join(dir, 'bin');
          mkdirSync(binDir, { recursive: true });
          const targetPath = join(dir, 'missing-target');
          const shimPath = join(binDir, 'rizz');
          symlinkSync(targetPath, shimPath);

          const result = runInstallLocalSync(['--dir', binDir]);
          assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
          assert(!existsSync(targetPath), 'dangling symlink target was created');
          const shimStat = lstatSync(shimPath);
          assert(shimStat.isFile(), 'expected replacement shim to be a regular file');
          assert(!shimStat.isSymbolicLink(), 'expected replacement shim not to be a symlink');
        });
      },
    },
    {
      name: 'install-local refuses to replace an existing rizz directory',
      run() {
        if (process.platform === 'win32') return;
        withTempDirSync('rizz-install-directory-smoke-', (dir) => {
          const binDir = join(dir, 'bin');
          const shimPath = join(binDir, 'rizz');
          mkdirSync(shimPath, { recursive: true });

          const result = runInstallLocalSync(['--dir', binDir]);
          assert(result.status === 1, `expected exit 1, got ${result.status}`);
          assert(result.stderr.includes('is a directory'), 'expected directory collision message');
          assert(
            lstatSync(shimPath).isDirectory(),
            'directory collision did not remain a directory',
          );
        });
      },
    },
    {
      name: 'install-local rejects missing --dir value and unknown flags',
      run() {
        const missingDir = runInstallLocalSync(['--dir']);
        assert(missingDir.status === 2, `expected exit 2, got ${missingDir.status}`);
        assert(missingDir.stderr.includes('--dir needs a path'), 'expected missing --dir message');

        const unknown = runInstallLocalSync(['--unknown']);
        assert(unknown.status === 2, `expected exit 2, got ${unknown.status}`);
        assert(unknown.stderr.includes('unknown option'), 'expected unknown flag message');
      },
    },
  ];

  for (const check of checks) {
    try {
      check.run();
      smokePassed += 1;
      console.log(`  ✓ ${check.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ ${check.name}`);
      console.log(`    ${message}`);
    }
  }

  console.log(`\n${smokePassed}/${checks.length} install-local smoke check(s) passed`);
  return smokePassed === checks.length;
}

const smokeOk = await runHeadlessSmoke();
const installSmokeOk = runInstallShimSmoke();
process.exit(piBenchResult.ok && smokeOk && installSmokeOk ? 0 : 1);
