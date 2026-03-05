import fs from 'node:fs';
import path from 'node:path';
import type { EngineeringMetricsSnapshot } from '@/server/stats/engineeringMetrics';

export type RolloutMode = 'report-only' | 'enforce';
export type RolloutGateStatus = 'pass' | 'fail' | 'unknown';
export type RolloutRecommendation = 'go' | 'hold' | 'rollback-hardening';

export interface RolloutGateDefinition {
  id: string;
  label: string;
  windowDays: 7 | 30;
  metric: string;
  operator: '>=' | '<=' | '>' | '<' | '==';
  target?: number;
  targetFromBaselineDelta?: number;
}

export interface RolloutPhaseDefinition {
  id: string;
  name: string;
  start: string;
  end: string;
  mode: RolloutMode;
  domains: string[];
  exitGates: RolloutGateDefinition[];
}

export interface HarnessRolloutConfig {
  version: string;
  timezone: string;
  rolloutStart: string;
  baseline: {
    id: string;
    windowStart: string;
    windowEnd: string;
    source: string;
  };
  owners: {
    rolloutGateOwnerVar: string;
    goNoGoOwnerVar: string;
  };
  sla: {
    defaultHours: number;
    overrideVar: string;
  };
  phases: RolloutPhaseDefinition[];
  goNoGo: {
    decisionDates: string[];
    recommendationPolicy: {
      pass: RolloutRecommendation;
      fail: RolloutRecommendation;
      unknown: RolloutRecommendation;
    };
  };
}

export interface RolloutGateResult {
  id: string;
  label: string;
  status: RolloutGateStatus;
  windowDays: 7 | 30;
  metric: string;
  operator: RolloutGateDefinition['operator'];
  expected: number | null;
  actual: number | null;
  detail: string;
}

export interface RolloutSummary {
  phase: string | null;
  phaseWindow: {
    start: string | null;
    end: string | null;
  };
  mode: RolloutMode | null;
  baselineId: string | null;
  overallStatus: RolloutGateStatus;
  recommendation: RolloutRecommendation;
  exitGates: RolloutGateResult[];
  deltaVsBaseline: {
    firstPassCiRate: number | null;
    revertRate: number | null;
    flakyRate: number | null;
    mergeThroughputPerWeek: number | null;
    medianPrSize: number | null;
  };
}

export interface RolloutBaselineRecord {
  id: string;
  payload: Record<string, unknown>;
  createdAt: string;
  source: string;
  hash: string;
}

const CONFIG_PATH = path.resolve(process.cwd(), 'config/harness-rollout-gates.json');

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPathValue(input: unknown, dotPath: string): unknown {
  const parts = dotPath
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  let current: unknown = input;
  for (const part of parts) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
}

function compare(
  operator: RolloutGateDefinition['operator'],
  left: number,
  right: number,
): boolean {
  if (operator === '>=') return left >= right;
  if (operator === '<=') return left <= right;
  if (operator === '>') return left > right;
  if (operator === '<') return left < right;
  return left === right;
}

function chooseOverallStatus(gates: RolloutGateResult[]): RolloutGateStatus {
  if (gates.some((gate) => gate.status === 'fail')) return 'fail';
  if (gates.some((gate) => gate.status === 'unknown')) return 'unknown';
  return 'pass';
}

function toMetricsRecord(
  snapshot: EngineeringMetricsSnapshot | Record<string, unknown>,
): Record<string, unknown> {
  if ('windowDays' in snapshot) {
    return snapshot as unknown as Record<string, unknown>;
  }
  return snapshot;
}

function metricDelta(
  current: Record<string, unknown> | null,
  baseline: Record<string, unknown> | null,
  metric: string,
): number | null {
  if (!current || !baseline) return null;
  const currentValue = safeNumber(getPathValue(current, metric));
  const baselineValue = safeNumber(getPathValue(baseline, metric));
  if (currentValue === null || baselineValue === null) return null;
  return Math.round((currentValue - baselineValue) * 10000) / 10000;
}

export function loadHarnessRolloutConfig(): HarnessRolloutConfig {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw) as HarnessRolloutConfig;
}

