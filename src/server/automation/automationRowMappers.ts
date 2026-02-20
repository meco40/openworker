import type {
  AutomationDeadLetter,
  AutomationRule,
  AutomationRun,
  SchedulerLeaseState,
} from '@/server/automation/types';

export function toRule(row: Record<string, unknown>): AutomationRule {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    cronExpression: row.cron_expression as string,
    timezone: row.timezone as string,
    prompt: row.prompt as string,
    enabled: Number(row.enabled) === 1,
    nextRunAt: (row.next_run_at as string) || null,
    lastRunAt: (row.last_run_at as string) || null,
    consecutiveFailures: Number(row.consecutive_failures || 0),
    lastError: (row.last_error as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toRun(row: Record<string, unknown>): AutomationRun {
  return {
    id: row.id as string,
    ruleId: row.rule_id as string,
    userId: row.user_id as string,
    triggerSource: row.trigger_source as AutomationRun['triggerSource'],
    scheduledFor: row.scheduled_for as string,
    runKey: row.run_key as string,
    status: row.status as AutomationRun['status'],
    attempt: Number(row.attempt || 0),
    nextAttemptAt: (row.next_attempt_at as string) || null,
    errorMessage: (row.error_message as string) || null,
    resultSummary: (row.result_summary as string) || null,
    startedAt: (row.started_at as string) || null,
    finishedAt: (row.finished_at as string) || null,
    createdAt: row.created_at as string,
  };
}

export function toDeadLetter(row: Record<string, unknown>): AutomationDeadLetter {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    ruleId: row.rule_id as string,
    reason: row.reason as string,
    payload: (row.payload as string) || null,
    createdAt: row.created_at as string,
  };
}

export function toLease(row: Record<string, unknown>): SchedulerLeaseState {
  return {
    singletonKey: row.singleton_key as string,
    instanceId: row.instance_id as string,
    heartbeatAt: row.heartbeat_at as string,
    updatedAt: row.updated_at as string,
  };
}
