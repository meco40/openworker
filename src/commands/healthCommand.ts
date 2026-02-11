import { runHealthChecks } from './healthChecks';
import type {
  HealthCheck,
  HealthCheckStatus,
  HealthCommandOptions,
  HealthReport,
  HealthReportStatus,
  HealthSummary,
} from './healthTypes';

function aggregateSummary(checks: HealthCheck[]): HealthSummary {
  const summary: HealthSummary = { ok: 0, warning: 0, critical: 0, skipped: 0 };
  for (const check of checks) {
    summary[check.status] += 1;
  }
  return summary;
}

function toHealthStatus(summary: HealthSummary): HealthReportStatus {
  if (summary.critical > 0) return 'critical';
  if (summary.warning > 0) return 'degraded';
  return 'ok';
}

export async function runHealthCommand(options: HealthCommandOptions = {}): Promise<HealthReport> {
  const checks = await runHealthChecks(options);
  const summary = aggregateSummary(checks);
  return {
    status: toHealthStatus(summary),
    checks,
    summary,
    generatedAt: new Date().toISOString(),
  };
}

export type { HealthCheck, HealthCheckStatus, HealthCommandOptions, HealthReport, HealthReportStatus };
