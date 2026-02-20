import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteAutomationRepository } from '@/server/automation/sqliteAutomationRepository';

function uniqueDbPath(name: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('automation repository', () => {
  const createdDbFiles: string[] = [];

  afterEach(() => {
    for (const dbFile of createdDbFiles.splice(0, createdDbFiles.length)) {
      if (fs.existsSync(dbFile)) {
        try {
          fs.unlinkSync(dbFile);
        } catch {
          // ignore brief Windows file locks
        }
      }
    }
  });

  it('creates and lists rules scoped by user', () => {
    const dbPath = uniqueDbPath('automation.repository.rules');
    createdDbFiles.push(dbPath);

    const repo = new SqliteAutomationRepository(dbPath);
    const rule = repo.createRule({
      userId: 'user-a',
      name: 'Morning briefing',
      cronExpression: '0 10 * * *',
      timezone: 'Europe/Berlin',
      prompt: 'Give me a briefing',
      enabled: true,
    });

    expect(rule.userId).toBe('user-a');
    expect(repo.listRules('user-a')).toHaveLength(1);
    expect(repo.listRules('user-b')).toHaveLength(0);

    repo.close();
  });

  it('deduplicates runs by run key', () => {
    const dbPath = uniqueDbPath('automation.repository.runs');
    createdDbFiles.push(dbPath);

    const repo = new SqliteAutomationRepository(dbPath);
    const rule = repo.createRule({
      userId: 'user-a',
      name: 'Every 10 min',
      cronExpression: '*/10 * * * *',
      timezone: 'UTC',
      prompt: 'Ping',
      enabled: true,
    });

    const runA = repo.createOrGetRun({
      ruleId: rule.id,
      userId: rule.userId,
      scheduledFor: '2026-02-11T10:00:00.000Z',
      triggerSource: 'manual',
      runKey: `${rule.id}:2026-02-11T10:00:00.000Z`,
    });
    const runB = repo.createOrGetRun({
      ruleId: rule.id,
      userId: rule.userId,
      scheduledFor: '2026-02-11T10:00:00.000Z',
      triggerSource: 'manual',
      runKey: `${rule.id}:2026-02-11T10:00:00.000Z`,
    });

    expect(runA.id).toBe(runB.id);
    expect(repo.listRuns(rule.id, rule.userId)).toHaveLength(1);

    repo.close();
  });

  it('uses a lease to guard scheduler singleton ownership', () => {
    const dbPath = uniqueDbPath('automation.repository.lease');
    createdDbFiles.push(dbPath);

    const repo = new SqliteAutomationRepository(dbPath);
    const now = '2026-02-11T10:00:00.000Z';
    const later = '2026-02-11T10:00:03.000Z';
    const expired = '2026-02-11T10:00:20.000Z';

    expect(repo.acquireLease('instance-a', 5_000, now)).toBe(true);
    expect(repo.acquireLease('instance-b', 5_000, later)).toBe(false);
    expect(repo.acquireLease('instance-b', 5_000, expired)).toBe(true);

    repo.close();
  });
});
