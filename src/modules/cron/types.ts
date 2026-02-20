export type CronRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead_letter'
  | 'skipped';

export interface CronRule {
  id: string;
  userId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CronRun {
  id: string;
  ruleId: string;
  userId: string;
  triggerSource: 'cron' | 'manual';
  scheduledFor: string;
  runKey: string;
  status: CronRunStatus;
  attempt: number;
  nextAttemptAt: string | null;
  errorMessage: string | null;
  resultSummary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface CronLeaseState {
  singletonKey: string;
  instanceId: string;
  heartbeatAt: string;
  updatedAt: string;
}

export interface CronMetrics {
  activeRules: number;
  queuedRuns: number;
  runningRuns: number;
  deadLetterRuns: number;
  leaseAgeSeconds: number | null;
}
