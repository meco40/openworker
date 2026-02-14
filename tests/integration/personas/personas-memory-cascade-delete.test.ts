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

describe('persona memory cascade delete', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.PERSONAS_DB_PATH;
    delete process.env.MEMORY_DB_PATH;
    (globalThis as { __memoryRepository?: unknown }).__memoryRepository = undefined;
    (globalThis as { __memoryService?: unknown }).__memoryService = undefined;
    (globalThis as { __modelHubService?: unknown }).__modelHubService = undefined;

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
    const memoryDbPath = path.join(
      process.cwd(),
      '.local',
      `memory.persona-cascade.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(personasDbPath, memoryDbPath);
    process.env.PERSONAS_DB_PATH = personasDbPath;
    process.env.MEMORY_DB_PATH = memoryDbPath;

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
