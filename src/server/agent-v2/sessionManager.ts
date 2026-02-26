/**
 * Session Manager (Legacy Entry Point)
 *
 * This file is maintained for backward compatibility.
 * All functionality has been moved to the session/ module.
 *
 * @deprecated Import from '@/server/agent-v2/session' instead.
 */

export {
  AgentV2SessionManager,
  QUEUE_PRIORITY,
  safeJsonParse,
  buildPendingSessionSnapshot,
  buildApprovalResultMessage,
  DEFAULT_MAX_QUEUE_LENGTH,
  MIN_QUEUE_LENGTH,
  MAX_QUEUE_LENGTH,
} from './session';

export type {
  AgentCommand,
  AgentCommandResult,
  AgentSessionHandle,
  AgentSessionSnapshot,
  AgentV2EventEnvelope,
  LifecycleHookContext,
  LifecycleHookStage,
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
} from './session';
