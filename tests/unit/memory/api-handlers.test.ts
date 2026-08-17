import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMemoryRuntimeReadyStateForTests } from '@/server/memory/runtime';

vi.mock('@/server/channels/messages/runtime', () => ({
  getMessageRepository: () => ({
    listConversations: () => [],
  }),
}));

describe('memory api handlers', () => {
  afterEach(() => {
    setMemoryRuntimeReadyStateForTests(undefined);
  });

  it('returns an empty degraded snapshot when memory GET runs without mem0 readiness', async () => {
    setMemoryRuntimeReadyStateForTests(false);
    const { handleMemoryGet } = await import('@/server/memory/api/getHandler');

    const response = await handleMemoryGet(
      new Request('http://localhost/api/memory?personaId=persona-test&page=1&pageSize=25'),
      { userId: 'legacy-local-user', authenticated: true },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      degraded: true,
      nodes: [],
      pagination: {
        page: 1,
        pageSize: 25,
        total: 0,
        totalPages: 1,
      },
    });
  });

  it('returns 503 for memory POST mutations when mem0 is degraded', async () => {
    setMemoryRuntimeReadyStateForTests(false);
    const { handleMemoryPost } = await import('@/server/memory/api/postHandler');

    const response = await handleMemoryPost(
      new Request('http://localhost/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fcName: 'core_memory_store',
          args: {
            personaId: 'persona-test',
            type: 'fact',
            content: 'persist-me',
            importance: 4,
          },
        }),
      }),
      { userId: 'legacy-local-user', authenticated: true },
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.ok).toBe(false);
    expect(String(payload.error || '')).toMatch(/memory runtime unavailable/i);
  });
});
