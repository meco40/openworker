import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadFlowsRoute() {
  return import('../../../app/api/worker/orchestra/flows/route');
}

async function loadFlowByIdRoute() {
  return import('../../../app/api/worker/orchestra/flows/[id]/route');
}

async function loadFlowPublishRoute() {
  return import('../../../app/api/worker/orchestra/flows/[id]/publish/route');
}

function makeGraph(nextNodeId = 'n2') {
  return {
    startNodeId: 'n1',
    nodes: [
      { id: 'n1', personaId: 'persona-research' },
      { id: nextNodeId, personaId: 'persona-review' },
    ],
    edges: [{ from: 'n1', to: nextNodeId }],
  };
}

function uniqueDbPath(prefix: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${prefix}.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('orchestra flows routes', () => {
  const cleanupPaths: string[] = [];
  const personaCleanupPaths: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.WORKER_DB_PATH;
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

    for (const filePath of personaCleanupPaths.splice(0, personaCleanupPaths.length)) {
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

  it('supports create, update, publish and immutable published snapshots', async () => {
    const dbPath = uniqueDbPath('worker.orchestra.flows');
    const personasDbPath = uniqueDbPath('personas.orchestra.flows');
    cleanupPaths.push(dbPath);
    personaCleanupPaths.push(personasDbPath);
    process.env.WORKER_DB_PATH = dbPath;
    process.env.PERSONAS_DB_PATH = personasDbPath;
    mockUserContext({ userId: 'user-a', authenticated: true });

    const flowsRoute = await loadFlowsRoute();
    const byIdRoute = await loadFlowByIdRoute();
    const publishRoute = await loadFlowPublishRoute();

    const createResponse = await flowsRoute.POST(
      new Request('http://localhost/api/worker/orchestra/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Research Pipeline',
          workspaceType: 'research',
          graph: makeGraph(),
        }),
      }),
    );
    const createPayload = (await createResponse.json()) as {
      ok: boolean;
      flow: { id: string; name: string };
    };
    expect(createResponse.status).toBe(201);
    expect(createPayload.ok).toBe(true);
    expect(createPayload.flow.name).toBe('Research Pipeline');

    const updateResponse = await byIdRoute.PATCH(
      new Request(`http://localhost/api/worker/orchestra/flows/${createPayload.flow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Research Pipeline V1',
        }),
      }),
      { params: Promise.resolve({ id: createPayload.flow.id }) },
    );
    const updatePayload = (await updateResponse.json()) as {
      ok: boolean;
      flow: { name: string };
    };
    expect(updateResponse.status).toBe(200);
    expect(updatePayload.ok).toBe(true);
    expect(updatePayload.flow.name).toBe('Research Pipeline V1');

    const publishV1Response = await publishRoute.POST(
      new Request(`http://localhost/api/worker/orchestra/flows/${createPayload.flow.id}/publish`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: createPayload.flow.id }) },
    );
    const publishV1Payload = (await publishV1Response.json()) as {
      ok: boolean;
      published: { id: string; version: number; graphJson: string };
    };
    expect(publishV1Response.status).toBe(200);
    expect(publishV1Payload.ok).toBe(true);
    expect(publishV1Payload.published.version).toBe(1);

    const patchGraphResponse = await byIdRoute.PATCH(
      new Request(`http://localhost/api/worker/orchestra/flows/${createPayload.flow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          graph: makeGraph('n3'),
        }),
      }),
      { params: Promise.resolve({ id: createPayload.flow.id }) },
    );
    expect(patchGraphResponse.status).toBe(200);

    const publishV2Response = await publishRoute.POST(
      new Request(`http://localhost/api/worker/orchestra/flows/${createPayload.flow.id}/publish`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: createPayload.flow.id }) },
    );
    const publishV2Payload = (await publishV2Response.json()) as {
      ok: boolean;
      published: { version: number; graphJson: string };
    };
    expect(publishV2Response.status).toBe(200);
    expect(publishV2Payload.ok).toBe(true);
    expect(publishV2Payload.published.version).toBe(2);

    const v1Graph = JSON.parse(publishV1Payload.published.graphJson) as {
      edges: Array<{ to: string }>;
    };
    const v2Graph = JSON.parse(publishV2Payload.published.graphJson) as {
      edges: Array<{ to: string }>;
    };
    expect(v1Graph.edges[0].to).toBe('n2');
    expect(v2Graph.edges[0].to).toBe('n3');

    const listResponse = await flowsRoute.GET(
      new Request('http://localhost/api/worker/orchestra/flows?workspaceType=research'),
    );
    const listPayload = (await listResponse.json()) as {
      ok: boolean;
      drafts: Array<{ id: string }>;
      published: Array<{ version: number }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listPayload.ok).toBe(true);
    expect(listPayload.drafts.length).toBe(1);
    expect(listPayload.published.length).toBeGreaterThanOrEqual(2);
  });

  it('returns 400 when graph validation fails', async () => {
    const dbPath = uniqueDbPath('worker.orchestra.flows.invalid');
    const personasDbPath = uniqueDbPath('personas.orchestra.flows.invalid');
    cleanupPaths.push(dbPath);
    personaCleanupPaths.push(personasDbPath);
    process.env.WORKER_DB_PATH = dbPath;
    process.env.PERSONAS_DB_PATH = personasDbPath;
    mockUserContext({ userId: 'user-a', authenticated: true });

    const flowsRoute = await loadFlowsRoute();
    const invalidResponse = await flowsRoute.POST(
      new Request('http://localhost/api/worker/orchestra/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Flow',
          workspaceType: 'research',
          graph: {
            startNodeId: 'n1',
            nodes: [{ id: 'n1', personaId: 'persona-a' }],
            edges: [{ from: 'n1', to: 'n2' }],
          },
        }),
      }),
    );
    const invalidPayload = (await invalidResponse.json()) as { ok: boolean; error: string };

    expect(invalidResponse.status).toBe(400);
    expect(invalidPayload.ok).toBe(false);
    expect(invalidPayload.error.toLowerCase()).toContain('unknown');
  });

  it('accepts persona-default placeholder when user has personas', async () => {
    const workerDbPath = uniqueDbPath('worker.orchestra.flows.placeholder');
    const personasDbPath = uniqueDbPath('personas.orchestra.flows.placeholder');
    cleanupPaths.push(workerDbPath);
    personaCleanupPaths.push(personasDbPath);
    process.env.WORKER_DB_PATH = workerDbPath;
    process.env.PERSONAS_DB_PATH = personasDbPath;
    mockUserContext({ userId: 'user-a', authenticated: true });

    const { getPersonaRepository } = await import('../../../src/server/personas/personaRepository');
    const personaRepo = getPersonaRepository();
    const persona = personaRepo.createPersona({
      userId: 'user-a',
      name: 'Research Persona',
      emoji: '🔎',
      vibe: '',
    });

    const flowsRoute = await loadFlowsRoute();
    const createResponse = await flowsRoute.POST(
      new Request('http://localhost/api/worker/orchestra/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Research Pipeline',
          workspaceType: 'research',
          graph: {
            startNodeId: 'n1',
            nodes: [{ id: 'n1', personaId: 'persona-default' }],
            edges: [],
          },
        }),
      }),
    );

    const createPayload = (await createResponse.json()) as {
      ok: boolean;
      flow?: { graphJson?: string };
      error?: string;
    };
    expect(createResponse.status).toBe(201);
    expect(createPayload.ok).toBe(true);

    const flowGraph = JSON.parse(createPayload.flow?.graphJson || '{}') as {
      nodes: Array<{ id: string; personaId: string }>;
    };
    expect(flowGraph.nodes[0]?.personaId).toBe(persona.id);
  });
});
