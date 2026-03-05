import { queryAll } from '@/lib/db';
import { getMasterRepository } from '@/server/master/runtime';
import type { WorkspaceScope } from '@/server/master/types';
import {
  computeEngineeringMetricsSnapshot,
  type AsyncFailureSignal,
  type CompletedRunSignal,
  type EngineeringMetricsSnapshot,
  type EngineeringSignalSet,
  type VerificationRunSignal,
} from '@/server/stats/engineeringMetrics';
import {
  getHarnessLaneStats,
  getLatestEngineeringSnapshot,
} from '@/server/stats/engineeringSnapshotRepository';

const ALLOWED_WINDOWS = new Set([7, 30]);
const DEFAULT_WORKSPACE_ID = 'default';
const ASYNC_FAILURE_SLA_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_STALE_MS = 26 * 60 * 60 * 1000;

interface MergeSizeRow {
  metadata: string | null;
}

interface AsyncFailureRow {
  status: string | null;
  updated_at: string | null;
  failed_at: string | null;
}

function parseIsoMs(value: string | null | undefined): number | null {
  const input = String(value || '').trim();
  if (!input) return null;
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function resolveScopes(userId: string, workspaceId: string | null): WorkspaceScope[] {
  if (workspaceId) {
    return [{ userId, workspaceId }];
  }

  const known = getMasterRepository()
    .listKnownScopes(500)
    .filter((scope) => scope.userId === userId);
  if (known.length > 0) {
    return known;
  }
  return [{ userId, workspaceId: DEFAULT_WORKSPACE_ID }];
}

function extractMergeSize(metadata: string | null): number | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const candidates = [
      parsed.linesChanged,
      parsed.changedLines,
      parsed.changed_lines,
      parsed.diffLines,
    ];
    for (const candidate of candidates) {
      const numeric = Number(candidate);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;
      return Math.round(numeric);
    }
  } catch {
    // Ignore malformed metadata rows.
  }
  return null;
}

function collectMergeSizedChanges(fromIso: string): number[] {
  const rows = queryAll<MergeSizeRow>(
    `SELECT metadata
     FROM task_activities
     WHERE activity_type IN ('completed', 'status_changed', 'test_passed')
       AND created_at >= ?`,
    [fromIso],
  );
  return rows
    .map((row) => extractMergeSize(row.metadata))
    .filter((value): value is number => typeof value === 'number');
}

function collectAsyncFailures(fromIso: string, nowMs: number): AsyncFailureSignal[] {
  const rows = queryAll<AsyncFailureRow>(
    `SELECT t.status, t.updated_at, MAX(a.created_at) AS failed_at
     FROM tasks t
     JOIN task_activities a ON a.task_id = t.id
     WHERE a.activity_type = 'test_failed'
       AND a.created_at >= ?
     GROUP BY t.id, t.status, t.updated_at`,
    [fromIso],
  );

  return rows.map((row) => {
    const failedAtMs = parseIsoMs(row.failed_at);
    const updatedAtMs = parseIsoMs(row.updated_at);
    const status = String(row.status || '')
      .trim()
      .toLowerCase();
    const closed = status === 'done' || status === 'review';
    const referenceMs = Math.max(failedAtMs ?? 0, updatedAtMs ?? 0);
    const breachedSla = !closed && referenceMs > 0 && nowMs - referenceMs > ASYNC_FAILURE_SLA_MS;
    return { breachedSla };
  });
}

