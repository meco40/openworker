import type { ModelHubRepository } from '@/server/model-hub/repository';
import { PROVIDER_CATALOG } from '@/server/model-hub/providerCatalog';
import { EMBEDDING_PROFILE_ID } from '../utils';
import type { EmbeddingInput } from '../types';
import {
  dispatchGeminiEmbedding,
  dispatchCohereEmbedding,
  dispatchOpenAICompatibleEmbedding,
} from '../embedding';

export async function dispatchEmbedding(
  repository: ModelHubRepository,
  encryptionKey: string,
  input: EmbeddingInput,
): Promise<Record<string, unknown>> {
  const embeddingPipeline = repository
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

  const record = repository.getAccountRecordById(preferredEmbeddingModel.accountId);
  if (!record) {
    return { error: 'Embedding account record not found.' };
  }
  const defaultEmbeddingModel: string | null = preferredEmbeddingModel.modelName?.trim() || null;

  if (provider.id !== 'gemini') {
    if (provider.id === 'cohere') {
      const { decryptSecret } = await import('@/server/model-hub/crypto');
      const secret = decryptSecret(record.encryptedSecret, encryptionKey);
      if (!secret?.trim()) {
        return { error: 'Cohere account secret is missing or empty.' };
      }
      return await dispatchCohereEmbedding(
        secret,
        input.operation,
        input.payload,
        defaultEmbeddingModel || '',
      );
    }
    if (provider.apiBaseUrl) {
      const { decryptSecret } = await import('@/server/model-hub/crypto');
      const secret = decryptSecret(record.encryptedSecret, encryptionKey);
      if (!secret?.trim()) {
        return { error: `${provider.id} account secret is missing or empty.` };
      }
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

  return await dispatchGeminiEmbedding(record, encryptionKey, input, defaultEmbeddingModel);
}
