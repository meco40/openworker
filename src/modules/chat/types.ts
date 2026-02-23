import type { ChannelType, Message } from '@/shared/domain/types';

export type ChatRole = Message['role'];

export interface MessageInput {
  content: string;
  platform: ChannelType;
  role: ChatRole;
  id?: string;
  timestamp?: string;
}

export interface QueuedChatMessage {
  id: string;
  content: string;
  attachmentName?: string;
}
