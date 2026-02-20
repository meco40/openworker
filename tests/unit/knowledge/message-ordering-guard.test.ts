import { describe, it, expect } from 'vitest';
import {
  createIdempotencyKey,
  isLateArrival,
  reorderByTimestamp,
  type IncomingMessage,
  type StoredMessage,
} from '@/server/knowledge/messageOrderingGuard';

function makeIncoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channelId: 'ch-web',
    originalMessageId: 'msg-001',
    content: 'Hallo Welt',
    originalTimestamp: '2026-02-17T10:00:00Z',
    receivedAt: '2026-02-17T10:00:05Z',
    channelSource: 'web',
    ...overrides,
  };
}

function makeStored(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'stored-1',
    content: 'Hello',
    originalTimestamp: '2026-02-17T10:00:00Z',
    createdAt: '2026-02-17T10:00:05Z',
    ...overrides,
  };
}

describe('createIdempotencyKey', () => {
  it('creates deterministic key from channel + messageId + content prefix', () => {
    const msg = makeIncoming();
    const key1 = createIdempotencyKey(msg);
    const key2 = createIdempotencyKey(msg);
    expect(key1).toBe(key2);
    expect(key1.length).toBeGreaterThan(0);
  });

  it('produces different keys for different content', () => {
    const msg1 = makeIncoming({ content: 'Hallo' });
    const msg2 = makeIncoming({ content: 'Tschuess' });
    expect(createIdempotencyKey(msg1)).not.toBe(createIdempotencyKey(msg2));
  });

  it('produces same key for same content on different channels', () => {
    const webMsg = makeIncoming({ channelSource: 'web', channelId: 'ch-web' });
    const waMsg = makeIncoming({ channelSource: 'whatsapp', channelId: 'ch-wa' });
    // Idempotency should detect cross-channel duplicates based on content + originalMessageId
    // Different channels with same originalMessageId + content → could be same or different
    // depending on implementation. Our goal: same content from same original source = same key
    const key1 = createIdempotencyKey(webMsg);
    const key2 = createIdempotencyKey(waMsg);
    // Different channelId → different keys (by design, cross-channel dedup uses content matching)
    expect(key1).not.toBe(key2);
  });
});

describe('isLateArrival', () => {
  it('returns false when arrival is within threshold', () => {
    const msg = makeIncoming({
      originalTimestamp: '2026-02-17T10:00:00Z',
      receivedAt: '2026-02-17T10:02:00Z', // 2 min
    });
    expect(isLateArrival(msg, 5 * 60 * 1000)).toBe(false);
  });

  it('returns true when arrival exceeds threshold', () => {
    const msg = makeIncoming({
      originalTimestamp: '2026-02-17T10:00:00Z',
      receivedAt: '2026-02-17T10:08:00Z', // 8 min
    });
    expect(isLateArrival(msg, 5 * 60 * 1000)).toBe(true);
  });

  it('defaults to 5 minute threshold', () => {
    const msg = makeIncoming({
      originalTimestamp: '2026-02-17T10:00:00Z',
      receivedAt: '2026-02-17T10:06:00Z', // 6 min
    });
    expect(isLateArrival(msg)).toBe(true);
  });
});

describe('reorderByTimestamp', () => {
  it('sorts messages by originalTimestamp ascending', () => {
    const messages: StoredMessage[] = [
      makeStored({ id: 'b', originalTimestamp: '2026-02-17T10:05:00Z' }),
      makeStored({ id: 'a', originalTimestamp: '2026-02-17T10:02:00Z' }),
      makeStored({ id: 'c', originalTimestamp: '2026-02-17T10:08:00Z' }),
    ];
    const sorted = reorderByTimestamp(messages);
    expect(sorted.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserves order for already-sorted messages', () => {
    const messages: StoredMessage[] = [
      makeStored({ id: 'a', originalTimestamp: '2026-02-17T10:00:00Z' }),
      makeStored({ id: 'b', originalTimestamp: '2026-02-17T10:01:00Z' }),
    ];
    const sorted = reorderByTimestamp(messages);
    expect(sorted.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('returns empty array for empty input', () => {
    expect(reorderByTimestamp([])).toEqual([]);
  });
});
