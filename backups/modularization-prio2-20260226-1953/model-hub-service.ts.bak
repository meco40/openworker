import { decryptSecret, encryptSecret, maskSecret } from '@/server/model-hub/crypto';
import type {
  CreatePipelineModelInput,
  ModelHubRepository,
  PipelineReasoningEffort,
  PipelineModelEntry,
  ProviderAccountRecord,
  ProviderAccountView,
} from '@/server/model-hub/repository';
import { fetchModelsForAccount, type FetchedModel } from '@/server/model-hub/modelFetcher';
import {
  dispatchGatewayRequest,
  type GatewayRequest,
  type GatewayResponse,
} from '@/server/model-hub/gateway';
import { isJwtExpiringSoon, refreshOpenAICodexToken } from '@/server/model-hub/codexAuth';
import { PROVIDER_CATALOG } from '@/server/model-hub/providerCatalog';
import { fetchWithTimeout, parseErrorMessage } from '@/server/model-hub/Models/shared/http';

interface ConnectProviderAccountInput {
  providerId: string;
  label: string;
  authMethod: 'none' | 'api_key' | 'oauth';
  secret: string;
  refreshToken?: string;
  encryptionKey: string;
}

interface GeminiEmbeddingModelsApi {
  embedContent(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  batchEmbedContents?(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const EMBEDDING_PROFILE_ID = 'p1-embeddings';

interface OpenAICompatibleEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

interface CohereEmbeddingResponse {
  embeddings?: { float?: number[][] } | number[][];
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function tryExtractBatchPayloadAsEmbedContent(
  payload: Record<string, unknown>,
): { model: string; contents: string[] } | null {
  const requests = Array.isArray(payload.requests) ? payload.requests : null;
  if (!requests || requests.length === 0) return null;

  const first = requests[0];
  if (!first || typeof first !== 'object') return null;
  const firstModel = (first as { model?: unknown }).model;
  if (typeof firstModel !== 'string' || !firstModel.trim()) return null;

  const contents: string[] = [];
  for (const request of requests) {
    if (!request || typeof request !== 'object') continue;
    const req = request as {
      contents?: unknown;
      content?: { parts?: Array<{ text?: unknown }> };
    };

    if (Array.isArray(req.contents)) {
      for (const entry of req.contents) {
        if (typeof entry === 'string' && entry.trim()) {
          contents.push(entry);
        } else if (
          entry &&
          typeof entry === 'object' &&
          Array.isArray((entry as { parts?: unknown }).parts)
        ) {
          for (const part of (entry as { parts: Array<{ text?: unknown }> }).parts) {
            if (typeof part?.text === 'string' && part.text.trim()) {
              contents.push(part.text);
            }
          }
        }
      }
    } else if (req.content && Array.isArray(req.content.parts)) {
      for (const part of req.content.parts) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          contents.push(part.text);
        }
      }
    }
  }

  if (contents.length === 0) return null;
  return { model: firstModel.trim(), contents };
}

function normalizeBearerSecret(secret: string): string {
  return secret
    .trim()
    .replace(/^Bearer\s+/i, '')
    .trim();
}

function extractTextParts(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (!Array.isArray(value)) return [];

  const texts: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) texts.push(text);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const parts = (entry as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) {
        texts.push(text.trim());
      }
    }
  }
  return texts;
}

