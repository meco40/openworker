import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWorldModelDb: vi.fn(),
  runWithWorldModelScope: vi.fn(),
  withWorldModelTransaction: vi.fn(),
  query: vi.fn(),
  getConfiguredEmbeddingProvider: vi.fn(),
  generateEmbeddingOnce: vi.fn(),
  vectorSearch: vi.fn(),
}));

vi.mock('@/server/world-model/db', () => ({
  getWorldModelDb: mocks.getWorldModelDb,
  runWithWorldModelScope: mocks.runWithWorldModelScope,
  withWorldModelTransaction: mocks.withWorldModelTransaction,
}));
vi.mock('@/server/world-model/embeddings/provider', () => ({
  getConfiguredEmbeddingProvider: mocks.getConfiguredEmbeddingProvider,
  generateEmbeddingOnce: mocks.generateEmbeddingOnce,
}));
vi.mock('@/server/world-model/retrieval/vector', () => ({ vectorSearch: mocks.vectorSearch }));

import { PostgresMemoryClient } from '@/server/memory/postgresMemoryClient';
import { MemoryVersionConflictError } from '@/server/memory/errors';

const scope = { userId: 'user-a', personaId: 'assistant', workspaceId: 'workspace-a' };
const client = new PostgresMemoryClient();

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'memory-1',
    user_id: scope.userId,
    persona_id: scope.personaId,
    workspace_id: scope.workspaceId,
    memory_type: 'fact',
    content: 'A saved fact',
    importance: 3,
    confidence: 0.7,
    lifecycle_status: 'confirmed',
    version: 2,
    metadata: { source: 'test' },
    idempotency_key: null,
    legacy_provider: null,
    legacy_provider_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function result(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue(result());
  mocks.getWorldModelDb.mockReturnValue({ query: mocks.query });
  mocks.runWithWorldModelScope.mockImplementation(
    async (_scope: unknown, callback: () => unknown) => callback(),
  );
  mocks.withWorldModelTransaction.mockImplementation(
    async (callback: (db: { query: typeof mocks.query }) => unknown) =>
      callback({ query: mocks.query }),
  );
  mocks.getConfiguredEmbeddingProvider.mockReturnValue(null);
  mocks.generateEmbeddingOnce.mockResolvedValue([0.1, 0.2]);
  mocks.vectorSearch.mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe('PostgresMemoryClient', () => {
  it('normalizes and inserts a new canonical row with history', async () => {
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{ id: 'memory-created' }]))
      .mockResolvedValueOnce(result());

    await expect(
      client.addMemory({
        ...scope,
        content: 'Saved content',
        metadata: {
          type: ' preference ',
          importance: 8.7,
          confidence: -2,
          version: 0,
          idempotencyKey: 'stable-key',
          legacyProvider: ' mem0 ',
          legacyMem0Id: ' legacy-1 ',
          source_observation_id: ' observation-1 ',
        },
      }),
    ).resolves.toEqual({ id: 'memory-created', created: true });

    expect(mocks.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      'SELECT',
      'SELECT',
      'INSERT',
      'INSERT',
    ]);
    expect(mocks.query.mock.calls[2]?.[1]).toEqual(
      expect.arrayContaining([
        scope.userId,
        scope.personaId,
        scope.workspaceId,
        'preference',
        'Saved content',
        5,
        0.1,
        'new',
        1,
        expect.any(String),
        'stable-key',
        'mem0',
        'legacy-1',
        'observation-1',
      ]),
    );
    expect(mocks.withWorldModelTransaction).toHaveBeenCalledWith(expect.any(Function), scope);
  });

  it('returns an idempotent duplicate before attempting an insert', async () => {
    mocks.query.mockResolvedValueOnce(result([{ id: 'existing-id' }]));

    await expect(
      client.addMemory({
        ...scope,
        content: 'duplicate',
        metadata: { idempotencyKey: 'same-key' },
      }),
    ).resolves.toEqual({ id: 'existing-id', created: false });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('deduplicates legacy provider IDs and resolves insert conflicts', async () => {
    mocks.query.mockResolvedValueOnce(result([{ id: 'legacy' }]));
    await expect(
      client.addMemory({
        ...scope,
        content: 'legacy duplicate',
        metadata: { legacyProvider: 'mem0', legacyProviderId: 'legacy-id' },
      }),
    ).resolves.toEqual({ id: 'legacy', created: false });

    mocks.query
      .mockReset()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{ id: 'race-winner' }]));
    await expect(
      client.addMemory({
        ...scope,
        content: 'concurrent duplicate',
        metadata: { idempotencyKey: 'race-key' },
      }),
    ).resolves.toEqual({ id: 'race-winner', created: false });
  });

  it('throws when an insert conflict cannot be resolved to a canonical row', async () => {
    mocks.query.mockResolvedValueOnce(result()).mockResolvedValueOnce(result());

    await expect(
      client.addMemory({ ...scope, content: 'unknown conflict', metadata: {} }),
    ).rejects.toThrow('Canonical memory insert conflicted with an unknown unique constraint.');
  });

  it('uses lexical recall for an unconfigured provider and returns nullable scores', async () => {
    mocks.query.mockResolvedValueOnce(result([memoryRow()]));
    await expect(
      client.searchMemories({ ...scope, query: '  coffee  ', limit: 10 }),
    ).resolves.toMatchObject([{ id: 'memory-1', score: 0.5, content: 'A saved fact' }]);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      scope.userId,
      scope.personaId,
      scope.workspaceId,
      'coffee',
      10,
    ]);

    mocks.query.mockResolvedValueOnce(result([memoryRow()]));
    await expect(client.searchMemories({ ...scope, query: '  ', limit: 0 })).resolves.toMatchObject(
      [{ score: null }],
    );
  });

  it('returns only current scoped rows for semantic hits and caps the result count', async () => {
    mocks.getConfiguredEmbeddingProvider.mockReturnValue({ model: 'test', modelVersion: '1' });
    mocks.vectorSearch.mockResolvedValue([
      { targetType: 'entity', targetId: 'entity-1', similarity: 0.99 },
      { targetType: 'memory', targetId: 'memory-1', similarity: 0.91 },
      { targetType: 'memory', targetId: 'missing-row', similarity: 0.8 },
      { targetType: 'memory', targetId: 'second-row', similarity: 0.7 },
    ]);
    mocks.query.mockResolvedValueOnce(result([memoryRow()]));

    await expect(
      client.searchMemories({ ...scope, query: 'semantic query', limit: 1 }),
    ).resolves.toMatchObject([{ id: 'memory-1', score: 0.91 }]);
    expect(mocks.generateEmbeddingOnce).toHaveBeenCalledWith(
      { model: 'test', modelVersion: '1' },
      'semantic query',
    );
    expect(mocks.vectorSearch).toHaveBeenCalledWith(
      [0.1, 0.2],
      scope.userId,
      scope.personaId,
      scope.workspaceId,
      20,
      0.2,
      { include: ['memory'], activeMemoryOnly: true },
    );
  });

  it('falls back to lexical recall when semantic search fails or finds no memory hits', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getConfiguredEmbeddingProvider.mockReturnValue({ model: 'test', modelVersion: '1' });
    mocks.vectorSearch.mockRejectedValueOnce(new Error('vector unavailable'));
    mocks.query.mockResolvedValueOnce(result([memoryRow()]));
    await expect(
      client.searchMemories({ ...scope, query: 'fallback query', limit: 5 }),
    ).resolves.toMatchObject([{ id: 'memory-1', score: 0.5 }]);
    expect(warn).toHaveBeenCalledOnce();

    mocks.vectorSearch.mockResolvedValueOnce([{ targetType: 'entity', targetId: 'entity-1' }]);
    mocks.query.mockResolvedValueOnce(result([memoryRow()]));
    await expect(
      client.searchMemories({ ...scope, query: 'lexical query', limit: 5 }),
    ).resolves.toMatchObject([{ id: 'memory-1', score: 0.5 }]);
  });

  it('applies trimmed list filters and clamps page inputs', async () => {
    mocks.query
      .mockResolvedValueOnce(result([{ count: '2' }]))
      .mockResolvedValueOnce(result([memoryRow()]));

    await expect(
      client.listMemories({
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
        query: ' coffee ',
        type: ' fact ',
        page: 0,
        pageSize: 500,
      }),
    ).resolves.toMatchObject({ total: 2, page: 1, pageSize: 200, memories: [{ id: 'memory-1' }] });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      scope.userId,
      scope.personaId,
      scope.workspaceId,
      'coffee',
      'fact',
      0,
      200,
    ]);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      scope.userId,
      scope.personaId,
      scope.workspaceId,
      'coffee',
      'fact',
      0,
      200,
    ]);
    expect(mocks.runWithWorldModelScope).toHaveBeenCalledOnce();
  });

  it('lists without optional filters and uses safe defaults for invalid pagination', async () => {
    mocks.query.mockResolvedValueOnce(result()).mockResolvedValueOnce(result());
    await expect(
      client.listMemories({ userId: scope.userId, page: Number.NaN, pageSize: Number.NaN }),
    ).resolves.toEqual({ memories: [], total: 0, page: 1, pageSize: 50 });
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([scope.userId, '', '', 0, 50]);
  });

  it('reads scoped and unscoped rows, and returns null for a miss', async () => {
    mocks.query.mockResolvedValueOnce(result([memoryRow({ metadata: [] })]));
    await expect(client.getMemory('memory-1', scope)).resolves.toMatchObject({
      metadata: { type: 'fact', source: 'postgres', workspaceId: scope.workspaceId },
    });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'memory-1',
      scope.userId,
      scope.personaId,
      scope.workspaceId,
    ]);

    mocks.query.mockResolvedValueOnce(result());
    await expect(client.getMemory('missing')).resolves.toBeNull();
    expect(mocks.query.mock.calls[1]?.[1]).toEqual(['missing']);
    expect(mocks.runWithWorldModelScope).toHaveBeenCalledOnce();
  });

  it('maps scoped and unscoped history rows with normalized metadata', async () => {
    mocks.query.mockResolvedValueOnce(
      result([
        {
          action: 'update',
          version: '3',
          content: 'Updated fact',
          metadata: { source: 'import' },
          created_at: '2026-10-03T00:00:00.000Z',
        },
      ]),
    );
    await expect(client.getMemoryHistory('memory-1', scope)).resolves.toMatchObject([
      {
        action: 'update',
        content: 'Updated fact',
        metadata: { source: 'import', version: 3 },
        raw: { version: 3 },
      },
    ]);

    mocks.query.mockResolvedValueOnce(result());
    await expect(client.getMemoryHistory('memory-1')).resolves.toEqual([]);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual(['memory-1']);
  });

  it('updates a row with preserved canonical defaults and a new history version', async () => {
    mocks.query
      .mockResolvedValueOnce(result([memoryRow()]))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result());

    await expect(
      client.updateMemory('memory-1', { ...scope, content: 'Revised fact', metadata: {} }, scope),
    ).resolves.toBeUndefined();
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      'fact',
      'Revised fact',
      3,
      0.7,
      'confirmed',
      3,
      '{}',
      'memory-1',
      2,
    ]);
    expect(mocks.query.mock.calls[2]?.[1]).toEqual([
      'memory-1',
      scope.userId,
      scope.personaId,
      scope.workspaceId,
      3,
    ]);
  });

  it('rejects missing and stale versions during updates', async () => {
    mocks.query.mockResolvedValueOnce(result());
    await expect(
      client.updateMemory('missing', { ...scope, content: 'revised', metadata: {} }, scope),
    ).rejects.toThrow('Memory node not found: missing');

    mocks.query.mockResolvedValueOnce(result([memoryRow()]));
    await expect(
      client.updateMemory(
        'memory-1',
        { ...scope, content: 'revised', metadata: { expectedVersion: 9 } },
        scope,
      ),
    ).rejects.toBeInstanceOf(MemoryVersionConflictError);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('reports an optimistic conflict when the conditional update loses a race', async () => {
    mocks.query
      .mockResolvedValueOnce(result([memoryRow()]))
      .mockResolvedValueOnce(result([], 0))
      .mockResolvedValueOnce(result([], 0));

    await expect(
      client.updateMemory(
        'memory-1',
        { ...scope, content: 'revised', metadata: { expectedVersion: 2 } },
        scope,
      ),
    ).rejects.toBeInstanceOf(MemoryVersionConflictError);
  });

  it('requires scoped deletion, rejects missing rows, and removes the vector on success', async () => {
    await expect(client.deleteMemory('memory-1')).rejects.toThrow(
      'Scoped canonical memory deletion requires user, persona, and workspace.',
    );

    mocks.query.mockResolvedValueOnce(result());
    await expect(client.deleteMemory('missing', scope)).rejects.toThrow(
      'Memory node not found: missing',
    );

    mocks.query
      .mockReset()
      .mockResolvedValueOnce(result([memoryRow()]))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([], 1));
    await expect(client.deleteMemory('memory-1', scope)).resolves.toBeUndefined();
    expect(mocks.query.mock.calls[3]?.[0]).toContain('DELETE FROM world_model_embeddings');
  });

  it('bulk-deletes scoped rows and skips vector cleanup for an empty scope', async () => {
    mocks.query
      .mockResolvedValueOnce(result([memoryRow(), memoryRow({ id: 'memory-2', version: 4 })]))
      .mockResolvedValue(result([], 1));
    await expect(client.deleteMemoriesByFilter(scope)).resolves.toBe(2);
    expect(
      mocks.query.mock.calls.filter(([sql]) =>
        String(sql).includes('DELETE FROM world_model_embeddings'),
      ),
    ).toHaveLength(1);

    mocks.query.mockReset().mockResolvedValueOnce(result());
    await expect(client.deleteMemoriesByFilter(scope)).resolves.toBe(0);
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it('counts only for a usable user ID, with or without a persona scope', async () => {
    await expect(client.countMemories({ userId: '  ' })).resolves.toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();

    mocks.query.mockResolvedValueOnce(result([{ count: '7' }]));
    await expect(client.countMemories({ ...scope })).resolves.toBe(7);
    expect(mocks.runWithWorldModelScope).toHaveBeenCalledOnce();

    mocks.query.mockResolvedValueOnce(result());
    await expect(client.countMemories({ userId: scope.userId })).resolves.toBe(0);
  });
});
