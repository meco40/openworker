import { describe, expect, it } from 'vitest';
import {
  clampArtifactForPersistence,
  trimArtifactHistoryForPayload,
} from '@/modules/agent-room/utils/artifact.utils';
import {
  isRateLimitedGatewayError,
  isTransientGatewayConnectionError,
} from '@/modules/agent-room/utils/error.utils';
import {
  consumeReplayForCommand,
  shouldFallbackToSessionSnapshot,
} from '@/modules/agent-room/utils/replay.utils';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';

// ─── artifact.utils ─────────────────────────────────────────────

describe('clampArtifactForPersistence', () => {
  it('returns empty string for falsy input', () => {
    expect(clampArtifactForPersistence('')).toBe('');
  });

  it('returns text unchanged when under limit', () => {
    expect(clampArtifactForPersistence('hello world')).toBe('hello world');
  });

  it('truncates from the beginning when over limit', () => {
    const result = clampArtifactForPersistence('abcdefghij', 5);
    expect(result).toBe('fghij');
    expect(result.length).toBe(5);
  });

  it('trims whitespace', () => {
    expect(clampArtifactForPersistence('  hello  ')).toBe('hello');
  });
});

describe('trimArtifactHistoryForPayload', () => {
  it('returns empty for empty array', () => {
    expect(trimArtifactHistoryForPayload([])).toEqual([]);
  });

  it('returns empty for non-array input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(trimArtifactHistoryForPayload(null as never)).toEqual([]);
  });

  it('filters empty/whitespace entries', () => {
    expect(trimArtifactHistoryForPayload(['', '  ', 'valid'])).toEqual(['valid']);
  });

  it('preserves entries when under size limit', () => {
    const history = ['snapshot-1', 'snapshot-2'];
    expect(trimArtifactHistoryForPayload(history)).toEqual(history);
  });

  it('drops oldest entries when over size limit', () => {
    const large = 'x'.repeat(5000);
    const history = [large, large, large, 'last'];
    const result = trimArtifactHistoryForPayload(history, 6000);
    // Should have trimmed from front until under 6000 JSON chars
    expect(result.length).toBeLessThan(history.length);
    expect(result[result.length - 1]).toBe('last');
  });
});

// ─── error.utils ────────────────────────────────────────────────

