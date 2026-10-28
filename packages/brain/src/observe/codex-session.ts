import { readFile } from 'node:fs/promises';
import { type ObserveEvent, isRecord, normalizeHook } from './model.js';
import { type StaffResult, staffErr, staffOk } from './result.js';

/**
 * Best-effort reader for Codex rollout JSONL.
 * `.jsonl.zst` is recognized and refused: decoding it would add a dependency.
 * The line schema is not a stable Codex contract.
 */
export async function readCodexRollout(options: {
  readonly path: string;
  readonly projectRoot: string;
  readonly at: string;
}): Promise<StaffResult<readonly ObserveEvent[]>> {
  if (options.path.endsWith('.zst')) {
    return staffErr(
      'CODEX_ROLLUP_COMPRESSED',
      'Codex rollout is zstd-compressed. Rizz does not decode .jsonl.zst.',
    );
  }
  let raw = '';
  try {
    raw = await readFile(options.path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return staffErr('IO_FAILED', message);
  }
  const events: ObserveEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const payload = isRecord(parsed.payload) ? parsed.payload : parsed;
    const type = typeof parsed.type === 'string' ? parsed.type : '';
    const payloadType = typeof payload.type === 'string' ? payload.type : '';
    if (type === 'session_meta' || payloadType === 'session_meta') {
      events.push(
        normalizeHook({
          tool: 'codex',
          hook: 'SessionStart',
          payload: {
            ...payload,
            session_id: typeof payload.id === 'string' ? payload.id : 'rollout',
            hook_event_name: 'SessionStart',
          },
          projectRoot: options.projectRoot,
          at: options.at,
        }),
      );
      continue;
    }
    if (payloadType === 'token_count' || type === 'token_count') {
      const info = isRecord(payload.info) ? payload.info : payload;
      const usage = isRecord(info.total_token_usage) ? info.total_token_usage : info;
      events.push(
        normalizeHook({
          tool: 'codex',
          hook: 'PreCompact',
          payload: {
            ...usage,
            hook_event_name: 'token_count',
            session_id: 'rollout',
          },
          projectRoot: options.projectRoot,
          at: options.at,
        }),
      );
    }
  }
  return staffOk(events);
}
