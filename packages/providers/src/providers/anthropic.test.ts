import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../provider.js';
import { TOOL_SPECS } from '../runtime/tools/spec.js';
import { buildAnthropicRequest, createAnthropicProvider } from './anthropic.js';

const KEY = 'sk-ant-test-SECRET-do-not-leak';

/** A fetch stub returning a JSON Messages response. */
function jsonFetch(body: object, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

/** A fetch stub returning an SSE stream of the given event payloads. */
function sseFetch(events: object[]): typeof fetch {
  const text = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
}

describe('buildAnthropicRequest', () => {
  it('hoists system messages to the top-level system param', () => {
    const messages: Message[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ];
    const body = buildAnthropicRequest(messages, { model: 'm', maxTokens: 10, stream: false });
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('coalesces consecutive tool results into a single user message after the assistant turn', () => {
    const messages: Message[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read', args: {} },
          { id: 'b', name: 'read', args: {} },
        ],
      },
      { role: 'tool', content: 'res a', toolCallId: 'a' },
      { role: 'tool', content: 'res b', toolCallId: 'b' },
    ];
    const body = buildAnthropicRequest(messages, { model: 'm', maxTokens: 10, stream: false });
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]?.role).toBe('assistant');
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'res a' },
        { type: 'tool_result', tool_use_id: 'b', content: 'res b' },
      ],
    });
  });

  it('synthesizes a tool_result for a dangling tool_use (resume after interrupt)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'bash', args: {} }] },
      // No tool result followed — the turn was interrupted, then resumed.
    ];
    const body = buildAnthropicRequest(messages, { model: 'm', maxTokens: 10, stream: false });
    const last = body.messages.at(-1);
    expect(last?.role).toBe('user');
    expect(last?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'x',
      is_error: true,
    });
  });

  it('maps tool specs to input_schema', () => {
    const body = buildAnthropicRequest([{ role: 'user', content: 'x' }], {
      model: 'm',
      maxTokens: 10,
      stream: false,
      tools: TOOL_SPECS,
    });
    expect(body.tools).toHaveLength(TOOL_SPECS.length);
    expect(body.tools?.[0]).toMatchObject({ name: 'read', input_schema: { type: 'object' } });
  });
});

describe('createAnthropicProvider.complete (non-streaming)', () => {
  it('returns content, tool calls, and usage; sends auth headers', async () => {
    const fetchImpl = jsonFetch({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.ts' } },
      ],
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    const provider = createAnthropicProvider({ apiKey: KEY, model: 'claude-opus-4-8', fetchImpl });
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('hello');
    expect(result.value.toolCalls).toEqual([{ id: 't1', name: 'read', args: { path: 'a.ts' } }]);
    expect(result.value.inputTokens).toBe(12);
    expect(result.value.outputTokens).toBe(5);

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    const init = (call[1] ?? {}) as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBeTruthy();
  });

  it.each([
    [401, 'PROVIDER_AUTH'],
    [403, 'PROVIDER_AUTH'],
    [429, 'PROVIDER_RATE_LIMIT'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [529, 'PROVIDER_UNAVAILABLE'],
    [400, 'UNKNOWN'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const provider = createAnthropicProvider({
      apiKey: KEY,
      model: 'm',
      fetchImpl: jsonFetch({ error: { type: 'boom' } }, status),
    });
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
  });

  it('returns INTERRUPTED when the signal is already aborted, without calling fetch', async () => {
    const fetchImpl = jsonFetch({});
    const provider = createAnthropicProvider({ apiKey: KEY, model: 'm', fetchImpl });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      signal: AbortSignal.abort(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERRUPTED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never leaks the api key in an error message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`socket closed for ${KEY}`);
    }) as unknown as typeof fetch;
    const provider = createAnthropicProvider({ apiKey: KEY, model: 'm', fetchImpl });
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.error.message).not.toContain(KEY);
  });
});

describe('createAnthropicProvider.complete (streaming)', () => {
  it('forwards text deltas to onChunk and assembles tool calls + usage', async () => {
    const fetchImpl = sseFetch([
      { type: 'message_start', usage: { input_tokens: 9 } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'He' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } },
      {
        type: 'content_block_start',
        index: 1,
        block: { type: 'tool_use', id: 'tc', name: 'bash' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
      },
      { type: 'message_delta', usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ]);
    const chunks: string[] = [];
    const provider = createAnthropicProvider({ apiKey: KEY, model: 'm', fetchImpl });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: (d) => chunks.push(d),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(chunks).toEqual(['He', 'llo']);
    expect(result.value.content).toBe('Hello');
    expect(result.value.toolCalls).toEqual([{ id: 'tc', name: 'bash', args: { command: 'ls' } }]);
    expect(result.value.inputTokens).toBe(9);
    expect(result.value.outputTokens).toBe(7);
  });

  it('does not drop a final event that lacks a trailing newline', async () => {
    // A stub/proxy may omit the final \n; the tail flush must still surface the last event.
    const text =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}';
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const chunks: string[] = [];
    const provider = createAnthropicProvider({ apiKey: KEY, model: 'm', fetchImpl });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: (d) => chunks.push(d),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(chunks).toEqual(['hi']);
    expect(result.value.content).toBe('hi');
  });
});
