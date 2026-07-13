import { homedir } from 'node:os';
import { join } from 'node:path';
import { pinAcquiredSkill, previewAcquiredSkill } from './acquired-skill-selection.js';
import { executeAgentCommand } from './agent-bridges.js';
import {
  acquireApprovedSkillSource,
  previewApprovedSkillSource,
  searchApprovedSkillSources,
} from './approved-skill-sources.js';
import {
  compileTaskBrief,
  completeLoopWork,
  createLoopHandoff,
  readLoopStatus,
  recordLoopCheckpoint,
  startLoopWork,
} from './context-loop.js';
import { enablePinnedSkill, listEnabledProjectSkills } from './project-skill-enablement.js';
import { resolveRizzHome } from './project-store.js';
import {
  type ResourcePolicy,
  acquireResourceLease,
  configureResourcePolicy,
  readResourceStatus,
  releaseResourceLease,
} from './resource-governance.js';
import { scanSkillCollection } from './skill-collection-compatibility.js';
import { searchAcquiredSkills } from './skill-discovery-index.js';
import { applySkillUpdate, previewSkillUpdate, removeProjectSkill } from './skill-lifecycle.js';
import { doctorSkillRegistry } from './skill-registry-doctor.js';
import { addPinnedSkill, auditSkillSource, inspectSkillSource } from './skill-source-manager.js';
import {
  applyVaultImport,
  inspectVault,
  previewVaultImport,
  reconcileVaultImport,
} from './vault-import.js';

export interface ContextCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ParsedFlag {
  readonly value?: string;
  readonly rest: readonly string[];
  readonly missing: boolean;
}

function flag(args: readonly string[], name: string): ParsedFlag {
  const index = args.indexOf(name);
  if (index < 0) return { rest: args, missing: false };
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) return { rest: args, missing: true };
  return { value, rest: [...args.slice(0, index), ...args.slice(index + 2)], missing: false };
}

function repeatedFlag(
  args: readonly string[],
  name: string,
): { values: string[]; rest: string[]; missing: boolean } {
  const values: string[] = [];
  const rest: string[] = [];
  let missing = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      rest.push(args[index] ?? '');
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) missing = true;
    else {
      values.push(value);
      index += 1;
    }
  }
  return { values, rest, missing };
}

function failed(code: string, message: string): ContextCommandResult {
  return { exitCode: 2, stdout: '', stderr: `rizz: ${code}: ${message}\n` };
}

function rendered(value: unknown, json: boolean, summary: string): ContextCommandResult {
  return {
    exitCode: 0,
    stdout: json ? `${JSON.stringify(value)}\n` : `${summary}\n`,
    stderr: '',
  };
}

function resultError(result: {
  readonly error: { readonly code: string; readonly message: string };
}): ContextCommandResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: `rizz: ${result.error.code}: ${result.error.message}\n`,
  };
}

function sequenceFlag(args: readonly string[]): {
  value?: number;
  rest: readonly string[];
  invalid: boolean;
} {
  const parsed = flag(args, '--sequence');
  if (parsed.missing) return { rest: parsed.rest, invalid: true };
  if (parsed.value === undefined) return { rest: parsed.rest, invalid: false };
  const value = Number(parsed.value);
  return Number.isInteger(value) && value >= 0
    ? { value, rest: parsed.rest, invalid: false }
    : { rest: parsed.rest, invalid: true };
}

function nextLoopAction(status: string): string {
  switch (status) {
    case 'started':
      return 'plan';
    case 'planning':
      return 'implement';
    case 'implementing':
      return 'verify';
    case 'verifying':
      return 'review';
    case 'reviewing':
      return 'complete';
    default:
      return 'start';
  }
}

