import type {
  ChannelType,
  Conversation,
  InboxItem,
  Message,
  MessageAttachment,
} from '@/shared/domain/types';

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

export const STREAMING_DRAFT_ID_PREFIX = 'stream-local-';

type ParsedMessageMetadata = {
  attachments?: Array<{
    name?: unknown;
    mimeType?: unknown;
    size?: unknown;
  }>;
  status?: unknown;
  approvalToken?: unknown;
  approval_token?: unknown;
  approvalPrompt?: unknown;
  approval_prompt?: unknown;
  approvalToolId?: unknown;
  approvalToolFunction?: unknown;
};

function toUiTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function mapConversationApiMessage(message: ConversationApiMessage): Message {
  const parsedMetadata = parseMessageMetadata(message.metadata);
  const attachment = parseMessageAttachment(message, parsedMetadata);
  const approvalRequest = parseMessageApprovalRequest(parsedMetadata);
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: toUiTime(message.createdAt),
    conversationId: message.conversationId,
    platform: message.platform,
    attachment,
    approvalRequest,
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

export function upsertMessageReplacingStreamingDraft(
  messages: Message[],
  incoming: Message,
): Message[] {
  if (messages.some((message) => message.id === incoming.id)) {
    return messages;
  }

  if (incoming.role === 'agent') {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.id.startsWith(STREAMING_DRAFT_ID_PREFIX)) {
        const next = [...messages];
        next[index] = incoming;
        return next;
      }
    }
  }

  return [...messages, incoming];
}

export function removeMessageById(messages: Message[], messageId: string): Message[] {
  return messages.filter((message) => message.id !== messageId);
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

function compareConversationOrder(a: Conversation, b: Conversation): number {
  const updatedAtCompare = b.updatedAt.localeCompare(a.updatedAt);
  if (updatedAtCompare !== 0) return updatedAtCompare;
  return b.id.localeCompare(a.id);
}

export function upsertConversationFromInboxUpdate(
  conversations: Conversation[],
  item: Pick<InboxItem, 'conversationId' | 'channelType' | 'title' | 'updatedAt'>,
): Conversation[] {
  const existing = conversations.find((conversation) => conversation.id === item.conversationId);
  if (existing && existing.updatedAt.localeCompare(item.updatedAt) > 0) {
    return conversations;
  }

  const nextConversation: Conversation = existing
    ? {
        ...existing,
        channelType: item.channelType,
        title: item.title,
        updatedAt: item.updatedAt,
      }
    : {
        id: item.conversationId,
        channelType: item.channelType,
        externalChatId: null,
        userId: 'unknown',
        title: item.title,
        modelOverride: null,
        personaId: null,
        createdAt: item.updatedAt,
        updatedAt: item.updatedAt,
      };

  const withoutCurrent = conversations.filter(
    (conversation) => conversation.id !== item.conversationId,
  );
  return [nextConversation, ...withoutCurrent].sort(compareConversationOrder);
}

export function applyInboxSnapshot(
  conversations: Conversation[],
  items: Array<Pick<InboxItem, 'conversationId' | 'channelType' | 'title' | 'updatedAt'>>,
): Conversation[] {
  const previousById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  const nextById = new Map<string, Conversation>();

  for (const item of items) {
    const existing = previousById.get(item.conversationId);
    const nextConversation: Conversation = existing
      ? {
          ...existing,
          channelType: item.channelType,
          title: item.title,
          updatedAt: item.updatedAt,
        }
      : {
          id: item.conversationId,
          channelType: item.channelType,
          externalChatId: null,
          userId: 'unknown',
          title: item.title,
          modelOverride: null,
          personaId: null,
          createdAt: item.updatedAt,
          updatedAt: item.updatedAt,
        };
    nextById.set(nextConversation.id, nextConversation);
  }

  return Array.from(nextById.values()).sort(compareConversationOrder);
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

function parseMessageMetadata(raw: string | null | undefined): ParsedMessageMetadata | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ParsedMessageMetadata;
  } catch {
    return null;
  }
}

function parseMessageAttachment(
  message: ConversationApiMessage,
  metadata: ParsedMessageMetadata | null,
): MessageAttachment | undefined {
  if (!metadata) return undefined;
  const first = Array.isArray(metadata.attachments) ? metadata.attachments[0] : undefined;
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
}

function parseMessageApprovalRequest(
  metadata: ParsedMessageMetadata | null,
): Message['approvalRequest'] {
  if (!metadata) return undefined;
  if (String(metadata.status || '').trim() !== 'approval_required') return undefined;

  const tokenValue =
    typeof metadata.approvalToken === 'string'
      ? metadata.approvalToken
      : typeof metadata.approval_token === 'string'
        ? metadata.approval_token
        : '';
  const token = tokenValue.trim();
  if (!token) return undefined;

  const prompt =
    typeof metadata.approvalPrompt === 'string'
      ? metadata.approvalPrompt.trim() || undefined
      : typeof metadata.approval_prompt === 'string'
        ? metadata.approval_prompt.trim() || undefined
        : undefined;
  const toolId =
    typeof metadata.approvalToolId === 'string'
      ? metadata.approvalToolId.trim() || undefined
      : undefined;
  const toolFunctionName =
    typeof metadata.approvalToolFunction === 'string'
      ? metadata.approvalToolFunction.trim() || undefined
      : undefined;

  return {
    token,
    prompt,
    toolId,
    toolFunctionName,
  };
}
