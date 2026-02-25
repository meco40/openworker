import crypto from 'node:crypto';
import { ChannelType } from '@/shared/domain/types';
import { AgentV2Error } from '@/server/agent-v2/errors';
import { AgentV2Repository } from '@/server/agent-v2/repository';
import type {
  AgentCommand,
  AgentCommandResult,
  AgentSessionHandle,
  AgentSessionSnapshot,
  AgentV2EventEnvelope,
  LifecycleHookContext,
  LifecycleHookStage,
} from '@/server/agent-v2/types';
import { AgentV2ExtensionHost } from '@/server/agent-v2/extensions/host';
import { getMessageService } from '@/server/channels/messages/runtime';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { getPersonaRepository } from '@/server/personas/personaRepository';

const QUEUE_PRIORITY = {
  abort: 500,
  approval: 400,
  steer: 300,
  follow_up: 200,
  input: 100,
} as const;

export class AgentV2SessionManager {
  private readonly repository: AgentV2Repository;
  private readonly extensionHost: AgentV2ExtensionHost;
  private readonly processingSessions = new Set<string>();
  private readonly activeHandles = new Map<string, AgentSessionHandle>();

  constructor(repository?: AgentV2Repository, extensionHost?: AgentV2ExtensionHost) {
    this.repository = repository ?? new AgentV2Repository();
    this.extensionHost = extensionHost ?? new AgentV2ExtensionHost(this.repository);
    this.extensionHost.refresh();
    const recovery = this.repository.recoverRunningCommandsOnStartup();
    if (recovery.recoveredCommands > 0) {
      console.warn(
        `[agent-v2] Startup recovery marked ${recovery.recoveredCommands} command(s) as failed_recoverable.`,
      );
    }
    this.repository.pruneExpiredEvents();
  }

  async startSession(input: {
    userId: string;
    title?: string;
    personaId?: string;
    conversationId?: string;
  }): Promise<{ session: AgentSessionSnapshot; events: AgentV2EventEnvelope[] }> {
    const now = new Date().toISOString();
    const messageService = getMessageService();
    const requestedPersonaId = String(input.personaId || '').trim() || null;

    let conversation = input.conversationId
      ? messageService.getConversation(input.conversationId, input.userId)
      : null;
    if (input.conversationId && !conversation) {
      throw new AgentV2Error('Conversation not found.', 'NOT_FOUND');
    }
    if (!conversation) {
      const externalChatId = `agent-v2-${crypto.randomUUID()}`;
      conversation = messageService.getOrCreateConversation(
        ChannelType.WEBCHAT,
        externalChatId,
        input.title || 'Agent Session',
        input.userId,
      );
    }

    if (requestedPersonaId) {
      const persona = getPersonaRepository().getPersona(requestedPersonaId);
      if (!persona) {
        throw new AgentV2Error('Persona not found.', 'INVALID_REQUEST');
      }
      messageService.setPersonaId(conversation.id, requestedPersonaId, input.userId);
      conversation = messageService.getConversation(conversation.id, input.userId) || conversation;
    }

    await this.runHooks('session.before_start', {
      session: buildPendingSessionSnapshot(input.userId, conversation.id, now),
      command: null,
      stage: 'session.before_start',
      payload: {
        title: input.title || null,
        personaId: requestedPersonaId,
        conversationId: conversation.id,
      },
    });

    const created = this.repository.createSession({
      userId: input.userId,
      conversationId: conversation.id,
      status: 'idle',
    });

    this.activeHandles.set(created.session.id, {
      sessionId: created.session.id,
      userId: input.userId,
      snapshot: created.session,
    });

    await this.runHooks('session.after_start', {
      session: created.session,
      command: null,
      stage: 'session.after_start',
      payload: {
        title: input.title || null,
        personaId: requestedPersonaId,
        conversationId: conversation.id,
      },
    });

    this.emitPersistedEvents(input.userId, created.events);
    return created;
  }

