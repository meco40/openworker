import { describe, expect, it } from 'vitest';

import {
  computeEngineeringMetricsSnapshot,
  type EngineeringSignalSet,
} from '@/server/stats/engineeringMetrics';

function makeSignals(overrides: Partial<EngineeringSignalSet> = {}): EngineeringSignalSet {
  return {
    windowDays: 30,
    completedRuns: [],
    verificationRuns: [],
    rollbackEvents: 0,
    mergeSizedChanges: [],
    asyncFailures: [],
    ...overrides,
  };
}

describe('computeEngineeringMetricsSnapshot', () => {
  it('returns nullable metrics when no data exists', () => {
    const result = computeEngineeringMetricsSnapshot(makeSignals());
    expect(result.windowDays).toBe(30);
    expect(result.leadTimeMedianHours).toBeNull();
    expect(result.firstPassCiRate).toBeNull();
    expect(result.flakyRate).toBeNull();
    expect(result.revertRate).toBeNull();
    expect(result.medianPrSize).toBeNull();
    expect(result.asyncFailureSlaBreaches).toBe(0);
  });

  it('computes snapshot metrics from available signals', () => {
    const result = computeEngineeringMetricsSnapshot(
      makeSignals({
        completedRuns: [
          {
            createdAt: '2026-03-01T10:00:00.000Z',
            completedAt: '2026-03-01T14:00:00.000Z',
            requiredRefinement: false,
          },
          {
            createdAt: '2026-03-02T10:00:00.000Z',
            completedAt: '2026-03-02T16:00:00.000Z',
            requiredRefinement: true,
          },
        ],
        verificationRuns: [{ passed: true }, { passed: false }],
        rollbackEvents: 1,
        mergeSizedChanges: [120, 280, 700],
        asyncFailures: [{ breachedSla: true }, { breachedSla: false }],
      }),
    );

    expect(result.leadTimeMedianHours).toBe(5);
    expect(result.mergeThroughputPerWeek).toBeCloseTo(0.47, 2);
    expect(result.firstPassCiRate).toBe(0.5);
    expect(result.flakyRate).toBe(0.5);
    expect(result.revertRate).toBeCloseTo(0.33, 2);
    expect(result.medianPrSize).toBe(280);
    expect(result.asyncFailureSlaBreaches).toBe(1);
  });
});
