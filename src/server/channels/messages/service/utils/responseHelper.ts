import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import { deliverOutbound } from '@/server/channels/outbound/router';
import { getServerEventBus } from '@/server/events/runtime';
import type { HistoryManager } from '@/server/channels/messages/historyManager';
import type { SubagentManager } from '@/server/channels/messages/service/subagentManager';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';

export interface CommandHandlerDeps {
  subagentManager: SubagentManager;
  toolManager: ToolManager;
  historyManager: HistoryManager;
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<StoredMessage>;
  startSubagentRun: (params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    agentId: string;
    task: string;
    guidance?: string;
    modelOverride?: string;
  }) => Promise<import('@/server/agents/subagentRegistry').SubagentRunRecord>;
  runSubagent: (params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: import('@/server/agents/subagentRegistry').SubagentRunRecord;
  }) => Promise<void>;
}

export function createSendResponse(historyManager: HistoryManager) {
  return async function sendResponse(
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ): Promise<StoredMessage> {
    const agentMsg = historyManager.appendAgentMessage(
      conversation.id,
      platform,
      content,
      metadata,
    );
    getServerEventBus().publish('chat.message.persisted', {
      conversation,
      message: agentMsg,
    });

    broadcastToUser(conversation.userId, GatewayEvents.CHAT_MESSAGE, agentMsg);

    try {
      await deliverOutbound(platform, externalChatId, content, {
        personaId: conversation.personaId ?? undefined,
      });
    } catch (error) {
      console.error(`Outbound delivery failed for ${platform}:`, error);
    }

    return agentMsg;
  };
}
