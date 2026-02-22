import type { ChannelType } from '@/shared/domain/types';
import type {
  MessageRepository,
  StoredMessage,
  Conversation,
} from '@/server/channels/messages/repository';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import { routeMessage } from '@/server/channels/messages/messageRouter';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { applyChannelBindingPersona } from '@/server/channels/messages/channelBindingPersona';
import {
  buildMessageAttachmentMetadata,
  type StoredMessageAttachment,
} from '@/server/channels/messages/attachments';
import { getServerEventBus } from '@/server/events/runtime';
import { SessionManager } from '@/server/channels/messages/sessionManager';
import { HistoryManager } from '@/server/channels/messages/historyManager';
import { ContextBuilder } from '@/server/channels/messages/contextBuilder';

import {
  inferShellCommandFromNaturalLanguage,
  SUBAGENT_MAX_ACTIVE_PER_CONVERSATION,
} from './types';
import { SubagentManager } from './subagentManager';
import { ToolManager } from './toolManager';
import { RecallService } from './recallService';
import { SummaryService } from './summaryService';
import {
  handleAutomationCommand,
  handleShellCommand,
  handleSubagentCommand,
  handlePersonaCommand,
  type CommandHandlerDeps,
} from './commandHandlers';

// Import modular functions
import { createSendResponse } from './utils/responseHelper';
import { handleMemorySave } from './handlers/memoryHandler';
import { dispatchToAI, runModelToolLoop } from './dispatchers/aiDispatcher';
import { runSubagent, invokeSubagentToolCall } from './subagent/executor';
import { respondToolApproval } from './approval/handler';

// Re-export types for consumers
export * from './types';
export { SubagentManager, ToolManager, RecallService, SummaryService };
export type { CommandHandlerDeps } from './utils/responseHelper';
export { createSendResponse } from './utils/responseHelper';
export { handleMemorySave } from './handlers/memoryHandler';
export { dispatchToAI, runModelToolLoop } from './dispatchers/aiDispatcher';
export { runSubagent, invokeSubagentToolCall } from './subagent/executor';
export { respondToolApproval } from './approval/handler';

export class MessageService {
  private readonly sessionManager = new SessionManager();
  private readonly historyManager: HistoryManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly subagentManager: SubagentManager;
  private readonly toolManager: ToolManager;
  private readonly recallService: RecallService;
  private readonly summaryService: SummaryService;
  private readonly summaryRefreshInFlight: Set<string>;

  /** In-flight AI requests keyed by conversationId — used for abort */
  private readonly activeRequests = new Map<string, AbortController>();
  /** In-memory deduplication guard for active clientMessageIds */
  private readonly processingMessages = new Set<string>();

  // Bound sendResponse function
  private readonly sendResponse: ReturnType<typeof createSendResponse>;

  constructor(private readonly repo: MessageRepository) {
    this.historyManager = new HistoryManager(repo);
    this.contextBuilder = new ContextBuilder(repo);
    this.subagentManager = new SubagentManager(() => this.getSubagentMaxActivePerConversation());
    this.toolManager = new ToolManager(() => this.requiresInteractiveToolApproval());
    this.recallService = new RecallService();
    this.summaryService = new SummaryService(repo);
    this.summaryRefreshInFlight = (
      this.summaryService as unknown as { summaryRefreshInFlight: Set<string> }
    ).summaryRefreshInFlight;
    this.sendResponse = createSendResponse(this.historyManager);
  }

  // --- Configuration ------------------------------------------

  private getSubagentMaxActivePerConversation(): number {
    const raw = Number.parseInt(String(process.env.SUBAGENT_MAX_ACTIVE || ''), 10);
    if (!Number.isFinite(raw) || raw <= 0) {
      return SUBAGENT_MAX_ACTIVE_PER_CONVERSATION;
    }
    return Math.max(1, Math.min(20, raw));
  }

  private requiresInteractiveToolApproval(): boolean {
    return String(process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED || 'false').toLowerCase() === 'true';
  }

