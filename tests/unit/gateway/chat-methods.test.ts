import { afterEach, describe, expect, it, vi } from 'vitest';

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
  const previousKeepaliveMs = process.env.OPENCLAW_CHAT_STREAM_KEEPALIVE_MS;

  afterEach(() => {
    vi.useRealTimers();
    if (previousKeepaliveMs === undefined) {
      delete process.env.OPENCLAW_CHAT_STREAM_KEEPALIVE_MS;
    } else {
      process.env.OPENCLAW_CHAT_STREAM_KEEPALIVE_MS = previousKeepaliveMs;
    }
  });

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
    await dispatchMethod(
      makeRequest('chat.conversations.list'),
      makeClient('user-scoped'),
      (frame) => sent.push(frame),
    );

    expect(listConversations).toHaveBeenNthCalledWith(1, 120, 'user-scoped');
    expect(listConversations).toHaveBeenNthCalledWith(2, 200, 'user-scoped');
    expect(listConversations).toHaveBeenNthCalledWith(3, 50, 'user-scoped');
    expect(sent).toHaveLength(3);
  });

  it('rejects chat.send when requested persona mismatches bound conversation persona', async () => {
    vi.resetModules();

    const setPersonaId = vi.fn();
    const handleWebUIMessage = vi.fn();
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: () => ({
        listMessages: vi.fn(() => []),
        listConversations: vi.fn(() => []),
      }),
      getMessageService: () => ({
        getConversation: vi.fn(() => ({
          id: 'conv-1',
          personaId: 'persona-a',
        })),
        setPersonaId,
        handleWebUIMessage,
        abortGeneration: vi.fn(() => false),
        respondToolApproval: vi.fn(),
      }),
    }));

    const { dispatchMethod } = await import('@/server/gateway/method-router');
    await import('@/server/gateway/methods/chat');

    const sent: Array<{ ok?: boolean; error?: { code?: string; message?: string } }> = [];
    await dispatchMethod(
      makeRequest('chat.send', {
        conversationId: 'conv-1',
        content: 'try mismatch',
        personaId: 'persona-b',
      }),
      makeClient('user-scoped'),
      (frame) => sent.push(frame as { ok?: boolean; error?: { code?: string; message?: string } }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].ok).toBe(false);
    expect(sent[0].error?.code).toBe('INVALID_REQUEST');
    expect(String(sent[0].error?.message || '')).toMatch(/persona/i);
    expect(setPersonaId).not.toHaveBeenCalled();
    expect(handleWebUIMessage).not.toHaveBeenCalled();
  });

  it('emits keepalive stream frames during long chat.stream handling', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    process.env.OPENCLAW_CHAT_STREAM_KEEPALIVE_MS = '1000';

    const handleWebUIMessage = vi.fn(
      async (
        _conversationId: string,
        _content: string,
        _userId?: string,
        _clientMessageId?: string,
        _attachments?: unknown[],
        _onStreamDelta?: (delta: string) => void,
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return {
          userMsg: { id: 'msg-user-1' },
          agentMsg: { id: 'msg-agent-1' },
        };
      },
    );

    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: () => ({
        listMessages: vi.fn(() => []),
        listConversations: vi.fn(() => []),
      }),
      getMessageService: () => ({
        getConversation: vi.fn(() => null),
        setPersonaId: vi.fn(),
        handleWebUIMessage,
        abortGeneration: vi.fn(() => false),
        respondToolApproval: vi.fn(),
      }),
    }));

    const { dispatchMethod } = await import('@/server/gateway/method-router');
    await import('@/server/gateway/methods/chat');

    const sent: Array<Record<string, unknown>> = [];
    const streamPromise = dispatchMethod(
      makeRequest('chat.stream', { conversationId: 'conv-1', content: 'build' }, 'req-stream-1'),
      makeClient('user-keepalive'),
      (frame) => sent.push(frame as Record<string, unknown>),
    );

    await vi.advanceTimersByTimeAsync(2600);
    await streamPromise;

    const streamFrames = sent.filter((frame) => frame.type === 'stream');
    expect(streamFrames.some((frame) => frame.done === false && frame.delta === '')).toBe(true);
    expect(streamFrames.at(-1)).toMatchObject({
      type: 'stream',
      id: 'req-stream-1',
      done: true,
      delta: '',
    });
    expect(handleWebUIMessage).toHaveBeenCalledTimes(1);
  });
});
