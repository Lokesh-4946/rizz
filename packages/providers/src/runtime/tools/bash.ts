// `bash` tool (design §2.5) — the maximum-severity safety surface. The service does two jobs, kept
// separate: `classifyCommand` (a PURE function) labels a command read-only | destructive | networked
// and whether it needs approval; `runBash` actually executes. The service NEVER self-approves — it
// only classifies. The loop (orchestration) is what blocks and asks the user (design §2.5, ADR-001
// rule 7). This is the explicit answer to the documented bypassable-allowlist failures where
// `rm -rf` ran unprompted (latent-demands §5, issues #6608/#10077/#15711).
//
// Policy: allow-by-pattern ONLY for read-only; everything destructive or networked is
// deny-by-default until approved. The classifier is conservative — an unknown command is treated as
// destructive and asks. Parsing is shell-operator aware so a piped/chained command is classified by
// its most dangerous segment.

import { execFile } from 'node:child_process';
import { type Result, RizzError, err, ok } from '../../result.js';

export type CommandClass = 'read-only' | 'destructive' | 'networked';

export interface Classification {
  readonly kind: CommandClass;
  readonly requiresApproval: boolean;
  readonly reason: string;
}

export interface BashParams {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface BashResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

// Programs that only observe. Anything not in here is suspect (conservative default).
const READ_ONLY = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'which',
  'whoami',
  'date',
  'printenv',
  'grep',
  'rg',
  'tree',
  'stat',
  'file',
  'du',
  'df',
  'basename',
  'dirname',
  'realpath',
  'sort',
  'uniq',
  'cut',
  'diff',
  'tsc',
  'vitest',
  'jest',
  'biome',
]);
// NOTE: `node`/`python`/`ruby`/`perl` are deliberately NOT read-only — `node -e "..."` executes
// arbitrary code and would bypass the approval gate. So are `env` (`env FOO=x rm -rf .` runs a
// program) and `find` (handled specially below, since `-exec`/`-delete` run/remove). They fall
// through to "unknown → destructive".

// `find` flags that execute a program or delete files — these make a `find` command dangerous.
const FIND_DANGEROUS = /\s-(exec|execdir|ok|okdir|delete)\b/;
// `fd`'s exec flags run an arbitrary program per match (the same hazard as `find -exec`).
const FD_DANGEROUS = /\s(-x|--exec|-X|--exec-batch)\b/;

// Programs that mutate the filesystem or process state — always approve.
const DESTRUCTIVE = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'dd',
  'mkfs',
  'shred',
  'truncate',
  'chmod',
  'chown',
  'ln',
  'kill',
  'killall',
  'pkill',
  'shutdown',
  'reboot',
  'mkdir',
  'touch',
  'tee',
]);

// Programs that touch the network — always approve (exfiltration + surprise-install risk).
const NETWORKED = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'telnet',
  'ftp',
  'pip',
  'pip3',
  'brew',
  'apt',
  'apt-get',
  'docker',
  'kubectl',
]);

