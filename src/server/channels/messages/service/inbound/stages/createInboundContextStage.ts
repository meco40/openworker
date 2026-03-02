import { routeMessage } from '@/server/channels/messages/messageRouter';
import { buildMessageAttachmentMetadata } from '@/server/channels/messages/attachments';
import { getServerEventBus } from '@/server/events/runtime';
import { applyChannelBindingPersona } from '@/server/channels/messages/channelBindingPersona';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import { areToolsDisabledForPersona } from '@/server/channels/messages/service/core/toolPolicy';
import type { HandleInboundDeps, HandleInboundParams } from '../handleInbound';

export interface CreateInboundContextResult {
  conversation: ReturnType<HandleInboundDeps['sessionManager']['getOrCreateConversation']>;
  userMsg: ReturnType<HandleInboundDeps['historyManager']['appendUserMessage']>;
  effectiveConversation: ReturnType<typeof applyChannelBindingPersona>;
  activePersona: ReturnType<ReturnType<typeof getPersonaRepository>['getPersona']>;
  toolsDisabledForPersona: boolean;
  route: ReturnType<typeof routeMessage>;
}

export function createInboundContextStage(
  deps: HandleInboundDeps,
  params: HandleInboundParams,
): CreateInboundContextResult {
  const {
    platform,
    externalChatId,
    content,
    senderName,
    externalMsgId,
    userId,
    clientMessageId,
    attachments,
  } = params;

  const conversation = deps.sessionManager.getOrCreateConversation(
    deps.repo,
    platform,
    externalChatId,
    undefined,
    userId,
  );

  if (clientMessageId && deps.state.processingMessages.has(clientMessageId)) {
    throw new Error('Duplicate request — already processing');
  }
  if (clientMessageId) deps.state.processingMessages.add(clientMessageId);

  const userMsg = deps.historyManager.appendUserMessage(conversation.id, platform, content, {
    externalMsgId,
    senderName,
    clientMessageId,
    metadata: buildMessageAttachmentMetadata(attachments),
  });
  getServerEventBus().publish('chat.message.persisted', {
    conversation,
    message: userMsg,
  });
  broadcastToUser(conversation.userId, GatewayEvents.CHAT_MESSAGE, userMsg);

  const effectiveConversation = applyChannelBindingPersona(deps.repo, conversation, platform);
  const activePersona = effectiveConversation.personaId
    ? getPersonaRepository().getPersona(effectiveConversation.personaId)
    : null;
  const toolsDisabledForPersona = areToolsDisabledForPersona(activePersona);

  return {
    conversation,
    userMsg,
    effectiveConversation,
    activePersona,
    toolsDisabledForPersona,
    route: routeMessage(content),
  };
}