  getSession(sessionId: string, userId: string): AgentSessionSnapshot {
    const session = this.repository.getSession(sessionId, userId);
    if (!session) throw new AgentV2Error('Session not found.', 'NOT_FOUND');
    this.activeHandles.set(sessionId, { sessionId, userId, snapshot: session });
    return session;
  }

  listSessions(userId: string, limit?: number): AgentSessionSnapshot[] {
    return this.repository.listSessions(userId, limit || 50);
  }

  async enqueueInput(input: {
    sessionId: string;
    userId: string;
    content: string;
    idempotencyKey?: string;
  }): Promise<{ command: AgentCommand; session: AgentSessionSnapshot }> {
    return await this.enqueueCommand({
      sessionId: input.sessionId,
      userId: input.userId,
      commandType: 'input',
      payload: { content: input.content },
      idempotencyKey: input.idempotencyKey,
      priority: QUEUE_PRIORITY.input,
    });
  }

  async enqueueSteer(input: {
    sessionId: string;
    userId: string;
    instruction: string;
    idempotencyKey?: string;
  }): Promise<{ command: AgentCommand; session: AgentSessionSnapshot }> {
    return await this.enqueueCommand({
      sessionId: input.sessionId,
      userId: input.userId,
      commandType: 'steer',
      payload: { content: input.instruction },
      idempotencyKey: input.idempotencyKey,
      priority: QUEUE_PRIORITY.steer,
    });
  }

  async enqueueFollowUp(input: {
    sessionId: string;
    userId: string;
    content: string;
    idempotencyKey?: string;
  }): Promise<{ command: AgentCommand; session: AgentSessionSnapshot }> {
    return await this.enqueueCommand({
      sessionId: input.sessionId,
      userId: input.userId,
      commandType: 'follow_up',
      payload: { content: input.content },
      idempotencyKey: input.idempotencyKey,
      priority: QUEUE_PRIORITY.follow_up,
    });
  }

  async enqueueApprovalResponse(input: {
    sessionId: string;
    userId: string;
    approvalToken: string;
    approved: boolean;
    approveAlways?: boolean;
    toolId?: string;
    toolFunctionName?: string;
    idempotencyKey?: string;
  }): Promise<{ command: AgentCommand; session: AgentSessionSnapshot }> {
    return await this.enqueueCommand({
      sessionId: input.sessionId,
      userId: input.userId,
      commandType: 'approval',
      payload: {
        approvalToken: input.approvalToken,
        approved: input.approved,
        approveAlways: Boolean(input.approveAlways),
        toolId: input.toolId || null,
        toolFunctionName: input.toolFunctionName || null,
      },
      idempotencyKey: input.idempotencyKey,
      priority: QUEUE_PRIORITY.approval,
    });
  }

  async enqueueAbort(input: {
    sessionId: string;
    userId: string;
    reason?: string;
    idempotencyKey?: string;
  }): Promise<{ command: AgentCommand; session: AgentSessionSnapshot }> {
    return await this.enqueueCommand({
      sessionId: input.sessionId,
      userId: input.userId,
      commandType: 'abort',
      payload: {
        reason: input.reason || 'Abort requested.',
      },
      idempotencyKey: input.idempotencyKey,
      priority: QUEUE_PRIORITY.abort,
    });
  }

  replaySessionEvents(input: {
    sessionId: string;
    userId: string;
    fromSeq: number;
    limit?: number;
  }): AgentV2EventEnvelope[] {
    return this.repository.replayEvents(input);
  }

  /**
   * Directly look up the terminal event (completed or error) for a specific command.
   * Bypasses seq-based replay, works even when lastSeq is stale (e.g. after hold/resume).
   */
  getCommandResult(commandId: string, sessionId: string): AgentV2EventEnvelope | null {
    return this.repository.getCommandResult(commandId, sessionId);
  }

