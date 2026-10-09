import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenLoopRecord } from '@/server/world-model/types';

let deliverDueOpenLoops: typeof import('@/server/world-model/services/openLoopService').deliverDueOpenLoops;

const listDue = vi.fn();
const claim = vi.fn();
const countToday = vi.fn();
const markAsked = vi.fn();
const enqueue = vi.fn();
const releaseLease = vi.fn();
const enqueueOutbox = vi.fn();
const updateStatus = vi.fn();
const transactionDb = { query: vi.fn() };
const withTransaction = vi.fn((callback: (db: typeof transactionDb) => Promise<unknown>) =>
  callback(transactionDb),
);
const getConfig = vi.fn(() => ({
  enabled: false,
  dailyProactiveBudget: 10,
  quietHours: null,
  userActiveWindowMs: 300_000,
}));

vi.mock('@/server/world-model/repositories/prospectiveRepository', () => ({
  listDueOpenLoops: (...args: unknown[]) => listDue(...args),
  claimDueOpenLoop: (...args: unknown[]) => claim(...args),
  countAskedOpenLoopsToday: (...args: unknown[]) => countToday(...args),
  markOpenLoopAsked: (...args: unknown[]) => markAsked(...args),
  releaseOpenLoopLease: (...args: unknown[]) => releaseLease(...args),
  updateOpenLoopStatus: (...args: unknown[]) => updateStatus(...args),
}));

vi.mock('@/server/world-model/repositories/outboxRepository', () => ({
  enqueueOutboxEvent: (...args: unknown[]) => enqueueOutbox(...args),
}));

vi.mock('@/server/world-model/config', () => ({
  getWorldModelConfig: () => getConfig(),
}));

vi.mock('@/server/world-model/db', () => ({
  withWorldModelTransaction: (callback: (db: typeof transactionDb) => Promise<unknown>) =>
    withTransaction(callback),
}));

let openLoopService: typeof import('@/server/world-model/services/openLoopService');

function openLoop(partial: Partial<OpenLoopRecord>): OpenLoopRecord {
  return {
    id: 'loop-1',
    userId: 'u',
    personaId: 'p',
    workspaceId: 'w',
    type: 'event_outcome',
    status: 'open',
    attempts: 0,
    importance: 2,
    deduplicationKey: 'k',
    maxAttempts: 3,
    createdAt: '2026-08-18T11:00:00.000Z',
    updatedAt: '2026-08-18T11:00:00.000Z',
    ...partial,
  };
}

