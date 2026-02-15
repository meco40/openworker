import { ChannelType, type Conversation } from '../../../types';
import { LEGACY_LOCAL_USER_ID } from '../auth/constants';

function normalizePlatform(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function normalizeExternalChatId(value: string): string {
  return String(value || '').trim();
}

export interface MemoryScopeInput {
  userId?: string | null;
  channelType?: ChannelType | string | null;
  externalChatId?: string | null;
}

export function resolveMemoryScopedUserId(input: MemoryScopeInput): string {
  const baseUserId = String(input.userId || '').trim() || LEGACY_LOCAL_USER_ID;
  if (baseUserId !== LEGACY_LOCAL_USER_ID) return baseUserId;

  const normalizedPlatform = normalizePlatform(String(input.channelType || ''));
  const normalizedExternalChatId = normalizeExternalChatId(String(input.externalChatId || ''));
  if (!normalizedPlatform || !normalizedExternalChatId) return baseUserId;
  if (normalizedPlatform === normalizePlatform(String(ChannelType.WEBCHAT))) return baseUserId;

  return `channel:${normalizedPlatform}:${normalizedExternalChatId}`;
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
  if (primary === LEGACY_LOCAL_USER_ID) return [primary];
  const baseUserId = String(input.userId || '').trim() || LEGACY_LOCAL_USER_ID;
  if (baseUserId !== LEGACY_LOCAL_USER_ID) return [primary];
  return [primary, LEGACY_LOCAL_USER_ID];
}
