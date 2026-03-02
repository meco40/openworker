import crypto from 'node:crypto';
import { toRule } from '@/server/automation/automationRowMappers';
import type {
  AutomationRule,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from '@/server/automation/types';
import type { FlowGraph } from '@/server/automation/flowTypes';
import type { SqlParam, SqliteDb } from './types';

export function createRule(db: SqliteDb, input: CreateAutomationRuleInput): string {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  db.prepare(
    `
      INSERT INTO automation_rules (
        id, user_id, name, cron_expression, timezone, prompt, enabled,
        next_run_at, last_run_at, consecutive_failures, last_error, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)
    `,
  ).run(
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

  return id;
}

export function updateRule(
  db: SqliteDb,
  ruleId: string,
  userId: string,
  patch: UpdateAutomationRuleInput,
): void {
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
    return;
  }

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(ruleId, userId);

  db.prepare(`UPDATE automation_rules SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(
    ...values,
  );
}

export function deleteRule(db: SqliteDb, ruleId: string): void {
  db.prepare('DELETE FROM automation_dead_letters WHERE rule_id = ?').run(ruleId);
  db.prepare('DELETE FROM automation_runs WHERE rule_id = ?').run(ruleId);
  db.prepare('DELETE FROM automation_rules WHERE id = ?').run(ruleId);
}

export function getRule(db: SqliteDb, ruleId: string, userId: string): AutomationRule | null {
  const row = db
    .prepare('SELECT * FROM automation_rules WHERE id = ? AND user_id = ?')
    .get(ruleId, userId) as Record<string, unknown> | undefined;
  return row ? toRule(row) : null;
}

export function getRuleById(db: SqliteDb, ruleId: string): AutomationRule | null {
  const row = db.prepare('SELECT * FROM automation_rules WHERE id = ?').get(ruleId) as
    | Record<string, unknown>
    | undefined;
  return row ? toRule(row) : null;
}

export function listRules(db: SqliteDb, userId: string): AutomationRule[] {
  const rows = db
    .prepare('SELECT * FROM automation_rules WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map(toRule);
}

export function listDueRules(db: SqliteDb, nowIso: string, limit = 50): AutomationRule[] {
  const rows = db
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

export function saveFlowGraph(
  db: SqliteDb,
  ruleId: string,
  userId: string,
  graph: FlowGraph,
): void {
  db.prepare(
    `UPDATE automation_rules SET flow_graph = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(JSON.stringify(graph), new Date().toISOString(), ruleId, userId);
}
