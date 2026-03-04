import { describe, expect, it, vi } from 'vitest';
import { createMem0Client, type Mem0ClientConfig } from '@/server/memory/mem0';
import { registerMem0ClientCleanup } from './mem0-client.harness';

describe('mem0Client', () => {
  registerMem0ClientCleanup();
  it('falls back to v1 search endpoint when v2 search is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'legacy-1',
              memory: 'Legacy Search Hit',
              score: 0.91,
              metadata: { type: 'fact' },
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );

    const client = createMem0Client(
      {
        baseUrl: 'http://mem0.local',
        apiPath: '/v1',
      },
      fetchMock as unknown as typeof fetch,
    );

    const hits = await client.searchMemories({
      userId: 'user-1',
      personaId: 'persona-1',
      query: 'legacy',
      limit: 5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const secondCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe('http://mem0.local/v2/memories/search');
    expect(secondCall[0]).toBe('http://mem0.local/v1/search');
    expect(secondCall[1].method).toBe('POST');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'legacy-1', content: 'Legacy Search Hit' });
  });

  it('falls back to v1 list endpoint when v2 list is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 'legacy-1', memory: 'Alpha', metadata: { type: 'fact' } },
            { id: 'legacy-2', memory: 'Beta', metadata: { type: 'preference' } },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );

    const client = createMem0Client(
      {
        baseUrl: 'http://mem0.local',
        apiPath: '/v1',
      },
      fetchMock as unknown as typeof fetch,
    );

    const result = await client.listMemories({
      userId: 'user-1',
      personaId: 'persona-1',
      page: 1,
      pageSize: 1,
      query: 'Alpha',
      type: 'fact',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const secondCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe('http://mem0.local/v2/memories');
    expect(secondCall[0]).toBe('http://mem0.local/v1/memories?user_id=user-1&agent_id=persona-1');
    expect(secondCall[1].method).toBe('GET');
    expect(result.total).toBe(1);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({ id: 'legacy-1', content: 'Alpha' });
  });

  it('falls back to v1 list endpoint when v2 returns an empty first page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            memories: [],
            total: 0,
            page: 1,
            page_size: 25,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 'legacy-1', memory: 'Alpha', metadata: { type: 'fact' } },
            { id: 'legacy-2', memory: 'Beta', metadata: { type: 'preference' } },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );

    const client = createMem0Client(
      {
        baseUrl: 'http://mem0.local',
        apiPath: '/v1',
      },
      fetchMock as unknown as typeof fetch,
    );

    const result = await client.listMemories({
      userId: 'user-1',
      personaId: 'persona-1',
      page: 1,
      pageSize: 25,
      type: 'fact',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const secondCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe('http://mem0.local/v2/memories');
    expect(secondCall[0]).toBe('http://mem0.local/v1/memories?user_id=user-1&agent_id=persona-1');
    expect(result.total).toBe(1);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({ id: 'legacy-1', content: 'Alpha' });
  });

  it('deletes all persona memories via filter endpoint', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ deleted: 3 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const client = createMem0Client(
      {
        baseUrl: 'http://mem0.local',
        apiPath: '/v1',
        timeoutMs: 4000,
      },
      fetchMock as unknown as typeof fetch,
    );

    const deleted = await client.deleteMemoriesByFilter({
      userId: 'user-1',
      personaId: 'persona-1',
    });
    expect(deleted).toBe(3);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://mem0.local/v1/memories');
    expect(call[1].method).toBe('DELETE');
    const body = JSON.parse(String(call[1].body));
    expect(body).toMatchObject({
      user_id: 'user-1',
      agent_id: 'persona-1',
    });
  });

  it('loads memory history via history endpoint', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              action: 'update',
              timestamp: '2026-02-15T10:00:00.000Z',
              content: 'updated memory content',
              metadata: { version: 2, type: 'fact' },
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );

    const client = createMem0Client(
      {
        baseUrl: 'http://mem0.local',
        apiPath: '/v1',
        timeoutMs: 4000,
      },
      fetchMock as unknown as typeof fetch,
    );

    const history = await client.getMemoryHistory('mem0-1');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'update',
      timestamp: '2026-02-15T10:00:00.000Z',
      content: 'updated memory content',
      metadata: { version: 2, type: 'fact' },
    });

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://mem0.local/v1/memories/mem0-1/history');
    expect(call[1].method).toBe('GET');
  });

  it('falls back to query-based delete for legacy mem0 delete API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'All relevant memories deleted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = createMem0Client(
      {
        baseUrl: 'http://mem0.local',
        apiPath: '/',
      },
      fetchMock as unknown as typeof fetch,
    );

    const deleted = await client.deleteMemoriesByFilter({
      userId: 'user-1',
      personaId: 'persona-1',
    });
    expect(deleted).toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const secondCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe('http://mem0.local/memories');
    expect(secondCall[0]).toBe('http://mem0.local/memories?user_id=user-1&agent_id=persona-1');
    expect(secondCall[1].method).toBe('DELETE');
  });

  it('aborts request after timeout', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve(
            new Response(JSON.stringify({ id: 'late' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }, 250);
      });
    });

    const config: Mem0ClientConfig = {
      baseUrl: 'http://mem0.local',
      apiPath: '/v1',
      timeoutMs: 100,
    };
    const client = createMem0Client(config, fetchMock as unknown as typeof fetch);

    await expect(
      client.addMemory({
        userId: 'user-1',
        personaId: 'persona-1',
        content: 'timeout test',
        metadata: {},
      }),
    ).rejects.toThrow(/timeout|aborted/i);
  });
});
