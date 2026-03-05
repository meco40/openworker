import { expect, test, type APIRequestContext } from '@playwright/test';

async function ensureMasterScope(request: APIRequestContext): Promise<{
  personaId: string;
  workspaceId: string;
}> {
  const personasResponse = await request.get('/api/personas');
  expect(personasResponse.status()).toBe(200);
  const personasPayload = (await personasResponse.json()) as {
    ok?: boolean;
    personas?: Array<{ id?: string }>;
  };
  expect(personasPayload.ok).toBe(true);

  let personaId = String(personasPayload.personas?.[0]?.id || '');
  if (!personaId) {
    const createPersonaResponse = await request.post('/api/personas', {
      data: {
        name: `Harness Persona ${Date.now()}`,
        vibe: 'Mission-control harness persona',
      },
    });
    expect(createPersonaResponse.status()).toBe(201);
    const createdPersonaPayload = (await createPersonaResponse.json()) as {
      ok?: boolean;
      persona?: { id?: string };
    };
    expect(createdPersonaPayload.ok).toBe(true);
    personaId = String(createdPersonaPayload.persona?.id || '');
  }
  expect(personaId.length).toBeGreaterThan(0);

  const workspacesResponse = await request.get('/api/workspaces');
  expect(workspacesResponse.status()).toBe(200);
  const workspacesPayload = (await workspacesResponse.json()) as Array<{ id?: string }>;
  const workspaceId = String(workspacesPayload?.[0]?.id || 'default');
  expect(workspaceId.length).toBeGreaterThan(0);

  return { personaId, workspaceId };
}

async function markRunCompleted(
  request: APIRequestContext,
  runId: string,
  scope: { personaId: string; workspaceId: string },
  page: { waitForTimeout: (timeout: number) => Promise<void> },
): Promise<void> {
  let lastStatus = -1;
  let lastError = '';

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const patchResponse = await request.patch(`/api/master/runs/${encodeURIComponent(runId)}`, {
      data: {
        status: 'COMPLETED',
        verificationPassed: true,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
      },
    });
    lastStatus = patchResponse.status();

    const payload = (await patchResponse.json().catch(() => ({}))) as { error?: string };
    lastError = String(payload.error || '');

    if (lastStatus === 200) {
      return;
    }
    if (lastStatus === 404) {
      break;
    }

    // run.start executes asynchronously and can contend with immediate PATCH updates.
    await page.waitForTimeout(250);
  }

  throw new Error(`Failed to PATCH run as COMPLETED (status=${lastStatus}, error="${lastError}")`);
}

test('mission-control run create/start/feedback flow is executable', async ({ page, request }) => {
  await page.goto('/');
  const scope = await ensureMasterScope(request);

  const createResponse = await request.post('/api/master/runs', {
    data: {
      title: 'Harness Mission Control Run',
      contract: 'Create one concise execution summary.',
      personaId: scope.personaId,
      workspaceId: scope.workspaceId,
    },
  });
  expect(createResponse.status()).toBe(201);
  const createPayload = (await createResponse.json()) as {
    ok: boolean;
    run?: { id?: string };
  };
  expect(createPayload.ok).toBe(true);
  const runId = String(createPayload.run?.id || '');
  expect(runId.length).toBeGreaterThan(0);

  const startResponse = await request.post(
    `/api/master/runs/${encodeURIComponent(runId)}/actions`,
    {
      data: {
        actionType: 'run.start',
        stepId: 'harness-manual-start',
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
      },
    },
  );
  expect(startResponse.status()).toBe(200);

  await markRunCompleted(request, runId, scope, page);

  const feedbackParams = new URLSearchParams({
    personaId: scope.personaId,
    workspaceId: scope.workspaceId,
  });
  const feedbackResponse = await request.post(
    `/api/master/runs/${encodeURIComponent(runId)}/feedback?${feedbackParams.toString()}`,
    {
      data: {
        rating: 5,
        policy: 'balanced',
        comment: 'Harness verification passed',
      },
    },
  );
  expect(feedbackResponse.status()).toBe(200);
  const feedbackPayload = (await feedbackResponse.json()) as { ok: boolean };
  expect(feedbackPayload.ok).toBe(true);
});
