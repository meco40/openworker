import type { CronLeaseState, CronMetrics, CronRule, CronRun } from '@/modules/cron/types';
import {
  CronMetricsPayload,
  CronRulesPayload,
  CronRunsPayload,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  MIN_HISTORY_LIMIT,
  OkPayload,
  RULE_LIMIT,
} from './types';

export function clampHistoryLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(MAX_HISTORY_LIMIT, Math.max(MIN_HISTORY_LIMIT, Math.floor(value)));
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function resolveLeaseAgeSeconds(
  lease: Partial<CronLeaseState> | null | undefined,
  metrics: Partial<CronMetrics> | undefined,
): number | null {
  if (typeof metrics?.leaseAgeSeconds === 'number') {
    return Math.max(0, Math.round(metrics.leaseAgeSeconds));
  }

  const leaseTimestamp = lease?.heartbeatAt ?? lease?.updatedAt;
  if (!leaseTimestamp) {
    return null;
  }

  const ageMs = Date.now() - Date.parse(leaseTimestamp);
  if (!Number.isFinite(ageMs)) {
    return null;
  }
  return Math.max(0, Math.round(ageMs / 1000));
}

async function readJson<T extends OkPayload>(response: Response): Promise<T> {
  const payload = (await response.json()) as T;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

export async function fetchRules(): Promise<CronRule[]> {
  const response = await fetch(`/api/automations?limit=${RULE_LIMIT}`, { cache: 'no-store' });
  const payload = await readJson<CronRulesPayload>(response);
  return Array.isArray(payload.rules) ? payload.rules : [];
}

export async function fetchMetrics(): Promise<CronMetrics> {
  const response = await fetch('/api/automations/metrics', { cache: 'no-store' });
  const payload = await readJson<CronMetricsPayload>(response);
  const metrics = payload.metrics || {};
  const lease = payload.leaseState ?? payload.lease;
  return {
    activeRules: typeof metrics.activeRules === 'number' ? metrics.activeRules : 0,
    queuedRuns: typeof metrics.queuedRuns === 'number' ? metrics.queuedRuns : 0,
    runningRuns: typeof metrics.runningRuns === 'number' ? metrics.runningRuns : 0,
    deadLetterRuns: typeof metrics.deadLetterRuns === 'number' ? metrics.deadLetterRuns : 0,
    leaseAgeSeconds: resolveLeaseAgeSeconds(lease, payload.metrics),
  };
}

export async function fetchRuns(ruleId: string, limit: number): Promise<CronRun[]> {
  const response = await fetch(
    `/api/automations/${encodeURIComponent(ruleId)}/runs?limit=${clampHistoryLimit(limit)}`,
    {
      cache: 'no-store',
    },
  );
  const payload = await readJson<CronRunsPayload>(response);
  return Array.isArray(payload.runs) ? payload.runs : [];
}

export async function readCronPayload<T extends OkPayload>(response: Response): Promise<T> {
  return readJson<T>(response);
}
