import { describe, expect, it } from 'vitest';
import { ownerDecisionSummary, renderSummary } from './summary.js';

describe('owner decision summary', () => {
  it('renders the open decisions and a parseable document', () => {
    const inbox = [{ id: 'dec-1', text: 'Should health require auth?', threadId: 'cursor-conv-1' }];
    const text = renderSummary({ threads: 1, inbox, dropped: 0 });
    expect(text).toContain('1 thread(s) observed.');
    expect(text).toContain('- Should health require auth? (cursor-conv-1)');
    expect(text).not.toContain('npm test');
    expect(ownerDecisionSummary({ threads: 1, inbox, dropped: 0 })).toEqual({
      threads: 1,
      dropped: 0,
      decisions: inbox,
    });
  });
});
