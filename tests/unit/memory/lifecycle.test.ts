import { afterEach, describe, expect, it } from 'vitest';
import type { Mem0Client } from '@/server/memory/mem0';
import { getServerEventBus } from '@/server/events/runtime';
import { isActiveMemoryMetadata, transitionLifecycle } from '@/server/memory/lifecycle';
import { MemoryService } from '@/server/memory/service';

afterEach(() => getServerEventBus().clearAllSubscribers());

describe('memory lifecycle enforcement', () => {
  it('transitions lifecycle states and excludes expired recall with an event', async () => {
    expect(transitionLifecycle('new', 'contradicted')).toBe('superseded');
    expect(transitionLifecycle('stale', 'reactivated')).toBe('confirmed');
    expect(isActiveMemoryMetadata({ lifecycleStatus: 'superseded' })).toBe(false);

    const events: Array<{ signal: string; memoryId: string }> = [];
    getServerEventBus().subscribe('memory.lifecycle.changed', (event) => {
      events.push({ signal: event.signal, memoryId: event.memoryId });
    });
    const expired = {
      id: 'expired-1',
      content: 'expired fact',
      score: 0.95,
      metadata: {
        type: 'fact',
        lifecycleStatus: 'confirmed',
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    };
    const client = {
      searchMemories: async () => [expired],
      listMemories: async () => ({ memories: [expired], total: 1, page: 1, pageSize: 10 }),
    } as unknown as Mem0Client;
    const result = await new MemoryService(client).recallDetailed(
      'persona-a',
      'expired',
      3,
      'user-a',
    );
    expect(result.matches).toHaveLength(0);
    expect(events).toContainEqual({ signal: 'time_expired', memoryId: 'expired-1' });
  });
});