  close(): void {
    this.extensionHost.stopAll();
    this.repository.close();
  }

  private async enqueueCommand(input: {
    sessionId: string;
    userId: string;
    commandType: AgentCommand['commandType'];
    payload: Record<string, unknown>;
    priority: number;
    idempotencyKey?: string;
  }): Promise<{ command: AgentCommand; session: AgentSessionSnapshot }> {
    const current = this.getSession(input.sessionId, input.userId);
    await this.ensureQueueCapacity(input.sessionId, input.userId);
    await this.runHooks('command.before_enqueue', {
      session: current,
      command: null,
      stage: 'command.before_enqueue',
      payload: {
        commandType: input.commandType,
        payload: input.payload,
      },
    });

    const enqueue = this.repository.enqueueCommand({
      sessionId: input.sessionId,
      userId: input.userId,
      commandType: input.commandType,
      payload: input.payload,
      priority: input.priority,
      idempotencyKey: input.idempotencyKey,
    });

    this.emitPersistedEvents(input.userId, enqueue.events);
    this.activeHandles.set(input.sessionId, {
      sessionId: input.sessionId,
      userId: input.userId,
      snapshot: enqueue.session,
    });

    if (!enqueue.reused) {
      void this.processQueue(input.sessionId, input.userId);
    }

    return { command: enqueue.command, session: enqueue.session };
  }

  private async processQueue(sessionId: string, userId: string): Promise<void> {
    if (this.processingSessions.has(sessionId)) return;
    this.processingSessions.add(sessionId);
    try {
      while (true) {
        const started = this.repository.startNextQueuedCommand(sessionId, userId);
        if (!started) break;
        this.emitPersistedEvents(userId, started.events);

        const sessionBeforeExecution = this.getSession(sessionId, userId);
        await this.runHooks('command.before_execute', {
          session: sessionBeforeExecution,
          command: started.command,
          stage: 'command.before_execute',
          payload: {
            commandType: started.command.commandType,
          },
        });

        let completionStatus: AgentCommand['status'] = 'completed';
        let resultPayload: Record<string, unknown> | null = null;
        let errorCode: string | null = null;
        let errorMessage: string | null = null;

        try {
          const execution = await this.executeCommand(started.command, userId);
          resultPayload = {
            message: execution.message,
            ...(execution.metadata || {}),
          };
          if (execution.status !== 'ok') {
            completionStatus = 'failed_recoverable';
            errorCode = 'COMMAND_EXECUTION_FAILED';
            errorMessage = execution.message;
          } else if (started.command.commandType === 'abort') {
            completionStatus = 'aborted';
          }
        } catch (error) {
          completionStatus = 'failed_recoverable';
          errorCode = 'COMMAND_RUNTIME_EXCEPTION';
          errorMessage = error instanceof Error ? error.message : 'Command runtime exception.';
        }

        if (completionStatus === 'aborted') {
          await this.runHooks('session.before_complete', {
            session: this.getSession(sessionId, userId),
            command: started.command,
            stage: 'session.before_complete',
            payload: { reason: 'abort_command' },
          });
        }

        const completed = this.repository.completeCommand({
          sessionId,
          userId,
          commandId: started.command.id,
          status: completionStatus,
          result: resultPayload,
          errorCode,
          errorMessage,
        });
        this.emitPersistedEvents(userId, completed.events);
        this.activeHandles.set(sessionId, {
          sessionId,
          userId,
          snapshot: completed.session,
        });

        if (completed.session.status === 'aborted' || completed.session.status === 'completed') {
          await this.runHooks('session.after_complete', {
            session: completed.session,
            command: started.command,
            stage: 'session.after_complete',
            payload: {
              status: completed.session.status,
            },
          });
        }

        if (completionStatus === 'aborted') break;
      }
    } finally {
      this.processingSessions.delete(sessionId);
    }
  }

