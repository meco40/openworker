import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import * as memoryRuntime from '@/server/memory/runtime';

export function resolveVectorCountScopes(userId?: string): string[] {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return [];
  if (normalizedUserId !== LEGACY_LOCAL_USER_ID) return [normalizedUserId];

  const scopes = new Set<string>([normalizedUserId]);
  try {
    const conversations = getMessageRepository().listConversations(500, normalizedUserId);
    for (const conversation of conversations) {
      const channel = String(conversation.channelType || '')
        .trim()
        .toLowerCase();
      const externalChatId = String(conversation.externalChatId || '').trim();
      if (!channel || !externalChatId || channel === 'webchat') continue;
      scopes.add(`channel:${channel}:${externalChatId}`);
    }
  } catch (error) {
    console.warn('Vector scope discovery failed:', error);
  }

  return Array.from(scopes);
}

export async function resolveVectorNodeCount(userId?: string): Promise<number> {
  const runtimeWithOptional = memoryRuntime as typeof memoryRuntime & {
    getMemoryServiceIfReady?: () => ReturnType<typeof memoryRuntime.getMemoryService> | null;
  };
  const guardedService =
    'getMemoryServiceIfReady' in runtimeWithOptional
      ? runtimeWithOptional.getMemoryServiceIfReady?.()
      : undefined;
  if (guardedService === null) {
    return -1;
  }

  const memoryService = guardedService ?? memoryRuntime.getMemoryService();
  const scopes = resolveVectorCountScopes(userId);
  if (scopes.length === 0) {
    return memoryService.count();
  }
  if (scopes.length === 1) {
    return memoryService.count(undefined, scopes[0]);
  }

  const concurrency = 5;
  let total = 0;
  for (let index = 0; index < scopes.length; index += concurrency) {
    const batch = scopes.slice(index, index + concurrency);
    const counts = await Promise.all(
      batch.map((scopeUserId) => memoryService.count(undefined, scopeUserId)),
    );
    for (const count of counts) {
      total += count;
    }
  }
  return total;
}

const VECTOR_COUNT_TIMEOUT_MS = 3000;

export async function resolveVectorNodeCountSafe(userId?: string): Promise<number> {
  try {
    return await Promise.race([
      resolveVectorNodeCount(userId),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('vectorNodeCount timeout')), VECTOR_COUNT_TIMEOUT_MS),
      ),
    ]);
  } catch {
    return -1;
  }
}
