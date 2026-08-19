import { describe, expect, it } from 'vitest';

import {
  correlateUserResponse,
  type CorrelatableTarget,
} from '@/server/world-model/services/responseCorrelationService';

const target = (partial: Partial<CorrelatableTarget>): CorrelatableTarget => ({
  id: 't1',
  targetType: 'open_loop',
  ...partial,
});

describe('correlateUserResponse', () => {
  it('matches the single active candidate in the same conversation/window', () => {
    const decision = correlateUserResponse(
      {
        channel: 'telegram',
        conversationId: 'conv-1',
        text: 'ja, ich war dort',
        receivedAt: '2026-08-18T12:05:00.000Z',
      },
      [
        target({
          id: 'loop-1',
          channel: 'telegram',
          conversationId: 'conv-1',
          askedAt: '2026-08-18T12:00:00.000Z',
        }),
      ],
    );
    expect(decision.match?.id).toBe('loop-1');
    expect(decision.ambiguous).toBe(false);
  });

  it('returns ambiguous when multiple candidates score positive', () => {
    const decision = correlateUserResponse(
      {
        channel: 'telegram',
        conversationId: 'conv-1',
        text: 'ja',
        receivedAt: '2026-08-18T12:05:00.000Z',
      },
      [
        target({
          id: 'a',
          channel: 'telegram',
          conversationId: 'conv-1',
          askedAt: '2026-08-18T11:59:00.000Z',
        }),
        target({
          id: 'b',
          channel: 'telegram',
          conversationId: 'conv-1',
          askedAt: '2026-08-18T12:01:00.000Z',
        }),
      ],
    );
    expect(decision.match).toBeNull();
    expect(decision.ambiguous).toBe(true);
    expect(decision.reason).toBe('ambiguous');
  });

  it('returns none when no candidate has positive signal', () => {
    const decision = correlateUserResponse(
      {
        channel: 'slack',
        conversationId: 'other',
        text: 'ok',
        receivedAt: '2026-08-18T12:05:00.000Z',
      },
      [
        target({
          id: 'a',
          channel: 'telegram',
          conversationId: 'conv-1',
          askedAt: '2026-08-18T11:00:00.000Z',
        }),
      ],
    );
    expect(decision.match).toBeNull();
    expect(decision.ambiguous).toBe(false);
    expect(decision.reason).toBe('none');
  });

  it('matches on conversation+channel even when outside the time window', () => {
    // Deterministic conversation/channel signals dominate the time window:
    // a reply in the same conversation/channel is still the best correlate,
    // even if it arrived later than the default window.
    const decision = correlateUserResponse(
      {
        channel: 'telegram',
        conversationId: 'conv-1',
        text: 'ja',
        receivedAt: '2026-08-18T14:00:00.000Z',
      },
      [
        target({
          id: 'a',
          channel: 'telegram',
          conversationId: 'conv-1',
          askedAt: '2026-08-18T12:00:00.000Z',
        }),
      ],
      30 * 60 * 1000,
    );
    expect(decision.match?.id).toBe('a');
    expect(decision.ambiguous).toBe(false);
  });

  it('does not match when only the time window is positive but channel/conversation differ', () => {
    const decision = correlateUserResponse(
      {
        channel: 'slack',
        conversationId: 'other',
        text: 'ja',
        receivedAt: '2026-08-18T12:05:00.000Z',
      },
      [
        target({
          id: 'a',
          channel: 'telegram',
          conversationId: 'conv-1',
          askedAt: '2026-08-18T12:00:00.000Z',
        }),
      ],
      30 * 60 * 1000,
    );
    expect(decision.match).toBeNull();
  });

  it('does not award a time-window score to a message sent before the question', () => {
    const decision = correlateUserResponse(
      {
        channel: 'slack',
        conversationId: 'other',
        text: 'ja',
        receivedAt: '2026-08-18T11:59:00.000Z',
      },
      [
        target({
          id: 'future-question',
          channel: 'telegram',
          conversationId: 'different',
          askedAt: '2026-08-18T12:00:00.000Z',
        }),
      ],
    );
    expect(decision.match).toBeNull();
    expect(decision.reason).toBe('none');
  });
});
