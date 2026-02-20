import { ChannelType } from '@/shared/domain/types';
import type { Conversation, MessageRepository } from '@/server/channels/messages/repository';
import type { ChannelKey } from '@/server/channels/adapters/types';

type ChannelBindingRepo = Pick<
  MessageRepository,
  'updatePersonaId' | 'getChannelBinding' | 'updateChannelBindingPersona'
>;

export function getChannelBindingPersonaId(
  repo: ChannelBindingRepo,
  userId: string,
  platform: ChannelType,
): string | null {
  if (!repo.getChannelBinding) return null;
  const binding = repo.getChannelBinding(userId, platform as string as ChannelKey);
  return binding?.personaId ?? null;
}

export function setChannelBindingPersona(
  repo: ChannelBindingRepo,
  userId: string,
  platform: ChannelType,
  personaId: string | null,
): void {
  if (!repo.updateChannelBindingPersona) return;
  repo.updateChannelBindingPersona(userId, platform as string as ChannelKey, personaId);
}

export function applyChannelBindingPersona(
  repo: ChannelBindingRepo,
  conversation: Conversation,
  platform: ChannelType,
): Conversation {
  // WebChat uses the React Context — skip
  if (platform === ChannelType.WEBCHAT) return conversation;

  // If the conversation already has a persona, use it
  if (conversation.personaId) return conversation;

  const bindingPersonaId = getChannelBindingPersonaId(repo, conversation.userId, platform);
  if (!bindingPersonaId) return conversation;

  repo.updatePersonaId(conversation.id, bindingPersonaId, conversation.userId);
  return { ...conversation, personaId: bindingPersonaId };
}
