import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, PATCH, POST, PUT } from '../../../app/api/memory/route';

function makePostRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function resetMemorySingletons(): void {
  (globalThis as { __memoryService?: unknown }).__memoryService = undefined;
  (globalThis as { __mem0Client?: unknown }).__mem0Client = undefined;
}

type MemRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  userId: string;
  personaId: string;
  createdAt: string;
  updatedAt: string;
};

function scopeKey(userId: string, personaId: string): string {
  return `${userId}::${personaId}`;
}

function setupMem0FetchMock() {
  const byScope = new Map<string, MemRecord[]>();
  const historyById = new Map<string, Array<Record<string, unknown>>>();

  const readScope = (userId: string, personaId: string): MemRecord[] =>
    byScope.get(scopeKey(userId, personaId)) || [];

  const writeScope = (userId: string, personaId: string, rows: MemRecord[]) => {
    byScope.set(scopeKey(userId, personaId), rows);
  };

  const findById = (id: string): { key: string; index: number; record: MemRecord } | null => {
    for (const [key, rows] of byScope.entries()) {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) return { key, index, record: rows[index] };
    }
    return null;
  };

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(url);
    const method = String(init?.method || 'GET').toUpperCase();
    const pathname = parsed.pathname;
    const body = (() => {
      if (!init?.body || typeof init.body !== 'string') return {} as Record<string, unknown>;
      try {
        return JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })();

    if (method === 'POST' && pathname.endsWith('/v1/memories')) {
      const userId = String(body.user_id || 'legacy-local-user');
      const personaId = String(body.agent_id || 'persona-default');
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const content = String((messages[0] as { content?: string } | undefined)?.content || '');
      const id = `mem0-${Math.random().toString(36).slice(2, 10)}`;
      const now = new Date().toISOString();
      const row: MemRecord = {
        id,
        content,
        metadata: (body.metadata as Record<string, unknown>) || {},
        userId,
        personaId,
        createdAt: now,
        updatedAt: now,
      };
      writeScope(userId, personaId, [...readScope(userId, personaId), row]);
      historyById.set(id, [
        {
          action: 'create',
          timestamp: row.createdAt,
          content,
          metadata: row.metadata,
        },
      ]);
      return new Response(JSON.stringify([{ id, memory: content }]), { status: 200 });
    }

    if (method === 'POST' && pathname.endsWith('/v2/memories/search')) {
      const filters = (body.filters as Record<string, unknown>) || {};
      const userId = String(filters.user_id || 'legacy-local-user');
      const personaId = String(filters.agent_id || 'persona-default');
      const query = String(body.query || '').toLowerCase();
      const limit = Number(body.top_k || body.limit || 3);
      const rows = readScope(userId, personaId)
        .filter((row) => row.content.toLowerCase().includes(query))
        .slice(0, Math.max(1, Math.floor(limit)));
      return new Response(
        JSON.stringify(
          rows.map((row) => ({
            id: row.id,
            memory: row.content,
            score: 0.92,
            metadata: row.metadata,
          })),
        ),
        { status: 200 },
      );
    }

    if (method === 'POST' && pathname.endsWith('/v2/memories')) {
      const filters = (body.filters as Record<string, unknown>) || {};
      const userId = String(filters.user_id || 'legacy-local-user');
      const personaId = String(filters.agent_id || '');
      const page = Math.max(1, Math.floor(Number(body.page || 1)));
      const pageSize = Math.max(1, Math.floor(Number(body.page_size || 25)));
      const query = String(body.query || '').toLowerCase();
      const typeFilter = String(filters.type || '');

      const source = personaId
        ? readScope(userId, personaId)
        : Array.from(byScope.entries())
            .filter(([key]) => key.startsWith(`${userId}::`))
            .flatMap(([, rows]) => rows);

      const filtered = source.filter((row) => {
        const queryOk = query ? row.content.toLowerCase().includes(query) : true;
        const typeOk = typeFilter ? String(row.metadata.type || '') === typeFilter : true;
        return queryOk && typeOk;
      });
      const offset = (page - 1) * pageSize;
      const memories = filtered.slice(offset, offset + pageSize).map((row) => ({
        id: row.id,
        memory: row.content,
        metadata: row.metadata,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }));

      return new Response(
        JSON.stringify({
          memories,
          total: filtered.length,
          page,
          page_size: pageSize,
        }),
        { status: 200 },
      );
    }

    if (method === 'GET' && pathname.endsWith('/history') && pathname.includes('/v1/memories/')) {
      const parts = pathname.split('/');
      const id = decodeURIComponent(parts[parts.length - 2] || '');
      return new Response(JSON.stringify(historyById.get(id) || []), { status: 200 });
    }

    if (method === 'GET' && pathname.includes('/v1/memories/')) {
      const id = decodeURIComponent(pathname.split('/').pop() || '');
      const found = findById(id);
      if (!found) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          id: found.record.id,
          memory: found.record.content,
          metadata: found.record.metadata,
          created_at: found.record.createdAt,
          updated_at: found.record.updatedAt,
        }),
        { status: 200 },
      );
    }

    if (method === 'PUT' && pathname.includes('/v1/memories/')) {
      const id = decodeURIComponent(pathname.split('/').pop() || '');
      const found = findById(id);
      if (!found) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      const rows = [...(byScope.get(found.key) || [])];
      rows[found.index] = {
        ...rows[found.index],
        content: String(body.text || rows[found.index].content),
        metadata: (body.metadata as Record<string, unknown>) || rows[found.index].metadata,
        updatedAt: new Date().toISOString(),
      };
      byScope.set(found.key, rows);
      historyById.set(id, [
        ...(historyById.get(id) || []),
        {
          action: 'update',
          timestamp: rows[found.index].updatedAt,
          content: rows[found.index].content,
          metadata: rows[found.index].metadata,
        },
      ]);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (method === 'DELETE' && pathname.includes('/v1/memories/')) {
      const id = decodeURIComponent(pathname.split('/').pop() || '');
      const found = findById(id);
      if (!found) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      const rows = [...(byScope.get(found.key) || [])];
      rows.splice(found.index, 1);
      byScope.set(found.key, rows);
      return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
    }

    if (method === 'DELETE' && pathname.endsWith('/v1/memories')) {
      const userId = String(body.user_id || 'legacy-local-user');
      const personaId = String(body.agent_id || '');
      if (!personaId) {
        return new Response(JSON.stringify({ deleted: 0 }), { status: 200 });
      }
      const key = scopeKey(userId, personaId);
      const deleted = (byScope.get(key) || []).length;
      byScope.delete(key);
      return new Response(JSON.stringify({ deleted }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: `Unhandled ${method} ${pathname}` }), { status: 500 });
  });

  vi.stubGlobal('fetch', mock as unknown as typeof fetch);
  return { mock };
}