const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse']);
const NETWORKED_GIT = new Set(['push', 'pull', 'fetch', 'clone']);
// `git remote` is read-only when listing (`git remote`, `git remote -v`, `git remote show`) but
// mutates repo config with these sub-subcommands → approve.
const MUTATING_REMOTE = new Set(['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'prune']);
const NODE_PM = new Set(['npm', 'pnpm', 'yarn']);
const NETWORKED_PM_SUBCMD = new Set(['install', 'i', 'add', 'ci', 'update', 'up', 'dlx', 'create']);
const READ_ONLY_PM_SUBCMD = new Set(['test', 'run', 'list', 'ls', 'why', 'outdated']);

function classifySegment(segment: string): Classification {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const program = tokens[0];
  if (program === undefined) {
    return { kind: 'read-only', reason: 'empty segment', requiresApproval: false };
  }

  // Truncating/appending redirects mutate a file regardless of the program. Ignore the stderr-merge
  // forms (`2>&1`, `>&2`) which don't write a file; any remaining `>` is a file write.
  const withoutStderrMerge = segment.replace(/\d?>&\d/g, '');
  if (/>/.test(withoutStderrMerge)) {
    return { kind: 'destructive', reason: 'redirect writes to a file', requiresApproval: true };
  }

  // `find` is read-only when searching, but `-exec`/`-delete` run programs or remove files → approve.
  if (program === 'find') {
    if (FIND_DANGEROUS.test(segment)) {
      return {
        kind: 'destructive',
        reason: 'find -exec/-delete runs or removes',
        requiresApproval: true,
      };
    }
    return { kind: 'read-only', reason: 'find searches', requiresApproval: false };
  }

  // `fd` mirrors `find`: read-only when searching, but -x/--exec/-X runs an arbitrary program.
  if (program === 'fd') {
    if (FD_DANGEROUS.test(segment)) {
      return { kind: 'destructive', reason: 'fd --exec runs a program', requiresApproval: true };
    }
    return { kind: 'read-only', reason: 'fd searches', requiresApproval: false };
  }

  // `sort` reads, but `-o`/`--output` writes (even in place) without a shell `>` → approve. NOTE:
  // any read-only program added above that can write via a flag needs a guard like this one.
  if (program === 'sort' && /\s(-o|--output)(=|\s|$)/.test(segment)) {
    return { kind: 'destructive', reason: 'sort -o writes a file', requiresApproval: true };
  }

  if (NETWORKED.has(program)) {
    return { kind: 'networked', reason: `${program} touches the network`, requiresApproval: true };
  }
  if (DESTRUCTIVE.has(program)) {
    return {
      kind: 'destructive',
      reason: `${program} mutates the filesystem`,
      requiresApproval: true,
    };
  }

  if (program === 'git') {
    const sub = tokens[1] ?? '';
    if (NETWORKED_GIT.has(sub)) {
      return {
        kind: 'networked',
        reason: `git ${sub} touches the network`,
        requiresApproval: true,
      };
    }
    if (sub === 'remote') {
      const remoteSub = tokens[2] ?? '';
      if (MUTATING_REMOTE.has(remoteSub)) {
        return {
          kind: 'destructive',
          reason: `git remote ${remoteSub} edits config`,
          requiresApproval: true,
        };
      }
      return { kind: 'read-only', reason: 'git remote lists', requiresApproval: false };
    }
    if (READ_ONLY_GIT.has(sub)) {
      return { kind: 'read-only', reason: `git ${sub} only reads`, requiresApproval: false };
    }
    // git add/commit/reset/clean/checkout/rebase/... mutate the tree → approve.
    return { kind: 'destructive', reason: `git ${sub} mutates the repo`, requiresApproval: true };
  }

  if (NODE_PM.has(program)) {
    const sub = tokens[1] ?? '';
    if (NETWORKED_PM_SUBCMD.has(sub)) {
      return {
        kind: 'networked',
        reason: `${program} ${sub} fetches packages`,
        requiresApproval: true,
      };
    }
    if (READ_ONLY_PM_SUBCMD.has(sub)) {
      return { kind: 'read-only', reason: `${program} ${sub} is safe`, requiresApproval: false };
    }
    return { kind: 'destructive', reason: `${program} ${sub} may mutate`, requiresApproval: true };
  }

  if (READ_ONLY.has(program)) {
    return { kind: 'read-only', reason: `${program} only reads`, requiresApproval: false };
  }

  // Unknown → conservative: treat as destructive and ask (deny-by-default).
  return {
    kind: 'destructive',
    reason: `${program} is unknown — treated as destructive`,
    requiresApproval: true,
  };
}

/** Classify a (possibly chained/piped) command by its most dangerous segment. PURE — no execution. */
export function classifyCommand(command: string): Classification {
  // Command substitution ($(...) or backticks) hides a nested command the segment parser can't see
  // (`cat $(rm -rf .)`). We can't classify the inner command safely → require approval.
  if (/\$\(|`/.test(command)) {
    return {
      kind: 'destructive',
      reason: 'command substitution — cannot classify safely',
      requiresApproval: true,
    };
  }

  const segments = command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return { kind: 'read-only', reason: 'empty command', requiresApproval: false };
  }

  const classes = segments.map(classifySegment);
  const networked = classes.find((c) => c.kind === 'networked');
  if (networked) return networked;
  const destructive = classes.find((c) => c.requiresApproval);
  if (destructive) return { ...destructive, kind: 'destructive' };
  return { kind: 'read-only', reason: 'all segments read-only', requiresApproval: false };
}

/** Execute a command. Approval (if required) is the loop's responsibility — this just runs. */
export function runBash(params: BashParams): Promise<Result<BashResult>> {
  const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    const options: Parameters<typeof execFile>[2] = {
      cwd: params.cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      ...(params.signal ? { signal: params.signal } : {}),
    };
    execFile(shellProgram(), [shellFlag(), params.command], options, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        resolvePromise(err(new RizzError('INTERRUPTED', 'command interrupted')));
        return;
      }
      const exitCode = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
      resolvePromise(ok({ stdout: String(stdout), stderr: String(stderr), exitCode }));
    });
  });
}

// Platform-aware shell selection (D-008). POSIX uses `sh -c`; Windows uses `cmd /c`.
function shellProgram(): string {
  return process.platform === 'win32' ? 'cmd' : 'sh';
}
function shellFlag(): string {
  return process.platform === 'win32' ? '/c' : '-c';
}
