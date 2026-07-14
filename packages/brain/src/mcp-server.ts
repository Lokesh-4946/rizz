import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  SUPPORTED_SKILL_AGENTS,
  compileTaskBrief,
  completeLoopWork,
  createLoopHandoff,
  readLoopStatus,
  recordLoopCheckpoint,
} from './context-loop.js';
import { explainCurrentProject } from './current-project.js';
import {
  type MissionAgent,
  type MissionCitation,
  type MissionPreview,
  type MissionPreviewOptions,
  previewMission,
} from './mission-contract.js';
import { prepareProjectStore } from './project-store.js';
import { readResourceStatus } from './resource-governance.js';
import { redactSensitiveText } from './sensitivity.js';

interface McpServerOptions {
  readonly rootDir: string;
  readonly rizzHome?: string;
  readonly write: (line: string) => void;
}

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

interface ToolResult {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: unknown;
  readonly isError?: boolean;
}

const RESOURCES = [
  ['rizz://project/current', 'Current project identity', 'application/json'],
  ['rizz://brain/summary', 'Current repository intelligence summary', 'application/json'],
  ['rizz://product/current', 'Current approved product context', 'text/markdown'],
  ['rizz://sprint/current', 'Current sprint context', 'text/markdown'],
  ['rizz://loop/status', 'Current engineering loop state', 'application/json'],
  ['rizz://review/latest', 'Latest deterministic review packet', 'application/json'],
  ['rizz://resources/status', 'Current resource policy and active leases', 'application/json'],
] as const;

const MISSION_OPTION_PROPERTIES = {
  scope: { type: 'array', items: { type: 'string' } },
  scope_status: { type: 'string', enum: ['open', 'proposed', 'accepted'] },
  requested_skills: { type: 'array', items: { type: 'string' } },
  approved_skill_risks: { type: 'array', items: { type: 'string' } },
  constraints: { type: 'array', items: { type: 'string' } },
  stop_conditions: { type: 'array', items: { type: 'string' } },
  required_behavior: { type: 'array', items: { type: 'string' } },
  non_goals: { type: 'array', items: { type: 'string' } },
  verification_checks: { type: 'array', items: { type: 'string' } },
  uncertainty_notes: { type: 'array', items: { type: 'string' } },
  proposed_constraints: { type: 'array', items: { type: 'object' } },
  proposed_non_goals: { type: 'array', items: { type: 'object' } },
  risks: { type: 'array', items: { type: 'object' } },
} as const;

const TOOLS = [
  {
    name: 'get_task_brief',
    description: 'Compile a bounded, evidence-backed task packet for the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        agent: { type: 'string', enum: SUPPORTED_SKILL_AGENTS },
        ...MISSION_OPTION_PROPERTIES,
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_mission',
    description:
      'Preview a versioned mission with verified skill identities and provenance-bearing proposals.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        agent: { type: 'string', enum: ['codex', 'claude', 'copilot'] },
        ...MISSION_OPTION_PROPERTIES,
      },
      required: ['task', 'agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_file',
    description: 'Explain one repository file with direct evidence and confidence.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_flow',
    description: 'Explain one reconstructed repository flow.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_review_packet',
    description: 'Read the latest deterministic review packet.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'record_checkpoint',
    description: 'Record a sequence-guarded work checkpoint.',
    inputSchema: mutationSchema({ summary: { type: 'string' } }, ['summary']),
  },
  {
    name: 'complete_work',
    description: 'Complete the active work item with a sequence-guarded summary.',
    inputSchema: mutationSchema({ summary: { type: 'string' } }, ['summary']),
  },
  {
    name: 'create_handoff',
    description: 'Create a durable handoff for the active work item.',
    inputSchema: mutationSchema({ summary: { type: 'string' }, next_baton: { type: 'string' } }, [
      'summary',
      'next_baton',
    ]),
  },
] as const;

function mutationSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      repository_revision: { type: 'string' },
      sequence: { type: 'integer', minimum: 0 },
      ...properties,
    },
    required: ['project_id', 'repository_revision', 'sequence', ...required],
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function revision(rootDir: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null;
}

