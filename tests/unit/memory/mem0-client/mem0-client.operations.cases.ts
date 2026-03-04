import { describe, expect, it, vi } from 'vitest';
import { createMem0Client, type Mem0ListMemoryResult } from '@/server/memory/mem0';
import { registerMem0ClientCleanup } from './mem0-client.harness';

describe('mem0Client', () => {
  registerMem0ClientCleanup();
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
});
