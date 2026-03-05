import { describe, expect, it, vi } from 'vitest';

import type { GatewayClient } from '@/server/gateway/client-registry';
import type { RequestFrame } from '@/server/gateway/protocol';

function makeClient(userId = 'user-1'): GatewayClient {
  return {
    socket: {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as GatewayClient['socket'],
    connId: 'conn-1',
    userId,
    connectedAt: Date.now(),
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    seq: 0,
  };
}

async function setupForChannelsTests() {
  vi.resetModules();

  const broadcastToUser = vi.fn();
  const upsertChannelBinding = vi.fn();
  const pairChannel = vi.fn(async () => ({
    status: 'connected',
    transport: 'webhook',
    peerName: 'telegram:test',
    details: {},
  }));
  const unpairChannel = vi.fn(async () => {});

  vi.doMock('../../../src/server/gateway/broadcast', () => ({
    broadcastToUser,
  }));
  vi.doMock('../../../src/server/channels/pairing', () => ({
    isPairChannelType: (value: string) =>
      ['telegram', 'discord', 'whatsapp', 'imessage'].includes(value),
    pairChannel,
    unpairChannel,
  }));
  vi.doMock('../../../src/server/channels/messages/runtime', () => ({
    getMessageRepository: () => ({
      listChannelBindings: () => [
        { channel: 'telegram', status: 'connected', peerName: 'telegram:test' },
      ],
      upsertChannelBinding,
    }),
    getMessageService: () => ({
      listInbox: () => ({
        items: [
          {
            conversationId: 'conv-1',
            channelType: 'Telegram',
            title: 'Chat',
            updatedAt: '2026-02-11T00:00:00.000Z',
            lastMessage: {
              id: 'msg-1',
              role: 'user',
              content: 'hello',
              createdAt: '2026-02-11T00:00:01.000Z',
              platform: 'Telegram',
            },
          },
        ],
        limit: 50,
        hasMore: false,
        nextCursor: null,
        totalMatched: 1,
      }),
    }),
  }));

  const { dispatchMethod } = await import('@/server/gateway/method-router');
  await import('@/server/gateway/methods/channels');

  return { dispatchMethod, pairChannel, unpairChannel, upsertChannelBinding, broadcastToUser };
}

function makeRequest(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 'req-1',
): RequestFrame {
  return { type: 'req', id, method, params };
}

describe('gateway channels methods', () => {
  it('lists inbox entries via inbox.list', async () => {
    const { dispatchMethod } = await setupForChannelsTests();
    const sent: unknown[] = [];

    await dispatchMethod(
      makeRequest('inbox.list', { channel: 'telegram', version: 2 }),
      makeClient(),
      (frame) => sent.push(frame),
    );

    const response = sent[0] as {
      ok: boolean;
      payload: {
        items: Array<{ conversationId: string }>;
        page: {
          returned: number;
          totalMatched: number;
          hasMore: boolean;
          nextCursor: string | null;
        };
      };
    };
    expect(response.ok).toBe(true);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0].conversationId).toBe('conv-1');
    expect(response.payload.page.returned).toBe(1);
    expect(response.payload.page.totalMatched).toBe(1);
    expect(response.payload.page.hasMore).toBe(false);
    expect(response.payload.page.nextCursor).toBeNull();
  });

  it('returns v1 payload shape with deprecation metadata in inbox.list', async () => {
    const { dispatchMethod } = await setupForChannelsTests();
    const sent: unknown[] = [];

    await dispatchMethod(
      makeRequest('inbox.list', { channel: 'telegram', version: 1 }),
      makeClient(),
      (frame) => sent.push(frame),
    );

    const response = sent[0] as {
      ok: boolean;
      payload: {
        items: Array<{ conversationId: string }>;
        total: number;
        deprecated?: { sunset?: string };
      };
    };
    expect(response.ok).toBe(true);
    expect(response.payload.total).toBe(1);
    expect(response.payload.deprecated?.sunset).toBeTruthy();
  });

  it('enforces ws inbox rate limit', async () => {
    const prevRateLimit = process.env.INBOX_WS_RATE_LIMIT_PER_MINUTE;
    process.env.INBOX_WS_RATE_LIMIT_PER_MINUTE = '1';
    (
      globalThis as typeof globalThis & {
        __inboxRateLimitBuckets?: unknown;
      }
    ).__inboxRateLimitBuckets = undefined;
    try {
      const { dispatchMethod } = await setupForChannelsTests();
      const sent: unknown[] = [];

      await dispatchMethod(makeRequest('inbox.list', { version: 2 }), makeClient(), (frame) =>
        sent.push(frame),
      );
      await dispatchMethod(
        makeRequest('inbox.list', { version: 2 }, 'req-2'),
        makeClient(),
        (frame) => sent.push(frame),
      );

      const first = sent[0] as { ok: boolean };
      const second = sent[1] as {
        ok: boolean;
        error?: { code?: string; message?: string };
      };

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      expect(second.error?.code).toBe('RATE_LIMITED');
    } finally {
      if (prevRateLimit === undefined) {
        delete process.env.INBOX_WS_RATE_LIMIT_PER_MINUTE;
      } else {
        process.env.INBOX_WS_RATE_LIMIT_PER_MINUTE = prevRateLimit;
      }
      (
        globalThis as typeof globalThis & {
          __inboxRateLimitBuckets?: unknown;
        }
      ).__inboxRateLimitBuckets = undefined;
    }
  });

  it('responds to channels.list with channel state', async () => {
    const { dispatchMethod } = await setupForChannelsTests();
    const sent: unknown[] = [];

    await dispatchMethod(makeRequest('channels.list'), makeClient(), (frame) => sent.push(frame));

    expect(sent).toHaveLength(1);
    const response = sent[0] as {
      type: string;
      ok: boolean;
      payload: { channels: Array<{ channel: string; status: string }> };
    };
    expect(response.type).toBe('res');
    expect(response.ok).toBe(true);
    expect(response.payload.channels.length).toBeGreaterThan(0);
  });

  it('pairs a channel via channels.pair', async () => {
    const { dispatchMethod, pairChannel, upsertChannelBinding, broadcastToUser } =
      await setupForChannelsTests();
    const sent: unknown[] = [];

    await dispatchMethod(
      makeRequest('channels.pair', { channel: 'telegram', token: 'abc' }),
      makeClient('user-a'),
      (frame) => sent.push(frame),
    );

    expect(pairChannel).toHaveBeenCalledWith('telegram', 'abc', undefined);
    expect(upsertChannelBinding).toHaveBeenCalled();
    expect(broadcastToUser).toHaveBeenCalled();
    const response = sent[0] as { ok: boolean; payload: { status: string } };
    expect(response.ok).toBe(true);
    expect(response.payload.status).toBe('connected');
  });

  it('unpairs channel via channels.unpair', async () => {
    const { dispatchMethod, unpairChannel, upsertChannelBinding } = await setupForChannelsTests();
    const sent: unknown[] = [];

    await dispatchMethod(
      makeRequest('channels.unpair', { channel: 'telegram' }),
      makeClient('user-a'),
      (frame) => sent.push(frame),
    );

    expect(unpairChannel).toHaveBeenCalledWith('telegram', undefined);
    expect(upsertChannelBinding).toHaveBeenCalled();
    const response = sent[0] as { ok: boolean; payload: { status: string } };
    expect(response.ok).toBe(true);
    expect(response.payload.status).toBe('disconnected');
  });
});
