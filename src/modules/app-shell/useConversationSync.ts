import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Conversation,
  InboxItem,
  InboxPage,
  InboxUpdatedPayload,
  Message,
} from '@/shared/domain/types';
import {
  applyInboxSnapshot,
  mapConversationApiMessage,
  mapConversationStreamMessage,
  removeMessageById,
  upsertConversationFromInboxUpdate,
  upsertMessageReplacingStreamingDraft,
  upsertConversationActivity,
} from '@/modules/app-shell/runtimeLogic';
import { getGatewayClient } from '@/modules/gateway/ws-client';
import { debug } from '@/lib/debug';

interface ConversationListResponse {
  ok: boolean;
  conversations: Conversation[];
}

interface InboxListResponse {
  ok: boolean;
  items: InboxItem[];
  page: InboxPage;
}

interface PersistedConversationMessage {
  id: string;
  conversationId?: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  metadata?: string | null;
  createdAt: string;
  platform: Message['platform'];
}

interface ConversationMessagesResponse {
  ok: boolean;
  messages: PersistedConversationMessage[];
}

interface StreamConversationMessage extends PersistedConversationMessage {
  conversationId: string;
}

interface UseConversationSyncArgs {
  enabled: boolean;
}

function logChatDisplayStep(stage: string, payload: Record<string, unknown> = {}): void {
  debug.api(`[chat.display] ${stage}`, {
    ts: new Date().toISOString(),
    ...payload,
  });
}

