/**
 * Command enqueue operations.
 */

import { AgentV2Error } from '@/server/agent-v2/errors';
import type { AgentV2Repository } from '@/server/agent-v2/repository';
import type { AgentSessionSnapshot } from '@/server/agent-v2/types';
import type { EnqueueCommandParams, EnqueueCommandResult } from '../types';
import { QUEUE_PRIORITY } from '../constants';
import { resolveMaxQueueLength } from '../utils';

export interface EnqueueContext {
  repository: AgentV2Repository;
  activeHandles: Map<string, { sessionId: string; userId: string; snapshot: AgentSessionSnapshot }>;
  getSession: (sessionId: string, userId: string) => AgentSessionSnapshot;
  runHooks: (stage: string, context: unknown) => Promise<void>;
  emitPersistedEvents: (userId: string, events: unknown[]) => void;
  processQueue: (sessionId: string, userId: string) => Promise<void>;
}

/**
 * Internal method to enqueue a command with priority.
 */
export async function enqueueCommand(
  input: EnqueueCommandParams,
  ctx: EnqueueContext,
): Promise<EnqueueCommandResult> {
  const current = ctx.getSession(input.sessionId, input.userId);
  await ensureQueueCapacity(input.sessionId, input.userId, ctx.repository);
  await ctx.runHooks('command.before_enqueue', {
    session: current,
    command: null,
    stage: 'command.before_enqueue',
    payload: {
      commandType: input.commandType,
      payload: input.payload,
    },
  });

  const enqueue = ctx.repository.enqueueCommand({
    sessionId: input.sessionId,
    userId: input.userId,
    commandType: input.commandType,
    payload: input.payload,
    priority: input.priority,
    idempotencyKey: input.idempotencyKey,
    commandId: input.commandId,
  });

  ctx.emitPersistedEvents(input.userId, enqueue.events);
  ctx.activeHandles.set(input.sessionId, {
    sessionId: input.sessionId,
    userId: input.userId,
    snapshot: enqueue.session,
  });

  if (!enqueue.reused) {
    void ctx.processQueue(input.sessionId, input.userId);
  }

  return { command: enqueue.command, session: enqueue.session };
}

/**
 * Ensures the queue has capacity for a new command.
 */
export async function ensureQueueCapacity(
  sessionId: string,
  userId: string,
  repository: AgentV2Repository,
): Promise<void> {
  const current = repository.countQueuedCommands(sessionId, userId);
  const maxQueue = resolveMaxQueueLength();
  if (current >= maxQueue) {
    throw new AgentV2Error(`Session command queue is full (${maxQueue}).`, 'BACKPRESSURE');
  }
}

/**
 * Enqueues a user input command.
 */
export async function enqueueInput(
  sessionId: string,
  userId: string,
  content: string,
  idempotencyKey: string | undefined,
  commandId: string | undefined,
  enqueueFn: (params: EnqueueCommandParams) => Promise<EnqueueCommandResult>,
): Promise<EnqueueCommandResult> {
  return enqueueFn({
    sessionId,
    userId,
    commandType: 'input',
    payload: { content },
    priority: QUEUE_PRIORITY.input,
    idempotencyKey,
    commandId,
  });
}

/**
 * Enqueues a steer command.
 */
export async function enqueueSteer(
  sessionId: string,
  userId: string,
  instruction: string,
  idempotencyKey: string | undefined,
  enqueueFn: (params: EnqueueCommandParams) => Promise<EnqueueCommandResult>,
): Promise<EnqueueCommandResult> {
  return enqueueFn({
    sessionId,
    userId,
    commandType: 'steer',
    payload: { content: instruction },
    priority: QUEUE_PRIORITY.steer,
    idempotencyKey,
  });
}

/**
 * Enqueues a follow-up command.
 */
export async function enqueueFollowUp(
  sessionId: string,
  userId: string,
  content: string,
  idempotencyKey: string | undefined,
  commandId: string | undefined,
  enqueueFn: (params: EnqueueCommandParams) => Promise<EnqueueCommandResult>,
): Promise<EnqueueCommandResult> {
  return enqueueFn({
    sessionId,
    userId,
    commandType: 'follow_up',
    payload: { content },
    priority: QUEUE_PRIORITY.follow_up,
    idempotencyKey,
    commandId,
  });
}

/**
 * Enqueues an approval response command.
 */
export async function enqueueApprovalResponse(
  sessionId: string,
  userId: string,
  approvalToken: string,
  approved: boolean,
  approveAlways: boolean | undefined,
  toolId: string | undefined,
  toolFunctionName: string | undefined,
  idempotencyKey: string | undefined,
  enqueueFn: (params: EnqueueCommandParams) => Promise<EnqueueCommandResult>,
): Promise<EnqueueCommandResult> {
  return enqueueFn({
    sessionId,
    userId,
    commandType: 'approval',
    payload: {
      approvalToken,
      approved,
      approveAlways: Boolean(approveAlways),
      toolId: toolId || null,
      toolFunctionName: toolFunctionName || null,
    },
    priority: QUEUE_PRIORITY.approval,
    idempotencyKey,
  });
}

/**
 * Enqueues an abort command.
 */
export async function enqueueAbort(
  sessionId: string,
  userId: string,
  reason: string | undefined,
  idempotencyKey: string | undefined,
  enqueueFn: (params: EnqueueCommandParams) => Promise<EnqueueCommandResult>,
): Promise<EnqueueCommandResult> {
  return enqueueFn({
    sessionId,
    userId,
    commandType: 'abort',
    payload: {
      reason: reason || 'Abort requested.',
    },
    priority: QUEUE_PRIORITY.abort,
    idempotencyKey,
  });
}
