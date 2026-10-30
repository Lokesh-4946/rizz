import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { join } from 'node:path';
import { prepareProjectStore } from '../project-store.js';
import { readBrainText } from './brain-index.js';
import { countUnrecorded, foldSpool, refreshObserveIndex } from './fold.js';
import { loadJournal } from './journal.js';
import { readTokenRows, summarizeTokens } from './ledger.js';
import { renderTokenReport } from './ledger.js';
import {
  appendDecisionRecord,
  inboxDecisionId,
  isInboxAnswered,
  listInbox,
  readDecisionRecords,
} from './notes.js';
import { observePaths } from './paths.js';
import { renderSummary } from './summary.js';

export interface ObserveServer {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function page(token: string, brain: string): string {
  const safe = escapeHtml(brain);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Rizz brain</title>
<style>
body { font: 15px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; color: #1c1917; background: #faf7f2; }
pre { white-space: pre-wrap; background: #fff; border: 1px solid #e7e5e4; padding: 1rem; }
form { display: flex; gap: .5rem; margin: 1rem 0; }
input { flex: 1; padding: .4rem .6rem; }
#answer { min-height: 2rem; }
</style>
</head>
<body>
<h1>Rizz brain</h1>
<p>This page only reads the project brain. It does not run the host agent.</p>
<form id="ask">
<input name="q" placeholder="summary, tokens, threads, or search text" aria-label="Query the brain">
<button type="submit">Ask</button>
</form>
<div id="answer"></div>
<pre id="brain">${safe}</pre>
<script>
const token = ${JSON.stringify(token)};
const brain = document.querySelector('#brain');
const answer = document.querySelector('#answer');
async function refresh() {
  const response = await fetch('/api/brain?token=' + encodeURIComponent(token));
  if (!response.ok) return;
  const body = await response.json();
  brain.textContent = body.markdown ?? '';
}
document.querySelector('#ask').addEventListener('submit', async (event) => {
  event.preventDefault();
  const q = new FormData(event.target).get('q');
  const response = await fetch('/api/query?token=' + encodeURIComponent(token) + '&q=' + encodeURIComponent(String(q ?? '')));
  const body = await response.json();
  answer.textContent = body.summary ?? '';
});
refresh();
setInterval(refresh, 2000);
const events = new EventSource('/events?token=' + encodeURIComponent(token));
events.onmessage = () => refresh();
</script>
</body>
</html>`;
}

function send(response: ServerResponse, status: number, body: string, type: string): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

function tokenOk(url: URL, expected: string): boolean {
  return url.searchParams.get('token') === expected;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function startObserveServer(options: {
  readonly projectRoot: string;
  readonly rizzHome: string;
  readonly token?: string;
}): Promise<ObserveServer> {
  const prepared = await prepareProjectStore({
    rootDir: options.projectRoot,
    rizzHome: options.rizzHome,
  });
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  const paths = observePaths(prepared.value.projectDir);
  const token = options.token ?? randomBytes(16).toString('hex');
  const clients = new Set<ServerResponse>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!tokenOk(url, token)) {
      send(response, 401, 'missing token\n', 'text/plain; charset=utf-8');
      return;
    }
    if (url.pathname === '/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write('data: {"type":"ready"}\n\n');
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (url.pathname === '/api/brain') {
      const markdown = await readBrainText(paths.brain);
      send(
        response,
        200,
        JSON.stringify({ markdown: markdown.ok ? markdown.value : '' }),
        'application/json',
      );
      return;
    }
    if (url.pathname === '/api/query') {
      const q = url.searchParams.get('q') ?? '';
      const summary = await answer(paths, q, options.rizzHome, options.projectRoot);
      send(response, 200, JSON.stringify({ summary }), 'application/json');
      return;
    }
    if (url.pathname === '/api/decide' && request.method === 'POST') {
      const posted = readDecisionPost(await readBody(request));
      if (posted === undefined) {
        send(response, 400, JSON.stringify({ ok: false }), 'application/json');
        return;
      }
      const inbox = await listInbox(paths.inboxDir);
      const item = inbox.ok ? inbox.value.find((entry) => entry.id === posted.id) : undefined;
      if (item === undefined) {
        send(response, 404, JSON.stringify({ ok: false }), 'application/json');
        return;
      }
      const recorded = await appendDecisionRecord(paths.decisions, {
        id: inboxDecisionId(posted.id),
        text: posted.answer,
        source: 'owner',
        createdAt: new Date().toISOString(),
      });
      if (!recorded.ok) {
        send(
          response,
          400,
          JSON.stringify({ ok: false, code: recorded.error.code }),
          'application/json',
        );
        return;
      }
      await rm(join(paths.inboxDir, `${posted.id}.md`), { force: true });
      await refreshObserveIndex({
        projectDir: prepared.value.projectDir,
        projectRoot: options.projectRoot,
        at: new Date().toISOString(),
      });
      send(response, 200, JSON.stringify({ ok: true }), 'application/json');
      return;
    }
    const markdown = await readBrainText(paths.brain);
    send(response, 200, page(token, markdown.ok ? markdown.value : ''), 'text/html; charset=utf-8');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  let folding = false;
  const timer = setInterval(() => {
    if (folding) return;
    folding = true;
    void foldSpool(options.rizzHome)
      .then((result) => {
        if (!result.ok || result.value.applied === 0) return;
        for (const client of clients) client.write(`data: ${JSON.stringify({ type: 'fold' })}\n\n`);
      })
      .finally(() => {
        folding = false;
      });
  }, 1000);
  timer.unref();

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    async close() {
      clearInterval(timer);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function readDecisionPost(
  raw: string,
): { readonly id: string; readonly answer: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const answer = typeof record.answer === 'string' ? record.answer.trim() : '';
    if (id === '' || answer === '') return undefined;
    return { id, answer };
  } catch {
    return undefined;
  }
}

async function answer(
  paths: ReturnType<typeof observePaths>,
  query: string,
  rizzHome: string,
  projectRoot: string,
): Promise<string> {
  const inbox = await listInbox(paths.inboxDir);
  const decisions = await readDecisionRecords(paths.decisions);
  const openInbox = (inbox.ok ? inbox.value : []).filter(
    (item) => !decisions.ok || !isInboxAnswered(item.id, decisions.value),
  );
  const journal = await loadJournal(paths.journalDir);
  const threads = new Set((journal.ok ? journal.value : []).map((event) => event.threadId));
  const normalized = query.trim().toLowerCase();
  if (normalized === '' || normalized === 'summary') {
    const dropped = await countUnrecorded(rizzHome, projectRoot);
    return renderSummary({ threads: threads.size, inbox: openInbox, dropped });
  }
  if (normalized === 'tokens') {
    const rows = await readTokenRows(paths.ledger);
    if (!rows.ok) return 'no usage recorded';
    return renderTokenReport(summarizeTokens(rows.value));
  }
  if (normalized === 'threads') {
    if (threads.size === 0) return 'no threads yet';
    return [...threads].map((id) => `- [[threads/${id}]]`).join('\n');
  }
  const brain = await readBrainText(paths.brain);
  const haystack = brain.ok ? brain.value : '';
  if (haystack.toLowerCase().includes(normalized)) return haystack;
  return 'Nothing in the brain index matched that query.';
}
