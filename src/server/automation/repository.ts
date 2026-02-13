import type {
  AutomationDeadLetter,
  AutomationRule,
  AutomationRun,
  CreateAutomationRuleInput,
  CreateAutomationRunInput,
  SchedulerLeaseState,
  UpdateAutomationRuleInput,
} from './types';

export interface AutomationRepository {
  createRule(input: CreateAutomationRuleInput): AutomationRule;
  updateRule(
    ruleId: string,
    userId: string,
    patch: UpdateAutomationRuleInput,
  ): AutomationRule | null;
  deleteRule(ruleId: string, userId: string): boolean;
  getRule(ruleId: string, userId: string): AutomationRule | null;
  getRuleById(ruleId: string): AutomationRule | null;
  listRules(userId: string): AutomationRule[];
  listDueRules(nowIso: string, limit?: number): AutomationRule[];

  createOrGetRun(input: CreateAutomationRunInput): AutomationRun;
  getRun(runId: string): AutomationRun | null;
  listRuns(ruleId: string, userId: string, limit?: number): AutomationRun[];
  listQueuedRunsDue(nowIso: string, limit?: number): AutomationRun[];

  markRunRunning(runId: string, startedAt: string): AutomationRun | null;
  markRunSucceeded(runId: string, finishedAt: string, summary?: string): AutomationRun | null;
  markRunForRetry(
    runId: string,
    attempt: number,
    errorMessage: string,
    nextAttemptAt: string,
  ): AutomationRun | null;
  markRunDeadLetter(runId: string, errorMessage: string, finishedAt: string): AutomationRun | null;

  recordDeadLetter(
    runId: string,
    ruleId: string,
    reason: string,
    payload?: string | null,
  ): AutomationDeadLetter;

  countActiveRules(): number;
  countRunsByStatus(status: AutomationRun['status']): number;

  acquireLease(instanceId: string, ttlMs: number, nowIso?: string): boolean;
  releaseLease(instanceId: string): void;
  getLeaseState(): SchedulerLeaseState | null;

  close(): void;
}
