import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeGmailAction: vi.fn(),
  bridgeMasterAction: vi.fn(),
  getMasterRepository: vi.fn(() => ({})),
  resolveMasterUserId: vi.fn(async () => 'user-1'),
  resolveScopeFromRequest: vi.fn(() => ({
    userId: 'user-1',
    personaId: 'persona-1',
    workspaceId: 'workspace-1',
    personaWorkspaceRoot: 'C:/workspace',
    workspaceCwd: 'C:/workspace/projects/workspaces/workspace-1',
  })),
}));

vi.mock('@/server/master/connectors/gmail/actions', () => ({
  executeGmailAction: mocks.executeGmailAction,
}));
vi.mock('@/server/world-model/services/masterActionBridge', () => ({
  bridgeMasterAction: mocks.bridgeMasterAction,
}));
vi.mock('@/server/master/runtime', () => ({
  getMasterRepository: mocks.getMasterRepository,
}));
vi.mock('@/server/master/http', () => ({
  resolveMasterUserId: mocks.resolveMasterUserId,
  resolveScopeFromRequest: mocks.resolveScopeFromRequest,
}));

import { POST } from '../../../app/api/master/gmail/route';

describe('master Gmail route World-Model bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeGmailAction.mockResolvedValue({ ok: true, result: { id: 'gmail-1' } });
    mocks.bridgeMasterAction.mockImplementation(async (input) => {
      const executed = await input.run();
      return {
        attemptId: 'attempt-1',
        created: true,
        succeeded: executed.ok,
        replayed: false,
        result: executed.result,
        receipt: executed.receipt,
      };
    });
  });

  it('bridges an executed approved action and preserves its provider receipt', async () => {
    const response = await POST(
      new Request('http://localhost/api/master/gmail', {
        method: 'POST',
        body: JSON.stringify({
          personaId: 'persona-1',
          workspaceId: 'workspace-1',
          runId: 'run-1',
          stepId: 'step-1',
          action: 'send',
          decision: 'approve_once',
          draft: { to: 'recipient@example.com', subject: 'Subject', body: 'Body' },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, result: { id: 'gmail-1' } });
    expect(mocks.bridgeMasterAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        taskId: 'run-1',
        actionType: 'gmail.send',
        idempotencyKey: expect.stringContaining('run-1:step-1:gmail.send:'),
      }),
    );
    const bridgeInput = mocks.bridgeMasterAction.mock.calls[0][0];
    expect(bridgeInput.run).toBeTypeOf('function');
    expect(mocks.executeGmailAction).toHaveBeenCalledOnce();
    const runResult = await bridgeInput.run();
    expect(runResult.receipt).toMatchObject({
      providerId: 'gmail',
      target: 'recipient@example.com',
      payload: { action: 'send', result: { id: 'gmail-1' } },
    });
  });

  it('does not create an executed World-Model attempt while approval is pending', async () => {
    mocks.executeGmailAction.mockResolvedValueOnce({
      ok: false,
      approvalRequired: true,
      error: 'Approval required for gmail.send',
    });
    const response = await POST(
      new Request('http://localhost/api/master/gmail', {
        method: 'POST',
        body: JSON.stringify({
          personaId: 'persona-1',
          workspaceId: 'workspace-1',
          runId: 'run-2',
          stepId: 'step-2',
          action: 'send',
          draft: { to: 'recipient@example.com', subject: 'Subject', body: 'Body' },
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(mocks.bridgeMasterAction).not.toHaveBeenCalled();
    expect(mocks.executeGmailAction).toHaveBeenCalledOnce();
  });
});
