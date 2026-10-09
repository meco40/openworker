import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatWorldModelContext,
  retrieveContext,
  type RetrievalContextResult,
} from '@/server/world-model/retrieval';

const mocks = vi.hoisted(() => ({
  searchAssertions: vi.fn().mockResolvedValue([]),
  searchTasks: vi.fn().mockResolvedValue([]),
  searchRelations: vi.fn().mockResolvedValue([]),
  searchOpenLoops: vi.fn().mockResolvedValue([]),
  searchGraphitiFactsWithRerank: vi.fn().mockResolvedValue([]),
}));

let mockConfig: {
  enabled: boolean;
  e2eEnabled: boolean;
  graphitiRecallEnabled: boolean;
  graphitiBackendEnabled: boolean;
};
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
  searchAssertions: mocks.searchAssertions,
}));
vi.mock('@/server/world-model/retrieval/tasks', () => ({
  searchTasks: mocks.searchTasks,
}));
vi.mock('@/server/world-model/retrieval/relations', () => ({
  searchRelations: mocks.searchRelations,
}));
vi.mock('@/server/world-model/retrieval/openLoops', () => ({
  searchOpenLoops: mocks.searchOpenLoops,
}));
vi.mock('@/server/world-model/graphiti/retrieval', () => ({
  searchGraphitiFactsWithRerank: mocks.searchGraphitiFactsWithRerank,
}));

