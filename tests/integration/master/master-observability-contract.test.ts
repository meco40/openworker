import { describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import { collectMasterMetrics } from '@/server/master/metrics';
import { MasterRemindersService } from '@/server/master/reminders';

describe('master observability contract', () => {
  it('emits approval, session, and reminder metrics', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'user-observability', workspaceId: 'ws-observability' };
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Observe runtime',
      contract: 'collect metrics',
    });

    repo.createApprovalRequest(scope, {
      runId: run.id,
      stepId: 'step-1',
      toolName: 'shell_execute',
      actionType: 'shell.exec',
      summary: 'Approve shell command',
      prompt: 'Run tests',
      host: 'gateway',
      cwd: 'D:/web/clawtest',
      resolvedPath: null,
      fingerprint: 'shell.exec:tests',
      riskLevel: 'medium',
      status: 'pending',
      expiresAt: '2026-03-07T12:00:00.000Z',
      decision: null,
      decisionReason: null,
      decidedAt: null,
    });

    repo.createSubagentSession(scope, {
      runId: run.id,
      status: 'running',
      title: 'Recover session',
      prompt: 'Resume stale work',
      assignedTools: ['read'],
      ownerId: 'worker-1',
      leaseExpiresAt: '2026-03-06T00:00:00.000Z',
      heartbeatAt: '2026-03-05T23:59:00.000Z',
      latestEventAt: null,
      resultSummary: null,
      lastError: null,
    });

    const reminders = new MasterRemindersService(repo, {
      now: () => new Date('2026-03-06T12:00:00.000Z'),
    });
    const reminder = reminders.create(scope, {
      title: 'Follow up',
      message: 'Send summary',
      remindAt: '2026-03-06T12:30:00.000Z',
    });
    reminders.fire(scope, reminder.id, {
      firedAt: '2026-03-06T12:30:00.000Z',
      source: 'api',
    });

    const metrics = collectMasterMetrics(repo, scope);

    expect(metrics).toMatchObject({
      approval_wait_time_p95_ms: expect.any(Number),
      approval_queue_age_p95_ms: expect.any(Number),
      expired_approvals_count: expect.any(Number),
      stuck_sessions_count: expect.any(Number),
      reminder_fire_success_rate: expect.any(Number),
      reminder_fire_drift_p95_ms: expect.any(Number),
      generated_at: expect.any(String),
    });

    repo.close();
  });
});
