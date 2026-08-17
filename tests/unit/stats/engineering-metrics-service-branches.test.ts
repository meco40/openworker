import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryAll: vi.fn(),
  loadDomainRegistry: vi.fn(),
  evaluateHarnessRollout: vi.fn(),
  loadHarnessRolloutConfig: vi.fn(),
  getMasterRepository: vi.fn(),
  computeEngineeringMetricsSnapshot: vi.fn(),
  getGuardianAutoRevertCount: vi.fn(),
  getEngineeringRolloutBaselineById: vi.fn(),
  getHarnessDomainStats: vi.fn(),
  getHarnessLaneStats: vi.fn(),
  getHarnessScenarioStats: vi.fn(),
  getHarnessWorktreeStats: vi.fn(),
  getLatestEngineeringSnapshot: vi.fn(),
  getLatestEngineeringRolloutBaseline: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  queryAll: mocks.queryAll,
}));

vi.mock('@/server/ci/harnessDomainRegistry', () => ({
  loadDomainRegistry: mocks.loadDomainRegistry,
}));

vi.mock('@/server/stats/harnessRollout', () => ({
  evaluateHarnessRollout: mocks.evaluateHarnessRollout,
  loadHarnessRolloutConfig: mocks.loadHarnessRolloutConfig,
}));

vi.mock('@/server/master/runtime', () => ({
  getMasterRepository: mocks.getMasterRepository,
}));

vi.mock('@/server/stats/engineeringMetrics', () => ({
  computeEngineeringMetricsSnapshot: mocks.computeEngineeringMetricsSnapshot,
}));

vi.mock('@/server/stats/engineeringSnapshotRepository', () => ({
  getGuardianAutoRevertCount: mocks.getGuardianAutoRevertCount,
  getEngineeringRolloutBaselineById: mocks.getEngineeringRolloutBaselineById,
  getHarnessDomainStats: mocks.getHarnessDomainStats,
  getHarnessLaneStats: mocks.getHarnessLaneStats,
  getHarnessScenarioStats: mocks.getHarnessScenarioStats,
  getHarnessWorktreeStats: mocks.getHarnessWorktreeStats,
  getLatestEngineeringSnapshot: mocks.getLatestEngineeringSnapshot,
  getLatestEngineeringRolloutBaseline: mocks.getLatestEngineeringRolloutBaseline,
}));

import {
  collectEngineeringMetricsSnapshot,
  parseWindowDays,
} from '@/server/stats/engineeringMetricsService';

const NOW = new Date('2026-08-18T00:00:00.000Z');
const NOW_MS = NOW.getTime();

function defaultRolloutConfig() {
  return {
    version: '1.0.0',
    timezone: 'UTC',
    rolloutStart: '2026-01-01',
    baseline: { id: 'base-1', windowStart: '', windowEnd: '', source: 'test' },
    owners: { rolloutGateOwnerVar: 'X', goNoGoOwnerVar: 'Y' },
    sla: { defaultHours: 24, overrideVar: 'Z' },
    phases: [],
    goNoGo: {
      decisionDates: [],
      recommendationPolicy: { pass: 'go', fail: 'hold', unknown: 'hold' },
    },
  };
}

function defaultBaseline() {
  return {
    id: 'base-1',
    payload: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    baselineHash: 'hash',
  };
}

function defaultComputed() {
  return {
    windowDays: 30,
    leadTimeMedianHours: 1.5,
    mergeThroughputPerWeek: 10,
    firstPassCiRate: 0.8,
    flakyRate: 0.1,
    revertRate: 0.05,
    medianPrSize: 100,
    asyncFailureSlaBreaches: 0,
    generatedAt: NOW.toISOString(),
  };
}

