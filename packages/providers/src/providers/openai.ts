// OpenAI-compatible Chat Completions adapter (a Provider — the "how" of talking to any OpenAI-shaped
// endpoint with a BYOK key). One adapter covers OpenAI, OpenRouter, a local Ollama (`/v1`), and any
// custom OpenAI-compatible URL — they differ only by `baseUrl` (+ an optional key; Ollama needs none).
// Maps the loop's neutral Message[]/ToolSpec[] to the chat format, streams when a chunk sink is given,
// returns a structured Result, and never logs/echoes the key (§3.6). The subscription paths
// (Codex/Copilot) are deliberately NOT here — BYOK only (D-033). Services stay pure (ADR-001).

import type { CompletionRequest, CompletionResult, Message, Provider } from '../provider.js';
import { type Result, RizzError, err, ok } from '../result.js';
import type { ToolCall } from '../runtime/dispatch.js';
import type { ToolSpec } from '../runtime/tools/spec.js';
import { sseDataLines } from './sse.js';
import { codeForStatus, redact } from './util.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 4096;

export interface OpenAiProviderOptions {
  /** BYOK key. Empty string is allowed for keyless local endpoints (Ollama). */
  readonly apiKey: string;
  readonly model: string;
  readonly label?: string;
  /** OpenAI-compatible base URL (default https://api.openai.com/v1). */
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  /** Injected for tests; defaults to the global `fetch` (Node ≥ 22). */
  readonly fetchImpl?: typeof fetch;
}

// --- Wire types (only the fields rizz uses) ---

interface WireToolCall {
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}
interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  readonly tool_call_id?: string;
}

export interface OpenAiRequestBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly WireMessage[];
  readonly tools?: readonly object[];
  readonly stream?: boolean;
  readonly stream_options?: { include_usage: boolean };
}

