import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';
import { cleanupSqliteArtifacts } from '../../helpers/sqliteTestArtifacts';

describe('engineering snapshot repository branches', () => {
  let databasePath = '';
  let previousDatabasePath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    databasePath = path.resolve(
      getTestArtifactsRoot(),
      `engineering.snapshot.repo.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = databasePath;
  });

  afterEach(async () => {
    // Close the lazy singleton after each test because coverage runs can import eagerly.
    const { closeDb } = await import('@/lib/db');
    closeDb();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    cleanupSqliteArtifacts(databasePath);
  });

  it('stores ingest receipts and snapshots and ignores malformed snapshot payloads', async () => {
    const { run } = await import('@/lib/db');
    const repo = await import('@/server/stats/engineeringSnapshotRepository');
    expect(repo.hasIngestReceipt('receipt-1')).toBe(false);
    repo.createIngestReceipt('receipt-1', '2026-04-22T10:00:00.000Z');
    expect(repo.hasIngestReceipt('receipt-1')).toBe(true);

    repo.storeEngineeringSnapshot({
      windowDays: 30,
      payload: { firstPassCiRate: 0.9, nested: { ok: true } },
      source: 'github-snapshot',
      generatedAt: '2026-04-22T10:00:00.000Z',
    });
    expect(repo.getLatestEngineeringSnapshot(30)).toMatchObject({
      windowDays: 30,
      source: 'github-snapshot',
      payload: { firstPassCiRate: 0.9, nested: { ok: true } },
    });

    run(
      `INSERT INTO engineering_metrics_snapshots (id, window_days, payload_json, source, generated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['invalid-snapshot', 7, '"not-an-object"', 'broken', '2026-04-22T11:00:00.000Z'],
    );
    expect(repo.getLatestEngineeringSnapshot(7)).toBeNull();
  });

  it('stores rollout baselines and gate runs and returns null for malformed payloads', async () => {
    const { run } = await import('@/lib/db');
    const repo = await import('@/server/stats/engineeringSnapshotRepository');
    repo.storeEngineeringRolloutBaseline({
      id: 'baseline-1',
      windowStart: '2026-04-01T00:00:00.000Z',
      windowEnd: '2026-04-21T23:59:59.000Z',
      payload: { overallStatus: 'pass' },
      source: 'snapshot',
      baselineHash: 'hash-1',
    });

    expect(repo.getEngineeringRolloutBaselineById('baseline-1')).toMatchObject({
      id: 'baseline-1',
      baselineHash: 'hash-1',
      payload: { overallStatus: 'pass' },
    });
    expect(repo.getLatestEngineeringRolloutBaseline()?.id).toBe('baseline-1');

    run(
      `INSERT INTO engineering_rollout_baselines
       (id, window_start, window_end, payload_json, source, baseline_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'baseline-invalid',
        '2026-04-01T00:00:00.000Z',
        '2026-04-21T23:59:59.000Z',
        '"bad-payload"',
        'snapshot',
        'hash-invalid',
      ],
    );
    expect(repo.getEngineeringRolloutBaselineById('baseline-invalid')).toBeNull();

    repo.storeEngineeringRolloutGateRun({
      phaseId: 'week-1',
      status: 'pass',
      payload: { phase: 'week-1' },
      generatedAt: '2026-04-22T10:30:00.000Z',
    });
    expect(repo.getLatestEngineeringRolloutGateRun()).toMatchObject({
      phaseId: 'week-1',
      status: 'pass',
      payload: { phase: 'week-1' },
    });

    run(
      `INSERT INTO engineering_rollout_gate_runs (id, phase_id, status, payload_json, generated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['gate-invalid', null, 'unknown', '"bad-payload"', '2026-04-22T10:31:00.000Z'],
    );
    expect(repo.getLatestEngineeringRolloutGateRun()).toBeNull();
  });

  it('aggregates harness and guardian stats and prunes old events', async () => {
    const { queryOne } = await import('@/lib/db');
    const repo = await import('@/server/stats/engineeringSnapshotRepository');
    repo.replaceEngineeringPrFacts([
      {
        prNumber: 1,
        createdAt: '2026-04-20T10:00:00.000Z',
        mergedAt: '2026-04-21T10:00:00.000Z',
        additions: 10,
        deletions: 5,
        firstPassBlocking: true,
        reverted: false,
      },
    ]);
    expect(
      queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM engineering_pr_facts')?.total,
    ).toBe(1);

    repo.appendHarnessRunEvents([
      {
        serviceName: 'github-actions',
        domain: 'security',
        lane: 'coverage',
        scenario: 'scenario-a',
        status: 'success',
        startedAt: '2026-04-22T09:00:00.000Z',
        finishedAt: '2026-04-22T09:01:00.000Z',
        durationMs: 61_000,
        worktreeId: 'wt-a',
        commitSha: 'abcdef1',
      },
      {
        serviceName: 'github-actions',
        domain: 'security',
        lane: 'coverage',
        scenario: 'scenario-a',
        status: 'failure',
        startedAt: '2026-04-22T09:02:00.000Z',
        finishedAt: '2026-04-22T09:03:00.000Z',
        durationMs: 59_000,
        worktreeId: 'wt-a',
        commitSha: 'abcdef2',
        errorKind: 'timeout',
      },
      {
        serviceName: 'github-actions',
        domain: 'tasks',
        lane: 'main-guardian',
        scenario: 'guardian-auto-revert',
        status: 'success',
        startedAt: '2026-04-22T09:04:00.000Z',
        finishedAt: '2026-04-22T09:05:00.000Z',
        durationMs: -5,
        worktreeId: 'wt-b',
        commitSha: 'abcdef3',
      },
      {
        serviceName: 'github-actions',
        domain: 'legacy',
        lane: 'old',
        scenario: 'old-scenario',
        status: 'cancelled',
        startedAt: '2025-12-01T09:00:00.000Z',
        finishedAt: '2025-12-01T09:01:00.000Z',
        durationMs: 10,
      },
    ]);

    expect(repo.getHarnessLaneStats('2026-04-22T00:00:00.000Z')).toEqual([
      {
        lane: 'coverage',
        totalRuns: 2,
        successRuns: 1,
        medianDurationMs: 60000,
        flakySuspicions: 1,
      },
      {
        lane: 'main-guardian',
        totalRuns: 1,
        successRuns: 1,
        medianDurationMs: 0,
        flakySuspicions: 0,
      },
    ]);
    expect(repo.getHarnessDomainStats('2026-04-22T00:00:00.000Z')).toEqual([
      { domain: 'security', totalRuns: 2, successRuns: 1 },
      { domain: 'tasks', totalRuns: 1, successRuns: 1 },
    ]);
    expect(repo.getHarnessScenarioStats('2026-04-22T00:00:00.000Z')).toEqual([
      { scenario: 'guardian-auto-revert', totalRuns: 1, successRuns: 1, flakySuspicions: 0 },
      { scenario: 'scenario-a', totalRuns: 2, successRuns: 1, flakySuspicions: 1 },
    ]);
    expect(repo.getHarnessWorktreeStats('2026-04-22T00:00:00.000Z')).toEqual([
      {
        worktreeId: 'wt-a',
        totalRuns: 2,
        successRuns: 1,
        lastFinishedAt: '2026-04-22T09:03:00.000Z',
      },
      {
        worktreeId: 'wt-b',
        totalRuns: 1,
        successRuns: 1,
        lastFinishedAt: '2026-04-22T09:05:00.000Z',
      },
    ]);
    expect(repo.getGuardianAutoRevertCount('2026-04-22T00:00:00.000Z')).toBe(1);
    expect(repo.pruneHarnessRunEventsBefore('2026-01-01T00:00:00.000Z')).toBe(1);
  });
});
