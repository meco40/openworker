/**
 * Session-related type definitions and interfaces.
 * Re-exports from agent-v2 types for convenience.
 */

export type {
  AgentCommand,
  AgentCommandResult,
  AgentSessionHandle,
  AgentSessionSnapshot,
  AgentV2EventEnvelope,
  LifecycleHookContext,
  LifecycleHookStage,
} from '@/server/agent-v2/types';

import type {
  AgentCommand,
  AgentSessionSnapshot,
  AgentV2EventEnvelope,
} from '@/server/agent-v2/types';

/**
 * Input parameters for starting a new session.
 */
export interface StartSessionInput {
  userId: string;
  title?: string;
  personaId?: string;
  conversationId?: string;
}

/**
 * Result of starting a new session.
 */
export interface StartSessionResult {
  session: AgentSessionSnapshot;
  events: AgentV2EventEnvelope[];
}

/**
 * Input parameters for enqueuing user input.
 */
export interface EnqueueInputParams {
  sessionId: string;
  userId: string;
  content: string;
  idempotencyKey?: string;
  commandId?: string;
}

/**
 * Input parameters for enqueuing a steer command.
 */
export interface EnqueueSteerParams {
  sessionId: string;
  userId: string;
  instruction: string;
  idempotencyKey?: string;
}

/**
 * Input parameters for enqueuing a follow-up command.
 */
export interface EnqueueFollowUpParams {
  sessionId: string;
  userId: string;
  content: string;
  idempotencyKey?: string;
  commandId?: string;
}

/**
 * Input parameters for enqueuing an approval response.
 */
export interface EnqueueApprovalParams {
  sessionId: string;
  userId: string;
  approvalToken: string;
  approved: boolean;
  approveAlways?: boolean;
  toolId?: string;
  toolFunctionName?: string;
  idempotencyKey?: string;
}

/**
 * Input parameters for enqueuing an abort command.
 */
export interface EnqueueAbortParams {
  sessionId: string;
  userId: string;
  reason?: string;
  idempotencyKey?: string;
}

/**
 * Input parameters for replaying session events.
 */
export interface ReplaySessionEventsInput {
  sessionId: string;
  userId: string;
  fromSeq: number;
  limit?: number;
}

/**
 * Parameters for internal command enqueue operation.
 */
export interface EnqueueCommandParams {
  sessionId: string;
  userId: string;
  commandType: AgentCommand['commandType'];
  payload: Record<string, unknown>;
  priority: number;
  idempotencyKey?: string;
  commandId?: string;
}

/**
 * Result of enqueuing a command.
 */
export interface EnqueueCommandResult {
  command: AgentCommand;
  session: AgentSessionSnapshot;
}

/**
 * Parameters for emitting ephemeral events.
 */
export interface EmitEphemeralEventParams {
  sessionId: string;
  userId: string;
  commandId?: string;
  type: AgentV2EventEnvelope['type'];
  payload: Record<string, unknown>;
}
