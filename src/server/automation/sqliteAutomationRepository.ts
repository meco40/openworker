import type BetterSqlite3 from 'better-sqlite3';
import type { AutomationRepository } from '@/server/automation/repository';
import type {
  AutomationDeadLetter,
  AutomationRule,
  AutomationRun,
  CreateAutomationRuleInput,
  CreateAutomationRunInput,
  SchedulerLeaseState,
  UpdateAutomationRuleInput,
} from '@/server/automation/types';
import type { FlowGraph } from '@/server/automation/flowTypes';
import { openSqliteDatabase } from '@/server/db/sqlite';
import {
  acquireLease,
  getLeaseState,
  releaseLease,
} from '@/server/automation/sqlite-automation-repository/lease';
import { migrateAutomationSchema } from '@/server/automation/sqlite-automation-repository/migration';
import {
  countActiveRules,
  countRunsByStatus,
  createOrGetRun,
  getRun,
  listQueuedRunsDue,
  listRuns,
  markRunDeadLetter,
  markRunForRetry,
  markRunRunning,
  markRunSucceeded,
  recordDeadLetter,
} from '@/server/automation/sqlite-automation-repository/runs';
import {
  createRule,
  deleteRule,
  getRule,
  getRuleById,
  listDueRules,
  listRules,
  saveFlowGraph,
  updateRule,
} from '@/server/automation/sqlite-automation-repository/rules';

export class SqliteAutomationRepository implements AutomationRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(dbPath = process.env.AUTOMATION_DB_PATH || '.local/automation.db') {
    this.db = openSqliteDatabase({ dbPath });
    migrateAutomationSchema(this.db);
  }

  createRule(input: CreateAutomationRuleInput): AutomationRule {
    const ruleId = createRule(this.db, input);
    const created = this.getRule(ruleId, input.userId);
    if (!created) {
      throw new Error('Failed to create automation rule.');
    }
    return created;
  }

  updateRule(
    ruleId: string,
    userId: string,
    patch: UpdateAutomationRuleInput,
  ): AutomationRule | null {
    const existing = getRule(this.db, ruleId, userId);
    if (!existing) return null;
    updateRule(this.db, ruleId, userId, patch);
    return getRule(this.db, ruleId, userId);
  }

  deleteRule(ruleId: string, userId: string): boolean {
    const existing = getRule(this.db, ruleId, userId);
    if (!existing) return false;
    deleteRule(this.db, ruleId);
    return true;
  }

  getRule(ruleId: string, userId: string): AutomationRule | null {
    return getRule(this.db, ruleId, userId);
  }

  getRuleById(ruleId: string): AutomationRule | null {
    return getRuleById(this.db, ruleId);
  }

  listRules(userId: string): AutomationRule[] {
    return listRules(this.db, userId);
  }

  listDueRules(nowIso: string, limit = 50): AutomationRule[] {
    return listDueRules(this.db, nowIso, limit);
  }

  getFlowGraph(ruleId: string, userId: string): FlowGraph | null {
    const rule = this.getRule(ruleId, userId);
    return rule?.flowGraph ?? null;
  }

  saveFlowGraph(ruleId: string, userId: string, graph: FlowGraph): AutomationRule | null {
    const existing = this.getRule(ruleId, userId);
    if (!existing) return null;
    saveFlowGraph(this.db, ruleId, userId, graph);
    return this.getRule(ruleId, userId);
  }

  createOrGetRun(input: CreateAutomationRunInput): AutomationRun {
    return createOrGetRun(this.db, input);
  }

  getRun(runId: string): AutomationRun | null {
    return getRun(this.db, runId);
  }

  listRuns(ruleId: string, userId: string, limit = 50): AutomationRun[] {
    return listRuns(this.db, ruleId, userId, limit);
  }

  listQueuedRunsDue(nowIso: string, limit = 50): AutomationRun[] {
    return listQueuedRunsDue(this.db, nowIso, limit);
  }

  markRunRunning(runId: string, startedAt: string): AutomationRun | null {
    markRunRunning(this.db, runId, startedAt);
    return this.getRun(runId);
  }

  markRunSucceeded(runId: string, finishedAt: string, summary?: string): AutomationRun | null {
    markRunSucceeded(this.db, runId, finishedAt, summary);
    return this.getRun(runId);
  }

  markRunForRetry(
    runId: string,
    attempt: number,
    errorMessage: string,
    nextAttemptAt: string,
  ): AutomationRun | null {
    markRunForRetry(this.db, runId, attempt, errorMessage, nextAttemptAt);
    return this.getRun(runId);
  }

  markRunDeadLetter(runId: string, errorMessage: string, finishedAt: string): AutomationRun | null {
    markRunDeadLetter(this.db, runId, errorMessage, finishedAt);
    return this.getRun(runId);
  }

  recordDeadLetter(
    runId: string,
    ruleId: string,
    reason: string,
    payload?: string | null,
  ): AutomationDeadLetter {
    return recordDeadLetter(this.db, runId, ruleId, reason, payload);
  }

  countActiveRules(): number {
    return countActiveRules(this.db);
  }

  countRunsByStatus(status: AutomationRun['status']): number {
    return countRunsByStatus(this.db, status);
  }

  acquireLease(instanceId: string, ttlMs: number, nowIso = new Date().toISOString()): boolean {
    return acquireLease(this.db, instanceId, ttlMs, nowIso);
  }

  releaseLease(instanceId: string): void {
    releaseLease(this.db, instanceId);
  }

  getLeaseState(): SchedulerLeaseState | null {
    return getLeaseState(this.db);
  }

  close(): void {
    this.db.close();
  }
}
