import { beforeEach, describe, expect, it, vi } from 'vitest';

import { retrieveContext } from '@/server/world-model/retrieval';

let mockConfig: { enabled: boolean; e2eEnabled: boolean };
const findStructured = vi.fn();
const fullText = vi.fn();

vi.mock('@/server/world-model/config', () => ({
  getWorldModelConfig: () => mockConfig,
}));

vi.mock('@/server/world-model/retrieval/structured', () => ({
  findStructuredEvents: (...args: unknown[]) => findStructured(...args),
}));

vi.mock('@/server/world-model/retrieval/fulltext', () => ({
  fullTextSearchAssertions: (...args: unknown[]) => fullText(...args),
}));
vi.mock('@/server/world-model/retrieval/assertions', () => ({
  searchAssertions: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/server/world-model/retrieval/tasks', () => ({
  searchTasks: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/server/world-model/retrieval/relations', () => ({
  searchRelations: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/server/world-model/retrieval/openLoops', () => ({
  searchOpenLoops: vi.fn().mockResolvedValue([]),
}));

describe('retrieveContext', () => {
  beforeEach(() => {
    mockConfig = { enabled: true, e2eEnabled: false };
    findStructured.mockReset();
    fullText.mockReset();
    findStructured.mockResolvedValue([]);
    fullText.mockResolvedValue([]);
  });

  it('is fail-closed when disabled', async () => {
    mockConfig = { enabled: false, e2eEnabled: false };
    const result = await retrieveContext({ userId: 'u', personaId: 'p', query: 'kino' });
    expect(result.enabled).toBe(false);
    expect(result.source).toBe('none');
    expect(findStructured).not.toHaveBeenCalled();
  });

  it('retains structured state as the highest-priority source in the aggregate', async () => {
    findStructured.mockResolvedValue([
      { id: 'e1', title: 'Kino', status: 'cancelled', timeline: [] },
    ]);
    const result = await retrieveContext({ userId: 'u', personaId: 'p', query: 'kino' });
    expect(result.source).toBe('structured');
    expect(result.structured).toHaveLength(1);
    expect(fullText).toHaveBeenCalled();
  });

  it('falls back to fulltext when no structured hit exists', async () => {
    fullText.mockResolvedValue([
      {
        predicate: 'prefers',
        objectValue: 'Kino',
        modality: 'reported',
        status: 'active',
        confidence: 0.9,
      },
    ]);
    const result = await retrieveContext({ userId: 'u', personaId: 'p', query: 'kino' });
    expect(result.source).toBe('fulltext');
    expect(result.fullText).toHaveLength(1);
  });

  it('reports none when both are empty', async () => {
    const result = await retrieveContext({ userId: 'u', personaId: 'p', query: 'unbekannt' });
    expect(result.source).toBe('none');
    expect(result.enabled).toBe(true);
  });
});