export function useConversationSync({ enabled }: UseConversationSyncArgs) {
  const [conversations, setConversations] = useState<Conversation[]>(() => []);
  const [messages, setMessages] = useState<Message[]>(() => []);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => null);

  const activeConversationRef = useRef<string | null>(activeConversationId);
  const loadMessagesRequestIdRef = useRef(0);
  useEffect(() => {
    activeConversationRef.current = activeConversationId;
  }, [activeConversationId]);

  const loadConversations = useCallback(async (options?: { resync?: boolean }) => {
    const isResync = Boolean(options?.resync);
    const startedAt = performance.now();
    logChatDisplayStep('client.inbox.load.start', { resync: isResync });
    try {
      const aggregatedItems: InboxItem[] = [];
      let cursor: string | null = null;
      let pageCount = 0;
      do {
        const params = new URLSearchParams({
          version: '2',
          limit: '100',
        });
        if (cursor) {
          params.set('cursor', cursor);
        }
        if (isResync) {
          params.set('resync', '1');
        }

        const pageStartedAt = performance.now();
        logChatDisplayStep('client.inbox.page.request', {
          page: pageCount + 1,
          resync: isResync,
          hasCursor: Boolean(cursor),
        });
        const response = await fetch(`/api/channels/inbox?${params.toString()}`);
        const data = (await response.json()) as InboxListResponse;
        if (!response.ok || !data.ok) {
          throw new Error('Inbox listing failed');
        }
        logChatDisplayStep('client.inbox.page.response', {
          page: pageCount + 1,
          status: response.status,
          returned: Array.isArray(data.items) ? data.items.length : 0,
          hasMore: Boolean(data.page?.hasMore),
          durationMs: Math.round(performance.now() - pageStartedAt),
        });

        aggregatedItems.push(...(Array.isArray(data.items) ? data.items : []));
        cursor = data.page?.hasMore ? data.page.nextCursor || null : null;
        pageCount += 1;
      } while (cursor && pageCount < 20);

      const previousActiveConversationId = activeConversationRef.current;
      setConversations((previous) => applyInboxSnapshot(previous, aggregatedItems));
      setActiveConversationId((previous) => {
        if (previous && aggregatedItems.some((item) => item.conversationId === previous)) {
          return previous;
        }
        return aggregatedItems[0]?.conversationId || null;
      });
      logChatDisplayStep('client.inbox.load.complete', {
        resync: isResync,
        pageCount,
        returned: aggregatedItems.length,
        previousActiveConversationId,
        nextActiveConversationId:
          previousActiveConversationId || aggregatedItems[0]?.conversationId || null,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      if (isResync) {
        console.warn('Inbox resync failed, falling back to conversations endpoint:', error);
      }
      logChatDisplayStep('client.inbox.load.error', {
        resync: isResync,
        durationMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : 'Inbox listing failed',
      });
      try {
        const fallbackStartedAt = performance.now();
        const response = await fetch('/api/channels/conversations');
        const data = (await response.json()) as ConversationListResponse;
        if (!data.ok) {
          return;
        }
        setConversations(data.conversations);
        if (data.conversations.length > 0 && !activeConversationRef.current) {
          setActiveConversationId(data.conversations[0].id);
        }
        logChatDisplayStep('client.conversations.fallback.complete', {
          returned: data.conversations.length,
          durationMs: Math.round(performance.now() - fallbackStartedAt),
        });
      } catch (fallbackError) {
        console.warn('Failed to load conversations:', fallbackError);
        logChatDisplayStep('client.conversations.fallback.error', {
          message:
            fallbackError instanceof Error ? fallbackError.message : 'Failed to load conversations',
        });
      }
    }
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    const requestId = ++loadMessagesRequestIdRef.current;
    const startedAt = performance.now();
    logChatDisplayStep('client.messages.load.start', {
      conversationId,
      requestId,
    });
    try {
      const response = await fetch(`/api/channels/messages?conversationId=${conversationId}`);
      const data = (await response.json()) as ConversationMessagesResponse;
      if (!data.ok) {
        logChatDisplayStep('client.messages.load.invalid', {
          conversationId,
          requestId,
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return;
      }
      if (requestId !== loadMessagesRequestIdRef.current) {
        logChatDisplayStep('client.messages.load.stale', {
          conversationId,
          requestId,
          currentRequestId: loadMessagesRequestIdRef.current,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return;
      }
      if (activeConversationRef.current !== conversationId) {
        logChatDisplayStep('client.messages.load.inactive', {
          conversationId,
          requestId,
          activeConversationId: activeConversationRef.current,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return;
      }
      setMessages(data.messages.map(mapConversationApiMessage));
      logChatDisplayStep('client.messages.load.complete', {
        conversationId,
        requestId,
        returned: data.messages.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      console.error(error);
      logChatDisplayStep('client.messages.load.error', {
        conversationId,
        requestId,
        durationMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : 'Failed to load messages',
      });
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void loadConversations();
  }, [enabled, loadConversations]);

  // ─── WebSocket Live Updates ──────────────────────────────
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const client = getGatewayClient();
    logChatDisplayStep('client.ws.connect.start');
    client.connect();

    // Listen for chat.message events via WS gateway
    const unsub = client.on('chat.message', (payload) => {
      try {
        const data = payload as StreamConversationMessage;

        if (data.conversationId === activeConversationRef.current) {
          setMessages((previous) =>
            upsertMessageReplacingStreamingDraft(previous, mapConversationStreamMessage(data)),
          );
        }

        setConversations((previous) =>
          upsertConversationActivity(previous, data.conversationId, data.createdAt),
        );
      } catch {
        // Ignore malformed messages.
      }
    });
    const unsubInboxUpdated = client.on('inbox.updated', (payload) => {
      const data = payload as InboxUpdatedPayload;
      if (!data || data.version !== 'v2' || !data.conversationId) {
        return;
      }
      logChatDisplayStep('client.ws.inbox.updated', {
        action: data.action,
        conversationId: data.conversationId,
        hasItem: Boolean(data.item),
      });

      if (data.action === 'delete') {
        setConversations((previous) =>
          previous.filter((conversation) => conversation.id !== data.conversationId),
        );
        if (activeConversationRef.current === data.conversationId) {
          setActiveConversationId(null);
          setMessages([]);
        }
        return;
      }

      if (!data.item) {
        return;
      }
      const item = data.item;

      setConversations((previous) => upsertConversationFromInboxUpdate(previous, item));
    });

    // ─── Session lifecycle events ────────────────────────
    const unsubDeleted = client.on('conversation.deleted', (payload) => {
      const { conversationId } = payload as { conversationId: string };
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (activeConversationRef.current === conversationId) {
        setActiveConversationId(null);
        setMessages([]);
      }
    });

    const unsubReset = client.on('conversation.reset', (payload) => {
      const { newConversationId } = payload as {
        oldConversationId: string | null;
        newConversationId: string;
      };
      // Refresh conversation list — the new conversation will appear
      fetch('/api/channels/conversations')
        .then((r) => r.json())
        .then((data: ConversationListResponse) => {
          if (data.ok) {
            setConversations(data.conversations);
            setActiveConversationId(newConversationId);
          }
        })
        .catch(() => {
          /* ignore */
        });
    });

    const unsubAborted = client.on('chat.aborted', () => {
      // No special UI action needed — the aborted message arrives via chat.message
    });
    const unsubMessageDeleted = client.on('chat.message.deleted', (payload) => {
      const { messageId, conversationId } = payload as {
        messageId?: string;
        conversationId?: string | null;
      };
      const normalizedMessageId = String(messageId || '').trim();
      if (!normalizedMessageId) return;
      if (conversationId && conversationId !== activeConversationRef.current) {
        return;
      }
      setMessages((previous) => removeMessageById(previous, normalizedMessageId));
    });
    const unsubState = client.onStateChange((state) => {
      if (state !== 'connected') return;
      logChatDisplayStep('client.ws.connected.resync', {
        activeConversationId: activeConversationRef.current,
      });
      void loadConversations({ resync: true });
      const currentConversationId = activeConversationRef.current;
      if (currentConversationId) {
        void loadMessages(currentConversationId);
      }
    });

    return () => {
      unsub();
      unsubDeleted();
      unsubReset();
      unsubAborted();
      unsubInboxUpdated();
      unsubMessageDeleted();
      unsubState();
    };
  }, [enabled, loadConversations, loadMessages]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!activeConversationId) {
      loadMessagesRequestIdRef.current += 1;
      setMessages([]);
      return;
    }

    void loadMessages(activeConversationId);
  }, [activeConversationId, enabled, loadMessages]);

  return {
    conversations,
    setConversations,
    messages,
    setMessages,
    activeConversationId,
    setActiveConversationId,
  };
}
