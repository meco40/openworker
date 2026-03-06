import { describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import {
  applyApprovalDecision,
  createPendingApprovalRequest,
} from '@/server/master/approvals/service';
import { resolveRuntimeApproval } from '@/server/master/execution/approvalPolicy';

describe('master approval service', () => {
  it('creates a pending request and consumes approve_once exactly once', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Approval run',
      contract: 'need approval',
    });

    const request = createPendingApprovalRequest({
      repo,
      scope,
      runId: run.id,
      stepId: 'step-1',
      actionType: 'shell.exec',
      summary: 'Run a shell command',
      host: 'gateway',
      cwd: 'D:/web/clawtest',
      resolvedPath: 'D:/web/clawtest',
      fingerprint: 'shell.exec:D:/web/clawtest',
      riskLevel: 'high',
    });
    expect(request.status).toBe('pending');

    const decided = applyApprovalDecision({
      repo,
      scope,
      requestId: request.id,
      decision: 'approve_once',
    });
    expect(decided.decision).toBe('approve_once');
    expect(decided.status).toBe('approved');

    const first = resolveRuntimeApproval({
      repo,
      scope,
      actionType: 'shell.exec',
      fingerprint: 'shell.exec:D:/web/clawtest',
      requiresApproval: true,
    });
    const second = resolveRuntimeApproval({
      repo,
      scope,
      actionType: 'shell.exec',
      fingerprint: 'shell.exec:D:/web/clawtest',
      requiresApproval: true,
    });

    expect(first.decision).toBe('allowed');
    expect(second.decision).toBe('awaiting_approval');
    repo.close();
  });
});
