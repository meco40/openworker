import { describe, expect, it } from 'vitest';
import { MemoryService } from '@/server/memory/service';
import { SqliteMemoryClient } from '@/server/memory/sqliteMemoryClient';
import { SqliteMemoryRepository } from '@/server/memory/sqliteMemoryRepository';

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
});