export function resolveCurrentRolloutPhase(
  config: HarnessRolloutConfig,
  now: Date,
): RolloutPhaseDefinition | null {
  const nowMs = now.getTime();
  for (const phase of config.phases) {
    const startMs = Date.parse(phase.start);
    const endMs = Date.parse(phase.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (nowMs >= startMs && nowMs <= endMs) {
      return phase;
    }
  }
  return null;
}

export function isGoNoGoDate(config: HarnessRolloutConfig, now: Date): boolean {
  const isoDate = now.toISOString().slice(0, 10);
  return config.goNoGo.decisionDates.includes(isoDate);
}

export function evaluateHarnessRollout(params: {
  config: HarnessRolloutConfig;
  snapshotsByWindow: Partial<Record<7 | 30, EngineeringMetricsSnapshot | Record<string, unknown>>>;
  baseline: RolloutBaselineRecord | null;
  now?: Date;
}): RolloutSummary {
  const now = params.now || new Date();
  const phase = resolveCurrentRolloutPhase(params.config, now);
  const baselinePayload = params.baseline?.payload || null;

  if (!phase) {
    return {
      phase: null,
      phaseWindow: { start: null, end: null },
      mode: null,
      baselineId: params.baseline?.id || params.config.baseline.id,
      overallStatus: 'unknown',
      recommendation: 'hold',
      exitGates: [],
      deltaVsBaseline: {
        firstPassCiRate: null,
        revertRate: null,
        flakyRate: null,
        mergeThroughputPerWeek: null,
        medianPrSize: null,
      },
    };
  }

  const gateResults: RolloutGateResult[] = phase.exitGates.map((gate) => {
    const snapshot = params.snapshotsByWindow[gate.windowDays]
      ? toMetricsRecord(params.snapshotsByWindow[gate.windowDays] as EngineeringMetricsSnapshot)
      : null;

    if (!snapshot) {
      return {
        id: gate.id,
        label: gate.label,
        status: 'unknown',
        windowDays: gate.windowDays,
        metric: gate.metric,
        operator: gate.operator,
        expected: null,
        actual: null,
        detail: `No snapshot available for window ${gate.windowDays}d.`,
      };
    }

    const actual = safeNumber(getPathValue(snapshot, gate.metric));
    if (actual === null) {
      return {
        id: gate.id,
        label: gate.label,
        status: 'unknown',
        windowDays: gate.windowDays,
        metric: gate.metric,
        operator: gate.operator,
        expected: null,
        actual: null,
        detail: `Metric ${gate.metric} missing in ${gate.windowDays}d snapshot.`,
      };
    }

    let expected: number | null = safeNumber(gate.target);
    if (expected === null && gate.targetFromBaselineDelta !== undefined) {
      const baselineValue = safeNumber(getPathValue(baselinePayload, gate.metric));
      if (baselineValue === null) {
        return {
          id: gate.id,
          label: gate.label,
          status: 'unknown',
          windowDays: gate.windowDays,
          metric: gate.metric,
          operator: gate.operator,
          expected: null,
          actual,
          detail: `Baseline metric ${gate.metric} missing for delta-based gate.`,
        };
      }
      expected = baselineValue + Number(gate.targetFromBaselineDelta);
    }

    if (expected === null) {
      return {
        id: gate.id,
        label: gate.label,
        status: 'unknown',
        windowDays: gate.windowDays,
        metric: gate.metric,
        operator: gate.operator,
        expected: null,
        actual,
        detail: 'Gate target is missing.',
      };
    }

    const passed = compare(gate.operator, actual, expected);
    return {
      id: gate.id,
      label: gate.label,
      status: passed ? 'pass' : 'fail',
      windowDays: gate.windowDays,
      metric: gate.metric,
      operator: gate.operator,
      expected: Math.round(expected * 10000) / 10000,
      actual: Math.round(actual * 10000) / 10000,
      detail: passed ? 'Gate passed.' : 'Gate failed.',
    };
  });

  const overallStatus = chooseOverallStatus(gateResults);
  const recommendation = params.config.goNoGo.recommendationPolicy[overallStatus];

  const snapshot30 = params.snapshotsByWindow[30]
    ? toMetricsRecord(params.snapshotsByWindow[30] as EngineeringMetricsSnapshot)
    : null;
  const snapshot7 = params.snapshotsByWindow[7]
    ? toMetricsRecord(params.snapshotsByWindow[7] as EngineeringMetricsSnapshot)
    : null;

  return {
    phase: phase.id,
    phaseWindow: {
      start: phase.start,
      end: phase.end,
    },
    mode: phase.mode,
    baselineId: params.baseline?.id || params.config.baseline.id,
    overallStatus,
    recommendation,
    exitGates: gateResults,
    deltaVsBaseline: {
      firstPassCiRate: metricDelta(snapshot30, baselinePayload, 'firstPassCiRate'),
      revertRate: metricDelta(snapshot30, baselinePayload, 'revertRate'),
      flakyRate: metricDelta(snapshot7 || snapshot30, baselinePayload, 'flakyRate'),
      mergeThroughputPerWeek: metricDelta(snapshot30, baselinePayload, 'mergeThroughputPerWeek'),
      medianPrSize: metricDelta(snapshot30, baselinePayload, 'medianPrSize'),
    },
  };
}
