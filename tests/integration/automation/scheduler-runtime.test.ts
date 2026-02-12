import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SqliteAutomationRepository } from '../../../src/server/automation/sqliteAutomationRepository';
import { AutomationService } from '../../../src/server/automation/service';
import { AutomationRuntime } from '../../../src/server/automation/runtime';

function uniqueDbPath(name: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('automation runtime', () => {
  const createdDbFiles: string[] = [];
  let repo: SqliteAutomationRepository;

  beforeEach(() => {
    const dbPath = uniqueDbPath('automation.runtime');
    createdDbFiles.push(dbPath);
    repo = new SqliteAutomationRepository(dbPath);
  });

  afterEach(() => {
    repo.close();
    vi.restoreAllMocks();
    for (const dbFile of createdDbFiles.splice(0, createdDbFiles.length)) {
      if (fs.existsSync(dbFile)) {
        try {
          fs.unlinkSync(dbFile);
        } catch {
          // ignore transient locks
        }
      }
    }
  });

  it('runs due rules and writes succeeded run entries', async () => {
    const service = new AutomationService(repo, {
      runPrompt: async () => ({ summary: 'done' }),
    });

    const rule = service.createRule({
      userId: 'legacy-local-user',
      name: 'Morning',
      cronExpression: '* * * * *',
      timezone: 'UTC',
      prompt: 'Briefing',
      enabled: true,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const runtime = new AutomationRuntime(service, {
      instanceId: 'scheduler-a',
      leaseTtlMs: 5_000,
      retryBackoffMs: [1, 1, 1],
      maxAttempts: 3,
    });

    await runtime.runOnce();

    const runs = service.listRuns(rule.id, rule.userId);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.status).toBe('succeeded');
  });

  it('moves repeated failures to dead-letter without crashing runtime', async () => {
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });

    const service = new AutomationService(repo, {
      runPrompt: failing,
    });

    const rule = service.createRule({
      userId: 'legacy-local-user',
      name: 'Failing',
      cronExpression: '* * * * *',
      timezone: 'UTC',
      prompt: 'Fail',
      enabled: true,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const runtime = new AutomationRuntime(service, {
      instanceId: 'scheduler-a',
      leaseTtlMs: 5_000,
      retryBackoffMs: [1, 1, 1],
      maxAttempts: 3,
    });

    await runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await runtime.runOnce();

    const runs = service.listRuns(rule.id, rule.userId);
    expect(runs[0]?.status).toBe('dead_letter');
    expect(failing).toHaveBeenCalled();
  });
});

