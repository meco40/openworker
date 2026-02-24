import { afterEach, describe, expect, it, vi } from 'vitest';
const mem0SyncMocks = vi.hoisted(() => ({
  syncMem0LlmFromModelHub: vi.fn(),
  syncMem0EmbedderFromModelHub: vi.fn(),
}));

vi.mock('@/server/memory/mem0EmbedderSync', () => ({
  syncMem0LlmFromModelHub: mem0SyncMocks.syncMem0LlmFromModelHub,
  syncMem0EmbedderFromModelHub: mem0SyncMocks.syncMem0EmbedderFromModelHub,
}));

import {
  __resetMem0ModelHubSyncStateForTests,
  createMem0Client,
  createMem0ClientFromEnv,
  type Mem0ListMemoryResult,
  type Mem0ClientConfig,
} from '@/server/memory/mem0Client';

describe('mem0Client', () => {
  afterEach(() => {
    __resetMem0ModelHubSyncStateForTests();
    mem0SyncMocks.syncMem0LlmFromModelHub.mockReset();
    mem0SyncMocks.syncMem0EmbedderFromModelHub.mockReset();
    vi.restoreAllMocks();
  });

  it('creates a client from env only when provider is mem0 and base url exists', () => {
    const fetchMock = vi.fn();

    const disabled = createMem0ClientFromEnv(
      {
        MEMORY_PROVIDER: 'disabled',
        MEM0_BASE_URL: 'http://mem0.local',
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(disabled).toBeNull();

    const implicit = createMem0ClientFromEnv(
      {
        MEM0_BASE_URL: 'http://mem0.local',
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(implicit).not.toBeNull();

    const enabled = createMem0ClientFromEnv(
      {
        MEMORY_PROVIDER: 'mem0',
        MEM0_BASE_URL: 'http://mem0.local',
        MEM0_API_KEY: 'mem0_secret',
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(enabled).not.toBeNull();
  });

  it('throws for explicit mem0 provider without base url', () => {
    const fetchMock = vi.fn();
    expect(() =>
      createMem0ClientFromEnv(
        {
          MEMORY_PROVIDER: 'mem0',
          MEM0_BASE_URL: '',
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).toThrow(/MEM0_BASE_URL/i);
  });

  it('throws for explicit mem0 provider without api key', () => {
    const fetchMock = vi.fn();
    expect(() =>
      createMem0ClientFromEnv(
        {
          MEMORY_PROVIDER: 'mem0',
          MEM0_BASE_URL: 'http://mem0.local',
          MEM0_API_KEY: '',
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).toThrow(/MEM0_API_KEY/i);
  });

  it('throws in production when MEMORY_PROVIDER is not mem0', () => {
    const fetchMock = vi.fn();
    expect(() =>
      createMem0ClientFromEnv(
        {
          NODE_ENV: 'production',
          MEMORY_PROVIDER: '',
          MEM0_BASE_URL: 'http://mem0.local',
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).toThrow(/MEMORY_PROVIDER=mem0/i);
  });

  it('posts add memory with scoped payload', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: 'mem0-1', memory: 'Ich trinke Kaffee schwarz' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const client = createMem0Client(
      {
        baseUrl: 'http://mem0.local',
        apiKey: 'secret',
        apiPath: '/v1',
        timeoutMs: 4000,
      },
      fetchMock as unknown as typeof fetch,
    );

    const result = await client.addMemory({
      userId: 'user-1',
      personaId: 'persona-1',
      content: 'Ich trinke Kaffee schwarz',
      metadata: { type: 'fact', importance: 4 },
    });

    expect(result.id).toBe('mem0-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://mem0.local/v1/memories');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
    });
    const body = JSON.parse(String(call[1].body));
    expect(body).toMatchObject({
      messages: [{ role: 'user', content: 'Ich trinke Kaffee schwarz' }],
      user_id: 'user-1',
      agent_id: 'persona-1',
    });
    expect(body.metadata).toMatchObject({ type: 'fact', importance: 4 });
  });

  it('forwards extended evidence metadata in add memory payload', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: 'mem0-extended-1', memory: 'Episode summary' }]), {
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

    await client.addMemory({
      userId: 'user-1',
      personaId: 'persona-1',
      content: 'Episode summary',
      metadata: {
        type: 'fact',
        importance: 4,
        topicKey: 'meeting-andreas',
        conversationId: 'conv-42',
        sourceSeqStart: 100,
        sourceSeqEnd: 124,
        artifactType: 'episode',
      },
    });

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1].body));
    expect(body.metadata).toMatchObject({
      topicKey: 'meeting-andreas',
      conversationId: 'conv-42',
      sourceSeqStart: 100,
      sourceSeqEnd: 124,
      artifactType: 'episode',
    });
  });

  it('lists memories with filters and pagination for WebUI CRUD', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            memories: [
              {
                id: 'mem0-1',
                memory: 'Alpha',
                score: 0.9,
                metadata: { type: 'fact', importance: 5 },
              },
            ],
            total: 17,
            page: 2,
            page_size: 10,
          }),
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

    const result: Mem0ListMemoryResult = await client.listMemories({
      userId: 'user-1',
      personaId: 'persona-1',
      page: 2,
      pageSize: 10,
      query: 'alp',
      type: 'fact',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://mem0.local/v2/memories');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(String(call[1].body));
    expect(body.filters).toMatchObject({
      user_id: 'user-1',
      agent_id: 'persona-1',
      type: 'fact',
    });
    expect(body.query).toBe('alp');
    expect(body.page).toBe(2);
    expect(body.page_size).toBe(10);

    expect(result.memories).toHaveLength(1);
    expect(result.total).toBe(17);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
  });

  it('parses search response variants defensively', async () => {
    const responses = [
      new Response(
        JSON.stringify({
          memories: [
            {
              id: 'a',
              memory: 'Alpha',
              score: 0.9,
              metadata: { type: 'fact', importance: 5 },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
      new Response(
        JSON.stringify([
          {
            id: 'b',
            text: 'Beta',
            similarity: 0.8,
          },
        ]),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    ];

    const fetchMock = vi.fn(async () => responses.shift() as Response);
    const client = createMem0Client(
      {
        baseUrl: 'http://mem0.local',
        apiPath: '/v1',
        timeoutMs: 4000,
      },
      fetchMock as unknown as typeof fetch,
    );

    const first = await client.searchMemories({
      userId: 'user-1',
      personaId: 'persona-1',
      query: 'Alpha?',
      limit: 3,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: 'a', content: 'Alpha', score: 0.9 });
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe('http://mem0.local/v2/memories/search');
    const firstBody = JSON.parse(String(firstCall[1].body));
    expect(firstBody.filters).toMatchObject({ user_id: 'user-1', agent_id: 'persona-1' });

    const second = await client.searchMemories({
      userId: 'user-1',
      personaId: 'persona-1',
      query: 'Beta?',
      limit: 3,
    });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ id: 'b', content: 'Beta', score: 0.8 });
  });

  it('extracts memory id from results envelope on add memory', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [{ id: 'mem0-results-1', memory: 'Ich trinke Tee' }],
          }),
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

    const result = await client.addMemory({
      userId: 'user-1',
      personaId: 'persona-1',
      content: 'Ich trinke Tee',
      metadata: { type: 'fact', importance: 3 },
    });

    expect(result.id).toBe('mem0-results-1');
  });

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

  it('auto-syncs mem0 config from model hub when runtime is unconfigured (503)', async () => {
    mem0SyncMocks.syncMem0LlmFromModelHub.mockResolvedValue({ ok: true });
    mem0SyncMocks.syncMem0EmbedderFromModelHub.mockResolvedValue({ ok: true });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Mem0 runtime is not configured.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ memories: [], total: 0, page: 1, page_size: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = createMem0Client(
      {
        baseUrl: 'http://mem0.local',
        apiPath: '/v1',
        maxRetries: 0,
      },
      fetchMock as unknown as typeof fetch,
    );

    const result = await client.listMemories({
      userId: 'user-1',
      personaId: 'persona-1',
      page: 1,
      pageSize: 10,
    });

    expect(result.total).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mem0SyncMocks.syncMem0LlmFromModelHub).toHaveBeenCalledTimes(1);
    expect(mem0SyncMocks.syncMem0EmbedderFromModelHub).toHaveBeenCalledTimes(1);
  });
});