describe('engineeringMetricsService branch coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryAll.mockReturnValue([]);
    mocks.loadDomainRegistry.mockReturnValue({ domains: [{ id: 'domain-a' }, { id: 'domain-b' }] });
    mocks.evaluateHarnessRollout.mockReturnValue({
      phase: null,
      phaseWindow: { start: null, end: null },
      mode: null,
      baselineId: null,
      overallStatus: 'unknown',
      recommendation: 'hold',
      exitGates: [],
      deltaVsBaseline: {},
    });
    mocks.loadHarnessRolloutConfig.mockReturnValue(defaultRolloutConfig());
    mocks.getMasterRepository.mockReturnValue({
      listKnownScopes: vi.fn(() => []),
      listRuns: vi.fn(() => []),
      listAuditEvents: vi.fn(() => []),
    });
    mocks.computeEngineeringMetricsSnapshot.mockReturnValue(defaultComputed());
    mocks.getGuardianAutoRevertCount.mockReturnValue(0);
    mocks.getEngineeringRolloutBaselineById.mockReturnValue(null);
    mocks.getHarnessDomainStats.mockReturnValue([]);
    mocks.getHarnessLaneStats.mockReturnValue([]);
    mocks.getHarnessScenarioStats.mockReturnValue([]);
    mocks.getHarnessWorktreeStats.mockReturnValue([]);
    mocks.getLatestEngineeringSnapshot.mockReturnValue(null);
    mocks.getLatestEngineeringRolloutBaseline.mockReturnValue(defaultBaseline());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseWindowDays', () => {
    it('returns 30 for null', () => {
      expect(parseWindowDays(null)).toBe(30);
    });

    it('returns 7 for "7"', () => {
      expect(parseWindowDays('7')).toBe(7);
    });

    it('returns 30 for "30"', () => {
      expect(parseWindowDays('30')).toBe(30);
    });

    it('throws for invalid window', () => {
      expect(() => parseWindowDays('15')).toThrow('windowDays must be 7 or 30');
      expect(() => parseWindowDays('abc')).toThrow('windowDays must be 7 or 30');
    });
  });

  describe('collectEngineeringMetricsSnapshot - fallback path', () => {
    it('computes fallback snapshot with no snapshot available', () => {
      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 30,
        now: NOW,
      });

      expect(result.source).toBe('fallback');
      expect(result.isFallback).toBe(true);
      expect(result.snapshotAgeHours).toBeNull();
      expect(mocks.computeEngineeringMetricsSnapshot).toHaveBeenCalled();
    });

    it('resolves scopes via known scopes when no workspaceId', () => {
      mocks.getMasterRepository.mockReturnValue({
        listKnownScopes: vi.fn(() => [
          { userId: 'user-1', workspaceId: 'ws-a' },
          { userId: 'user-1', workspaceId: 'ws-b' },
          { userId: 'other', workspaceId: 'ws-c' },
        ]),
        listRuns: vi.fn(() => []),
        listAuditEvents: vi.fn(() => []),
      });

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: null,
        windowDays: 7,
        now: NOW,
      });

      expect(result.source).toBe('fallback');
    });

    it('uses default workspace when no known scopes', () => {
      mocks.getMasterRepository.mockReturnValue({
        listKnownScopes: vi.fn(() => []),
        listRuns: vi.fn(() => []),
        listAuditEvents: vi.fn(() => []),
      });

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: null,
        windowDays: 7,
        now: NOW,
      });

      expect(result.source).toBe('fallback');
    });

    it('collects run signals with completed runs and rollback events', () => {
      mocks.getMasterRepository.mockReturnValue({
        listKnownScopes: vi.fn(() => []),
        listRuns: vi.fn(() => [
          {
            status: 'COMPLETED',
            createdAt: '2026-08-10T00:00:00.000Z',
            updatedAt: '2026-08-11T00:00:00.000Z',
            verificationPassed: true,
          },
          {
            status: 'COMPLETED',
            createdAt: '2026-08-12T00:00:00.000Z',
            updatedAt: '2026-08-13T00:00:00.000Z',
            verificationPassed: false,
          },
          {
            status: 'RUNNING',
            createdAt: '2026-08-14T00:00:00.000Z',
            updatedAt: '2026-08-14T00:00:00.000Z',
          },
        ]),
        listAuditEvents: vi.fn(() => [
          { action: 'rollback' },
          { action: 'deploy' },
          { action: 'rollback' },
        ]),
      });

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 7,
        now: NOW,
      });

      expect(result.source).toBe('fallback');
      expect(mocks.computeEngineeringMetricsSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          completedRuns: expect.arrayContaining([
            expect.objectContaining({ requiredRefinement: false }),
            expect.objectContaining({ requiredRefinement: true }),
          ]),
          verificationRuns: expect.arrayContaining([
            expect.objectContaining({ passed: true }),
            expect.objectContaining({ passed: false }),
          ]),
          rollbackEvents: 2,
        }),
        expect.any(String),
      );
    });

    it('collects merge sized changes and async failures', () => {
      mocks.queryAll.mockImplementation((sql: string) => {
        if (sql.includes('FROM tasks t')) {
          return [
            {
              status: 'done',
              updated_at: '2026-08-17T00:00:00.000Z',
              failed_at: '2026-08-16T00:00:00.000Z',
            },
            {
              status: 'in_progress',
              updated_at: '2026-08-01T00:00:00.000Z',
              failed_at: '2026-08-01T00:00:00.000Z',
            },
            {
              status: 'review',
              updated_at: '2026-08-17T00:00:00.000Z',
              failed_at: '2026-08-16T00:00:00.000Z',
            },
            { status: 'bogus', updated_at: 'not-a-date', failed_at: 'not-a-date' },
          ];
        }
        if (sql.includes('FROM task_activities')) {
          return [
            { metadata: JSON.stringify({ linesChanged: 42 }) },
            { metadata: JSON.stringify({ changedLines: 10 }) },
            { metadata: 'not-json' },
            { metadata: JSON.stringify({ linesChanged: -5 }) },
            { metadata: null },
          ];
        }
        return [];
      });

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 7,
        now: NOW,
      });

      expect(result.source).toBe('fallback');
      expect(mocks.computeEngineeringMetricsSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          mergeSizedChanges: expect.arrayContaining([42, 10]),
          asyncFailures: expect.arrayContaining([
            expect.objectContaining({ breachedSla: false }),
            expect.objectContaining({ breachedSla: true }),
          ]),
        }),
        expect.any(String),
      );
    });

    it('computes domain coverage with covered and uncovered domains', () => {
      mocks.getHarnessDomainStats.mockReturnValue([
        { domain: 'domain-a', totalRuns: 5 },
        { domain: 'domain-b', totalRuns: 0 },
      ]);

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 7,
        now: NOW,
      });

      expect(result.domainCoverage).toEqual({
        activeDomains: 2,
        coveredDomains: 1,
        coverageRate: 0.5,
        uncoveredDomains: ['domain-b'],
      });
    });

    it('computes worktree harness stats', () => {
      mocks.getHarnessWorktreeStats.mockReturnValue([
        { totalRuns: 3, successRuns: 3 },
        { totalRuns: 3, successRuns: 1 },
        { totalRuns: 0, successRuns: 0 },
      ]);

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 7,
        now: NOW,
      });

      expect(result.worktreeHarness).toEqual({
        totalWorktrees: 3,
        healthyWorktrees: 1,
        successRate: 0.33,
        unstableWorktrees: 1,
      });
    });

    it('computes scenario success rates', () => {
      mocks.getHarnessScenarioStats.mockReturnValue([
        { scenario: 's1', totalRuns: 4, successRuns: 2, flakySuspicions: 1 },
        { scenario: 's2', totalRuns: 0, successRuns: 0, flakySuspicions: 0 },
      ]);

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 7,
        now: NOW,
      });

      expect(result.scenarioSuccessRates).toEqual([
        { scenario: 's1', successRate: 0.5, totalRuns: 4, flakySuspicions: 1 },
        { scenario: 's2', successRate: null, totalRuns: 0, flakySuspicions: 0 },
      ]);
    });

    it('handles loadRolloutState failure with fallback config', () => {
      mocks.loadHarnessRolloutConfig.mockImplementation(() => {
        throw new Error('config missing');
      });

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 7,
        now: NOW,
      });

      expect(result.source).toBe('fallback');
      expect(mocks.evaluateHarnessRollout).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ version: 'unknown' }),
          baseline: null,
        }),
      );
    });
  });

  describe('collectEngineeringMetricsSnapshot - snapshot path', () => {
    it('uses fresh snapshot when available', () => {
      const freshSnapshot = {
        id: 'snap-1',
        windowDays: 30,
        generatedAt: '2026-08-17T23:00:00.000Z',
        payload: {
          leadTimeMedianHours: 2.5,
          mergeThroughputPerWeek: 20,
          firstPassCiRate: 0.9,
          flakyRate: 0.05,
          revertRate: 0.02,
          medianPrSize: 150,
          asyncFailureSlaBreaches: 1,
          domainCoverage: {
            activeDomains: 2,
            coveredDomains: 2,
            coverageRate: 1,
            uncoveredDomains: [],
          },
          scenarioSuccessRates: [
            { scenario: 's1', successRate: 0.8, totalRuns: 5, flakySuspicions: 0 },
          ],
          worktreeHarness: {
            totalWorktrees: 2,
            healthyWorktrees: 2,
            successRate: 1,
            unstableWorktrees: 0,
          },
          criticalFailAutoReverts: 3,
        },
      };
      mocks.getLatestEngineeringSnapshot.mockReturnValue(freshSnapshot);

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 30,
        now: NOW,
      });

      expect(result.source).toBe('snapshot');
      expect(result.isFallback).toBe(false);
      expect(result.leadTimeMedianHours).toBe(2.5);
      expect(result.mergeThroughputPerWeek).toBe(20);
      expect(result.firstPassCiRate).toBe(0.9);
      expect(result.flakyRate).toBe(0.05);
      expect(result.revertRate).toBe(0.02);
      expect(result.medianPrSize).toBe(150);
      expect(result.asyncFailureSlaBreaches).toBe(1);
      expect(result.domainCoverage?.coveredDomains).toBe(2);
      expect(result.scenarioSuccessRates).toHaveLength(1);
      expect(result.worktreeHarness?.healthyWorktrees).toBe(2);
      expect(result.criticalFailAutoReverts).toBe(3);
      expect(result.snapshotAgeHours).toBeGreaterThan(0);
    });

    it('uses snake_case payload keys', () => {
      const freshSnapshot = {
        id: 'snap-2',
        windowDays: 7,
        generatedAt: '2026-08-17T23:00:00.000Z',
        payload: {
          lead_time_median_hours: 3.5,
          merge_throughput_per_week: 30,
          first_pass_ci_rate: 0.7,
          flaky_rate: 0.1,
          revert_rate: 0.03,
          median_pr_size: 200,
          async_failure_sla_breaches: 2,
          domain_coverage: {
            activeDomains: 1,
            coveredDomains: 1,
            coverageRate: 1,
            uncoveredDomains: [],
          },
          scenario_success_rates: [],
          worktree_harness: {
            totalWorktrees: 1,
            healthyWorktrees: 1,
            successRate: 1,
            unstableWorktrees: 0,
          },
          critical_fail_auto_reverts: 4,
        },
      };
      mocks.getLatestEngineeringSnapshot.mockReturnValue(freshSnapshot);

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 7,
        now: NOW,
      });

      expect(result.source).toBe('snapshot');
      expect(result.leadTimeMedianHours).toBe(3.5);
      expect(result.mergeThroughputPerWeek).toBe(30);
      expect(result.firstPassCiRate).toBe(0.7);
      expect(result.flakyRate).toBe(0.1);
      expect(result.revertRate).toBe(0.03);
      expect(result.medianPrSize).toBe(200);
      expect(result.asyncFailureSlaBreaches).toBe(2);
      expect(result.criticalFailAutoReverts).toBe(4);
    });

    it('falls back to computed values when payload fields missing', () => {
      const freshSnapshot = {
        id: 'snap-3',
        windowDays: 30,
        generatedAt: '2026-08-17T23:00:00.000Z',
        payload: {},
      };
      mocks.getLatestEngineeringSnapshot.mockReturnValue(freshSnapshot);

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 30,
        now: NOW,
      });

      expect(result.source).toBe('snapshot');
      expect(result.leadTimeMedianHours).toBeNull();
      expect(result.mergeThroughputPerWeek).toBeNull();
      expect(result.firstPassCiRate).toBeNull();
      expect(result.flakyRate).toBeNull();
      expect(result.revertRate).toBeNull();
      expect(result.medianPrSize).toBeNull();
      expect(result.asyncFailureSlaBreaches).toBe(0);
      expect(result.domainCoverage).toBeDefined();
      expect(result.scenarioSuccessRates).toBeDefined();
      expect(result.worktreeHarness).toBeDefined();
      expect(result.criticalFailAutoReverts).toBe(0);
    });

    it('ignores stale snapshot and uses fallback', () => {
      const staleSnapshot = {
        id: 'snap-stale',
        windowDays: 30,
        generatedAt: '2026-08-01T00:00:00.000Z',
        payload: {},
      };
      mocks.getLatestEngineeringSnapshot.mockReturnValue(staleSnapshot);

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 30,
        now: NOW,
      });

      expect(result.source).toBe('fallback');
      expect(result.isFallback).toBe(true);
    });

    it('computes snapshotAgeHours from stale snapshot in fallback', () => {
      const staleSnapshot = {
        id: 'snap-stale-2',
        windowDays: 30,
        generatedAt: '2026-08-01T00:00:00.000Z',
        payload: {},
      };
      mocks.getLatestEngineeringSnapshot.mockReturnValue(staleSnapshot);

      const result = collectEngineeringMetricsSnapshot({
        userId: 'user-1',
        workspaceId: 'ws-1',
        windowDays: 30,
        now: NOW,
      });

      expect(result.source).toBe('fallback');
      expect(result.snapshotAgeHours).toBeGreaterThan(0);
    });
  });
});
