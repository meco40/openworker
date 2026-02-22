import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupSqliteArtifacts } from '../../helpers/sqliteTestArtifacts';

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

describe('GET /api/health/scheduler', () => {
  const createdDbFiles: string[] = [];
  let previousLeaseTtl: string | undefined;
  let previousTickInterval: string | undefined;
  let previousStaleAfter: string | undefined;
  let previousHealthToken: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousLeaseTtl = process.env.AUTOMATION_LEASE_TTL_MS;
    previousTickInterval = process.env.AUTOMATION_TICK_INTERVAL_MS;
    previousStaleAfter = process.env.SCHEDULER_HEALTH_STALE_AFTER_MS;
    previousHealthToken = process.env.SCHEDULER_HEALTH_TOKEN;

    delete process.env.SCHEDULER_HEALTH_TOKEN;
    delete process.env.SCHEDULER_HEALTH_STALE_AFTER_MS;
    process.env.AUTOMATION_LEASE_TTL_MS = '30000';
    process.env.AUTOMATION_TICK_INTERVAL_MS = '15000';

    const dbPath = uniqueDbPath('scheduler-health');
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
      cleanupSqliteArtifacts(dbFile);
    }

    if (previousLeaseTtl === undefined) {
      delete process.env.AUTOMATION_LEASE_TTL_MS;
    } else {
      process.env.AUTOMATION_LEASE_TTL_MS = previousLeaseTtl;
    }

    if (previousTickInterval === undefined) {
      delete process.env.AUTOMATION_TICK_INTERVAL_MS;
    } else {
      process.env.AUTOMATION_TICK_INTERVAL_MS = previousTickInterval;
    }

    if (previousStaleAfter === undefined) {
      delete process.env.SCHEDULER_HEALTH_STALE_AFTER_MS;
    } else {
      process.env.SCHEDULER_HEALTH_STALE_AFTER_MS = previousStaleAfter;
    }

    if (previousHealthToken === undefined) {
      delete process.env.SCHEDULER_HEALTH_TOKEN;
    } else {
      process.env.SCHEDULER_HEALTH_TOKEN = previousHealthToken;
    }
  });

  it('returns 503 when no scheduler lease heartbeat exists', async () => {
    const { GET } = await import('../../../app/api/health/scheduler/route');

    const response = await GET(new Request('http://localhost/api/health/scheduler'));
    const payload = (await response.json()) as {
      ok: boolean;
      healthy: boolean;
      scheduler: { heartbeatAt: string | null; instanceId: string | null };
    };

    expect(response.status).toBe(503);
    expect(payload.ok).toBe(false);
    expect(payload.healthy).toBe(false);
    expect(payload.scheduler.heartbeatAt).toBeNull();
    expect(payload.scheduler.instanceId).toBeNull();
  });

  it('returns 200 and lease heartbeat details when scheduler heartbeat is fresh', async () => {
    const runtime = await import('../../../src/server/automation/runtime');
    runtime.getAutomationService().acquireLease('scheduler-fresh', 30_000);

    const { GET } = await import('../../../app/api/health/scheduler/route');
    const response = await GET(new Request('http://localhost/api/health/scheduler'));
    const payload = (await response.json()) as {
      ok: boolean;
      healthy: boolean;
      scheduler: {
        instanceId: string | null;
        heartbeatAt: string | null;
        ageMs: number | null;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.healthy).toBe(true);
    expect(payload.scheduler.instanceId).toBe('scheduler-fresh');
    expect(payload.scheduler.heartbeatAt).toBeTruthy();
    expect(payload.scheduler.ageMs).not.toBeNull();
    expect(Number(payload.scheduler.ageMs)).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 when lease heartbeat is stale', async () => {
    process.env.SCHEDULER_HEALTH_STALE_AFTER_MS = '10000';
    const runtime = await import('../../../src/server/automation/runtime');
    runtime
      .getAutomationService()
      .acquireLease('scheduler-stale', 30_000, '2026-01-01T00:00:00.000Z');

    const { GET } = await import('../../../app/api/health/scheduler/route');
    const response = await GET(new Request('http://localhost/api/health/scheduler'));
    const payload = (await response.json()) as {
      ok: boolean;
      healthy: boolean;
      scheduler: { instanceId: string | null; ageMs: number | null };
    };

    expect(response.status).toBe(503);
    expect(payload.ok).toBe(false);
    expect(payload.healthy).toBe(false);
    expect(payload.scheduler.instanceId).toBe('scheduler-stale');
    expect(Number(payload.scheduler.ageMs)).toBeGreaterThan(10000);
  });

  it('supports optional token protection for scheduler health endpoint', async () => {
    process.env.SCHEDULER_HEALTH_TOKEN = 'top-secret-token';
    const runtime = await import('../../../src/server/automation/runtime');
    runtime.getAutomationService().acquireLease('scheduler-secure', 30_000);

    const { GET } = await import('../../../app/api/health/scheduler/route');

    const unauthorizedResponse = await GET(new Request('http://localhost/api/health/scheduler'));
    expect(unauthorizedResponse.status).toBe(401);

    const authorizedResponse = await GET(
      new Request('http://localhost/api/health/scheduler', {
        headers: { 'x-scheduler-health-token': 'top-secret-token' },
      }),
    );
    const payload = (await authorizedResponse.json()) as { ok: boolean; healthy: boolean };

    expect(authorizedResponse.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.healthy).toBe(true);
  });
});
