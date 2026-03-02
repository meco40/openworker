/** MessageService facade over modular operations. */

import { ChannelType } from '@/shared/domain/types';
import type {
  Conversation,
  MessageRepository,
  StoredMessage,
} from '@/server/channels/messages/repository';
import { SessionManager } from '@/server/channels/messages/sessionManager';
import { HistoryManager } from '@/server/channels/messages/historyManager';
import { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import type { StoredMessageAttachment } from '@/server/channels/messages/attachments';

import { SubagentManager } from './subagentManager';
import { ToolManager } from './toolManager';
import { RecallService } from './recall';
import { SummaryService } from './summaryService';
import { createSendResponse } from './utils/responseHelper';
import {
  getSubagentMaxActivePerConversation,
  requiresInteractiveToolApproval,
} from './core/configuration';
import type { ServiceState } from './core/types';
import {
  resolveConversationWorkspace,
  resolveConversationWorkspaceCwd,
} from './core/projectManagement';
import { resolveChatModelRouting, isMemoryEnabledForConversation } from './routing/modelRouting';
import {
  listConversations,
  getOrCreateConversation,
  getDefaultWebChatConversation,
  getConversation,
  isAgentRoomConversation,
  listMessages,
  getMessage,
} from './conversation/operations';
import {
  abortGeneration,
  abortAllActiveRequests,
  deleteConversation,
  deleteMessage,
  saveDirectMessage,
} from './maintenance/operations';
import {
  buildCommandHandlerDeps,
  runSubagentOperation,
  invokeSubagentToolCallOperation,
  respondToolApprovalOperation,
} from './orchestration/subagentToolApproval';
import { handleInboundMessage } from './inbound/handleInbound';
import { handleWebUIMessage } from './handlers/webUIHandler';
import type { CommandHandlerDeps } from './commands';

export class MessageService {
  private readonly sessionManager = new SessionManager();
  private readonly historyManager: HistoryManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly subagentManager: SubagentManager;
  private readonly toolManager: ToolManager;
  private readonly recallService: RecallService;
  private readonly summaryService: SummaryService;
  private readonly summaryRefreshInFlight: Set<string>;
  private readonly state: ServiceState;
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
      (query, options) =>
        typeof this.repo.searchMessages === 'function'
          ? this.repo.searchMessages(query, options)
          : [],
      (conversation) => this.isMemoryEnabledWithRepo(conversation),
    );
    this.summaryService = new SummaryService(repo);
    this.summaryRefreshInFlight = (
      this.summaryService as unknown as { summaryRefreshInFlight: Set<string> }
    ).summaryRefreshInFlight;
    this.state = {
      activeRequests: new Map<string, AbortController>(),
      processingMessages: new Set<string>(),
      pendingProjectClarifications: new Map(),
    };
    this.sendResponse = createSendResponse(this.historyManager);
  }

  private resolveWorkspaceWithRepo(conversation: Conversation) {
    return resolveConversationWorkspace(conversation, this.repo);
  }

  private isMemoryEnabledWithRepo(conversation: Conversation): boolean {
    return isMemoryEnabledForConversation(conversation, this.repo);
  }

  listConversations(userId?: string, limit?: number): Conversation[] {
    return listConversations(
      { repo: this.repo, sessionManager: this.sessionManager },
      userId,
      limit,
    );
  }

  getOrCreateConversation(
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
    userId?: string,
  ): Conversation {
    return getOrCreateConversation(
      { repo: this.repo, sessionManager: this.sessionManager },
      channelType,
      externalChatId,
      title,
      userId,
    );
  }

  getDefaultWebChatConversation(userId?: string): Conversation {
    return getDefaultWebChatConversation(
      { repo: this.repo, sessionManager: this.sessionManager },
      userId,
    );
  }

  getConversation(conversationId: string, userId?: string): Conversation | null {
    return getConversation(
      { repo: this.repo, sessionManager: this.sessionManager },
      conversationId,
      userId,
    );
  }

  isAgentRoomConversation(conversationId: string, userId?: string): boolean {
    return isAgentRoomConversation(
      { repo: this.repo, sessionManager: this.sessionManager },
      conversationId,
      userId,
    );
  }

  listMessages(
    conversationId: string,
    userId?: string,
    limit?: number,
    before?: string,
  ): StoredMessage[] {
    return listMessages(
      { repo: this.repo, sessionManager: this.sessionManager },
      conversationId,
      userId,
      limit,
      before,
    );
  }

  getMessage(messageId: string, userId?: string): StoredMessage | null {
    return getMessage({ repo: this.repo, sessionManager: this.sessionManager }, messageId, userId);
  }

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
    return handleInboundMessage(
      {
        repo: this.repo,
        sessionManager: this.sessionManager,
        historyManager: this.historyManager,
        contextBuilder: this.contextBuilder,
        toolManager: this.toolManager,
        recallService: this.recallService,
        summaryService: this.summaryService,
        state: this.state,
        sendResponse: this.sendResponse,
        getCommandHandlerDeps: this.getCommandHandlerDeps.bind(this),
        respondToolApproval: this.respondToolApproval.bind(this),
        resolveChatModelRouting: this.resolveChatModelRouting,
      },
      {
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
      },
    );
  }

  async runSubagent(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: import('@/server/agents/subagentRegistry').SubagentRunRecord;
  }): Promise<void> {
    return runSubagentOperation(
      {
        subagentManager: this.subagentManager,
        toolManager: this.toolManager,
        resolveChatModelRouting: this.resolveChatModelRouting,
        sendResponse: this.sendResponse,
      },
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
    return invokeSubagentToolCallOperation(
      {
        subagentManager: this.subagentManager,
        toolManager: this.toolManager,
        resolveChatModelRouting: this.resolveChatModelRouting,
        getConversation: this.getConversation.bind(this),
      },
      this.getCommandHandlerDeps.bind(this),
      params,
    );
  }

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
    return respondToolApprovalOperation(
      {
        sessionManager: this.sessionManager,
        contextBuilder: this.contextBuilder,
        toolManager: this.toolManager,
        summaryService: this.summaryService,
        getConversation: this.getConversation.bind(this),
        setConversationProjectGuardApproved: (conversationId, userId, approved) =>
          this.repo.setConversationProjectGuardApproved?.(conversationId, userId, approved),
        resolveConversationWorkspaceCwd: (conversation) =>
          resolveConversationWorkspaceCwd(conversation, this.repo),
        resolveChatModelRouting: this.resolveChatModelRouting,
        sendResponse: this.sendResponse,
      },
      params,
    );
  }

  private getCommandHandlerDeps(): CommandHandlerDeps {
    return buildCommandHandlerDeps(
      {
        subagentManager: this.subagentManager,
        toolManager: this.toolManager,
        historyManager: this.historyManager,
        resolveConversationWorkspaceCwd: (conversation) =>
          resolveConversationWorkspaceCwd(conversation, this.repo),
        sendResponse: this.sendResponse,
      },
      this.runSubagent.bind(this),
    );
  }

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

  abortGeneration(conversationId: string): boolean {
    return abortGeneration(this.state.activeRequests, conversationId);
  }

  abortAllActiveRequests(): void {
    abortAllActiveRequests(this.state.activeRequests);
  }

  deleteConversation(conversationId: string, userId: string): boolean {
    return deleteConversation(
      {
        repo: this.repo,
        sessionManager: this.sessionManager,
        summaryRefreshInFlight: this.summaryRefreshInFlight,
        summaryService: this.summaryService,
        recallService: this.recallService,
        activeRequests: this.state.activeRequests,
      },
      conversationId,
      userId,
    );
  }

  deleteMessage(messageId: string, userId: string, conversationId?: string): boolean {
    return deleteMessage(
      {
        repo: this.repo,
        sessionManager: this.sessionManager,
        summaryRefreshInFlight: this.summaryRefreshInFlight,
        summaryService: this.summaryService,
        recallService: this.recallService,
        activeRequests: this.state.activeRequests,
      },
      messageId,
      userId,
      conversationId,
    );
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
    return saveDirectMessage(
      { repo: this.repo, sessionManager: this.sessionManager },
      { conversationId, role, content, platform, userId, metadata },
    );
  }

  private resolveChatModelRouting = resolveChatModelRouting;
}