function normalizeOpenAICompatibleEmbeddingInput(
  operation: 'embedContent' | 'batchEmbedContents',
  payload: Record<string, unknown>,
  fallbackModel: string,
): { model: string; input: string[]; dimensions?: number } | null {
  const requestedModel =
    typeof payload.model === 'string' && payload.model.trim().length > 0
      ? payload.model.trim()
      : '';
  const model = requestedModel || fallbackModel.trim();
  if (!model) return null;
  const dimensions = asPositiveInteger(payload.dimensions);

  if (payload.input !== undefined) {
    if (typeof payload.input === 'string' && payload.input.trim()) {
      return { model, input: [payload.input.trim()], dimensions };
    }
    if (Array.isArray(payload.input)) {
      const normalized = payload.input
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean);
      if (normalized.length > 0) {
        return { model, input: normalized, dimensions };
      }
    }
  }

  if (operation === 'embedContent') {
    const fromContents = extractTextParts(payload.contents);
    if (fromContents.length > 0) return { model, input: fromContents, dimensions };
    const fromContent = extractTextParts((payload as { content?: unknown }).content);
    if (fromContent.length > 0) return { model, input: fromContent, dimensions };
    return null;
  }

  const batchFallback = tryExtractBatchPayloadAsEmbedContent(payload);
  if (batchFallback) {
    return {
      model: requestedModel || batchFallback.model || model,
      input: batchFallback.contents,
      dimensions,
    };
  }

  const fromContents = extractTextParts(payload.contents);
  if (fromContents.length > 0) return { model, input: fromContents, dimensions };
  return null;
}

async function dispatchOpenAICompatibleEmbedding(
  providerId: string,
  baseUrl: string,
  secret: string,
  operation: 'embedContent' | 'batchEmbedContents',
  payload: Record<string, unknown>,
  fallbackModel: string,
): Promise<Record<string, unknown>> {
  const normalized = normalizeOpenAICompatibleEmbeddingInput(operation, payload, fallbackModel);
  if (!normalized) {
    return { error: 'Embedding payload is missing a supported model/input format.' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const normalizedSecret = normalizeBearerSecret(secret);
  if (normalizedSecret) {
    headers.Authorization = `Bearer ${normalizedSecret}`;
  }
  if (providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://openclaw.app';
    headers['X-Title'] = 'OpenClaw';
  }

  const response = await fetchWithTimeout(
    `${baseUrl.replace(/\/$/, '')}/embeddings`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: normalized.model,
        input: normalized.input,
        ...(normalized.dimensions ? { dimensions: normalized.dimensions } : {}),
      }),
    },
    60_000,
  );

  if (!response.ok) {
    return { error: await parseErrorMessage(response) };
  }

  const json = (await response.json().catch(() => ({}))) as OpenAICompatibleEmbeddingResponse;
  const vectors = (json.data ?? [])
    .map((entry) => (Array.isArray(entry?.embedding) ? entry.embedding : []))
    .filter((embedding) => embedding.length > 0);

  if (operation === 'embedContent') {
    return { embedding: { values: vectors[0] ?? [] } };
  }
  return { embeddings: vectors.map((values) => ({ values })) };
}

async function dispatchCohereEmbedding(
  secret: string,
  operation: 'embedContent' | 'batchEmbedContents',
  payload: Record<string, unknown>,
  fallbackModel: string,
): Promise<Record<string, unknown>> {
  const normalized = normalizeOpenAICompatibleEmbeddingInput(operation, payload, fallbackModel);
  if (!normalized) {
    return { error: 'Embedding payload is missing a supported model/input format.' };
  }

  const response = await fetchWithTimeout(
    'https://api.cohere.com/v2/embed',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${normalizeBearerSecret(secret)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: normalized.model,
        texts: normalized.input,
        embedding_types: ['float'],
      }),
    },
    60_000,
  );

  if (!response.ok) {
    return { error: await parseErrorMessage(response) };
  }

  const json = (await response.json().catch(() => ({}))) as CohereEmbeddingResponse;
  const rawEmbeddings = Array.isArray(json.embeddings)
    ? json.embeddings
    : Array.isArray(json.embeddings?.float)
      ? json.embeddings.float
      : [];

  const vectors = rawEmbeddings.filter(
    (embedding): embedding is number[] => Array.isArray(embedding) && embedding.length > 0,
  );

  if (operation === 'embedContent') {
    return { embedding: { values: vectors[0] ?? [] } };
  }
  return { embeddings: vectors.map((values) => ({ values })) };
}

