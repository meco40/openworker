import type { GeminiEmbeddingModelsApi } from '../types';
import { tryExtractBatchPayloadAsEmbedContent } from '../utils';
import { decryptSecret } from '@/server/model-hub/crypto';
import type { ProviderAccountRecord } from '@/server/model-hub/repository';

export interface GeminiEmbeddingInput {
  operation: 'embedContent' | 'batchEmbedContents';
  payload: Record<string, unknown>;
}

export async function dispatchGeminiEmbedding(
  record: ProviderAccountRecord,
  encryptionKey: string,
  input: GeminiEmbeddingInput,
  defaultEmbeddingModel: string | null,
): Promise<Record<string, unknown>> {
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
