import { describe, expect, it } from 'vitest';
import { normalizeTaskDeliverables } from '../../../src/modules/worker/services/workerTaskDeliverables';

describe('worker task detail deliverables', () => {
  it('normalizes and sorts deliverables by createdAt', () => {
    const normalized = normalizeTaskDeliverables([
      {
        id: 'd2',
        name: 'legacy-notes.txt',
        source: 'legacy-artifact',
        mimeType: 'text/plain',
        createdAt: '2026-02-13T12:00:02.000Z',
      },
      {
        id: 'd1',
        name: 'final-report.md',
        source: 'deliverable',
        mimeType: 'text/markdown',
        createdAt: '2026-02-13T12:00:01.000Z',
      },
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized[0].name).toBe('final-report.md');
    expect(normalized[1].name).toBe('legacy-notes.txt');
  });
});
