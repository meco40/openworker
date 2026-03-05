import { expect, test } from '@playwright/test';

test('mission-control run create/start/feedback flow is executable', async ({ page, request }) => {
  await page.goto('/');

  const createResponse = await request.post('/api/master/runs', {
    data: {
      title: 'Harness Mission Control Run',
      contract: 'Create one concise execution summary.',
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
      },
    },
  );
  expect(startResponse.status()).toBe(200);

  const patchResponse = await request.patch(`/api/master/runs/${encodeURIComponent(runId)}`, {
    data: {
      status: 'COMPLETED',
      verificationPassed: true,
    },
  });
  expect(patchResponse.status()).toBe(200);

  const feedbackResponse = await request.post(
    `/api/master/runs/${encodeURIComponent(runId)}/feedback`,
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
