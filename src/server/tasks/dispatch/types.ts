import type { Agent, OpenClawSession, Task } from '@/lib/types';

export interface DispatchHttpResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface DispatchChatSendResult {
  userMsgId?: string;
  agentMsgId?: string;
  conversationId?: string;
  agentContent?: string;
  agentMetadata?: Record<string, unknown>;
}

export interface DispatchFailure {
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface DispatchRuntimeClient {
  isConnected(): boolean;
  connect(): Promise<void>;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export type DispatchTaskRow = Task & {
  assigned_agent_name?: string;
};

export interface PreparedDispatchContext {
  taskId: string;
  task: DispatchTaskRow;
  agent: Agent;
  session: OpenClawSession;
  now: string;
  taskMessage: string;
  taskProjectDir: string;
  client: DispatchRuntimeClient;
}

export type DispatchPreparationResult =
  | {
      kind: 'response';
      response: DispatchHttpResponse;
    }
  | {
      kind: 'context';
      context: PreparedDispatchContext;
    };

export type DispatchExecutionResult =
  | {
      kind: 'response';
      response: DispatchHttpResponse;
    }
  | {
      kind: 'result';
      sendResult: DispatchChatSendResult | null;
    };