describe('isRateLimitedGatewayError', () => {
  it('returns true for RATE_LIMITED code', () => {
    expect(isRateLimitedGatewayError({ code: 'RATE_LIMITED' })).toBe(true);
  });

  it('returns true for "too many requests" in message', () => {
    expect(isRateLimitedGatewayError(new Error('Too Many Requests'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isRateLimitedGatewayError(new Error('Something else'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRateLimitedGatewayError(null)).toBe(false);
  });
});

describe('isTransientGatewayConnectionError', () => {
  it('detects websocket not connected', () => {
    expect(isTransientGatewayConnectionError(new Error('WebSocket not connected'))).toBe(true);
  });

  it('detects client disconnected', () => {
    expect(isTransientGatewayConnectionError(new Error('client disconnected'))).toBe(true);
  });

  it('detects failed to connect', () => {
    expect(isTransientGatewayConnectionError(new Error('Failed to connect'))).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isTransientGatewayConnectionError(new Error('timeout'))).toBe(false);
  });
});

// ─── replay.utils ───────────────────────────────────────────────

function makeReplayEvent(overrides: Partial<AgentV2EventEnvelope> = {}): AgentV2EventEnvelope {
  return {
    schemaVersion: '2.1',
    eventId: 'evt-r1',
    sessionId: 'sess-r1',
    commandId: 'cmd-replay',
    seq: 1,
    emittedAt: '2026-01-01T00:00:00Z',
    type: 'agent.v2.command.completed',
    payload: {},
    ...overrides,
  };
}

describe('consumeReplayForCommand', () => {
  it('returns initial state for empty events', () => {
    const result = consumeReplayForCommand({
      events: [],
      commandId: 'cmd-1',
      fromSeq: 0,
      text: '',
    });
    expect(result.completed).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.text).toBe('');
    expect(result.nextSeq).toBe(0);
  });

  it('accumulates model deltas', () => {
    const events = [
      makeReplayEvent({ seq: 1, type: 'agent.v2.model.delta', payload: { delta: 'Hello ' } }),
      makeReplayEvent({ seq: 2, type: 'agent.v2.model.delta', payload: { delta: 'World' } }),
    ];
    const result = consumeReplayForCommand({
      events,
      commandId: 'cmd-replay',
      fromSeq: 0,
      text: '',
    });
    expect(result.text).toBe('Hello World');
    expect(result.nextSeq).toBe(2);
  });

  it('marks completed on command.completed', () => {
    const events = [
      makeReplayEvent({ seq: 1, type: 'agent.v2.command.completed', payload: { status: 'ok' } }),
    ];
    const result = consumeReplayForCommand({
      events,
      commandId: 'cmd-replay',
      fromSeq: 0,
      text: '',
    });
    expect(result.completed).toBe(true);
    expect(result.failed).toBe(false);
  });

  it('marks failed on error event', () => {
    const events = [
      makeReplayEvent({
        seq: 1,
        type: 'agent.v2.error',
        payload: { message: 'Something broke' },
      }),
    ];
    const result = consumeReplayForCommand({
      events,
      commandId: 'cmd-replay',
      fromSeq: 0,
      text: '',
    });
    expect(result.failed).toBe(true);
    expect(result.errorMessage).toBe('Something broke');
  });

  it('marks failed for failed status in completion', () => {
    const events = [
      makeReplayEvent({
        seq: 1,
        type: 'agent.v2.command.completed',
        payload: { status: 'failed' },
      }),
    ];
    const result = consumeReplayForCommand({
      events,
      commandId: 'cmd-replay',
      fromSeq: 0,
      text: '',
    });
    expect(result.failed).toBe(true);
    expect(result.errorMessage).toContain('failed');
  });

  it('ignores events for different commandId', () => {
    const events = [
      makeReplayEvent({
        commandId: 'other-cmd',
        seq: 5,
        type: 'agent.v2.model.delta',
        payload: { delta: 'X' },
      }),
    ];
    const result = consumeReplayForCommand({
      events,
      commandId: 'cmd-replay',
      fromSeq: 0,
      text: '',
    });
    expect(result.text).toBe('');
    // But seq is still tracked (global high watermark)
    expect(result.nextSeq).toBe(5);
  });

  it('extracts result.message when text is empty on completion', () => {
    const events = [
      makeReplayEvent({
        seq: 1,
        type: 'agent.v2.command.completed',
        payload: { status: 'ok', result: { message: 'Final answer.' } },
      }),
    ];
    const result = consumeReplayForCommand({
      events,
      commandId: 'cmd-replay',
      fromSeq: 0,
      text: '',
    });
    expect(result.text).toBe('Final answer.');
    expect(result.completed).toBe(true);
  });
});

describe('shouldFallbackToSessionSnapshot', () => {
  it('returns true for REPLAY_WINDOW_EXPIRED', () => {
    expect(shouldFallbackToSessionSnapshot(new Error('REPLAY_WINDOW_EXPIRED: too old'))).toBe(true);
  });

  it('returns true for "Replay window expired"', () => {
    expect(shouldFallbackToSessionSnapshot(new Error('Replay window expired'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(shouldFallbackToSessionSnapshot(new Error('Network timeout'))).toBe(false);
  });
});

// ─── lineDiff (shared utility) ──────────────────────────────────

describe('lineDiff utility', () => {
  // Inline import to avoid 'use client' issue
  it('computes empty diff for identical texts', async () => {
    const { computeLineDiff } = await import('@/shared/lib/lineDiff');
    const result = computeLineDiff('hello\nworld', 'hello\nworld');
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.kind === 'same')).toBe(true);
  });

  it('detects added lines', async () => {
    const { computeLineDiff } = await import('@/shared/lib/lineDiff');
    const result = computeLineDiff('a', 'a\nb');
    const added = result.filter((r) => r.kind === 'added');
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe('b');
  });

  it('detects removed lines', async () => {
    const { computeLineDiff } = await import('@/shared/lib/lineDiff');
    const result = computeLineDiff('a\nb', 'a');
    const removed = result.filter((r) => r.kind === 'removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].text).toBe('b');
  });
});