describe('deliverDueOpenLoops', () => {
  beforeEach(async () => {
    vi.doUnmock('@/server/world-model/services/openLoopService');
    vi.resetModules();
    openLoopService = await import('@/server/world-model/services/openLoopService');
    deliverDueOpenLoops = openLoopService.deliverDueOpenLoops;
    listDue.mockReset();
    claim.mockReset();
    countToday.mockReset();
    markAsked.mockReset();
    enqueue.mockReset();
    releaseLease.mockReset();
    countToday.mockResolvedValue(0);
    enqueueOutbox.mockReset().mockResolvedValue({ id: 'outbox-1' });
    updateStatus.mockReset();
    withTransaction.mockReset().mockImplementation((callback) => callback(transactionDb));
    getConfig.mockReset().mockReturnValue({
      enabled: false,
      dailyProactiveBudget: 10,
      quietHours: null,
      userActiveWindowMs: 300_000,
    });
  });

  it('delivers due open loops and marks them asked', async () => {
    const loop = openLoop({});
    listDue.mockResolvedValue([loop]);
    claim.mockResolvedValue(loop);
    const markAskedFn = vi.fn(async () => {});
    const result = await deliverDueOpenLoops('u', 'p', {
      listDueOpenLoops: listDue,
      claimDueOpenLoop: claim,
      markAsked: markAskedFn,
      enqueueDelivery: enqueue,
      deliver: async () => ({ ok: true }),
      decideDelivery: () => ({ allow: true, reason: 'allow' as const }),
      now: () => '2026-08-18T12:00:00.000Z',
      releaseLease,
    });
    expect(result.delivered).toBe(1);
    expect(markAskedFn).toHaveBeenCalledWith(loop.id, '2026-08-18T12:00:00.000Z');
    expect(enqueue).toHaveBeenCalledWith(loop);
  });

  it('rejects loops blocked by policy without enqueueing', async () => {
    const loop = openLoop({});
    listDue.mockResolvedValue([loop]);
    claim.mockResolvedValue(loop);
    const result = await deliverDueOpenLoops('u', 'p', {
      listDueOpenLoops: listDue,
      claimDueOpenLoop: claim,
      decideDelivery: () => ({ allow: false, reason: 'quiet_time' as const }),
      now: () => '2026-08-18T12:00:00.000Z',
    });
    expect(result.rejected).toBe(1);
    expect(result.reasons.quiet_time).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledWith(loop.id, '2026-08-18T12:01:00.000Z');
  });

  it('counts failed delivery', async () => {
    const loop = openLoop({});
    listDue.mockResolvedValue([loop]);
    claim.mockResolvedValue(loop);
    const result = await deliverDueOpenLoops('u', 'p', {
      listDueOpenLoops: listDue,
      claimDueOpenLoop: claim,
      decideDelivery: () => ({ allow: true, reason: 'allow' as const }),
      deliver: async () => ({ ok: false }),
      now: () => '2026-08-18T12:00:00.000Z',
      releaseLease,
    });
    expect(result.failed).toBe(1);
    expect(result.reasons.delivery_failed).toBe(1);
  });

  it('uses repository defaults and enqueues when only a workspace and clock are supplied', async () => {
    const loop = openLoop({ workspaceId: undefined, question: 'Confirm the date?' });
    listDue.mockResolvedValue([loop]);
    claim.mockResolvedValue(loop);

    const result = await deliverDueOpenLoops('u', 'p', 'workspace-override', {
      now: () => '2026-08-18T12:00:00.000Z',
    });

    expect(result).toMatchObject({ totalDue: 1, enqueued: 1, delivered: 0, failed: 0 });
    expect(listDue).toHaveBeenCalledWith(
      'u',
      'p',
      '2026-08-18T12:00:00.000Z',
      'workspace-override',
    );
    expect(claim).toHaveBeenCalledWith(
      'u',
      'p',
      '2026-08-18T12:00:00.000Z',
      'workspace-override',
      'scheduler',
      60_000,
    );
    expect(enqueueOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'proactive.question.requested',
        aggregateId: loop.id,
        workspaceId: '',
        payload: expect.objectContaining({
          workspaceId: '',
          openLoopId: loop.id,
          question: 'Confirm the date?',
        }),
      }),
    );
    expect(releaseLease).toHaveBeenCalledWith(loop.id, null);
  });

  it('rejects notification-budget breaches before enqueueing', async () => {
    const loop = openLoop({});
    listDue.mockResolvedValue([loop]);
    claim.mockResolvedValue(loop);
    countToday.mockResolvedValue(10);

    const result = await deliverDueOpenLoops('u', 'p', {
      listDueOpenLoops: listDue,
      claimDueOpenLoop: claim,
      decideDelivery: () => ({ allow: true, reason: 'allow' }),
      enqueueDelivery: enqueue,
      now: () => '2026-08-18T12:00:00.000Z',
      releaseLease,
    });

    expect(result).toMatchObject({ rejected: 1, enqueued: 0 });
    expect(result.reasons.budget_exceeded).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledWith(loop.id, '2026-08-18T12:01:00.000Z');
  });

  it('does not process a loop that another worker already claimed', async () => {
    const loop = openLoop({});
    listDue.mockResolvedValue([loop]);
    claim.mockResolvedValue(null);

    await expect(
      deliverDueOpenLoops('u', 'p', {
        listDueOpenLoops: listDue,
        claimDueOpenLoop: claim,
        now: () => '2026-08-18T12:00:00.000Z',
        enqueueDelivery: enqueue,
        releaseLease,
      }),
    ).resolves.toMatchObject({ totalDue: 1, enqueued: 0, delivered: 0, rejected: 0, failed: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it('releases the lease and counts enqueue failures', async () => {
    const loop = openLoop({ attempts: 2 });
    listDue.mockResolvedValue([loop]);
    claim.mockResolvedValue(loop);
    const failedEnqueue = vi.fn().mockRejectedValue(new Error('outbox unavailable'));

    const result = await deliverDueOpenLoops('u', 'p', {
      listDueOpenLoops: listDue,
      claimDueOpenLoop: claim,
      decideDelivery: () => ({ allow: true, reason: 'allow' }),
      enqueueDelivery: failedEnqueue,
      now: () => '2026-08-18T12:00:00.000Z',
      releaseLease,
    });

    expect(result).toMatchObject({ failed: 1, delivered: 0, enqueued: 0 });
    expect(result.reasons.enqueue_failed).toBe(1);
    expect(releaseLease).toHaveBeenCalledWith(loop.id, '2026-08-18T12:04:00.000Z');
  });

  it('enqueues and marks answered loops within their expected persistence boundaries', async () => {
    const loop = openLoop({ workspaceId: undefined, question: 'Confirm the date?' });

    await openLoopService.enqueueOpenLoopDelivery(loop);
    expect(enqueueOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `proactive-question:${loop.id}:${loop.attempts}`,
        workspaceId: '',
        payload: expect.objectContaining({ workspaceId: '', question: 'Confirm the date?' }),
      }),
    );

    await openLoopService.enqueueAndMarkAsked(loop, '2026-08-18T12:00:00.000Z');
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(enqueueOutbox).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        aggregateId: loop.id,
        payload: expect.objectContaining({ openLoopId: loop.id }),
      }),
      transactionDb,
    );
    expect(markAsked).toHaveBeenCalledWith(loop.id, '2026-08-18T12:00:00.000Z', transactionDb);

    await openLoopService.resolveOpenLoopAsAnswered(loop.id, 'observation-1', 'Confirmed');
    await openLoopService.resolveOpenLoopAsAnsweredInTx(
      loop.id,
      undefined,
      undefined,
      transactionDb,
    );
    expect(updateStatus).toHaveBeenNthCalledWith(
      1,
      loop.id,
      'answered',
      expect.objectContaining({
        resolvedObservationId: 'observation-1',
        note: 'Confirmed',
        lastCheckedAt: expect.any(String),
      }),
    );
    expect(updateStatus).toHaveBeenNthCalledWith(
      2,
      loop.id,
      'answered',
      expect.objectContaining({ resolvedObservationId: undefined, note: undefined }),
      transactionDb,
    );
  });

  it('enqueues all due loops in a single transaction', async () => {
    const loops = [openLoop({ workspaceId: undefined }), openLoop({ id: 'loop-2' })];
    listDue.mockResolvedValue(loops);

    await expect(
      openLoopService.claimAndDeliverDueOpenLoopsWithinTransaction('u', 'p'),
    ).resolves.toMatchObject({ totalDue: 2, enqueued: 2, delivered: 0, failed: 0 });

    expect(listDue).toHaveBeenCalledWith('u', 'p', expect.any(String), '', 50, transactionDb);
    expect(enqueueOutbox).toHaveBeenCalledTimes(2);
    expect(withTransaction).toHaveBeenCalledOnce();
  });
});