  private resolveChatModelRouting(conversation: Conversation): {
    preferredModelId?: string;
    modelHubProfileId: string;
  } {
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
  ): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage; newConversationId?: string }> {
    const conversation = this.sessionManager.getOrCreateConversation(
      this.repo,
      platform,
      externalChatId,
      undefined,
      userId,
    );

    // In-memory deduplication: if this clientMessageId is already being processed, reject
    if (clientMessageId && this.processingMessages.has(clientMessageId)) {
      throw new Error('Duplicate request — already processing');
    }
    if (clientMessageId) this.processingMessages.add(clientMessageId);

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

      // Try to learn from feedback
      void this.recallService.maybeLearnFromFeedback(effectiveConversation, content);

      // Handle memory save
      const memorySaveResult = await handleMemorySave(
        {
          conversation: effectiveConversation,
          content,
          platform,
          externalChatId,
        },
        this.sendResponse.bind(this),
      );
      if (memorySaveResult.message) {
        return { userMsg, agentMsg: memorySaveResult.message };
      }

      const inferredShellCommand = inferShellCommandFromNaturalLanguage(content);
      if (inferredShellCommand) {
        return {
          userMsg,
          agentMsg: await this.handleInferredShellQuestion({
            conversation: effectiveConversation,
            platform,
            externalChatId,
            userInput: content,
            command: inferredShellCommand,
            onStreamDelta,
          }),
        };
      }

      const modelOutcome = await dispatchToAI(
        {
          contextBuilder: this.contextBuilder,
          recallService: this.recallService,
          summaryService: this.summaryService,
          toolManager: this.toolManager,
          resolveChatModelRouting: this.resolveChatModelRouting.bind(this),
          runModelToolLoop,
          activeRequests: this.activeRequests,
        },
        {
          conversation: effectiveConversation,
          platform,
          externalChatId,
          userInput: content,
          onStreamDelta,
          turnSeq: userMsg.seq ?? undefined,
        },
      );

      const agentMsg = await this.sendResponse(
        effectiveConversation,
        modelOutcome.content,
        platform,
        externalChatId,
        modelOutcome.metadata,
      );

      return { userMsg, agentMsg };
    } finally {
      if (clientMessageId) this.processingMessages.delete(clientMessageId);
    }
  }

  private async handleInferredShellQuestion(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    userInput: string;
    command: string;
    onStreamDelta?: (delta: string) => void;
  }): Promise<StoredMessage> {
    const { conversation, platform, externalChatId, userInput, command, onStreamDelta } = params;
    await this.toolManager.ensureShellSkillInstalled();
    const toolContext = await this.toolManager.resolveToolContext();
    const installedFunctions = new Set(toolContext.installedFunctionNames);
    installedFunctions.add('shell_execute');

    const toolExecution = await this.toolManager.executeToolFunctionCall({
      conversation,
      platform,
      externalChatId,
      functionName: 'shell_execute',
      args: { command },
      installedFunctions,
      toolId: toolContext.functionToSkillId.get('shell_execute') || 'shell-access',
    });

    if (toolExecution.kind === 'approval_required') {
      return this.sendResponse(
        conversation,
        toolExecution.prompt,
        platform,
        externalChatId,
        this.toolManager.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
          ok: false,
          runtime: 'chat-shell-inference',
          inferredCommand: command,
          inferredFrom: userInput,
        }),
      );
    }

    const toolResultContent =
      toolExecution.kind === 'ok'
        ? `Tool "shell_execute" result:\n${toolExecution.output}`
        : `Tool "shell_execute" failed:\n${toolExecution.output}`;

    const messages = this.contextBuilder.buildGatewayMessages(
      conversation.id,
      conversation.userId,
      50,
      conversation.personaId,
    );
    messages.push({ role: 'assistant', content: '[Tool call: shell_execute]' });
    messages.push({ role: 'user', content: toolResultContent });

    const { preferredModelId, modelHubProfileId } = this.resolveChatModelRouting(conversation);
    const modelOutcome = await runModelToolLoop(this.toolManager, {
      conversation,
      messages,
      modelHubProfileId,
      preferredModelId,
      toolContext,
      onStreamDelta,
    });

    return this.sendResponse(conversation, modelOutcome.content, platform, externalChatId, {
      ...modelOutcome.metadata,
      runtime: 'chat-shell-inference',
      inferredCommand: command,
    });
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
        runModelToolLoop,
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
        runModelToolLoop,
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
        resolveChatModelRouting: this.resolveChatModelRouting.bind(this),
        runModelToolLoop,
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
      sendResponse: this.sendResponse.bind(this),
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
  ): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage; newConversationId?: string }> {
    const conversation = this.sessionManager.resolveConversationForWebChat(
      this.repo,
      conversationId,
      userId,
    );

    return this.handleInbound(
      conversation.channelType,
      conversation.externalChatId || 'default',
      content,
      undefined,
      undefined,
      conversation.userId,
      clientMessageId,
      attachments,
      onStreamDelta,
    );
  }

  // --- Utility Methods ----------------------------------------

  abortGeneration(conversationId: string): boolean {
    const controller = this.activeRequests.get(conversationId);
    if (!controller) return false;
    controller.abort();
    this.activeRequests.delete(conversationId);
    return true;
  }

  deleteConversation(conversationId: string, userId: string): boolean {
    this.abortGeneration(conversationId);
    this.activeRequests.delete(conversationId);
    this.summaryRefreshInFlight.delete(conversationId);
    this.summaryService.clearInFlight(conversationId);
    this.recallService.clearConversationState(conversationId);
    return this.repo.deleteConversation(conversationId, userId);
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
}

// Export a factory function for backward compatibility
export function createMessageService(repo: MessageRepository): MessageService {
  return new MessageService(repo);
}
