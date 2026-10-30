import { chmod, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isRecord } from '../model.js';
import { type StaffResult, staffErr, staffOk } from '../result.js';
import { DEFAULT_REPLY_WAIT_MS, isHttpUrl, isRelayName } from './contract.js';

export interface RelayConfig {
  readonly name: string;
  readonly webhookUrl: string;
  readonly pollUrl: string;
  readonly senderKey: string;
  readonly createdAt: string;
  readonly replyWaitMs: number;
}

export interface RelayPublic {
  readonly name: string;
  readonly webhookUrl: string;
  readonly pollUrl: string;
  readonly createdAt: string;
  readonly replyWaitMs: number;
  readonly pollConfigured: boolean;
}

function agentsDir(rizzHome: string): string {
  return join(rizzHome, 'relay', 'agents');
}

export function relayConfigPath(rizzHome: string, name: string): string {
  return join(agentsDir(rizzHome), `${name}.json`);
}

/** Windows does not report Unix permission bits. POSIX must be exactly 0600. */
export function isPrivateFileMode(mode: number): boolean {
  if (process.platform === 'win32') return true;
  return (mode & 0o777) === 0o600;
}

export function relayNoticePath(rizzHome: string): string {
  return join(rizzHome, 'relay', 'notice.txt');
}

export async function writePrivateFile(path: string, contents: string): Promise<StaffResult<void>> {
  const dir = dirname(path);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
    const actual = await readFile(path, 'utf8');
    if (actual !== contents) {
      return staffErr('WRITE_VERIFY_FAILED', `write to ${path} did not match what was read back`);
    }
    return staffOk(undefined);
  } catch (error) {
    await rm(tmp, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    return staffErr('IO_FAILED', `cannot write ${path}: ${message}`);
  }
}

function parseConfig(value: unknown, name: string): RelayConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (value.name !== name || typeof value.webhookUrl !== 'string') return undefined;
  if (typeof value.senderKey !== 'string' || value.senderKey === '') return undefined;
  const pollUrl = typeof value.pollUrl === 'string' ? value.pollUrl : '';
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : '';
  const replyWaitMs =
    typeof value.replyWaitMs === 'number' &&
    Number.isInteger(value.replyWaitMs) &&
    value.replyWaitMs >= 0
      ? value.replyWaitMs
      : DEFAULT_REPLY_WAIT_MS;
  return {
    name,
    webhookUrl: value.webhookUrl,
    pollUrl,
    senderKey: value.senderKey,
    createdAt,
    replyWaitMs,
  };
}

export function toPublic(config: RelayConfig): RelayPublic {
  return {
    name: config.name,
    webhookUrl: config.webhookUrl,
    pollUrl: config.pollUrl,
    createdAt: config.createdAt,
    replyWaitMs: config.replyWaitMs,
    pollConfigured: config.pollUrl !== '',
  };
}

export async function addRelay(options: {
  readonly rizzHome: string;
  readonly name: string;
  readonly webhookUrl: string;
  readonly pollUrl: string;
  readonly senderKey: string;
  readonly createdAt: string;
  readonly replyWaitMs: number;
}): Promise<StaffResult<RelayPublic>> {
  if (!isRelayName(options.name)) {
    return staffErr('BAD_REQUEST', 'relay name must be lowercase and start with a letter');
  }
  if (!isHttpUrl(options.webhookUrl)) {
    return staffErr('BAD_REQUEST', 'relay url must be http or https');
  }
  if (options.pollUrl !== '' && !isHttpUrl(options.pollUrl)) {
    return staffErr('BAD_REQUEST', 'poll url must be http or https');
  }
  if (options.senderKey.trim() === '') {
    return staffErr('BAD_REQUEST', 'sender key is empty; set RIZZ_RELAY_KEY or pipe it on stdin');
  }
  const config: RelayConfig = {
    name: options.name,
    webhookUrl: options.webhookUrl,
    pollUrl: options.pollUrl,
    senderKey: options.senderKey.trim(),
    createdAt: options.createdAt,
    replyWaitMs: options.replyWaitMs,
  };
  const written = await writePrivateFile(
    relayConfigPath(options.rizzHome, options.name),
    `${JSON.stringify(config)}\n`,
  );
  if (!written.ok) return written;
  return staffOk(toPublic(config));
}

export async function readRelay(
  rizzHome: string,
  name: string,
): Promise<StaffResult<RelayConfig | undefined>> {
  if (!isRelayName(name)) return staffOk(undefined);
  try {
    const raw = await readFile(relayConfigPath(rizzHome, name), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return staffOk(parseConfig(parsed, name));
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (code === 'ENOENT') return staffOk(undefined);
    return staffErr('IO_FAILED', `cannot read relay ${name}`);
  }
}

export async function listRelays(rizzHome: string): Promise<StaffResult<readonly RelayConfig[]>> {
  let names: string[] = [];
  try {
    names = (await readdir(agentsDir(rizzHome))).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (code === 'ENOENT') return staffOk([]);
    return staffErr('IO_FAILED', 'cannot list relays');
  }
  const configs: RelayConfig[] = [];
  for (const fileName of names) {
    const name = fileName.slice(0, -'.json'.length);
    const config = await readRelay(rizzHome, name);
    if (!config.ok) return config;
    if (config.value !== undefined) configs.push(config.value);
  }
  return staffOk(configs);
}

export async function removeRelay(rizzHome: string, name: string): Promise<StaffResult<'removed'>> {
  if (!isRelayName(name)) return staffErr('UNKNOWN_RELAY', `unknown relay '${name}'`);
  const existing = await readRelay(rizzHome, name);
  if (!existing.ok) return existing;
  if (existing.value === undefined) return staffErr('UNKNOWN_RELAY', `unknown relay '${name}'`);
  try {
    await rm(relayConfigPath(rizzHome, name), { force: true });
  } catch {
    return staffErr('IO_FAILED', `cannot remove relay ${name}`);
  }
  return staffOk('removed');
}

export async function writeRelayNotice(rizzHome: string, message: string): Promise<void> {
  const safe = message.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 300);
  await writePrivateFile(relayNoticePath(rizzHome), `${safe}\n`);
}

export async function readRelayNotice(rizzHome: string): Promise<string> {
  try {
    return (await readFile(relayNoticePath(rizzHome), 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function clearRelayNotice(rizzHome: string): Promise<void> {
  await rm(relayNoticePath(rizzHome), { force: true });
}
