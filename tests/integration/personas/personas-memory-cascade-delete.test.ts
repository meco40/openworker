import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadPersonasRoute() {
  return import('../../../app/api/personas/route');
}

async function loadPersonaByIdRoute() {
  return import('../../../app/api/personas/[id]/route');
}

async function loadMemoryRoute() {
  return import('../../../app/api/memory/route');
}

function makeMemoryPostRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function memoryScopeKey(userId: string, personaId: string): string {
  return `${userId}::${personaId}`;
}

describe('persona memory cascade delete', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.PERSONAS_DB_PATH;
    delete process.env.MEMORY_PROVIDER;
    delete process.env.MEM0_BASE_URL;
    delete process.env.MEM0_API_PATH;
    delete process.env.MEM0_API_KEY;
    (globalThis as { __memoryService?: unknown }).__memoryService = undefined;
    (globalThis as { __mem0Client?: unknown }).__mem0Client = undefined;
    (globalThis as { __modelHubService?: unknown }).__modelHubService = undefined;
    vi.unstubAllGlobals();

    for (const filePath of cleanupPaths.splice(0, cleanupPaths.length)) {
      for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        try {
          if (fs.existsSync(candidate)) {
            fs.unlinkSync(candidate);
          }
        } catch {
          // ignore file lock in tests
        }
      }
    }
  });

  it('deletes memory entries when persona is deleted', async () => {
    const personasDbPath = path.join(
      process.cwd(),
      '.local',
      `personas.memory-cascade.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(personasDbPath);
    process.env.PERSONAS_DB_PATH = personasDbPath;
    process.env.MEMORY_PROVIDER = 'mem0';
    process.env.MEM0_BASE_URL = 'http://mem0.local';
    process.env.MEM0_API_PATH = '/v1';
    process.env.MEM0_API_KEY = 'mem0_test_key';

    const memoryStore = new Map<string, Array<{ id: string; content: string; metadata: Record<string, unknown> }>>();
    const defaultUser = 'user-a';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const parsed = new URL(url);
        const method = String(init?.method || 'GET').toUpperCase();
        const body = (() => {
          if (!init?.body || typeof init.body !== 'string') return {} as Record<string, unknown>;
          try {
            return JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            return {} as Record<string, unknown>;
          }
        })();

        if (method === 'POST' && parsed.pathname.endsWith('/v1/memories')) {
          const userId = String(body.user_id || defaultUser);
          const personaId = String(body.agent_id || 'persona-default');
          const messages = Array.isArray(body.messages) ? body.messages : [];
          const content = String((messages[0] as { content?: string } | undefined)?.content || '');
          const id = `mem0-${Math.random().toString(36).slice(2, 10)}`;
          const key = memoryScopeKey(userId, personaId);
          const next = [...(memoryStore.get(key) || []), { id, content, metadata: (body.metadata as Record<string, unknown>) || {} }];
          memoryStore.set(key, next);
          return new Response(JSON.stringify([{ id, memory: content }]), { status: 200 });
        }

        if (method === 'POST' && parsed.pathname.endsWith('/v2/memories')) {
          const filters = (body.filters as Record<string, unknown>) || {};
          const userId = String(filters.user_id || defaultUser);
          const personaId = String(filters.agent_id || '');
          const key = memoryScopeKey(userId, personaId);
          const rows = personaId ? memoryStore.get(key) || [] : [];
          return new Response(
            JSON.stringify({
              memories: rows.map((row) => ({
                id: row.id,
                memory: row.content,
                metadata: row.metadata,
              })),
              total: rows.length,
              page: 1,
              page_size: 25,
            }),
            { status: 200 },
          );
        }

        if (method === 'DELETE' && parsed.pathname.endsWith('/v1/memories')) {
          const userId = String(body.user_id || defaultUser);
          const personaId = String(body.agent_id || '');
          const key = memoryScopeKey(userId, personaId);
          const deleted = (memoryStore.get(key) || []).length;
          memoryStore.delete(key);
          return new Response(JSON.stringify({ deleted }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: `Unhandled ${method} ${parsed.pathname}` }), { status: 500 });
      }) as unknown as typeof fetch,
    );

    mockUserContext({ userId: 'user-a', authenticated: true });

    (globalThis as { __modelHubService?: unknown }).__modelHubService = {
      dispatchEmbedding: vi.fn(async () => ({ embedding: { values: [1, 0] } })),
    };

    const personasRoute = await loadPersonasRoute();
    const createResponse = await personasRoute.POST(
      new Request('http://localhost/api/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Memory Persona' }),
      }),
    );
    const createPayload = (await createResponse.json()) as {
      ok: boolean;
      persona: { id: string };
    };

    expect(createResponse.status).toBe(201);
    expect(createPayload.ok).toBe(true);
    const personaId = createPayload.persona.id;

    const memoryRoute = await loadMemoryRoute();
    const storeResponse = await memoryRoute.POST(
      makeMemoryPostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'likes lasagna', importance: 5 },
      }),
    );
    expect(storeResponse.status).toBe(200);

    const beforeDeleteResponse = await memoryRoute.GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const beforeDeletePayload = (await beforeDeleteResponse.json()) as {
      ok: boolean;
      nodes: Array<{ content: string }>;
    };
    expect(beforeDeleteResponse.status).toBe(200);
    expect(beforeDeletePayload.ok).toBe(true);
    expect(beforeDeletePayload.nodes).toHaveLength(1);

    const personaByIdRoute = await loadPersonaByIdRoute();
    const deleteResponse = await personaByIdRoute.DELETE(
      new Request(`http://localhost/api/personas/${personaId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: personaId }) },
    );
    expect(deleteResponse.status).toBe(200);

    const afterDeleteResponse = await memoryRoute.GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const afterDeletePayload = (await afterDeleteResponse.json()) as {
      ok: boolean;
      nodes: Array<{ content: string }>;
    };
    expect(afterDeleteResponse.status).toBe(200);
    expect(afterDeletePayload.ok).toBe(true);
    expect(afterDeletePayload.nodes).toHaveLength(0);
  }, 15_000);
});
