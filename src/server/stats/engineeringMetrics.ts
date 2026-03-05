export interface CompletedRunSignal {
  createdAt: string;
  completedAt: string;
  requiredRefinement: boolean;
}

export interface VerificationRunSignal {
  passed: boolean;
}

export interface AsyncFailureSignal {
  breachedSla: boolean;
}

export interface EngineeringSignalSet {
  windowDays: 7 | 30;
  completedRuns: CompletedRunSignal[];
  verificationRuns: VerificationRunSignal[];
  rollbackEvents: number;
  mergeSizedChanges: number[];
  asyncFailures: AsyncFailureSignal[];
}

export interface EngineeringMetricsSnapshot {
  windowDays: 7 | 30;
  leadTimeMedianHours: number | null;
  mergeThroughputPerWeek: number | null;
  firstPassCiRate: number | null;
  flakyRate: number | null;
  revertRate: number | null;
  medianPrSize: number | null;
  asyncFailureSlaBreaches: number;
  generatedAt: string;
  source?: 'snapshot' | 'fallback';
  snapshotAgeHours?: number | null;
  isFallback?: boolean;
  domainCoverage?: {
    activeDomains: number;
    coveredDomains: number;
    coverageRate: number | null;
    uncoveredDomains: string[];
  };
  scenarioSuccessRates?: Array<{
    scenario: string;
    successRate: number | null;
    totalRuns: number;
    flakySuspicions: number;
  }>;
  worktreeHarness?: {
    totalWorktrees: number;
    healthyWorktrees: number;
    successRate: number | null;
    unstableWorktrees: number;
  };
  criticalFailAutoReverts?: number;
  observability?: {
    laneSuccessRates: Array<{
      lane: string;
      successRate: number | null;
      medianDurationMs: number | null;
      flakySuspicions: number;
    }>;
  };
  rollout?: {
    phase: string | null;
    phaseWindow: {
      start: string | null;
      end: string | null;
    };
    mode: 'report-only' | 'enforce' | null;
    baselineId: string | null;
    overallStatus: 'pass' | 'fail' | 'unknown';
    recommendation: 'go' | 'hold' | 'rollback-hardening';
    exitGates: Array<{
      id: string;
      label: string;
      status: 'pass' | 'fail' | 'unknown';
      windowDays: 7 | 30;
      metric: string;
      operator: '>=' | '<=' | '>' | '<' | '==';
      expected: number | null;
      actual: number | null;
      detail: string;
    }>;
    deltaVsBaseline: {
      firstPassCiRate: number | null;
      revertRate: number | null;
      flakyRate: number | null;
      mergeThroughputPerWeek: number | null;
      medianPrSize: number | null;
    };
  };
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeMedian(values: number[]): number | null {
  const filtered = values
    .filter((value) => Number.isFinite(value))
    .map((value) => Number(value))
    .sort((left, right) => left - right);
  if (filtered.length === 0) return null;
  const middle = Math.floor(filtered.length / 2);
  if (filtered.length % 2 === 1) return filtered[middle];
  return (filtered[middle - 1] + filtered[middle]) / 2;
}

function parseIsoMs(value: string): number | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp;
}

function toLeadTimeHours(signal: CompletedRunSignal): number | null {
  const startMs = parseIsoMs(signal.createdAt);
  const endMs = parseIsoMs(signal.completedAt);
  if (startMs === null || endMs === null) return null;
  if (endMs < startMs) return null;
  return (endMs - startMs) / (60 * 60 * 1000);
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function safeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function computeEngineeringMetricsSnapshot(
  signals: EngineeringSignalSet,
  generatedAt = new Date().toISOString(),
): EngineeringMetricsSnapshot {
  const leadTimes = signals.completedRuns
    .map((signal) => toLeadTimeHours(signal))
    .filter((value): value is number => value !== null);
  const leadTimeMedian = safeMedian(leadTimes);

  const merges = safeCount(signals.completedRuns.length);
  const mergeThroughput = merges > 0 ? roundToTwo(merges / (Number(signals.windowDays) / 7)) : null;

  const firstPass = ratio(
    signals.verificationRuns.filter((signal) => signal.passed).length,
    signals.verificationRuns.length,
  );

  const flaky = ratio(
    signals.completedRuns.filter((signal) => signal.requiredRefinement).length,
    signals.completedRuns.length,
  );

  const reverted = safeCount(signals.rollbackEvents);
  const revert = ratio(reverted, Math.max(merges, signals.mergeSizedChanges.length));

  const medianPrSize = safeMedian(signals.mergeSizedChanges);

  const asyncFailureSlaBreaches = signals.asyncFailures.filter(
    (signal) => signal.breachedSla,
  ).length;

  return {
    windowDays: signals.windowDays,
    leadTimeMedianHours: leadTimeMedian === null ? null : roundToTwo(leadTimeMedian),
    mergeThroughputPerWeek: mergeThroughput,
    firstPassCiRate: firstPass === null ? null : roundToTwo(firstPass),
    flakyRate: flaky === null ? null : roundToTwo(flaky),
    revertRate: revert === null ? null : roundToTwo(revert),
    medianPrSize: medianPrSize === null ? null : Math.round(medianPrSize),
    asyncFailureSlaBreaches,
    generatedAt,
  };
}
