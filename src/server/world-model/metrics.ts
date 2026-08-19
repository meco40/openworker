import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';
import { getWorldModelConfig } from '@/server/world-model/config';
import { checkGraphitiHealth } from '@/server/world-model/graphiti/client';

export interface WorldModelMetricsInput {
  pendingObservations: number;
  outboxAgeMs: number;
  outboxDeadLetters: number;
  dueOpenLoops: number;
  projectionLagMs: number;
}

export interface WorldModelMetrics {
  ingestionLagMs: number;
  pendingObservations: number;
  projectionLagMs: number;
  outboxAgeMs: number;
  outboxDeadLetters: number;
  dueOpenLoops: number;
  mode: string;
  graphitiReachable?: boolean;
  embeddingsTotal: number;
  embeddingsWithoutText: number;
  pendingProjections: number;
  failedProjections: number;
  deliveryReceipts: number;
}

export interface WorldModelAlertThresholds {
  outboxAgeMs: number;
  outboxDeadLetters: number;
  pendingObservations: number;
  pendingProjections: number;
  failedProjections: number;
  projectionLagMs: number;
}

export const DEFAULT_WM_ALERT_THRESHOLDS: WorldModelAlertThresholds = {
  outboxAgeMs: 5 * 60_000,
  outboxDeadLetters: 10,
  pendingObservations: 50,
  pendingProjections: 50,
  failedProjections: 0,
  projectionLagMs: 5 * 60_000,
};

/**
 * Phase 15: Stellt beobachtbare World-Model-Metriken zusammen.
 */
export function summarizeWorldModelMetrics(
  input: WorldModelMetricsInput,
  mode: string,
): WorldModelMetrics {
  return {
    ingestionLagMs: Math.max(0, input.projectionLagMs),
    pendingObservations: Math.max(0, input.pendingObservations),
    projectionLagMs: Math.max(0, input.projectionLagMs),
    outboxAgeMs: Math.max(0, input.outboxAgeMs),
    outboxDeadLetters: Math.max(0, input.outboxDeadLetters),
    dueOpenLoops: Math.max(0, input.dueOpenLoops),
    mode,
    embeddingsTotal: 0,
    embeddingsWithoutText: 0,
    pendingProjections: 0,
    failedProjections: 0,
    deliveryReceipts: 0,
  };
}

export function worldModelHealthStatus(metrics: WorldModelMetrics): 'healthy' | 'degraded' {
  const degraded =
    metrics.outboxDeadLetters > 0 ||
    metrics.failedProjections > 0 ||
    metrics.outboxAgeMs > DEFAULT_WM_ALERT_THRESHOLDS.outboxAgeMs ||
    metrics.pendingObservations > DEFAULT_WM_ALERT_THRESHOLDS.pendingObservations;
  return degraded ? 'degraded' : 'healthy';
}

export interface RawWorldModelMetrics {
  pendingObservations: number;
  outboxPending: number;
  outboxFailed: number;
  outboxAgeMs: number;
  dueOpenLoops: number;
  projectionLagMs: number;
  embeddingsTotal: number;
  embeddingsWithoutText: number;
  pendingProjections: number;
  failedProjections: number;
  deliveryReceipts: number;
}

/**
 * Liest die operativen World-Model-Metriken direkt aus PostgreSQL.
 * Diese Werte bilden die Grundlage für Health-Checks und Alerting.
 */
