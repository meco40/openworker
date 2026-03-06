import { describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import {
  applyApprovalDecision,
  createPendingApprovalRequest,
} from '@/server/master/approvals/service';
import {
  clearOneTimeApprovalsForTests,
  resolveRuntimeApproval,
} from '@/server/master/execution/approvalPolicy';
import { saveToolPolicy } from '@/server/master/toolPolicy/service';

describe('master runtime approval policy', () => {
  it('requires approval when no persistent or one-time decision exists', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };

    const result = resolveRuntimeApproval({
      repo,
      scope,
      actionType: 'shell.exec',
      fingerprint: 'shell.exec',
      requiresApproval: true,
    });
    expect(result.decision).toBe('awaiting_approval');

    repo.close();
  });

  it('consumes one-time approval exactly once', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    clearOneTimeApprovalsForTests();
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Approval run',
      contract: 'needs one approval',
    });
    const request = createPendingApprovalRequest({
      repo,
      scope,
      runId: run.id,
      stepId: 'step-1',
      actionType: 'shell.exec',
      summary: 'Run shell.exec once',
      host: 'gateway',
      cwd: 'D:/web/clawtest',
      resolvedPath: 'D:/web/clawtest',
      fingerprint: 'shell.exec',
      riskLevel: 'high',
    });
    applyApprovalDecision({
      repo,
      scope,
      requestId: request.id,
      decision: 'approve_once',
    });

    const first = resolveRuntimeApproval({
      repo,
      scope,
      actionType: 'shell.exec',
      fingerprint: 'shell.exec',
      requiresApproval: true,
    });
    const second = resolveRuntimeApproval({
      repo,
      scope,
      actionType: 'shell.exec',
      fingerprint: 'shell.exec',
      requiresApproval: true,
    });

    expect(first.decision).toBe('allowed');
    expect(second.decision).toBe('awaiting_approval');

    repo.close();
    clearOneTimeApprovalsForTests();
  });

  it('denies runtime actions when operator tool policy security is deny', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'deny',
        ask: 'off',
        allowlist: [],
        updatedBy: 'operator-user',
      },
    });

    const result = resolveRuntimeApproval({
      repo,
      scope,
      actionType: 'shell.exec',
      fingerprint: 'shell.exec',
      requiresApproval: false,
      toolName: 'shell_execute',
      host: 'gateway',
      targetContext: 'D:/web/clawtest',
    });

    expect(result.decision).toBe('denied');
    repo.close();
  });

  it('requires approval when operator allowlist misses and ask is on_miss', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: ['shell.exec:gateway:D:/safe/workspace:*'],
        updatedBy: 'operator-user',
      },
    });

    const result = resolveRuntimeApproval({
      repo,
      scope,
      actionType: 'shell.exec',
      fingerprint: 'shell.exec',
      requiresApproval: false,
      toolName: 'shell_execute',
      host: 'gateway',
      targetContext: 'D:/other/workspace',
    });

    expect(result.decision).toBe('awaiting_approval');
    repo.close();
  });
});
