import type {
  CreatePipelineModelInput,
  PipelineReasoningEffort,
  PipelineModelEntry,
  ProviderAccountRecord,
  ProviderAccountView,
} from '@/server/model-hub/repository';
import type { FetchedModel } from '@/server/model-hub/modelFetcher';
import type { GatewayRequest, GatewayResponse } from '@/server/model-hub/gateway';

export type {
  CreatePipelineModelInput,
  PipelineReasoningEffort,
  PipelineModelEntry,
  ProviderAccountRecord,
  ProviderAccountView,
};
export type { FetchedModel };
export type { GatewayRequest, GatewayResponse };

export interface ConnectProviderAccountInput {
  providerId: string;
  label: string;
  authMethod: 'none' | 'api_key' | 'oauth';
  secret: string;
  refreshToken?: string;
  encryptionKey: string;
}

export interface GeminiEmbeddingModelsApi {
  embedContent(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  batchEmbedContents?(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface OpenAICompatibleEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

export interface CohereEmbeddingResponse {
  embeddings?: { float?: number[][] } | number[][];
}

export interface EmbeddingInput {
  operation: 'embedContent' | 'batchEmbedContents';
  payload: Record<string, unknown>;
}

export interface DispatchWithFallbackOptions {
  signal?: AbortSignal;
  modelOverride?: string;
  onStreamDelta?: (delta: string) => void;
}
