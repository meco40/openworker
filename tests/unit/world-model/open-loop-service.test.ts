import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenLoopRecord } from '@/server/world-model/types';

let deliverDueOpenLoops: typeof import('@/server/world-model/services/openLoopService').deliverDueOpenLoops;

const listDue = vi.fn();
const claim = vi.fn();
const countToday = vi.fn();
const markAsked = vi.fn();
const enqueue = vi.fn();
const releaseLease = vi.fn();

vi.mock('@/server/world-model/repositories/prospectiveRepository', () => ({
  listDueOpenLoops: (...args: unknown[]) => listDue(...args),
  claimDueOpenLoop: (...args: unknown[]) => claim(...args),
  countAskedOpenLoopsToday: (...args: unknown[]) => countToday(...args),
  markOpenLoopAsked: (...args: unknown[]) => markAsked(...args),
  releaseOpenLoopLease: (...args: unknown[]) => releaseLease(...args),
  updateOpenLoopStatus: vi.fn(async () => {}),
}));

vi.mock('@/server/world-model/repositories/outboxRepository', () => ({
  enqueueOutboxEvent: vi.fn(async () => ({ id: 'e' })),
}));

vi.mock('@/server/world-model/config', () => ({
  getWorldModelConfig: vi.fn(() => ({
    enabled: false,
    dailyProactiveBudget: 10,
    quietHours: null,
    userActiveWindowMs: 300_000,
  })),
}));

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
    deliverDueOpenLoops = (await import('@/server/world-model/services/openLoopService'))
      .deliverDueOpenLoops;
    listDue.mockReset();
    claim.mockReset();
    countToday.mockReset();
    markAsked.mockReset();
    enqueue.mockReset();
    releaseLease.mockReset();
    countToday.mockResolvedValue(0);
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
});
