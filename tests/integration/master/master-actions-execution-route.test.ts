import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

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
      getTestArtifactsRoot(),
      `master.actions.execute.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasDb = path.resolve(
      getTestArtifactsRoot(),
      `master.actions.personas.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasRoot = path.resolve(
      getTestArtifactsRoot(),
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
          stepId: 'step-tick',
          actionType: 'run.tick',
        }),
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(startResponse.status).toBe(200);
    const startPayload = (await startResponse.json()) as {
      ok: boolean;
      run: { status: string; resultBundle: string | null };
    };
    expect(startPayload.ok).toBe(true);
    expect(['COMPLETED', 'REFINING']).toContain(startPayload.run.status);
    expect(Boolean(startPayload.run.resultBundle)).toBe(true);

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
    const finalRunStatus = runPayload.run.status;
    expect(['COMPLETED', 'REFINING']).toContain(finalRunStatus);
    expect(Boolean(runPayload.run.resultBundle)).toBe(true);

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

  it('pauses run in awaiting approval when runtime requests shell approval', async () => {
    const prevApprovals = process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'true';
    try {
      const { getPersonaRepository } = await import('@/server/personas/personaRepository');
      const persona = getPersonaRepository().createPersona({
        userId: 'legacy-local-user',
        name: 'Master Approval Persona',
        emoji: 'A',
        vibe: 'strict',
      });

      const runsRoute = await import('../../../app/api/master/runs/route');
      const actionsRoute = await import('../../../app/api/master/runs/[id]/actions/route');

      const createResponse = await runsRoute.POST(
        new Request('http://localhost/api/master/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: 'Shell task',
            contract: 'Open terminal and run one shell command to inspect environment.',
            personaId: persona.id,
            workspaceId: 'w-approval',
          }),
        }),
      );
      expect(createResponse.status).toBe(201);
      const createPayload = (await createResponse.json()) as { run: { id: string } };
      const runId = createPayload.run.id;

      const tickResponse = await actionsRoute.POST(
        new Request(`http://localhost/api/master/runs/${runId}/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            personaId: persona.id,
            workspaceId: 'w-approval',
            stepId: 'step-tick',
            actionType: 'run.tick',
          }),
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      expect(tickResponse.status).toBe(200);
      const tickPayload = (await tickResponse.json()) as {
        ok: boolean;
        run: { status: string; pausedForApproval: boolean };
      };
      expect(tickPayload.ok).toBe(true);
      expect(tickPayload.run.status).toBe('AWAITING_APPROVAL');
      expect(tickPayload.run.pausedForApproval).toBe(true);
    } finally {
      if (prevApprovals === undefined) {
        delete process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
      } else {
        process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = prevApprovals;
      }
    }
  });
});
