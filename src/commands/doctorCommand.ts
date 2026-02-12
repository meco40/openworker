import { getLogRepository } from '../logging/logRepository';
import { getWorkerRepository } from '../server/worker/workerRepository';
import { runHealthCommand } from './healthCommand';
import { buildDoctorFindings, type DoctorFinding } from './doctorRules';
import type { HealthCheck, HealthCommandOptions, HealthReportStatus } from './healthTypes';

export interface DoctorReport {
  status: HealthReportStatus;
  checks: HealthCheck[];
  findings: DoctorFinding[];
  recommendations: string[];
  generatedAt: string;
}

const OPEN_TASK_STATUSES = new Set([
  'queued',
  'planning',
  'clarifying',
  'executing',
  'review',
  'waiting_approval',
]);

function resolveErrorCountLast15m(): number {
  const now = Date.now();
  const threshold = now - 15 * 60 * 1000;
  const logs = getLogRepository().listLogs({ level: 'error', limit: 2000 });
  return logs.filter((entry) => {
    const ts = Date.parse(entry.createdAt || entry.timestamp);
    return Number.isFinite(ts) && ts >= threshold;
  }).length;
}

function resolveErrorCountPrevious15m(): number {
  const now = Date.now();
  const upper = now - 15 * 60 * 1000;
  const lower = now - 30 * 60 * 1000;
  const logs = getLogRepository().listLogs({ level: 'error', limit: 2000 });
  return logs.filter((entry) => {
    const ts = Date.parse(entry.createdAt || entry.timestamp);
    return Number.isFinite(ts) && ts >= lower && ts < upper;
  }).length;
}

function resolveOpenTaskCount(): number {
  const tasks = getWorkerRepository().listTasks({ limit: 5000 });
  return tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)).length;
}

function resolveDoctorStatus(
  healthStatus: HealthReportStatus,
  findings: DoctorFinding[],
): HealthReportStatus {
  if (healthStatus === 'critical' || findings.some((finding) => finding.severity === 'critical')) {
    return 'critical';
  }
  if (healthStatus === 'degraded' || findings.length > 0) {
    return 'degraded';
  }
  return 'ok';
}

export async function runDoctorCommand(options: HealthCommandOptions = {}): Promise<DoctorReport> {
  const health = await runHealthCommand(options);
  const errorCountLast15m = resolveErrorCountLast15m();
  const errorCountPrevious15m = resolveErrorCountPrevious15m();
  const findings = buildDoctorFindings({
    checks: health.checks,
    errorCountLast15m,
    errorCountPrevious15m,
    openTaskCount: resolveOpenTaskCount(),
  });

  const recommendations = Array.from(
    new Set(findings.map((finding) => finding.recommendation).filter(Boolean)),
  );

  return {
    status: resolveDoctorStatus(health.status, findings),
    checks: health.checks,
    findings,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}