  private async executeCommand(command: AgentCommand, userId: string): Promise<AgentCommandResult> {
    const session = this.getSession(command.sessionId, userId);
    if (command.commandType === 'abort') {
      const aborted = getMessageService().abortGeneration(session.conversationId);
      return {
        status: 'ok',
        message: aborted ? 'Abort signal sent.' : 'No in-flight command to abort.',
        metadata: { aborted },
      };
    }

    if (command.commandType === 'approval') {
      const payload = command.payload;
      const approvalToken = String(payload.approvalToken || '').trim();
      if (!approvalToken) {
        return { status: 'error', message: 'approvalToken is required.' };
      }

      const result = await getMessageService().respondToolApproval({
        conversationId: session.conversationId,
        userId,
        approvalToken,
        approved: Boolean(payload.approved),
        approveAlways: Boolean(payload.approveAlways),
        toolId: payload.toolId ? String(payload.toolId) : undefined,
        toolFunctionName: payload.toolFunctionName ? String(payload.toolFunctionName) : undefined,
      });

      if (result.status === 'approval_required') {
        const event = this.repository.appendEvent({
          sessionId: session.id,
          userId,
          commandId: command.id,
          type: 'agent.v2.approval.required',
          payload: {
            approvalToken,
            reason: 'Further approval is required.',
          },
        });
        this.emitPersistedEvents(userId, [event]);
      }

      return {
        status: result.status === 'not_found' ? 'error' : 'ok',
        message: buildApprovalResultMessage(result.status),
        metadata: {
          status: result.status,
          policyUpdated: result.policyUpdated,
        },
      };
    }

    const content = String(command.payload.content || '').trim();
    if (!content) {
      return {
        status: 'error',
        message: `${command.commandType} requires non-empty content.`,
      };
    }

    await this.runHooks('model.before_dispatch', {
      session,
      command,
      stage: 'model.before_dispatch',
      payload: {
        commandType: command.commandType,
      },
    });

    let activeTool: string | null = null;
    const messageService = getMessageService();
    const result = await messageService.handleWebUIMessage(
      session.conversationId,
      content,
      userId,
      undefined,
      undefined,
      (delta) => {
        if (typeof delta !== 'string') return;
        if (delta.startsWith('\u0000tc:')) {
          const toolName = delta.slice('\u0000tc:'.length).trim();
          if (toolName) {
            activeTool = toolName;
            void this.emitEphemeralEvent({
              sessionId: session.id,
              userId,
              commandId: command.id,
              type: 'agent.v2.tool.started',
              payload: { toolName },
            });
            void this.runHooks('tool.before_execute', {
              session,
              command,
              stage: 'tool.before_execute',
              payload: { toolName },
            }).catch(() => {});
          } else if (activeTool) {
            const completedTool = activeTool;
            activeTool = null;
            void this.emitEphemeralEvent({
              sessionId: session.id,
              userId,
              commandId: command.id,
              type: 'agent.v2.tool.completed',
              payload: { toolName: completedTool },
            });
            void this.runHooks('tool.after_execute', {
              session,
              command,
              stage: 'tool.after_execute',
              payload: { toolName: completedTool },
            }).catch(() => {});
            if (this.repository.hasQueuedAbort(session.id)) {
              messageService.abortGeneration(session.conversationId);
            }
          }
          return;
        }

        void this.emitEphemeralEvent({
          sessionId: session.id,
          userId,
          commandId: command.id,
          type: 'agent.v2.model.delta',
          payload: { delta },
        });
      },
      // Agent-v2 programmatic sessions must not trigger the project clarification
      // guard — swarm phase prompts may contain build-intent keywords without any
      // user project context being relevant.
      { skipProjectGuard: true },
    );

    await this.runHooks('model.after_dispatch', {
      session: this.getSession(session.id, userId),
      command,
      stage: 'model.after_dispatch',
      payload: {
        messageId: result.agentMsg.id,
      },
    });

    const metadata = safeJsonParse<Record<string, unknown>>(result.agentMsg.metadata);
    if (String(metadata?.status || '').trim() === 'approval_required') {
      const event = this.repository.appendEvent({
        sessionId: session.id,
        userId,
        commandId: command.id,
        type: 'agent.v2.approval.required',
        payload: metadata || {},
      });
      this.emitPersistedEvents(userId, [event]);
      await this.runHooks('approval.required', {
        session: this.getSession(session.id, userId),
        command,
        stage: 'approval.required',
        payload: metadata || {},
      });
    }

    return {
      status: 'ok',
      message: result.agentMsg.content,
      metadata: {
        userMessageId: result.userMsg.id,
        agentMessageId: result.agentMsg.id,
        newConversationId: result.newConversationId || null,
        status: metadata?.status || 'ok',
      },
    };
  }

