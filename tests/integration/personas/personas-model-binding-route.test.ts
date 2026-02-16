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

describe('personas model binding route', () => {
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

  it('creates and updates personas with model binding fields', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `personas.model.binding.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.PERSONAS_DB_PATH = dbPath;

    mockUserContext({ userId: 'user-a', authenticated: true });
    mockPipelineModels(['gpt-4o-mini', 'claude-3.7-sonnet']);

    const personasRoute = await loadPersonasRoute();
    const createResponse = await personasRoute.POST(
      new Request('http://localhost/api/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Developer Persona',
          preferredModelId: 'gpt-4o-mini',
          modelHubProfileId: 'team-a',
        }),
      }),
    );
    const createPayload = (await createResponse.json()) as {
      ok: boolean;
      persona: { id: string; preferredModelId: string | null; modelHubProfileId: string | null };
    };

    expect(createResponse.status).toBe(201);
    expect(createPayload.ok).toBe(true);
    expect(createPayload.persona.preferredModelId).toBe('gpt-4o-mini');
    expect(createPayload.persona.modelHubProfileId).toBe('team-a');

    const personaRoute = await loadPersonaByIdRoute();
    const updateResponse = await personaRoute.PUT(
      new Request(`http://localhost/api/personas/${createPayload.persona.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferredModelId: 'claude-3.7-sonnet',
          modelHubProfileId: 'team-b',
        }),
      }),
      { params: Promise.resolve({ id: createPayload.persona.id }) },
    );
    const updatePayload = (await updateResponse.json()) as {
      ok: boolean;
      persona: { preferredModelId: string | null; modelHubProfileId: string | null };
    };

    expect(updateResponse.status).toBe(200);
    expect(updatePayload.ok).toBe(true);
    expect(updatePayload.persona.preferredModelId).toBe('claude-3.7-sonnet');
    expect(updatePayload.persona.modelHubProfileId).toBe('team-b');
  });
});
