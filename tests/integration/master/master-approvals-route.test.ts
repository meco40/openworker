import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('master approvals routes', () => {
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

  it('lists pending approval requests and applies a decision through the dedicated route', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.MASTER_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.approvals.${suffix}.db`,
    );
    process.env.PERSONAS_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.approvals.personas.${suffix}.db`,
    );
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.approvals.personas.root.${suffix}`,
    );
    cleanupPaths.push(
      String(process.env.MASTER_DB_PATH),
      String(process.env.PERSONAS_DB_PATH),
      String(process.env.PERSONAS_ROOT_PATH),
    );

    mockUserContext({ userId: 'legacy-local-user', authenticated: true });
    const runsRoute = await import('../../../app/api/master/runs/route');
    const actionsRoute = await import('../../../app/api/master/runs/[id]/actions/route');
    const approvalsRoute = await import('../../../app/api/master/approvals/route');
    const decisionRoute = await import('../../../app/api/master/approvals/[id]/decision/route');
    const scope = { workspaceId: 'w-approval-routes' };
    const createRunResponse = await runsRoute.POST(
      new Request('http://localhost/api/master/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Approval route run',
          contract: 'needs approval',
          workspaceId: scope.workspaceId,
        }),
      }),
    );
    expect(createRunResponse.status).toBe(201);
    const createRunPayload = (await createRunResponse.json()) as { run: { id: string } };
    const runId = createRunPayload.run.id;

    const requestResponse = await actionsRoute.POST(
      new Request(`http://localhost/api/master/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: scope.workspaceId,
          stepId: 'step-approval',
          actionType: 'shell.exec',
          fingerprint: 'shell.exec:D:/web/clawtest',
        }),
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(requestResponse.status).toBe(202);
    const requestPayload = (await requestResponse.json()) as {
      approvalRequired: boolean;
      approvalRequestId: string;
    };
    expect(requestPayload.approvalRequired).toBe(true);

    const listResponse = await approvalsRoute.GET(
      new Request(`http://localhost/api/master/approvals?workspaceId=${scope.workspaceId}`),
    );
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as {
      ok: boolean;
      approvalRequests: Array<{ id: string; status: string }>;
    };
    expect(listPayload.approvalRequests).toHaveLength(1);
    expect(listPayload.approvalRequests[0]?.id).toBe(requestPayload.approvalRequestId);

    const decisionResponse = await decisionRoute.POST(
      new Request(
        `http://localhost/api/master/approvals/${requestPayload.approvalRequestId}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: scope.workspaceId,
            decision: 'approve_once',
          }),
        },
      ),
      { params: Promise.resolve({ id: requestPayload.approvalRequestId }) },
    );
    expect(decisionResponse.status).toBe(200);
    const decisionPayload = (await decisionResponse.json()) as {
      ok: boolean;
      approvalRequest: { status: string; decision: string | null };
    };
    expect(decisionPayload.approvalRequest.status).toBe('approved');
    expect(decisionPayload.approvalRequest.decision).toBe('approve_once');
  });
});
