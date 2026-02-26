/**
 * Session Manager Module
 *
 * This is the main entry point for the session management functionality.
 * It provides the AgentV2SessionManager class which coordinates all session
 * operations by delegating to specialized sub-modules.
 */

import type {
  AgentCommand,
  AgentSessionHandle,
  AgentSessionSnapshot,
  AgentV2EventEnvelope,
  LifecycleHookContext,
  LifecycleHookStage,
} from '@/server/agent-v2/types';
import { AgentV2Repository } from '@/server/agent-v2/repository';
import { AgentV2ExtensionHost } from '@/server/agent-v2/extensions/host';
import { broadcastToUser } from '@/server/gateway/broadcast';

// Re-export types for convenience
export type {
  AgentCommand,
  AgentCommandResult,
  AgentSessionHandle,
  AgentSessionSnapshot,
  AgentV2EventEnvelope,
  LifecycleHookContext,
  LifecycleHookStage,
} from '@/server/agent-v2/types';

// Re-export session-specific types
export type {
  StartSessionInput,
  StartSessionResult,
  EnqueueInputParams,
  EnqueueSteerParams,
  EnqueueFollowUpParams,
  EnqueueApprovalParams,
  EnqueueAbortParams,
  ReplaySessionEventsInput,
  EnqueueCommandParams,
  EnqueueCommandResult,
  EmitEphemeralEventParams,
} from './types';

// Import state operations
import {
  startSession,
  getSession,
  listSessions,
  performStartupRecovery,
  close,
  markProcessing,
  unmarkProcessing,
  type CreateSessionContext,
  type UpdateSessionContext,
  type LifecycleContext,
} from './state';

// Import command operations
import {
  enqueueCommand,
  enqueueInput,
  enqueueSteer,
  enqueueFollowUp,
  enqueueApprovalResponse,
  enqueueAbort,
  executeCommand,
  type EnqueueContext,
  type ExecuteContext,
} from './commands';

// Import event operations
import { replaySessionEvents, getCommandResult, type ReplayContext } from './events';

// Import utilities
import { safeJsonParse, buildPendingSessionSnapshot, buildApprovalResultMessage } from './utils';

// Import constants
import { QUEUE_PRIORITY } from './constants';

/**
 * Main session manager class for Agent V2.
 * Coordinates session lifecycle, command queue management, and event handling.
 */
export class AgentV2SessionManager {
  private readonly repository: AgentV2Repository;
  private readonly extensionHost: AgentV2ExtensionHost;
  private readonly processingSessions = new Set<string>();
  private readonly activeHandles = new Map<string, AgentSessionHandle>();

  constructor(repository?: AgentV2Repository, extensionHost?: AgentV2ExtensionHost) {
    this.repository = repository ?? new AgentV2Repository();
    this.extensionHost = extensionHost ?? new AgentV2ExtensionHost(this.repository);
    this.extensionHost.refresh();
    performStartupRecovery(this.getLifecycleContext());
  }

  // ==================== Session Lifecycle ====================

  async startSession(input: {
    userId: string;
    title?: string;
    personaId?: string;
    conversationId?: string;
  }): Promise<{ session: AgentSessionSnapshot; events: AgentV2EventEnvelope[] }> {
    return startSession(input, this.getCreateSessionContext());
  }

  getSession(sessionId: string, userId: string): AgentSessionSnapshot {
    return getSession(sessionId, userId, this.getUpdateSessionContext());
  }

  listSessions(userId: string, limit?: number): AgentSessionSnapshot[] {
    return listSessions(userId, limit || 50, this.repository);
  }

  close(): void {
    close(this.getLifecycleContext());
  }

  // ==================== Command Enqueue ====================

  async enqueueInput(input: {
    sessionId: string;
    userId: string;
    content: string;
    idempotencyKey?: string;
    commandId?: string;
  }): Promise<{ command: AgentCommand; session: AgentSessionSnapshot }> {
    return enqueueInput(
      input.sessionId,
      input.userId,
      input.content,
      input.idempotencyKey,
      input.commandId,
      (params) => enqueueCommand(params, this.getEnqueueContext()),
    );
  }

  async enqueueSteer(input: {
    sessionId: string;
    userId: string;
    instruction: string;
    idempotencyKey?: string;
  }): Promise<{ command: AgentCommand; session: AgentSessionSnapshot }> {
    return enqueueSteer(
      input.sessionId,
      input.userId,
      input.instruction,
      input.idempotencyKey,
      (params) => enqueueCommand(params, this.getEnqueueContext()),
    );
  }

