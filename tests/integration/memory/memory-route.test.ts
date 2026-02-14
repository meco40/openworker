import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, PATCH, POST, PUT } from '../../../app/api/memory/route';

interface EmbeddingPayload {
  contents?: Array<{ parts?: Array<{ text?: string }> } | string>;
  content?: { parts?: Array<{ text?: string }> };
  requests?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    contents?: Array<{ parts?: Array<{ text?: string }> } | string>;
  }>;
}

function makePostRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function resetMemorySingletons(): void {
  (globalThis as { __memoryRepository?: unknown }).__memoryRepository = undefined;
  (globalThis as { __memoryService?: unknown }).__memoryService = undefined;
}

describe('/api/memory route', () => {
  let dbPath = '';
  const personaId = 'persona-test';

  beforeEach(() => {
    dbPath = path.join(
      process.cwd(),
      '.local',
      `memory.route.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MEMORY_DB_PATH = dbPath;
    resetMemorySingletons();

    (globalThis as { __modelHubService?: unknown }).__modelHubService = {
      dispatchEmbedding: vi.fn(
        async (_key: string, input: { operation: string; payload: EmbeddingPayload }) => {
          const fromContents = (() => {
            const first = input.payload?.contents?.[0];
            if (typeof first === 'string') return first;
            return first?.parts?.[0]?.text || '';
          })();
          const fromRequestContents = (() => {
            const first = input.payload?.requests?.[0]?.contents?.[0];
            if (typeof first === 'string') return first;
            return first?.parts?.[0]?.text || '';
          })();
          const text: string =
            fromContents ||
            input.payload?.content?.parts?.[0]?.text ||
            fromRequestContents ||
            input.payload?.requests?.[0]?.content?.parts?.[0]?.text ||
            '';
          const map: Record<string, number[]> = {
            'persist-me': [1, 0],
            'find-me': [1, 0],
            'persist-me-a': [1, 0],
            'persist-me-b': [0, 1],
            'persist-me-c': [0.6, 0.8],
            'bulk-a': [0.7, 0.3],
            'bulk-b': [0.2, 0.9],
            'persist-me-updated': [0.95, 0.05],
          };
          return { embedding: { values: map[text] || [0.11, 0.89] } };
        },
      ),
    };
  });

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
        args: { personaId, query: 'find-me', limit: 5 },
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
  });

  it('deletes one memory node via DELETE', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();
    const nodeId = String(storeJson?.result?.data?.id || '');
    expect(nodeId.length).toBeGreaterThan(0);

    const deleteResponse = await DELETE(
      new Request(
        `http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}&id=${encodeURIComponent(nodeId)}`,
        { method: 'DELETE' },
      ),
    );
    const deleteJson = await deleteResponse.json();
    expect(deleteResponse.status).toBe(200);
    expect(deleteJson.ok).toBe(true);
    expect(deleteJson.deleted).toBe(1);

    const listResponse = await GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listJson.nodes).toHaveLength(0);
  });

  it('supports bulk update and bulk delete via PATCH', async () => {
    const first = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'bulk-a', importance: 2 },
      }),
    );
    const second = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'preference', content: 'bulk-b', importance: 3 },
      }),
    );
    const firstJson = await first.json();
    const secondJson = await second.json();
    const idA = String(firstJson?.result?.data?.id || '');
    const idB = String(secondJson?.result?.data?.id || '');

    const bulkUpdateResponse = await PATCH(
      makePostRequest({
        personaId,
        ids: [idA, idB],
        action: 'update',
        type: 'lesson',
        importance: 5,
      }),
    );
    const bulkUpdateJson = await bulkUpdateResponse.json();
    expect(bulkUpdateResponse.status).toBe(200);
    expect(bulkUpdateJson.ok).toBe(true);
    expect(bulkUpdateJson.affected).toBe(2);

    const listAfterUpdate = await GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const listAfterUpdateJson = await listAfterUpdate.json();
    expect(listAfterUpdateJson.nodes.every((node: { type: string }) => node.type === 'lesson')).toBe(
      true,
    );
    expect(
      listAfterUpdateJson.nodes.every((node: { importance: number }) => node.importance === 5),
    ).toBe(true);

    const bulkDeleteResponse = await PATCH(
      makePostRequest({
        personaId,
        ids: [idA, idB],
        action: 'delete',
      }),
    );
    const bulkDeleteJson = await bulkDeleteResponse.json();
    expect(bulkDeleteResponse.status).toBe(200);
    expect(bulkDeleteJson.ok).toBe(true);
    expect(bulkDeleteJson.affected).toBe(2);
  });

  it('returns 400 when personaId is missing', async () => {
    const response = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);

    const listResponse = await GET(new Request('http://localhost/api/memory'));
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(400);
    expect(listJson.ok).toBe(false);
  });
});
