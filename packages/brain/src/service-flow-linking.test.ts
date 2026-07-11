import { describe, expect, it } from 'vitest';

import { serviceIdsForFiles, serviceMatchesFlowFile } from './service-flow-linking.js';

const baseService = {
  id: 'service:scripts',
  name: 'scripts',
  confidence: 'inferred' as const,
  evidence_ids: ['evidence:file-scripts--upload-adapter-test-results.mjs'],
  source_files: ['scripts/upload-adapter-test-results.mjs'],
  data: {
    service_root: 'scripts',
    entrypoints: ['scripts/upload-adapter-test-results.mjs'],
  },
};

describe('service flow linking precision', () => {
  it('does not link every top-level script folder file to a one-file service', () => {
    expect(serviceMatchesFlowFile(baseService, 'scripts/check-examples.sh')).toBe(false);
    expect(serviceIdsForFiles(['scripts/check-examples.sh'], [baseService])).toEqual([]);
  });

  it('keeps direct service source and nested service root matches', () => {
    expect(serviceMatchesFlowFile(baseService, 'scripts/upload-adapter-test-results.mjs')).toBe(
      true,
    );

    const nestedService = {
      ...baseService,
      id: 'service:src--sessions',
      name: 'src/sessions',
      source_files: ['src/sessions/store.ts'],
      data: { service_root: 'src/sessions', entrypoints: ['src/sessions/store.ts'] },
    };

    expect(serviceMatchesFlowFile(nestedService, 'src/sessions/handler.ts')).toBe(true);
  });
});
