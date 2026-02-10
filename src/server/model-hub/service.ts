import { encryptSecret, maskSecret } from './crypto';
import type {
  CreatePipelineModelInput,
  ModelHubRepository,
  PipelineModelEntry,
  ProviderAccountView,
} from './repository';
import { fetchModelsForAccount, type FetchedModel } from './modelFetcher';
import { dispatchGatewayRequest, type GatewayRequest, type GatewayResponse } from './gateway';

interface ConnectProviderAccountInput {
  providerId: string;
  label: string;
  authMethod: 'api_key' | 'oauth';
  secret: string;
  refreshToken?: string;
  encryptionKey: string;
}

export class ModelHubService {
  constructor(private readonly repository: ModelHubRepository) {}

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

  updateHealth(accountId: string, ok: boolean): void {
    this.repository.setHealthStatus(accountId, ok);
  }

  deleteAccount(accountId: string): boolean {
    return this.repository.deleteAccount(accountId);
  }

  // ─── Model fetching ────────────────────────────────────────────

  async fetchModelsForAccount(accountId: string, encryptionKey: string): Promise<FetchedModel[]> {
    const account = this.repository.getAccountRecordById(accountId);
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

  replacePipeline(profileId: string, models: CreatePipelineModelInput[]): PipelineModelEntry[] {
    return this.repository.replacePipeline(profileId, models);
  }

  // ─── Gateway dispatch ──────────────────────────────────────────

  async dispatchChat(
    accountId: string,
    encryptionKey: string,
    request: GatewayRequest,
  ): Promise<GatewayResponse> {
    const account = this.repository.getAccountRecordById(accountId);
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
   */
  async dispatchWithFallback(
    profileId: string,
    encryptionKey: string,
    request: Omit<GatewayRequest, 'model'>,
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
    for (const entry of activeModels) {
      const account = this.repository.getAccountRecordById(entry.accountId);
      if (!account) continue;

      const result = await dispatchGatewayRequest(account, encryptionKey, {
        ...request,
        model: entry.modelName,
      });

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

    try {
      if (input.operation === 'embedContent') {
        const result = await (ai.models as any).embedContent(input.payload);
        return result ?? {};
      }
      if (input.operation === 'batchEmbedContents') {
        const modelsObj = ai.models as any;
        if (typeof modelsObj.batchEmbedContents !== 'function') {
          return { embeddings: [] };
        }
        const result = await modelsObj.batchEmbedContents(input.payload);
        return result ?? {};
      }
      return { error: `Unknown embedding operation: ${input.operation}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Embedding request failed';
      return { error: message };
    }
  }
}
