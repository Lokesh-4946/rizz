// The Anthropic Messages API adapter (a Provider implementation — the "how" of talking to Claude
// over the public API with a BYOK key). It maps the loop's neutral Message[]/ToolSpec[] to the
// Anthropic wire format, streams when a chunk sink is given, and returns a structured Result. It
// holds the key in a closure and NEVER logs it or echoes a provider error body verbatim (§3.6).
//
// This is the supported third-party path to Claude (an API key). The Pro/Max *subscription* OAuth is
// deliberately not implemented here — see the handoff. Adapters never touch session/orchestration
// state; the loop drives cost/fallback/retry off the Result this returns.

import type { CompletionRequest, CompletionResult, Message, Provider } from '../provider.js';
import { type Result, RizzError, type RizzErrorCode, err, ok } from '../result.js';
import type { ToolCall } from '../runtime/dispatch.js';
import type { ToolSpec } from '../runtime/tools/spec.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  /** Model id, e.g. 'claude-opus-4-8'. */
  readonly model: string;
  /** Status-bar / picker label. Defaults to the model id. */
  readonly label?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  /** Injected for tests; defaults to the global `fetch` (Node ≥ 22). */
  readonly fetchImpl?: typeof fetch;
}

// --- Wire-format types (only the fields rizz uses) ---

interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}
interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}
interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface WireMessage {
  readonly role: 'user' | 'assistant';
  readonly content: ContentBlock[];
}

export interface AnthropicRequestBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly WireMessage[];
  readonly system?: string;
  readonly tools?: readonly object[];
  readonly stream?: boolean;
}

const isAssistant = (role: Message['role']): boolean => role === 'assistant';

/** Build the content blocks for one neutral message (excluding system, handled separately). */
function blocksFor(message: Message): ContentBlock[] {
  if (message.role === 'tool') {
    return [
      {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      },
    ];
  }
  if (message.role === 'assistant') {
    const blocks: ContentBlock[] = [];
    if (message.content !== '') blocks.push({ type: 'text', text: message.content });
    for (const tc of message.toolCalls ?? []) {
      blocks.push({ type: 'tool_use', id: tc.id ?? '', name: tc.name, input: tc.args });
    }
    return blocks;
  }
  // user
  return message.content === '' ? [] : [{ type: 'text', text: message.content }];
}

/**
 * Map neutral messages → the Anthropic request body. System messages are hoisted to the top-level
 * `system` param (a mid-conversation system message is a 400 otherwise). Consecutive messages with
 * the same effective role are coalesced into one wire message, because the API requires user/assistant
 * to alternate and wants all tool_results for a turn in a single user message.
 *
 * Dangling tool_use guard: any assistant `tool_use` without a matching `tool_result` later in the
 * history (e.g. an interrupted turn that is then resumed) gets a synthesized error tool_result, so a
 * resumed session never sends an invalid request that the API would reject (a real-world resume bug).
 */
export function buildAnthropicRequest(
  messages: readonly Message[],
  options: { model: string; maxTokens: number; tools?: readonly ToolSpec[]; stream: boolean },
): AnthropicRequestBody {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const wire: { role: 'user' | 'assistant'; content: ContentBlock[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role: 'user' | 'assistant' = isAssistant(message.role) ? 'assistant' : 'user';
    const blocks = blocksFor(message);
    if (blocks.length === 0) continue;
    const last = wire.at(-1);
    if (last !== undefined && last.role === role) {
      last.content.push(...blocks);
    } else {
      wire.push({ role, content: blocks });
    }
  }

  resolveDanglingToolUses(wire);

  const tools = options.tools?.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  }));

  return {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: wire,
    ...(systemText !== '' ? { system: systemText } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(options.stream ? { stream: true } : {}),
  };
}

/** Ensure every assistant tool_use has a following tool_result; synthesize one for any that don't. */
function resolveDanglingToolUses(
  wire: { role: 'user' | 'assistant'; content: ContentBlock[] }[],
): void {
  const satisfied = new Set<string>();
  for (const msg of wire) {
    for (const block of msg.content) {
      if (block.type === 'tool_result') satisfied.add(block.tool_use_id);
    }
  }
  for (let i = 0; i < wire.length; i += 1) {
    const msg = wire[i];
    if (msg === undefined || msg.role !== 'assistant') continue;
    const missing = msg.content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use' && !satisfied.has(b.id))
      .map((b) => b.id);
    if (missing.length === 0) continue;
    const results: ToolResultBlock[] = missing.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: '(interrupted — no result was produced for this tool call)',
      is_error: true,
    }));
    const next = wire[i + 1];
    if (next !== undefined && next.role === 'user') {
      next.content.unshift(...results);
    } else {
      wire.splice(i + 1, 0, { role: 'user', content: results });
    }
    for (const id of missing) satisfied.add(id);
  }
}

/** Map an HTTP status to a stable error code the loop can classify (design §5). */
function codeForStatus(status: number): RizzErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH';
  if (status === 429) return 'PROVIDER_RATE_LIMIT';
  // 408/409/5xx (incl. Anthropic's 529 "overloaded") are transient → fallback/retry.
  if (status === 408 || status === 409 || status >= 500) return 'PROVIDER_UNAVAILABLE';
  // Other 4xx (400/404/422…) are caller-side and non-retryable → surface, don't loop.
  return 'UNKNOWN';
}

/** Remove the key from any text before it could be surfaced (defense in depth — the key isn't logged). */
function redact(text: string, secret: string): string {
  return secret === '' ? text : text.split(secret).join('«redacted»');
}

interface ParsedReply {
  content: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}

