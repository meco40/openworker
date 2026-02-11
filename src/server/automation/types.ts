export type AutomationTriggerSource = 'cron' | 'manual';

export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead_letter'
  | 'skipped';

export interface AutomationRule {
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

export interface AutomationRun {
  id: string;
  ruleId: string;
  userId: string;
  triggerSource: AutomationTriggerSource;
  scheduledFor: string;
  runKey: string;
  status: AutomationRunStatus;
  attempt: number;
  nextAttemptAt: string | null;
  errorMessage: string | null;
  resultSummary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface AutomationDeadLetter {
  id: string;
  runId: string;
  ruleId: string;
  reason: string;
  payload: string | null;
  createdAt: string;
}

export interface SchedulerLeaseState {
  singletonKey: string;
  instanceId: string;
  heartbeatAt: string;
  updatedAt: string;
}

export interface CreateAutomationRuleInput {
  userId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRunAt?: string | null;
}

export interface UpdateAutomationRuleInput {
  name?: string;
  cronExpression?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  consecutiveFailures?: number;
  lastError?: string | null;
}

export interface CreateAutomationRunInput {
  ruleId: string;
  userId: string;
  triggerSource: AutomationTriggerSource;
  scheduledFor: string;
  runKey: string;
  attempt?: number;
  nextAttemptAt?: string | null;
}