  async enqueueFollowUp(input: {
    sessionId: string;
    userId: string;
    content: string;
    idempotencyKey?: string;
    commandId?: string;
  }): Promise<{ command: AgentCommand; session: AgentSessionSnapshot }> {
    return enqueueFollowUp(
      input.sessionId,
      input.userId,
      input.content,
      input.idempotencyKey,
      input.commandId,
      (params) => enqueueCommand(params, this.getEnqueueContext()),
    );
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
    return enqueueApprovalResponse(
      input.sessionId,
      input.userId,
      input.approvalToken,
      input.approved,
      input.approveAlways,
      input.toolId,
      input.toolFunctionName,
      input.idempotencyKey,
      (params) => enqueueCommand(params, this.getEnqueueContext()),
    );
  }

  async enqueueAbort(input: {
    sessionId: string;
    userId: string;
    reason?: string;
    idempotencyKey?: string;
  }): Promise<{ command: AgentCommand; session: AgentSessionSnapshot }> {
    return enqueueAbort(
      input.sessionId,
      input.userId,
      input.reason,
      input.idempotencyKey,
      (params) => enqueueCommand(params, this.getEnqueueContext()),
    );
  }

  // ==================== Event Handling ====================

  replaySessionEvents(input: {
    sessionId: string;
    userId: string;
    fromSeq: number;
    limit?: number;
  }): AgentV2EventEnvelope[] {
    return replaySessionEvents(input, this.getReplayContext());
  }

  getCommandResult(commandId: string, sessionId: string): AgentV2EventEnvelope | null {
    return getCommandResult(commandId, sessionId, this.repository);
  }

  // ==================== Private Methods ====================

  private async processQueue(sessionId: string, userId: string): Promise<void> {
    if (this.processingSessions.has(sessionId)) return;
    markProcessing(sessionId, this.getLifecycleContext());
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
          const execution = await executeCommand(started.command, userId, this.getExecuteContext());
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
      unmarkProcessing(sessionId, this.getLifecycleContext());
    }
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

  // ==================== Context Helpers ====================

  private getCreateSessionContext(): CreateSessionContext {
    return {
      repository: this.repository,
      extensionHost: this.extensionHost,
      activeHandles: this.activeHandles,
      runHooks: (stage, context) =>
        this.runHooks(stage as LifecycleHookStage, context as LifecycleHookContext),
      emitPersistedEvents: (userId, events) =>
        this.emitPersistedEvents(userId, events as AgentV2EventEnvelope[]),
    };
  }

  private getUpdateSessionContext(): UpdateSessionContext {
    return {
      repository: this.repository,
      activeHandles: this.activeHandles,
    };
  }

  private getLifecycleContext(): LifecycleContext {
    return {
      repository: this.repository,
      extensionHost: this.extensionHost,
      processingSessions: this.processingSessions,
      activeHandles: this.activeHandles,
    };
  }

  private getEnqueueContext(): EnqueueContext {
    return {
      repository: this.repository,
      activeHandles: this.activeHandles,
      getSession: (sessionId, userId) => this.getSession(sessionId, userId),
      runHooks: (stage, context) =>
        this.runHooks(stage as LifecycleHookStage, context as LifecycleHookContext),
      emitPersistedEvents: (userId, events) =>
        this.emitPersistedEvents(userId, events as AgentV2EventEnvelope[]),
      processQueue: (sessionId, userId) => this.processQueue(sessionId, userId),
    };
  }

  private getExecuteContext(): ExecuteContext {
    return {
      repository: this.repository,
      extensionHost: this.extensionHost,
      activeHandles: this.activeHandles,
      getSession: (sessionId, userId) => this.getSession(sessionId, userId),
      runHooks: (stage, context) =>
        this.runHooks(stage as LifecycleHookStage, context as LifecycleHookContext),
      emitPersistedEvents: (userId, events) =>
        this.emitPersistedEvents(userId, events as AgentV2EventEnvelope[]),
      emitEphemeralEvent: (params) => this.emitEphemeralEvent(params),
    };
  }

  private getReplayContext(): ReplayContext {
    return {
      repository: this.repository,
    };
  }
}

// Re-export utility functions for backward compatibility
export { QUEUE_PRIORITY, safeJsonParse, buildPendingSessionSnapshot, buildApprovalResultMessage };

// Re-export constants for backward compatibility
export { DEFAULT_MAX_QUEUE_LENGTH, MIN_QUEUE_LENGTH, MAX_QUEUE_LENGTH } from './constants';