function mapPipelineReasoningEffort(
  reasoningEffort?: PipelineReasoningEffort,
): GatewayRequest['reasoning_effort'] | undefined {
  if (!reasoningEffort || reasoningEffort === 'off') {
    return undefined;
  }
  if (reasoningEffort === 'minimal') {
    return 'low';
  }
  if (reasoningEffort === 'xhigh') {
    return 'high';
  }
  if (reasoningEffort === 'low' || reasoningEffort === 'medium' || reasoningEffort === 'high') {
    return reasoningEffort;
  }
  return undefined;
}

export class ModelHubService {
  constructor(private readonly repository: ModelHubRepository) {}

  private async maybeRefreshOpenAICodexAccount(
    account: ProviderAccountRecord,
    encryptionKey: string,
  ): Promise<ProviderAccountRecord> {
    if (account.providerId !== 'openai-codex' || account.authMethod !== 'oauth') {
      return account;
    }
    if (!account.encryptedRefreshToken) {
      return account;
    }

    const currentAccessToken = decryptSecret(account.encryptedSecret, encryptionKey);
    if (!currentAccessToken?.trim()) {
      return account;
    }
    if (!isJwtExpiringSoon(currentAccessToken)) {
      return account;
    }

    const currentRefreshToken = decryptSecret(account.encryptedRefreshToken, encryptionKey);
    if (!currentRefreshToken?.trim()) {
      return account;
    }

    try {
      const refreshed = await refreshOpenAICodexToken(currentRefreshToken);
      this.repository.updateAccountCredentials({
        id: account.id,
        encryptedSecret: encryptSecret(refreshed.accessToken, encryptionKey),
        encryptedRefreshToken: encryptSecret(refreshed.refreshToken, encryptionKey),
        secretMasked: maskSecret(refreshed.accessToken),
      });
      return this.repository.getAccountRecordById(account.id) ?? account;
    } catch {
      return account;
    }
  }

  async getUsableAccountById(
    accountId: string,
    encryptionKey: string,
  ): Promise<ProviderAccountRecord | null> {
    const account = this.repository.getAccountRecordById(accountId);
    if (!account) return null;
    return this.maybeRefreshOpenAICodexAccount(account, encryptionKey);
  }

  // ─── Account management ────────────────────────────────────────

  connectAccount(input: ConnectProviderAccountInput): ProviderAccountView {
    const encryptedSecret = encryptSecret(input.secret, input.encryptionKey);
    const encryptedRefreshToken = input.refreshToken
      ? encryptSecret(input.refreshToken, input.encryptionKey)
      : null;

    return this.repository.createAccount({
      providerId: input.providerId,
      label: input.label,
      authMethod: input.authMethod,
      encryptedSecret,
      encryptedRefreshToken,
      secretMasked: maskSecret(input.secret),
    });
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
    return this.repository.deleteAccount(accountId);
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
    const account = await this.getUsableAccountById(accountId, encryptionKey);
    if (!account) return [];
    return fetchModelsForAccount(account, encryptionKey, { purpose });
  }

  // ─── Pipeline management ───────────────────────────────────────

  listPipeline(profileId: string): PipelineModelEntry[] {
    return this.repository.listPipelineModels(profileId);
  }

  addModelToPipeline(input: CreatePipelineModelInput): PipelineModelEntry {
    return this.repository.addPipelineModel(input);
  }

  removeModelFromPipeline(modelId: string): boolean {
    return this.repository.removePipelineModel(modelId);
  }

  updateModelStatus(modelId: string, status: 'active' | 'rate-limited' | 'offline'): void {
    this.repository.updatePipelineModelStatus(modelId, status);
  }

  movePipelineModel(profileId: string, modelId: string, direction: 'up' | 'down'): boolean {
    const pipeline = [...this.repository.listPipelineModels(profileId)].sort(
      (a, b) => a.priority - b.priority,
    );
    const sourceIndex = pipeline.findIndex((model) => model.id === modelId);
    if (sourceIndex < 0) return false;

    const targetIndex = direction === 'up' ? sourceIndex - 1 : sourceIndex + 1;
    if (targetIndex < 0 || targetIndex >= pipeline.length) return false;

    const source = pipeline[sourceIndex];
    const target = pipeline[targetIndex];
    this.repository.updatePipelineModelPriority(source.id, target.priority);
    this.repository.updatePipelineModelPriority(target.id, source.priority);
    return true;
  }