  private async emitEphemeralEvent(input: {
    sessionId: string;
    userId: string;
    commandId?: string;
    type: AgentV2EventEnvelope['type'];
    payload: Record<string, unknown>;
  }): Promise<void> {
    const event = this.repository.appendEvent({
      sessionId: input.sessionId,
      userId: input.userId,
      commandId: input.commandId ?? null,
      type: input.type,
      payload: input.payload,
    });
    this.emitPersistedEvents(input.userId, [event]);
  }

  private emitPersistedEvents(userId: string, events: AgentV2EventEnvelope[]): void {
    for (const envelope of events) {
      broadcastToUser(userId, envelope.type, envelope, { protocol: 'v2' });
    }
  }

  private async runHooks(stage: LifecycleHookStage, context: LifecycleHookContext): Promise<void> {
    const outcomes = await this.extensionHost.runHooks(stage, context);
    if (outcomes.length === 0) return;
    for (const outcome of outcomes) {
      if (outcome.ok) continue;
      if (context.session.id === 'pending') {
        console.warn(
          `[agent-v2] Hook failure before session creation (${outcome.extensionId}): ${outcome.error || 'unknown error'}`,
        );
        continue;
      }
      const event = this.repository.appendEvent({
        sessionId: context.session.id,
        userId: context.session.userId,
        commandId: context.command?.id || null,
        type: 'agent.v2.error',
        payload: {
          errorCode: 'HOOK_FAILED',
          message: outcome.error || 'Lifecycle hook failed.',
          extensionId: outcome.extensionId,
          stage: outcome.stage,
          policy: outcome.policy,
          durationMs: outcome.durationMs,
        },
      });
      this.emitPersistedEvents(context.session.userId, [event]);
    }
  }

  private async ensureQueueCapacity(sessionId: string, userId: string): Promise<void> {
    const current = this.repository.countQueuedCommands(sessionId, userId);
    const maxQueue = resolveMaxQueueLength();
    if (current >= maxQueue) {
      throw new AgentV2Error(`Session command queue is full (${maxQueue}).`, 'BACKPRESSURE');
    }
  }
}

function resolveMaxQueueLength(): number {
  const raw = Number.parseInt(String(process.env.AGENT_V2_MAX_QUEUE_PER_SESSION || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) return 64;
  return Math.max(4, Math.min(raw, 512));
}

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function buildPendingSessionSnapshot(
  userId: string,
  conversationId: string,
  now: string,
): AgentSessionSnapshot {
  return {
    id: 'pending',
    userId,
    conversationId,
    status: 'idle',
    revision: 0,
    lastSeq: 0,
    queueDepth: 0,
    runningCommandId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function buildApprovalResultMessage(
  status: 'approved' | 'denied' | 'not_found' | 'approval_required',
): string {
  if (status === 'approved') return 'Approval command accepted.';
  if (status === 'denied') return 'Approval denied.';
  if (status === 'approval_required') return 'Another approval step is required.';
  return 'Approval token not found.';
}
