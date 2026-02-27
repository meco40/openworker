import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MasterGlobals = typeof globalThis & {
  __masterRepository?: unknown;
};

describe('master metrics route', () => {
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
      `master.metrics.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasDb = path.resolve(
      '.local',
      `master.metrics.personas.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const personasRoot = path.resolve(
      '.local',
      `master.metrics.personas.root.${Date.now()}.${Math.random().toString(36).slice(2)}`,
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
      // ignore
    }
    (globalThis as MasterGlobals).__masterRepository = undefined;

    for (const target of cleanupPaths.splice(0, cleanupPaths.length)) {
      if (!fs.existsSync(target)) continue;
      try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.unlinkSync(target);
      } catch {
        // ignore transient locks
      }
    }
  });

  it('returns observability metrics payload with required keys', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const persona = getPersonaRepository().createPersona({
      userId: 'legacy-local-user',
      name: 'Master Metrics Persona',
      emoji: 'M',
      vibe: 'strict',
    });

    const runsRoute = await import('../../../app/api/master/runs/route');
    const metricsRoute = await import('../../../app/api/master/metrics/route');

    const createResponse = await runsRoute.POST(
      new Request('http://localhost/api/master/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Metrics run',
          contract: 'Generate one verifiable output.',
          personaId: persona.id,
          workspaceId: 'metrics-ws',
        }),
      }),
    );
    expect(createResponse.status).toBe(201);

    const metricsResponse = await metricsRoute.GET(
      new Request(
        `http://localhost/api/master/metrics?personaId=${encodeURIComponent(persona.id)}&workspaceId=metrics-ws`,
      ),
    );
    expect(metricsResponse.status).toBe(200);
    const payload = (await metricsResponse.json()) as {
      ok: boolean;
      metrics: Record<string, unknown>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.metrics).toHaveProperty('run_completion_rate');
    expect(payload.metrics).toHaveProperty('verify_pass_rate');
    expect(payload.metrics).toHaveProperty('delegation_success_rate');
    expect(payload.metrics).toHaveProperty('duplicate_side_effect_rate');
    expect(payload.metrics).toHaveProperty('generated_at');
  });
});
