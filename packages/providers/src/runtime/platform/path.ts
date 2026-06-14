// Platform path service (design §6, D-008). All tool path math goes through here so the loop and
// tools stay OS-agnostic — no raw string concatenation of separators, and `~` resolves the same way
// on Mac/Linux/Windows. Cross-platform is a first-class M3 concern, not deferred.

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** Expand a leading `~` / `~/...` to the user's home directory. Other `~user` forms are left as-is. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a tool-supplied path against the workspace root. Absolute paths are honored as given
 * (after `~` expansion); relative paths resolve under `cwd`. Returns a normalized absolute path.
 */
export function resolveWorkspacePath(cwd: string, p: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}