async function executeResourceCommand(
  rootDir: string,
  args: readonly string[],
  wantsJson: boolean,
): Promise<ContextCommandResult> {
  const action = args[1];
  if (action === 'status' && args.length === 2) {
    const result = await readResourceStatus({ rootDir });
    return result.ok
      ? rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2))
      : resultError(result);
  }
  if (action === 'lease') {
    const work = flag(args.slice(2), '--work-id');
    const agent = flag(work.rest, '--agent');
    if (work.missing || agent.missing || work.value === undefined || agent.value === undefined) {
      return failed('RESOURCE_LEASE_USAGE', 'Resource lease needs --work-id and --agent.');
    }
    if (agent.rest.length > 0)
      return failed('RESOURCE_OPTION_UNKNOWN', `Unknown option '${agent.rest[0]}'.`);
    const result = await acquireResourceLease({ rootDir, workId: work.value, agent: agent.value });
    return result.ok
      ? rendered(result.value, wantsJson, `rizz resource lease ${result.value.lease_id}`)
      : resultError(result);
  }
  if (action === 'release') {
    const lease = flag(args.slice(2), '--lease-id');
    if (lease.missing || lease.value === undefined || lease.rest.length > 0) {
      return failed('RESOURCE_RELEASE_USAGE', 'Resource release needs --lease-id.');
    }
    const result = await releaseResourceLease({ rootDir, leaseId: lease.value });
    return result.ok
      ? rendered(result.value, wantsJson, `rizz resource released ${result.value.released}`)
      : resultError(result);
  }
  if (action === 'configure') {
    const mapping = [
      ['--max-agents', 'max_concurrent_agents'],
      ['--context-bytes', 'max_context_bytes'],
      ['--lease-ms', 'lease_ms'],
      ['--command-ms', 'max_command_ms'],
      ['--provider-cents', 'max_provider_cost_cents'],
    ] as const;
    let rest: readonly string[] = args.slice(2);
    const policy: { -readonly [Key in keyof ResourcePolicy]?: number } = {};
    for (const [option, field] of mapping) {
      const parsed = flag(rest, option);
      if (parsed.missing) return failed('RESOURCE_FLAG_VALUE_REQUIRED', `${option} needs a value.`);
      if (parsed.value !== undefined) {
        const value = Number(parsed.value);
        if (!Number.isInteger(value))
          return failed('RESOURCE_FLAG_INVALID', `${option} must be an integer.`);
        policy[field] = value;
      }
      rest = parsed.rest;
    }
    if (rest.length > 0) return failed('RESOURCE_OPTION_UNKNOWN', `Unknown option '${rest[0]}'.`);
    if (Object.keys(policy).length === 0)
      return failed('RESOURCE_POLICY_REQUIRED', 'Configure needs at least one policy flag.');
    const result = await configureResourcePolicy({ rootDir, policy });
    return result.ok
      ? rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2))
      : resultError(result);
  }
  return failed(
    'RESOURCE_ACTION_UNKNOWN',
    'Resources supports status, configure, lease, and release.',
  );
}

