import { describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import {
  clearOneTimeApprovalsForTests,
  registerOneTimeApproval,
  resolveRuntimeApproval,
} from '@/server/master/execution/approvalPolicy';

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
    registerOneTimeApproval(scope, 'shell.exec', 'shell.exec');

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
});