describe('retrieveContext', () => {
  beforeEach(() => {
    mockConfig = {
      enabled: true,
      e2eEnabled: false,
      graphitiRecallEnabled: false,
      graphitiBackendEnabled: false,
    };
    findStructured.mockReset();
    fullText.mockReset();
    findStructured.mockResolvedValue([]);
    fullText.mockResolvedValue([]);
    getEmbeddingProvider.mockReset();
    generateEmbeddingOnce.mockReset();
    vectorSearch.mockReset();
    getEmbeddingProvider.mockReturnValue(null);
    mocks.searchAssertions.mockReset().mockResolvedValue([]);
    mocks.searchTasks.mockReset().mockResolvedValue([]);
    mocks.searchRelations.mockReset().mockResolvedValue([]);
    mocks.searchOpenLoops.mockReset().mockResolvedValue([]);
    mocks.searchGraphitiFactsWithRerank.mockReset().mockResolvedValue([]);
  });

  it('is fail-closed when disabled', async () => {
    mockConfig = {
      enabled: false,
      e2eEnabled: false,
      graphitiRecallEnabled: false,
      graphitiBackendEnabled: false,
    };
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

  it.each([
    ['Was habe ich mit Kino gemacht?', ['completed', 'attended']],
    ['Was ist mit Kino geplant?', ['planned', 'proposed', 'in_progress']],
    ['Was ist mit Kino abgesagt?', ['cancelled', 'no_show']],
    ['Was steht noch offen?', ['planned', 'proposed', 'in_progress']],
    ['Kino', undefined],
  ])('passes the planned event status filter for "%s"', async (query, statusFilter) => {
    await retrieveContext({ userId: 'u', personaId: 'p', query });

    expect(findStructured.mock.calls[0]?.[0]).toMatchObject({ statusFilter });
  });

  it('bounds limits and passes explicit workspace and temporal scope to the canonical lanes', async () => {
    await retrieveContext({
      userId: 'u',
      personaId: 'p',
      workspaceId: 'w',
      query: 'Was habe ich mit Kino gemacht?',
      limit: 80,
      asOfKnownTime: '2024-01-02T00:00:00.000Z',
      asOfValidTime: '2024-02-03T00:00:00.000Z',
    });

    expect(findStructured.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'w',
      term: 'Kino',
      limit: 50,
      validAsOf: '2024-02-03T00:00:00.000Z',
      knownAsOf: '2024-01-02T00:00:00.000Z',
    });
    expect(fullText.mock.calls[0]?.slice(0, 5)).toEqual([
      'u',
      'p',
      'w',
      'Was habe ich mit Kino gemacht?',
      50,
    ]);
  });

  it('allows E2E retrieval when the regular world model is disabled', async () => {
    mockConfig.enabled = false;
    mockConfig.e2eEnabled = true;

    const result = await retrieveContext({ userId: 'u', personaId: 'p', query: 'Kino' });

    expect(result).toMatchObject({ enabled: true, source: 'none' });
    expect(findStructured).toHaveBeenCalledOnce();
  });

  it('treats full-text failures as an empty lane and continues with other results', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fullText.mockRejectedValue(new Error('full-text unavailable'));
    mocks.searchTasks.mockResolvedValue([
      {
        id: 'task-1',
        title: 'Tickets buchen',
        status: 'active',
        dueAt: null,
        createdAt: '2025-01-01',
      },
    ]);

    const result = await retrieveContext({ userId: 'u', personaId: 'p', query: 'Tickets' });

    expect(result.fullText).toEqual([]);
    expect(result.tasks).toHaveLength(1);
    expect(result.source).toBe('fulltext');
    consoleError.mockRestore();
  });

  it('fails the typed domain lane closed when one domain search rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.searchRelations.mockRejectedValue(new Error('relations unavailable'));

    const result = await retrieveContext({ userId: 'u', personaId: 'p', query: 'Kino' });

    expect(result).toMatchObject({
      assertions: [],
      tasks: [],
      relations: [],
      openLoops: [],
      source: 'none',
    });
    consoleError.mockRestore();
  });

  it('keeps canonical results when embedding generation or vector search fails', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = { model: 'embed-test', modelVersion: '1', generateEmbedding: vi.fn() };
    getEmbeddingProvider.mockReturnValue(provider);
    generateEmbeddingOnce.mockRejectedValueOnce(new Error('embedding unavailable'));
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

    const embeddingFailure = await retrieveContext({ userId: 'u', personaId: 'p', query: 'Kino' });
    expect(embeddingFailure.source).toBe('fulltext');
    expect(vectorSearch).not.toHaveBeenCalled();

    generateEmbeddingOnce.mockResolvedValue([0.1]);
    vectorSearch.mockRejectedValue(new Error('vector unavailable'));
    const vectorFailure = await retrieveContext({ userId: 'u', personaId: 'p', query: 'Kino' });
    expect(vectorFailure.source).toBe('fulltext');
    expect(vectorFailure.vector).toEqual([]);
    consoleWarn.mockRestore();
  });

  it('uses Graphiti only when both feature flags are enabled and contains Graphiti failures', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockConfig.graphitiRecallEnabled = true;

    await retrieveContext({ userId: 'u', personaId: 'p', workspaceId: 'w', query: 'Kino' });
    expect(mocks.searchGraphitiFactsWithRerank).not.toHaveBeenCalled();

    mockConfig.graphitiBackendEnabled = true;
    mocks.searchGraphitiFactsWithRerank.mockResolvedValue([
      { uuid: 'fact-1', fact: 'Kino am Freitag' },
    ]);
    const result = await retrieveContext({
      userId: 'u',
      personaId: 'p',
      workspaceId: 'w',
      query: 'Kino',
    });
    expect(result).toMatchObject({ source: 'graphiti', graphiti: [{ uuid: 'fact-1' }] });
    expect(mocks.searchGraphitiFactsWithRerank).toHaveBeenCalledWith(
      expect.any(String),
      { text: 'Kino', terms: ['Kino'] },
      { maxResults: 5 },
    );

    mocks.searchGraphitiFactsWithRerank.mockRejectedValue(new Error('Graphiti unavailable'));
    const failed = await retrieveContext({ userId: 'u', personaId: 'p', query: 'Kino' });
    expect(failed).toMatchObject({ source: 'none', graphiti: [] });
    consoleWarn.mockRestore();
  });
});

