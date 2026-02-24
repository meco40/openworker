export type AgentV2SchemaVersion = '2.1';

export const AGENT_V2_SCHEMA_VERSION: AgentV2SchemaVersion = '2.1';

export type AgentV2SessionStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'aborted'
  | 'error'
  | 'error_recoverable';

export type AgentV2CommandType = 'input' | 'steer' | 'follow_up' | 'approval' | 'abort';

export type AgentV2CommandStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'failed_recoverable'
  | 'aborted';

export type AgentV2EventType =
  | 'agent.v2.session.updated'
  | 'agent.v2.command.queued'
  | 'agent.v2.command.started'
  | 'agent.v2.command.completed'
  | 'agent.v2.model.delta'
  | 'agent.v2.tool.started'
  | 'agent.v2.tool.completed'
  | 'agent.v2.approval.required'
  | 'agent.v2.session.completed'
  | 'agent.v2.error';

export interface AgentV2EventEnvelope<TPayload = Record<string, unknown>> {
  schemaVersion: AgentV2SchemaVersion;
  eventId: string;
  sessionId: string;
  commandId: string | null;
  seq: number;
  emittedAt: string;
  type: AgentV2EventType;
  payload: TPayload;
}

export interface AgentSessionSnapshot {
  id: string;
  userId: string;
  conversationId: string;
  status: AgentV2SessionStatus;
  revision: number;
  lastSeq: number;
  queueDepth: number;
  runningCommandId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AgentSessionHandle {
  sessionId: string;
  userId: string;
  snapshot: AgentSessionSnapshot;
}

export interface AgentCommand {
  id: string;
  sessionId: string;
  commandType: AgentV2CommandType;
  priority: number;
  status: AgentV2CommandStatus;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
}

export interface AgentCommandResult {
  status: 'ok' | 'error';
  message: string;
  metadata?: Record<string, unknown>;
}

export type LifecycleHookStage =
  | 'session.before_start'
  | 'session.after_start'
  | 'command.before_enqueue'
  | 'command.before_execute'
  | 'model.before_dispatch'
  | 'model.after_dispatch'
  | 'tool.before_execute'
  | 'tool.after_execute'
  | 'approval.required'
  | 'session.before_complete'
  | 'session.after_complete';

export interface LifecycleHookContext {
  session: AgentSessionSnapshot;
  command: AgentCommand | null;
  stage: LifecycleHookStage;
  payload?: Record<string, unknown>;
}

export interface LifecycleHookOutcome {
  ok: boolean;
  extensionId: string;
  stage: LifecycleHookStage;
  error?: string;
  durationMs: number;
  policy: 'fail_open' | 'fail_closed';
}

export interface ExtensionManifestV1 {
  schemaVersion: '1';
  id: string;
  version: string;
  digest: string;
  keyId: string;
  signature: string;
  modulePath: string;
  hookStages: LifecycleHookStage[];
  failClosedStages?: LifecycleHookStage[];
  timeoutMs?: number;
}

export interface AgentV2SigningKeyRecord {
  keyId: string;
  algorithm: string;
  publicKeyPem: string;
  status: 'active' | 'rotated' | 'revoked';
  createdAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
}