function result(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(code: string, message: string): ToolResult {
  const value = { code, message: redactSensitiveText(message) };
  return { ...result(value), isError: true };
}

function stringList(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function missionAgent(value: unknown): MissionAgent | null {
  return value === 'codex' || value === 'claude' || value === 'copilot' ? value : null;
}

function citation(value: unknown): MissionCitation | null {
  if (!isRecord(value) || typeof value.value !== 'string') return null;
  if (value.kind === 'path' || value.kind === 'evidence') {
    return { kind: value.kind, value: value.value };
  }
  if (value.kind === 'symbol' && typeof value.path === 'string') {
    return { kind: 'symbol', value: value.value, path: value.path };
  }
  return null;
}

function citations(value: unknown): readonly MissionCitation[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(citation);
  return parsed.every((item): item is MissionCitation => item !== null) ? parsed : null;
}

function proposedInputs(value: unknown): MissionPreviewOptions['proposedConstraints'] | null {
  if (!Array.isArray(value)) return null;
  const result: Array<{ statement: string; citations: readonly MissionCitation[] }> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.statement !== 'string') return null;
    const parsedCitations = citations(item.citations);
    if (parsedCitations === null) return null;
    result.push({ statement: item.statement, citations: parsedCitations });
  }
  return result;
}

function riskInputs(value: unknown): MissionPreviewOptions['risks'] | null {
  if (!Array.isArray(value)) return null;
  const result: Array<NonNullable<MissionPreviewOptions['risks']>[number]> = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.statement !== 'string' ||
      (item.provenance !== 'explicit' &&
        item.provenance !== 'deterministic_signal' &&
        item.provenance !== 'ai_inferred')
    ) {
      return null;
    }
    const parsedCitations = item.citations === undefined ? [] : citations(item.citations);
    if (parsedCitations === null) return null;
    result.push({
      statement: item.statement,
      provenance: item.provenance,
      citations: parsedCitations,
    });
  }
  return result;
}

function missionOptions(
  options: McpServerOptions,
  args: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly value: MissionPreviewOptions } | { readonly ok: false } {
  const agent = missionAgent(args.agent);
  if (typeof args.task !== 'string' || agent === null) return { ok: false };
  const listFields = [
    ['scope', 'scope'],
    ['requested_skills', 'requestedSkills'],
    ['approved_skill_risks', 'approvedSkillRisks'],
    ['constraints', 'constraints'],
    ['stop_conditions', 'stopConditions'],
    ['required_behavior', 'requiredBehavior'],
    ['non_goals', 'nonGoals'],
    ['verification_checks', 'verificationChecks'],
    ['uncertainty_notes', 'uncertaintyNotes'],
  ] as const;
  const parsedLists: Record<string, readonly string[]> = {};
  for (const [wireName, optionName] of listFields) {
    if (args[wireName] === undefined) continue;
    const parsed = stringList(args[wireName]);
    if (parsed === null) return { ok: false };
    parsedLists[optionName] = parsed;
  }
  if (
    args.scope_status !== undefined &&
    args.scope_status !== 'open' &&
    args.scope_status !== 'proposed' &&
    args.scope_status !== 'accepted'
  ) {
    return { ok: false };
  }
  const proposedConstraints =
    args.proposed_constraints === undefined ? undefined : proposedInputs(args.proposed_constraints);
  const proposedNonGoals =
    args.proposed_non_goals === undefined ? undefined : proposedInputs(args.proposed_non_goals);
  const risks = args.risks === undefined ? undefined : riskInputs(args.risks);
  if (proposedConstraints === null || proposedNonGoals === null || risks === null) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      ...options,
      task: args.task,
      agent,
      ...parsedLists,
      ...(args.scope_status === undefined ? {} : { scopeStatus: args.scope_status }),
      ...(proposedConstraints === undefined ? {} : { proposedConstraints }),
      ...(proposedNonGoals === undefined ? {} : { proposedNonGoals }),
      ...(risks === undefined ? {} : { risks }),
    },
  };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function readOptional(path: string): Promise<string> {
  try {
    return redactSensitiveText(await readFile(path, 'utf8'));
  } catch {
    return '';
  }
}

