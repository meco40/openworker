/**
 * MessageService - Main entry point
 * Refactored from monolithic 1197 lines to modular architecture
 */

import { ChannelType } from '@/shared/domain/types';
import type {
  MessageRepository,
  StoredMessage,
  Conversation,
} from '@/server/channels/messages/repository';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import { routeMessage } from '@/server/channels/messages/messageRouter';
import {
  buildMessageAttachmentMetadata,
  deleteStoredAttachmentFile,
  extractStoredAttachmentsFromMetadata,
  type StoredMessageAttachment,
} from '@/server/channels/messages/attachments';
import { getServerEventBus } from '@/server/events/runtime';
import { SessionManager } from '@/server/channels/messages/sessionManager';
import { HistoryManager } from '@/server/channels/messages/historyManager';
import { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import { applyChannelBindingPersona } from '@/server/channels/messages/channelBindingPersona';
import { getPersonaRepository } from '@/server/personas/personaRepository';

import { SubagentManager } from './subagentManager';
import { ToolManager } from './toolManager';
import { RecallService } from './recallService';
import { SummaryService } from './summaryService';
import { createSendResponse } from './utils/responseHelper';
import { handleMemorySave } from './handlers/memoryHandler';
import { dispatchToAI, runModelToolLoop } from './dispatchers/aiDispatcher';
import {
  handleAutomationCommand,
  handleShellCommand,
  handleSubagentCommand,
  handlePersonaCommand,
  handleApprovalCommand,
  handleProjectCommand,
  type CommandHandlerDeps,
} from './commands';

// Core types and utils
import { inferShellCommandFromNaturalLanguage, isExplicitRecallCommand } from './types';
import { isProjectRequiredIntent } from './projectGuard';

// Core modules
import {
  getSubagentMaxActivePerConversation,
  requiresInteractiveToolApproval,
  shouldAllowCodeInResponse,
  stripCodeBlocksIfNeeded,
} from './core/configuration';
import type { ServiceState } from './core/types';
import {
  resolveConversationWorkspace,
  resolveConversationWorkspaceCwd,
  getProjectClarificationKey,
  maybeRequestProjectClarification,
  maybeConsumeProjectClarificationReply,
} from './core/projectManagement';

// Routing modules
import {
  resolveChatModelRouting,
  isAgentRoomConversationRecord,
  isMemoryEnabledForConversation,
} from './routing/modelRouting';

// Execution modules
import {
  buildAutonomousExecutionDirective,
  resolveMaxToolCalls,
  runBuildWorkspacePreflight,
} from './execution/buildExecution';
import { runSubagent, invokeSubagentToolCall } from './execution/subagentExecution';
import { respondToolApproval } from './execution/toolApproval';

// Handler modules
import { handleInferredShellQuestion } from './handlers/shellInference';
import { handleWebUIMessage } from './handlers/webUIHandler';

// Re-export types for consumers
export * from './types';
export { SubagentManager, ToolManager, RecallService, SummaryService };
export type { CommandHandlerDeps };
export { createSendResponse } from './utils/responseHelper';
export { handleMemorySave } from './handlers/memoryHandler';
export { dispatchToAI, runModelToolLoop } from './dispatchers/aiDispatcher';
export { runSubagent, invokeSubagentToolCall } from './subagent/executor';
export { respondToolApproval as execRespondToolApproval } from './approval/handler';

export class MessageService {
  private readonly sessionManager = new SessionManager();
  private readonly historyManager: HistoryManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly subagentManager: SubagentManager;
  private readonly toolManager: ToolManager;
  private readonly recallService: RecallService;
  private readonly summaryService: SummaryService;
  private readonly summaryRefreshInFlight: Set<string>;

  /** Service state container */
  private readonly state: ServiceState;

  // Bound sendResponse function
  private readonly sendResponse: ReturnType<typeof createSendResponse>;

  constructor(private readonly repo: MessageRepository) {
    this.historyManager = new HistoryManager(repo);
    this.contextBuilder = new ContextBuilder(repo);
    this.subagentManager = new SubagentManager(
      () => getSubagentMaxActivePerConversation(),
      (conversation) => this.resolveWorkspaceWithRepo(conversation),
    );
    this.toolManager = new ToolManager(
      () => requiresInteractiveToolApproval(),
      this.invokeSubagentToolCall.bind(this),
    );
    this.recallService = new RecallService(
      (query, options) => {
        if (typeof this.repo.searchMessages !== 'function') return [];
        return this.repo.searchMessages(query, options);
      },
      (conversation) => this.isMemoryEnabledWithRepo(conversation),
    );
    this.summaryService = new SummaryService(repo);
    this.summaryRefreshInFlight = (
      this.summaryService as unknown as { summaryRefreshInFlight: Set<string> }
    ).summaryRefreshInFlight;

    // Initialize state
    this.state = {
      activeRequests: new Map<string, AbortController>(),
      processingMessages: new Set<string>(),
      pendingProjectClarifications: new Map(),
    };

    this.sendResponse = createSendResponse(this.historyManager);
  }

  // --- Helper methods for dependency injection ---

  private resolveWorkspaceWithRepo(conversation: Conversation): {
    projectId?: string;
    workspacePath?: string;
    workspaceRelativePath?: string;
  } | null {
    return resolveConversationWorkspace(conversation, this.repo);
  }

  private isMemoryEnabledWithRepo(conversation: Conversation): boolean {
    return isMemoryEnabledForConversation(conversation, this.repo);
  }

  // --- Conversation Management --------------------------------

  listConversations(userId?: string, limit?: number): Conversation[] {
    const resolvedUserId = this.sessionManager.resolveUserId(userId);
    return this.repo.listConversations(limit, resolvedUserId);
  }

  getOrCreateConversation(
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
    userId?: string,
  ): Conversation {
    return this.sessionManager.getOrCreateConversation(
      this.repo,
      channelType,
      externalChatId,
      title,
      userId,
    );
  }

  getDefaultWebChatConversation(userId?: string): Conversation {
    const resolvedUserId = this.sessionManager.resolveUserId(userId);
    return this.repo.getDefaultWebChatConversation(resolvedUserId);
  }

  getConversation(conversationId: string, userId?: string): Conversation | null {
    const resolvedUserId = this.sessionManager.resolveUserId(userId);
    return this.repo.getConversation(conversationId, resolvedUserId);
  }

  isAgentRoomConversation(conversationId: string, userId?: string): boolean {
    const conversation = this.getConversation(conversationId, userId);
    if (!conversation) return false;
    return isAgentRoomConversationRecord(conversation, this.repo);
  }

  listMessages(
    conversationId: string,
    userId?: string,
    limit?: number,
    before?: string,
  ): StoredMessage[] {
    const resolvedUserId = this.sessionManager.resolveUserId(userId);
    return this.repo.listMessages(conversationId, limit, before, resolvedUserId);
  }

  getMessage(messageId: string, userId?: string): StoredMessage | null {
    const resolvedUserId = this.sessionManager.resolveUserId(userId);
    if (this.repo.getMessage) {
      return this.repo.getMessage(messageId, resolvedUserId);
    }
    return null;
  }

  // --- Core: Handle Inbound Message --------------------------

  async handleInbound(
    platform: ChannelType,
    externalChatId: string,
    content: string,
    senderName?: string,
    externalMsgId?: string,
    userId?: string,
    clientMessageId?: string,
    attachments?: StoredMessageAttachment[],
    onStreamDelta?: (delta: string) => void,
    opts?: {
      skipProjectGuard?: boolean;
      executionDirective?: string;
      maxToolCalls?: number;
      requireToolCall?: boolean;
    },
  ): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage; newConversationId?: string }> {
    const conversation = this.sessionManager.getOrCreateConversation(
      this.repo,
      platform,
      externalChatId,
      undefined,
      userId,
    );

    // In-memory deduplication: if this clientMessageId is already being processed, reject
    if (clientMessageId && this.state.processingMessages.has(clientMessageId)) {
      throw new Error('Duplicate request — already processing');
    }
    if (clientMessageId) this.state.processingMessages.add(clientMessageId);

    try {
      const userMsg = this.historyManager.appendUserMessage(conversation.id, platform, content, {
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

      // --- /new or /reset ? create fresh conversation ------
      if (route.target === 'session-command') {
        const newConv = this.repo.createConversation({
          channelType: platform,
          externalChatId: `manual-${userId || 'local'}-${Date.now()}`,
          title: route.payload || undefined,
          userId: conversation.userId,
        });
        const agentMsg = await this.sendResponse(
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
            this.sendResponse.bind(this),
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
            this.repo,
            this.sendResponse.bind(this),
          ),
        };
      }

      if (route.target === 'project-command') {
        this.state.pendingProjectClarifications.delete(
          getProjectClarificationKey(applyChannelBindingPersona(this.repo, conversation, platform)),
        );
        return {
          userMsg,
          agentMsg: await handleProjectCommand(
            conversation,
            route.payload,
            platform,
            externalChatId,
            this.repo,
            this.sendResponse.bind(this),
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
            this.getCommandHandlerDeps(),
            this.respondToolApproval.bind(this),
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
            this.getCommandHandlerDeps(),
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
            this.getCommandHandlerDeps(),
          ),
        };
      }

      // For external channels, auto-apply persona from channel binding
      const effectiveConversation = applyChannelBindingPersona(this.repo, conversation, platform);
      const memoryEnabledForConversation = this.isMemoryEnabledWithRepo(effectiveConversation);
      let effectiveUserInput = content;
      let projectCreatedFromClarification: string | null = null;

      const consumedClarification = await maybeConsumeProjectClarificationReply({
        conversation: effectiveConversation,
        platform,
        externalChatId,
        content,
        repo: this.repo,
        pendingProjectClarifications: this.state.pendingProjectClarifications,
        sendResponse: this.sendResponse.bind(this),
      });
      if (consumedClarification && 'message' in consumedClarification) {
        return { userMsg, agentMsg: consumedClarification.message };
      }
      if (consumedClarification && 'replayTaskInput' in consumedClarification) {
        effectiveUserInput = consumedClarification.replayTaskInput;
        projectCreatedFromClarification = consumedClarification.projectName;
      }

      // Try to learn from feedback
      if (memoryEnabledForConversation) {
        void this.recallService.maybeLearnFromFeedback(effectiveConversation, content);
      }

      // Handle memory save
      const memorySaveResult = await handleMemorySave(
        {
          conversation: effectiveConversation,
          content,
          platform,
          externalChatId,
          memoryEnabled: memoryEnabledForConversation,
        },
        this.sendResponse.bind(this),
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
            repo: this.repo,
            pendingProjectClarifications: this.state.pendingProjectClarifications,
            sendResponse: this.sendResponse.bind(this),
          });
      if (projectClarificationMessage) {
        return { userMsg, agentMsg: projectClarificationMessage };
      }

      // Shell inference check
      const inferredShellCommand = inferShellCommandFromNaturalLanguage(effectiveUserInput);
      if (inferredShellCommand) {
        return {
          userMsg,
          agentMsg: await handleInferredShellQuestion(
            {
              contextBuilder: this.contextBuilder,
              toolManager: this.toolManager,
              resolveChatModelRouting: this.resolveChatModelRouting.bind(this),
              resolveConversationWorkspaceCwd: (c) => resolveConversationWorkspaceCwd(c, this.repo),
            },
            this.sendResponse.bind(this),
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
        ? await this.recallService.buildStrictEvidenceReply(
            effectiveConversation,
            effectiveUserInput,
          )
        : null;
      if (strictRecall) {
        const agentMsg = await this.sendResponse(
          effectiveConversation,
          strictRecall.content,
          platform,
          externalChatId,
          strictRecall.metadata,
        );
        return { userMsg, agentMsg };
      }

      const activeWorkspaceCwd = resolveConversationWorkspaceCwd(effectiveConversation, this.repo);
      const buildIntent = isProjectRequiredIntent(effectiveUserInput);

      // Load persona to check autonomous mode
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
          toolManager: this.toolManager,
          sendResponse: this.sendResponse.bind(this),
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
      const executionDirective =
        explicitExecutionDirective || autonomousExecutionDirective || undefined;

      const modelOutcome = await dispatchToAI(
        {
          contextBuilder: this.contextBuilder,
          recallService: this.recallService,
          summaryService: this.summaryService,
          toolManager: this.toolManager,
          resolveChatModelRouting: this.resolveChatModelRouting.bind(this),
          runModelToolLoop,
          resolveConversationWorkspaceCwd: (c) => resolveConversationWorkspaceCwd(c, this.repo),
          activeRequests: this.state.activeRequests,
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

      const agentMsg = await this.sendResponse(
        effectiveConversation,
        finalOutput,
        platform,
        externalChatId,
        {
          ...modelOutcome.metadata,
          ...(buildIntent ? { executionMode: 'autonomous' } : {}),
          ...(activeWorkspaceCwd ? { workspaceCwd: activeWorkspaceCwd } : {}),
        },
      );

      return { userMsg, agentMsg };
    } finally {
      if (clientMessageId) this.state.processingMessages.delete(clientMessageId);
    }
  }

  // --- Subagent Execution -------------------------------------

  async runSubagent(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: import('@/server/agents/subagentRegistry').SubagentRunRecord;
  }): Promise<void> {
    return runSubagent(
      {
        subagentManager: this.subagentManager,
        toolManager: this.toolManager,
        resolveChatModelRouting: this.resolveChatModelRouting.bind(this),
      },
      this.sendResponse.bind(this),
      params,
    );
  }

  async invokeSubagentToolCall(params: {
    args: Record<string, unknown>;
    conversationId: string;
    userId: string;
    platform: ChannelType;
    externalChatId: string;
  }): Promise<Record<string, unknown>> {
    return invokeSubagentToolCall(
      {
        subagentManager: this.subagentManager,
        toolManager: this.toolManager,
        resolveChatModelRouting: this.resolveChatModelRouting.bind(this),
        getConversation: this.getConversation.bind(this),
        getCommandHandlerDeps: this.getCommandHandlerDeps.bind(this),
      },
      params,
    );
  }

  // --- Tool Approval ------------------------------------------

  async respondToolApproval(params: {
    conversationId: string;
    userId: string;
    approvalToken: string;
    approved: boolean;
    approveAlways?: boolean;
    toolId?: string;
    toolFunctionName?: string;
  }): Promise<{
    ok: boolean;
    status: 'approved' | 'denied' | 'not_found' | 'approval_required';
    policyUpdated: boolean;
  }> {
    return respondToolApproval(
      {
        sessionManager: this.sessionManager,
        contextBuilder: this.contextBuilder,
        toolManager: this.toolManager,
        summaryService: this.summaryService,
        getConversation: this.getConversation.bind(this),
        setConversationProjectGuardApproved: (conversationId, userId, approved) => {
          this.repo.setConversationProjectGuardApproved?.(conversationId, userId, approved);
        },
        resolveConversationWorkspaceCwd: (c) => resolveConversationWorkspaceCwd(c, this.repo),
        resolveChatModelRouting: this.resolveChatModelRouting.bind(this),
      },
      this.sendResponse.bind(this),
      params,
    );
  }

  // --- Helper: Get Command Handler Dependencies ---------------

  private getCommandHandlerDeps(): CommandHandlerDeps {
    return {
      subagentManager: this.subagentManager,
      toolManager: this.toolManager,
      historyManager: this.historyManager,
      resolveWorkspaceCwd: (c) => resolveConversationWorkspaceCwd(c, this.repo),
      sendResponse: this.sendResponse,
      startSubagentRun: async (params) => {
        const run = await this.subagentManager.startSubagentRun(params);
        return run;
      },
      runSubagent: this.runSubagent.bind(this),
    };
  }

  // --- WebUI Handler ------------------------------------------

  async handleWebUIMessage(
    conversationId: string,
    content: string,
    userId?: string,
    clientMessageId?: string,
    attachments?: StoredMessageAttachment[],
    onStreamDelta?: (delta: string) => void,
    opts?: {
      skipProjectGuard?: boolean;
      executionDirective?: string;
      maxToolCalls?: number;
      requireToolCall?: boolean;
    },
  ): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage; newConversationId?: string }> {
    return handleWebUIMessage(
      { sessionManager: this.sessionManager, repo: this.repo },
      this.handleInbound.bind(this),
      { conversationId, content, userId, clientMessageId, attachments, onStreamDelta, opts },
    );
  }

  // --- Utility Methods ----------------------------------------

  abortGeneration(conversationId: string): boolean {
    const controller = this.state.activeRequests.get(conversationId);
    if (!controller) return false;
    controller.abort();
    this.state.activeRequests.delete(conversationId);
    return true;
  }

  /**
   * Abort all in-flight AI requests. Called during graceful server shutdown to
   * ensure no requests hang open after the process receives SIGTERM.
   */
  abortAllActiveRequests(): void {
    for (const controller of this.state.activeRequests.values()) {
      controller.abort();
    }
    this.state.activeRequests.clear();
  }

  deleteConversation(conversationId: string, userId: string): boolean {
    this.abortGeneration(conversationId);
    this.state.activeRequests.delete(conversationId);
    this.summaryRefreshInFlight.delete(conversationId);
    this.summaryService.clearInFlight(conversationId);
    this.recallService.clearConversationState(conversationId);
    return this.repo.deleteConversation(conversationId, userId);
  }

  deleteMessage(messageId: string, userId: string, conversationId?: string): boolean {
    if (
      typeof this.repo.deleteMessage !== 'function' ||
      typeof this.repo.getMessage !== 'function'
    ) {
      return false;
    }

    const normalizedUserId = this.sessionManager.resolveUserId(userId);
    const message = this.repo.getMessage(messageId, normalizedUserId);
    if (!message) {
      return false;
    }
    if (conversationId && message.conversationId !== conversationId) {
      return false;
    }

    const deleted = this.repo.deleteMessage(messageId, normalizedUserId);
    if (!deleted) {
      return false;
    }

    for (const attachment of extractStoredAttachmentsFromMetadata(message.metadata)) {
      deleteStoredAttachmentFile(attachment);
    }

    this.summaryRefreshInFlight.delete(message.conversationId);
    this.summaryService.clearInFlight(message.conversationId);
    this.recallService.clearConversationState(message.conversationId);
    return true;
  }

  async maybeRefreshConversationSummary(conversation: Conversation): Promise<void> {
    await this.summaryService.maybeRefreshConversationSummary(conversation);
  }

  setModelOverride(conversationId: string, modelOverride: string | null, userId: string): void {
    this.repo.updateModelOverride(conversationId, modelOverride, userId);
  }

  setPersonaId(conversationId: string, personaId: string | null, userId: string): void {
    this.repo.updatePersonaId(conversationId, personaId, userId);
  }

  saveDirectMessage(
    conversationId: string,
    role: 'user' | 'agent' | 'system',
    content: string,
    platform: ChannelType,
    userId?: string,
    metadata?: Record<string, unknown>,
  ): StoredMessage {
    const conversation = userId
      ? this.repo.getConversation(conversationId, this.sessionManager.resolveUserId(userId))
      : this.repo.getConversation(conversationId);

    if (!conversation) {
      throw new Error('Conversation not found for current user.');
    }

    const msg = this.repo.saveMessage({ conversationId, role, content, platform, metadata });
    getServerEventBus().publish('chat.message.persisted', {
      conversation,
      message: msg,
    });
    broadcastToUser(conversation.userId, GatewayEvents.CHAT_MESSAGE, msg);
    return msg;
  }

  // --- Private routing helper --------------------------------

  private resolveChatModelRouting = resolveChatModelRouting;
}

// Export a factory function for backward compatibility
export function createMessageService(repo: MessageRepository): MessageService {
  return new MessageService(repo);
}
