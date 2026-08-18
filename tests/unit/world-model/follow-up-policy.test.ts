import { describe, expect, it } from 'vitest';

import { decideOpenLoopDelivery } from '@/server/world-model/services/followUpPolicy';

const openLoop = () => ({
  status: 'open',
  attempts: 0,
  maxAttempts: 3,
  importance: 2,
});

describe('decideOpenLoopDelivery', () => {
  it('allows delivery for a due open loop by default', () => {
    const decision = decideOpenLoopDelivery(openLoop(), { now: '2026-08-18T12:00:00.000Z' });
    expect(decision).toEqual({ allow: true, reason: 'allow' });
  });

  it('blocks delivery outside the allowed statuses', () => {
    const decision = decideOpenLoopDelivery(
      { ...openLoop(), status: 'resolved' },
      { now: '2026-08-18T12:00:00.000Z' },
    );
    expect(decision.allow).toBe(false);
  });

  it('respects doNotAskBefore', () => {
    const decision = decideOpenLoopDelivery(
      { ...openLoop(), doNotAskBefore: '2026-08-18T13:00:00.000Z' },
      { now: '2026-08-18T12:00:00.000Z' },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('quiet_time');
  });

  it('respects maxAttempts', () => {
    const decision = decideOpenLoopDelivery(
      { ...openLoop(), status: 'asked', attempts: 3 },
      { now: '2026-08-18T12:00:00.000Z' },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('budget_exceeded');
  });

  it('respects quiet hours', () => {
    const decision = decideOpenLoopDelivery(openLoop(), {
      now: '2026-08-18T02:00:00.000Z',
      quietHours: { start: 22, end: 6 },
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('quiet_time');
  });

  it('respects daily budget', () => {
    const decision = decideOpenLoopDelivery(openLoop(), {
      now: '2026-08-18T12:00:00.000Z',
      dailyBudget: 3,
      deliveredToday: 3,
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('budget_exceeded');
  });

  it('respects channel availability', () => {
    const decision = decideOpenLoopDelivery(openLoop(), {
      now: '2026-08-18T12:00:00.000Z',
      channelAvailable: false,
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('channel_unavailable');
  });

  it('blocks while user interaction is active', () => {
    const decision = decideOpenLoopDelivery(openLoop(), {
      now: '2026-08-18T12:00:00.000Z',
      userInteractionActive: true,
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('user_active');
  });
});
