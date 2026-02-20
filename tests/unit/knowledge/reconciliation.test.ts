import { describe, it, expect } from 'vitest';
import { detectOrphans, type StoreEntry } from '@/server/knowledge/reconciliation';

describe('detectOrphans', () => {
  it('detects mem0 orphans (in mem0 but not in knowledge)', () => {
    const mem0: StoreEntry[] = [
      { id: 'mem-1', content: 'Max ist Bruder' },
      { id: 'mem-2', content: 'Lisa mag Pizza' },
    ];
    const knowledge: StoreEntry[] = [
      { id: 'kn-1', content: 'Max ist Bruder', externalRef: 'mem-1' },
    ];
    const report = detectOrphans(mem0, knowledge);
    expect(report.mem0OrphansFound).toBe(1);
    expect(report.mem0Orphans[0].id).toBe('mem-2');
  });

  it('detects knowledge orphans (in knowledge but not in mem0)', () => {
    const mem0: StoreEntry[] = [{ id: 'mem-1', content: 'Max ist Bruder' }];
    const knowledge: StoreEntry[] = [
      { id: 'kn-1', content: 'Max ist Bruder', externalRef: 'mem-1' },
      { id: 'kn-2', content: 'Lisa mag Pizza', externalRef: 'mem-2' },
    ];
    const report = detectOrphans(mem0, knowledge);
    expect(report.knowledgeOrphansFound).toBe(1);
    expect(report.knowledgeOrphans[0].id).toBe('kn-2');
  });

  it('reports zero when everything is consistent', () => {
    const mem0: StoreEntry[] = [{ id: 'mem-1', content: 'Max ist Bruder' }];
    const knowledge: StoreEntry[] = [
      { id: 'kn-1', content: 'Max ist Bruder', externalRef: 'mem-1' },
    ];
    const report = detectOrphans(mem0, knowledge);
    expect(report.mem0OrphansFound).toBe(0);
    expect(report.knowledgeOrphansFound).toBe(0);
  });

  it('handles empty stores', () => {
    const report = detectOrphans([], []);
    expect(report.mem0OrphansFound).toBe(0);
    expect(report.knowledgeOrphansFound).toBe(0);
  });

  it('detects multiple orphans in both directions', () => {
    const mem0: StoreEntry[] = [
      { id: 'mem-1', content: 'A' },
      { id: 'mem-2', content: 'B' },
      { id: 'mem-3', content: 'C' },
    ];
    const knowledge: StoreEntry[] = [
      { id: 'kn-1', content: 'A', externalRef: 'mem-1' },
      { id: 'kn-4', content: 'D', externalRef: 'mem-99' },
    ];
    const report = detectOrphans(mem0, knowledge);
    expect(report.mem0OrphansFound).toBe(2); // mem-2, mem-3
    expect(report.knowledgeOrphansFound).toBe(1); // kn-4 (ref mem-99 not in mem0)
  });
});
