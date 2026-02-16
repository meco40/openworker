import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadSubagentsRoute() {
  return import('../../../app/api/worker/[id]/subagents/route');
}

async function loadWorkerRepository() {
  return import('../../../src/server/worker/workerRepository');
}

async function loadPersonaRepository() {
  return import('../../../src/server/personas/personaRepository');
}

describe('orchestra subagent sessions route', () => {
  const cleanupPaths: string[] = [];

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
  });

  it('creates, updates and lists subagent sessions', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const workerDbPath = path.join(
      process.cwd(),
      '.local',
      `worker.orchestra.subagents.${suffix}.db`,
    );
    const personasDbPath = path.join(process.cwd(), '.local', `personas.orchestra.subagents.${suffix}.db`);
    cleanupPaths.push(workerDbPath, personasDbPath);
    process.env.WORKER_DB_PATH = workerDbPath;
    process.env.PERSONAS_DB_PATH = personasDbPath;
    mockUserContext({ userId: 'user-a', authenticated: true });

    const { getWorkerRepository } = await loadWorkerRepository();
    const repo = getWorkerRepository();
    const { getPersonaRepository } = await loadPersonaRepository();
    const persona = getPersonaRepository().createPersona({
      userId: 'user-a',
      name: 'Session Persona',
      emoji: ':)',
      vibe: 'focused',
      preferredModelId: 'gpt-4o-mini',
      modelHubProfileId: 'team-a',
    } as never);
    const task = repo.createTask({
      title: 'Subagent test task',
      objective: 'Exercise subagent session APIs',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-user-a',
      userId: 'user-a',
    });

    const route = await loadSubagentsRoute();
    const createResponse = await route.POST(
      new Request(`http://localhost/api/worker/${task.id}/subagents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-1',
          nodeId: 'node-a',
          personaId: persona.id,
          allowPersonaOverride: true,
          sessionRef: 'agent-session-1',
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    const createPayload = (await createResponse.json()) as { ok: boolean; session: { id: string } };
    expect(createResponse.status).toBe(201);
    expect(createPayload.ok).toBe(true);

    const updateResponse = await route.PATCH(
      new Request(`http://localhost/api/worker/${task.id}/subagents`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: createPayload.session.id,
          status: 'completed',
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(updateResponse.status).toBe(200);

    const listResponse = await route.GET(
      new Request(`http://localhost/api/worker/${task.id}/subagents`),
      { params: Promise.resolve({ id: task.id }) },
    );
    const listPayload = (await listResponse.json()) as {
      ok: boolean;
      sessions: Array<{ id: string; status: string }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listPayload.ok).toBe(true);
    expect(listPayload.sessions).toHaveLength(1);
    expect(listPayload.sessions[0].status).toBe('completed');
  });

  it('inherits task persona by default and requires explicit override opt-in', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const workerDbPath = path.join(process.cwd(), '.local', `worker.subagents.${suffix}.db`);
    const personasDbPath = path.join(process.cwd(), '.local', `personas.subagents.${suffix}.db`);
    cleanupPaths.push(workerDbPath, personasDbPath);
    process.env.WORKER_DB_PATH = workerDbPath;
    process.env.PERSONAS_DB_PATH = personasDbPath;

    mockUserContext({ userId: 'user-a', authenticated: true });

    const { getWorkerRepository } = await loadWorkerRepository();
    const workerRepo = getWorkerRepository();
    const task = workerRepo.createTask({
      title: 'Subagent inheritance',
      objective: 'Use task persona by default',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-user-a',
      userId: 'user-a',
    });

    const { getPersonaRepository } = await loadPersonaRepository();
    const personaRepo = getPersonaRepository();
    const inheritedPersona = personaRepo.createPersona({
      userId: 'user-a',
      name: 'Inherited Persona',
      emoji: ':)',
      vibe: 'focused',
      preferredModelId: 'gpt-4o-mini',
      modelHubProfileId: 'team-a',
    } as never);
    const overridePersona = personaRepo.createPersona({
      userId: 'user-a',
      name: 'Override Persona',
      emoji: ':D',
      vibe: 'builder',
      preferredModelId: 'claude-3.7-sonnet',
      modelHubProfileId: 'team-b',
    } as never);
    workerRepo.assignPersona(task.id, inheritedPersona.id);

    const route = await loadSubagentsRoute();

    const inheritedResponse = await route.POST(
      new Request(`http://localhost/api/worker/${task.id}/subagents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-inherit',
          nodeId: 'node-inherit',
          sessionRef: 'session-inherit',
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    const inheritedPayload = (await inheritedResponse.json()) as {
      ok: boolean;
      session: { personaId: string | null; metadata: string | null };
    };
    expect(inheritedResponse.status).toBe(201);
    expect(inheritedPayload.session.personaId).toBe(inheritedPersona.id);
    expect(inheritedPayload.session.metadata).toContain('"personaResolution":"inherited_task_persona"');
    expect(inheritedPayload.session.metadata).toContain('"modelHubProfileId":"team-a"');

    const blockedOverrideResponse = await route.POST(
      new Request(`http://localhost/api/worker/${task.id}/subagents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-override-blocked',
          nodeId: 'node-override-blocked',
          personaId: overridePersona.id,
          sessionRef: 'session-override-blocked',
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(blockedOverrideResponse.status).toBe(400);

    const allowedOverrideResponse = await route.POST(
      new Request(`http://localhost/api/worker/${task.id}/subagents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-override-allowed',
          nodeId: 'node-override-allowed',
          personaId: overridePersona.id,
          allowPersonaOverride: true,
          sessionRef: 'session-override-allowed',
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    const allowedOverridePayload = (await allowedOverrideResponse.json()) as {
      ok: boolean;
      session: { personaId: string | null; metadata: string | null };
    };
    expect(allowedOverrideResponse.status).toBe(201);
    expect(allowedOverridePayload.session.personaId).toBe(overridePersona.id);
    expect(allowedOverridePayload.session.metadata).toContain('"personaResolution":"explicit_override"');
    expect(allowedOverridePayload.session.metadata).toContain('"modelHubProfileId":"team-b"');
  });
});