describe('/api/memory route', () => {
  const personaId = 'persona-test';

  beforeEach(() => {
    process.env.MEMORY_PROVIDER = 'mem0';
    process.env.MEM0_BASE_URL = 'http://mem0.local';
    process.env.MEM0_API_PATH = '/v1';
    process.env.MEM0_API_KEY = 'mem0_test_key';
    setupMem0FetchMock();
    resetMemorySingletons();
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

  it('returns 409 on stale expectedVersion via PUT', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();
    const nodeId = String(storeJson?.result?.data?.id || '');
    expect(nodeId.length).toBeGreaterThan(0);

    const firstUpdate = await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        content: 'persist-me-v2',
        expectedVersion: 1,
      }),
    );
    expect(firstUpdate.status).toBe(200);

    const staleUpdate = await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        content: 'persist-me-stale',
        expectedVersion: 1,
      }),
    );
    const staleJson = await staleUpdate.json();
    expect(staleUpdate.status).toBe(409);
    expect(staleJson.ok).toBe(false);
    expect(String(staleJson.error || '')).toMatch(/version|conflict/i);
  });

  it('returns memory history via GET with history flag', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();
    const nodeId = String(storeJson?.result?.data?.id || '');
    expect(nodeId.length).toBeGreaterThan(0);

    await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        content: 'persist-me-updated',
        importance: 5,
      }),
    );

    const historyResponse = await GET(
      new Request(
        `http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}&id=${encodeURIComponent(nodeId)}&history=1`,
      ),
    );
    const historyJson = await historyResponse.json();
    expect(historyResponse.status).toBe(200);
    expect(historyJson.ok).toBe(true);
    expect(historyJson.node.id).toBe(nodeId);
    expect(Array.isArray(historyJson.history)).toBe(true);
    expect(historyJson.history.length).toBeGreaterThanOrEqual(2);
  });

  it('restores memory from history index via PUT', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();
    const nodeId = String(storeJson?.result?.data?.id || '');
    expect(nodeId.length).toBeGreaterThan(0);

    await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        content: 'persist-me-updated',
        importance: 5,
        expectedVersion: 1,
      }),
    );

    const restoreResponse = await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        restoreIndex: 0,
        expectedVersion: 2,
      }),
    );
    const restoreJson = await restoreResponse.json();
    expect(restoreResponse.status).toBe(200);
    expect(restoreJson.ok).toBe(true);
    expect(restoreJson.node.id).toBe(nodeId);
    expect(restoreJson.node.content).toBe('persist-me');
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

  it('returns 400 for unsupported bulk action values', async () => {
    const first = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'bulk-invalid-action', importance: 2 },
      }),
    );
    const firstJson = await first.json();
    const id = String(firstJson?.result?.data?.id || '');
    expect(id.length).toBeGreaterThan(0);

    const response = await PATCH(
      makePostRequest({
        personaId,
        ids: [id],
        action: 'noop',
        type: 'lesson',
      }),
    );
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/action/i);
  });

  it('returns 401 when auth is required and request user context is unavailable', async () => {
    const previousRequireAuth = process.env.REQUIRE_AUTH;
    process.env.REQUIRE_AUTH = 'true';
    try {
      const response = await GET(
        new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
      );
      const json = await response.json();
      expect(response.status).toBe(401);
      expect(json.ok).toBe(false);
    } finally {
      if (previousRequireAuth === undefined) {
        delete process.env.REQUIRE_AUTH;
      } else {
        process.env.REQUIRE_AUTH = previousRequireAuth;
      }
    }
  });
});
