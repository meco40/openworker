import { beforeEach, describe, expect, it } from 'vitest';
import {
  GET,
  POST,
  PUT,
  makePostRequest,
  personaId,
  setupMemoryRouteTestEnv,
} from './memory-route.harness';

describe('/api/memory route', () => {
  beforeEach(setupMemoryRouteTestEnv);
  it('stores memory via POST and returns persisted nodes via GET', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();

    expect(storeResponse.status).toBe(200);
    expect(storeJson.ok).toBe(true);
    expect(storeJson.result.action).toBe('store');

    const listResponse = await GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(listJson.nodes).toHaveLength(1);
    expect(listJson.nodes[0].content).toBe('persist-me');
  });

  it('includes channel-scoped memory for legacy web user when channel conversation exists', async () => {
    const telegramExternalChatId = '1527785051';
    const channelScopedUserId = `channel:telegram:${telegramExternalChatId}`;
    const memoryServiceModule = await import('@/server/memory/runtime');
    const memoryService = memoryServiceModule.getMemoryService();
    await memoryService.store(
      personaId,
      'fact',
      'persisted-in-telegram-scope',
      4,
      channelScopedUserId,
    );

    (globalThis as { __messageRepository?: unknown }).__messageRepository = {
      listConversations: () => [
        {
          id: 'conv-telegram-1',
          channelType: 'Telegram',
          externalChatId: telegramExternalChatId,
          userId: 'legacy-local-user',
          title: 'Telegram',
          modelOverride: null,
          personaId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };

    const listResponse = await GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const listJson = await listResponse.json();

    expect(listResponse.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(
      listJson.nodes.some(
        (node: { content: string }) => node.content === 'persisted-in-telegram-scope',
      ),
    ).toBe(true);
  });

  it('recalls relevant memory context via POST', async () => {
    await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'preference', content: 'persist-me', importance: 3 },
      }),
    );

    const recallResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_recall',
        args: { personaId, query: 'persist', limit: 5 },
      }),
    );
    const recallJson = await recallResponse.json();

    expect(recallResponse.status).toBe(200);
    expect(recallJson.ok).toBe(true);
    expect(recallJson.result.action).toBe('recall');
    expect(recallJson.result.data).toContain('[Type: preference] persist-me');
  });

  it('returns 400 for invalid payload', async () => {
    const response = await POST(
      makePostRequest({
        fcName: 'unsupported_call',
        args: {},
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
  });

  it('supports paginated GET results', async () => {
    await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me-a', importance: 4 },
      }),
    );
    await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'preference', content: 'persist-me-b', importance: 3 },
      }),
    );
    await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'lesson', content: 'persist-me-c', importance: 2 },
      }),
    );

    const listResponse = await GET(
      new Request(
        `http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}&page=1&pageSize=2`,
      ),
    );
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(Array.isArray(listJson.nodes)).toBe(true);
    expect(listJson.nodes).toHaveLength(2);
    expect(listJson.pagination.total).toBe(3);
    expect(listJson.pagination.totalPages).toBe(2);
  });

  it('updates memory node content via PUT', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();
    const nodeId = String(storeJson?.result?.data?.id || '');
    expect(nodeId.length).toBeGreaterThan(0);

    const updateResponse = await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        content: 'persist-me-updated',
        importance: 5,
      }),
    );
    const updateJson = await updateResponse.json();
    expect(updateResponse.status).toBe(200);
    expect(updateJson.ok).toBe(true);
    expect(updateJson.node.content).toBe('persist-me-updated');
    expect(updateJson.node.importance).toBe(5);
    expect(updateJson.node.id).toBe(nodeId);
    expect(updateJson.node.metadata.version).toBe(2);
  });
});
