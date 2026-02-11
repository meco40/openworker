export type HealthReportStatus = 'ok' | 'degraded' | 'critical';
export type HealthCheckStatus = 'ok' | 'warning' | 'critical' | 'skipped';
export type HealthCheckCategory = 'core' | 'security' | 'integration' | 'diagnostics';

export interface HealthCheck {
  id: string;
  category: HealthCheckCategory;
  status: HealthCheckStatus;
  message: string;
  latencyMs: number;
  details?: Record<string, unknown>;
}

export interface HealthSummary {
  ok: number;
  warning: number;
  critical: number;
  skipped: number;
}

export interface HealthReport {
  status: HealthReportStatus;
  checks: HealthCheck[];
  summary: HealthSummary;
  generatedAt: string;
}

export interface HealthCommandOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