function collectRunSignals(
  scopes: WorkspaceScope[],
  fromIso: string,
): {
  completedRuns: CompletedRunSignal[];
  verificationRuns: VerificationRunSignal[];
  rollbackEvents: number;
} {
  const fromMs = parseIsoMs(fromIso) ?? 0;
  const completedRuns: CompletedRunSignal[] = [];
  const verificationRuns: VerificationRunSignal[] = [];
  let rollbackEvents = 0;

  for (const scope of scopes) {
    const runs = getMasterRepository().listRuns(scope, 500);
    const filtered = runs.filter((run) => {
      if (run.status !== 'COMPLETED') return false;
      const completedMs = parseIsoMs(run.updatedAt);
      return completedMs !== null && completedMs >= fromMs;
    });

    for (const run of filtered) {
      completedRuns.push({
        createdAt: run.createdAt,
        completedAt: run.updatedAt,
        requiredRefinement: !run.verificationPassed,
      });
      verificationRuns.push({ passed: run.verificationPassed });
    }

    const auditEvents = getMasterRepository().listAuditEvents(scope, 1000);
    rollbackEvents += auditEvents.filter((event) => event.action.includes('rollback')).length;
  }

  return { completedRuns, verificationRuns, rollbackEvents };
}

export function parseWindowDays(raw: string | null): 7 | 30 {
  if (!raw) return 30;
  const parsed = Number.parseInt(raw, 10);
  if (!ALLOWED_WINDOWS.has(parsed)) {
    throw new Error('windowDays must be 7 or 30');
  }
  return parsed as 7 | 30;
}

export function collectEngineeringMetricsSnapshot(params: {
  userId: string;
  workspaceId: string | null;
  windowDays: 7 | 30;
  now?: Date;
}): EngineeringMetricsSnapshot {
  const now = params.now || new Date();
  const from = new Date(now.getTime() - params.windowDays * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString();
  const nowMs = now.getTime();

  const laneStats = getHarnessLaneStats(fromIso).map((row) => ({
    lane: row.lane,
    successRate:
      row.totalRuns <= 0 ? null : Math.round((row.successRuns / row.totalRuns) * 100) / 100,
    medianDurationMs: row.medianDurationMs,
    flakySuspicions: row.flakySuspicions,
  }));

  const latest = getLatestEngineeringSnapshot(params.windowDays);
  if (latest) {
    const generatedMs = parseIsoMs(latest.generatedAt);
    if (generatedMs !== null && nowMs - generatedMs <= SNAPSHOT_STALE_MS) {
      const payload = latest.payload;
      return {
        windowDays: params.windowDays,
        leadTimeMedianHours: numericOrNull(payload.leadTimeMedianHours),
        mergeThroughputPerWeek: numericOrNull(payload.mergeThroughputPerWeek),
        firstPassCiRate: numericOrNull(payload.firstPassCiRate),
        flakyRate: numericOrNull(payload.flakyRate),
        revertRate: numericOrNull(payload.revertRate),
        medianPrSize: integerOrNull(payload.medianPrSize),
        asyncFailureSlaBreaches: integerOrZero(payload.asyncFailureSlaBreaches),
        generatedAt: latest.generatedAt,
        source: 'snapshot',
        snapshotAgeHours: Math.round(((nowMs - generatedMs) / (60 * 60 * 1000)) * 100) / 100,
        isFallback: false,
        observability: {
          laneSuccessRates: laneStats,
        },
      };
    }
  }

  const scopes = resolveScopes(params.userId, params.workspaceId);
  const runSignals = collectRunSignals(scopes, fromIso);
  const signals: EngineeringSignalSet = {
    windowDays: params.windowDays,
    completedRuns: runSignals.completedRuns,
    verificationRuns: runSignals.verificationRuns,
    rollbackEvents: runSignals.rollbackEvents,
    mergeSizedChanges: collectMergeSizedChanges(fromIso),
    asyncFailures: collectAsyncFailures(fromIso, nowMs),
  };
  const computed = computeEngineeringMetricsSnapshot(signals, now.toISOString());
  return {
    ...computed,
    source: 'fallback',
    snapshotAgeHours:
      latest && parseIsoMs(latest.generatedAt) !== null
        ? Math.round(
            ((nowMs - (parseIsoMs(latest.generatedAt) || nowMs)) / (60 * 60 * 1000)) * 100,
          ) / 100
        : null,
    isFallback: true,
    observability: {
      laneSuccessRates: laneStats,
    },
  };
}

function numericOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function integerOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}
