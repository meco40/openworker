import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchOutboxOnce, registerOutboxHandler } from '@/server/world-model/outboxDispatcher';
import type { OutboxEvent } from '@/server/world-model/types';

const claimPending = vi.fn();
const markDispatched = vi.fn();
const markFailed = vi.fn();

vi.mock('@/server/world-model/repositories/outboxRepository', () => ({
  claimPendingOutboxEvents: (...args: unknown[]) => claimPending(...args),
  markOutboxDispatched: (...args: unknown[]) => markDispatched(...args),
  markOutboxFailed: (...args: unknown[]) => markFailed(...args),
  enqueueOutboxEvent: vi.fn(),
}));

vi.mock('@/server/world-model/config', () => ({
  getWorldModelConfig: () => ({ outboxBatchSize: 100 }),
}));

vi.mock('@/server/world-model/db', () => ({
  getWorldModelDb: vi.fn(() => ({ pool: { end: vi.fn(async () => {}) }, query: vi.fn() })),
  runWorldModelMigrations: vi.fn(async () => []),
}));

function event(partial: Partial<OutboxEvent>): OutboxEvent {
  return {
    id: 'e',
    eventType: 'test.event',
    aggregateType: 'event',
    aggregateId: 'a',
    payload: {},
    status: 'pending',
    attempts: 0,
    createdAt: '2026-08-18T12:00:00.000Z',
    ...partial,
  };
}

describe('outbox dispatcher', () => {
  beforeEach(() => {
    claimPending.mockReset();
    markDispatched.mockReset();
    markFailed.mockReset();
  });

  it('keeps events visible as failed when no handler is registered', async () => {
    claimPending.mockResolvedValue([event({})]);
    const handled = await dispatchOutboxOnce();
    expect(handled).toBe(0);
    expect(markDispatched).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      'e',
      '[world-model:outbox] no handler registered for test.event',
      expect.any(String),
    );
  });

  it('runs a registered handler and acknowledges on success', async () => {
    registerOutboxHandler('test.event', async () => {});
    claimPending.mockResolvedValue([event({})]);
    const handled = await dispatchOutboxOnce();
    expect(handled).toBe(1);
    expect(markDispatched).toHaveBeenCalledWith('e', expect.any(String));
  });

  it('marks an event failed when its handler throws', async () => {
    registerOutboxHandler('test.event', async () => {
      throw new Error('boom');
    });
    claimPending.mockResolvedValue([event({})]);
    const handled = await dispatchOutboxOnce();
    expect(handled).toBe(0);
    expect(markFailed).toHaveBeenCalledWith('e', 'boom', expect.any(String));
    expect(markDispatched).not.toHaveBeenCalled();
  });
});
