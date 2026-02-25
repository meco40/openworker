import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation, Message } from '@/shared/domain/types';
import {
  mapConversationApiMessage,
  mapConversationStreamMessage,
  removeMessageById,
  upsertMessageReplacingStreamingDraft,
  upsertConversationActivity,
} from '@/modules/app-shell/runtimeLogic';
import { getGatewayClient } from '@/modules/gateway/ws-client';

interface ConversationListResponse {
  ok: boolean;
  conversations: Conversation[];
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
  useEffect(() => {
    activeConversationRef.current = activeConversationId;
  }, [activeConversationId]);

  const loadConversations = useCallback(async () => {
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
    } catch (error) {
      console.warn('Failed to load conversations:', error);
    }
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const response = await fetch(`/api/channels/messages?conversationId=${conversationId}`);
      const data = (await response.json()) as ConversationMessagesResponse;
      if (!data.ok) {
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
      void loadConversations();
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
      unsubMessageDeleted();
      unsubState();
    };
  }, [enabled, loadConversations, loadMessages]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!activeConversationId) {
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
