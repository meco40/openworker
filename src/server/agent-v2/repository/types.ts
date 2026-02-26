import type {
  AgentV2CommandStatus,
  AgentV2CommandType,
  AgentV2EventType,
  AgentV2SessionStatus,
} from '@/server/agent-v2/types';

export interface SessionRow {
  id: string;
  user_id: string;
  conversation_id: string;
  status: AgentV2SessionStatus;
  revision: number;
  last_seq: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CommandRow {
  id: string;
  session_id: string;
  command_type: AgentV2CommandType;
  priority: number;
  status: AgentV2CommandStatus;
  payload_json: string;
  idempotency_key: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  result_json: string | null;
}

export interface EventRow {
  id: string;
  session_id: string;
  command_id: string | null;
  seq: number;
  type: AgentV2EventType;
  payload_json: string;
  emitted_at: string;
}

export interface ExtensionRow {
  id: string;
  version: string;
  digest: string;
  manifest_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface EnqueueAgentCommandInput {
  sessionId: string;
  userId: string;
  commandType: AgentV2CommandType;
  priority: number;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  /** Pre-generated command ID — used when the caller must know the ID before enqueue. */
  commandId?: string;
}

export interface EnqueueAgentCommandResult {
  command: import('@/server/agent-v2/types').AgentCommand;
  reused: boolean;
  session: import('@/server/agent-v2/types').AgentSessionSnapshot;
  events: import('@/server/agent-v2/types').AgentV2EventEnvelope[];
}

export interface StartNextCommandResult {
  command: import('@/server/agent-v2/types').AgentCommand;
  session: import('@/server/agent-v2/types').AgentSessionSnapshot;
  events: import('@/server/agent-v2/types').AgentV2EventEnvelope[];
}

export interface CompleteCommandInput {
  sessionId: string;
  userId: string;
  commandId: string;
  status: AgentV2CommandStatus;
  result?: import('@/server/agent-v2/types').AgentCommandResult | Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface CompleteCommandResult {
  command: import('@/server/agent-v2/types').AgentCommand;
  session: import('@/server/agent-v2/types').AgentSessionSnapshot;
  events: import('@/server/agent-v2/types').AgentV2EventEnvelope[];
}