  replacePipeline(profileId: string, models: CreatePipelineModelInput[]): PipelineModelEntry[] {
    return this.repository.replacePipeline(profileId, models);
  }

  // ─── Gateway dispatch ──────────────────────────────────────────

  async dispatchChat(
    accountId: string,
    encryptionKey: string,
    request: GatewayRequest,
  ): Promise<GatewayResponse> {
    const account = await this.getUsableAccountById(accountId, encryptionKey);
    if (!account) {
      return {
        ok: false,
        text: '',
        model: request.model,
        provider: 'unknown',
        error: `Account ${accountId} not found.`,
      };
    }
    return dispatchGatewayRequest(account, encryptionKey, request);
  }

  /**
   * Dispatches a chat request using the pipeline's priority fallback.
   * Tries each active model in priority order until one succeeds.
   *
   * If modelOverride is specified, tries the preferred model first,
   * then falls back to other active models in the pipeline.
   */
  async dispatchWithFallback(
    profileId: string,
    encryptionKey: string,
    request: Omit<GatewayRequest, 'model'>,
    options?: {
      signal?: AbortSignal;
      modelOverride?: string;
      onStreamDelta?: (delta: string) => void;
    },
  ): Promise<GatewayResponse> {
    const pipeline = this.repository.listPipelineModels(profileId);
    const activeModels = pipeline.filter((m) => m.status === 'active');

    if (activeModels.length === 0) {
      return {
        ok: false,
        text: '',
        model: '',
        provider: '',
        error: 'No active models in pipeline.',
      };
    }

    const errors: string[] = [];
    const attemptedModels = new Set<string>();

    // If modelOverride is specified, try preferred model first
    if (options?.modelOverride) {
      const preferredTarget = activeModels.find((m) => m.modelName === options.modelOverride);
      if (!preferredTarget) {
        errors.push(`Override model "${options.modelOverride}" not found in active pipeline.`);
      } else {
        const preferredAccount = this.repository.getAccountRecordById(preferredTarget.accountId);
        if (preferredAccount) {
          const usablePreferredAccount = await this.maybeRefreshOpenAICodexAccount(
            preferredAccount,
            encryptionKey,
          );
          const preferredReasoningEffort = mapPipelineReasoningEffort(
            preferredTarget.reasoningEffort,
          );
          const preferredResult = await dispatchGatewayRequest(
            usablePreferredAccount,
            encryptionKey,
            {
              ...request,
              model: preferredTarget.modelName,
              reasoning_effort: preferredReasoningEffort ?? request.reasoning_effort,
            },
            { signal: options?.signal, onStreamDelta: options?.onStreamDelta },
          );

          if (preferredResult.ok) {
            return preferredResult;
          }

          // Preferred model failed - record error and mark as rate-limited if needed
          errors.push(
            `${preferredTarget.modelName}@${preferredTarget.providerId}: ${preferredResult.error}`,
          );
          attemptedModels.add(preferredTarget.modelName);

          if (
            preferredResult.error?.includes('429') ||
            preferredResult.error?.toLowerCase().includes('rate')
          ) {
            this.repository.updatePipelineModelStatus(preferredTarget.id, 'rate-limited');
          }
        } else {
          errors.push(
            `${preferredTarget.modelName}@${preferredTarget.providerId}: Account not found`,
          );
        }
      }
    }

    // Try remaining active models in priority order (fallback)
    for (const entry of activeModels) {
      // Skip if already attempted (preferred model)
      if (attemptedModels.has(entry.modelName)) continue;

      // Check abort before each model attempt
      if (options?.signal?.aborted) {
        return { ok: false, text: '', model: '', provider: '', error: 'Aborted' };
      }

      const account = this.repository.getAccountRecordById(entry.accountId);
      if (!account) continue;
      const usableAccount = await this.maybeRefreshOpenAICodexAccount(account, encryptionKey);
      const pipelineReasoningEffort = mapPipelineReasoningEffort(entry.reasoningEffort);

      const result = await dispatchGatewayRequest(
        usableAccount,
        encryptionKey,
        {
          ...request,
          model: entry.modelName,
          reasoning_effort: pipelineReasoningEffort ?? request.reasoning_effort,
        },
        { signal: options?.signal, onStreamDelta: options?.onStreamDelta },
      );

      if (result.ok) {
        return result;
      }

      errors.push(`${entry.modelName}@${entry.providerId}: ${result.error}`);

      // Mark as rate-limited if the error suggests it
      if (result.error?.includes('429') || result.error?.toLowerCase().includes('rate')) {
        this.repository.updatePipelineModelStatus(entry.id, 'rate-limited');
      }
    }

    return {
      ok: false,
      text: '',
      model: '',
      provider: '',
      error: `All models failed: ${errors.join(' | ')}`,
    };
  }

