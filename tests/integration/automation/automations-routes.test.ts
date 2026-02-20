import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AutomationGlobals = typeof globalThis & {
  __automationRepository?: unknown;
  __automationService?: unknown;
  __automationRuntime?: unknown;
};

function uniqueDbPath(name: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('automation routes', () => {
  const createdDbFiles: string[] = [];
  let previousRequireAuth: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';
    previousRequireAuth = process.env.REQUIRE_AUTH;
    delete process.env.REQUIRE_AUTH;
    const dbPath = uniqueDbPath('automation.routes');
    process.env.AUTOMATION_DB_PATH = dbPath;
    createdDbFiles.push(dbPath);

    (globalThis as AutomationGlobals).__automationRepository = undefined;
    (globalThis as AutomationGlobals).__automationService = undefined;
    (globalThis as AutomationGlobals).__automationRuntime = undefined;
  });

  afterEach(() => {
    (globalThis as AutomationGlobals).__automationRepository = undefined;
    (globalThis as AutomationGlobals).__automationService = undefined;
    (globalThis as AutomationGlobals).__automationRuntime = undefined;

    for (const dbFile of createdDbFiles.splice(0, createdDbFiles.length)) {
      if (fs.existsSync(dbFile)) {
        try {
          fs.unlinkSync(dbFile);
        } catch {
          // ignore transient lock
        }
      }
    }
    if (previousRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH;
    } else {
      process.env.REQUIRE_AUTH = previousRequireAuth;
    }
  });

  it('supports CRUD and manual run for automations', async () => {
    const automationsRoute = await import('../../../app/api/automations/route');
    const detailRoute = await import('../../../app/api/automations/[id]/route');
    const runRoute = await import('../../../app/api/automations/[id]/run/route');
    const runsRoute = await import('../../../app/api/automations/[id]/runs/route');

    const createResponse = await automationsRoute.POST(
      new Request('http://localhost/api/automations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Morning briefing',
          cronExpression: '0 10 * * *',
          timezone: 'UTC',
          prompt: 'Give me a morning briefing',
          enabled: true,
        }),
      }),
    );

    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { ok: boolean; rule: { id: string } };
    expect(created.ok).toBe(true);
    const ruleId = created.rule.id;

    const listResponse = await automationsRoute.GET();
    const listed = (await listResponse.json()) as { ok: boolean; rules: Array<{ id: string }> };
    expect(listed.ok).toBe(true);
    expect(listed.rules.some((rule) => rule.id === ruleId)).toBe(true);

    const patchResponse = await detailRoute.PATCH(
      new Request(`http://localhost/api/automations/${ruleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      { params: Promise.resolve({ id: ruleId }) },
    );
    const patched = (await patchResponse.json()) as { ok: boolean; rule: { enabled: boolean } };
    expect(patched.ok).toBe(true);
    expect(patched.rule.enabled).toBe(false);

    const runResponse = await runRoute.POST(
      new Request(`http://localhost/api/automations/${ruleId}/run`, { method: 'POST' }),
      { params: Promise.resolve({ id: ruleId }) },
    );
    const runPayload = (await runResponse.json()) as { ok: boolean; run: { ruleId: string } };
    expect(runPayload.ok).toBe(true);
    expect(runPayload.run.ruleId).toBe(ruleId);

    const runsResponse = await runsRoute.GET(
      new Request(`http://localhost/api/automations/${ruleId}/runs`),
      { params: Promise.resolve({ id: ruleId }) },
    );
    const runsPayload = (await runsResponse.json()) as { ok: boolean; runs: Array<{ id: string }> };
    expect(runsPayload.ok).toBe(true);
    expect(runsPayload.runs.length).toBeGreaterThan(0);

    const deleteResponse = await detailRoute.DELETE(
      new Request(`http://localhost/api/automations/${ruleId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: ruleId }) },
    );
    const deleted = (await deleteResponse.json()) as { ok: boolean };
    expect(deleted.ok).toBe(true);
  }, 15_000);

  it('returns 401 when REQUIRE_AUTH is true and no session exists', async () => {
    process.env.REQUIRE_AUTH = 'true';
    const automationsRoute = await import('../../../app/api/automations/route');
    const response = await automationsRoute.GET();

    expect(response.status).toBe(401);
  });

  it('keeps automation auth behavior independent of chat session flag', async () => {
    process.env.REQUIRE_AUTH = 'true';
    process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';
    const automationsRoute = await import('../../../app/api/automations/route');
    const responseWhenFlagOff = await automationsRoute.GET();

    process.env.CHAT_PERSISTENT_SESSION_V2 = 'true';
    const responseWhenFlagOn = await automationsRoute.GET();

    expect(responseWhenFlagOff.status).toBe(401);
    expect(responseWhenFlagOn.status).toBe(401);
  });

  it('bounds GET /api/automations and /api/automations/[id]/runs via safe limit parsing', async () => {
    const automationsRoute = await import('../../../app/api/automations/route');
    const runRoute = await import('../../../app/api/automations/[id]/run/route');
    const runsRoute = await import('../../../app/api/automations/[id]/runs/route');

    for (let index = 0; index < 4; index += 1) {
      const createResponse = await automationsRoute.POST(
        new Request('http://localhost/api/automations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: `Rule ${index + 1}`,
            cronExpression: '0 10 * * *',
            timezone: 'UTC',
            prompt: `Prompt ${index + 1}`,
            enabled: true,
          }),
        }),
      );
      expect(createResponse.status).toBe(200);
    }

    const listWithLimitResponse = await (
      automationsRoute.GET as (request: Request) => Promise<Response>
    )(new Request('http://localhost/api/automations?limit=2'));
    const listWithLimitPayload = (await listWithLimitResponse.json()) as {
      ok: boolean;
      rules: Array<{ id: string }>;
    };
    expect(listWithLimitPayload.ok).toBe(true);
    expect(listWithLimitPayload.rules).toHaveLength(2);

    const listWithInvalidLimitResponse = await (
      automationsRoute.GET as (request: Request) => Promise<Response>
    )(new Request('http://localhost/api/automations?limit=not-a-number'));
    const listWithInvalidLimitPayload = (await listWithInvalidLimitResponse.json()) as {
      ok: boolean;
      rules: Array<{ id: string }>;
    };
    expect(listWithInvalidLimitPayload.ok).toBe(true);
    expect(listWithInvalidLimitPayload.rules.length).toBeGreaterThanOrEqual(4);

    const createdRuleId = listWithInvalidLimitPayload.rules[0]?.id;
    expect(createdRuleId).toBeTruthy();
    const ruleId = String(createdRuleId);

    for (let index = 0; index < 4; index += 1) {
      const runResponse = await runRoute.POST(
        new Request(`http://localhost/api/automations/${ruleId}/run`, { method: 'POST' }),
        { params: Promise.resolve({ id: ruleId }) },
      );
      expect(runResponse.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const runsWithLimitResponse = await runsRoute.GET(
      new Request(`http://localhost/api/automations/${ruleId}/runs?limit=2`),
      { params: Promise.resolve({ id: ruleId }) },
    );
    const runsWithLimitPayload = (await runsWithLimitResponse.json()) as {
      ok: boolean;
      runs: Array<{ id: string }>;
    };
    expect(runsWithLimitPayload.ok).toBe(true);
    expect(runsWithLimitPayload.runs).toHaveLength(2);

    const runsWithInvalidLimitResponse = await runsRoute.GET(
      new Request(`http://localhost/api/automations/${ruleId}/runs?limit=not-a-number`),
      { params: Promise.resolve({ id: ruleId }) },
    );
    const runsWithInvalidLimitPayload = (await runsWithInvalidLimitResponse.json()) as {
      ok: boolean;
      runs: Array<{ id: string }>;
    };
    expect(runsWithInvalidLimitPayload.ok).toBe(true);
    expect(runsWithInvalidLimitPayload.runs.length).toBeGreaterThanOrEqual(4);
  });

  it('returns automation metrics and lease state from GET /api/automations/metrics', async () => {
    const runtime = await import('../../../src/server/automation/runtime');
    const automationsRoute = await import('../../../app/api/automations/route');
    const runRoute = await import('../../../app/api/automations/[id]/run/route');
    const metricsRoute = await import('../../../app/api/automations/metrics/route');

    const createResponse = await automationsRoute.POST(
      new Request('http://localhost/api/automations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Metrics rule',
          cronExpression: '0 10 * * *',
          timezone: 'UTC',
          prompt: 'Metrics prompt',
          enabled: true,
        }),
      }),
    );
    const created = (await createResponse.json()) as { ok: boolean; rule: { id: string } };
    expect(created.ok).toBe(true);

    const runResponse = await runRoute.POST(
      new Request(`http://localhost/api/automations/${created.rule.id}/run`, { method: 'POST' }),
      { params: Promise.resolve({ id: created.rule.id }) },
    );
    expect(runResponse.status).toBe(200);

    const leaseAcquired = runtime
      .getAutomationService()
      .acquireLease('metrics-test-instance', 30_000);
    expect(leaseAcquired).toBe(true);

    const metricsResponse = await metricsRoute.GET();
    expect(metricsResponse.status).toBe(200);
    const metricsPayload = (await metricsResponse.json()) as {
      ok: boolean;
      metrics: {
        activeRules: number;
        queuedRuns: number;
        runningRuns: number;
        deadLetterRuns: number;
        leaseAgeSeconds: number | null;
      };
      leaseState: { instanceId: string } | null;
    };

    expect(metricsPayload.ok).toBe(true);
    expect(metricsPayload.metrics.activeRules).toBeGreaterThanOrEqual(1);
    expect(metricsPayload.metrics.queuedRuns).toBeGreaterThanOrEqual(1);
    expect(typeof metricsPayload.metrics.runningRuns).toBe('number');
    expect(typeof metricsPayload.metrics.deadLetterRuns).toBe('number');
    expect(metricsPayload.leaseState?.instanceId).toBe('metrics-test-instance');
  });

  it('returns 401 for GET /api/automations/metrics when auth is required and session is missing', async () => {
    process.env.REQUIRE_AUTH = 'true';
    const metricsRoute = await import('../../../app/api/automations/metrics/route');
    const response = await metricsRoute.GET();
    expect(response.status).toBe(401);
  });
});