async function executeSkillCommand(
  rootDir: string,
  args: readonly string[],
  wantsJson: boolean,
  rizzHome: string,
): Promise<ContextCommandResult> {
  const action = args[1];
  const sourceDir = args[2];
  if (action === 'sources') {
    const query = args.slice(2).join(' ').trim();
    const result = searchApprovedSkillSources({ query });
    return rendered(result, wantsJson, JSON.stringify(result, null, 2));
  }
  if (action === 'search') {
    const source = flag(args.slice(2), '--source');
    const pin = flag(source.rest, '--pin');
    const limit = flag(pin.rest, '--limit');
    if (
      source.missing ||
      pin.missing ||
      limit.missing ||
      (source.value === undefined) !== (pin.value === undefined)
    )
      return failed(
        'SKILL_SEARCH_USAGE',
        'Use skills search [query] [--source <source-id> --pin <commit>] [--limit <1-100>].',
      );
    const parsedLimit = limit.value === undefined ? undefined : Number(limit.value);
    const result = await searchAcquiredSkills({
      rizzHome,
      repositoryRoot: rootDir,
      query: limit.rest.join(' ').trim(),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      ...(source.value === undefined ? {} : { sourceId: source.value }),
      ...(pin.value === undefined ? {} : { revision: pin.value }),
    });
    return result.ok
      ? rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2))
      : resultError(result);
  }
  if (action === 'fetch' && sourceDir !== undefined) {
    const pin = flag(args.slice(3), '--pin');
    const isPreview = pin.rest.includes('--preview');
    const isApply = pin.rest.includes('--apply');
    const approved = pin.rest.includes('--approve');
    const rest = pin.rest.filter(
      (arg) => arg !== '--preview' && arg !== '--apply' && arg !== '--approve',
    );
    if (
      pin.missing ||
      pin.value === undefined ||
      isPreview === isApply ||
      rest.length > 0 ||
      (isApply && !approved)
    )
      return failed(
        'SKILL_FETCH_USAGE',
        'Use skills fetch <source-id> --pin <commit> --preview or --apply --approve.',
      );
    const result = isApply
      ? await acquireApprovedSkillSource({
          id: sourceDir,
          revision: pin.value,
          rizzHome,
          approved,
        })
      : previewApprovedSkillSource({ id: sourceDir, revision: pin.value });
    return result.ok
      ? rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2))
      : resultError(result);
  }
  if (action === 'scan' && sourceDir !== undefined) {
    const pin = flag(args.slice(3), '--pin');
    if (pin.missing || pin.value === undefined || pin.rest.length > 0)
      return failed('SKILL_SCAN_USAGE', 'Use skills scan <source-id> --pin <commit>.');
    const preview = previewApprovedSkillSource({ id: sourceDir, revision: pin.value });
    if (!preview.ok) return resultError(preview);
    const result = await scanSkillCollection({
      checkoutDir: join(rizzHome, 'global', 'skills', 'sources', sourceDir, pin.value),
    });
    return result.ok
      ? rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2))
      : resultError(result);
  }
  if (action === 'pin' && sourceDir !== undefined) {
    const pin = flag(args.slice(3), '--pin');
    const skillPath = flag(pin.rest, '--path');
    const isPreview = skillPath.rest.includes('--preview');
    const isApply = skillPath.rest.includes('--apply');
    const approved = skillPath.rest.includes('--approve');
    const rest = skillPath.rest.filter(
      (arg) => arg !== '--preview' && arg !== '--apply' && arg !== '--approve',
    );
    if (
      pin.missing ||
      pin.value === undefined ||
      skillPath.missing ||
      skillPath.value === undefined ||
      isPreview === isApply ||
      rest.length > 0 ||
      (isApply && !approved)
    )
      return failed(
        'SKILL_PIN_USAGE',
        'Use skills pin <source-id> --pin <commit> --path <skill-path> --preview or --apply --approve.',
      );
    const options = {
      rizzHome,
      sourceId: sourceDir,
      revision: pin.value,
      skillPath: skillPath.value,
    };
    const result = isApply
      ? await pinAcquiredSkill({ ...options, approved })
      : await previewAcquiredSkill(options);
    return result.ok
      ? rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2))
      : resultError(result);
  }
  if (action === 'doctor') {
    const repair = args.slice(2).includes('--repair');
    const approved = args.slice(2).includes('--approve');
    const rest = args.slice(2).filter((arg) => arg !== '--repair' && arg !== '--approve');
    if (rest.length > 0)
      return failed('SKILL_DOCTOR_USAGE', 'Use skills doctor [--repair --approve].');
    const result = await doctorSkillRegistry({ rizzHome, repair, approved });
    return result.ok
      ? rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2))
      : resultError(result);
  }
  if (action === 'list' && args.length === 2) {
    const result = await listEnabledProjectSkills({ rootDir, rizzHome });
    return result.ok
      ? rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2))
      : resultError(result);
  }
  if (action === 'enable' && sourceDir !== undefined) {
    const agents = repeatedFlag(args.slice(3), '--agent');
    const approved = agents.rest.includes('--approve');
    const rest = agents.rest.filter((arg) => arg !== '--approve');
    if (agents.missing || agents.values.length === 0 || rest.length > 0) {
      return failed(
        'SKILL_ENABLE_USAGE',
        'Use skills enable <name> --agent <agent> [--agent <agent>] --approve.',
      );
    }
    const result = await enablePinnedSkill({
      rootDir,
      rizzHome,
      name: sourceDir,
      agents: agents.values,
      approved,
    });
    return result.ok
      ? rendered(result.value, wantsJson, `rizz skill enabled ${result.value.name}`)
      : resultError(result);
  }
  if (action === 'update' && sourceDir !== undefined) {
    const pin = flag(args.slice(3), '--pin');
    const isPreview = pin.rest.includes('--preview');
    const isApply = pin.rest.includes('--apply');
    const approved = pin.rest.includes('--approve');
    const rest = pin.rest.filter(
      (arg) => arg !== '--preview' && arg !== '--apply' && arg !== '--approve',
    );
    if (
      pin.missing ||
      pin.value === undefined ||
      isPreview === isApply ||
      rest.length > 0 ||
      (isApply && !approved)
    ) {
      return failed(
        'SKILL_UPDATE_USAGE',
        'Use skills update <source> --pin <revision> --preview or --apply --approve.',
      );
    }
    const result = isApply
      ? await applySkillUpdate({
          rootDir,
          rizzHome,
          sourceDir,
          revision: pin.value,
          approved,
        })
      : await previewSkillUpdate({ rootDir, rizzHome, sourceDir, revision: pin.value });
    return result.ok
      ? rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2))
      : resultError(result);
  }
  if (action === 'remove' && sourceDir !== undefined) {
    const approved = args.slice(3).includes('--approve');
    const rest = args.slice(3).filter((arg) => arg !== '--approve');
    if (!approved || rest.length > 0) {
      return failed('SKILL_REMOVE_USAGE', 'Use skills remove <name> --approve.');
    }
    const result = await removeProjectSkill({
      rootDir,
      rizzHome,
      name: sourceDir,
      approved,
    });
    return result.ok
      ? rendered(result.value, wantsJson, `rizz skill removed ${result.value.removed}`)
      : resultError(result);
  }
  if (
    (action === 'inspect' || action === 'audit') &&
    sourceDir !== undefined &&
    args.length === 3
  ) {
    const result =
      action === 'inspect'
        ? await inspectSkillSource({ sourceDir })
        : await auditSkillSource({ sourceDir });
    return result.ok
      ? rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2))
      : resultError(result);
  }
  if (action === 'add' && sourceDir !== undefined) {
    const pin = flag(args.slice(3), '--pin');
    const approved = pin.rest.includes('--approve');
    const rest = pin.rest.filter((arg) => arg !== '--approve');
    if (pin.missing || pin.value === undefined || rest.length > 0) {
      return failed('SKILL_ADD_USAGE', 'Use skills add <source> --pin <revision> --approve.');
    }
    const result = await addPinnedSkill({
      sourceDir,
      rizzHome,
      revision: pin.value,
      approved,
    });
    return result.ok
      ? rendered(
          result.value,
          wantsJson,
          `rizz skill pinned ${result.value.name}@${result.value.source_revision}`,
        )
      : resultError(result);
  }
  return failed(
    'SKILL_ACTION_UNKNOWN',
    'Skills supports search, fetch, scan, pin, inspect, audit, add --pin, enable, list, update, remove, and doctor.',
  );
}

