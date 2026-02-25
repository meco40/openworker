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
import { createPersonaProjectWorkspace } from '@/server/personas/personaProjectWorkspace';
import { applyChannelBindingPersona } from '@/server/channels/messages/channelBindingPersona';
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

import {
  AUTONOMOUS_BUILD_MAX_TOOL_CALLS,
  inferShellCommandFromNaturalLanguage,
  isExplicitRecallCommand,
  SUBAGENT_MAX_ACTIVE_PER_CONVERSATION,
  TOOL_CALLS_HARD_CAP,
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
  handleApprovalCommand,
  handleProjectCommand,
  type CommandHandlerDeps,
} from './commandHandlers';
import {
  buildProjectClarificationPrompt,
  isProjectRequiredIntent,
  resolveProjectNameFromClarificationReply,
} from './projectGuard';

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
  /** Single-shot clarification state for build-intent messages without active project */
  private readonly pendingProjectClarifications = new Map<
    string,
    {
      requestedAt: string;
      originalTask: string;
      platform: ChannelType;
      externalChatId: string;
    }
  >();

  // Bound sendResponse function
  private readonly sendResponse: ReturnType<typeof createSendResponse>;

  constructor(private readonly repo: MessageRepository) {
    this.historyManager = new HistoryManager(repo);
    this.contextBuilder = new ContextBuilder(repo);
    this.subagentManager = new SubagentManager(
      () => this.getSubagentMaxActivePerConversation(),
      this.resolveConversationWorkspace.bind(this),
    );
    this.toolManager = new ToolManager(
      () => this.requiresInteractiveToolApproval(),
      this.invokeSubagentToolCall.bind(this),
    );
    this.recallService = new RecallService((query, options) => {
      if (typeof this.repo.searchMessages !== 'function') return [];
      return this.repo.searchMessages(query, options);
    });
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

  private resolveAutonomousBuildMaxToolCalls(): number {
    const raw = Number.parseInt(String(process.env.OPENCLAW_AUTONOMOUS_MAX_TOOL_CALLS || ''), 10);
    if (!Number.isFinite(raw) || raw <= 0) {
      return AUTONOMOUS_BUILD_MAX_TOOL_CALLS;
    }
    return Math.max(AUTONOMOUS_BUILD_MAX_TOOL_CALLS, Math.min(TOOL_CALLS_HARD_CAP, raw));
  }

  private resolveConversationWorkspace(conversation: Conversation): {
    projectId?: string;
    workspacePath?: string;
    workspaceRelativePath?: string;
  } | null {
    if (
      typeof this.repo.getConversationProjectState !== 'function' ||
      typeof this.repo.getProjectByIdOrSlug !== 'function'
    ) {
      return null;
    }

    if (!conversation.personaId) {
      return null;
    }

    const projectState = this.repo.getConversationProjectState(
      conversation.id,
      conversation.userId,
    );
    if (!projectState.activeProjectId) {
      return null;
    }

    const project = this.repo.getProjectByIdOrSlug(
      conversation.personaId,
      conversation.userId,
      projectState.activeProjectId,
    );
    if (!project) {
      return null;
    }

    return {
      projectId: project.id,
      workspacePath: project.workspacePath,
      workspaceRelativePath: project.workspaceRelativePath || undefined,
    };
  }

  private resolveConversationWorkspaceCwd(conversation: Conversation): string | undefined {
    return this.resolveConversationWorkspace(conversation)?.workspacePath;
  }

  private getProjectClarificationKey(conversation: Conversation): string {
    return `${conversation.id}::${conversation.userId}`;
  }

  private createAndActivateProjectForConversation(
    conversation: Conversation,
    requestedName: string,
  ): {
    id: string;
    name: string;
    slug: string;
    workspacePath: string;
  } | null {
    if (!conversation.personaId) {
      return null;
    }
    if (
      typeof this.repo.createProject !== 'function' ||
      typeof this.repo.setActiveProjectForConversation !== 'function'
    ) {
      return null;
    }

    const persona = getPersonaRepository().getPersona(conversation.personaId);
    if (!persona?.slug) {
      return null;
    }

    const projectName = String(requestedName || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    if (!projectName) {
      return null;
    }

    const workspace = createPersonaProjectWorkspace({
      personaSlug: persona.slug,
      task: projectName,
      requestedName: projectName,
    });

    const project = this.repo.createProject({
      userId: conversation.userId,
      personaId: conversation.personaId,
      name: projectName,
      workspacePath: workspace.absolutePath,
      workspaceRelativePath: workspace.relativePath,
    });
    this.repo.setActiveProjectForConversation(conversation.id, conversation.userId, project.id);
    return project;
  }

  private async maybeRequestProjectClarification(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    content: string;
  }): Promise<StoredMessage | null> {
    const { conversation, platform, externalChatId, content } = params;
    if (!conversation.personaId || !isProjectRequiredIntent(content)) {
      return null;
    }

    if (
      typeof this.repo.getConversationProjectState !== 'function' ||
      typeof this.repo.listProjectsByPersona !== 'function'
    ) {
      return null;
    }

    const projectState = this.repo.getConversationProjectState(
      conversation.id,
      conversation.userId,
    );
    if (projectState.activeProjectId) {
      return null;
    }

    const clarificationKey = this.getProjectClarificationKey(conversation);
    if (this.pendingProjectClarifications.has(clarificationKey)) {
      return null;
    }

    this.pendingProjectClarifications.set(clarificationKey, {
      requestedAt: new Date().toISOString(),
      originalTask: String(content || '').trim(),
      platform,
      externalChatId,
    });

    const projects = this.repo
      .listProjectsByPersona(conversation.personaId, conversation.userId)
      .slice(0, 5)
      .map((project) => ({ name: project.name, slug: project.slug }));
    const prompt = buildProjectClarificationPrompt({ projects });
    return this.sendResponse(conversation, prompt, platform, externalChatId, {
      ok: false,
      runtime: 'project-workspace-clarification',
      status: 'project_clarification_required',
    });
  }

  private async maybeConsumeProjectClarificationReply(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    content: string;
  }): Promise<
    | {
        replayTaskInput: string;
        projectName: string;
      }
    | {
        message: StoredMessage;
      }
    | null
  > {
    const { conversation, platform, externalChatId, content } = params;
    const clarificationKey = this.getProjectClarificationKey(conversation);
    const pending = this.pendingProjectClarifications.get(clarificationKey);
    if (!pending) {
      return null;
    }

    const projectName = resolveProjectNameFromClarificationReply({
      reply: content,
      originalTask: pending.originalTask,
    });
    if (!projectName) {
      return {
        message: await this.sendResponse(
          conversation,
          'Bitte nenne den Projektnamen (z. B. `Notes`) oder antworte mit `auto`.',
          platform,
          externalChatId,
          {
            ok: false,
            status: 'project_clarification_required',
            runtime: 'project-workspace-clarification',
          },
        ),
      };
    }

    const project = this.createAndActivateProjectForConversation(conversation, projectName);
    if (!project) {
      this.pendingProjectClarifications.delete(clarificationKey);
      return {
        message: await this.sendResponse(
          conversation,
          'Projekt konnte nicht erstellt werden. Bitte pruefe Persona/Projekt-Setup und versuche es erneut.',
          platform,
          externalChatId,
          {
            ok: false,
            status: 'project_clarification_failed',
            runtime: 'project-workspace-clarification',
          },
        ),
      };
    }

    this.pendingProjectClarifications.delete(clarificationKey);
    return {
      replayTaskInput: pending.originalTask,
      projectName: project.name,
    };
  }

  private shouldAllowCodeInResponse(userInput: string, metadata: Record<string, unknown>): boolean {
    const asksForCode =
      /\b(code|source|snippet|beispielcode|zeige code|show code|codeblock|implementation details?)\b/i.test(
        userInput,
      );
    if (asksForCode) return true;

    if (metadata.ok === false) return true;
    const status = String(metadata.status || '');
    if (status.includes('error') || status.includes('failed')) return true;
    return false;
  }

  private stripCodeBlocksIfNeeded(content: string, shouldAllowCode: boolean): string {
    const text = String(content || '');
    if (shouldAllowCode) return text;
    if (!text.includes('```')) return text;
    const stripped = text.replace(
      /```[\s\S]*?```/g,
      '[Code weggelassen. Umsetzung wurde im Projekt-Workspace ausgefuehrt.]',
    );
    return stripped.replace(/\n{3,}/g, '\n\n').trim();
  }

  private buildAutonomousExecutionDirective(params: {
    workspaceCwd?: string;
    buildIntent: boolean;
    isAutonomousPersona?: boolean;
  }): string | null {
    if (!params.buildIntent && !params.isAutonomousPersona) return null;
    const sharedAntiLoopDirectives = [
      '- Tool-Calls silent ausfuehren — NICHT beschreiben was du tun wirst, einfach tun.',
      '- Polling-Loops strikt verboten: ausreichend Timeout nutzen statt rapid-retry. Min. 5s Pause zwischen Wiederholungen.',
      '- Bei 2+ identischen Tool-Calls mit gleichem Ergebnis: Strategie sofort wechseln, nicht weiter wiederholen.',
      '- Bei Fehlern: Fehlerausgabe vollstaendig lesen und Root Cause verstehen BEVOR du retry machst.',
    ];
    const lines = params.isAutonomousPersona
      ? [
          'AUTONOMOUS AGENT MODE:',
          '- Du bist ein autonomer Agent. Handele eigenstaendig end-to-end ohne Rueckfragen.',
          '- Nutze alle verfuegbaren Tools aktiv: Shell, Filesystem, Browser, Python, HTTP, Web-Search, PDF.',
          '- Erkenne und korrigiere Fehler proaktiv. Versuche alternative Strategien wenn ein Ansatz scheitert.',
          '- Gib Zwischenstatus nach jedem wesentlichen Schritt in einem Satz aus.',
          '- Antworte ohne ueberfluessige Codeblöcke; liefere Fakten, Ergebnisse, geaenderte Dateien.',
          params.workspaceCwd ? `- Aktives Workspace-Verzeichnis: ${params.workspaceCwd}` : null,
          ...sharedAntiLoopDirectives,
        ]
      : [
          'AUTONOMOUS EXECUTION MODE (build task):',
          '- Arbeite end-to-end im aktiven Projekt-Workspace statt nur Plantext zu geben.',
          '- Nutze Tools aktiv fuer Inspektion, Umsetzung und Verifikation.',
          '- Wenn die Aufgabe coding/build ist, fuehre reale Datei- und CLI-Schritte aus.',
          '- Buendle Shell-Schritte in moeglichst wenige, robuste Befehle statt viele Mini-Calls.',
          '- Antworte ohne Codebloeke; gib stattdessen Status, geaenderte Dateien, Verifikation und Startkommando.',
          '- Nur bei Fehlern kurze, relevante Fehlersnippets zeigen.',
          params.workspaceCwd ? `- Aktives Workspace-Verzeichnis: ${params.workspaceCwd}` : null,
          ...sharedAntiLoopDirectives,
        ];
    return lines.filter(Boolean).join('\n');
  }

  private async runBuildWorkspacePreflight(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    workspaceCwd: string;
  }): Promise<
    | {
        kind: 'summary';
        text: string;
      }
    | {
        kind: 'approval_required';
        message: StoredMessage;
      }
  > {
    const toolContext = await this.toolManager.resolveToolContext();

    const command =
      process.platform === 'win32'
        ? 'Get-Location; Get-ChildItem -Force | Select-Object -First 30 Name,Mode,Length'
        : 'pwd; ls -la | head -n 40';
    const toolExecution = await this.toolManager.executeToolFunctionCall({
      conversation: params.conversation,
      platform: params.platform,
      externalChatId: params.externalChatId,
      functionName: 'shell_execute',
      args: { command },
      workspaceCwd: params.workspaceCwd,
      installedFunctions: toolContext.installedFunctionNames,
      toolId: toolContext.functionToSkillId.get('shell_execute') || 'shell-access',
    });

    if (toolExecution.kind === 'approval_required') {
      return {
        kind: 'approval_required',
        message: await this.sendResponse(
          params.conversation,
          toolExecution.prompt,
          params.platform,
          params.externalChatId,
          this.toolManager.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
            ok: false,
            runtime: 'build-workspace-preflight',
          }),
        ),
      };
    }

    const summaryPrefix =
      toolExecution.kind === 'ok' ? '[Workspace preflight result]' : '[Workspace preflight failed]';
    return {
      kind: 'summary',
      text: `${summaryPrefix}\n${toolExecution.output}`,
    };
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

      if (route.target === 'project-command') {
        this.pendingProjectClarifications.delete(
          this.getProjectClarificationKey(
            applyChannelBindingPersona(this.repo, conversation, platform),
          ),
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
      let effectiveUserInput = content;
      let projectCreatedFromClarification: string | null = null;

      const consumedClarification = await this.maybeConsumeProjectClarificationReply({
        conversation: effectiveConversation,
        platform,
        externalChatId,
        content,
      });
      if (consumedClarification && 'message' in consumedClarification) {
        return { userMsg, agentMsg: consumedClarification.message };
      }
      if (consumedClarification && 'replayTaskInput' in consumedClarification) {
        effectiveUserInput = consumedClarification.replayTaskInput;
        projectCreatedFromClarification = consumedClarification.projectName;
      }

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

      const projectClarificationMessage = opts?.skipProjectGuard
        ? null
        : await this.maybeRequestProjectClarification({
            conversation: effectiveConversation,
            platform,
            externalChatId,
            content: effectiveUserInput,
          });
      if (projectClarificationMessage) {
        return { userMsg, agentMsg: projectClarificationMessage };
      }

      const inferredShellCommand = inferShellCommandFromNaturalLanguage(effectiveUserInput);
      if (inferredShellCommand) {
        return {
          userMsg,
          agentMsg: await this.handleInferredShellQuestion({
            conversation: effectiveConversation,
            platform,
            externalChatId,
            userInput: effectiveUserInput,
            command: inferredShellCommand,
            onStreamDelta,
          }),
        };
      }

      const strictRecall = await this.recallService.buildStrictEvidenceReply(
        effectiveConversation,
        effectiveUserInput,
      );
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

      const activeWorkspaceCwd = this.resolveConversationWorkspaceCwd(effectiveConversation);
      const buildIntent = isProjectRequiredIntent(effectiveUserInput);

      // Load persona to check autonomous mode
      const activePersona = effectiveConversation.personaId
        ? getPersonaRepository().getPersona(effectiveConversation.personaId)
        : null;
      const isAutonomousPersona = Boolean(activePersona?.isAutonomous);

      let dispatchUserInput = effectiveUserInput;
      const explicitRecallCommand = isExplicitRecallCommand(effectiveUserInput);
      if (buildIntent && activeWorkspaceCwd) {
        const preflight = await this.runBuildWorkspacePreflight({
          conversation: effectiveConversation,
          platform,
          externalChatId,
          workspaceCwd: activeWorkspaceCwd,
        });
        if (preflight.kind === 'approval_required') {
          return { userMsg, agentMsg: preflight.message };
        }
        dispatchUserInput = `${effectiveUserInput}\n\n${preflight.text}`;
      }

      const autonomousExecutionDirective = this.buildAutonomousExecutionDirective({
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
          resolveConversationWorkspaceCwd: this.resolveConversationWorkspaceCwd.bind(this),
          activeRequests: this.activeRequests,
        },
        {
          conversation: effectiveConversation,
          platform,
          externalChatId,
          userInput: dispatchUserInput,
          onStreamDelta,
          turnSeq: userMsg.seq ?? undefined,
          executionDirective,
          maxToolCalls:
            opts?.maxToolCalls ??
            (isAutonomousPersona && activePersona
              ? activePersona.maxToolCalls
              : buildIntent
                ? this.resolveAutonomousBuildMaxToolCalls()
                : undefined),
          requireToolCall: opts?.requireToolCall,
          skipSummaryRefresh: explicitRecallCommand,
        },
      );
      const normalizedOutput = this.stripCodeBlocksIfNeeded(
        modelOutcome.content,
        this.shouldAllowCodeInResponse(effectiveUserInput, modelOutcome.metadata),
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
    const workspaceCwd = this.resolveConversationWorkspaceCwd(conversation);
    const toolContext = await this.toolManager.resolveToolContext();

    const toolExecution = await this.toolManager.executeToolFunctionCall({
      conversation,
      platform,
      externalChatId,
      functionName: 'shell_execute',
      args: { command },
      workspaceCwd,
      installedFunctions: toolContext.installedFunctionNames,
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
      workspaceCwd,
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
        setConversationProjectGuardApproved: (conversationId, userId, approved) => {
          this.repo.setConversationProjectGuardApproved?.(conversationId, userId, approved);
        },
        resolveConversationWorkspaceCwd: this.resolveConversationWorkspaceCwd.bind(this),
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
      resolveWorkspaceCwd: this.resolveConversationWorkspaceCwd.bind(this),
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
    opts?: {
      skipProjectGuard?: boolean;
      executionDirective?: string;
      maxToolCalls?: number;
      requireToolCall?: boolean;
    },
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
      opts,
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

  /**
   * Abort all in-flight AI requests. Called during graceful server shutdown to
   * ensure no requests hang open after the process receives SIGTERM.
   */
  abortAllActiveRequests(): void {
    for (const controller of this.activeRequests.values()) {
      controller.abort();
    }
    this.activeRequests.clear();
  }

  deleteConversation(conversationId: string, userId: string): boolean {
    this.abortGeneration(conversationId);
    this.activeRequests.delete(conversationId);
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
}

// Export a factory function for backward compatibility
export function createMessageService(repo: MessageRepository): MessageService {
  return new MessageService(repo);
}
