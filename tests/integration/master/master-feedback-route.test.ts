import { getTestArtifactsRoot } from '../../helpers/testArtifacts';
/**
 * Integration test: POST /api/master/runs/[id]/feedback
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MasterGlobals = typeof globalThis & {
  __masterRepository?: unknown;
};

describe('master feedback route', () => {
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
      `master.feedback.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasDb = path.resolve(
      getTestArtifactsRoot(),
      `master.feedback.personas.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasRoot = path.resolve(
      getTestArtifactsRoot(),
      `master.feedback.root.${Date.now()}.${Math.random().toString(36).slice(2)}`,
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
      // ignore if not imported
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

  it('rejects feedback on a non-completed run', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const persona = getPersonaRepository().createPersona({
      userId: 'legacy-local-user',
      name: 'Feedback Persona',
      emoji: 'F',
      vibe: 'strict',
    });

    const runsRoute = await import('../../../app/api/master/runs/route');
    const feedbackRoute = await import('../../../app/api/master/runs/[id]/feedback/route');

    // Create a run (starts in ANALYZING state)
    const createRes = await runsRoute.POST(
      new Request('http://localhost/api/master/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Feedback Test',
          contract: 'run something',
          personaId: persona.id,
          workspaceId: 'w1',
        }),
      }),
    );
    const createPayload = (await createRes.json()) as { ok: boolean; run: { id: string } };
    expect(createPayload.ok).toBe(true);
    const runId = createPayload.run.id;

    // Attempt feedback on non-completed run → 422
    const feedbackRes = await feedbackRoute.POST(
      new Request(
        `http://localhost/api/master/runs/${runId}/feedback?personaId=${persona.id}&workspaceId=w1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            rating: 4,
            policy: 'balanced',
            comment: 'Good job',
          }),
        },
      ),
      { params: Promise.resolve({ id: runId }) },
    );

    expect(feedbackRes.status).toBe(422);
    const payload = (await feedbackRes.json()) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/completed/i);
  });

  it('accepts feedback on a completed run', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const persona = getPersonaRepository().createPersona({
      userId: 'legacy-local-user',
      name: 'Feedback Persona 2',
      emoji: 'G',
      vibe: 'strict',
    });

    const runsRoute = await import('../../../app/api/master/runs/route');
    const feedbackRoute = await import('../../../app/api/master/runs/[id]/feedback/route');
    const { getMasterRepository } = await import('@/server/master/runtime');
    const { resolveMasterWorkspaceScope } = await import('@/server/master/workspaceScope');

    // Create a run
    const createRes = await runsRoute.POST(
      new Request('http://localhost/api/master/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Feedback Test 2',
          contract: 'run something else',
          personaId: persona.id,
          workspaceId: 'w1',
        }),
      }),
    );
    const createPayload = (await createRes.json()) as { ok: boolean; run: { id: string } };
    expect(createPayload.ok).toBe(true);
    const runId = createPayload.run.id;

    // Force run to COMPLETED status directly in repo
    const repo = getMasterRepository();
    const scope = resolveMasterWorkspaceScope({
      userId: 'legacy-local-user',
      personaId: persona.id,
      workspaceId: 'w1',
    });
    repo.updateRun(scope, runId, { status: 'COMPLETED', progress: 100 });

    // Submit feedback
    const feedbackRes = await feedbackRoute.POST(
      new Request(
        `http://localhost/api/master/runs/${runId}/feedback?personaId=${persona.id}&workspaceId=w1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            rating: 5,
            policy: 'safe',
            comment: 'Excellent!',
          }),
        },
      ),
      { params: Promise.resolve({ id: runId }) },
    );

    expect(feedbackRes.status).toBe(200);
    const payload = (await feedbackRes.json()) as {
      ok: boolean;
      feedback: { rating: number; policy: string; comment: string | null };
    };
    expect(payload.ok).toBe(true);
    expect(payload.feedback.rating).toBe(5);
    expect(payload.feedback.policy).toBe('safe');
    expect(payload.feedback.comment).toBe('Excellent!');
  });

  it('rejects invalid rating', async () => {
    const feedbackRoute = await import('../../../app/api/master/runs/[id]/feedback/route');

    const feedbackRes = await feedbackRoute.POST(
      new Request('http://localhost/api/master/runs/fake-id/feedback?personaId=p1&workspaceId=w1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rating: 6,
          policy: 'balanced',
        }),
      }),
      { params: Promise.resolve({ id: 'fake-id' }) },
    );

    expect(feedbackRes.status).toBe(400);
    const payload = (await feedbackRes.json()) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/rating/i);
  });
});
