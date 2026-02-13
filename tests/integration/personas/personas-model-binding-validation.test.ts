import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

function mockPipelineModels(modelNames: string[]): void {
  vi.doMock('../../../src/server/model-hub/runtime', () => ({
    getModelHubService: () => ({
      listPipeline: () =>
        modelNames.map((modelName, idx) => ({
          id: `m-${idx + 1}`,
          profileId: 'p1',
          accountId: 'acc-1',
          providerId: 'openai',
          modelName,
          priority: idx + 1,
          status: 'active',
        })),
    }),
  }));
}

async function loadPersonasRoute() {
  return import('../../../app/api/personas/route');
}

async function loadPersonaByIdRoute() {
  return import('../../../app/api/personas/[id]/route');
}

describe('personas model binding validation', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.PERSONAS_DB_PATH;

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

  it('rejects unavailable models and enforces user scope on update', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `personas.model.validation.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.PERSONAS_DB_PATH = dbPath;

    mockUserContext({ userId: 'user-a', authenticated: true });
    mockPipelineModels(['gpt-4o-mini']);
    const personasRouteA = await loadPersonasRoute();

    const invalidCreate = await personasRouteA.POST(
      new Request('http://localhost/api/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Model Persona',
          preferredModelId: 'not-allowed-model',
        }),
      }),
    );
    expect(invalidCreate.status).toBe(400);

    const validCreate = await personasRouteA.POST(
      new Request('http://localhost/api/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Scoped Persona',
          preferredModelId: 'gpt-4o-mini',
        }),
      }),
    );
    const validPayload = (await validCreate.json()) as {
      ok: boolean;
      persona: { id: string };
    };
    expect(validCreate.status).toBe(201);
    expect(validPayload.ok).toBe(true);

    vi.resetModules();
    mockUserContext({ userId: 'user-b', authenticated: true });
    mockPipelineModels(['gpt-4o-mini']);
    const personaByIdRouteB = await loadPersonaByIdRoute();
    const crossUpdate = await personaByIdRouteB.PUT(
      new Request(`http://localhost/api/personas/${validPayload.persona.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferredModelId: 'gpt-4o-mini',
        }),
      }),
      { params: Promise.resolve({ id: validPayload.persona.id }) },
    );

    expect(crossUpdate.status).toBe(404);
  });
});
