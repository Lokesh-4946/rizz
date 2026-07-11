import { describe, expect, it } from 'vitest';
import { mergeFileConsumers } from './file-explain-intelligence.js';

describe('file explain consumer projection', () => {
  it('drops generic consumer fallback when exact route evidence exists', () => {
    expect(
      mergeFileConsumers({
        recorded: ['Other project components; exact consumers need deeper flow analysis.'],
        relationships: ['depends_on: flow:nextjs--page--src--app--page.tsx'],
        routes: ['route consumer: / via src/app/page.tsx'],
      }),
    ).toEqual([
      'depends_on: flow:nextjs--page--src--app--page.tsx',
      'route consumer: / via src/app/page.tsx',
    ]);
  });

  it('keeps generic consumer fallback when no exact evidence exists', () => {
    expect(
      mergeFileConsumers({
        recorded: ['Other project components; exact consumers need deeper flow analysis.'],
        relationships: [],
        routes: [],
      }),
    ).toEqual(['Other project components; exact consumers need deeper flow analysis.']);
  });
});
