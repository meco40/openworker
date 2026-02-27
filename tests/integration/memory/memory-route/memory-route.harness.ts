import { vi } from 'vitest';
import { DELETE, GET, PATCH, POST, PUT } from '../../../../app/api/memory/route';

export { DELETE, GET, PATCH, POST, PUT };

export const personaId = 'persona-test';

export function makePostRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function resetMemorySingletons(): void {
  (globalThis as { __memoryService?: unknown }).__memoryService = undefined;
  (globalThis as { __mem0Client?: unknown }).__mem0Client = undefined;
  (globalThis as { __messageRepository?: unknown }).__messageRepository = undefined;
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

    return new Response(JSON.stringify({ error: `Unhandled ${method} ${pathname}` }), {
      status: 500,
    });
  });

  vi.stubGlobal('fetch', mock as unknown as typeof fetch);
  return { mock };
}

export function setupMemoryRouteTestEnv(): void {
  process.env.MEMORY_PROVIDER = 'mem0';
  process.env.MEM0_BASE_URL = 'http://mem0.local';
  process.env.MEM0_API_PATH = '/v1';
  process.env.MEM0_API_KEY = 'mem0_test_key';
  setupMem0FetchMock();
  resetMemorySingletons();
}
