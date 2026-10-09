import { describe, expect, it } from 'vitest';
import { MemoryService } from '@/server/memory/service';
import { SqliteMemoryClient } from '@/server/memory/sqliteMemoryClient';
import { SqliteMemoryRepository } from '@/server/memory/sqliteMemoryRepository';
import type { Mem0MemoryInput } from '@/server/memory/mem0';

function memoryInput(
  content: string,
  options: Partial<Omit<Mem0MemoryInput, 'content' | 'metadata'>> & {
    metadata?: Record<string, unknown>;
  } = {},
): Mem0MemoryInput {
  return {
    userId: options.userId ?? 'user-a',
    personaId: options.personaId ?? 'persona-a',
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    content,
    metadata: options.metadata ?? {},
  };
}

describe('SqliteMemoryClient fallback', () => {
  it('supports scoped CRUD, history, lexical search and pagination', async () => {
    const repository = new SqliteMemoryRepository(':memory:');
    const service = new MemoryService(new SqliteMemoryClient(repository));

    const first = await service.storeMemory({
      personaId: 'persona-a',
      type: 'fact',
      content: 'Alice prefers coffee',
      importance: 4,
      userId: 'user-a',
    });
    await service.storeMemory({
      personaId: 'persona-a',
      type: 'preference',
      content: 'Bob prefers tea',
      importance: 3,
      userId: 'user-b',
    });

    expect((await service.recallDetailed('persona-a', 'coffee', 5, 'user-a')).matches).toHaveLength(
      1,
    );
    expect(
      (await service.listPage('persona-a', { page: 1, pageSize: 10 }, 'user-b')).pagination.total,
    ).toBe(1);

    const updated = await service.update(
      'persona-a',
      first.id,
      { content: 'Alice prefers espresso', expectedVersion: 1 },
      'user-a',
    );
    expect(updated?.content).toBe('Alice prefers espresso');
    expect((await service.history('persona-a', first.id, 'user-a'))?.entries.length).toBe(2);
    expect(await service.delete('persona-a', first.id, 'user-b')).toBe(false);
    expect(await service.delete('persona-a', first.id, 'user-a')).toBe(true);
  });

  it('deduplicates named stores by idempotency key', async () => {
    const repository = new SqliteMemoryRepository(':memory:');
    const service = new MemoryService(new SqliteMemoryClient(repository));
    const input = {
      personaId: 'persona-a' as const,
      type: 'fact' as const,
      content: 'stable fact',
      importance: 4,
      userId: 'user-a',
      metadata: { idempotencyKey: 'knowledge:1' },
    };

    const [first, second] = await Promise.all([
      service.storeMemory(input),
      service.storeMemory(input),
    ]);
    expect(second.id).toBe(first.id);
    expect(
      (await service.listPage('persona-a', { page: 1, pageSize: 10 }, 'user-a')).pagination.total,
    ).toBe(1);
  });

  it('persists the workspace scope supplied with a memory', async () => {
    const repository = new SqliteMemoryRepository(':memory:');
    const client = new SqliteMemoryClient(repository);
    const { id } = await client.addMemory({
      userId: 'user-a',
      personaId: 'persona-a',
      workspaceId: 'workspace-a',
      content: 'Workspace-scoped memory',
      metadata: { type: 'fact' },
    });

    await expect(
      client.getMemory(id, {
        userId: 'user-a',
        personaId: 'persona-a',
        workspaceId: 'workspace-a',
      }),
    ).resolves.toMatchObject({
      id,
      metadata: { workspaceId: 'workspace-a' },
    });
  });

  it('applies lexical search scope, scoring, ordering, and limits', async () => {
    const client = new SqliteMemoryClient(new SqliteMemoryRepository(':memory:'));
    const newer = await client.addMemory(
      memoryInput('Alice prefers coffee', {
        workspaceId: 'workspace-a',
        metadata: {
          type: 'preference',
          importance: 4,
          confidence: 0.9,
          lastVerified: '2026-10-02T00:00:00.000Z',
        },
      }),
    );
    const older = await client.addMemory(
      memoryInput('Coffee and tea', {
        workspaceId: 'workspace-a',
        metadata: {
          type: 'fact',
          importance: 3,
          confidence: 0.8,
          lastVerified: '2026-10-01T00:00:00.000Z',
        },
      }),
    );
    const withoutVerification = await client.addMemory(
      memoryInput('Coffee without a verified date', {
        workspaceId: 'workspace-a',
        metadata: { type: 'fact', importance: 5 },
      }),
    );
    const withoutVerificationOlder = await client.addMemory(
      memoryInput('Another coffee without a verified date', {
        workspaceId: 'workspace-a',
        metadata: { type: 'fact', importance: 1 },
      }),
    );
    await client.addMemory(
      memoryInput('Tea is nice', {
        workspaceId: 'workspace-b',
        metadata: { type: 'fact', lastVerified: '2026-10-03T00:00:00.000Z' },
      }),
    );
    await client.addMemory(memoryInput('Coffee in another persona', { personaId: 'persona-b' }));
    await client.addMemory(memoryInput('Coffee for another user', { userId: 'user-b' }));

    const scoped = await client.searchMemories({
      userId: 'user-a',
      personaId: 'persona-a',
      workspaceId: 'workspace-a',
      query: 'Coffee! a',
      limit: 20,
    });
    expect(scoped.map((record) => record.id)).toEqual([
      newer.id,
      older.id,
      withoutVerification.id,
      withoutVerificationOlder.id,
    ]);
    expect(scoped.map((record) => record.score)).toEqual([1, 1, 1, 1]);
    expect(
      (
        await client.searchMemories({
          userId: 'user-a',
          personaId: 'persona-a',
          query: 'coffee missing',
          limit: 0,
        })
      ).map((record) => [record.id, record.score]),
    ).toEqual([[newer.id, 0.5]]);
    await expect(
      client.searchMemories({
        userId: 'user-a',
        personaId: 'persona-a',
        query: '--- a',
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it('lists by persona, workspace, type, query, and normalized page bounds', async () => {
    const client = new SqliteMemoryClient(new SqliteMemoryRepository(':memory:'));
    const coffee = await client.addMemory(
      memoryInput('Coffee for Alice', {
        workspaceId: 'workspace-a',
        metadata: { type: 'preference', importance: 4 },
      }),
    );
    await client.addMemory(
      memoryInput('Coffee for Bob', {
        workspaceId: 'workspace-a',
        metadata: { type: 'fact', importance: 3 },
      }),
    );
    await client.addMemory(
      memoryInput('Tea for Alice', {
        workspaceId: 'workspace-b',
        metadata: { type: 'preference', importance: 2 },
      }),
    );
    await client.addMemory(memoryInput('Coffee elsewhere', { personaId: 'persona-b' }));

    await expect(
      client.listMemories({
        userId: 'user-a',
        personaId: 'persona-a',
        workspaceId: 'workspace-a',
        page: 0,
        pageSize: 500,
        type: 'preference',
        query: 'Alice',
      }),
    ).resolves.toMatchObject({
      memories: [expect.objectContaining({ id: coffee.id })],
      total: 1,
      page: 1,
      pageSize: 200,
    });

    await expect(
      client.listMemories({
        userId: 'user-a',
        personaId: 'persona-a',
        page: 1,
        pageSize: 10,
        type: 'fact',
        query: 'Coffee',
      }),
    ).resolves.toMatchObject({
      total: 1,
      memories: [expect.objectContaining({ content: 'Coffee for Bob' })],
    });

    await expect(
      client.listMemories({ userId: 'user-a', page: 0, pageSize: 0 }),
    ).resolves.toMatchObject({ total: 4, page: 1, pageSize: 1 });
    await expect(
      client.listMemories({
        userId: 'user-a',
        workspaceId: 'workspace-a',
        page: 1,
        pageSize: 10,
      }),
    ).resolves.toMatchObject({ total: 2, page: 1, pageSize: 10 });
  });

  it('enforces read, update, history, and delete scopes', async () => {
    const client = new SqliteMemoryClient(new SqliteMemoryRepository(':memory:'));
    const { id } = await client.addMemory(
      memoryInput('Initial memory', {
        workspaceId: 'workspace-a',
        metadata: { type: 'fact', lastVerified: '2026-10-01T00:00:00.000Z' },
      }),
    );
    const matchingScope = {
      userId: 'user-a',
      personaId: 'persona-a',
      workspaceId: 'workspace-a',
    };

    await expect(client.getMemory('missing')).resolves.toBeNull();
    await expect(client.getMemory(id)).resolves.toMatchObject({ id, score: null });
    await expect(client.getMemory(id, matchingScope)).resolves.toMatchObject({
      id,
      metadata: { workspaceId: 'workspace-a' },
    });
    for (const scope of [
      { ...matchingScope, userId: 'other-user' },
      { ...matchingScope, personaId: 'other-persona' },
      { ...matchingScope, workspaceId: 'workspace-b' },
    ]) {
      await expect(client.getMemory(id, scope)).resolves.toBeNull();
      await expect(client.updateMemory(id, memoryInput('Rejected update', scope))).rejects.toThrow(
        'Memory node scope mismatch.',
      );
      await expect(client.deleteMemory(id, scope)).rejects.toThrow('Memory node scope mismatch.');
    }

    await expect(client.updateMemory('missing', memoryInput('Missing update'))).rejects.toThrow(
      'Memory node not found: missing',
    );
    await client.updateMemory(
      id,
      memoryInput('Updated memory', {
        ...matchingScope,
        metadata: { type: 'preference', lastVerified: '2026-10-02T00:00:00.000Z' },
      }),
    );
    await expect(client.getMemoryHistory(id)).resolves.toMatchObject([
      { action: 'add', content: 'Initial memory', raw: {} },
      { action: 'update', content: 'Updated memory', raw: {} },
    ]);
    await expect(client.deleteMemory('missing')).rejects.toThrow('Memory node not found: missing');
    await client.deleteMemory(id, matchingScope);
    await expect(client.getMemory(id)).resolves.toBeNull();
  });

  it('deletes all persona memories or only the requested workspace', async () => {
    const client = new SqliteMemoryClient(new SqliteMemoryRepository(':memory:'));
    await client.addMemory(memoryInput('Workspace A', { workspaceId: 'workspace-a' }));
    await client.addMemory(memoryInput('Workspace B', { workspaceId: 'workspace-b' }));
    await client.addMemory(
      memoryInput('Another persona', { personaId: 'persona-b', workspaceId: 'workspace-a' }),
    );

    await expect(
      client.deleteMemoriesByFilter({
        userId: 'user-a',
        personaId: 'persona-a',
        workspaceId: 'workspace-a',
      }),
    ).resolves.toBe(1);
    await expect(
      client.listMemories({ userId: 'user-a', personaId: 'persona-a', page: 1, pageSize: 10 }),
    ).resolves.toMatchObject({
      total: 1,
      memories: [expect.objectContaining({ content: 'Workspace B' })],
    });
    await expect(
      client.deleteMemoriesByFilter({ userId: 'user-a', personaId: 'persona-a' }),
    ).resolves.toBe(1);
    await expect(
      client.listMemories({ userId: 'user-a', page: 1, pageSize: 10 }),
    ).resolves.toMatchObject({
      total: 1,
      memories: [expect.objectContaining({ content: 'Another persona' })],
    });
  });

  it('uses safe defaults for legacy blank users and incomplete metadata', async () => {
    const repository = new SqliteMemoryRepository(':memory:');
    const client = new SqliteMemoryClient(repository);
    const { id } = await client.addMemory({
      userId: '   ',
      personaId: 'persona-legacy',
      content: 'Legacy memory',
      metadata: undefined as unknown as Record<string, unknown>,
    });

    const record = await client.getMemory(id, {
      userId: '',
      personaId: 'persona-legacy',
    });
    expect(record).toMatchObject({
      id,
      content: 'Legacy memory',
      score: null,
      metadata: {
        type: 'fact',
        importance: 3,
        confidence: 0.3,
        source: 'sqlite',
        memoryProvider: 'sqlite',
      },
    });
    expect(record?.createdAt).toBe(record?.updatedAt);

    repository.insertNode(
      'persona-legacy',
      {
        id: 'empty-timestamp',
        type: 'fact',
        content: 'Old row without a timestamp',
        embedding: [],
        importance: 3,
        confidence: 0.3,
        timestamp: '',
        metadata: {},
      },
      'legacy-user',
    );
    const oldRow = await client.getMemory('empty-timestamp');
    expect(oldRow?.createdAt).toBeTruthy();
    expect(oldRow?.updatedAt).toBe(oldRow?.createdAt);
  });
});
