import { describe, expect, it } from 'vitest';
import {
  evaluateHarnessRollout,
  isGoNoGoDate,
  resolveCurrentRolloutPhase,
  type HarnessRolloutConfig,
} from '@/server/stats/harnessRollout';

const baseConfig: HarnessRolloutConfig = {
  version: 'test',
  timezone: 'UTC',
  rolloutStart: '2026-03-09T00:00:00Z',
  baseline: {
    id: 'baseline-fixed',
    windowStart: '2026-02-07T00:00:00Z',
    windowEnd: '2026-03-08T23:59:59Z',
    source: 'github-snapshot',
  },
  owners: {
    rolloutGateOwnerVar: 'ROLLOUT_GATE_OWNER',
    goNoGoOwnerVar: 'GO_NO_GO_OWNER',
  },
  sla: {
    defaultHours: 24,
    overrideVar: 'ROLLOUT_SLA_HOURS',
  },
  phases: [
    {
      id: 'week-4',
      name: 'Week 4',
      start: '2026-03-30T00:00:00Z',
      end: '2026-04-05T23:59:59Z',
      mode: 'enforce',
      domains: ['core-api'],
      exitGates: [
        {
          id: 'first-pass-plus-15pct',
          label: 'First-pass improves by 15pct',
          windowDays: 30,
          metric: 'firstPassCiRate',
          operator: '>=',
          targetFromBaselineDelta: 0.15,
        },
      ],
    },
  ],
  goNoGo: {
    decisionDates: ['2026-04-05'],
    recommendationPolicy: {
      pass: 'go',
      fail: 'hold',
      unknown: 'hold',
    },
  },
};

describe('harness rollout evaluator', () => {
  it('resolves active phase by UTC date window', () => {
    const phase = resolveCurrentRolloutPhase(baseConfig, new Date('2026-04-03T12:00:00Z'));
    expect(phase?.id).toBe('week-4');
  });

  it('passes delta-vs-baseline gate when target is met', () => {
    const summary = evaluateHarnessRollout({
      config: baseConfig,
      baseline: {
        id: 'baseline-fixed',
        payload: { firstPassCiRate: 0.7 },
        createdAt: '2026-03-08T23:59:59Z',
        source: 'github-snapshot',
        hash: 'hash',
      },
      snapshotsByWindow: {
        30: {
          windowDays: 30,
          firstPassCiRate: 0.86,
          generatedAt: '2026-04-03T12:00:00Z',
          asyncFailureSlaBreaches: 0,
          leadTimeMedianHours: null,
          mergeThroughputPerWeek: null,
          flakyRate: null,
          revertRate: null,
          medianPrSize: null,
        },
      },
      now: new Date('2026-04-03T12:00:00Z'),
    });

    expect(summary.overallStatus).toBe('pass');
    expect(summary.recommendation).toBe('go');
    expect(summary.exitGates[0].status).toBe('pass');
    expect(summary.deltaVsBaseline.firstPassCiRate).toBe(0.16);
  });

  it('fails gate when delta target is not met', () => {
    const summary = evaluateHarnessRollout({
      config: baseConfig,
      baseline: {
        id: 'baseline-fixed',
        payload: { firstPassCiRate: 0.8 },
        createdAt: '2026-03-08T23:59:59Z',
        source: 'github-snapshot',
        hash: 'hash',
      },
      snapshotsByWindow: {
        30: {
          windowDays: 30,
          firstPassCiRate: 0.86,
          generatedAt: '2026-04-03T12:00:00Z',
          asyncFailureSlaBreaches: 0,
          leadTimeMedianHours: null,
          mergeThroughputPerWeek: null,
          flakyRate: null,
          revertRate: null,
          medianPrSize: null,
        },
      },
      now: new Date('2026-04-03T12:00:00Z'),
    });

    expect(summary.overallStatus).toBe('fail');
    expect(summary.recommendation).toBe('hold');
    expect(summary.exitGates[0].status).toBe('fail');
  });

  it('detects go/no-go decision dates', () => {
    expect(isGoNoGoDate(baseConfig, new Date('2026-04-05T07:00:00Z'))).toBe(true);
    expect(isGoNoGoDate(baseConfig, new Date('2026-04-04T07:00:00Z'))).toBe(false);
  });
});
