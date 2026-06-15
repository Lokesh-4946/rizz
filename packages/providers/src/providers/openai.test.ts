import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../provider.js';
import { TOOL_SPECS } from '../runtime/tools/spec.js';
import { buildOpenAiRequest, createOpenAiProvider } from './openai.js';

const KEY = 'sk-openai-test-SECRET-do-not-leak';

/** A fetch stub returning a JSON Chat Completions response. */
function jsonFetch(body: object, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

/** A fetch stub returning an SSE stream of the given chunk payloads. */
function sseFetch(chunks: object[]): typeof fetch {
  const text = `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
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

/** Pull the (url, init) of the first fetch call. */
function firstCall(fetchImpl: typeof fetch): { url: string; init: RequestInit } {
  const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

describe('buildOpenAiRequest', () => {
  it('maps neutral messages to chat messages and sets max_tokens', () => {
    const messages: Message[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ];
    const body = buildOpenAiRequest(messages, { model: 'gpt-4o', maxTokens: 64, stream: false });
    expect(body.model).toBe('gpt-4o');
    expect(body.max_tokens).toBe(64);
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
    expect(body.stream).toBeUndefined();
  });

  it('maps an assistant tool-use turn and its tool results to the chat shape', () => {
    const messages: Message[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'a', name: 'read', args: { path: 'x.ts' } }],
      },
      { role: 'tool', content: 'res a', toolCallId: 'a' },
    ];
    const body = buildOpenAiRequest(messages, { model: 'm', maxTokens: 10, stream: false });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null, // empty assistant content becomes null per the chat spec
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read', arguments: '{"path":"x.ts"}' } },
      ],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', content: 'res a', tool_call_id: 'a' });
  });

  it('maps tool specs to function tools and requests usage on a stream', () => {
    const body = buildOpenAiRequest([{ role: 'user', content: 'x' }], {
      model: 'm',
      maxTokens: 10,
      stream: true,
      tools: TOOL_SPECS,
    });
    expect(body.tools).toHaveLength(TOOL_SPECS.length);
    expect(body.tools?.[0]).toMatchObject({ type: 'function', function: { name: 'read' } });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('createOpenAiProvider.complete (non-streaming)', () => {
  it('returns content, tool calls, and usage; sends the bearer key to /chat/completions', async () => {
    const fetchImpl = jsonFetch({
      choices: [
        {
          message: {
            content: 'hello',
            tool_calls: [{ id: 't1', function: { name: 'read', arguments: '{"path":"a.ts"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    });
    const provider = createOpenAiProvider({ apiKey: KEY, model: 'gpt-4o', fetchImpl });
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('hello');
    expect(result.value.toolCalls).toEqual([{ id: 't1', name: 'read', args: { path: 'a.ts' } }]);
    expect(result.value.inputTokens).toBe(12);
    expect(result.value.outputTokens).toBe(5);

    const { url, init } = firstCall(fetchImpl);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('targets a custom base URL (OpenRouter / custom endpoint), trimming a trailing slash', async () => {
    const fetchImpl = jsonFetch({ choices: [{ message: { content: 'ok' } }] });
    const provider = createOpenAiProvider({
      apiKey: KEY,
      model: 'meta-llama/llama-3.1-8b-instruct',
      baseUrl: 'https://openrouter.ai/api/v1/',
      fetchImpl,
    });
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(firstCall(fetchImpl).url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('omits the Authorization header for a keyless local endpoint (Ollama)', async () => {
    const fetchImpl = jsonFetch({ choices: [{ message: { content: 'ok' } }] });
    const provider = createOpenAiProvider({
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434/v1',
      fetchImpl,
    });
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const { url, init } = firstCall(fetchImpl);
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it.each([
    [401, 'PROVIDER_AUTH'],
    [403, 'PROVIDER_AUTH'],
    [429, 'PROVIDER_RATE_LIMIT'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [400, 'UNKNOWN'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const provider = createOpenAiProvider({
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
    const provider = createOpenAiProvider({ apiKey: KEY, model: 'm', fetchImpl });
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
    const provider = createOpenAiProvider({ apiKey: KEY, model: 'm', fetchImpl });
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.error.message).not.toContain(KEY);
  });
});

describe('createOpenAiProvider.complete (streaming)', () => {
  it('forwards text deltas to onChunk and assembles fragmented tool calls + usage', async () => {
    const fetchImpl = sseFetch([
      { choices: [{ delta: { content: 'He' } }] },
      { choices: [{ delta: { content: 'llo' } }] },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc', function: { name: 'bash' } }] } }],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 7 } },
    ]);
    const chunks: string[] = [];
    const provider = createOpenAiProvider({ apiKey: KEY, model: 'm', fetchImpl });
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
});
