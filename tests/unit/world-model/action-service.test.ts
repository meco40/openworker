import { beforeEach, describe, expect, it, vi } from 'vitest';

let executeAction: typeof import('@/server/world-model/services/actionService').executeAction;

const start = vi.fn();
const finish = vi.fn();

vi.mock('@/server/world-model/repositories/actionAttemptRepository', () => ({
  startActionAttempt: (...args: unknown[]) => start(...args),
  finishActionAttempt: (...args: unknown[]) => finish(...args),
}));

const scope = { userId: 'u', personaId: 'p', workspaceId: 'w' };

describe('executeAction', () => {
  beforeEach(async () => {
    vi.doUnmock('@/server/world-model/services/actionService');
    vi.resetModules();
    executeAction = (await import('@/server/world-model/services/actionService')).executeAction;
    start.mockReset();
    finish.mockReset();
  });

  it('runs the action and marks it succeeded', async () => {
    start.mockResolvedValue({
      attempt: { id: 'a1', status: 'started' },
      created: true,
    });
    const result = await executeAction({
      scope,
      actionType: 'send_email',
      idempotencyKey: 'k1',
      run: async () => ({ ok: true }),
    });
    expect(result).toMatchObject({ attemptId: 'a1', created: true, succeeded: true });
    expect(finish).toHaveBeenCalledWith('a1', 'succeeded', undefined);
  });

  it('does not re-run a previous attempt (idempotency)', async () => {
    start.mockResolvedValue({
      attempt: { id: 'a-old', status: 'succeeded' },
      created: false,
    });
    const runSpy = vi.fn(async () => ({ ok: true }));
    const result = await executeAction({
      scope,
      actionType: 'send_email',
      idempotencyKey: 'same-key',
      run: runSpy,
    });
    expect(result.created).toBe(false);
    expect(runSpy).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('marks a failed run as failed', async () => {
    start.mockResolvedValue({
      attempt: { id: 'a2', status: 'started' },
      created: true,
    });
    const result = await executeAction({
      scope,
      actionType: 'send_email',
      idempotencyKey: 'k2',
      run: async () => ({ ok: false, error: 'SMTP down' }),
    });
    expect(result.succeeded).toBe(false);
    expect(result.error).toBe('SMTP down');
    expect(finish).toHaveBeenCalledWith('a2', 'failed', undefined);
  });
});
