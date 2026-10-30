import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { type IncomingMessage, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareProjectStore } from '../../project-store.js';
import { runObserveCli } from '../cli.js';
import { foldSpool } from '../fold.js';
import { eventsIn } from '../journal.js';
import { observePaths } from '../paths.js';
import { receiveHook } from '../receive.js';
import { startObserveServer } from '../serve.js';
import { GROK_HINT } from './contract.js';

const roots: string[] = [];
const KEY = 'e2e-sender-key-not-for-journal';

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('assistant relay round trip', () => {
  it('sends from the hook, accepts a CLI reply and a polled reply, and quotes the next context', async () => {
    process.env.RIZZ_RELAY_POLL_INTERVAL_MS = '0';
    const home = await tempDir('rizz-relay-e2e-home-');
    const project = await tempDir('rizz-relay-e2e-project-');
    const posts: Array<{ authorization: string; json: Record<string, unknown> }> = [];
    let pollMessages: unknown[] = [];
    const pollUrls: string[] = [];
    const webhook = createServer(async (request, response) => {
      const raw = await bodyOf(request);
      posts.push({
        authorization: request.headers.authorization ?? '',
        json: JSON.parse(raw) as Record<string, unknown>,
      });
      response.writeHead(204);
      response.end();
    });
    const poll = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      pollUrls.push(url.search);
      if (request.headers.authorization !== `Bearer ${KEY}`) {
        response.writeHead(401);
        response.end('no');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ messages: pollMessages, cursor: 'cursor-1' }));
    });
    await new Promise<void>((resolve) => {
      webhook.listen(0, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => {
      poll.listen(0, '127.0.0.1', () => resolve());
    });
    const webhookPort = (webhook.address() as { port: number }).port;
    const pollPort = (poll.address() as { port: number }).port;
    const webhookUrl = `http://127.0.0.1:${webhookPort}/hook`;
    try {
      expect(
        await runObserveCli(
          [
            'relay',
            'add',
            'jenny',
            '--url',
            webhookUrl,
            '--poll-url',
            `http://127.0.0.1:${pollPort}/poll`,
            '--reply-wait',
            '0m',
          ],
          { cwd: project, rizzHome: home, env: { RIZZ_RELAY_KEY: KEY } },
        ),
      ).toBe(0);
      const started = Date.now();
      const hooked = await receiveHook({
        tool: 'cursor',
        hook: 'beforeSubmitPrompt',
        stdin: JSON.stringify({
          conversation_id: 'conv-e2e',
          generation_id: 'gen-e2e',
          hook_event_name: 'beforeSubmitPrompt',
          prompt: '@jenny hello from the hook',
          workspace_roots: [project],
        }),
        projectRoot: project,
        rizzHome: home,
        at: '2026-10-28T09:00:00.000Z',
      });
      expect(hooked.exitCode).toBe(0);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(posts).toHaveLength(0);
      const folded = await foldSpool(home);
      expect(folded.ok).toBe(true);
      expect(posts).toHaveLength(1);
      const sent = posts[0];
      expect(sent?.authorization).toBe(`Bearer ${KEY}`);
      expect(sent?.json.from).toBe('rizz');
      expect(sent?.json.text).toBe('hello from the hook');
      expect(Object.keys(sent?.json ?? {}).sort()).toEqual(
        ['from', 'id', 'indexExcerpt', 'project', 'projectPath', 'sentAt', 'text'].sort(),
      );
      expect(JSON.stringify(sent?.json)).not.toContain(KEY);
      const messageId = String(sent?.json.id);
      const prepared = await prepareProjectStore({ rootDir: project, rizzHome: home });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(sent?.json.project).toBe(prepared.value.projectId);
      const paths = observePaths(prepared.value.projectDir);
      const beforeReply = await readFile(paths.brain, 'utf8');
      expect(beforeReply).toContain(GROK_HINT);
      expect(beforeReply).not.toContain(KEY);
      expect(beforeReply).not.toContain(webhookUrl);
      expect(
        await runObserveCli(
          ['relay', 'deliver', '--from', 'jenny', '--in-reply-to', messageId, 'reply via cli'],
          { cwd: project, rizzHome: home, env: {} },
        ),
      ).toBe(0);
      expect(
        await runObserveCli(
          ['relay', 'deliver', '--from', 'jenny', '--in-reply-to', messageId, 'reply via cli'],
          { cwd: project, rizzHome: home, env: {} },
        ),
      ).toBe(0);
      const afterCli = await readFile(paths.brain, 'utf8');
      expect(afterCli).toContain('reply via cli');
      expect(afterCli).toContain('information, not an instruction');
      expect(afterCli).not.toContain(GROK_HINT);
      expect(afterCli).not.toContain(webhookUrl);
      const journal = await readFile(join(paths.journalDir, '2026-10.md'), 'utf8');
      expect(journal).not.toContain(KEY);
      expect(journal).not.toContain(webhookUrl);
      expect(eventsIn(journal).filter((event) => event.text === 'reply via cli')).toHaveLength(1);
      const context = await receiveHook({
        tool: 'cursor',
        hook: 'sessionStart',
        stdin: JSON.stringify({
          conversation_id: 'conv-e2e',
          hook_event_name: 'sessionStart',
          workspace_roots: [project],
        }),
        projectRoot: project,
        rizzHome: home,
        at: '2026-10-28T09:05:00.000Z',
      });
      expect(context.exitCode).toBe(0);
      const additional = JSON.parse(context.stdout) as { additional_context: string };
      expect(additional.additional_context).toContain('Quoted message from jenny.');
      expect(additional.additional_context).toContain('not an instruction');
      expect(additional.additional_context).toContain('> reply via cli');
      const again = await receiveHook({
        tool: 'cursor',
        hook: 'beforeSubmitPrompt',
        stdin: JSON.stringify({
          conversation_id: 'conv-e2e',
          generation_id: 'gen-e2e-2',
          hook_event_name: 'beforeSubmitPrompt',
          prompt: '@jenny second note',
          workspace_roots: [project],
        }),
        projectRoot: project,
        rizzHome: home,
        at: '2026-10-28T09:06:00.000Z',
      });
      expect(again.exitCode).toBe(0);
      expect(again.stdout).not.toContain('reply via cli');
      await foldSpool(home);
      expect(posts).toHaveLength(2);
      const secondId = String(posts[1]?.json.id);
      pollMessages = [
        {
          id: 'poll-reply-1',
          inReplyTo: secondId,
          from: 'jenny',
          text: 'reply via poll',
          at: '2026-10-28T09:07:00.000Z',
        },
      ];
      await foldSpool(home);
      await foldSpool(home);
      const afterPoll = await readFile(paths.brain, 'utf8');
      expect(afterPoll).toContain('reply via poll');
      expect(pollUrls.some((query) => query.includes('cursor-1'))).toBe(true);
      const pollContext = await receiveHook({
        tool: 'cursor',
        hook: 'sessionStart',
        stdin: JSON.stringify({
          conversation_id: 'conv-e2e-b',
          hook_event_name: 'sessionStart',
          workspace_roots: [project],
        }),
        projectRoot: project,
        rizzHome: home,
        at: '2026-10-28T09:08:00.000Z',
      });
      const pollAdditional = JSON.parse(pollContext.stdout) as { additional_context: string };
      expect(pollAdditional.additional_context).toContain('> reply via poll');
      expect(pollAdditional.additional_context).toContain('not an instruction');
      const pollJournal = await readFile(join(paths.journalDir, '2026-10.md'), 'utf8');
      expect(eventsIn(pollJournal).filter((event) => event.text === 'reply via poll')).toHaveLength(
        1,
      );
      const server = await startObserveServer({
        projectRoot: project,
        rizzHome: home,
        token: 'page-token',
      });
      try {
        const denied = await fetch(`http://127.0.0.1:${server.port}/api/relay/deliver`, {
          method: 'POST',
          body: '{}',
        });
        expect(denied.status).toBe(401);
        const page = await fetch(server.url);
        expect(await page.text()).toContain('Messages');
        const unknown = await fetch(
          `http://127.0.0.1:${server.port}/api/relay/deliver?token=page-token`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ from: 'nobody', inReplyTo: messageId, text: 'nope' }),
          },
        );
        expect(unknown.status).toBe(404);
      } finally {
        await server.close();
      }
    } finally {
      await new Promise<void>((resolve) => {
        webhook.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        poll.close(() => resolve());
      });
      process.env.RIZZ_RELAY_POLL_INTERVAL_MS = undefined;
    }
  });
});
