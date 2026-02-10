import type { ChannelType, Message } from '../../../../types';
import type { ChatRole, MessageInput } from '../types';

function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function createTimestamp(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function toMessage(
  content: string,
  platform: ChannelType,
  role: ChatRole,
  overrides: Pick<MessageInput, 'id' | 'timestamp'> = {},
): Message {
  return {
    id: overrides.id ?? createMessageId(),
    role,
    content,
    timestamp: overrides.timestamp ?? createTimestamp(),
    platform,
  };
}