/** Map one neutral message to an OpenAI chat message. */
function wireMessage(message: Message): WireMessage {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId ?? '' };
  }
  if (message.role === 'assistant') {
    const calls = (message.toolCalls ?? []).map((tc) => ({
      id: tc.id ?? '',
      type: 'function' as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
    return {
      role: 'assistant',
      content: message.content === '' ? null : message.content,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    };
  }
  return { role: message.role, content: message.content };
}

/** Build the Chat Completions request body from neutral messages (no coalescing needed). */
export function buildOpenAiRequest(
  messages: readonly Message[],
  options: { model: string; maxTokens: number; tools?: readonly ToolSpec[]; stream: boolean },
): OpenAiRequestBody {
  const tools = options.tools?.map((spec) => ({
    type: 'function',
    function: { name: spec.name, description: spec.description, parameters: spec.parameters },
  }));
  return {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: messages.map(wireMessage),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(options.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

interface ParsedReply {
  content: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}

/** Turn an accumulated OpenAI tool_call (arguments as a JSON string) into a neutral ToolCall. */
function toToolCall(raw: {
  id?: string | undefined;
  name?: string | undefined;
  args: string;
}): ToolCall {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = raw.args === '' ? {} : JSON.parse(raw.args);
    if (typeof value === 'object' && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    // Malformed tool arguments → empty object; the loop reports the bad call rather than crashing.
  }
  return { id: raw.id ?? '', name: raw.name ?? '', args: parsed };
}

/** Parse a non-streaming Chat Completions response. */
function parseJsonReply(body: unknown): ParsedReply {
  const reply: ParsedReply = { content: '', toolCalls: [], inputTokens: 0, outputTokens: 0 };
  if (typeof body !== 'object' || body === null) return reply;
  const obj = body as {
    choices?: { message?: { content?: unknown; tool_calls?: WireToolCall[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  reply.inputTokens = obj.usage?.prompt_tokens ?? 0;
  reply.outputTokens = obj.usage?.completion_tokens ?? 0;
  const message = obj.choices?.[0]?.message;
  if (typeof message?.content === 'string') reply.content = message.content;
  for (const call of message?.tool_calls ?? []) {
    reply.toolCalls.push(
      toToolCall({
        id: call.id,
        name: call.function?.name,
        args: call.function?.arguments ?? '',
      }),
    );
  }
  return reply;
}

export function createOpenAiProvider(options: OpenAiProviderOptions): Provider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const apiKey = options.apiKey;

  async function complete(request: CompletionRequest): Promise<Result<CompletionResult>> {
    if (request.signal?.aborted) {
      return err(new RizzError('INTERRUPTED', 'turn interrupted before the request was sent'));
    }
    const stream = request.onChunk !== undefined;
    const body = buildOpenAiRequest(request.messages, {
      model: options.model,
      maxTokens,
      stream,
      ...(request.tools ? { tools: request.tools } : {}),
    });

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // No Authorization header when keyless (local Ollama).
          ...(apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (cause) {
      if (request.signal?.aborted) return err(new RizzError('INTERRUPTED', 'turn interrupted'));
      const message = cause instanceof Error ? redact(cause.message, apiKey) : 'network error';
      return err(
        new RizzError('PROVIDER_UNAVAILABLE', `could not reach the endpoint: ${message}`, {
          cause,
        }),
      );
    }

    if (!response.ok) {
      const detail = await safeErrorDetail(response, apiKey);
      return err(
        new RizzError(
          codeForStatus(response.status),
          `OpenAI API error ${response.status}${detail}`,
        ),
      );
    }

    if (stream) return parseStream(response, request, apiKey);

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      return err(new RizzError('PROVIDER_UNAVAILABLE', 'malformed response', { cause }));
    }
    const parsed = parseJsonReply(json);
    return ok({
      content: parsed.content,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      ...(parsed.toolCalls.length > 0 ? { toolCalls: parsed.toolCalls } : {}),
    });
  }

  return { id: 'openai', label: options.label ?? options.model, complete };
}

/** Read an error body for the message WITHOUT leaking the key. */
async function safeErrorDetail(response: Response, apiKey: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: { message?: string; type?: string } };
    const detail = data?.error?.type ?? data?.error?.message;
    return detail ? ` (${redact(String(detail), apiKey)})` : '';
  } catch {
    return '';
  }
}

interface StreamChoice {
  readonly delta?: {
    readonly content?: string;
    readonly tool_calls?: {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
}
interface StreamChunk {
  readonly choices?: StreamChoice[];
  readonly usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Parse the SSE stream, forwarding text deltas to onChunk and assembling tool calls + usage. */
async function parseStream(
  response: Response,
  request: CompletionRequest,
  apiKey: string,
): Promise<Result<CompletionResult>> {
  const onChunk = request.onChunk;
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  // tool_calls stream as fragments keyed by index: an id+name on first sight, arguments appended.
  const toolFragments = new Map<number, { id: string; name: string; args: string }>();

  const handle = (chunk: StreamChunk): void => {
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content !== undefined && delta.content !== '') {
      content += delta.content;
      onChunk?.(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? 0;
      const current = toolFragments.get(index) ?? { id: '', name: '', args: '' };
      if (tc.id !== undefined) current.id = tc.id;
      if (tc.function?.name !== undefined) current.name = tc.function.name;
      if (tc.function?.arguments !== undefined) current.args += tc.function.arguments;
      toolFragments.set(index, current);
    }
  };

  try {
    for await (const payload of sseDataLines(response)) {
      try {
        handle(JSON.parse(payload) as StreamChunk);
      } catch {
        // keep-alive / non-JSON line — ignore.
      }
    }
  } catch (cause) {
    if (request.signal?.aborted) return err(new RizzError('INTERRUPTED', 'turn interrupted'));
    const message = cause instanceof Error ? redact(cause.message, apiKey) : 'stream error';
    return err(new RizzError('PROVIDER_UNAVAILABLE', `stream failed: ${message}`, { cause }));
  }

  const toolCalls = [...toolFragments.values()].map(toToolCall);
  return ok({
    content,
    inputTokens,
    outputTokens,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  });
}
