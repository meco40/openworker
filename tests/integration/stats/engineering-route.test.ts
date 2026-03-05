import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestArtifactsRoot } from '../../helpers/testArtifacts';
import { cleanupSqliteArtifacts } from '../../helpers/sqliteTestArtifacts';

type StatsGlobals = typeof globalThis & {
  __masterRepository?: unknown;
};

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('GET /api/stats/engineering', () => {
  let databasePath = '';
  let masterDbPath = '';
  let previousDatabasePath: string | undefined;
  let previousMasterDbPath: string | undefined;
  let previousIngestToken: string | undefined;
  let previousIngestEnabled: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousMasterDbPath = process.env.MASTER_DB_PATH;
    previousIngestToken = process.env.ENGINEERING_INGEST_TOKEN;
    previousIngestEnabled = process.env.ENGINEERING_INGEST_ENABLED;

    const stamp = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    databasePath = path.resolve(getTestArtifactsRoot(), `engineering.route.${stamp}.db`);
    masterDbPath = path.resolve(getTestArtifactsRoot(), `engineering.master.${stamp}.db`);

    process.env.DATABASE_PATH = databasePath;
    process.env.MASTER_DB_PATH = masterDbPath;
    process.env.ENGINEERING_INGEST_TOKEN = 'test-ingest-token';
    process.env.ENGINEERING_INGEST_ENABLED = '1';

    (globalThis as StatsGlobals).__masterRepository = undefined;
  });

  afterEach(async () => {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;

    if (previousMasterDbPath === undefined) delete process.env.MASTER_DB_PATH;
    else process.env.MASTER_DB_PATH = previousMasterDbPath;
    if (previousIngestToken === undefined) delete process.env.ENGINEERING_INGEST_TOKEN;
    else process.env.ENGINEERING_INGEST_TOKEN = previousIngestToken;
    if (previousIngestEnabled === undefined) delete process.env.ENGINEERING_INGEST_ENABLED;
    else process.env.ENGINEERING_INGEST_ENABLED = previousIngestEnabled;

    try {
      const runtime = await import('@/server/master/runtime');
      runtime.resetMasterRepositoryForTests();
    } catch {
      // ignore reset errors in teardown
    }

    cleanupSqliteArtifacts(databasePath);
    cleanupSqliteArtifacts(masterDbPath);

    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns nullable metrics for an empty baseline', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const { GET } = await import('../../../app/api/stats/engineering/route');
    const response = await GET(new Request('http://localhost/api/stats/engineering?windowDays=30'));
    const payload = (await response.json()) as {
      ok: boolean;
      snapshot: {
        windowDays: number;
        leadTimeMedianHours: number | null;
        firstPassCiRate: number | null;
        source: string;
        isFallback: boolean;
        domainCoverage: {
          activeDomains: number;
          coveredDomains: number;
        };
        scenarioSuccessRates: unknown[];
        worktreeHarness: {
          totalWorktrees: number;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.snapshot.windowDays).toBe(30);
    expect(payload.snapshot.leadTimeMedianHours).toBeNull();
    expect(payload.snapshot.firstPassCiRate).toBeNull();
    expect(payload.snapshot.source).toBeTruthy();
    expect(typeof payload.snapshot.isFallback).toBe('boolean');
    expect(payload.snapshot.domainCoverage.activeDomains).toBeGreaterThan(0);
    expect(Array.isArray(payload.snapshot.scenarioSuccessRates)).toBe(true);
    expect(typeof payload.snapshot.worktreeHarness.totalWorktrees).toBe('number');
  });

  it('returns partial metrics when run and task signals exist', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const { getMasterRepository } = await import('@/server/master/runtime');
    const { run } = await import('@/lib/db');

    const scope = { userId: 'legacy-local-user', workspaceId: 'default' };
    const repo = getMasterRepository();

    const successfulRun = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Run 1',
      contract: 'Do the thing',
    });
    repo.updateRun(scope, successfulRun.id, { status: 'COMPLETED', verificationPassed: true });

    const failedRun = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Run 2',
      contract: 'Do another thing',
    });
    repo.updateRun(scope, failedRun.id, { status: 'COMPLETED', verificationPassed: false });

    const staleIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    run(
      `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'task-async-1',
        'Async failure follow-up',
        'inbox',
        'normal',
        'default',
        'default',
        staleIso,
        staleIso,
      ],
    );

    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['act-1', 'task-async-1', 'test_failed', 'Async quality failed', staleIso],
    );

    const { GET } = await import('../../../app/api/stats/engineering/route');
    const response = await GET(new Request('http://localhost/api/stats/engineering?windowDays=30'));
    const payload = (await response.json()) as {
      ok: boolean;
      snapshot: {
        firstPassCiRate: number | null;
        mergeThroughputPerWeek: number | null;
        asyncFailureSlaBreaches: number;
        source: string;
        isFallback: boolean;
        criticalFailAutoReverts: number;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.snapshot.firstPassCiRate).toBe(0.5);
    expect(payload.snapshot.mergeThroughputPerWeek).not.toBeNull();
    expect(payload.snapshot.asyncFailureSlaBreaches).toBeGreaterThanOrEqual(1);
    expect(payload.snapshot.source).toBeTruthy();
    expect(typeof payload.snapshot.isFallback).toBe('boolean');
    expect(typeof payload.snapshot.criticalFailAutoReverts).toBe('number');
  });

  it('rejects unsupported window sizes', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const { GET } = await import('../../../app/api/stats/engineering/route');
    const response = await GET(new Request('http://localhost/api/stats/engineering?windowDays=10'));
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('windowDays');
  });

  it('prefers fresh snapshot payload over fallback signals', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const nowIso = new Date().toISOString();

    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');
    const ingestResponse = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-engineering-ingest-token': 'test-ingest-token',
          'x-engineering-ingest-timestamp': nowIso,
          'x-engineering-ingest-idempotency-key': `ingest-${Date.now()}`,
        },
        body: JSON.stringify({
          snapshots: [
            {
              windowDays: 30,
              leadTimeMedianHours: 7.5,
              mergeThroughputPerWeek: 4.2,
              firstPassCiRate: 0.9,
              flakyRate: 0.01,
              revertRate: 0.02,
              medianPrSize: 180,
              asyncFailureSlaBreaches: 0,
              domainCoverage: {
                activeDomains: 18,
                coveredDomains: 9,
                coverageRate: 0.5,
                uncoveredDomains: ['auth'],
              },
              scenarioSuccessRates: [
                {
                  scenario: 'chat-stream',
                  successRate: 1,
                  totalRuns: 2,
                  flakySuspicions: 0,
                },
              ],
              worktreeHarness: {
                totalWorktrees: 1,
                healthyWorktrees: 1,
                successRate: 1,
                unstableWorktrees: 0,
              },
              criticalFailAutoReverts: 1,
              generatedAt: nowIso,
              source: 'github-snapshot',
            },
          ],
        }),
      }),
    );
    expect(ingestResponse.status).toBe(200);

    const { GET } = await import('../../../app/api/stats/engineering/route');
    const response = await GET(new Request('http://localhost/api/stats/engineering?windowDays=30'));
    const payload = (await response.json()) as {
      ok: boolean;
      snapshot: {
        source: string;
        isFallback: boolean;
        firstPassCiRate: number | null;
        criticalFailAutoReverts: number;
        domainCoverage: {
          coveredDomains: number;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.snapshot.source).toBe('snapshot');
    expect(payload.snapshot.isFallback).toBe(false);
    expect(payload.snapshot.firstPassCiRate).toBe(0.9);
    expect(payload.snapshot.criticalFailAutoReverts).toBe(1);
    expect(payload.snapshot.domainCoverage.coveredDomains).toBe(9);
  });
});
