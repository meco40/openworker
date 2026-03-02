import { toLease } from '@/server/automation/automationRowMappers';
import type { SchedulerLeaseState } from '@/server/automation/types';
import type { SqliteDb } from './types';

const LEASE_KEY = 'scheduler-singleton';

export function acquireLease(
  db: SqliteDb,
  instanceId: string,
  ttlMs: number,
  nowIso = new Date().toISOString(),
): boolean {
  const row = db
    .prepare('SELECT * FROM automation_scheduler_lease WHERE singleton_key = ?')
    .get(LEASE_KEY) as Record<string, unknown> | undefined;

  if (!row) {
    db.prepare(
      `
        INSERT INTO automation_scheduler_lease (singleton_key, instance_id, heartbeat_at, updated_at)
        VALUES (?, ?, ?, ?)
      `,
    ).run(LEASE_KEY, instanceId, nowIso, nowIso);
    return true;
  }

  const existing = toLease(row);
  const expiredAt = new Date(existing.updatedAt).getTime() + ttlMs;
  const now = new Date(nowIso).getTime();

  if (existing.instanceId === instanceId || now > expiredAt) {
    db.prepare(
      `
        UPDATE automation_scheduler_lease
        SET instance_id = ?, heartbeat_at = ?, updated_at = ?
        WHERE singleton_key = ?
      `,
    ).run(instanceId, nowIso, nowIso, LEASE_KEY);
    return true;
  }

  return false;
}

export function releaseLease(db: SqliteDb, instanceId: string): void {
  db.prepare(
    'DELETE FROM automation_scheduler_lease WHERE singleton_key = ? AND instance_id = ?',
  ).run(LEASE_KEY, instanceId);
}

export function getLeaseState(db: SqliteDb): SchedulerLeaseState | null {
  const row = db
    .prepare('SELECT * FROM automation_scheduler_lease WHERE singleton_key = ?')
    .get(LEASE_KEY) as Record<string, unknown> | undefined;
  return row ? toLease(row) : null;
}
