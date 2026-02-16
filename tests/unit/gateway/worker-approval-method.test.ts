import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '../../../src/server/gateway/client-registry';

function makeClient(): GatewayClient {
  return {
    socket: {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    } as never,
    connId: 'conn-1',
    userId: 'user-1',
    connectedAt: Date.now(),
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    seq: 0,
  };
}

describe('worker.approval.respond bridge', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('forwards approval to openai runtime when token exists in checkpoint', async () => {
    const saveCheckpoint = vi.fn();
    const addApprovalRule = vi.fn();
    const submitOpenAiApproval = vi.fn().mockResolvedValue({ ok: true });
    const task = {
      id: 'task-1',
      status: 'waiting_approval',
      lastCheckpoint: JSON.stringify({ openaiApprovalToken: 'tok-1' }),
    };

    vi.doMock('../../../src/server/worker/workerRepository', () => ({
      getWorkerRepository: () => ({
        getTask: () => task,
        saveCheckpoint,
        addApprovalRule,
      }),
    }));
    vi.doMock('../../../src/server/worker/openai/openaiWorkerRuntime', () => ({
      submitOpenAiApproval,
    }));

    const { dispatchMethod } = await import('../../../src/server/gateway/method-router');
    await import('../../../src/server/gateway/methods/worker');

    const sent: unknown[] = [];
    await dispatchMethod(
      {
        type: 'req',
        id: 'req-1',
        method: 'worker.approval.respond',
        params: { taskId: 'task-1', approved: true },
      },
      makeClient(),
      (frame) => sent.push(frame),
    );

    expect(submitOpenAiApproval).toHaveBeenCalledWith('task-1', true, undefined);
    const res = sent[0] as { ok: boolean; payload?: Record<string, unknown> };
    expect(res.ok).toBe(true);
    expect(saveCheckpoint).toHaveBeenCalled();
  });
});
