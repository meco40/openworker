import type { ChannelType, Conversation } from '../../../../types';

// ─── Data shapes ─────────────────────────────────────────────

export type { Conversation };

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq?: number | null;
  role: 'user' | 'agent' | 'system';
  content: string;
  platform: ChannelType;
  externalMsgId: string | null;
  senderName: string | null;
  metadata: string | null; // JSON
  createdAt: string;
}

// ─── Inputs ──────────────────────────────────────────────────

export interface CreateConversationInput {
  channelType: ChannelType;
  externalChatId?: string;
  title?: string;
  userId?: string;
}

export interface SaveMessageInput {
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  platform: ChannelType;
  externalMsgId?: string;
  senderName?: string;
  metadata?: Record<string, unknown>;
  clientMessageId?: string;
}

export interface ConversationContextState {
  conversationId: string;
  summaryText: string;
  summaryUptoSeq: number;
  updatedAt: string;
}

// ─── Repository Interface ────────────────────────────────────

export interface MessageRepository {
  createConversation(input: CreateConversationInput): Conversation;
  // `userId` remains optional temporarily for legacy fallback paths.
  getConversation(id: string, userId?: string): Conversation | null;
  getConversationByExternalChat(
    channelType: ChannelType,
    externalChatId: string,
    userId?: string,
  ): Conversation | null;
  getOrCreateConversation(
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
    userId?: string,
  ): Conversation;
  listConversations(limit?: number, userId?: string): Conversation[];
  updateConversationTitle(id: string, title: string): void;

  saveMessage(input: SaveMessageInput): StoredMessage;
  listMessages(conversationId: string, limit?: number, before?: string, userId?: string): StoredMessage[];
  getDefaultWebChatConversation(userId?: string): Conversation;

  deleteConversation(id: string, userId: string): boolean;
  updateModelOverride(id: string, modelOverride: string | null, userId: string): void;
  findMessageByClientId(conversationId: string, clientMessageId: string): StoredMessage | null;

  getConversationContext(conversationId: string, userId?: string): ConversationContextState | null;
  upsertConversationContext(
    conversationId: string,
    summaryText: string,
    summaryUptoSeq: number,
    userId?: string,
  ): ConversationContextState;
}