/** Parse a non-streaming Messages response JSON into the neutral CompletionResult shape. */
function parseJsonReply(body: unknown): ParsedReply {
  const reply: ParsedReply = { content: '', toolCalls: [], inputTokens: 0, outputTokens: 0 };
  if (typeof body !== 'object' || body === null) return reply;
  const obj = body as {
    content?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  reply.inputTokens = obj.usage?.input_tokens ?? 0;
  reply.outputTokens = obj.usage?.output_tokens ?? 0;
  if (!Array.isArray(obj.content)) return reply;
  for (const block of obj.content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      reply.content += block.text;
    } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
      reply.toolCalls.push({
        id: block.id,
        name: String(block.name ?? ''),
        args: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return reply;
}

export function createAnthropicProvider(options: AnthropicProviderOptions): Provider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const apiKey = options.apiKey;

  async function complete(request: CompletionRequest): Promise<Result<CompletionResult>> {
    if (request.signal?.aborted) {
      return err(new RizzError('INTERRUPTED', 'turn interrupted before the request was sent'));
    }

    const stream = request.onChunk !== undefined;
    const body = buildAnthropicRequest(request.messages, {
      model: options.model,
      maxTokens,
      stream,
      ...(request.tools ? { tools: request.tools } : {}),
    });

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (cause) {
      if (request.signal?.aborted) return err(new RizzError('INTERRUPTED', 'turn interrupted'));
      const message = cause instanceof Error ? redact(cause.message, apiKey) : 'network error';
      return err(
        new RizzError('PROVIDER_UNAVAILABLE', `could not reach Anthropic: ${message}`, { cause }),
      );
    }

    if (!response.ok) {
      const code = codeForStatus(response.status);
      const detail = await safeErrorDetail(response, apiKey);
      return err(new RizzError(code, `Anthropic API error ${response.status}${detail}`));
    }

    if (stream) return parseStream(response, request, apiKey);

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      return err(new RizzError('PROVIDER_UNAVAILABLE', 'malformed Anthropic response', { cause }));
    }
    const parsed = parseJsonReply(json);
    return ok({
      content: parsed.content,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      ...(parsed.toolCalls.length > 0 ? { toolCalls: parsed.toolCalls } : {}),
    });
  }

  return {
    id: 'anthropic',
    label: options.label ?? options.model,
    complete,
  };
}

/** Read an error body for the message WITHOUT leaking the key; fall back to nothing on any trouble. */
async function safeErrorDetail(response: Response, apiKey: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: { type?: string } };
    const type = data?.error?.type;
    return type ? ` (${redact(String(type), apiKey)})` : '';
  } catch {
    return '';
  }
}

/** Parse the SSE stream into a CompletionResult, forwarding text deltas to onChunk as they arrive. */
async function parseStream(
  response: Response,
  request: CompletionRequest,
  apiKey: string,
): Promise<Result<CompletionResult>> {
  const onChunk = request.onChunk;
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  // tool_use blocks arrive as a start event then incremental input_json_delta fragments.
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

  const handleEvent = (event: StreamEvent): void => {
    switch (event.type) {
      case 'message_start':
        inputTokens = event.usage?.input_tokens ?? inputTokens;
        break;
      case 'content_block_start':
        if (event.block?.type === 'tool_use') {
          toolBlocks.set(event.index ?? 0, {
            id: String(event.block.id ?? ''),
            name: String(event.block.name ?? ''),
            json: '',
          });
        }
        break;
      case 'content_block_delta': {
        if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          content += event.delta.text;
          onChunk?.(event.delta.text);
        } else if (
          event.delta?.type === 'input_json_delta' &&
          typeof event.delta.partial_json === 'string'
        ) {
          const block = toolBlocks.get(event.index ?? 0);
          if (block) block.json += event.delta.partial_json;
        }
        break;
      }
      case 'message_delta':
        outputTokens = event.usage?.output_tokens ?? outputTokens;
        break;
    }
  };

  try {
    for await (const event of readSse(response)) handleEvent(event);
  } catch (cause) {
    if (request.signal?.aborted) return err(new RizzError('INTERRUPTED', 'turn interrupted'));
    const message = cause instanceof Error ? redact(cause.message, apiKey) : 'stream error';
    return err(
      new RizzError('PROVIDER_UNAVAILABLE', `Anthropic stream failed: ${message}`, { cause }),
    );
  }

  const toolCalls: ToolCall[] = [];
  for (const block of toolBlocks.values()) {
    toolCalls.push({ id: block.id, name: block.name, args: parseToolInput(block.json) });
  }
  return ok({
    content,
    inputTokens,
    outputTokens,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  });
}

function parseToolInput(json: string): Record<string, unknown> {
  if (json === '') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface StreamEvent {
  readonly type: string;
  readonly index?: number;
  readonly usage?: { input_tokens?: number; output_tokens?: number };
  readonly block?: { type?: string; id?: string; name?: string };
  readonly delta?: { type?: string; text?: string; partial_json?: string };
}

/** Decode the response body as Server-Sent Events, yielding each parsed `data:` payload. */
async function* readSse(response: Response): AsyncGenerator<StreamEvent> {
  const stream = response.body;
  if (stream === null) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of streamChunks(stream)) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload !== '' && payload !== '[DONE]') {
          try {
            yield JSON.parse(payload) as StreamEvent;
          } catch {
            // A non-JSON keep-alive/comment line is ignored, never fatal.
          }
        }
      }
      nl = buffer.indexOf('\n');
    }
  }
}

/** Iterate a web ReadableStream (Node fetch body) as byte chunks. */
async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
