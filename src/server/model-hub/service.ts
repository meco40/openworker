import { decryptSecret, encryptSecret, maskSecret } from './crypto';
import type {
  CreatePipelineModelInput,
  ModelHubRepository,
  PipelineReasoningEffort,
  PipelineModelEntry,
  ProviderAccountRecord,
  ProviderAccountView,
} from './repository';
import { fetchModelsForAccount, type FetchedModel } from './modelFetcher';
import { dispatchGatewayRequest, type GatewayRequest, type GatewayResponse } from './gateway';
import { isJwtExpiringSoon, refreshOpenAICodexToken } from './codexAuth';

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
    const account = await this.getUsableAccountById(accountId, encryptionKey);
    if (!account) return [];
    return fetchModelsForAccount(account, encryptionKey);
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
        return {
          ok: false,
          text: '',
          model: options.modelOverride,
          provider: '',
          error: `Override model "${options.modelOverride}" not found in active pipeline.`,
        };
      }

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
    // Find an account with a Gemini provider for embeddings
    const accounts = this.repository.listAccounts();
    const geminiAccount = accounts.find((a) => a.providerId === 'gemini');
    if (!geminiAccount) {
      return { error: 'No Gemini account available for embeddings.' };
    }

    const record = this.repository.getAccountRecordById(geminiAccount.id);
    if (!record) {
      return { error: 'Gemini account record not found.' };
    }

    const { decryptSecret } = await import('./crypto');
    const secret = decryptSecret(record.encryptedSecret, encryptionKey);
    if (!secret?.trim()) {
      return { error: 'Gemini account secret is missing or empty.' };
    }

    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: secret });
    const modelsApi = ai.models as unknown as GeminiEmbeddingModelsApi;

    try {
      if (input.operation === 'embedContent') {
        const result = await modelsApi.embedContent(input.payload);
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
