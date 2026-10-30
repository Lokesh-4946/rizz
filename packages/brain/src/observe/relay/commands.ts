import { stat } from 'node:fs/promises';
import {
  addRelay,
  listRelays,
  readRelay,
  relayConfigPath,
  removeRelay,
  toPublic,
} from './config.js';
import { DEFAULT_REPLY_WAIT_MS, RELAY_KEY_ENV, isRelayName, parseReplyWait } from './contract.js';
import { ingestRelayReply, sendRelayText } from './delivery.js';

export interface RelayCommandContext {
  readonly cwd: string;
  readonly rizzHome: string;
  readonly stdin: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function flagValue(
  argv: readonly string[],
  name: string,
): { readonly value: string | undefined; readonly missing: boolean; readonly rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  let missing = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== name) {
      if (token !== undefined) rest.push(token);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) missing = true;
    else {
      value = next;
      index += 1;
    }
  }
  return { value, missing, rest };
}

function writeError(message: string): void {
  process.stderr.write(`rizz: ${message}\n`);
}

export async function runRelayCommand(
  argv: readonly string[],
  context: RelayCommandContext,
): Promise<number> {
  const command = argv[0];
  if (command === 'msg') return sendMessage(argv.slice(1), context);
  if (command !== 'relay') {
    writeError(`unknown observe command '${command ?? ''}'`);
    return 2;
  }
  const action = argv[1];
  if (action === 'list') return list(context);
  if (action === 'remove') return remove(argv[2], context);
  if (action === 'add') return add(argv.slice(2), context);
  if (action === 'deliver') return deliver(argv.slice(2), context);
  process.stdout.write(`rizz relay — message a configured assistant

  rizz relay add <name> --url <webhook> [--poll-url <url>] [--reply-wait 10m]
  rizz relay list
  rizz relay remove <name>
  rizz relay deliver --from <name> --in-reply-to <id> [--text <text>] [text]
  rizz msg <name> <text>

The sender key is read from ${RELAY_KEY_ENV} or stdin. It is stored under the Rizz home
with mode 0600 and is never written to the brain, the journal, or logs.
`);
  return action === undefined || action === '--help' || action === '-h' ? 0 : 2;
}

async function add(argv: readonly string[], context: RelayCommandContext): Promise<number> {
  const name = argv[0];
  if (name === undefined || name.startsWith('--') || !isRelayName(name)) {
    writeError('relay add needs a lowercase name');
    return 2;
  }
  const url = flagValue(argv.slice(1), '--url');
  const poll = flagValue(url.rest, '--poll-url');
  const wait = flagValue(poll.rest, '--reply-wait');
  if (url.missing || poll.missing || wait.missing || url.value === undefined) {
    writeError('relay add needs --url <webhook>');
    return 2;
  }
  const replyWaitMs = wait.value === undefined ? DEFAULT_REPLY_WAIT_MS : parseReplyWait(wait.value);
  if (replyWaitMs === undefined) {
    writeError('reply wait must look like 10m, 30s, or 500ms');
    return 2;
  }
  const fromEnv = context.env[RELAY_KEY_ENV] ?? '';
  const senderKey = fromEnv.trim() !== '' ? fromEnv.trim() : context.stdin.trim();
  const saved = await addRelay({
    rizzHome: context.rizzHome,
    name,
    webhookUrl: url.value,
    pollUrl: poll.value ?? '',
    senderKey,
    createdAt: new Date().toISOString(),
    replyWaitMs,
  });
  if (!saved.ok) {
    writeError(`${saved.error.code}: ${saved.error.message}`);
    return saved.error.code === 'BAD_REQUEST' ? 2 : 1;
  }
  process.stdout.write(`rizz relay ${saved.value.name} saved\n`);
  const info = await stat(relayConfigPath(context.rizzHome, name));
  if ((info.mode & 0o777) !== 0o600) {
    writeError('relay config was not stored with mode 0600');
    return 1;
  }
  return 0;
}

async function list(context: RelayCommandContext): Promise<number> {
  const configs = await listRelays(context.rizzHome);
  if (!configs.ok) {
    writeError(`${configs.error.code}: ${configs.error.message}`);
    return 1;
  }
  if (configs.value.length === 0) {
    process.stdout.write('no relays\n');
    return 0;
  }
  for (const config of configs.value) {
    const view = toPublic(config);
    const poll = view.pollConfigured ? 'yes' : 'no';
    process.stdout.write(
      `${view.name}  poll=${poll}  wait=${view.replyWaitMs}ms  url=${view.webhookUrl}\n`,
    );
  }
  return 0;
}

async function remove(name: string | undefined, context: RelayCommandContext): Promise<number> {
  if (name === undefined) {
    writeError('relay remove needs a name');
    return 2;
  }
  const removed = await removeRelay(context.rizzHome, name);
  if (!removed.ok) {
    writeError(`${removed.error.code}: ${removed.error.message}`);
    return removed.error.code === 'UNKNOWN_RELAY' ? 2 : 1;
  }
  process.stdout.write(`rizz relay ${name} removed\n`);
  return 0;
}

async function deliver(argv: readonly string[], context: RelayCommandContext): Promise<number> {
  const from = flagValue(argv, '--from');
  const replyTo = flagValue(from.rest, '--in-reply-to');
  const textFlag = flagValue(replyTo.rest, '--text');
  if (from.missing || replyTo.missing || textFlag.missing) {
    writeError('relay deliver needs --from and --in-reply-to');
    return 2;
  }
  if (from.value === undefined || replyTo.value === undefined) {
    writeError('relay deliver needs --from and --in-reply-to');
    return 2;
  }
  const text = textFlag.value ?? textFlag.rest.join(' ').trim();
  const known = await readRelay(context.rizzHome, from.value);
  if (!known.ok) {
    writeError(`${known.error.code}: ${known.error.message}`);
    return 1;
  }
  if (known.value === undefined) {
    writeError(`unknown relay '${from.value}'`);
    return 2;
  }
  const saved = await ingestRelayReply({
    rizzHome: context.rizzHome,
    from: from.value,
    inReplyTo: replyTo.value,
    text,
    at: new Date().toISOString(),
    fallbackProjectRoot: context.cwd,
  });
  if (!saved.ok) {
    writeError(`${saved.error.code}: ${saved.error.message}`);
    const code = saved.error.code;
    return code === 'UNKNOWN_RELAY' || code === 'BAD_REQUEST' || code === 'PAYLOAD_TOO_LARGE'
      ? 2
      : 1;
  }
  process.stdout.write(`rizz relay ${saved.value.status} ${saved.value.id}\n`);
  return 0;
}

async function sendMessage(argv: readonly string[], context: RelayCommandContext): Promise<number> {
  const name = argv[0];
  const text = argv.slice(1).join(' ').trim();
  if (name === undefined || text === '') {
    writeError('msg needs an assistant name and text');
    return 2;
  }
  const sent = await sendRelayText({
    rizzHome: context.rizzHome,
    to: name,
    text,
    projectRoot: context.cwd,
  });
  if (!sent.ok) {
    writeError(`${sent.error.code}: ${sent.error.message}`);
    const code = sent.error.code;
    return code === 'UNKNOWN_RELAY' || code === 'PAYLOAD_TOO_LARGE' || code === 'BAD_REQUEST'
      ? 2
      : 1;
  }
  const reason = sent.value.reason === '' ? '' : ` ${sent.value.reason}`;
  process.stdout.write(`rizz msg ${sent.value.id} ${sent.value.status}${reason}\n`);
  return sent.value.status === 'failed' ? 1 : 0;
}
