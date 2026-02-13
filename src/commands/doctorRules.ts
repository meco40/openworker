import type { HealthCheck } from './healthTypes';

export type DoctorFindingSeverity = 'warning' | 'critical';

export interface DoctorFinding {
  id:
    | 'security_critical'
    | 'security_warning'
    | 'bridge_unreachable'
    | 'error_trend_anomaly'
    | 'error_spike'
    | 'task_backlog';
  severity: DoctorFindingSeverity;
  title: string;
  detail: string;
  recommendation: string;
}

interface BuildDoctorFindingsInput {
  checks: HealthCheck[];
  errorCountLast15m: number;
  errorCountPrevious15m: number;
  openTaskCount: number;
}

const ERROR_SPIKE_WARNING_THRESHOLD = 5;
const ERROR_SPIKE_CRITICAL_THRESHOLD = 10;
const TASK_BACKLOG_WARNING_THRESHOLD = 20;

export function buildDoctorFindings(input: BuildDoctorFindingsInput): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  const securityCheck = input.checks.find((check) => check.id === 'security.snapshot');
  if (securityCheck?.status === 'critical') {
    findings.push({
      id: 'security_critical',
      severity: 'critical',
      title: 'Critical Security Findings',
      detail: securityCheck.message,
      recommendation:
        'Review `/api/security/status`, disable high-risk command permissions, and fix missing secrets.',
    });
  } else if (securityCheck?.status === 'warning') {
    findings.push({
      id: 'security_warning',
      severity: 'warning',
      title: 'Security Warnings Present',
      detail: securityCheck.message,
      recommendation:
        'Open `/api/security/status` and resolve the reported warnings before promoting to production.',
    });
  }

  const bridgeIssue = input.checks.find(
    (check) =>
      check.id.startsWith('integration.') &&
      check.id.endsWith('_bridge') &&
      (check.status === 'warning' || check.status === 'critical'),
  );
  if (bridgeIssue) {
    findings.push({
      id: 'bridge_unreachable',
      severity: bridgeIssue.status === 'critical' ? 'critical' : 'warning',
      title: 'Bridge Health Degraded',
      detail: bridgeIssue.message,
      recommendation: 'Verify bridge availability and credentials, then rerun health checks.',
    });
  }

  if (input.errorCountLast15m >= ERROR_SPIKE_WARNING_THRESHOLD) {
    findings.push({
      id: 'error_spike',
      severity: input.errorCountLast15m >= ERROR_SPIKE_CRITICAL_THRESHOLD ? 'critical' : 'warning',
      title: 'Error Spike Detected',
      detail: `${input.errorCountLast15m} error logs in the last 15 minutes.`,
      recommendation: 'Inspect recent error logs and correlate with recent deployments or outages.',
    });
  }

  if (
    input.errorCountLast15m >= 8 &&
    ((input.errorCountPrevious15m === 0 && input.errorCountLast15m >= 10) ||
      (input.errorCountPrevious15m > 0 &&
        input.errorCountLast15m >= input.errorCountPrevious15m * 2 &&
        input.errorCountLast15m - input.errorCountPrevious15m >= 5))
  ) {
    findings.push({
      id: 'error_trend_anomaly',
      severity:
        input.errorCountPrevious15m === 0
          ? 'critical'
          : input.errorCountLast15m >= input.errorCountPrevious15m * 3
            ? 'critical'
            : 'warning',
      title: 'Error Trend Anomaly',
      detail: `Error trend changed from ${input.errorCountPrevious15m} to ${input.errorCountLast15m} in consecutive 15-minute windows.`,
      recommendation:
        'Investigate recent deployments or upstream dependency changes and set temporary alert escalation.',
    });
  }

  if (input.openTaskCount > TASK_BACKLOG_WARNING_THRESHOLD) {
    findings.push({
      id: 'task_backlog',
      severity: 'warning',
      title: 'Worker Task Backlog',
      detail: `${input.openTaskCount} tasks are currently open.`,
      recommendation: 'Scale workers or reduce queue pressure before backlog impacts latency.',
    });
  }

  return findings;
}
