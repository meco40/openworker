import type { ChannelType, Conversation } from '../../../types';
import { LEGACY_LOCAL_USER_ID } from '../auth/constants';

export interface MemoryScopeInput {
  userId?: string | null;
  channelType?: ChannelType | string | null;
  externalChatId?: string | null;
}

export function resolveMemoryScopedUserId(input: MemoryScopeInput): string {
  const baseUserId = String(input.userId || '').trim() || LEGACY_LOCAL_USER_ID;

  // Authenticated user: always use their real ID regardless of channel
  if (baseUserId !== LEGACY_LOCAL_USER_ID) return baseUserId;

  // Single-user mode (legacy-local-user): unified memory across ALL channels.
  // Telegram, WhatsApp, webchat all share the same memory scope so that
  // memories stored via one channel are visible when recalling from another.
  return LEGACY_LOCAL_USER_ID;
}

export function resolveMemoryScopedUserIdForConversation(
  conversation: Pick<Conversation, 'userId' | 'channelType' | 'externalChatId'>,
): string {
  return resolveMemoryScopedUserId({
    userId: conversation.userId,
    channelType: conversation.channelType,
    externalChatId: conversation.externalChatId || 'default',
  });
}

export function resolveMemoryUserIdCandidates(input: MemoryScopeInput): string[] {
  const primary = resolveMemoryScopedUserId(input);
  // In single-user mode all channels resolve to the same ID — no fallback needed.
  // In multi-user mode the authenticated ID is used directly.
  return [primary];
}
