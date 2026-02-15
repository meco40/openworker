import type { ChannelType, Conversation, Message, MessageAttachment } from '../../../types';

interface ConversationApiMessage {
  id: string;
  conversationId?: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  metadata?: string | null;
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
  const attachment = parseMessageAttachment(message);
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: toUiTime(message.createdAt),
    platform: message.platform,
    attachment,
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

export function removeConversationById(
  conversations: Conversation[],
  conversationId: string,
): Conversation[] {
  return conversations.filter((conversation) => conversation.id !== conversationId);
}

export function resolveActiveConversationAfterDeletion(
  remainingConversations: Conversation[],
  activeConversationId: string | null,
  deletedConversationId: string,
): string | null {
  if (!activeConversationId) {
    return remainingConversations[0]?.id ?? null;
  }
  const activeStillExists = remainingConversations.some(
    (conversation) => conversation.id === activeConversationId,
  );
  if (activeConversationId !== deletedConversationId && activeStillExists) {
    return activeConversationId;
  }
  return remainingConversations[0]?.id ?? null;
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

function parseMessageAttachment(message: ConversationApiMessage): MessageAttachment | undefined {
  if (!message.metadata?.trim()) return undefined;

  try {
    const parsed = JSON.parse(message.metadata) as {
      attachments?: Array<{
        name?: unknown;
        mimeType?: unknown;
        size?: unknown;
      }>;
    };
    const first = Array.isArray(parsed.attachments) ? parsed.attachments[0] : undefined;
    if (
      !first ||
      typeof first.name !== 'string' ||
      typeof first.mimeType !== 'string' ||
      typeof first.size !== 'number' ||
      !Number.isFinite(first.size)
    ) {
      return undefined;
    }

    const query = new URLSearchParams({
      messageId: message.id,
      index: '0',
    });
    if (message.conversationId) {
      query.set('conversationId', message.conversationId);
    }

    return {
      name: first.name,
      type: first.mimeType,
      size: Math.max(0, Math.floor(first.size)),
      url: `/api/channels/messages/attachments?${query.toString()}`,
    };
  } catch {
    return undefined;
  }
}