async function executeVaultCommand(
  rootDir: string,
  args: readonly string[],
  wantsJson: boolean,
): Promise<ContextCommandResult> {
  const action = args[1];
  if (action === 'inspect') {
    const sourceDir = args[2];
    if (sourceDir === undefined || args.length !== 3)
      return failed('VAULT_SOURCE_REQUIRED', 'Vault inspect needs one source directory.');
    const result = await inspectVault({ sourceDir });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2));
  }
  if (action === 'import') {
    const sourceDir = args[2];
    const mode = args[3];
    if (
      sourceDir === undefined ||
      (mode !== '--preview' && mode !== '--apply') ||
      args.length !== 4
    ) {
      return failed('VAULT_IMPORT_USAGE', 'Use vault import <source> --preview or --apply.');
    }
    const result =
      mode === '--apply'
        ? await applyVaultImport({ rootDir, sourceDir })
        : await previewVaultImport({ rootDir, sourceDir });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2));
  }
  if (action === 'reconcile' && args.length === 2) {
    const result = await reconcileVaultImport({ rootDir });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2));
  }
  return failed('VAULT_ACTION_UNKNOWN', 'Vault supports inspect, import, and reconcile.');
}

export async function executeContextCommand(options: {
  readonly rootDir: string;
  readonly args: readonly string[];
  readonly rizzHome?: string;
}): Promise<ContextCommandResult> {
  const wantsJson = options.args.includes('--json');
  const args = options.args.filter((arg) => arg !== '--json');
  if (args[0] === 'agents') {
    const result = await executeAgentCommand({ args: options.args, homeDir: homedir() });
    if (!result.ok) return failed(result.error.code, result.error.message);
    return {
      exitCode: result.value.command === 'doctor' && !result.value.healthy ? 1 : 0,
      stdout: wantsJson
        ? `${JSON.stringify(result.value)}\n`
        : `${JSON.stringify(result.value, null, 2)}\n`,
      stderr: '',
    };
  }
  if (args[0] === 'resources') return executeResourceCommand(options.rootDir, args, wantsJson);
  if (args[0] === 'skills')
    return executeSkillCommand(
      options.rootDir,
      args,
      wantsJson,
      options.rizzHome ?? resolveRizzHome({ homeDir: homedir() }),
    );
  if (args[0] === 'vault') return executeVaultCommand(options.rootDir, args, wantsJson);
  if (args[0] === 'brief') {
    const agent = flag(args.slice(1), '--agent');
    if (agent.missing) return failed('BRIEF_AGENT_REQUIRED', 'Brief --agent needs a value.');
    const unknownOption = agent.rest.find((argument) => argument.startsWith('--'));
    if (unknownOption !== undefined)
      return failed('BRIEF_OPTION_UNKNOWN', `Unknown option '${unknownOption}'.`);
    const task = agent.rest.join(' ').trim();
    if (task === '') return failed('BRIEF_TASK_REQUIRED', 'Brief needs a task.');
    const result = await compileTaskBrief({
      rootDir: options.rootDir,
      rizzHome: options.rizzHome ?? resolveRizzHome({ homeDir: homedir() }),
      task,
      ...(agent.value === undefined ? {} : { agent: agent.value }),
    });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, JSON.stringify(result.value, null, 2));
  }
  if (args[0] !== 'loop') return failed('CONTEXT_COMMAND_UNKNOWN', 'Expected brief or loop.');
  const action = args[1];
  const actionArgs = args.slice(2);
  if (action === 'status' || action === 'next') {
    if (actionArgs.length > 0)
      return failed('LOOP_OPTION_UNKNOWN', `Unknown option '${actionArgs[0]}'.`);
    const result = await readLoopStatus({ rootDir: options.rootDir });
    if (!result.ok) return resultError(result);
    const next = nextLoopAction(result.value.status);
    return rendered(
      action === 'next' ? { ...result.value, next } : result.value,
      wantsJson,
      action === 'next'
        ? `rizz loop next: ${next}`
        : `rizz loop ${result.value.status} at sequence ${result.value.sequence}`,
    );
  }
  if (action === 'start') {
    const task = flag(actionArgs, '--task');
    const agent = flag(task.rest, '--agent');
    const scopes = repeatedFlag(agent.rest, '--scope');
    if (task.missing || agent.missing || scopes.missing)
      return failed('LOOP_FLAG_VALUE_REQUIRED', 'Loop flags need values.');
    if (task.value === undefined || agent.value === undefined)
      return failed('LOOP_START_REQUIRED', 'Loop start needs --task and --agent.');
    if (scopes.rest.length > 0)
      return failed('LOOP_OPTION_UNKNOWN', `Unknown option '${scopes.rest[0]}'.`);
    const result = await startLoopWork({
      rootDir: options.rootDir,
      task: task.value,
      agent: agent.value,
      scope: scopes.values,
    });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, `rizz loop started ${result.value.work_id}`);
  }
  const summary = flag(actionArgs, '--summary');
  const sequence = sequenceFlag(summary.rest);
  if (summary.missing || sequence.invalid)
    return failed('LOOP_FLAG_VALUE_REQUIRED', 'Loop flags need valid values.');
  if (summary.value === undefined)
    return failed('LOOP_SUMMARY_REQUIRED', `Loop ${action ?? 'action'} needs --summary.`);
  if (action === 'handoff') {
    const next = flag(sequence.rest, '--next-baton');
    if (next.missing || next.value === undefined)
      return failed('LOOP_HANDOFF_REQUIRED', 'Loop handoff needs --next-baton.');
    if (next.rest.length > 0)
      return failed('LOOP_OPTION_UNKNOWN', `Unknown option '${next.rest[0]}'.`);
    const result = await createLoopHandoff({
      rootDir: options.rootDir,
      summary: summary.value,
      nextBaton: next.value,
      ...(sequence.value === undefined ? {} : { expectedSequence: sequence.value }),
    });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, `rizz loop handoff ${result.value.handoff_path}`);
  }
  if (sequence.rest.length > 0)
    return failed('LOOP_OPTION_UNKNOWN', `Unknown option '${sequence.rest[0]}'.`);
  if (action === 'complete') {
    const result = await completeLoopWork({
      rootDir: options.rootDir,
      summary: summary.value,
      ...(sequence.value === undefined ? {} : { expectedSequence: sequence.value }),
    });
    if (!result.ok) return resultError(result);
    return rendered(result.value, wantsJson, `rizz loop completed ${result.value.work_id}`);
  }
  const statuses = {
    checkpoint: 'implementing',
    verify: 'verifying',
    review: 'reviewing',
  } as const;
  if (action !== 'checkpoint' && action !== 'verify' && action !== 'review') {
    return failed('LOOP_ACTION_UNKNOWN', `Unknown loop action '${action ?? ''}'.`);
  }
  const result = await recordLoopCheckpoint({
    rootDir: options.rootDir,
    summary: summary.value,
    status: statuses[action],
    ...(sequence.value === undefined ? {} : { expectedSequence: sequence.value }),
  });
  if (!result.ok) return resultError(result);
  return rendered(
    result.value,
    wantsJson,
    `rizz loop ${result.value.status} at sequence ${result.value.sequence}`,
  );
}