async function resourceValue(
  options: McpServerOptions,
  uri: string,
): Promise<{ readonly mimeType: string; readonly text: string } | null> {
  const store = await prepareProjectStore(options);
  if (!store.ok) return null;
  switch (uri) {
    case 'rizz://project/current':
      return {
        mimeType: 'application/json',
        text: await readOptional(join(store.value.projectDir, 'project.json')),
      };
    case 'rizz://brain/summary':
      return {
        mimeType: 'application/json',
        text: await readOptional(join(store.value.brainDir, 'latest.json')),
      };
    case 'rizz://product/current':
      return {
        mimeType: 'text/markdown',
        text: await readOptional(join(store.value.projectDir, 'product', 'current.md')),
      };
    case 'rizz://sprint/current':
      return {
        mimeType: 'text/markdown',
        text: await readOptional(join(store.value.projectDir, 'planning', 'sprint.md')),
      };
    case 'rizz://loop/status': {
      const loop = await readLoopStatus(options);
      return { mimeType: 'application/json', text: JSON.stringify(loop) };
    }
    case 'rizz://review/latest':
      return {
        mimeType: 'application/json',
        text: await readOptional(join(store.value.brainDir, 'entities', 'reviews.json')),
      };
    case 'rizz://resources/status': {
      const status = await readResourceStatus(options);
      return {
        mimeType: 'application/json',
        text: JSON.stringify(status.ok ? status.value : status.error),
      };
    }
    default:
      return null;
  }
}

