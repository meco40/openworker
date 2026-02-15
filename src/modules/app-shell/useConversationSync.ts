import { useEffect, useRef, useState } from 'react';
import type { Conversation, Message } from '../../../types';
import {
  appendMessageIfMissing,
  mapConversationApiMessage,
  mapConversationStreamMessage,
  upsertConversationActivity,
} from './runtimeLogic';
import { getGatewayClient } from '../gateway/ws-client';

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

export function useConversationSync() {
  const [conversations, setConversations] = useState<Conversation[]>(() => []);
  const [messages, setMessages] = useState<Message[]>(() => []);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => null);

  const activeConversationRef = useRef<string | null>(activeConversationId);
  useEffect(() => {
    activeConversationRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    fetch('/api/channels/conversations')
      .then((response) => response.json())
      .then((data: ConversationListResponse) => {
        if (!data.ok) {
          return;
        }
        setConversations(data.conversations);
        if (data.conversations.length > 0 && !activeConversationRef.current) {
          setActiveConversationId(data.conversations[0].id);
        }
      })
      .catch((error) => console.warn('Failed to load conversations:', error));
  }, []);

  // ─── WebSocket Live Updates ──────────────────────────────
  useEffect(() => {
    const client = getGatewayClient();
    client.connect();

    // Listen for chat.message events via WS gateway
    const unsub = client.on('chat.message', (payload) => {
      try {
        const data = payload as StreamConversationMessage;

        if (data.conversationId === activeConversationRef.current) {
          setMessages((previous) =>
            appendMessageIfMissing(previous, mapConversationStreamMessage(data)),
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

    return () => {
      unsub();
      unsubDeleted();
      unsubReset();
      unsubAborted();
    };
  }, []);

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([]);
      return;
    }

    fetch(`/api/channels/messages?conversationId=${activeConversationId}`)
      .then((response) => response.json())
      .then((data: ConversationMessagesResponse) => {
        if (!data.ok) {
          return;
        }
        setMessages(data.messages.map(mapConversationApiMessage));
      })
      .catch(console.error);
  }, [activeConversationId]);

  return {
    conversations,
    setConversations,
    messages,
    setMessages,
    activeConversationId,
    setActiveConversationId,
  };
}