export async function collectWorldModelMetrics(
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<RawWorldModelMetrics> {
  const result: RawWorldModelMetrics = {
    pendingObservations: 0,
    outboxPending: 0,
    outboxFailed: 0,
    outboxAgeMs: 0,
    dueOpenLoops: 0,
    projectionLagMs: 0,
    embeddingsTotal: 0,
    embeddingsWithoutText: 0,
    pendingProjections: 0,
    failedProjections: 0,
    deliveryReceipts: 0,
  };

  try {
    const obsResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM world_model_observations
       WHERE received_at < now() - interval '5 minutes'`,
    );
    result.pendingObservations = Number(obsResult.rows[0]?.count ?? 0);
  } catch (error) {
    console.error('[world-model:metrics] pending observations query failed:', error);
  }

  try {
    const projectionResult = await db.query<{ pending: string; failed: string }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed
       FROM world_model_projection_pending`,
    );
    result.pendingProjections = Number(projectionResult.rows[0]?.pending ?? 0);
    result.failedProjections = Number(projectionResult.rows[0]?.failed ?? 0);
  } catch (error) {
    console.error('[world-model:metrics] pending projection query failed:', error);
  }

  try {
    const receiptResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM world_model_delivery_receipts`,
    );
    result.deliveryReceipts = Number(receiptResult.rows[0]?.count ?? 0);
  } catch (error) {
    console.error('[world-model:metrics] delivery receipt query failed:', error);
  }

  try {
    const outboxResult = await db.query<{
      pending: string;
      failed: string;
      oldest_age_ms: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         COALESCE(
           EXTRACT(EPOCH FROM (now() - MIN(created_at))) * 1000,
           0
         )::text AS oldest_age_ms
       FROM world_model_outbox_events
       WHERE status IN ('pending', 'failed')`,
    );
    result.outboxPending = Number(outboxResult.rows[0]?.pending ?? 0);
    result.outboxFailed = Number(outboxResult.rows[0]?.failed ?? 0);
    result.outboxAgeMs = Math.round(Number(outboxResult.rows[0]?.oldest_age_ms ?? 0));
  } catch (error) {
    console.error('[world-model:metrics] outbox query failed:', error);
  }

  try {
    const loopResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM world_model_open_loops
       WHERE status IN ('open', 'scheduled')
         AND (trigger_at IS NULL OR trigger_at <= now())`,
    );
    result.dueOpenLoops = Number(loopResult.rows[0]?.count ?? 0);
  } catch (error) {
    console.error('[world-model:metrics] open loops query failed:', error);
  }

  try {
    const lagResult = await db.query<{ max_lag_ms: string | null }>(
      `SELECT
         COALESCE(
           EXTRACT(EPOCH FROM (now() - MAX(received_at))) * 1000,
           0
         )::text AS max_lag_ms
       FROM world_model_observations`,
    );
    result.projectionLagMs = Math.round(Number(lagResult.rows[0]?.max_lag_ms ?? 0));
  } catch (error) {
    console.error('[world-model:metrics] projection lag query failed:', error);
  }

  try {
    const embResult = await db.query<{ total: string; without_text: string }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE target_content IS NULL OR target_content = '') AS without_text
       FROM world_model_embeddings`,
    );
    result.embeddingsTotal = Number(embResult.rows[0]?.total ?? 0);
    result.embeddingsWithoutText = Number(embResult.rows[0]?.without_text ?? 0);
  } catch (error) {
    console.error('[world-model:metrics] embeddings query failed:', error);
  }

  return result;
}

/**
 * Erzeugt aus den Roh-Metriken das öffentliche Metrics-Objekt.
 */
export async function getWorldModelMetrics(): Promise<WorldModelMetrics> {
  const config = getWorldModelConfig();
  const raw = await collectWorldModelMetrics();

  const metrics: WorldModelMetrics = {
    ingestionLagMs: raw.projectionLagMs,
    pendingObservations: raw.pendingObservations,
    projectionLagMs: raw.projectionLagMs,
    outboxAgeMs: raw.outboxAgeMs,
    outboxDeadLetters: raw.outboxFailed,
    dueOpenLoops: raw.dueOpenLoops,
    mode: config.mode,
    embeddingsTotal: raw.embeddingsTotal,
    embeddingsWithoutText: raw.embeddingsWithoutText,
    pendingProjections: raw.pendingProjections,
    failedProjections: raw.failedProjections,
    deliveryReceipts: raw.deliveryReceipts,
  };

  if (config.graphitiShadowEnabled) {
    try {
      const graphitiHealth = await checkGraphitiHealth();
      metrics.graphitiReachable = graphitiHealth.reachable;
    } catch {
      metrics.graphitiReachable = false;
    }
  }

  return metrics;
}

/**
 * Prüft, ob ein Alert für den aktuellen Zustand ausgelöst werden sollte.
 * Gibt die Liste der ausgelösten Alert-Regeln zurück.
 */
export function evaluateWorldModelAlerts(
  metrics: WorldModelMetrics,
  thresholds: WorldModelAlertThresholds = DEFAULT_WM_ALERT_THRESHOLDS,
): { rule: string; value: number; threshold: number }[] {
  const alerts: { rule: string; value: number; threshold: number }[] = [];

  if (metrics.outboxAgeMs > thresholds.outboxAgeMs) {
    alerts.push({
      rule: 'outbox_age',
      value: metrics.outboxAgeMs,
      threshold: thresholds.outboxAgeMs,
    });
  }
  if (metrics.outboxDeadLetters > thresholds.outboxDeadLetters) {
    alerts.push({
      rule: 'outbox_dead_letters',
      value: metrics.outboxDeadLetters,
      threshold: thresholds.outboxDeadLetters,
    });
  }
  if (metrics.pendingObservations > thresholds.pendingObservations) {
    alerts.push({
      rule: 'pending_observations',
      value: metrics.pendingObservations,
      threshold: thresholds.pendingObservations,
    });
  }
  if (metrics.pendingProjections > thresholds.pendingProjections) {
    alerts.push({
      rule: 'pending_projections',
      value: metrics.pendingProjections,
      threshold: thresholds.pendingProjections,
    });
  }
  if (metrics.failedProjections > thresholds.failedProjections) {
    alerts.push({
      rule: 'failed_projections',
      value: metrics.failedProjections,
      threshold: thresholds.failedProjections,
    });
  }
  if (metrics.projectionLagMs > thresholds.projectionLagMs) {
    alerts.push({
      rule: 'projection_lag',
      value: metrics.projectionLagMs,
      threshold: thresholds.projectionLagMs,
    });
  }

  return alerts;
}
