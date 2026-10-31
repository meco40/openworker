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

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    snapshots: [
      {
        windowDays: 30,
        generatedAt: new Date().toISOString(),
        source: 'github-snapshot',
      },
    ],
    ...overrides,
  };
}

describe('POST /api/internal/stats/engineering/snapshots branch coverage', () => {
  let databasePath = '';
  let previousDatabasePath: string | undefined;
  let previousToken: string | undefined;
  let previousEnabled: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    const { closeDb } = await import('@/lib/db');
    closeDb();

    previousDatabasePath = process.env.DATABASE_PATH;
    previousToken = process.env.ENGINEERING_INGEST_TOKEN;
    previousEnabled = process.env.ENGINEERING_INGEST_ENABLED;

    const stamp = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    databasePath = path.resolve(getTestArtifactsRoot(), `engineering.ingest.branches.${stamp}.db`);

    process.env.DATABASE_PATH = databasePath;
    process.env.ENGINEERING_INGEST_TOKEN = 'test-ingest-token';
    process.env.ENGINEERING_INGEST_ENABLED = '1';
    (globalThis as { __engineeringIngestRateWindow?: number[] }).__engineeringIngestRateWindow =
      undefined;
  });

  afterEach(async () => {
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
    const { closeDb } = await import('@/lib/db');
    closeDb();
  });

  it('returns 503 when the ingest feature flag is disabled', async () => {
    process.env.ENGINEERING_INGEST_ENABLED = '0';
    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');
    const response = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(makeBody()),
      }),
    );

    expect(response.status).toBe(503);
  });

  it('rejects absent credentials and timestamps, then accepts the case-insensitive enabled flag', async () => {
    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');

    delete process.env.ENGINEERING_INGEST_TOKEN;
    const missingExpectedToken = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(makeBody()),
      }),
    );
    expect(missingExpectedToken.status).toBe(401);

    process.env.ENGINEERING_INGEST_TOKEN = 'test-ingest-token';
    for (const providedToken of ['  ', 'xxxx-ingest-token']) {
      const unauthorized = await POST(
        new Request('http://localhost/api/internal/stats/engineering/snapshots', {
          method: 'POST',
          headers: makeHeaders({ 'x-engineering-ingest-token': providedToken }),
          body: JSON.stringify(makeBody()),
        }),
      );
      expect(unauthorized.status).toBe(401);
    }

    for (const timestamp of [
      '  ',
      'not-a-date',
      new Date(Date.now() + 20 * 60_000).toISOString(),
    ]) {
      const invalidTimestamp = await POST(
        new Request('http://localhost/api/internal/stats/engineering/snapshots', {
          method: 'POST',
          headers: makeHeaders({ 'x-engineering-ingest-timestamp': timestamp }),
          body: JSON.stringify(makeBody()),
        }),
      );
      expect(invalidTimestamp.status).toBe(400);
    }

    delete process.env.ENGINEERING_INGEST_ENABLED;
    const disabledByDefault = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(makeBody()),
      }),
    );
    expect(disabledByDefault.status).toBe(503);

    process.env.ENGINEERING_INGEST_ENABLED = ' TRUE ';
    const enabledByBooleanString = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(makeBody()),
      }),
    );
    expect(enabledByBooleanString.status).toBe(200);
  });

  it('rejects missing idempotency keys and invalid non-object bodies', async () => {
    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');

    const missingKey = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders({ 'x-engineering-ingest-idempotency-key': '   ' }),
        body: JSON.stringify(makeBody()),
      }),
    );
    expect(missingKey.status).toBe(400);

    const invalidBody = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(['not-an-object']),
      }),
    );
    expect(invalidBody.status).toBe(400);
  });

  it('rejects malformed snapshots, pr facts, rollout baseline, and rollout gate payloads', async () => {
    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');

    const badSnapshot = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(makeBody({ snapshots: [{ windowDays: 14 }] })),
      }),
    );
    expect(badSnapshot.status).toBe(400);

    const badPrFacts = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(
          makeBody({
            prFacts: [
              {
                prNumber: 'bad-number',
                createdAt: '2026-04-22T10:00:00.000Z',
                mergedAt: '2026-04-22T10:01:00.000Z',
              },
            ],
          }),
        ),
      }),
    );
    expect(badPrFacts.status).toBe(400);

    const badBaseline = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(
          makeBody({
            rolloutBaseline: {
              id: 'baseline-1',
              windowStart: '2026-04-01T00:00:00.000Z',
              windowEnd: '2026-04-22T00:00:00.000Z',
              payload: { ok: true },
              hash: '',
            },
          }),
        ),
      }),
    );
    expect(badBaseline.status).toBe(400);

    const badGateRun = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(
          makeBody({
            rolloutGateRun: {
              status: 'broken',
              payload: null,
            },
          }),
        ),
      }),
    );
    expect(badGateRun.status).toBe(400);
  });

  it('sanitizes event status, commit sha, run url, and sensitive error kinds on ingest', async () => {
    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');
    const response = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(
          makeBody({
            events: [
              {
                service_name: 'github-actions',
                lane: 'coverage',
                status: 'unexpected-status',
                started_at: new Date(Date.now() - 60_000).toISOString(),
                finished_at: new Date().toISOString(),
                duration_ms: 1234.56,
                commit_sha: 'not-a-sha',
                error_kind: 'api-token-leak',
                run_url: 'not-a-valid-url',
              },
            ],
          }),
        ),
      }),
    );

    expect(response.status).toBe(200);
    const { queryOne } = await import('@/lib/db');
    const row = queryOne<{
      status: string;
      duration_ms: number;
      commit_sha: string | null;
      error_kind: string | null;
      run_url: string | null;
    }>(
      'SELECT status, duration_ms, commit_sha, error_kind, run_url FROM harness_run_events LIMIT 1',
    );

    expect(row).toEqual({
      status: 'failure',
      duration_ms: 1234,
      commit_sha: null,
      error_kind: 'redacted-sensitive-error',
      run_url: null,
    });
  });

  it('normalizes snake-case aliases, defaults optional fields, and keeps rollout writes idempotent', async () => {
    const { POST } = await import('../../../app/api/internal/stats/engineering/snapshots/route');
    const now = new Date().toISOString();
    const baseline = {
      id: 'baseline-aliases',
      window_start: '2026-04-01T00:00:00.000Z',
      window_end: '2026-04-30T00:00:00.000Z',
      payload: { source: 'test' },
      baseline_hash: 'alias-hash',
    };
    const response = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify(
          makeBody({
            snapshots: [{ window_days: '7', generated_at: null, source: '   ' }],
            prFacts: [
              {
                pr_number: '42',
                created_at: now,
                merged_at: now,
                additions: 0,
                deletions: 0,
                first_pass_blocking: true,
                reverted: false,
              },
            ],
            events: [
              {
                status: 'CANCELLED',
                startedAt: now,
                finishedAt: now,
                durationMs: -5,
                serviceName: '',
                lane: ' ',
                commitSha: 'ABCDEF0123456',
                errorKind: 'timeout',
                runUrl: 'https://user:secret@example.test/path?token=secret#private',
              },
              {
                status: 'SKIPPED',
                started_at: now,
                finished_at: now,
                duration_ms: null,
                service_name: '',
                lane: 'delivery',
                commit_sha: '',
                error_kind: '!!!',
                run_url: ' ',
              },
            ],
            rollout_baseline: baseline,
            rollout_gate_run: {
              phase_id: 'phase-alias',
              status: 'FAIL',
              payload: { result: 'blocked' },
              generated_at: null,
            },
          }),
        ),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted: { snapshots: 1, prFacts: 1, events: 2, rolloutBaseline: 1, rolloutGateRun: 1 },
    });

    const { queryAll, queryOne } = await import('@/lib/db');
    expect(
      queryOne<{ source: string }>(
        'SELECT source FROM engineering_metrics_snapshots WHERE window_days = 7',
      )?.source,
    ).toBe('github-snapshot');
    expect(
      queryOne<{ additions: number; deletions: number; first_pass_blocking: number }>(
        'SELECT additions, deletions, first_pass_blocking FROM engineering_pr_facts WHERE pr_number = 42',
      ),
    ).toEqual({ additions: 0, deletions: 0, first_pass_blocking: 1 });
    const events = queryAll<{
      lane: string;
      service_name: string;
      status: string;
      duration_ms: number;
      commit_sha: string | null;
      error_kind: string | null;
      run_url: string | null;
    }>(
      'SELECT lane, service_name, status, duration_ms, commit_sha, error_kind, run_url FROM harness_run_events',
    );
    expect(events).toEqual(
      expect.arrayContaining([
        {
          lane: 'unknown',
          service_name: 'github-actions',
          status: 'cancelled',
          duration_ms: 0,
          commit_sha: 'abcdef0123456',
          error_kind: 'timeout',
          run_url: 'https://example.test/path',
        },
        {
          lane: 'delivery',
          service_name: 'github-actions',
          status: 'skipped',
          duration_ms: 0,
          commit_sha: null,
          error_kind: null,
          run_url: null,
        },
      ]),
    );

    const duplicateBaseline = await POST(
      new Request('http://localhost/api/internal/stats/engineering/snapshots', {
        method: 'POST',
        headers: makeHeaders({
          'x-engineering-ingest-idempotency-key': `duplicate-baseline-${Date.now()}`,
        }),
        body: JSON.stringify(
          makeBody({
            snapshots: [],
            prFacts: [],
            events: [],
            rolloutBaseline: baseline,
            rolloutGateRun: { status: 'unknown', payload: {} },
          }),
        ),
      }),
    );
    expect(duplicateBaseline.status).toBe(200);
    expect(queryAll('SELECT id FROM engineering_rollout_baselines')).toHaveLength(1);
    expect(
      queryAll<{ status: string }>('SELECT status FROM engineering_rollout_gate_runs').map(
        (row) => row.status,
      ),
    ).toEqual(expect.arrayContaining(['fail', 'unknown']));
  });
});
