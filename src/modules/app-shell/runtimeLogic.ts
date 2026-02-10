import type { ChannelType, Conversation, Message } from '../../../types';

interface ConversationApiMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  createdAt: string;
  platform: ChannelType;
}

interface ConversationStreamMessage extends ConversationApiMessage {
  conversationId: string;
}

function toUiTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function mapConversationApiMessage(message: ConversationApiMessage): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: toUiTime(message.createdAt),
    platform: message.platform,
  };
}

export function mapConversationStreamMessage(message: ConversationStreamMessage): Message {
  return mapConversationApiMessage(message);
}

export function appendMessageIfMissing(messages: Message[], incoming: Message): Message[] {
  if (messages.some((message) => message.id === incoming.id)) {
    return messages;
  }
  return [...messages, incoming];
}

export function upsertConversationActivity(
  conversations: Conversation[],
  conversationId: string,
  updatedAt: string,
): Conversation[] {
  const existing = conversations.find((conversation) => conversation.id === conversationId);
  if (!existing) {
    return conversations;
  }

  return [
    { ...existing, updatedAt },
    ...conversations.filter((conversation) => conversation.id !== conversationId),
  ];
}

export function buildConversationTitle(now: Date = new Date()): string {
  const stamp = now.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Chat ${stamp}`;
}
