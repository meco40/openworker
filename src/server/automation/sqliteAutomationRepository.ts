import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { AutomationRepository } from './repository';
import type {
  AutomationDeadLetter,
  AutomationRule,
  AutomationRun,
  CreateAutomationRuleInput,
  CreateAutomationRunInput,
  SchedulerLeaseState,
  UpdateAutomationRuleInput,
} from './types';

const LEASE_KEY = 'scheduler-singleton';

type SqlParam = string | number | null;

function toRule(row: Record<string, unknown>): AutomationRule {
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

function toRun(row: Record<string, unknown>): AutomationRun {
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

function toDeadLetter(row: Record<string, unknown>): AutomationDeadLetter {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    ruleId: row.rule_id as string,
    reason: row.reason as string,
    payload: (row.payload as string) || null,
    createdAt: row.created_at as string,
  };
}

function toLease(row: Record<string, unknown>): SchedulerLeaseState {
  return {
    singletonKey: row.singleton_key as string,
    instanceId: row.instance_id as string,
    heartbeatAt: row.heartbeat_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class SqliteAutomationRepository implements AutomationRepository {
  private readonly db: ReturnType<typeof Database>;

  constructor(dbPath = process.env.AUTOMATION_DB_PATH || '.local/automation.db') {
    if (dbPath === ':memory:') {
      this.db = new Database(':memory:');
    } else {
      const fullPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new Database(fullPath);
    }

    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_rules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        timezone TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        last_run_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automation_rules_user
        ON automation_rules (user_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_automation_rules_due
        ON automation_rules (enabled, next_run_at);

      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES automation_rules(id),
        user_id TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        run_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        error_message TEXT,
        result_summary TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automation_runs_rule
        ON automation_runs (rule_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_automation_runs_due
        ON automation_runs (status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS automation_dead_letters (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_scheduler_lease (
        singleton_key TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  createRule(input: CreateAutomationRuleInput): AutomationRule {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    this.db
      .prepare(
        `
        INSERT INTO automation_rules (
          id, user_id, name, cron_expression, timezone, prompt, enabled,
          next_run_at, last_run_at, consecutive_failures, last_error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)
      `,
      )
      .run(
        id,
        input.userId,
        input.name,
        input.cronExpression,
        input.timezone,
        input.prompt,
        input.enabled ? 1 : 0,
        input.nextRunAt || null,
        now,
        now,
      );

    return this.getRule(id, input.userId)!;
  }

  updateRule(ruleId: string, userId: string, patch: UpdateAutomationRuleInput): AutomationRule | null {
    const sets: string[] = [];
    const values: SqlParam[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.cronExpression !== undefined) {
      sets.push('cron_expression = ?');
      values.push(patch.cronExpression);
    }
    if (patch.timezone !== undefined) {
      sets.push('timezone = ?');
      values.push(patch.timezone);
    }
    if (patch.prompt !== undefined) {
      sets.push('prompt = ?');
      values.push(patch.prompt);
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(patch.enabled ? 1 : 0);
    }
    if (patch.nextRunAt !== undefined) {
      sets.push('next_run_at = ?');
      values.push(patch.nextRunAt);
    }
    if (patch.lastRunAt !== undefined) {
      sets.push('last_run_at = ?');
      values.push(patch.lastRunAt);
    }
    if (patch.consecutiveFailures !== undefined) {
      sets.push('consecutive_failures = ?');
      values.push(patch.consecutiveFailures);
    }
    if (patch.lastError !== undefined) {
      sets.push('last_error = ?');
      values.push(patch.lastError);
    }

    if (sets.length === 0) {
      return this.getRule(ruleId, userId);
    }

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(ruleId, userId);

    this.db
      .prepare(`UPDATE automation_rules SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...values);

    return this.getRule(ruleId, userId);
  }

  deleteRule(ruleId: string, userId: string): boolean {
    const existing = this.getRule(ruleId, userId);
    if (!existing) return false;

    this.db.prepare('DELETE FROM automation_dead_letters WHERE rule_id = ?').run(ruleId);
    this.db.prepare('DELETE FROM automation_runs WHERE rule_id = ?').run(ruleId);
    this.db.prepare('DELETE FROM automation_rules WHERE id = ? AND user_id = ?').run(ruleId, userId);
    return true;
  }

  getRule(ruleId: string, userId: string): AutomationRule | null {
    const row = this.db
      .prepare('SELECT * FROM automation_rules WHERE id = ? AND user_id = ?')
      .get(ruleId, userId) as Record<string, unknown> | undefined;
    return row ? toRule(row) : null;
  }

  getRuleById(ruleId: string): AutomationRule | null {
    const row = this.db
      .prepare('SELECT * FROM automation_rules WHERE id = ?')
      .get(ruleId) as Record<string, unknown> | undefined;
    return row ? toRule(row) : null;
  }

  listRules(userId: string): AutomationRule[] {
    const rows = this.db
      .prepare('SELECT * FROM automation_rules WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(toRule);
  }

  listDueRules(nowIso: string, limit = 50): AutomationRule[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM automation_rules
        WHERE enabled = 1
          AND next_run_at IS NOT NULL
          AND next_run_at <= ?
        ORDER BY next_run_at ASC
        LIMIT ?
      `,
      )
      .all(nowIso, limit) as Array<Record<string, unknown>>;
    return rows.map(toRule);
  }

  createOrGetRun(input: CreateAutomationRunInput): AutomationRun {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    this.db
      .prepare(
        `
        INSERT INTO automation_runs (
          id, rule_id, user_id, trigger_source, scheduled_for,
          run_key, status, attempt, next_attempt_at,
          error_message, result_summary, started_at, finished_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?)
        ON CONFLICT(run_key) DO NOTHING
      `,
      )
      .run(
        id,
        input.ruleId,
        input.userId,
        input.triggerSource,
        input.scheduledFor,
        input.runKey,
        input.attempt || 0,
        input.nextAttemptAt || now,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM automation_runs WHERE run_key = ?')
      .get(input.runKey) as Record<string, unknown>;
    return toRun(row);
  }

  getRun(runId: string): AutomationRun | null {
    const row = this.db
      .prepare('SELECT * FROM automation_runs WHERE id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    return row ? toRun(row) : null;
  }

  listRuns(ruleId: string, userId: string, limit = 50): AutomationRun[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM automation_runs
        WHERE rule_id = ? AND user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(ruleId, userId, limit) as Array<Record<string, unknown>>;

    return rows.map(toRun);
  }

  listQueuedRunsDue(nowIso: string, limit = 50): AutomationRun[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM automation_runs
        WHERE status = 'queued'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC
        LIMIT ?
      `,
      )
      .all(nowIso, limit) as Array<Record<string, unknown>>;

    return rows.map(toRun);
  }

  markRunRunning(runId: string, startedAt: string): AutomationRun | null {
    this.db
      .prepare(
        `
        UPDATE automation_runs
        SET status = 'running', started_at = ?, error_message = NULL
        WHERE id = ?
      `,
      )
      .run(startedAt, runId);
    return this.getRun(runId);
  }

  markRunSucceeded(runId: string, finishedAt: string, summary?: string): AutomationRun | null {
    this.db
      .prepare(
        `
        UPDATE automation_runs
        SET status = 'succeeded', finished_at = ?, result_summary = ?, error_message = NULL
        WHERE id = ?
      `,
      )
      .run(finishedAt, summary || null, runId);
    return this.getRun(runId);
  }

  markRunForRetry(
    runId: string,
    attempt: number,
    errorMessage: string,
    nextAttemptAt: string,
  ): AutomationRun | null {
    this.db
      .prepare(
        `
        UPDATE automation_runs
        SET status = 'queued', attempt = ?, error_message = ?, next_attempt_at = ?, finished_at = NULL
        WHERE id = ?
      `,
      )
      .run(attempt, errorMessage, nextAttemptAt, runId);
    return this.getRun(runId);
  }

  markRunDeadLetter(runId: string, errorMessage: string, finishedAt: string): AutomationRun | null {
    this.db
      .prepare(
        `
        UPDATE automation_runs
        SET status = 'dead_letter', error_message = ?, finished_at = ?
        WHERE id = ?
      `,
      )
      .run(errorMessage, finishedAt, runId);
    return this.getRun(runId);
  }

  recordDeadLetter(runId: string, ruleId: string, reason: string, payload?: string | null): AutomationDeadLetter {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO automation_dead_letters (id, run_id, rule_id, reason, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(id, runId, ruleId, reason, payload || null, now);

    const row = this.db
      .prepare('SELECT * FROM automation_dead_letters WHERE id = ?')
      .get(id) as Record<string, unknown>;
    return toDeadLetter(row);
  }

  countActiveRules(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM automation_rules WHERE enabled = 1')
      .get() as { count: number };
    return Number(row.count || 0);
  }

  countRunsByStatus(status: AutomationRun['status']): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM automation_runs WHERE status = ?')
      .get(status) as { count: number };
    return Number(row.count || 0);
  }

  acquireLease(instanceId: string, ttlMs: number, nowIso = new Date().toISOString()): boolean {
    const row = this.db
      .prepare('SELECT * FROM automation_scheduler_lease WHERE singleton_key = ?')
      .get(LEASE_KEY) as Record<string, unknown> | undefined;

    if (!row) {
      this.db
        .prepare(
          `
          INSERT INTO automation_scheduler_lease (singleton_key, instance_id, heartbeat_at, updated_at)
          VALUES (?, ?, ?, ?)
        `,
        )
        .run(LEASE_KEY, instanceId, nowIso, nowIso);
      return true;
    }

    const existing = toLease(row);
    const expiredAt = new Date(existing.updatedAt).getTime() + ttlMs;
    const now = new Date(nowIso).getTime();

    if (existing.instanceId === instanceId || now > expiredAt) {
      this.db
        .prepare(
          `
          UPDATE automation_scheduler_lease
          SET instance_id = ?, heartbeat_at = ?, updated_at = ?
          WHERE singleton_key = ?
        `,
        )
        .run(instanceId, nowIso, nowIso, LEASE_KEY);
      return true;
    }

    return false;
  }

  releaseLease(instanceId: string): void {
    this.db
      .prepare('DELETE FROM automation_scheduler_lease WHERE singleton_key = ? AND instance_id = ?')
      .run(LEASE_KEY, instanceId);
  }

  getLeaseState(): SchedulerLeaseState | null {
    const row = this.db
      .prepare('SELECT * FROM automation_scheduler_lease WHERE singleton_key = ?')
      .get(LEASE_KEY) as Record<string, unknown> | undefined;
    return row ? toLease(row) : null;
  }

  close(): void {
    this.db.close();
  }
}
