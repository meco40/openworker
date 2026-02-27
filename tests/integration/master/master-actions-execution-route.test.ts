import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MasterGlobals = typeof globalThis & {
  __masterRepository?: unknown;
  __masterOrchestrator?: unknown;
};

describe('master run execution actions route', () => {
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
      `master.actions.execute.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasDb = path.resolve(
      '.local',
      `master.actions.personas.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasRoot = path.resolve(
      '.local',
      `master.actions.personas.root.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );

    process.env.MASTER_DB_PATH = masterDb;
    process.env.PERSONAS_DB_PATH = personasDb;
    process.env.PERSONAS_ROOT_PATH = personasRoot;
    cleanupPaths.push(masterDb, personasDb, personasRoot);

    (globalThis as MasterGlobals).__masterRepository = undefined;
    (globalThis as MasterGlobals).__masterOrchestrator = undefined;
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
      // ignore if runtime not loaded
    }
    (globalThis as MasterGlobals).__masterRepository = undefined;
    (globalThis as MasterGlobals).__masterOrchestrator = undefined;

    for (const target of cleanupPaths.splice(0, cleanupPaths.length)) {
      if (!fs.existsSync(target)) continue;
      try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.unlinkSync(target);
      } catch {
        // ignore transient sqlite locks on windows
      }
    }
  });

  it('starts autonomous execution and exports result bundle', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const persona = getPersonaRepository().createPersona({
      userId: 'legacy-local-user',
      name: 'Master Execute Persona',
      emoji: 'X',
      vibe: 'strict',
    });

    const runsRoute = await import('../../../app/api/master/runs/route');
    const runRoute = await import('../../../app/api/master/runs/[id]/route');
    const actionsRoute = await import('../../../app/api/master/runs/[id]/actions/route');

    const createResponse = await runsRoute.POST(
      new Request('http://localhost/api/master/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Autonomous task',
          contract: 'Research current TypeScript release notes and summarize key points.',
          personaId: persona.id,
          workspaceId: 'w-exec',
        }),
      }),
    );
    expect(createResponse.status).toBe(201);
    const createPayload = (await createResponse.json()) as { run: { id: string } };
    const runId = createPayload.run.id;

    const startResponse = await actionsRoute.POST(
      new Request(`http://localhost/api/master/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w-exec',
          stepId: 'step-start',
          actionType: 'run.start',
        }),
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(startResponse.status).toBe(200);
    const startPayload = (await startResponse.json()) as { ok: boolean; run: { status: string } };
    expect(startPayload.ok).toBe(true);
    expect(startPayload.run.status === 'PLANNING' || startPayload.run.status === 'DELEGATING').toBe(
      true,
    );

    let settled = false;
    let finalRunStatus = '';
    for (let index = 0; index < 30; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const runResponse = await runRoute.GET(
        new Request(
          `http://localhost/api/master/runs/${runId}?personaId=${encodeURIComponent(persona.id)}&workspaceId=w-exec`,
        ),
        { params: Promise.resolve({ id: runId }) },
      );
      expect(runResponse.status).toBe(200);
      const runPayload = (await runResponse.json()) as {
        ok: boolean;
        run: { status: string; resultBundle: string | null };
      };
      finalRunStatus = runPayload.run.status;
      if (runPayload.run.status === 'COMPLETED' && runPayload.run.resultBundle) {
        settled = true;
        break;
      }
      if (runPayload.run.status === 'FAILED') {
        break;
      }
    }

    expect(settled).toBe(true);

    const exportResponse = await actionsRoute.POST(
      new Request(`http://localhost/api/master/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: persona.id,
          workspaceId: 'w-exec',
          stepId: 'step-export',
          actionType: 'run.export',
        }),
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(exportResponse.status).toBe(200);
    const exportPayload = (await exportResponse.json()) as {
      ok: boolean;
      exportBundle: { runId: string; status: string; steps: unknown[] };
    };
    expect(exportPayload.ok).toBe(true);
    expect(exportPayload.exportBundle.runId).toBe(runId);
    expect(exportPayload.exportBundle.status).toBe(finalRunStatus);
    expect(exportPayload.exportBundle.steps.length).toBeGreaterThan(0);
  });
});
