import type {
  CreatePipelineModelInput,
  ModelHubRepository,
  PipelineModelEntry,
  ProviderAccountRecord,
  ProviderAccountView,
} from '@/server/model-hub/repository';
import type { FetchedModel } from '@/server/model-hub/modelFetcher';
import type { GatewayRequest, GatewayResponse } from '@/server/model-hub/gateway';
import { fetchModelsForAccount } from '@/server/model-hub/modelFetcher';

import type {
  ConnectProviderAccountInput,
  EmbeddingInput,
  DispatchWithFallbackOptions,
} from './types';

import {
  connectProviderAccount,
  disconnectProviderAccount,
  maybeRefreshOpenAICodexAccount,
} from './provider';

import {
  listPipeline,
  addModelToPipeline,
  removeModelFromPipeline,
  updateModelStatus,
  movePipelineModel,
  replacePipeline,
} from './pipeline';

import { dispatchChat, dispatchWithFallback, dispatchEmbedding } from './dispatch';

// Re-export types for backward compatibility
export type {
  ConnectProviderAccountInput,
  EmbeddingInput,
  DispatchWithFallbackOptions,
  GeminiEmbeddingModelsApi,
  OpenAICompatibleEmbeddingResponse,
  CohereEmbeddingResponse,
} from './types';

export class ModelHubService {
  constructor(private readonly repository: ModelHubRepository) {}

  private async getUsableAccountByIdInternal(
    accountId: string,
    encryptionKey: string,
  ): Promise<ProviderAccountRecord | null> {
    const account = this.repository.getAccountRecordById(accountId);
    if (!account) return null;
    return maybeRefreshOpenAICodexAccount(this.repository, account, encryptionKey);
  }

  async getUsableAccountById(
    accountId: string,
    encryptionKey: string,
  ): Promise<ProviderAccountRecord | null> {
    return this.getUsableAccountByIdInternal(accountId, encryptionKey);
  }

  // ─── Account management ────────────────────────────────────────

  connectAccount(input: ConnectProviderAccountInput): ProviderAccountView {
    return connectProviderAccount(this.repository, input);
  }

  listAccounts(): ProviderAccountView[] {
    return this.repository.listAccounts();
  }

  getAccountById(accountId: string) {
    return this.repository.getAccountRecordById(accountId);
  }

  updateHealth(accountId: string, ok: boolean, message?: string | null): void {
    this.repository.setHealthStatus(accountId, ok, message);
  }

  deleteAccount(accountId: string): boolean {
    return disconnectProviderAccount(this.repository, accountId);
  }

  // ─── Model fetching ────────────────────────────────────────────

  async fetchModelsForAccount(accountId: string, encryptionKey: string): Promise<FetchedModel[]> {
    return this.fetchModelsForAccountByPurpose(accountId, encryptionKey);
  }

  async fetchModelsForAccountByPurpose(
    accountId: string,
    encryptionKey: string,
    purpose: 'general' | 'embedding' = 'general',
  ): Promise<FetchedModel[]> {
    const account = await this.getUsableAccountByIdInternal(accountId, encryptionKey);
    if (!account) return [];
    return fetchModelsForAccount(account, encryptionKey, { purpose });
  }

  // ─── Pipeline management ───────────────────────────────────────

  listPipeline(profileId: string): PipelineModelEntry[] {
    return listPipeline(this.repository, profileId);
  }

  addModelToPipeline(input: CreatePipelineModelInput): PipelineModelEntry {
    return addModelToPipeline(this.repository, input);
  }

  removeModelFromPipeline(modelId: string): boolean {
    return removeModelFromPipeline(this.repository, modelId);
  }

  updateModelStatus(modelId: string, status: 'active' | 'rate-limited' | 'offline'): void {
    return updateModelStatus(this.repository, modelId, status);
  }

  movePipelineModel(profileId: string, modelId: string, direction: 'up' | 'down'): boolean {
    return movePipelineModel(this.repository, profileId, modelId, direction);
  }

  replacePipeline(profileId: string, models: CreatePipelineModelInput[]): PipelineModelEntry[] {
    return replacePipeline(this.repository, profileId, models);
  }

  // ─── Gateway dispatch ──────────────────────────────────────────

  async dispatchChat(
    accountId: string,
    encryptionKey: string,
    request: GatewayRequest,
  ): Promise<GatewayResponse> {
    const account = await this.getUsableAccountByIdInternal(accountId, encryptionKey);
    if (!account) {
      return {
        ok: false,
        text: '',
        model: request.model,
        provider: 'unknown',
        error: `Account ${accountId} not found.`,
      };
    }
    return dispatchChat(this.repository, accountId, encryptionKey, request);
  }

  async dispatchWithFallback(
    profileId: string,
    encryptionKey: string,
    request: Omit<GatewayRequest, 'model'>,
    options?: DispatchWithFallbackOptions,
  ): Promise<GatewayResponse> {
    return dispatchWithFallback(this.repository, profileId, encryptionKey, request, options);
  }

  // ─── Embedding dispatch ────────────────────────────────────────

  async dispatchEmbedding(
    encryptionKey: string,
    input: EmbeddingInput,
  ): Promise<Record<string, unknown>> {
    return dispatchEmbedding(this.repository, encryptionKey, input);
  }
}

// Re-export utility functions for backward compatibility
export {
  asPositiveInteger,
  normalizeBearerSecret,
  extractTextParts,
  tryExtractBatchPayloadAsEmbedContent,
  mapPipelineReasoningEffort,
  EMBEDDING_PROFILE_ID,
} from './utils';

// Re-export embedding functions for backward compatibility
export {
  dispatchGeminiEmbedding,
  normalizeOpenAICompatibleEmbeddingInput,
  dispatchOpenAICompatibleEmbedding,
  dispatchCohereEmbedding,
} from './embedding';
