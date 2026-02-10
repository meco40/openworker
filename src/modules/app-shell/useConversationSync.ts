import { useEffect, useRef, useState } from 'react';
import type { Conversation, Message } from '../../../types';
import {
  appendMessageIfMissing,
  mapConversationApiMessage,
  mapConversationStreamMessage,
  upsertConversationActivity,
} from './runtimeLogic';

interface ConversationListResponse {
  ok: boolean;
  conversations: Conversation[];
}

interface PersistedConversationMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
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

  useEffect(() => {
    const sse = new EventSource('/api/channels/stream');
    sse.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data) as StreamConversationMessage;

        if (payload.conversationId === activeConversationRef.current) {
          setMessages((previous) =>
            appendMessageIfMissing(previous, mapConversationStreamMessage(payload)),
          );
        }

        setConversations((previous) =>
          upsertConversationActivity(previous, payload.conversationId, payload.createdAt),
        );
      } catch {
        // Ignore malformed SSE messages.
      }
    });

    return () => sse.close();
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
