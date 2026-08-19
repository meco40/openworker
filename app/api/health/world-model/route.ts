import { NextResponse } from 'next/server';
import { getWorldModelConfig } from '@/server/world-model/config';
import { getWorldModelDb } from '@/server/world-model/db';
import {
  collectWorldModelMetrics,
  worldModelHealthStatus,
  evaluateWorldModelAlerts,
} from '@/server/world-model/metrics';
import { checkGraphitiHealth } from '@/server/world-model/graphiti/client';
import { getConfiguredEmbeddingProvider } from '@/server/world-model/embeddings/provider';

/**
 * GET /api/health/world-model
 *
 * Phase 15: World-Model-Health-Route.
 * Gibt den Gesundheitszustand des World Models zurück:
 * - PostgreSQL-Verbindung
 * - Migrations-Version
 * - Outbox-Status
 * - Embedding-Status
 * - Modus (off/shadow/required/canonical)
 * - Graphiti-Status (wenn aktiviert)
 * - Aktive Alerts
 */
export async function GET(): Promise<NextResponse> {
  const config = getWorldModelConfig();
  const checks: Record<string, { status: 'ok' | 'degraded' | 'unavailable'; detail?: string }> = {};
  let overall: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  // Check 1: World Model enabled?
  if (!config.enabled && !config.e2eEnabled) {
    return NextResponse.json(
      {
        status: 'unavailable',
        mode: config.mode,
        reason: 'World Model is not enabled',
        checks: {},
      },
      { status: 503 },
    );
  }

  // Check 2: PostgreSQL connectivity
  try {
    const db = getWorldModelDb();
    const result = await db.query<{ version: string }>('SELECT version()');
    checks.postgresql = {
      status: 'ok',
      detail: result.rows[0]?.version?.split(',')[0] ?? 'connected',
    };
  } catch (error) {
    checks.postgresql = {
      status: 'unavailable',
      detail: error instanceof Error ? error.message : 'connection failed',
    };
    overall = 'unhealthy';
  }

  // Check 3: Migration version
  try {
    const db = getWorldModelDb();
    const migrationResult = await db.query<{ id: string }>(
      `SELECT id FROM _world_model_migrations ORDER BY applied_at DESC LIMIT 1`,
    );
    checks.migrations = {
      status: migrationResult.rows.length > 0 ? 'ok' : 'degraded',
      detail: migrationResult.rows[0]?.id ?? 'no migrations found',
    };
    if (checks.migrations.status === 'degraded' && overall === 'healthy') {
      overall = 'degraded';
    }
  } catch (error) {
    checks.migrations = {
      status: 'unavailable',
      detail: error instanceof Error ? error.message : 'migration check failed',
    };
    overall = 'unhealthy';
  }

  // Check 4: Operational metrics (outbox, open loops, embeddings)
  let metrics;
  try {
    const db = getWorldModelDb();
    const raw = await collectWorldModelMetrics(db);
    metrics = {
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

    const health = worldModelHealthStatus(metrics);
    checks.metrics = {
      status: health === 'healthy' ? 'ok' : 'degraded',
      detail: `pending=${raw.outboxPending}, failed=${raw.outboxFailed}, pending_projection=${raw.pendingProjections}, failed_projection=${raw.failedProjections}, due_loops=${raw.dueOpenLoops}, lag=${raw.projectionLagMs}ms`,
    };

    if (health === 'degraded' && overall === 'healthy') {
      overall = 'degraded';
    }
  } catch (error) {
    checks.metrics = {
      status: 'degraded',
      detail: error instanceof Error ? error.message : 'metrics collection failed',
    };
    if (overall === 'healthy') overall = 'degraded';
  }

  // Check 5b: Failed projection queue must be visible independently of outbox.
  if (metrics && metrics.failedProjections > 0) {
    checks.projections = {
      status: 'degraded',
      detail: `pending=${metrics.pendingProjections}, failed=${metrics.failedProjections}`,
    };
    if (overall === 'healthy') overall = 'degraded';
  } else {
    checks.projections = {
      status: 'ok',
      detail: `pending=${metrics?.pendingProjections ?? 0}, failed=0`,
    };
  }

  // Check 5: Outbox status (detailliert)
  try {
    const db = getWorldModelDb();
    const outboxResult = await db.query<{
      pending: string;
      failed: string;
      oldest_age_seconds: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::text AS oldest_age_seconds
       FROM world_model_outbox_events
       WHERE status IN ('pending', 'failed')`,
    );
    const pending = Number(outboxResult.rows[0]?.pending ?? 0);
    const failed = Number(outboxResult.rows[0]?.failed ?? 0);
    const oldestAge = Number(outboxResult.rows[0]?.oldest_age_seconds ?? 0);

    if (failed > 10 || oldestAge > 3600) {
      checks.outbox = {
        status: 'degraded',
        detail: `pending=${pending}, failed=${failed}, oldest_age=${oldestAge}s`,
      };
      if (overall === 'healthy') overall = 'degraded';
    } else {
      checks.outbox = {
        status: 'ok',
        detail: `pending=${pending}, failed=${failed}`,
      };
    }
  } catch {
    checks.outbox = { status: 'degraded', detail: 'outbox check failed' };
    if (overall === 'healthy') overall = 'degraded';
  }

  // Check 6: Embedding status
  try {
    const db = getWorldModelDb();
    const embResult = await db.query<{ total: string; without_embedding: string }>(
      `SELECT
         (SELECT COUNT(*) FROM world_model_observations) AS total,
         (SELECT COUNT(*) FROM world_model_observations o
          WHERE NOT EXISTS (
            SELECT 1 FROM world_model_embeddings e
            WHERE e.target_type = 'observation' AND e.target_id = o.id
          )) AS without_embedding`,
    );
    const total = Number(embResult.rows[0]?.total ?? 0);
    const without = Number(embResult.rows[0]?.without_embedding ?? 0);
    const providerConfigured = Boolean(getConfiguredEmbeddingProvider());
    checks.embeddings = {
      status:
        total > 0 && without / total > 0.5 ? 'degraded' : providerConfigured ? 'ok' : 'degraded',
      detail: `${total - without}/${total} embedded; provider=${providerConfigured ? 'configured' : 'missing'}`,
    };
    if (checks.embeddings.status === 'degraded' && overall === 'healthy') {
      overall = 'degraded';
    }
  } catch {
    checks.embeddings = { status: 'degraded', detail: 'embedding check failed' };
    if (overall === 'healthy') overall = 'degraded';
  }

  // Check 7: Graphiti status (optional)
  if (config.graphitiShadowEnabled || config.graphitiBackendEnabled) {
    try {
      const graphitiHealth = await checkGraphitiHealth();
      checks.graphiti = {
        status: graphitiHealth.reachable ? 'ok' : 'degraded',
        detail: graphitiHealth.reachable
          ? `reachable, latency=${graphitiHealth.latencyMs}ms`
          : (graphitiHealth.error ?? 'unreachable'),
      };
      if (!graphitiHealth.reachable && overall === 'healthy') {
        overall = 'degraded';
      }
    } catch (error) {
      checks.graphiti = {
        status: 'degraded',
        detail: error instanceof Error ? error.message : 'graphiti check failed',
      };
      if (overall === 'healthy') overall = 'degraded';
    }
  } else {
    checks.graphiti = { status: 'ok', detail: 'shadow disabled' };
  }

  // Check 8: SQLite automation scheduler lease/heartbeat.
  try {
    const { getAutomationService } = await import('@/server/automation/runtime');
    const schedulerMetrics = getAutomationService().getMetrics();
    const leaseTtlMs = Number(process.env.AUTOMATION_LEASE_TTL_MS || 30_000);
    const leaseAgeSeconds = schedulerMetrics.leaseAgeSeconds;
    const leaseHealthy = leaseAgeSeconds !== null && leaseAgeSeconds * 1000 <= leaseTtlMs * 2;
    checks.scheduler = {
      status: leaseHealthy ? 'ok' : 'degraded',
      detail: `lease_age=${leaseAgeSeconds ?? 'missing'}s, active_rules=${schedulerMetrics.activeRules}, dead_letters=${schedulerMetrics.deadLetterRuns}`,
    };
    if (!leaseHealthy && overall === 'healthy') overall = 'degraded';
  } catch (error) {
    checks.scheduler = {
      status: 'unavailable',
      detail: error instanceof Error ? error.message : 'scheduler lease check failed',
    };
    if (overall === 'healthy') overall = 'degraded';
  }

  // Check 9: Mode
  checks.mode = {
    status: config.mode === 'canonical' ? 'ok' : 'ok',
    detail: config.mode,
  };

  const statusCode = overall === 'healthy' ? 200 : overall === 'degraded' ? 200 : 503;
  const alerts = metrics ? evaluateWorldModelAlerts(metrics) : [];

  return NextResponse.json(
    {
      status: overall,
      mode: config.mode,
      timestamp: new Date().toISOString(),
      checks,
      alerts,
    },
    { status: statusCode },
  );
}
