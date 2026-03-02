import crypto from 'node:crypto';
import { toDeadLetter, toRun } from '@/server/automation/automationRowMappers';
import type {
  AutomationDeadLetter,
  AutomationRun,
  CreateAutomationRunInput,
} from '@/server/automation/types';
import type { SqliteDb } from './types';

export function createOrGetRun(db: SqliteDb, input: CreateAutomationRunInput): AutomationRun {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  db.prepare(
    `
      INSERT INTO automation_runs (
        id, rule_id, user_id, trigger_source, scheduled_for,
        run_key, status, attempt, next_attempt_at,
        error_message, result_summary, started_at, finished_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?)
      ON CONFLICT(run_key) DO NOTHING
    `,
  ).run(
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

  const row = db
    .prepare('SELECT * FROM automation_runs WHERE run_key = ?')
    .get(input.runKey) as Record<string, unknown>;
  return toRun(row);
}

export function getRun(db: SqliteDb, runId: string): AutomationRun | null {
  const row = db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(runId) as
    | Record<string, unknown>
    | undefined;
  return row ? toRun(row) : null;
}

export function listRuns(
  db: SqliteDb,
  ruleId: string,
  userId: string,
  limit = 50,
): AutomationRun[] {
  const rows = db
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

export function listQueuedRunsDue(db: SqliteDb, nowIso: string, limit = 50): AutomationRun[] {
  const rows = db
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

export function markRunRunning(db: SqliteDb, runId: string, startedAt: string): void {
  db.prepare(
    `
      UPDATE automation_runs
      SET status = 'running', started_at = ?, error_message = NULL
      WHERE id = ?
    `,
  ).run(startedAt, runId);
}

export function markRunSucceeded(
  db: SqliteDb,
  runId: string,
  finishedAt: string,
  summary?: string,
): void {
  db.prepare(
    `
      UPDATE automation_runs
      SET status = 'succeeded', finished_at = ?, result_summary = ?, error_message = NULL
      WHERE id = ?
    `,
  ).run(finishedAt, summary || null, runId);
}

export function markRunForRetry(
  db: SqliteDb,
  runId: string,
  attempt: number,
  errorMessage: string,
  nextAttemptAt: string,
): void {
  db.prepare(
    `
      UPDATE automation_runs
      SET status = 'queued', attempt = ?, error_message = ?, next_attempt_at = ?, finished_at = NULL
      WHERE id = ?
    `,
  ).run(attempt, errorMessage, nextAttemptAt, runId);
}

export function markRunDeadLetter(
  db: SqliteDb,
  runId: string,
  errorMessage: string,
  finishedAt: string,
): void {
  db.prepare(
    `
      UPDATE automation_runs
      SET status = 'dead_letter', error_message = ?, finished_at = ?
      WHERE id = ?
    `,
  ).run(errorMessage, finishedAt, runId);
}

export function recordDeadLetter(
  db: SqliteDb,
  runId: string,
  ruleId: string,
  reason: string,
  payload?: string | null,
): AutomationDeadLetter {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `
      INSERT INTO automation_dead_letters (id, run_id, rule_id, reason, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(id, runId, ruleId, reason, payload || null, now);

  const row = db.prepare('SELECT * FROM automation_dead_letters WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return toDeadLetter(row);
}

export function countActiveRules(db: SqliteDb): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM automation_rules WHERE enabled = 1')
    .get() as { count: number };
  return Number(row.count || 0);
}

export function countRunsByStatus(db: SqliteDb, status: AutomationRun['status']): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM automation_runs WHERE status = ?')
    .get(status) as { count: number };
  return Number(row.count || 0);
}
