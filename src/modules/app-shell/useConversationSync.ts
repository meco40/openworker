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

        const response = await fetch(`/api/channels/inbox?${params.toString()}`);
        const data = (await response.json()) as InboxListResponse;
        if (!response.ok || !data.ok) {
          throw new Error('Inbox listing failed');
        }

        aggregatedItems.push(...(Array.isArray(data.items) ? data.items : []));
        cursor = data.page?.hasMore ? data.page.nextCursor || null : null;
        pageCount += 1;
      } while (cursor && pageCount < 20);

      setConversations((previous) => applyInboxSnapshot(previous, aggregatedItems));
      setActiveConversationId((previous) => {
        if (previous && aggregatedItems.some((item) => item.conversationId === previous)) {
          return previous;
        }
        return aggregatedItems[0]?.conversationId || null;
      });
    } catch (error) {
      if (isResync) {
        console.warn('Inbox resync failed, falling back to conversations endpoint:', error);
      }
      try {
        const response = await fetch('/api/channels/conversations');
        const data = (await response.json()) as ConversationListResponse;
        if (!data.ok) {
          return;
        }
        setConversations(data.conversations);
        if (data.conversations.length > 0 && !activeConversationRef.current) {
          setActiveConversationId(data.conversations[0].id);
        }
      } catch (fallbackError) {
        console.warn('Failed to load conversations:', fallbackError);
      }
    }
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    const requestId = ++loadMessagesRequestIdRef.current;
    try {
      const response = await fetch(`/api/channels/messages?conversationId=${conversationId}`);
      const data = (await response.json()) as ConversationMessagesResponse;
      if (!data.ok) {
        return;
      }
      if (requestId !== loadMessagesRequestIdRef.current) {
        return;
      }
      if (activeConversationRef.current !== conversationId) {
        return;
      }
      setMessages(data.messages.map(mapConversationApiMessage));
    } catch (error) {
      console.error(error);
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
