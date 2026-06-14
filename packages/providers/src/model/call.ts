// callModel — the model service (design §3.1). The loop calls THIS, not a Provider directly, so
// streaming, abort, and usage normalization live in one place. It returns a normalized ModelReply.
//
// DEVIATION (see handoff D-024): the design's ModelReply.usage carries `costUsd`; this returns raw
// token usage only. Cost depends on price metadata + whether the call is on a subscription — both
// orchestration concerns (ADR-001: a service takes data in, it does not read pricing/subscription
// state). The loop computes cost via estimateCostUsd(model, usage, { subscription }).

import type { Message, Provider } from '../provider.js';
import { type Result, ok } from '../result.js';
import type { ToolCall } from '../runtime/dispatch.js';
import type { ToolSpec } from '../runtime/tools/spec.js';

export interface CallModelParams {
  readonly provider: Provider;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSpec[];
  readonly signal?: AbortSignal;
  readonly onChunk?: (delta: string) => void;
}

export interface ModelReply {
  readonly content: string;
  /** Empty → the content is the final answer; non-empty → the loop dispatches these. */
  readonly toolCalls: readonly ToolCall[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export async function callModel(params: CallModelParams): Promise<Result<ModelReply>> {
  const request = {
    messages: params.messages,
    ...(params.tools ? { tools: params.tools } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.onChunk ? { onChunk: params.onChunk } : {}),
  };
  const result = await params.provider.complete(request);
  if (!result.ok) return result;

  const { content, inputTokens, outputTokens, toolCalls } = result.value;
  return ok({
    content,
    toolCalls: toolCalls ?? [],
    usage: { inputTokens, outputTokens },
  });
}
