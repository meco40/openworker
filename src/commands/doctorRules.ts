import type { HealthCheck } from './healthTypes';

export type DoctorFindingSeverity = 'warning' | 'critical';

export interface DoctorFinding {
  id: 'security_critical' | 'bridge_unreachable' | 'error_spike' | 'task_backlog';
  severity: DoctorFindingSeverity;
  title: string;
  detail: string;
  recommendation: string;
}

interface BuildDoctorFindingsInput {
  checks: HealthCheck[];
  errorCountLast15m: number;
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
      severity:
        input.errorCountLast15m >= ERROR_SPIKE_CRITICAL_THRESHOLD ? 'critical' : 'warning',
      title: 'Error Spike Detected',
      detail: `${input.errorCountLast15m} error logs in the last 15 minutes.`,
      recommendation: 'Inspect recent error logs and correlate with recent deployments or outages.',
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
