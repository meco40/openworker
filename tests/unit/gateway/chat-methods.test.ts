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

function makeRequest(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 'req-1',
): RequestFrame {
  return { type: 'req', id, method, params };
}

describe('gateway chat methods', () => {
  it('passes client.userId into chat.history repository lookup', async () => {
    vi.resetModules();

    const listMessages = vi.fn(() => []);
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: () => ({
        listMessages,
        listConversations: vi.fn(() => []),
      }),
      getMessageService: () => ({
        getConversation: vi.fn(() => null),
        setPersonaId: vi.fn(),
        handleWebUIMessage: vi.fn(),
        abortGeneration: vi.fn(() => false),
        respondToolApproval: vi.fn(),
      }),
    }));

    const { dispatchMethod } = await import('@/server/gateway/method-router');
    await import('@/server/gateway/methods/chat');

    const sent: unknown[] = [];
    await dispatchMethod(
      makeRequest('chat.history', { conversationId: 'conv-1', limit: 10 }),
      makeClient('user-scoped'),
      (frame) => sent.push(frame),
    );

    expect(listMessages).toHaveBeenCalledWith('conv-1', 10, undefined, 'user-scoped');
    const response = sent[0] as { ok: boolean };
    expect(response.ok).toBe(true);
  });

  it('supports client limit for chat.conversations.list with default and max clamp', async () => {
    vi.resetModules();

    const listConversations = vi.fn(() => []);
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: () => ({
        listMessages: vi.fn(() => []),
        listConversations,
      }),
      getMessageService: () => ({
        getConversation: vi.fn(() => null),
        setPersonaId: vi.fn(),
        handleWebUIMessage: vi.fn(),
        abortGeneration: vi.fn(() => false),
        respondToolApproval: vi.fn(),
      }),
    }));

    const { dispatchMethod } = await import('@/server/gateway/method-router');
    await import('@/server/gateway/methods/chat');

    const sent: unknown[] = [];
    await dispatchMethod(
      makeRequest('chat.conversations.list', { limit: 120 }),
      makeClient('user-scoped'),
      (frame) => sent.push(frame),
    );
    await dispatchMethod(
      makeRequest('chat.conversations.list', { limit: 999 }),
      makeClient('user-scoped'),
      (frame) => sent.push(frame),
    );
    await dispatchMethod(makeRequest('chat.conversations.list'), makeClient('user-scoped'), (frame) =>
      sent.push(frame),
    );

    expect(listConversations).toHaveBeenNthCalledWith(1, 120, 'user-scoped');
    expect(listConversations).toHaveBeenNthCalledWith(2, 200, 'user-scoped');
    expect(listConversations).toHaveBeenNthCalledWith(3, 50, 'user-scoped');
    expect(sent).toHaveLength(3);
  });
});
