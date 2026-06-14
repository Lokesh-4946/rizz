// The four-tool schema fed to the model (design §2, Pi parity: four default tools, sub-1k-token
// system surface). grep/find/ls stay OPT-IN and off by default (D-018) — they are NOT in this set.
// Descriptions are deliberately terse to keep the token surface minimal (lightweight constraint).

export interface ToolSpec {
  readonly name: 'read' | 'write' | 'edit' | 'bash';
  readonly description: string;
  /** A minimal JSON-schema object describing the args; kept small on purpose. */
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: readonly string[];
  };
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'read',
    description: 'Read a UTF-8 text file. Returns content and a hash to anchor a later edit.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
        offset: { type: 'number', description: 'First line to return (0-based). Optional.' },
        limit: { type: 'number', description: 'Max lines to return. Defaults to 2000.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: 'Create or overwrite a file. Verifies the bytes landed before reporting success.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description:
      'Replace an exact, unique snippet in a file. Fails if oldText is missing, ambiguous, or the file changed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit.' },
        oldText: {
          type: 'string',
          description: 'Exact text to replace (must occur exactly once).',
        },
        newText: { type: 'string', description: 'Replacement text.' },
        baseHash: {
          type: 'string',
          description: 'Hash from the prior read, to detect staleness. Optional.',
        },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command. Read-only commands run directly; destructive/networked ones require approval.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        timeoutMs: { type: 'number', description: 'Timeout in ms. Optional.' },
      },
      required: ['command'],
    },
  },
];
