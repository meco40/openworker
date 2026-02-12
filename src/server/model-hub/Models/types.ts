import type { ProviderAccountRecord } from '../repository';
import type { ProviderCatalogEntry } from '../types';

export interface FetchedModel {
  id: string;
  name: string;
  provider: string;
  owned_by?: string;
  context_window?: number;
  created?: number;
}

export interface ConnectivityResult {
  ok: boolean;
  message: string;
}

export interface GatewayMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type GatewayAuditKind =
  | 'chat'
  | 'summary'
  | 'worker_planner'
  | 'worker_executor'
  | 'api_gateway';

export interface GatewayAuditContext {
  kind: GatewayAuditKind;
  conversationId?: string;
  taskId?: string;
  stepId?: string;
}

export interface GatewayRequest {
  model: string;
  messages: GatewayMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  systemInstruction?: string;
  tools?: unknown[];
  responseMimeType?: string;
  auditContext?: GatewayAuditContext;
}

export interface GatewayResponse {
  ok: boolean;
  text: string;
  model: string;
  provider: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  functionCalls?: Array<{ name: string; args?: unknown }>;
  error?: string;
}

export interface ProviderExecutionContext {
  provider: ProviderCatalogEntry;
  account: ProviderAccountRecord;
  secret: string;
}

export interface ProviderAdapter {
  id: string;
  fetchModels?: (context: ProviderExecutionContext) => Promise<FetchedModel[]>;
  testConnectivity?: (
    context: ProviderExecutionContext,
    options?: { model?: string },
  ) => Promise<ConnectivityResult>;
  dispatchGateway?: (
    context: ProviderExecutionContext,
    request: GatewayRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<GatewayResponse>;
}
