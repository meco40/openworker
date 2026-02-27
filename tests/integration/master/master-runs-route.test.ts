import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MasterGlobals = typeof globalThis & {
  __masterRepository?: unknown;
};

describe('master routes', () => {
  const cleanupPaths: string[] = [];
  let prevMasterDb: string | undefined;
  let prevPersonasDb: string | undefined;
  let prevPersonasRoot: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    prevMasterDb = process.env.MASTER_DB_PATH;
    prevPersonasDb = process.env.PERSONAS_DB_PATH;
    prevPersonasRoot = process.env.PERSONAS_ROOT_PATH;

    const masterDb = path.resolve(
      '.local',
      `master.route.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasDb = path.resolve(
      '.local',
      `master.personas.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasRoot = path.resolve(
      '.local',
      `master.personas.root.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );

    process.env.MASTER_DB_PATH = masterDb;
    process.env.PERSONAS_DB_PATH = personasDb;
    process.env.PERSONAS_ROOT_PATH = personasRoot;
    cleanupPaths.push(masterDb, personasDb, personasRoot);

    (globalThis as MasterGlobals).__masterRepository = undefined;
  });

  afterEach(async () => {
    if (prevMasterDb === undefined) delete process.env.MASTER_DB_PATH;
    else process.env.MASTER_DB_PATH = prevMasterDb;
    if (prevPersonasDb === undefined) delete process.env.PERSONAS_DB_PATH;
    else process.env.PERSONAS_DB_PATH = prevPersonasDb;
    if (prevPersonasRoot === undefined) delete process.env.PERSONAS_ROOT_PATH;
    else process.env.PERSONAS_ROOT_PATH = prevPersonasRoot;

    try {
      const runtime = await import('@/server/master/runtime');
      runtime.resetMasterRepositoryForTests();
    } catch {
      // ignore if runtime was not imported in current test
    }
    (globalThis as MasterGlobals).__masterRepository = undefined;

    for (const target of cleanupPaths.splice(0, cleanupPaths.length)) {
      if (!fs.existsSync(target)) continue;
      try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.unlinkSync(target);
      } catch {
        // ignore transient sqlite locks on Windows
      }
    }
  });

  it('supports run/action/delegation and notes/reminders workflows', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const persona = getPersonaRepository().createPersona({
      userId: 'legacy-local-user',
      name: 'Master Persona',
      emoji: 'M',
      vibe: 'strict',
    });

    const runsRoute = await import('../../../app/api/master/runs/route');
    const runRoute = await import('../../../app/api/master/runs/[id]/route');
    const actionsRoute = await import('../../../app/api/master/runs/[id]/actions/route');
    const delegationsRoute = await import('../../../app/api/master/runs/[id]/delegations/route');
    const notesRoute = await import('../../../app/api/master/notes/route');
    const remindersRoute = await import('../../../app/api/master/reminders/route');

    const createResponse = await runsRoute.POST(
      new Request('http://localhost/api/master/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Master contract',
          contract: 'deliver validated output',
          personaId: persona.id,
          workspaceId: 'w1',
        }),
      }),
    );
    expect(createResponse.status).toBe(201);
    const createPayload = (await createResponse.json()) as { ok: boolean; run: { id: string } };
    expect(createPayload.ok).toBe(true);
    const runId = createPayload.run.id;

    const listResponse = await runsRoute.GET(
      new Request(
        `http://localhost/api/master/runs?personaId=${encodeURIComponent(persona.id)}&workspaceId=w1`,
      ),
    );
    const listPayload = (await listResponse.json()) as { ok: boolean; runs: Array<{ id: string }> };
    expect(listPayload.ok).toBe(true);
    expect(listPayload.runs.some((run) => run.id === runId)).toBe(true);

    const getRunResponse = await runRoute.GET(
      new Request(
        `http://localhost/api/master/runs/${runId}?personaId=${encodeURIComponent(persona.id)}&workspaceId=w1`,
      ),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(getRunResponse.status).toBe(200);

    const approveRequiredResponse = await actionsRoute.POST(
      new Request(`http://localhost/api/master/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w1',
          stepId: 'step-1',
          actionType: 'gmail.send',
        }),
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(approveRequiredResponse.status).toBe(202);
    const approveRequiredPayload = (await approveRequiredResponse.json()) as {
      approvalRequired: boolean;
    };
    expect(approveRequiredPayload.approvalRequired).toBe(true);

    const approveAlwaysResponse = await actionsRoute.POST(
      new Request(`http://localhost/api/master/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w1',
          stepId: 'step-1',
          actionType: 'gmail.send',
          fingerprint: 'mail:f1',
          decision: 'approve_always',
        }),
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(approveAlwaysResponse.status).toBe(200);

    const delegatedResponse = await delegationsRoute.POST(
      new Request(`http://localhost/api/master/runs/${runId}/delegations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w1',
          capability: 'web_search',
          payload: '{"q":"latest docs"}',
        }),
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(delegatedResponse.status).toBe(201);

    const delegationsGetResponse = await delegationsRoute.GET(
      new Request(
        `http://localhost/api/master/runs/${runId}/delegations?personaId=${encodeURIComponent(persona.id)}&workspaceId=w1`,
      ),
      { params: Promise.resolve({ id: runId }) },
    );
    const delegationPayload = (await delegationsGetResponse.json()) as {
      ok: boolean;
      jobs: unknown[];
      events: unknown[];
    };
    expect(delegationPayload.ok).toBe(true);
    expect(delegationPayload.jobs.length).toBeGreaterThan(0);
    expect(delegationPayload.events.length).toBeGreaterThan(0);

    const noteCreateResponse = await notesRoute.POST(
      new Request('http://localhost/api/master/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w1',
          title: 'n1',
          content: 'c1',
          tags: ['a'],
        }),
      }),
    );
    expect(noteCreateResponse.status).toBe(201);

    const reminderCreateResponse = await remindersRoute.POST(
      new Request('http://localhost/api/master/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w1',
          title: 'r1',
          message: 'm1',
          remindAt: new Date().toISOString(),
        }),
      }),
    );
    expect(reminderCreateResponse.status).toBe(201);
  });

  it('blocks cross-workspace access for same persona', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const persona = getPersonaRepository().createPersona({
      userId: 'legacy-local-user',
      name: 'Isolation Persona',
      emoji: 'I',
      vibe: 'strict',
    });

    const runsRoute = await import('../../../app/api/master/runs/route');
    const runRoute = await import('../../../app/api/master/runs/[id]/route');

    const createResponse = await runsRoute.POST(
      new Request('http://localhost/api/master/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Scoped run',
          contract: 'do work',
          personaId: persona.id,
          workspaceId: 'alpha',
        }),
      }),
    );
    const createPayload = (await createResponse.json()) as { run: { id: string } };
    const runId = createPayload.run.id;

    const crossScopeResponse = await runRoute.GET(
      new Request(
        `http://localhost/api/master/runs/${runId}?personaId=${encodeURIComponent(persona.id)}&workspaceId=beta`,
      ),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(crossScopeResponse.status).toBe(404);
  });
});
