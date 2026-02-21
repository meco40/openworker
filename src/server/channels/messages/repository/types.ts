// ─── Data shapes ─────────────────────────────────────────────

import type { ChannelType, Conversation } from '@/shared/domain/types';

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
  personaId?: string;
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

// ─── Search Options ───────────────────────────────────────────

export interface SearchMessagesOptions {
  userId?: string;
  conversationId?: string;
  personaId?: string;
  role?: 'user' | 'agent' | 'system';
  limit?: number;
}
