import type { ChannelType, Conversation } from '../../../../types';

// ─── Data shapes ─────────────────────────────────────────────

export type { Conversation };

export interface StoredMessage {
  id: string;
  conversationId: string;
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
}

export interface SaveMessageInput {
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  platform: ChannelType;
  externalMsgId?: string;
  senderName?: string;
  metadata?: Record<string, unknown>;
}

// ─── Repository Interface ────────────────────────────────────

export interface MessageRepository {
  createConversation(input: CreateConversationInput): Conversation;
  getConversation(id: string): Conversation | null;
  getConversationByExternalChat(
    channelType: ChannelType,
    externalChatId: string,
  ): Conversation | null;
  getOrCreateConversation(
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
  ): Conversation;
  listConversations(limit?: number): Conversation[];
  updateConversationTitle(id: string, title: string): void;

  saveMessage(input: SaveMessageInput): StoredMessage;
  listMessages(conversationId: string, limit?: number, before?: string): StoredMessage[];
  getDefaultWebChatConversation(): Conversation;
}
