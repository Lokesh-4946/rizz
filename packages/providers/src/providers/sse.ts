// Shared Server-Sent Events reader for streaming provider adapters. Yields each `data:` payload
// string (skipping `[DONE]`, blank, and non-`data:` keep-alive lines), including a trailing line with
// no final newline — so a proxy/stub that omits the last `\n` never strands the final event. Each
// adapter JSON-parses the payloads per its own wire schema. Zero-dep; no fork per provider.

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

/** The payload of one SSE line, or undefined for a non-data / `[DONE]` / blank line. */
function dataPayload(raw: string): string | undefined {
  const line = raw.replace(/\r$/, '');
  if (!line.startsWith('data:')) return undefined;
  const payload = line.slice(5).trim();
  return payload === '' || payload === '[DONE]' ? undefined : payload;
}

/** Yield each SSE `data:` payload string from the response body. */
export async function* sseDataLines(response: Response): AsyncGenerator<string> {
  const stream = response.body;
  if (stream === null) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of streamChunks(stream)) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const payload = dataPayload(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (payload !== undefined) yield payload;
      nl = buffer.indexOf('\n');
    }
  }
  // Flush any bytes the decoder still holds, then the final newline-less line.
  buffer += decoder.decode();
  const tail = dataPayload(buffer);
  if (tail !== undefined) yield tail;
}