async function validateMutation(
  options: McpServerOptions,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult | null> {
  const store = await prepareProjectStore(options);
  if (!store.ok) return toolError(store.error.code, store.error.message);
  if (args.project_id !== store.value.projectId) {
    return toolError(
      'MCP_PROJECT_MISMATCH',
      'Mutation project ID does not match the current project.',
    );
  }
  if (args.repository_revision !== revision(options.rootDir)) {
    return toolError(
      'MCP_REVISION_MISMATCH',
      'Mutation repository revision does not match the current checkout.',
    );
  }
  if (!Number.isInteger(args.sequence)) {
    return toolError('MCP_SEQUENCE_REQUIRED', 'Mutation requires an integer loop sequence.');
  }
  return null;
}

async function callTool(
  options: McpServerOptions,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  if (name === 'preview_mission') {
    const parsed = missionOptions(options, args);
    if (!parsed.ok) return toolError('MCP_ARGUMENT_INVALID', 'Mission arguments are invalid.');
    const preview = await previewMission(parsed.value);
    return preview.ok
      ? result(preview.value)
      : toolError(preview.error.code, preview.error.message);
  }
  if (name === 'get_task_brief') {
    if (typeof args.task !== 'string')
      return toolError('MCP_ARGUMENT_INVALID', 'task is required.');
    if (args.agent !== undefined && typeof args.agent !== 'string')
      return toolError('MCP_ARGUMENT_INVALID', 'agent must be a string.');
    let mission: MissionPreview | undefined;
    const agent = missionAgent(args.agent);
    if (agent !== null) {
      const parsed = missionOptions(options, args);
      if (!parsed.ok) return toolError('MCP_ARGUMENT_INVALID', 'Mission arguments are invalid.');
      const preview = await previewMission(parsed.value);
      if (!preview.ok) return toolError(preview.error.code, preview.error.message);
      mission = preview.value;
    }
    const brief = await compileTaskBrief({
      ...options,
      task: args.task,
      ...(typeof args.agent === 'string' ? { agent: args.agent } : {}),
      ...(mission === undefined ? {} : { mission }),
    });
    return brief.ok ? result(brief.value) : toolError(brief.error.code, brief.error.message);
  }
  if (name === 'explain_file' || name === 'explain_flow') {
    const key = name === 'explain_file' ? 'path' : 'id';
    const value = args[key];
    if (typeof value !== 'string') return toolError('MCP_ARGUMENT_INVALID', `${key} is required.`);
    const target = name === 'explain_flow' && !value.startsWith('flow:') ? `flow:${value}` : value;
    const explanation = await explainCurrentProject({
      rootDir: options.rootDir,
      ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
      target,
    });
    return explanation.ok
      ? result(explanation.value)
      : toolError(explanation.error.code, explanation.error.message);
  }
  if (name === 'get_review_packet') {
    const value = await resourceValue(options, 'rizz://review/latest');
    return result(value?.text === '' || value === null ? {} : JSON.parse(value.text));
  }
  if (name !== 'record_checkpoint' && name !== 'complete_work' && name !== 'create_handoff') {
    return toolError('MCP_TOOL_UNKNOWN', `Unknown tool: ${name}`);
  }
  const invalid = await validateMutation(options, args);
  if (invalid !== null) return invalid;
  const sequence = args.sequence as number;
  if (typeof args.summary !== 'string')
    return toolError('MCP_ARGUMENT_INVALID', 'summary is required.');
  if (name === 'record_checkpoint') {
    const checkpoint = await recordLoopCheckpoint({
      rootDir: options.rootDir,
      ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
      summary: args.summary,
      expectedSequence: sequence,
    });
    return checkpoint.ok
      ? result(checkpoint.value)
      : toolError(checkpoint.error.code, checkpoint.error.message);
  }
  if (name === 'complete_work') {
    const completed = await completeLoopWork({
      rootDir: options.rootDir,
      ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
      summary: args.summary,
      expectedSequence: sequence,
    });
    return completed.ok
      ? result(completed.value)
      : toolError(completed.error.code, completed.error.message);
  }
  if (typeof args.next_baton !== 'string') {
    return toolError('MCP_ARGUMENT_INVALID', 'next_baton is required.');
  }
  const handoff = await createLoopHandoff({
    rootDir: options.rootDir,
    ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
    summary: args.summary,
    nextBaton: args.next_baton,
    expectedSequence: sequence,
  });
  return handoff.ok ? result(handoff.value) : toolError(handoff.error.code, handoff.error.message);
}

export function createMcpServer(options: McpServerOptions): {
  readonly handle: (line: string) => Promise<void>;
} {
  const send = (message: unknown): void => options.write(`${JSON.stringify(message)}\n`);
  let isInitialized = false;
  return {
    async handle(line: string): Promise<void> {
      let request: JsonRpcRequest;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
          send(rpcError(null, -32600, 'Invalid Request'));
          return;
        }
        request = parsed as unknown as JsonRpcRequest;
      } catch {
        send(rpcError(null, -32700, 'Parse error'));
        return;
      }
      if (request.id === undefined) return;
      if (request.method === 'initialize') {
        isInitialized = true;
        send({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { resources: {}, tools: {} },
            serverInfo: { name: 'rizz', version: '0.3.1' },
          },
        });
        return;
      }
      if (
        !isInitialized &&
        (request.method.startsWith('resources/') || request.method.startsWith('tools/'))
      ) {
        send(rpcError(request.id, -32002, 'Server not initialized'));
        return;
      }
      if (request.method === 'resources/list') {
        send({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            resources: RESOURCES.map(([uri, name, mimeType]) => ({ uri, name, mimeType })),
          },
        });
        return;
      }
      if (request.method === 'resources/read') {
        const uri = isRecord(request.params) ? request.params.uri : undefined;
        if (typeof uri !== 'string') {
          send(rpcError(request.id, -32602, 'Resource URI is required.'));
          return;
        }
        const value = await resourceValue(options, uri);
        if (value === null) {
          send(rpcError(request.id, -32602, `Unknown resource: ${uri}`));
          return;
        }
        send({
          jsonrpc: '2.0',
          id: request.id,
          result: { contents: [{ uri, mimeType: value.mimeType, text: value.text }] },
        });
        return;
      }
      if (request.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } });
        return;
      }
      if (request.method === 'tools/call') {
        const params = isRecord(request.params) ? request.params : {};
        const name = params.name;
        const args = isRecord(params.arguments) ? params.arguments : {};
        if (typeof name !== 'string') {
          send(rpcError(request.id, -32602, 'Tool name is required.'));
          return;
        }
        send({ jsonrpc: '2.0', id: request.id, result: await callTool(options, name, args) });
        return;
      }
      if (request.method === 'ping') {
        send({ jsonrpc: '2.0', id: request.id, result: {} });
        return;
      }
      send(rpcError(request.id, -32601, 'Method not found'));
    },
  };
}

export async function serveMcpStdio(options: {
  readonly rootDir: string;
  readonly input: Readable;
  readonly write: (line: string) => void;
}): Promise<void> {
  const server = createMcpServer(options);
  const lines = createInterface({ input: options.input });
  for await (const line of lines) await server.handle(line);
}
