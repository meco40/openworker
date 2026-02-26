import type { ProviderAccountRecord } from '@/server/model-hub/repository';
import type { ProviderCatalogEntry } from '@/server/model-hub/types';

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
  rateLimits?: RateLimitSnapshot;
}

export interface RateLimitWindow {
  window: string;
  limit?: number;
  remaining?: number;
  usedPercent?: number;
  remainingPercent?: number;
  reset?: string;
}

export interface RateLimitSnapshot {
  windows: RateLimitWindow[];
}

export interface GatewayMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  attachments?: GatewayMessageAttachment[];
}

export interface GatewayMessageAttachment {
  name: string;
  mimeType: string;
  size: number;
  storagePath: string;
  sha256?: string;
}

export type GatewayAuditKind =
  | 'chat'
  | 'summary'
  | 'worker_planner'
  | 'worker_executor'
  | 'api_gateway'
  | 'orchestra_routing'
  | 'room'
  | 'knowledge-extraction';

export interface GatewayAuditContext {
  kind: GatewayAuditKind;
  conversationId?: string;
  /** Sequence number of the user message that triggered this dispatch */
  turnSeq?: number;
  /** Fused recall context injected this turn — stored truncated (500 chars max) */
  memoryContext?: string;
  taskId?: string;
  stepId?: string;
  nodeId?: string;
}

export interface GatewayRequest {
  model: string;
  messages: GatewayMessage[];
  max_tokens?: number;
  temperature?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
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
  rateLimits?: RateLimitSnapshot;
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
    options?: { signal?: AbortSignal; onStreamDelta?: (delta: string) => void },
  ) => Promise<GatewayResponse>;
}