describe('formatWorldModelContext', () => {
  it('formats every source, optional fields, and de-duplicates canonical assertions', () => {
    const result: RetrievalContextResult = {
      source: 'structured',
      enabled: true,
      structured: [
        {
          id: 'event-1',
          title: 'Kino',
          status: 'completed',
          scheduledFor: '2025-01-01T18:00:00Z',
          endsAt: '2025-01-01T20:00:00Z',
          timeline: [
            {
              id: 'transition-1',
              eventId: 'event-1',
              title: 'Kino',
              toStatus: 'planned',
              reason: 'gebucht',
              transitionedAt: '2025-01-01T10:00:00Z',
            },
            {
              id: 'transition-2',
              eventId: 'event-1',
              title: 'Kino',
              toStatus: 'completed',
              transitionedAt: '2025-01-01T20:00:00Z',
            },
          ],
        },
      ],
      fullText: [
        {
          id: 'same-assertion',
          predicate: 'mag',
          objectValue: 'Kino',
          modality: 'reported',
          status: 'active',
          confidence: 0.9,
          sourceObservationId: 'obs-1',
        },
      ],
      assertions: [
        {
          id: 'same-assertion',
          subjectName: 'Mira',
          predicate: 'mag',
          objectValue: 'Kino',
          modality: 'reported',
          status: 'active',
          confidence: 0.9,
          knownFrom: '2025-01-01',
        },
        {
          id: 'assertion-2',
          subjectName: 'Mira',
          predicate: 'meidet',
          objectValue: 'Horror',
          modality: 'reported',
          status: 'active',
          confidence: 0.8,
          knownFrom: '2025-01-01',
          sourceObservationId: 'obs-2',
        },
      ],
      tasks: [
        {
          id: 'task-1',
          title: 'Tickets',
          status: 'open',
          dueAt: '2025-02-01',
          createdAt: '2025-01-01',
        },
        { id: 'task-2', title: 'Snacks', status: 'open', dueAt: null, createdAt: '2025-01-01' },
      ],
      relations: [
        {
          id: 'relation-1',
          sourceEntityName: 'Mira',
          targetEntityName: 'Noah',
          relationType: 'knows',
          confidence: 0.7,
          validFrom: null,
        },
      ],
      openLoops: [
        {
          id: 'loop-1',
          type: 'clarification',
          status: 'open',
          question: 'Welcher Film?',
          attempts: 1,
          lastAskedAt: null,
        },
        {
          id: 'loop-2',
          type: 'follow_up',
          status: 'open',
          question: null,
          attempts: 0,
          lastAskedAt: null,
        },
      ],
      vector: [
        {
          targetType: 'event',
          targetId: 'event-2',
          text: 'Filmabend',
          similarity: 0.82,
          model: 'test',
          modelVersion: '1',
        },
      ],
      graphiti: [{ uuid: 'graph-1', fact: 'Mira geht ins Kino' }, { fact: 'Kino am Freitag' }],
    };

    const formatted = formatWorldModelContext(result);

    expect(formatted).toContain('time=2025-01-01T18:00:00Z - 2025-01-01T20:00:00Z');
    expect(formatted).toContain('history=planned (gebucht) -> completed');
    expect(formatted).toContain('source=obs-1');
    expect(formatted).toContain('Mira meidet = Horror');
    expect(formatted).toContain('due=2025-02-01');
    expect(formatted).toContain('Task: Snacks; status=open');
    expect(formatted).toContain('Mira knows Noah');
    expect(formatted).toContain('question=Welcher Film?');
    expect(formatted).toContain('question=');
    expect(formatted).toContain('Semantic evidence [event-2]');
    expect(formatted).toContain('Graphiti derived fact: Kino am Freitag');
    expect(formatted?.match(/Assertion \[same-assertion\]/g)).toHaveLength(1);
  });

  it('returns null when all retrieval lanes are empty', () => {
    expect(
      formatWorldModelContext({
        structured: [],
        fullText: [],
        vector: [],
        source: 'none',
        enabled: true,
      }),
    ).toBeNull();
  });
});
