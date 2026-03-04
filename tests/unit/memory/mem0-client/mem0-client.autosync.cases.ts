import { describe, expect, it, vi } from 'vitest';
import { createMem0Client } from '@/server/memory/mem0';
import { getMem0SyncMocks, registerMem0ClientCleanup } from './mem0-client.harness';

describe('mem0Client', () => {
  registerMem0ClientCleanup();
  const mem0SyncMocks = getMem0SyncMocks();

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
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const thirdCall = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(thirdCall[0]).toBe('http://mem0.local/v1/memories?user_id=user-1&agent_id=persona-1');
    expect(mem0SyncMocks.syncMem0LlmFromModelHub).toHaveBeenCalledTimes(1);
    expect(mem0SyncMocks.syncMem0EmbedderFromModelHub).toHaveBeenCalledTimes(1);
  });

  it('auto-syncs mem0 config when embed model is invalid/not found', async () => {
    mem0SyncMocks.syncMem0LlmFromModelHub.mockResolvedValue({ ok: true });
    mem0SyncMocks.syncMem0EmbedderFromModelHub.mockResolvedValue({ ok: true });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            detail:
              "404 NOT_FOUND. {'error': {'code': 404, 'message': 'models/text-embedding-004 is not found for API version v1beta, or is not supported for embedContent.', 'status': 'NOT_FOUND'}}",
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ memories: [], total: 0, page: 1, page_size: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const thirdCall = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(thirdCall[0]).toBe('http://mem0.local/v1/memories?user_id=user-1&agent_id=persona-1');
    expect(mem0SyncMocks.syncMem0LlmFromModelHub).toHaveBeenCalledTimes(1);
    expect(mem0SyncMocks.syncMem0EmbedderFromModelHub).toHaveBeenCalledTimes(1);
  });
});
