// dispatchTool — the tool-execution service (design §3.2). It validates the model's tool call,
// resolves paths through the platform service, routes to one of the four tool implementations, and
// returns a structured ToolResult split into `forModel` (fed back to the LLM) and `forDisplay` (a
// compact TUI line) — Pi's structured-split design (pi-teardown §4).
//
// The bash safety handshake lives here as a CLASSIFY-then-ask: the service classifies the command
// and, when approval is required, calls back to the loop via `onApprovalNeeded`. The service never
// self-approves (ADR-001 rule 7). It also never touches Session or BudgetState — explicit params in,
// structured result out.

import { type Result, RizzError, err, ok } from '../result.js';
import { resolveWorkspacePath } from './platform/path.js';
import { type BashResult, classifyCommand, runBash } from './tools/bash.js';
import { editTool } from './tools/edit.js';
import { readTool } from './tools/read.js';
import { writeTool } from './tools/write.js';

export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ToolResult {
  readonly forModel: string;
  readonly forDisplay: string;
  readonly meta?: Record<string, unknown>;
}

export interface ApprovalRequest {
  readonly command: string;
  readonly kind: 'destructive' | 'networked';
  readonly reason: string;
}

export type ApprovalDecision =
  | { readonly approved: true; readonly editedCommand?: string }
  | { readonly approved: false };

export interface DispatchToolParams {
  readonly call: ToolCall;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onApprovalNeeded?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function dispatchTool(params: DispatchToolParams): Promise<Result<ToolResult>> {
  const { call, cwd } = params;
  switch (call.name) {
    case 'read':
      return dispatchRead(call, cwd);
    case 'write':
      return dispatchWrite(call, cwd);
    case 'edit':
      return dispatchEdit(call, cwd);
    case 'bash':
      return dispatchBash(params);
    default:
      return err(new RizzError('BAD_TOOL_CALL', `unknown tool "${call.name}"`));
  }
}

async function dispatchRead(call: ToolCall, cwd: string): Promise<Result<ToolResult>> {
  const path = asString(call.args.path);
  if (path === undefined) return err(new RizzError('BAD_TOOL_CALL', 'read requires a string "path"'));
  const abs = resolveWorkspacePath(cwd, path);
  const offset = asNumber(call.args.offset);
  const limit = asNumber(call.args.limit);
  const result = await readTool({
    path: abs,
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  if (!result.ok) return result;
  const { content, hash, totalLines, truncated } = result.value;
  return ok({
    forModel: `<file path="${path}" hash="${hash}" lines="${totalLines}"${truncated ? ' truncated="true"' : ''}>\n${content}\n</file>`,
    forDisplay: `read · ${path} · ${totalLines} lines`,
    meta: { hash, totalLines, truncated },
  });
}

async function dispatchWrite(call: ToolCall, cwd: string): Promise<Result<ToolResult>> {
  const path = asString(call.args.path);
  const content = asString(call.args.content);
  if (path === undefined || content === undefined) {
    return err(new RizzError('BAD_TOOL_CALL', 'write requires string "path" and "content"'));
  }
  const abs = resolveWorkspacePath(cwd, path);
  const result = await writeTool({ path: abs, content });
  if (!result.ok) return result;
  const { bytesWritten, newHash } = result.value;
  return ok({
    forModel: `wrote ${path} (${bytesWritten} bytes, hash ${newHash})`,
    forDisplay: `write · ${path} · ${bytesWritten} bytes`,
    meta: { bytesWritten, newHash },
  });
}

async function dispatchEdit(call: ToolCall, cwd: string): Promise<Result<ToolResult>> {
  const path = asString(call.args.path);
  const oldText = asString(call.args.oldText);
  const newText = asString(call.args.newText);
  if (path === undefined || oldText === undefined || newText === undefined) {
    return err(new RizzError('BAD_TOOL_CALL', 'edit requires string "path", "oldText", "newText"'));
  }
  const abs = resolveWorkspacePath(cwd, path);
  const baseHash = asString(call.args.baseHash);
  const result = await editTool({
    path: abs,
    oldText,
    newText,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });
  if (!result.ok) return result;
  const { bytesWritten, newHash } = result.value;
  return ok({
    forModel: `edited ${path} (1 replacement, ${bytesWritten} bytes, hash ${newHash})`,
    forDisplay: `edit · ${path} · 1 replacement`,
    meta: { bytesWritten, newHash, replacements: 1 },
  });
}

async function dispatchBash(params: DispatchToolParams): Promise<Result<ToolResult>> {
  const { call, cwd, signal, onApprovalNeeded } = params;
  const command = asString(call.args.command);
  if (command === undefined) {
    return err(new RizzError('BAD_TOOL_CALL', 'bash requires a string "command"'));
  }

  const classification = classifyCommand(command);
  let toRun = command;

  if (classification.requiresApproval) {
    if (onApprovalNeeded === undefined) {
      // No approver wired → deny-by-default. The model is told, so it can adapt rather than retry.
      return ok({
        forModel: `command denied (no approval channel): ${command}`,
        forDisplay: `bash · denied · ${classification.kind}`,
        meta: { denied: true, classification: classification.kind },
      });
    }
    const decision = await onApprovalNeeded({
      command,
      kind: classification.kind === 'networked' ? 'networked' : 'destructive',
      reason: classification.reason,
    });
    if (!decision.approved) {
      return ok({
        forModel: `command denied by user: ${command}`,
        forDisplay: `bash · denied · ${classification.kind}`,
        meta: { denied: true, classification: classification.kind },
      });
    }
    if (decision.editedCommand !== undefined) toRun = decision.editedCommand;
  }

  const timeoutMs = asNumber(call.args.timeoutMs);
  const result = await runBash({
    command: toRun,
    cwd,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!result.ok) return result;
  return ok(bashToolResult(toRun, result.value));
}

function bashToolResult(command: string, r: BashResult): ToolResult {
  const body = [r.stdout, r.stderr].filter((s) => s.length > 0).join('\n').trimEnd();
  return {
    forModel: `$ ${command}\n(exit ${r.exitCode})\n${body}`,
    forDisplay: `bash · ${command.length > 48 ? `${command.slice(0, 48)}…` : command} · exit ${r.exitCode}`,
    meta: { exitCode: r.exitCode },
  };
}
