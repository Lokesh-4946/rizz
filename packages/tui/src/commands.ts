// Pure slash-command parser for the Simple-mode TUI (UI/UX spec §5, D-032). A line either runs a
// command or is chat sent to the model. Parsing is separated from handling so it is unit-testable
// without a TTY, and so commands route to their handler in demo mode instead of being echoed as user
// text (D-032). Unknown `/x` is reported, not silently treated as chat.

/** @internal */
export type Command =
  | { readonly kind: 'chat'; readonly text: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'help' }
  | { readonly kind: 'login' }
  | { readonly kind: 'model' }
  | { readonly kind: 'status' }
  | { readonly kind: 'theme'; readonly arg?: string }
  | { readonly kind: 'plan' }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'unknown'; readonly name: string };

/** @internal */
export function parseCommand(line: string): Command {
  const input = line.trim();
  if (input === '') return { kind: 'empty' };
  if (!input.startsWith('/')) return { kind: 'chat', text: input };

  const [word, ...rest] = input.slice(1).split(/\s+/);
  const name = (word ?? '').toLowerCase();
  const arg = rest.join(' ').trim();

  switch (name) {
    case 'exit':
    case 'quit':
      return { kind: 'exit' };
    case 'help':
      return { kind: 'help' };
    case 'login':
      return { kind: 'login' };
    case 'model':
      return { kind: 'model' };
    case 'status':
      return { kind: 'status' };
    case 'theme':
      return arg === '' ? { kind: 'theme' } : { kind: 'theme', arg };
    case 'plan':
      return { kind: 'plan' };
    case 'workspace':
      return { kind: 'workspace' };
    default:
      return { kind: 'unknown', name };
  }
}

/** `/theme set <name>` → the name; `/theme <name>` is also accepted. Returns undefined for a bare list. */
/** @internal */
export function parseThemeArg(arg: string | undefined): string | undefined {
  if (arg === undefined || arg === '') return undefined;
  const parts = arg.split(/\s+/);
  if (parts[0] === 'set') return parts.slice(1).join(' ') || undefined;
  return arg;
}
