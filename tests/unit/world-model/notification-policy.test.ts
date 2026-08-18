import { describe, expect, it } from 'vitest';

import {
  decideNotification,
  type NotificationPolicyConfig,
} from '@/server/world-model/services/notificationPolicy';

const baseConfig: NotificationPolicyConfig = {};

describe('decideNotification', () => {
  it('allows notifications by default', () => {
    const decision = decideNotification(
      { now: '2026-08-18T12:00:00.000Z', channel: 'telegram', counts: { deliveredToday: 0 } },
      baseConfig,
    );
    expect(decision).toEqual({ allow: true, reason: 'allow' });
  });

  it('blocks during quiet hours', () => {
    const decision = decideNotification(
      { now: '2026-08-18T02:00:00.000Z', channel: 'telegram', counts: { deliveredToday: 0 } },
      { quietHours: { start: 22, end: 6 } },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('quiet_time');
  });

  it('blocks when daily budget is exceeded', () => {
    const decision = decideNotification(
      {
        now: '2026-08-18T12:00:00.000Z',
        channel: 'telegram',
        counts: { deliveredToday: 5 },
      },
      { dailyBudget: 5 },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('budget_exceeded');
  });

  it('blocks when the channel is disabled by preference', () => {
    const decision = decideNotification(
      { now: '2026-08-18T12:00:00.000Z', channel: 'email', counts: { deliveredToday: 0 } },
      { channelPref: { email: false } },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('channel_closed');
  });

  it('allows when quiet hours do not apply crossing midnight', () => {
    const decision = decideNotification(
      { now: '2026-08-18T12:00:00.000Z', channel: 'telegram', counts: { deliveredToday: 1 } },
      { quietHours: { start: 22, end: 6 } },
    );
    expect(decision.allow).toBe(true);
  });
});
