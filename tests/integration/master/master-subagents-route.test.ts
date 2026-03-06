import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('master subagents routes', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.MASTER_DB_PATH;
    delete process.env.PERSONAS_DB_PATH;
    delete process.env.PERSONAS_ROOT_PATH;

    try {
      const runtime = await import('@/server/master/runtime');
      runtime.resetMasterRepositoryForTests();
    } catch {
      // ignore cleanup if runtime was not imported
    }

    for (const target of cleanupPaths.splice(0, cleanupPaths.length)) {
      if (!fs.existsSync(target)) continue;
      try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.rmSync(target, { force: true });
      } catch {
        // ignore transient sqlite locks on windows
      }
    }
  });

  it('lists subagent sessions, returns paired detail, and cancels a session', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.MASTER_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.subagents.${suffix}.db`,
    );
    process.env.PERSONAS_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.subagents.personas.${suffix}.db`,
    );
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.subagents.personas.root.${suffix}`,
    );
    cleanupPaths.push(
      String(process.env.MASTER_DB_PATH),
      String(process.env.PERSONAS_DB_PATH),
      String(process.env.PERSONAS_ROOT_PATH),
    );

    mockUserContext({ userId: 'legacy-local-user', authenticated: true });

    const runsRoute = await import('../../../app/api/master/runs/route');
    const subagentsRoute = await import('../../../app/api/master/subagents/route');
    const sessionRoute = await import('../../../app/api/master/subagents/[id]/route');
    const { getMasterRepository } = await import('@/server/master/runtime');
    const { resolveMasterWorkspaceScope } = await import('@/server/master/workspaceScope');
    const { createSubagentSessionForDispatch } =
      await import('@/server/master/delegation/sessionService');

    const workspaceId = 'w-subagents-routes';
    const createRunResponse = await runsRoute.POST(
      new Request('http://localhost/api/master/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Subagent route run',
          contract: 'show sessions',
          workspaceId,
        }),
      }),
    );
    expect(createRunResponse.status).toBe(201);
    const createRunPayload = (await createRunResponse.json()) as { run: { id: string } };
    const runId = createRunPayload.run.id;

    const scope = resolveMasterWorkspaceScope({
      userId: 'legacy-local-user',
      workspaceId,
    });
    const repo = getMasterRepository();
    const session = createSubagentSessionForDispatch(repo, scope, {
      runId,
      capability: 'web_search',
      payload: '{"q":"subagents"}',
      assignedTools: ['read', 'web_search'],
    });
    const job = repo.createDelegationJob(scope, {
      runId,
      capability: 'web_search',
      payload: '{"q":"subagents"}',
      status: 'queued',
      priority: 'medium',
      maxAttempts: 3,
      timeoutMs: 90_000,
    });
    repo.appendDelegationEvent(scope, {
      runId,
      jobId: job.id,
      type: 'started',
      payload: JSON.stringify({ stage: 'running' }),
    });

    const listResponse = await subagentsRoute.GET(
      new Request(
        `http://localhost/api/master/subagents?workspaceId=${workspaceId}&runId=${runId}`,
      ),
    );
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as {
      ok: boolean;
      sessions: Array<{ id: string; runId: string }>;
    };
    expect(listPayload.ok).toBe(true);
    expect(listPayload.sessions).toHaveLength(1);
    expect(listPayload.sessions[0]?.id).toBe(session.id);

    const detailResponse = await sessionRoute.GET(
      new Request(`http://localhost/api/master/subagents/${session.id}?workspaceId=${workspaceId}`),
      { params: Promise.resolve({ id: session.id }) },
    );
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      ok: boolean;
      session: { id: string };
      job: { id: string } | null;
      events: Array<{ type: string }>;
    };
    expect(detailPayload.job?.id).toBe(job.id);
    expect(detailPayload.events.map((event) => event.type)).toEqual(['started']);

    const cancelResponse = await sessionRoute.PATCH(
      new Request(`http://localhost/api/master/subagents/${session.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          action: 'cancel',
          reason: 'operator_cancelled',
        }),
      }),
      { params: Promise.resolve({ id: session.id }) },
    );
    expect(cancelResponse.status).toBe(200);
    const cancelPayload = (await cancelResponse.json()) as {
      ok: boolean;
      session: { status: string; lastError: string | null };
    };
    expect(cancelPayload.session.status).toBe('cancelled');
    expect(cancelPayload.session.lastError).toBe('operator_cancelled');
  });
});
