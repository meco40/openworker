import { beforeEach, describe, expect, it, vi } from 'vitest';

import { retrieveContext } from '@/server/world-model/retrieval';

let mockConfig: { enabled: boolean; e2eEnabled: boolean };
const findStructured = vi.fn();
const fullText = vi.fn();
const getEmbeddingProvider = vi.fn();
const generateEmbeddingOnce = vi.fn();
const vectorSearch = vi.fn();

vi.mock('@/server/world-model/config', () => ({
  getWorldModelConfig: () => mockConfig,
}));

vi.mock('@/server/world-model/retrieval/structured', () => ({
  findStructuredEvents: (...args: unknown[]) => findStructured(...args),
}));

vi.mock('@/server/world-model/retrieval/fulltext', () => ({
  fullTextSearchAssertions: (...args: unknown[]) => fullText(...args),
}));
vi.mock('@/server/world-model/embeddings/provider', () => ({
  getConfiguredEmbeddingProvider: (...args: unknown[]) => getEmbeddingProvider(...args),
  generateEmbeddingOnce: (...args: unknown[]) => generateEmbeddingOnce(...args),
}));
vi.mock('@/server/world-model/retrieval/vector', () => ({
  vectorSearch: (...args: unknown[]) => vectorSearch(...args),
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
    getEmbeddingProvider.mockReset();
    generateEmbeddingOnce.mockReset();
    vectorSearch.mockReset();
    getEmbeddingProvider.mockReturnValue(null);
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

  it('starts independent canonical retrieval lanes concurrently', async () => {
    let releaseStructured!: (value: []) => void;
    let releaseFullText!: (value: []) => void;
    findStructured.mockImplementation(
      () => new Promise<[]>((resolve) => (releaseStructured = resolve)),
    );
    fullText.mockImplementation(() => new Promise<[]>((resolve) => (releaseFullText = resolve)));

    const pending = retrieveContext({ userId: 'u', personaId: 'p', query: 'kino' });
    await vi.waitFor(() => {
      expect(findStructured).toHaveBeenCalledTimes(1);
      expect(fullText).toHaveBeenCalledTimes(1);
    });
    releaseStructured([]);
    releaseFullText([]);

    await expect(pending).resolves.toMatchObject({ enabled: true, source: 'none' });
  });

  it('keeps full-text results when structured event retrieval fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    findStructured.mockRejectedValue(new Error('events unavailable'));
    fullText.mockResolvedValue([
      {
        id: 'a1',
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
    consoleError.mockRestore();
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

  it('keeps generic memory vectors in the lifecycle-aware Memory source', async () => {
    const provider = {
      model: 'embed-test',
      modelVersion: '1',
      generateEmbedding: vi.fn(),
    };
    getEmbeddingProvider.mockReturnValue(provider);
    generateEmbeddingOnce.mockResolvedValue([0.1, 0.2]);
    vectorSearch.mockResolvedValue([]);

    await retrieveContext({ userId: 'u', personaId: 'p', query: 'kino' });

    expect(generateEmbeddingOnce).toHaveBeenCalledWith(provider, 'kino');
    expect(vectorSearch).toHaveBeenCalledWith([0.1, 0.2], 'u', 'p', '', 5, 0.5, {
      exclude: ['memory'],
    });
  });
});
