import { isRecord } from '../model.js';
import { loadRelayRows } from './board.js';
import { ingestRelayReply, sendRelayText } from './delivery.js';

const JSON_TYPE = 'application/json';
const BODY_CAP = 32_000;

function json(status: number, value: unknown): { status: number; body: string; type: string } {
  return { status, body: `${JSON.stringify(value)}\n`, type: JSON_TYPE };
}

function field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

export async function handleRelayHttp(options: {
  readonly method: string;
  readonly pathname: string;
  readonly rizzHome: string;
  readonly projectRoot: string;
  readonly body: string;
}): Promise<{ readonly status: number; readonly body: string; readonly type: string }> {
  if (options.body.length > BODY_CAP) return json(413, { ok: false, error: 'payload too large' });
  if (options.pathname === '/api/relay/messages' && options.method === 'GET') {
    const rows = await loadRelayRows(options.rizzHome, options.projectRoot);
    if (!rows.ok) return json(500, { ok: false, error: rows.error.message });
    return json(200, {
      ok: true,
      messages: rows.value.map((row) => ({
        id: row.messageId,
        at: row.at,
        direction: row.direction,
        relay: row.relay,
        text: row.text,
        status: row.label,
        unread: row.unread,
        inReplyTo: row.inReplyTo,
        delivery: row.delivery,
        reason: row.reason,
      })),
    });
  }
  if (options.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  let parsed: unknown;
  try {
    parsed = options.body.trim() === '' ? {} : JSON.parse(options.body);
  } catch {
    return json(400, { ok: false, error: 'body was not JSON' });
  }
  if (!isRecord(parsed)) return json(400, { ok: false, error: 'body was not an object' });
  if (options.pathname === '/api/relay/send') {
    const sent = await sendRelayText({
      rizzHome: options.rizzHome,
      to: field(parsed, 'to'),
      text: field(parsed, 'text'),
      projectRoot: options.projectRoot,
    });
    if (!sent.ok) return json(400, { ok: false, error: sent.error.message });
    return json(200, {
      ok: true,
      id: sent.value.id,
      status: sent.value.status,
      reason: sent.value.reason,
    });
  }
  if (options.pathname === '/api/relay/deliver') {
    const saved = await ingestRelayReply({
      rizzHome: options.rizzHome,
      from: field(parsed, 'from'),
      inReplyTo: field(parsed, 'inReplyTo'),
      text: field(parsed, 'text'),
      at: new Date().toISOString(),
      fallbackProjectRoot: options.projectRoot,
    });
    if (!saved.ok) {
      const status = saved.error.code === 'UNKNOWN_RELAY' ? 404 : 400;
      return json(status, { ok: false, error: saved.error.message });
    }
    return json(200, { ok: true, id: saved.value.id, status: saved.value.status });
  }
  return json(404, { ok: false, error: 'unknown relay route' });
}
