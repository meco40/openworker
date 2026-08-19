import { ChannelType } from '@/shared/domain/types';
import type {
  Conversation,
  MessageRepository,
  StoredMessage,
} from '@/server/channels/messages/repository';
import type { StoredMessageAttachment } from '@/server/channels/messages/attachments';
import type { SessionManager } from '@/server/channels/messages/sessionManager';
import type { HistoryManager } from '@/server/channels/messages/historyManager';
import type { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import type { RecallService } from '@/server/channels/messages/service/recall';
import type { SummaryService } from '@/server/channels/messages/service/summaryService';
import type { CommandHandlerDeps } from '@/server/channels/messages/service/commands';
import type { ServiceState } from '@/server/channels/messages/service/core/types';
import type { ModelRoutingConfig } from '@/server/channels/messages/service/routing/modelRouting';
import { createInboundContextStage } from './stages/createInboundContextStage';
import { routeCommandStage } from './stages/routeCommandStage';
import { prepareDispatchStage } from './stages/prepareDispatchStage';
import { dispatchModelStage } from './stages/dispatchModelStage';
import {
  correlateInboundResponse,
  looksLikeResponse,
} from '@/server/world-model/services/inboundResponseCorrelation';
import { getWorldModelConfig } from '@/server/world-model/config';
import { recordObservation } from '@/server/world-model/services/observationService';
import { isWorldModelRequired } from '@/server/world-model/mode';
import { bridgeStoredChatMessage } from '@/server/world-model/liveChatBridge';

export interface HandleInboundDeps {
  repo: MessageRepository;
  sessionManager: SessionManager;
  historyManager: HistoryManager;
  contextBuilder: ContextBuilder;
  toolManager: ToolManager;
  recallService: RecallService;
  summaryService: SummaryService;
  state: ServiceState;
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<StoredMessage>;
  getCommandHandlerDeps: () => CommandHandlerDeps;
  respondToolApproval: (params: {
    conversationId: string;
    userId: string;
    approvalToken: string;
    approved: boolean;
    approveAlways?: boolean;
    toolId?: string;
    toolFunctionName?: string;
  }) => Promise<{
    ok: boolean;
    status: 'approved' | 'denied' | 'not_found' | 'approval_required';
    policyUpdated: boolean;
  }>;
  resolveChatModelRouting?: (conversation: Conversation) => ModelRoutingConfig;
}

export interface HandleInboundParams {
  platform: ChannelType;
  externalChatId: string;
  content: string;
  senderName?: string;
  externalMsgId?: string;
  userId?: string;
  clientMessageId?: string;
  attachments?: StoredMessageAttachment[];
  onStreamDelta?: (delta: string) => void;
  opts?: {
    skipProjectGuard?: boolean;
    executionDirective?: string;
    maxToolCalls?: number;
    requireToolCall?: boolean;
  };
}

export async function handleInboundMessage(
  deps: HandleInboundDeps,
  params: HandleInboundParams,
): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage; newConversationId?: string }> {
  const { clientMessageId } = params;

  try {
    const context = createInboundContextStage(deps, params);

    // The persisted message id is the canonical source identity used by both
    // live ingestion and backfill. In canonical mode a failed write is
    // propagated by the bridge; shadow/off remain fail-soft.
    await bridgeStoredChatMessage({
      conversation: context.effectiveConversation,
      message: context.userMsg,
    });

    // --- World-Model Response Correlation (Phase 9) ---
    // Prueft, ob die eingehende Nachricht eine Antwort auf eine proaktive
    // Frage (Open Loop) oder ein Event-Follow-up ist. Bei einem Treffer wird
    // der Zustand atomar aktualisiert, bevor das LLM antwortet.
    if (looksLikeResponse(params.content)) {
      const worldModelConfig = getWorldModelConfig();
      if (
        (worldModelConfig.enabled || worldModelConfig.e2eEnabled) &&
        context.effectiveConversation.personaId
      ) {
        let observationId: string | undefined;
        const observationSourceId = context.userMsg.id;
        try {
          const observation = await recordObservation(
            {
              userId: context.effectiveConversation.userId,
              personaId: context.effectiveConversation.personaId ?? '',
              workspaceId: context.effectiveConversation.workspaceId ?? '',
              sourceType: 'chat_message',
              sourceId: observationSourceId,
              occurredAt: new Date().toISOString(),
              payload: {
                conversationId: context.effectiveConversation.id,
                seq: context.userMsg.seq,
                role: 'user',
                text: params.content,
                channelType: params.platform,
                externalChatId: params.externalChatId,
                externalMsgId: params.externalMsgId,
              },
              sourceAuthority: 'user',
            },
            {
              userId: context.effectiveConversation.userId,
              personaId: context.effectiveConversation.personaId ?? '',
              workspaceId: context.effectiveConversation.workspaceId ?? '',
            },
          );
          observationId = observation.observation.id;
        } catch (error) {
          if (isWorldModelRequired(worldModelConfig.mode)) throw error;
          console.error('[world-model:correlation] inbound observation failed:', error);
        }
        await correlateInboundResponse({
          conversation: context.effectiveConversation,
          userMessage: {
            text: params.content,
            receivedAt: new Date().toISOString(),
            observationId,
            sourceId: observationSourceId,
          },
        }).catch((error) => {
          console.error('[world-model:correlation] inbound correlation failed:', error);
        });
      }
    }

    const routed = await routeCommandStage({
      deps,
      route: context.route,
      userMsg: context.userMsg,
      effectiveConversation: context.effectiveConversation,
      platform: params.platform,
      externalChatId: params.externalChatId,
      userId: params.userId,
      toolsDisabledForPersona: context.toolsDisabledForPersona,
    });
    if (routed) {
      return routed;
    }

    const prepared = await prepareDispatchStage({
      deps,
      params,
      userMsg: context.userMsg,
      effectiveConversation: context.effectiveConversation,
      toolsDisabledForPersona: context.toolsDisabledForPersona,
    });
    if (prepared.kind === 'done') {
      return prepared.result;
    }

    return dispatchModelStage({
      deps,
      params,
      userMsg: context.userMsg,
      effectiveConversation: context.effectiveConversation,
      activePersona: context.activePersona,
      toolsDisabledForPersona: context.toolsDisabledForPersona,
      effectiveUserInput: prepared.effectiveUserInput,
      projectCreatedFromClarification: prepared.projectCreatedFromClarification,
    });
  } finally {
    if (clientMessageId) deps.state.processingMessages.delete(clientMessageId);
  }
}