  // ─── Embedding dispatch ────────────────────────────────────────

  async dispatchEmbedding(
    encryptionKey: string,
    input: { operation: 'embedContent' | 'batchEmbedContents'; payload: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    const embeddingPipeline = this.repository
      .listPipelineModels(EMBEDDING_PROFILE_ID)
      .filter((model) => model.status === 'active')
      .sort((a, b) => a.priority - b.priority);
    const preferredEmbeddingModel = embeddingPipeline[0];

    if (!preferredEmbeddingModel) {
      return { error: 'No active embedding model configured. Add one in Gateway Control.' };
    }

    const provider = PROVIDER_CATALOG.find(
      (entry) => entry.id === preferredEmbeddingModel.providerId,
    );
    if (!provider) {
      return { error: `Unknown embedding provider: ${preferredEmbeddingModel.providerId}.` };
    }

    const record: ProviderAccountRecord | null = this.repository.getAccountRecordById(
      preferredEmbeddingModel.accountId,
    );
    if (!record) {
      return { error: 'Embedding account record not found.' };
    }
    const defaultEmbeddingModel: string | null = preferredEmbeddingModel.modelName?.trim() || null;

    const { decryptSecret } = await import('@/server/model-hub/crypto');
    const secret = decryptSecret(record.encryptedSecret, encryptionKey);
    if (!secret?.trim()) {
      return { error: 'Gemini account secret is missing or empty.' };
    }

    const requestedModel =
      typeof input.payload.model === 'string' && input.payload.model.trim().length > 0
        ? input.payload.model.trim()
        : null;
    const embeddingPayload =
      input.operation === 'embedContent' && !requestedModel && defaultEmbeddingModel
        ? { ...input.payload, model: defaultEmbeddingModel }
        : input.payload;

    try {
      if (provider.id !== 'gemini') {
        if (provider.id === 'cohere') {
          return await dispatchCohereEmbedding(
            secret,
            input.operation,
            input.payload,
            defaultEmbeddingModel || '',
          );
        }
        if (provider.apiBaseUrl) {
          return await dispatchOpenAICompatibleEmbedding(
            provider.id,
            provider.apiBaseUrl,
            secret,
            input.operation,
            input.payload,
            defaultEmbeddingModel || '',
          );
        }
        return {
          error: `Embedding provider "${provider.id}" is not supported yet.`,
        };
      }

      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: secret });
      const modelsApi = ai.models as unknown as GeminiEmbeddingModelsApi;

      if (input.operation === 'embedContent') {
        const result = await modelsApi.embedContent(embeddingPayload);
        return result ?? {};
      }
      if (input.operation === 'batchEmbedContents') {
        if (typeof modelsApi.batchEmbedContents !== 'function') {
          const fallback = tryExtractBatchPayloadAsEmbedContent(input.payload);
          if (!fallback) {
            return { embeddings: [] };
          }
          const result = await modelsApi.embedContent(fallback);
          return result ?? {};
        }
        const result = await modelsApi.batchEmbedContents(input.payload);
        return result ?? {};
      }
      return { error: `Unknown embedding operation: ${input.operation}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Embedding request failed';
      return { error: message };
    }
  }
}
