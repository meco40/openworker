/**
 * Chat model routing utilities
 * Extracted from the monolithic index.ts
 */

import type { Conversation, MessageRepository } from '@/server/channels/messages/repository';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { ChannelType } from '@/shared/domain/types';

/**
 * Model routing configuration result
 */
export interface ModelRoutingConfig {
  preferredModelId?: string;
  modelHubProfileId: string;
}

/**
 * Resolve chat model routing configuration for a conversation
 */
export function resolveChatModelRouting(conversation: Conversation): ModelRoutingConfig {
  let preferredModelId = conversation.modelOverride ?? undefined;
  let modelHubProfileId = process.env.MODEL_HUB_PROFILE_ID?.trim() || 'p1';

  if (conversation.personaId) {
    try {
      const persona = getPersonaRepository().getPersona(conversation.personaId);
      if (!preferredModelId && persona?.preferredModelId) {
        preferredModelId = persona.preferredModelId;
      }
      if (persona?.modelHubProfileId?.trim()) {
        modelHubProfileId = persona.modelHubProfileId.trim();
      }
    } catch {
      // Persona storage should not block model routing.
    }
  }

  return {
    preferredModelId,
    modelHubProfileId,
  };
}

/**
 * Check if a conversation is an agent room conversation
 */
export function isAgentRoomConversationRecord(
  conversation: Conversation,
  repo: MessageRepository,
): boolean {
  if (conversation.channelType === ChannelType.AGENT_ROOM) return true;
  if (typeof repo.isAgentRoomConversation === 'function') {
    return repo.isAgentRoomConversation(conversation.id, conversation.userId);
  }
  return false;
}

/**
 * Check if memory is enabled for a conversation
 */
export function isMemoryEnabledForConversation(
  conversation: Conversation,
  repo: MessageRepository,
): boolean {
  return !isAgentRoomConversationRecord(conversation, repo);
}
