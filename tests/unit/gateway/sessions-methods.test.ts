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

async function setupForSessionTests() {
  vi.resetModules();

  const broadcastToUser = vi.fn();
  const emitInboxUpdated = vi.fn();
  const deleteConversation = vi.fn(() => true);
  const getOrCreateConversation = vi.fn(() => ({
    id: 'conv-new',
    channelType: 'WebChat',
    title: 'New Conversation',
    updatedAt: '2026-03-05T00:00:00.000Z',
  }));

  vi.doMock('../../../src/server/gateway/broadcast', () => ({
    broadcastToUser,
  }));
  vi.doMock('../../../src/server/channels/inbox/events', () => ({
    emitInboxUpdated,
  }));
  vi.doMock('../../../src/server/channels/messages/runtime', () => ({
    getMessageService: () => ({
      deleteConversation,
      getOrCreateConversation,
    }),
  }));

  const { dispatchMethod } = await import('@/server/gateway/method-router');
  await import('@/server/gateway/methods/sessions');

  return {
    dispatchMethod,
    broadcastToUser,
    emitInboxUpdated,
    deleteConversation,
    getOrCreateConversation,
  };
}

describe('gateway sessions methods', () => {
  it('emits inbox delete event when sessions.delete succeeds', async () => {
    const { dispatchMethod, emitInboxUpdated, deleteConversation } = await setupForSessionTests();
    const sent: unknown[] = [];

    await dispatchMethod(
      makeRequest('sessions.delete', { conversationId: 'conv-1' }),
      makeClient('user-a'),
      (frame) => sent.push(frame),
    );

    expect(deleteConversation).toHaveBeenCalledWith('conv-1', 'user-a');
    expect(emitInboxUpdated).toHaveBeenCalledWith({
      userId: 'user-a',
      action: 'delete',
      conversationId: 'conv-1',
      item: null,
    });
    const response = sent[0] as { ok: boolean; payload: { deleted: boolean } };
    expect(response.ok).toBe(true);
    expect(response.payload.deleted).toBe(true);
  });

  it('does not emit inbox delete event when sessions.delete returns false', async () => {
    const { dispatchMethod, emitInboxUpdated, deleteConversation } = await setupForSessionTests();
    deleteConversation.mockReturnValue(false);
    const sent: unknown[] = [];

    await dispatchMethod(
      makeRequest('sessions.delete', { conversationId: 'conv-1' }),
      makeClient('user-a'),
      (frame) => sent.push(frame),
    );

    expect(emitInboxUpdated).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delete', conversationId: 'conv-1' }),
    );
    const response = sent[0] as { ok: boolean; payload: { deleted: boolean } };
    expect(response.ok).toBe(true);
    expect(response.payload.deleted).toBe(false);
  });

  it('emits inbox upsert event when sessions.reset creates a new conversation', async () => {
    const { dispatchMethod, emitInboxUpdated, getOrCreateConversation } =
      await setupForSessionTests();
    const sent: unknown[] = [];

    await dispatchMethod(
      makeRequest('sessions.reset', { title: 'Fresh Start' }),
      makeClient('user-a'),
      (frame) => sent.push(frame),
    );

    expect(getOrCreateConversation).toHaveBeenCalled();
    expect(emitInboxUpdated).toHaveBeenCalledWith({
      userId: 'user-a',
      action: 'upsert',
      conversationId: 'conv-new',
      item: {
        conversationId: 'conv-new',
        channelType: 'WebChat',
        title: 'New Conversation',
        updatedAt: '2026-03-05T00:00:00.000Z',
        lastMessage: null,
      },
    });
    const response = sent[0] as { ok: boolean; payload: { conversationId: string } };
    expect(response.ok).toBe(true);
    expect(response.payload.conversationId).toBe('conv-new');
  });
});
