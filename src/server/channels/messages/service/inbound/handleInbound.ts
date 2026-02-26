import { ChannelType } from '@/shared/domain/types';
import type {
  Conversation,
  MessageRepository,
  StoredMessage,
} from '@/server/channels/messages/repository';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import { routeMessage } from '@/server/channels/messages/messageRouter';
import {
  buildMessageAttachmentMetadata,
  type StoredMessageAttachment,
} from '@/server/channels/messages/attachments';
import { getServerEventBus } from '@/server/events/runtime';
import { applyChannelBindingPersona } from '@/server/channels/messages/channelBindingPersona';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import type { SessionManager } from '@/server/channels/messages/sessionManager';
import type { HistoryManager } from '@/server/channels/messages/historyManager';
import type { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import type { RecallService } from '@/server/channels/messages/service/recallService';
import type { SummaryService } from '@/server/channels/messages/service/summaryService';
import {
  handleAutomationCommand,
  handleShellCommand,
  handleSubagentCommand,
  handlePersonaCommand,
  handleApprovalCommand,
  handleProjectCommand,
  type CommandHandlerDeps,
} from '@/server/channels/messages/service/commands';
import { handleMemorySave } from '@/server/channels/messages/service/handlers/memoryHandler';
import { handleInferredShellQuestion } from '@/server/channels/messages/service/handlers/shellInference';
import { dispatchToAI, runModelToolLoop } from '@/server/channels/messages/service/dispatchers/aiDispatcher';
import { isProjectRequiredIntent } from '@/server/channels/messages/service/projectGuard';
import {
  shouldAllowCodeInResponse,
  stripCodeBlocksIfNeeded,
} from '@/server/channels/messages/service/core/configuration';
import type { ServiceState } from '@/server/channels/messages/service/core/types';
import {
  resolveConversationWorkspaceCwd,
  getProjectClarificationKey,
  maybeRequestProjectClarification,
  maybeConsumeProjectClarificationReply,
} from '@/server/channels/messages/service/core/projectManagement';
import {
  resolveChatModelRouting,
  isMemoryEnabledForConversation,
} from '@/server/channels/messages/service/routing/modelRouting';
import {
  buildAutonomousExecutionDirective,
  resolveMaxToolCalls,
  runBuildWorkspacePreflight,
} from '@/server/channels/messages/service/execution/buildExecution';
import {
  inferShellCommandFromNaturalLanguage,
  isExplicitRecallCommand,
} from '@/server/channels/messages/service/types';
import type { ModelRoutingConfig } from '@/server/channels/messages/service/routing/modelRouting';

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
  const {
    platform,
    externalChatId,
    content,
    senderName,
    externalMsgId,
    userId,
    clientMessageId,
    attachments,
    onStreamDelta,
    opts,
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

  try {
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

    const route = routeMessage(content);

    if (route.target === 'session-command') {
      const newConv = deps.repo.createConversation({
        channelType: platform,
        externalChatId: `manual-${userId || 'local'}-${Date.now()}`,
        title: route.payload || undefined,
        userId: conversation.userId,
      });
      const agentMsg = await deps.sendResponse(
        conversation,
        '✨ Neue Konversation erstellt.',
        platform,
        externalChatId,
      );
      return { userMsg, agentMsg, newConversationId: newConv.id };
    }

    if (route.target === 'automation-command') {
      return {
        userMsg,
        agentMsg: await handleAutomationCommand(
          conversation,
          route.payload,
          platform,
          externalChatId,
          deps.sendResponse,
        ),
      };
    }

    if (route.target === 'persona-command') {
      return {
        userMsg,
        agentMsg: await handlePersonaCommand(
          conversation,
          route.payload,
          platform,
          externalChatId,
          deps.repo,
          deps.sendResponse,
        ),
      };
    }

    if (route.target === 'project-command') {
      deps.state.pendingProjectClarifications.delete(
        getProjectClarificationKey(applyChannelBindingPersona(deps.repo, conversation, platform)),
      );
      return {
        userMsg,
        agentMsg: await handleProjectCommand(
          conversation,
          route.payload,
          platform,
          externalChatId,
          deps.repo,
          deps.sendResponse,
        ),
      };
    }

    if (route.target === 'approval-command') {
      return {
        userMsg,
        agentMsg: await handleApprovalCommand(
          conversation,
          route.payload,
          route.command,
          platform,
          externalChatId,
          deps.getCommandHandlerDeps(),
          deps.respondToolApproval,
        ),
      };
    }

    if (route.target === 'shell-command') {
      return {
        userMsg,
        agentMsg: await handleShellCommand(
          conversation,
          route.payload,
          platform,
          externalChatId,
          deps.getCommandHandlerDeps(),
        ),
      };
    }

    if (route.target === 'subagent-command') {
      return {
        userMsg,
        agentMsg: await handleSubagentCommand(
          {
            conversation,
            platform,
            externalChatId,
          },
          route.payload,
          route.command,
          deps.getCommandHandlerDeps(),
        ),
      };
    }

    const effectiveConversation = applyChannelBindingPersona(deps.repo, conversation, platform);
    const memoryEnabledForConversation = isMemoryEnabledForConversation(
      effectiveConversation,
      deps.repo,
    );
    let effectiveUserInput = content;
    let projectCreatedFromClarification: string | null = null;

    const consumedClarification = await maybeConsumeProjectClarificationReply({
      conversation: effectiveConversation,
      platform,
      externalChatId,
      content,
      repo: deps.repo,
      pendingProjectClarifications: deps.state.pendingProjectClarifications,
      sendResponse: deps.sendResponse,
    });

    if (consumedClarification && 'message' in consumedClarification) {
      return { userMsg, agentMsg: consumedClarification.message };
    }
    if (consumedClarification && 'replayTaskInput' in consumedClarification) {
      effectiveUserInput = consumedClarification.replayTaskInput;
      projectCreatedFromClarification = consumedClarification.projectName;
    }

    if (memoryEnabledForConversation) {
      void deps.recallService.maybeLearnFromFeedback(effectiveConversation, content);
    }

    const memorySaveResult = await handleMemorySave(
      {
        conversation: effectiveConversation,
        content,
        platform,
        externalChatId,
        memoryEnabled: memoryEnabledForConversation,
      },
      deps.sendResponse,
    );

    if (memorySaveResult.message) {
      return { userMsg, agentMsg: memorySaveResult.message };
    }

    const projectClarificationMessage = opts?.skipProjectGuard
      ? null
      : await maybeRequestProjectClarification({
          conversation: effectiveConversation,
          platform,
          externalChatId,
          content: effectiveUserInput,
          repo: deps.repo,
          pendingProjectClarifications: deps.state.pendingProjectClarifications,
          sendResponse: deps.sendResponse,
        });
    if (projectClarificationMessage) {
      return { userMsg, agentMsg: projectClarificationMessage };
    }

    const inferredShellCommand = inferShellCommandFromNaturalLanguage(effectiveUserInput);
    if (inferredShellCommand) {
      return {
        userMsg,
        agentMsg: await handleInferredShellQuestion(
          {
            contextBuilder: deps.contextBuilder,
            toolManager: deps.toolManager,
            resolveChatModelRouting: deps.resolveChatModelRouting ?? resolveChatModelRouting,
            resolveConversationWorkspaceCwd: (conversation) =>
              resolveConversationWorkspaceCwd(conversation, deps.repo),
          },
          deps.sendResponse,
          {
            conversation: effectiveConversation,
            platform,
            externalChatId,
            userInput: effectiveUserInput,
            command: inferredShellCommand,
            onStreamDelta,
          },
        ),
      };
    }

    const strictRecall = memoryEnabledForConversation
      ? await deps.recallService.buildStrictEvidenceReply(effectiveConversation, effectiveUserInput)
      : null;
    if (strictRecall) {
      const agentMsg = await deps.sendResponse(
        effectiveConversation,
        strictRecall.content,
        platform,
        externalChatId,
        strictRecall.metadata,
      );
      return { userMsg, agentMsg };
    }

    const activeWorkspaceCwd = resolveConversationWorkspaceCwd(effectiveConversation, deps.repo);
    const buildIntent = isProjectRequiredIntent(effectiveUserInput);
    const activePersona = effectiveConversation.personaId
      ? getPersonaRepository().getPersona(effectiveConversation.personaId)
      : null;
    const isAutonomousPersona = Boolean(activePersona?.isAutonomous);

    let dispatchUserInput = effectiveUserInput;
    const explicitRecallCommand = isExplicitRecallCommand(effectiveUserInput);
    if (buildIntent && activeWorkspaceCwd) {
      const preflight = await runBuildWorkspacePreflight({
        conversation: effectiveConversation,
        platform,
        externalChatId,
        workspaceCwd: activeWorkspaceCwd,
        toolManager: deps.toolManager,
        sendResponse: deps.sendResponse,
      });
      if (preflight.kind === 'approval_required') {
        return { userMsg, agentMsg: preflight.message };
      }
      dispatchUserInput = `${effectiveUserInput}\n\n${preflight.text}`;
    }

    const autonomousExecutionDirective = buildAutonomousExecutionDirective({
      workspaceCwd: activeWorkspaceCwd,
      buildIntent,
      isAutonomousPersona,
    });
    const explicitExecutionDirective = String(opts?.executionDirective || '').trim();
    const executionDirective = explicitExecutionDirective || autonomousExecutionDirective || undefined;

    const modelOutcome = await dispatchToAI(
      {
        contextBuilder: deps.contextBuilder,
        recallService: deps.recallService,
        summaryService: deps.summaryService,
        toolManager: deps.toolManager,
        resolveChatModelRouting: deps.resolveChatModelRouting ?? resolveChatModelRouting,
        runModelToolLoop,
        resolveConversationWorkspaceCwd: (conversation) =>
          resolveConversationWorkspaceCwd(conversation, deps.repo),
        activeRequests: deps.state.activeRequests,
      },
      {
        conversation: effectiveConversation,
        platform,
        externalChatId,
        userInput: dispatchUserInput,
        onStreamDelta,
        turnSeq: userMsg.seq ?? undefined,
        executionDirective,
        maxToolCalls: resolveMaxToolCalls({
          isAutonomousPersona,
          activePersona,
          buildIntent,
          overrideMaxToolCalls: opts?.maxToolCalls,
        }),
        requireToolCall: opts?.requireToolCall,
        skipSummaryRefresh: explicitRecallCommand,
      },
    );

    const normalizedOutput = stripCodeBlocksIfNeeded(
      modelOutcome.content,
      shouldAllowCodeInResponse(effectiveUserInput, modelOutcome.metadata),
    );

    const finalOutput = projectCreatedFromClarification
      ? `Projekt automatisch erstellt und aktiviert: ${projectCreatedFromClarification}\n\n${normalizedOutput}`
      : normalizedOutput;

    const agentMsg = await deps.sendResponse(effectiveConversation, finalOutput, platform, externalChatId, {
      ...modelOutcome.metadata,
      ...(buildIntent ? { executionMode: 'autonomous' } : {}),
      ...(activeWorkspaceCwd ? { workspaceCwd: activeWorkspaceCwd } : {}),
    });

    return { userMsg, agentMsg };
  } finally {
    if (clientMessageId) deps.state.processingMessages.delete(clientMessageId);
  }
}
