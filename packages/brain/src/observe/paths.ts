import { join } from 'node:path';

/** Observer files live inside the existing per-project store, not in the git repo. */
export interface ObservePaths {
  readonly root: string;
  readonly brain: string;
  readonly journalDir: string;
  readonly decisions: string;
  readonly vision: string;
  readonly threadsDir: string;
  readonly handoffsDir: string;
  readonly inboxDir: string;
  readonly ledger: string;
  readonly serveLock: string;
}

export function observePaths(projectDir: string): ObservePaths {
  const root = join(projectDir, 'observe');
  return {
    root,
    brain: join(root, 'BRAIN.md'),
    journalDir: join(root, 'journal'),
    decisions: join(root, 'decisions.md'),
    vision: join(root, 'vision.md'),
    threadsDir: join(root, 'threads'),
    handoffsDir: join(root, 'handoffs'),
    inboxDir: join(root, 'inbox'),
    ledger: join(root, 'ledger', 'tokens.jsonl'),
    serveLock: join(root, 'serve.lock'),
  };
}

export function spoolFile(rizzHome: string): string {
  return join(rizzHome, 'spool', 'events.jsonl');
}

export function spoolOffsetFile(rizzHome: string): string {
  return join(rizzHome, 'spool', 'offset.json');
}

export function spoolLock(rizzHome: string): string {
  return join(rizzHome, 'spool', 'lock');
}

/** One complete event per file. Hooks use this when the shared spool lock is busy. */
export function spoolPendingDir(rizzHome: string): string {
  return join(rizzHome, 'spool', 'pending');
}

/** Events that could not be queued. Summary counts these. */
export function spoolDropDir(rizzHome: string): string {
  return join(rizzHome, 'spool', 'drops');
}
