import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationSync } from '@/modules/app-shell/useConversationSync';

const gatewayMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  on: vi.fn(() => () => {}),
  onStateChange: vi.fn(() => () => {}),
}));

vi.mock('@/modules/gateway/ws-client', () => ({
  getGatewayClient: () => ({
    connect: gatewayMocks.connect,
    on: gatewayMocks.on,
    onStateChange: gatewayMocks.onStateChange,
  }),
}));

type StateHandler = (state: string) => void;

describe('useConversationSync reconnect behavior', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    gatewayMocks.connect.mockClear();
    gatewayMocks.on.mockClear();
    gatewayMocks.onStateChange.mockClear();
    gatewayMocks.on.mockImplementation(() => () => {});
    gatewayMocks.onStateChange.mockImplementation(() => () => {});
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function getStateHandler(): StateHandler {
    const calls = gatewayMocks.onStateChange.mock.calls as unknown as Array<[StateHandler]>;
    const handler = calls[0]?.[0];
    if (!handler) {
      throw new Error('Expected onStateChange handler to be registered.');
    }
    return handler;
  }

  it('reloads conversations with resync and active history when gateway reconnects', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const urlString = String(url);
      if (urlString.includes('/api/channels/inbox')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            items: [
              {
                conversationId: 'conv-1',
                channelType: 'WebChat',
                title: 'Test Conversation',
                updatedAt: '2026-08-17T10:00:00.000Z',
                lastMessage: null,
              },
            ],
            page: { hasMore: false, nextCursor: null },
          }),
        };
      }
      if (urlString.includes('/api/channels/messages')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                id: 'msg-1',
                conversationId: 'conv-1',
                role: 'user',
                content: 'Hello',
                createdAt: '2026-08-17T10:00:00.000Z',
                platform: 'WebChat',
              },
            ],
          }),
        };
      }
      return { ok: false, json: async () => ({ ok: false }) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useConversationSync({ enabled: true }));

    // Wait for initial load
    await waitFor(() => {
      expect(result.current.conversations.length).toBe(1);
    });

    // Capture the state-change handler registered by the hook
    const stateHandler = getStateHandler();

    // Simulate gateway reconnect
    await act(async () => {
      stateHandler('connected');
    });

    // Verify resync fetch was called with resync=1
    const inboxCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/channels/inbox'),
    );
    expect(inboxCalls.length).toBeGreaterThanOrEqual(2);
    const resyncCall = inboxCalls.find((call) => String(call[0]).includes('resync=1'));
    expect(resyncCall).toBeDefined();

    // Verify messages were reloaded for the active conversation
    const messageCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/channels/messages'),
    );
    expect(messageCalls.length).toBeGreaterThanOrEqual(2);
    expect(String(messageCalls[messageCalls.length - 1][0])).toContain('conversationId=conv-1');
  });

  it('does not reload when gateway state is not connected', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        items: [],
        page: { hasMore: false, nextCursor: null },
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useConversationSync({ enabled: true }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const initialCallCount = fetchMock.mock.calls.length;

    const stateHandler = getStateHandler();

    // Simulate a non-connected state — should not trigger resync
    await act(async () => {
      stateHandler('reconnecting');
    });

    expect(fetchMock.mock.calls.length).toBe(initialCallCount);
  });
});
