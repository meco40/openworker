import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestArtifactsRoot } from '../../helpers/testArtifacts';
import { cleanupSqliteArtifacts } from '../../helpers/sqliteTestArtifacts';

function makeHeaders(overrides: Record<string, string> = {}): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-engineering-ingest-token': 'test-ingest-token',
    'x-engineering-ingest-timestamp': new Date().toISOString(),
    'x-engineering-ingest-idempotency-key': `ingest-${Date.now()}`,
    ...overrides,
  };
}

function makeBody() {
  return {
    snapshots: [
      {
        windowDays: 7,
        leadTimeMedianHours: 4.5,
        mergeThroughputPerWeek: 12,
        firstPassCiRate: 0.8,
        flakyRate: 0.01,
        revertRate: 0.02,
        medianPrSize: 220,
        asyncFailureSlaBreaches: 0,
        generatedAt: new Date().toISOString(),
        source: 'github-snapshot',
      },
    ],
    prFacts: [
      {
        prNumber: 123,
        createdAt: new Date(Date.now() - 10_000).toISOString(),
        mergedAt: new Date().toISOString(),
        additions: 50,
        deletions: 10,
        firstPassBlocking: true,
        reverted: false,
      },
    ],
    events: [
      {
        trace_id: 'trace-1',
        span_id: 'span-1',
        service_name: 'github-actions',
        domain: 'ops-observability',
        lane: 'coverage',
        scenario: 'lane:coverage',
        status: 'success',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 1000,
        worktree_id: 'gha-main',
        commit_sha: 'abcdef1234567890abcdef1234567890abcdef12',
        error_kind: null,
        run_url: 'https://github.com/example/repo/actions/runs/1?token=secret',
      },
    ],
  };
}

describe('POST /api/internal/stats/engineering/snapshots', () => {
  let databasePath = '';
  let previousDatabasePath: string | undefined;
  let previousToken: string | undefined;
  let previousEnabled: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousToken = process.env.ENGINEERING_INGEST_TOKEN;
    previousEnabled = process.env.ENGINEERING_INGEST_ENABLED;

    const stamp = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    databasePath = path.resolve(getTestArtifactsRoot(), `engineering.ingest.${stamp}.db`);

    process.env.DATABASE_PATH = databasePath;
    process.env.ENGINEERING_INGEST_TOKEN = 'test-ingest-token';
    process.env.ENGINEERING_INGEST_ENABLED = '1';
    (globalThis as { __engineeringIngestRateWindow?: number[] }).__engineeringIngestRateWindow =
      undefined;
  });

  afterEach(() => {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;

    if (previousToken === undefined) delete process.env.ENGINEERING_INGEST_TOKEN;
    else process.env.ENGINEERING_INGEST_TOKEN = previousToken;

    if (previousEnabled === undefined) delete process.env.ENGINEERING_INGEST_ENABLED;
    else process.env.ENGINEERING_INGEST_ENABLED = previousEnabled;

    cleanupSqliteArtifacts(databasePath);
    (globalThis as { __engineeringIngestRateWindow?: number[] }).__engineeringIngestRateWindow =
      undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 401 when ingest token is missing or invalid', async () => {
    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');
    const response = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders({ 'x-engineering-ingest-token': 'wrong-token' }),
        body: JSON.stringify(makeBody()),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 when timestamp is outside allowed window', async () => {
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');
    const response = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders({ 'x-engineering-ingest-timestamp': stale }),
        body: JSON.stringify(makeBody()),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('returns 200 for a valid ingest payload and 409 for replay', async () => {
    const idempotencyKey = `ingest-replay-${Date.now()}`;
    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');

    const first = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders({ 'x-engineering-ingest-idempotency-key': idempotencyKey }),
        body: JSON.stringify(makeBody()),
      }),
    );
    expect(first.status).toBe(200);

    const second = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders({ 'x-engineering-ingest-idempotency-key': idempotencyKey }),
        body: JSON.stringify(makeBody()),
      }),
    );
    expect(second.status).toBe(409);

    const { queryAll } = await import('@/lib/db');
    const rows = queryAll<{
      domain: string | null;
      scenario: string | null;
      worktree_id: string | null;
      commit_sha: string | null;
      run_url: string | null;
    }>('SELECT domain, scenario, worktree_id, commit_sha, run_url FROM harness_run_events');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].domain).toBe('ops-observability');
    expect(rows[0].scenario).toBe('lane:coverage');
    expect(rows[0].worktree_id).toBe('gha-main');
    expect(rows[0].commit_sha).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(rows[0].run_url).toBe('https://github.com/example/repo/actions/runs/1');
  });

  it('returns 429 when ingest rate window is exceeded', async () => {
    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');
    for (let index = 0; index < 12; index += 1) {
      const response = await POST(
        new Request('http://localhost/api/internal/stats/engineering/snapshots', {
          method: 'POST',
          headers: makeHeaders({
            'x-engineering-ingest-idempotency-key': `rate-ok-${Date.now()}-${index}`,
          }),
          body: JSON.stringify(makeBody()),
        }),
      );
      expect(response.status).toBe(200);
    }

    const blocked = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders({
          'x-engineering-ingest-idempotency-key': `rate-block-${Date.now()}`,
        }),
        body: JSON.stringify(makeBody()),
      }),
    );
    expect(blocked.status).toBe(429);
  });
});
