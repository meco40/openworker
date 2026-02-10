import type { ChannelType, Message } from '../../../types';

export type ChatRole = Message['role'];

export interface MessageInput {
  content: string;
  platform: ChannelType;
  role: ChatRole;
  id?: string;
  timestamp?: string;
}
